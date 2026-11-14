//! Signed Market financial receipts (Market purchase profile, not ACI §7 event logs).
//!
//! Ownership mirrors pinned `stream::authorize` field checks because that helper
//! and `authorize_request` / `MarketHandle::head` are `pub(crate)` only.
use super::*;
use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};
use bitrouter_cloud::{
    auth::{CredentialResolver, Scope, resolver::VerifiedResolution},
    db::FabricDb,
};
use ed25519_dalek::Signer;
use sea_orm::{ConnectionTrait, DbBackend, Statement};
use std::sync::Arc;

const PURPOSE: &str = "market.receipt.v1";
const KEY_ID: &str = "market-ephemeral-v1";
const ACTIVE_NAMESPACE_HEADER: &str = "x-bitrouter-namespace";
/// Shared by every 404 path so cross-buyer and unknown-id bodies match exactly.
const NOT_FOUND_BODY: &str = "not_found";
const UNAUTHORIZED_BODY: &str = "unauthorized";

/// In-process receipt signing key. Never logged or serialized.
pub struct ReceiptSigningKey(ed25519_dalek::SigningKey);

impl ReceiptSigningKey {
    pub fn new(key: ed25519_dalek::SigningKey) -> Self {
        Self(key)
    }

    fn sign(&self, message: &[u8]) -> ed25519_dalek::Signature {
        self.0.sign(message)
    }
}

#[derive(Clone)]
struct HandlerState {
    db: Arc<FabricDb>,
    resolver: Arc<dyn CredentialResolver>,
    market_id: Arc<str>,
    issuer: Arc<str>,
    keyset_digest: Arc<str>,
    receipt_key: Arc<ReceiptSigningKey>,
    key_id: Arc<str>,
}

pub fn mount(
    router: Router,
    db: Arc<FabricDb>,
    resolver: Arc<dyn CredentialResolver>,
    market_id: impl Into<Arc<str>>,
    issuer: impl Into<Arc<str>>,
    keyset_digest: Arc<str>,
    receipt_key: Arc<ReceiptSigningKey>,
) -> Router {
    let state = HandlerState {
        db,
        resolver,
        market_id: market_id.into(),
        issuer: issuer.into(),
        keyset_digest,
        receipt_key,
        key_id: Arc::from(KEY_ID),
    };
    router.route(
        "/market/v1/receipts/{request_id}/signed",
        get(signed_receipt).with_state(state),
    )
}

fn not_found() -> Response {
    (
        StatusCode::NOT_FOUND,
        [(header::CACHE_CONTROL, "no-store")],
        NOT_FOUND_BODY,
    )
        .into_response()
}

fn unauthorized() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        [(header::CACHE_CONTROL, "no-store")],
        UNAUTHORIZED_BODY,
    )
        .into_response()
}

fn unavailable() -> Response {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        [(header::CACHE_CONTROL, "no-store")],
        "receipt_unavailable",
    )
        .into_response()
}

fn forbidden() -> Response {
    (
        StatusCode::FORBIDDEN,
        [(header::CACHE_CONTROL, "no-store")],
        "forbidden",
    )
        .into_response()
}

/// Path id shape: same UUID gate as Market `authorize_request` before DB.
fn valid_request_id(id: &str) -> bool {
    Uuid::parse_str(id).is_ok()
}

fn extract_bearer(headers: &HeaderMap) -> Option<&str> {
    let value = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let mut tokens = value
        .split(',')
        .map(str::trim)
        .filter_map(|part| part.strip_prefix("Bearer ").map(str::trim))
        .filter(|token| !token.is_empty());
    let first = tokens.next()?;
    if tokens.next().is_some() {
        return None;
    }
    Some(first)
}

/// Mirrors `bitrouter_cloud::auth::namespace::select` (pub(crate)).
async fn select_namespace(
    db: &FabricDb,
    principal: &bitrouter_cloud::auth::Principal,
    headers: &HeaderMap,
) -> Result<Option<String>, Response> {
    if let Some(namespace) = &principal.namespace_id {
        return Ok(Some(namespace.clone()));
    }
    let Some(namespace) = headers
        .get(ACTIVE_NAMESPACE_HEADER)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(None);
    };
    match db
        .namespace_owned_by(namespace, &principal.subject_user_id)
        .await
    {
        Ok(true) => Ok(Some(namespace.to_owned())),
        Ok(false) => Err(forbidden()),
        Err(_) => Err(unavailable()),
    }
}

fn is_final_committed(receipt: &Value) -> bool {
    if receipt.get("settlement").and_then(Value::as_str) != Some("committed") {
        return false;
    }
    matches!(
        receipt.pointer("/status/status").and_then(Value::as_str),
        Some("delivered" | "closed")
    )
}

async fn signed_receipt(
    State(state): State<HandlerState>,
    Path(request_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    if !valid_request_id(&request_id) {
        return not_found();
    }
    let Some(token) = extract_bearer(&headers).or_else(|| {
        headers
            .get("x-api-key")
            .and_then(|value| value.to_str().ok())
            .map(str::trim)
            .filter(|value| !value.is_empty())
    }) else {
        return unauthorized();
    };
    let verified = match state.resolver.resolve_verified(token).await {
        Ok(v) => v,
        Err(_) => return unauthorized(),
    };
    let VerifiedResolution::Allow(proof) = verified else {
        return unauthorized();
    };
    let principal = proof.original();
    if !principal.scopes.contains(&Scope::INFERENCE_INVOKE) {
        return forbidden();
    }
    let namespace = match select_namespace(&state.db, principal, &headers).await {
        Ok(v) => v,
        Err(response) => return response,
    };

    // Ownership fields mirror `market/pg/stream.rs` `authorize` (issuer, user,
    // namespace) after `store::load_optional` by market_id + request_id.
    let row = match state
        .db
        .conn()
        .query_one(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT s.issuer, s.user_id, s.namespace_id, s.idempotency_key, r.receipt \
             FROM public.market_inference_requests s \
             LEFT JOIN public.market_inference_receipts r \
               ON r.request_id = s.request_id AND r.revision = s.revision \
             WHERE s.market_id = $1 AND s.request_id = $2",
            [state.market_id.as_ref().into(), request_id.clone().into()],
        ))
        .await
    {
        Ok(row) => row,
        Err(_) => return unavailable(),
    };
    let Some(row) = row else {
        return not_found();
    };
    let issuer: String = match row.try_get("", "issuer") {
        Ok(v) => v,
        Err(_) => return unavailable(),
    };
    let user_id: String = match row.try_get("", "user_id") {
        Ok(v) => v,
        Err(_) => return unavailable(),
    };
    let row_namespace: Option<String> = match row.try_get("", "namespace_id") {
        Ok(v) => v,
        Err(_) => return unavailable(),
    };
    if issuer != state.issuer.as_ref()
        || user_id != principal.subject_user_id
        || row_namespace.as_deref() != namespace.as_deref()
    {
        return not_found();
    }
    let idempotency_key: String = match row.try_get("", "idempotency_key") {
        Ok(v) => v,
        Err(_) => return unavailable(),
    };
    let receipt: Option<Value> = match row.try_get("", "receipt") {
        Ok(v) => v,
        Err(_) => return unavailable(),
    };
    let Some(receipt) = receipt else {
        return not_found();
    };
    if !is_final_committed(&receipt) {
        return not_found();
    }

    let mut document = json!({
        "receipt": receipt,
        "idempotency_key": idempotency_key,
        "request_id": request_id,
        "purpose": PURPOSE,
        "workload_keyset_digest": state.keyset_digest.as_ref(),
        "key_id": state.key_id.as_ref(),
    });
    let signing_input = match aci_protocol::receipt::receipt_signing_input(&document) {
        Ok(bytes) => bytes,
        Err(_) => return unavailable(),
    };
    let signature = state.receipt_key.sign(&signing_input);
    document
        .as_object_mut()
        .expect("object")
        .insert("signature".into(), json!(hex::encode(signature.to_bytes())));
    ([(header::CACHE_CONTROL, "no-store")], axum::Json(document)).into_response()
}
