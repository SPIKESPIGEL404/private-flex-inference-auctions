//! First-hop ACI identity only. No upstream verification or financial receipt.
use super::*;
use aci_protocol::{digest, identity, types::*};
use axum::{extract::Query, http::StatusCode, response::IntoResponse};
use dstack_sdk_types::dstack::{GetQuoteResponse, InfoResponse};
use std::{io::Read, os::unix::fs::FileTypeExt, path::PathBuf};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    dstack_socket: PathBuf,
    tls_certificate: PathBuf,
    public_domain: String,
    keyset_lifetime_seconds: u64,
}

struct Identity {
    rpc: reqwest::Client,
    keyset: Value,
    digest: String,
    domain: String,
    not_after: u64,
    // Generated inside this process; the first-hop surface issues no receipts.
    _receipt_key: ed25519_dalek::SigningKey,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Challenge {
    nonce: String,
}

impl Identity {
    async fn rpc<T: serde::de::DeserializeOwned>(&self, method: &str, body: Value) -> Result<T> {
        let response = self
            .rpc
            .post(format!("http://localhost/{method}"))
            .json(&body)
            .send()
            .await?
            .error_for_status()?;
        // The trusted local RPC is still bounded; do not buffer unbounded data.
        let mut response = response;
        let mut raw = Vec::new();
        while let Some(chunk) = response.chunk().await? {
            ensure!(
                raw.len() + chunk.len() <= 2 * 1024 * 1024,
                "dstack response too large"
            );
            raw.extend_from_slice(&chunk);
        }
        Ok(serde_json::from_slice(&raw)?)
    }

    async fn report(&self, nonce: &str) -> Result<AttestationReport> {
        ensure!(identity::is_valid_nonce(nonce), "invalid challenge");
        ensure!(
            (chrono::Utc::now().timestamp() as u64) < self.not_after,
            "identity expired; restart with a fresh identity"
        );
        let statement = identity::attestation_statement(&self.digest, Some(nonce))?;
        let rd = identity::report_data(&statement);
        let slot = identity::report_data_slot(rd);
        let quote: GetQuoteResponse = self
            .rpc("GetQuote", json!({"report_data":hex::encode(slot)}))
            .await?;
        ensure!(
            hex::decode(&quote.report_data)? == slot,
            "dstack returned a different report-data slot"
        );
        let raw = quote.decode_quote()?;
        // This service accepts only the TDX v4 layout used by the pinned client.
        // This is a shape/binding check; the buyer verifies the hardware signature.
        ensure!(
            raw.len() >= 632
                && raw[..2] == [4, 0]
                && raw[4..8] == [0x81, 0, 0, 0]
                && raw[568..632] == slot,
            "dstack quote is not the requested TDX v4 identity"
        );
        let info: Value = self.rpc("Info", json!({})).await?;
        let info = InfoResponse::validated_from_value(info)?;
        ensure!(
            !info.tcb_info.app_compose.is_empty(),
            "missing measured compose"
        );
        let spki = self.keyset["tls_public_keys"][0]["spki_sha256"].clone();
        Ok(AttestationReport {
            api_version: "aci/1".into(),
            workload_keyset_digest: self.digest.clone(),
            attestation: AttestationEnvelope {
                tee_type: "tdx".into(),
                workload_keyset: self.keyset.clone(),
                report_data_hex: hex::encode(rd),
                source_provenance: SourceProvenance::default(),
                evidence: json!({"quote":quote.quote,"quote_report_data":quote.report_data,
                    "event_log":serde_json::to_string(&info.tcb_info.event_log)?,
                    "app_compose":info.tcb_info.app_compose,"vm_config":quote.vm_config,
                    "downstream_tls_binding":{"domain":self.domain,"spki_sha256":spki}}),
            },
            service_capabilities: ServiceCapabilities::default(),
        })
    }
}

fn is_policy_digest(value: &str) -> bool {
    let Some(hex) = value.strip_prefix("sha256:") else {
        return false;
    };
    hex.len() == 64
        && hex
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

pub async fn mount(router: Router, policy_digest: &str) -> Result<(Router, bool)> {
    let Some(path) = env::var_os("PRIVATE_MARKET_ATTESTATION_CONFIG") else {
        return Ok((router, false));
    };
    ensure!(
        is_policy_digest(policy_digest),
        "catalog identity changed during startup"
    );
    let config: Config = live::read(Path::new(&path))?;
    ensure!(
        config.dstack_socket.is_absolute()
            && fs::metadata(&config.dstack_socket)?.file_type().is_socket(),
        "dstack requires an explicit local Unix socket"
    );
    let domain = config.public_domain;
    let parsed = url::Url::parse(&format!("https://{domain}"))?;
    ensure!(
        parsed.host_str() == Some(domain.as_str())
            && parsed.port().is_none()
            && parsed.path() == "/"
            && parsed.query().is_none()
            && parsed.fragment().is_none()
            && parsed.username().is_empty()
            && parsed.password().is_none(),
        "invalid public TLS domain"
    );
    ensure!(
        (60..=3600).contains(&config.keyset_lifetime_seconds),
        "identity lifetime must be 60..3600 seconds"
    );
    let bytes = fs::read(config.tls_certificate)?;
    ensure!(bytes.len() <= 128 * 1024, "TLS certificate too large");
    let (_, pem) = x509_parser::pem::parse_x509_pem(&bytes)
        .map_err(|_| anyhow::anyhow!("invalid TLS certificate PEM"))?;
    let (_, cert) = x509_parser::parse_x509_certificate(&pem.contents)
        .map_err(|_| anyhow::anyhow!("invalid TLS certificate"))?;
    let spki = digest::sha256_hex(cert.public_key().raw)
        .trim_start_matches("sha256:")
        .to_owned();
    let mut seed = [0u8; 32];
    fs::File::open("/dev/urandom")?.read_exact(&mut seed)?;
    let key = ed25519_dalek::SigningKey::from_bytes(&seed);
    let not_after = chrono::Utc::now().timestamp() as u64 + config.keyset_lifetime_seconds;
    let keyset = serde_json::to_value(WorkloadKeyset {
        // Pinned WorkloadKeyset has no extension field. subject is inside the
        // JCS digest, so report_data binds this catalog file hash.
        subject: Some(format!("market-policy:{policy_digest}")),
        not_after,
        receipt_signing_keys: vec![KeyedPublicKey {
            key_id: "market-ephemeral-v1".into(),
            algo: "ed25519".into(),
            public_key_hex: hex::encode(key.verifying_key().to_bytes()),
        }],
        e2ee_public_keys: vec![],
        tls_public_keys: vec![TlsSpki {
            spki_sha256_hex: spki,
            domain: Some(domain.clone()),
        }],
    })?;
    let identity = Arc::new(Identity {
        rpc: reqwest::Client::builder()
            .unix_socket(config.dstack_socket)
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(15))
            .build()?,
        digest: identity::workload_keyset_digest(&keyset)?,
        keyset,
        domain,
        not_after,
        _receipt_key: key,
    });
    // Startup must obtain a real RPC response. There is no development/fallback
    // quote generator in this executable; tests own their separate RPC server.
    identity
        .report(&Uuid::new_v4().simple().to_string().repeat(2))
        .await
        .context("initialize dstack identity")?;
    let handler = move |Query(challenge): Query<Challenge>| {
        let identity = identity.clone();
        async move {
            if !identity::is_valid_nonce(&challenge.nonce) {
                return (StatusCode::BAD_REQUEST, "invalid_attestation_challenge").into_response();
            }
            match identity.report(&challenge.nonce).await {
                Ok(report) => ([("cache-control", "no-store")], axum::Json(report)).into_response(),
                Err(_) => {
                    (StatusCode::SERVICE_UNAVAILABLE, "attestation_unavailable").into_response()
                }
            }
        }
    };
    Ok((
        router
            .route("/market/v1/aci/attestation", get(handler.clone()))
            .route("/v1/aci/attestation", get(handler)),
        true,
    ))
}
