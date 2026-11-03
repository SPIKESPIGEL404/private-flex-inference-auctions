//! Pinned, authenticated vLLM transport. Runtime identity is checked both before
//! dispatch and inside each response; ordinary SSE never substitutes for it.
use crate::*;
use serde::{Deserialize, Serialize};
use std::time::Duration;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VllmProfile {
    pub profile_id: String,
    pub served_model: String,
    pub model_revision: String,
    pub vllm_version: String,
    pub image_ref: String,
    pub engine_args_digest: String,
    pub tokenizer_digest: String,
    pub chat_template_digest: String,
    pub gpu_name: String,
    pub vocab_size: u64,
    pub max_prompt_tokens: u64,
    pub max_output_tokens: u64,
    pub max_model_len: u64,
    pub result_bytes_per_output_token: u64,
    pub result_overhead_bytes: u64,
    pub max_live_requests: u64,
    pub scheduler_only: bool,
}
impl VllmProfile {
    pub fn computed_digest(&self) -> Result<String> {
        digest("flex-scheduler/vllm-profile/v1", self)
    }
    pub fn model_profile(&self) -> ModelProfile {
        ModelProfile {
            profile_id: self.profile_id.clone(),
            tokenizer_digest: self.tokenizer_digest.clone(),
            chat_template_digest: self.chat_template_digest.clone(),
            max_prompt_tokens: self.max_prompt_tokens,
            max_output_tokens: self.max_output_tokens,
            max_model_len: self.max_model_len,
            vocab_size: self.vocab_size,
            result_bytes_per_output_token: self.result_bytes_per_output_token,
            result_overhead_bytes: self.result_overhead_bytes,
        }
    }
    pub fn validate(&self) -> Result<()> {
        for id in [&self.profile_id, &self.served_model, &self.image_ref] {
            crate::contracts::id(id)?;
        }
        for hash in [
            &self.engine_args_digest,
            &self.tokenizer_digest,
            &self.chat_template_digest,
        ] {
            crate::contracts::decode_hex::<32>(hash)?;
        }
        if self.vllm_version.is_empty()
            || self.vllm_version.len() > 128
            || !self
                .vllm_version
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_.+".contains(&b))
            || self.model_revision.len() != 40
            || !self
                .model_revision
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
            || !self.scheduler_only
            || self.result_bytes_per_output_token < 12
            || self.result_overhead_bytes < 72
            || self.max_live_requests == 0
            || self.max_live_requests > 1024
            || self.max_prompt_tokens == 0
            || self.max_output_tokens == 0
            || self
                .max_prompt_tokens
                .checked_add(self.max_output_tokens)
                .is_none_or(|n| n > self.max_model_len)
            || self.max_model_len > i64::MAX as u64
            || self.vocab_size == 0
            || self.vocab_size > u32::MAX as u64
            || self
                .result_bytes_per_output_token
                .checked_mul(self.max_output_tokens)
                .and_then(|n| n.checked_add(self.result_overhead_bytes))
                .is_none_or(|n| n > 64 * 1024 * 1024)
        {
            return Err(Error::Invalid("pinned vLLM profile"));
        }
        Ok(())
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VllmSession {
    pub profile: VllmProfile,
    pub profile_digest: String,
    pub engine_epoch: String,
    pub accepting: bool,
}
impl VllmSession {
    /// Binds the complete engine/profile contract into the signed plan and the
    /// journal config without changing earlier journal encodings.
    pub fn scheduler_policy_version(&self) -> String {
        format!("external-gate-v1-{}", self.profile_digest)
    }
    pub fn validate(&self) -> Result<()> {
        self.profile.validate()?;
        crate::contracts::id(&self.engine_epoch)?;
        if !self.accepting || self.profile.computed_digest()? != self.profile_digest {
            return Err(Error::Invalid("vLLM session binding or admission"));
        }
        Ok(())
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StreamIdentity {
    pub engine_epoch: String,
    pub profile_digest: String,
    pub binding_digest: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VllmHttpConfig {
    pub transport: MockHttpConfig,
    /// Trusted configuration, obtained from a reviewed deployment/profile probe.
    /// The transport never silently adopts a new profile or engine epoch.
    pub session: VllmSession,
}

pub struct VllmHttpRunner {
    inner: MockHttpRunner,
    session: VllmSession,
    profile_url: String,
}

pub(crate) fn http_client(
    connect_timeout_ms: u64,
    bearer: Option<&str>,
) -> Result<reqwest::Client> {
    let mut headers = reqwest::header::HeaderMap::new();
    if let Some(token) = bearer {
        if token.is_empty()
            || token.len() > 4096
            || token
                .bytes()
                .any(|b| b.is_ascii_whitespace() || b.is_ascii_control())
        {
            return Err(Error::Invalid("Bearer credential encoding"));
        }
        let mut value = reqwest::header::HeaderValue::from_str(&format!("Bearer {token}"))
            .map_err(|_| Error::Invalid("Bearer credential encoding"))?;
        value.set_sensitive(true);
        headers.insert(reqwest::header::AUTHORIZATION, value);
    }
    reqwest::Client::builder()
        .default_headers(headers)
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .no_proxy()
        .http1_only()
        .pool_max_idle_per_host(0)
        .no_gzip()
        .no_brotli()
        .no_deflate()
        .no_zstd()
        .connect_timeout(Duration::from_millis(connect_timeout_ms))
        .build()
        .map_err(|_| Error::Invalid("HTTP client configuration"))
}
impl VllmHttpRunner {
    pub fn new(config: VllmHttpConfig, bearer: &str) -> Result<Self> {
        config.session.validate()?;
        let mut url = reqwest::Url::parse(&config.transport.endpoint)
            .map_err(|_| Error::Invalid("vLLM endpoint"))?;
        if url.scheme() != "https"
            || url
                .host_str()
                .is_none_or(|host| !host.ends_with(".chutes.ai") || host == "chutes.ai")
            || url.port().is_some_and(|p| p != 443)
            || url.path() != "/scheduler/completions"
            || url.query().is_some()
            || url.fragment().is_some()
            || !url.username().is_empty()
            || url.password().is_some()
        {
            return Err(Error::Invalid("pinned HTTPS Chutes endpoint required"));
        }
        if config.transport.served_model != config.session.profile.served_model
            || config.transport.model_profile_id != config.session.profile.profile_id
            || config.transport.max_live_streams as u64 > config.session.profile.max_live_requests
        {
            return Err(Error::ConfigMismatch);
        }
        let client = http_client(config.transport.connect_timeout_ms, Some(bearer))?;
        url.set_path("/scheduler/profile");
        Ok(Self {
            inner: MockHttpRunner::with_session(config.transport, client, config.session.clone())?,
            session: config.session,
            profile_url: url.into(),
        })
    }

    pub async fn run_until_idle(&self, scheduler: &mut Scheduler) -> Result<MockRunReport> {
        let preflight_started = std::time::Instant::now();
        if !scheduler.spool_enabled()
            || scheduler.config().model != self.session.profile.model_profile()
            || scheduler.config().scheduler_policy_version
                != self.session.scheduler_policy_version()
            || scheduler.config().max_reserved_context_tokens > self.session.profile.max_model_len
            || scheduler.config().max_inflight_requests > self.session.profile.max_live_requests
            || scheduler.snapshot()?.engine_epoch.as_ref() != Some(&self.session.engine_epoch)
        {
            return Err(Error::ConfigMismatch);
        }
        if self.verify_session().await.is_err() {
            scheduler.transport_interrupted("vllm-session-preflight-failed".into())?;
            return Err(Error::ConfigMismatch);
        }
        let preflight_us = preflight_started
            .elapsed()
            .as_micros()
            .min(u64::MAX as u128) as u64;
        let mut report = self.inner.run_until_idle(scheduler).await?;
        report.scope = "phase-four-pinned-https-vllm".into();
        report.preflight_us = Some(preflight_us);
        if self.verify_session().await.is_err() {
            scheduler.transport_interrupted("vllm-session-postflight-failed".into())?;
            return Err(Error::ConfigMismatch);
        }
        Ok(report)
    }
    async fn verify_session(&self) -> Result<()> {
        let response = self
            .inner
            .client()
            .post(&self.profile_url)
            .json(&serde_json::json!({}))
            .timeout(Duration::from_secs(30))
            .send()
            .await
            .map_err(|_| Error::Invalid("vLLM profile unavailable"))?;
        let current: VllmSession =
            serde_json::from_slice(&bounded_response(response, 65536).await?)
                .map_err(|_| Error::Invalid("vLLM profile schema"))?;
        current.validate()?;
        if current != self.session {
            return Err(Error::ConfigMismatch);
        }
        Ok(())
    }
}

pub(crate) async fn bounded_response(
    mut response: reqwest::Response,
    limit: usize,
) -> Result<Vec<u8>> {
    if response.status() != reqwest::StatusCode::OK
        || response.content_length().is_some_and(|n| n > limit as u64)
    {
        return Err(Error::Invalid("bounded control response status or length"));
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| Error::Invalid("control response body"))?
    {
        if bytes
            .len()
            .checked_add(chunk.len())
            .is_none_or(|n| n > limit)
        {
            return Err(Error::Invalid("control response limit"));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

/// Bounded, authenticated deployment-control reads. No inference retry/fallback.
pub struct VllmControl {
    client: reqwest::Client,
    base: reqwest::Url,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TokenizedPrompt {
    pub engine_epoch: String,
    pub profile_digest: String,
    pub token_ids: Vec<u32>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EngineTrace {
    pub admitted_ns: u64,
    pub first_token_ns: Option<u64>,
    pub terminal_ns: Option<u64>,
    pub finished_ns: Option<u64>,
    pub binding_digest: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EngineState {
    pub engine_epoch: String,
    pub accepting: bool,
    pub active: Vec<String>,
    pub traces: std::collections::BTreeMap<String, EngineTrace>,
    pub release: String,
}
impl VllmControl {
    pub fn new(endpoint: &str, bearer: &str) -> Result<Self> {
        let url = reqwest::Url::parse(endpoint).map_err(|_| Error::Invalid("control endpoint"))?;
        if url.scheme() != "https"
            || url.host_str().is_none_or(|h| !h.ends_with(".chutes.ai"))
            || url.port().is_some_and(|p| p != 443)
            || url.path() != "/scheduler/completions"
            || url.query().is_some()
            || url.fragment().is_some()
            || !url.username().is_empty()
            || url.password().is_some()
        {
            return Err(Error::Invalid("pinned HTTPS Chutes endpoint required"));
        }
        Ok(Self {
            client: http_client(10000, Some(bearer))?,
            base: url,
        })
    }
    async fn post<T: serde::de::DeserializeOwned>(
        &self,
        path: &str,
        body: serde_json::Value,
        limit: usize,
    ) -> Result<T> {
        let mut url = self.base.clone();
        url.set_path(path);
        let response = self
            .client
            .post(url)
            .json(&body)
            .timeout(Duration::from_secs(45))
            .send()
            .await
            .map_err(|_| Error::Invalid("control endpoint unavailable"))?;
        serde_json::from_slice(&bounded_response(response, limit).await?)
            .map_err(|_| Error::Invalid("control response schema"))
    }
    pub async fn profile(&self) -> Result<VllmSession> {
        let profile: VllmSession = self
            .post("/scheduler/profile", serde_json::json!({}), 65536)
            .await?;
        profile.validate()?;
        Ok(profile)
    }
    pub async fn tokenize(
        &self,
        messages: serde_json::Value,
        session: &VllmSession,
    ) -> Result<TokenizedPrompt> {
        let t: TokenizedPrompt = self
            .post(
                "/scheduler/tokenize",
                serde_json::json!({"messages":messages}),
                262144,
            )
            .await?;
        if t.engine_epoch != session.engine_epoch
            || t.profile_digest != session.profile_digest
            || t.token_ids.is_empty()
            || t.token_ids.len() as u64 > session.profile.max_prompt_tokens
            || t.token_ids
                .iter()
                .any(|&t| u64::from(t) >= session.profile.vocab_size)
        {
            return Err(Error::ConfigMismatch);
        }
        Ok(t)
    }
    pub async fn state(&self) -> Result<EngineState> {
        self.post("/scheduler/state", serde_json::json!({}), 1048576)
            .await
    }
    /// Explicit operator action; closes admission for this boot permanently.
    pub async fn seal(&self, engine_epoch: &str) -> Result<serde_json::Value> {
        self.post(
            "/scheduler/seal",
            serde_json::json!({"engine_epoch":engine_epoch}),
            65536,
        )
        .await
    }
    pub async fn metrics(&self) -> Result<String> {
        let mut url = self.base.clone();
        url.set_path("/metrics");
        let response = self
            .client
            .get(url)
            .timeout(Duration::from_secs(30))
            .send()
            .await
            .map_err(|_| Error::Invalid("metrics unavailable"))?;
        String::from_utf8(bounded_response(response, 1048576).await?)
            .map_err(|_| Error::Invalid("metrics encoding"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::TcpListener,
    };

    #[tokio::test]
    async fn bearer_is_sent_once_and_redirect_is_not_followed() {
        let original = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let target = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", original.local_addr().unwrap());
        let location = format!("http://{}/steal", target.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut socket, _) = original.accept().await.unwrap();
            let mut bytes = vec![0; 8192];
            let n = socket.read(&mut bytes).await.unwrap();
            let request = String::from_utf8_lossy(&bytes[..n]).to_lowercase();
            assert!(request.contains("authorization: bearer synthetic-fixture-token"));
            socket.write_all(format!("HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").as_bytes()).await.unwrap();
        });
        let response = http_client(1000, Some("synthetic-fixture-token"))
            .unwrap()
            .get(url)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 302);
        server.await.unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(100), target.accept())
                .await
                .is_err()
        );
    }
    #[tokio::test]
    async fn control_body_has_a_hard_limit_even_with_chunked_response() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut bytes = [0; 4096];
            let n = socket.read(&mut bytes).await.unwrap();
            assert!(n > 0);
            socket.write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n10\r\n0123456789abcdef\r\n0\r\n\r\n").await.unwrap();
        });
        let response = http_client(1000, None)
            .unwrap()
            .get(url)
            .send()
            .await
            .unwrap();
        assert!(bounded_response(response, 8).await.is_err());
        server.await.unwrap();
    }
}
