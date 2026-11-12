//! Signed purchase admission. Runs only when the ACI identity surface is enabled.
use super::*;
use aci_protocol::digest;
use axum::{
    body::{Body, to_bytes},
    extract::State as AxumState,
    http::{HeaderMap, HeaderName, Method, Request, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};
use ed25519_dalek::{Signature, VerifyingKey};
use std::collections::HashMap;
use std::sync::Mutex;

const BODY_LIMIT: usize = 128 * 1024;
const WINDOW_SECS: i64 = 300;
const REPLAY_CAP: usize = 65_536;
const BUYER_HEADERS: [&str; 4] = [
    "x-buyer-key",
    "x-buyer-nonce",
    "x-buyer-ts",
    "x-buyer-signature",
];

#[derive(Clone)]
pub struct Guard {
    inner: Arc<Inner>,
}

struct Inner {
    keyset_digest: Arc<str>,
    process_start: i64,
    authority_url: String,
    internal_token: String,
    keys_by_user: HashMap<String, String>,
    replay: Mutex<Replay>,
    http: reqwest::Client,
}

struct Replay {
    // (buyer_key, nonce) -> unix seconds when accepted
    entries: HashMap<(String, String), i64>,
}

#[derive(Deserialize)]
struct IntrospectBody {
    // Partial view of the existing authority response; unknown fields are
    // ignored so Market's richer introspect body stays unchanged.
    active: bool,
    #[serde(default)]
    sub: Option<String>,
}

enum Fail {
    Invalid,
    Authority,
}

impl IntoResponse for Fail {
    fn into_response(self) -> Response {
        match self {
            Fail::Invalid => {
                (StatusCode::UNAUTHORIZED, "purchase_signature_invalid").into_response()
            }
            Fail::Authority => {
                (StatusCode::SERVICE_UNAVAILABLE, "purchase_auth_unavailable").into_response()
            }
        }
    }
}

impl Guard {
    pub fn new(
        keyset_digest: Arc<str>,
        process_start: i64,
        authority_url: String,
        internal_token: String,
        buyers: &[Buyer],
    ) -> Result<Self> {
        let mut keys_by_user = HashMap::new();
        for buyer in buyers {
            ensure!(
                parse_public_key(&buyer.public_key).is_ok(),
                "buyer public key must be ed25519 base58"
            );
            ensure!(
                keys_by_user
                    .insert(buyer.user.clone(), buyer.public_key.clone())
                    .is_none(),
                "duplicate buyer user"
            );
        }
        Ok(Self {
            inner: Arc::new(Inner {
                keyset_digest,
                process_start,
                authority_url,
                internal_token,
                keys_by_user,
                replay: Mutex::new(Replay {
                    entries: HashMap::new(),
                }),
                http: reqwest::Client::builder()
                    .no_proxy()
                    .redirect(reqwest::redirect::Policy::none())
                    .timeout(Duration::from_secs(5))
                    .build()?,
            }),
        })
    }
}

pub async fn layer(
    AxumState(guard): AxumState<Guard>,
    request: Request<Body>,
    next: Next,
) -> Response {
    if request.method() != Method::POST || request.uri().path() != "/market/v1/chat/completions" {
        return next.run(request).await;
    }
    match admit(guard.inner.clone(), request).await {
        Ok(request) => next.run(request).await,
        Err(fail) => fail.into_response(),
    }
}

async fn admit(inner: Arc<Inner>, request: Request<Body>) -> Result<Request<Body>, Fail> {
    let (mut parts, body) = request.into_parts();
    let headers = &parts.headers;
    let key = single_header(headers, "x-buyer-key")?;
    let nonce = single_header(headers, "x-buyer-nonce")?;
    let ts_raw = single_header(headers, "x-buyer-ts")?;
    let signature = single_header(headers, "x-buyer-signature")?;
    let idempotency = single_header(headers, "idempotency-key")?;
    let authorization = single_header(headers, "authorization")?;

    if !nonce_ok(nonce) || !signature_ok(signature) || !idempotency_ok(idempotency) {
        return Err(Fail::Invalid);
    }
    let ts = parse_ts(ts_raw)?;
    let now = chrono::Utc::now().timestamp();
    if ts < inner.process_start || (now - ts).abs() > WINDOW_SECS {
        return Err(Fail::Invalid);
    }
    let verifying = parse_public_key(key)?;
    let bytes = to_bytes(body, BODY_LIMIT)
        .await
        .map_err(|_| Fail::Invalid)?;
    let body_sha = digest::sha256_hex(&bytes);
    let statement = json!({
        "purpose": "market.purchase.v1",
        "method": "POST",
        "path": "/market/v1/chat/completions",
        "body_sha256": body_sha,
        "idempotency_key": idempotency,
        "nonce": nonce,
        "ts": ts,
        "keyset": inner.keyset_digest.as_ref(),
    });
    let canonical = digest::jcs_bytes(&statement).map_err(|_| Fail::Invalid)?;
    let sig_bytes = hex::decode(signature).map_err(|_| Fail::Invalid)?;
    let sig = Signature::from_slice(&sig_bytes).map_err(|_| Fail::Invalid)?;
    // Signature before any authority contact so garbage never reaches introspect.
    verifying
        .verify_strict(&canonical, &sig)
        .map_err(|_| Fail::Invalid)?;
    if statement["keyset"].as_str() != Some(inner.keyset_digest.as_ref()) {
        return Err(Fail::Invalid);
    }

    let token = authorization
        .strip_prefix("Bearer ")
        .filter(|value| !value.is_empty() && value.len() <= 512)
        .ok_or(Fail::Invalid)?;
    let user = introspect(&inner, token).await?;
    let registered = inner.keys_by_user.get(&user).ok_or(Fail::Invalid)?;
    if registered != key {
        return Err(Fail::Invalid);
    }

    {
        let mut replay = inner.replay.lock().map_err(|_| Fail::Invalid)?;
        replay.purge(now);
        let entry = (key.to_owned(), nonce.to_owned());
        if replay.entries.contains_key(&entry) {
            return Err(Fail::Invalid);
        }
        if replay.entries.len() >= REPLAY_CAP {
            return Err(Fail::Invalid);
        }
        replay.entries.insert(entry, now);
    }

    strip_buyer_headers(&mut parts.headers);
    Ok(Request::from_parts(parts, Body::from(bytes)))
}

impl Replay {
    fn purge(&mut self, now: i64) {
        self.entries
            .retain(|_, seen| now.saturating_sub(*seen) <= WINDOW_SECS);
    }
}

async fn introspect(inner: &Inner, token: &str) -> Result<String, Fail> {
    let response = inner
        .http
        .post(format!(
            "{}/api/internal/introspect",
            inner.authority_url.trim_end_matches('/')
        ))
        .header("x-internal-service-token", &inner.internal_token)
        .json(&json!({"token": token}))
        .send()
        .await
        .map_err(|_| Fail::Authority)?;
    if !response.status().is_success() {
        return Err(Fail::Authority);
    }
    let mut raw = Vec::new();
    let mut response = response;
    while let Some(chunk) = response.chunk().await.map_err(|_| Fail::Authority)? {
        if raw.len().saturating_add(chunk.len()) > 16 * 1024 {
            return Err(Fail::Authority);
        }
        raw.extend_from_slice(&chunk);
    }
    let body: IntrospectBody = serde_json::from_slice(&raw).map_err(|_| Fail::Invalid)?;
    if !body.active {
        return Err(Fail::Invalid);
    }
    let sub = body
        .sub
        .filter(|value| !value.is_empty() && value.len() <= 512)
        .ok_or(Fail::Invalid)?;
    Ok(sub)
}

fn single_header<'a>(headers: &'a HeaderMap, name: &'static str) -> Result<&'a str, Fail> {
    let mut values = headers.get_all(name).iter();
    let first = values.next().ok_or(Fail::Invalid)?;
    if values.next().is_some() {
        return Err(Fail::Invalid);
    }
    first.to_str().map_err(|_| Fail::Invalid)
}

fn strip_buyer_headers(headers: &mut HeaderMap) {
    let remove: Vec<HeaderName> = headers
        .keys()
        .filter(|name| {
            let lower = name.as_str();
            BUYER_HEADERS.contains(&lower)
                || lower
                    .strip_prefix("x-buyer-")
                    .is_some_and(|rest| !rest.is_empty())
        })
        .cloned()
        .collect();
    for name in remove {
        headers.remove(name);
    }
}

fn nonce_ok(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn signature_ok(value: &str) -> bool {
    value.len() == 128
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b) || (b'A'..=b'F').contains(&b))
}

fn idempotency_ok(value: &str) -> bool {
    let len = value.len();
    (1..=128).contains(&len) && value.chars().all(|c| !c.is_control())
}

fn parse_ts(value: &str) -> Result<i64, Fail> {
    if value.is_empty()
        || !value.bytes().all(|b| b.is_ascii_digit())
        || (value.len() > 1 && value.starts_with('0'))
    {
        return Err(Fail::Invalid);
    }
    value.parse().map_err(|_| Fail::Invalid)
}

fn parse_public_key(value: &str) -> Result<VerifyingKey, Fail> {
    let encoded = value.strip_prefix("ed25519:").ok_or(Fail::Invalid)?;
    let bytes = bs58::decode(encoded)
        .into_vec()
        .map_err(|_| Fail::Invalid)?;
    if bytes.len() != 32 {
        return Err(Fail::Invalid);
    }
    let mut raw = [0u8; 32];
    raw.copy_from_slice(&bytes);
    VerifyingKey::from_bytes(&raw).map_err(|_| Fail::Invalid)
}

pub(crate) fn encode_public_key(bytes: &[u8; 32]) -> String {
    format!("ed25519:{}", bs58::encode(bytes).into_string())
}

pub(crate) fn encode_secret_key(seed: &[u8; 32], public: &[u8; 32]) -> String {
    let mut secret = [0u8; 64];
    secret[..32].copy_from_slice(seed);
    secret[32..].copy_from_slice(public);
    format!("ed25519:{}", bs58::encode(secret).into_string())
}
