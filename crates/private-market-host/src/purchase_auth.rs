//! Signed purchase admission, with optional Market-purchase E2EE.
//!
//! Order on POST /market/v1/chat/completions when enabled:
//! signature on the exact wire body → introspection → (if attested) E2EE
//! decrypt of `bitrouter_purchase` → strip buyer/E2EE headers → Market.
use super::*;
use crate::e2ee;
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
use x25519_dalek::StaticSecret as X25519SecretKey;

const BODY_LIMIT: usize = 128 * 1024;
const WINDOW_SECS: i64 = 300;
const REPLAY_CAP: usize = 65_536;
const BUYER_HEADERS: [&str; 4] = [
    "x-buyer-key",
    "x-buyer-nonce",
    "x-buyer-ts",
    "x-buyer-signature",
];
const E2EE_HEADERS: [&str; 5] = [
    "x-e2ee-version",
    "x-client-pub-key",
    "x-model-pub-key",
    "x-e2ee-nonce",
    "x-e2ee-timestamp",
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
    /// Present only when attestation published an E2EE key (required path).
    e2ee: Option<E2eeState>,
    replay: Mutex<Replay>,
    e2ee_replay: Mutex<E2eeReplay>,
    http: reqwest::Client,
}

struct E2eeState {
    secret: X25519SecretKey,
    public_hex: String,
}

struct Replay {
    // (buyer_key, nonce) -> unix seconds when accepted
    entries: HashMap<(String, String), i64>,
}

struct E2eeReplay {
    // (client_pub, service_pub, nonce) -> unix seconds
    entries: HashMap<(String, String, String), i64>,
}

#[derive(Deserialize)]
struct IntrospectBody {
    active: bool,
    #[serde(default)]
    sub: Option<String>,
}

enum Fail {
    Invalid,
    Authority,
    E2ee(&'static str),
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
            Fail::E2ee(code) => (
                StatusCode::BAD_REQUEST,
                axum::Json(json!({
                    "error": {"message": code, "type": code, "code": code}
                })),
            )
                .into_response(),
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
        e2ee: Option<(X25519SecretKey, String)>,
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
                e2ee: e2ee.map(|(secret, public_hex)| E2eeState { secret, public_hex }),
                replay: Mutex::new(Replay {
                    entries: HashMap::new(),
                }),
                e2ee_replay: Mutex::new(E2eeReplay {
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
    // Enforce body limit before any signature work that hashes the body and
    // before any E2EE decryption.
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

    let forward_bytes = if let Some(e2ee_state) = &inner.e2ee {
        decrypt_purchase(&inner, e2ee_state, &parts.headers, &bytes, now)?
    } else {
        bytes.to_vec()
    };

    strip_buyer_headers(&mut parts.headers);
    strip_e2ee_headers(&mut parts.headers);
    Ok(Request::from_parts(parts, Body::from(forward_bytes)))
}

fn decrypt_purchase(
    inner: &Inner,
    e2ee_state: &E2eeState,
    headers: &HeaderMap,
    wire: &[u8],
    now: i64,
) -> Result<Vec<u8>, Fail> {
    let present: Vec<_> = E2EE_HEADERS
        .iter()
        .filter(|name| headers.contains_key(**name))
        .collect();
    if present.is_empty() {
        return Err(Fail::E2ee("e2ee_header_missing"));
    }
    if present.len() != E2EE_HEADERS.len() {
        return Err(Fail::E2ee("e2ee_header_missing"));
    }
    let version =
        single_header(headers, "x-e2ee-version").map_err(|_| Fail::E2ee("e2ee_header_missing"))?;
    if version != e2ee::E2EE_VERSION {
        return Err(Fail::E2ee("e2ee_invalid_version"));
    }
    let client_pub = single_header(headers, "x-client-pub-key")
        .map_err(|_| Fail::E2ee("e2ee_header_missing"))?;
    let model_pub =
        single_header(headers, "x-model-pub-key").map_err(|_| Fail::E2ee("e2ee_header_missing"))?;
    let e2ee_nonce =
        single_header(headers, "x-e2ee-nonce").map_err(|_| Fail::E2ee("e2ee_header_missing"))?;
    let e2ee_ts_raw = single_header(headers, "x-e2ee-timestamp")
        .map_err(|_| Fail::E2ee("e2ee_header_missing"))?;

    let client_norm = e2ee::normalize_public_key_hex(client_pub)
        .map_err(|_| Fail::E2ee("e2ee_invalid_public_key"))?;
    let model_norm = e2ee::normalize_public_key_hex(model_pub)
        .map_err(|_| Fail::E2ee("e2ee_invalid_public_key"))?;
    if model_norm != e2ee_state.public_hex {
        return Err(Fail::E2ee("e2ee_model_key_mismatch"));
    }
    if !e2ee_nonce_ok(e2ee_nonce) {
        return Err(Fail::E2ee("e2ee_invalid_nonce"));
    }
    let e2ee_ts = parse_e2ee_ts(e2ee_ts_raw)?;
    if (now - e2ee_ts).abs() > WINDOW_SECS {
        return Err(Fail::E2ee("e2ee_invalid_timestamp"));
    }

    let mut body: Value =
        serde_json::from_slice(wire).map_err(|_| Fail::E2ee("e2ee_decryption_failed"))?;
    let model = match body.get("model") {
        Some(Value::String(s)) => s.clone(),
        _ => return Err(Fail::E2ee("e2ee_invalid_payload_model")),
    };
    refuse_foreign_ciphertext(&body)?;

    let ciphertext = match body.get(e2ee::FIELD_PURCHASE) {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Object(_)) => return Err(Fail::E2ee("e2ee_decryption_failed")),
        _ => return Err(Fail::E2ee("e2ee_decryption_failed")),
    };
    if ciphertext.len() > e2ee::PURCHASE_CIPHERTEXT_HEX_MAX
        || !e2ee::looks_like_x25519_ciphertext(&ciphertext)
    {
        return Err(Fail::E2ee("e2ee_decryption_failed"));
    }

    let aad = digest::jcs_bytes(&json!({
        "purpose": e2ee::AAD_PURPOSE,
        "algo": e2ee::E2EE_ALGO_X25519,
        "model": model,
        "field": e2ee::FIELD_PURCHASE,
        "nonce": e2ee_nonce,
        "ts": e2ee_ts,
    }))
    .map_err(|_| Fail::E2ee("e2ee_decryption_failed"))?;
    let plain = e2ee::decrypt_with_secret(&e2ee_state.secret, &ciphertext, &aad)
        .map_err(|_| Fail::E2ee("e2ee_decryption_failed"))?;
    let purchase: Value =
        serde_json::from_slice(&plain).map_err(|_| Fail::E2ee("e2ee_decryption_failed"))?;
    validate_purchase_object(&purchase)?;
    body[e2ee::FIELD_PURCHASE] = purchase;

    {
        let mut replay = inner
            .e2ee_replay
            .lock()
            .map_err(|_| Fail::E2ee("e2ee_decryption_failed"))?;
        replay.purge(now);
        let entry = (client_norm, model_norm, e2ee_nonce.to_ascii_lowercase());
        if replay.entries.contains_key(&entry) {
            return Err(Fail::E2ee("e2ee_replay_detected"));
        }
        if replay.entries.len() >= REPLAY_CAP {
            return Err(Fail::E2ee("e2ee_replay_detected"));
        }
        replay.entries.insert(entry, now);
    }

    serde_json::to_vec(&body).map_err(|_| Fail::E2ee("e2ee_decryption_failed"))
}

fn validate_purchase_object(value: &Value) -> Result<(), Fail> {
    let obj = value
        .as_object()
        .ok_or(Fail::E2ee("e2ee_decryption_failed"))?;
    let service = obj
        .get("service_type")
        .and_then(|v| v.as_str())
        .ok_or(Fail::E2ee("e2ee_decryption_failed"))?;
    if service != "on_demand" {
        return Err(Fail::E2ee("e2ee_decryption_failed"));
    }
    for key in ["provider_cap_micro_usd", "total_cap_micro_usd"] {
        let n = obj
            .get(key)
            .and_then(|v| v.as_i64())
            .ok_or(Fail::E2ee("e2ee_decryption_failed"))?;
        if n <= 0 {
            return Err(Fail::E2ee("e2ee_decryption_failed"));
        }
    }
    Ok(())
}

fn refuse_foreign_ciphertext(body: &Value) -> Result<(), Fail> {
    let Some(messages) = body.get("messages").and_then(|v| v.as_array()) else {
        return Ok(());
    };
    for message in messages {
        match message.get("content") {
            Some(Value::String(s)) if e2ee::looks_like_x25519_ciphertext(s) => {
                return Err(Fail::E2ee("e2ee_decryption_failed"));
            }
            Some(Value::Array(parts)) => {
                for part in parts {
                    for key in ["text", "input_audio"] {
                        if let Some(Value::String(s)) = part.get(key)
                            && e2ee::looks_like_x25519_ciphertext(s)
                        {
                            return Err(Fail::E2ee("e2ee_decryption_failed"));
                        }
                    }
                    if let Some(Value::Object(url)) = part.get("image_url")
                        && let Some(Value::String(s)) = url.get("url")
                        && e2ee::looks_like_x25519_ciphertext(s)
                    {
                        return Err(Fail::E2ee("e2ee_decryption_failed"));
                    }
                }
            }
            _ => {}
        }
    }
    if let Some(Value::String(s)) = body.get("prompt")
        && e2ee::looks_like_x25519_ciphertext(s)
    {
        return Err(Fail::E2ee("e2ee_decryption_failed"));
    }
    Ok(())
}

fn e2ee_nonce_ok(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b) || (b'A'..=b'F').contains(&b))
}

fn parse_e2ee_ts(value: &str) -> Result<i64, Fail> {
    if value.is_empty()
        || !value.bytes().all(|b| b.is_ascii_digit())
        || (value.len() > 1 && value.starts_with('0'))
    {
        return Err(Fail::E2ee("e2ee_invalid_timestamp"));
    }
    value
        .parse()
        .map_err(|_| Fail::E2ee("e2ee_invalid_timestamp"))
}

impl Replay {
    fn purge(&mut self, now: i64) {
        self.entries
            .retain(|_, seen| now.saturating_sub(*seen) <= WINDOW_SECS);
    }
}

impl E2eeReplay {
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

fn strip_e2ee_headers(headers: &mut HeaderMap) {
    let remove: Vec<HeaderName> = headers
        .keys()
        .filter(|name| {
            let lower = name.as_str();
            E2EE_HEADERS.contains(&lower)
                || lower
                    .strip_prefix("x-e2ee-")
                    .is_some_and(|rest| !rest.is_empty())
        })
        .cloned()
        .collect();
    for name in remove {
        headers.remove(name);
    }
    headers.remove("x-client-pub-key");
    headers.remove("x-model-pub-key");
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
    parse_public_key_str(value).map_err(|_| Fail::Invalid)
}

/// Shared format check for deploy config and purchase admission.
pub(crate) fn parse_public_key_str(value: &str) -> Result<VerifyingKey, ()> {
    let encoded = value.strip_prefix("ed25519:").ok_or(())?;
    let bytes = bs58::decode(encoded).into_vec().map_err(|_| ())?;
    if bytes.len() != 32 {
        return Err(());
    }
    let mut raw = [0u8; 32];
    raw.copy_from_slice(&bytes);
    VerifyingKey::from_bytes(&raw).map_err(|_| ())
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
