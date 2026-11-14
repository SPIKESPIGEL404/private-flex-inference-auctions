//! Standard NEAR Intents charge through the pinned official TypeScript SDK.
//! The child process is a private stdio adapter, never a public verifier API.
use super::*;
use axum::extract::Path;
use serde::Deserialize;
use std::{collections::BTreeMap, path::PathBuf, process::Stdio, time::Duration};
use tokio::{io::AsyncWriteExt, process::Command, sync::Semaphore};

#[derive(Clone)]
pub(super) struct Config {
    bridge: PathBuf,
    config_file: PathBuf,
    slots: Arc<Semaphore>,
    pub(super) live: bool,
}

#[derive(Deserialize)]
struct BridgeResponse {
    status: u16,
    data: Value,
    #[serde(default)]
    headers: BTreeMap<String, String>,
}

impl Config {
    pub(super) fn from_env(is_live: bool) -> Result<Self> {
        let config_file = PathBuf::from(
            env::var("PRIVATE_MARKET_MPP_NEARINTENTS_CONFIG")
                .context("NEAR Intents configuration path required")?,
        );
        let config: Value = serde_json::from_slice(&std::fs::read(&config_file)?)?;
        ensure!(
            matches!(config["mode"].as_str(), Some("live" | "controlled")),
            "explicit settlement mode required"
        );
        ensure!(
            !is_live || config["mode"] == "live",
            "controlled settlement cannot fund a live Provider"
        );
        let bridge = env::var_os("PRIVATE_MARKET_MPP_NEARINTENTS_BRIDGE")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("../../services/mpp-nearintents/bridge.mjs")
            });
        ensure!(bridge.is_file(), "NEAR Intents bridge missing");
        Ok(Self {
            bridge,
            config_file,
            slots: Arc::new(Semaphore::new(4)),
            live: config["mode"] == "live",
        })
    }

    async fn execute(&self, input: Value) -> Result<BridgeResponse> {
        let _permit = self.slots.acquire().await?;
        let mut child = Command::new("node")
            .arg(&self.bridge)
            .env("PRIVATE_MARKET_MPP_NEARINTENTS_CONFIG", &self.config_file)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()
            .context("start NEAR Intents SDK bridge")?;
        let mut stdin = child.stdin.take().context("bridge input unavailable")?;
        stdin.write_all(&serde_json::to_vec(&input)?).await?;
        stdin.shutdown().await?;
        drop(stdin);
        let output = tokio::time::timeout(Duration::from_secs(150), child.wait_with_output())
            .await
            .context(
                "NEAR Intents verification timed out; retry the original funding resource",
            )??;
        ensure!(
            output.stdout.len() <= 256 * 1024,
            "bridge response too large"
        );
        serde_json::from_slice(&output.stdout).context("invalid SDK bridge response")
    }

    pub(super) async fn check(&self, operation: &str) -> Result<()> {
        let output = self.execute(json!({"operation":operation})).await?;
        ensure!(
            output.status == 200,
            "NEAR Intents SDK initialization/configuration check failed"
        );
        Ok(())
    }
}

pub(super) async fn invoke(
    state: &AppState,
    config: &Config,
    operation: &str,
    user: &str,
    mut input: Value,
) -> ApiResult<Response> {
    input["operation"] = operation.into();
    input["user_id"] = user.into();
    let mut output = config.execute(input.clone()).await?;
    if matches!(operation, "pay" | "reconcile")
        && output.status < 300
        && output.data["ledger_id"].is_string()
    {
        let ready = state.cache.reconcile_balance(user).await.is_ok();
        if ready {
            let reread = config
                .execute(json!({"operation":"read","user_id":user,"id":input["id"]}))
                .await?;
            if reread.status == 200 {
                output.data = reread.data;
            }
        }
        if !ready || output.data["status"] != "credited" {
            output.status = 202;
            output.headers.remove("payment-receipt");
        }
    }
    let mut response = response(
        StatusCode::from_u16(output.status).map_err(|_| invalid())?,
        output.data,
    );
    for (name, value) in output.headers {
        if matches!(name.as_str(), "www-authenticate" | "payment-receipt") {
            response.headers_mut().insert(
                axum::http::HeaderName::from_bytes(name.as_bytes()).map_err(|_| invalid())?,
                value.parse().map_err(|_| invalid())?,
            );
        }
    }
    Ok(response)
}

pub(super) async fn reconcile(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    uri: Uri,
) -> ApiResult<Response> {
    let user = authenticate(&state, &headers, &uri).await?;
    let config = state.config.nearintents.as_ref().ok_or_else(not_found)?;
    if headers.get_all("payment-authorization").iter().count() > 1 {
        return Err(invalid());
    }
    let credential = headers
        .get("payment-authorization")
        .map(|v| v.to_str().map(str::to_owned))
        .transpose()
        .map_err(|_| invalid())?;
    invoke(
        &state,
        config,
        "reconcile",
        &user,
        json!({"id":id,"credential":credential}),
    )
    .await
}
