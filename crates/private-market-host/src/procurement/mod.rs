//! Optional MPP funding and pre-admission bid state. Official NEAR Intents and
//! controlled test modes are explicit; withdrawals and automatic dispatch are absent.
mod bids;
mod funding;
mod nearintents;

use super::{ISSUER, sql};
use anyhow::{Context, Result, ensure};
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, State},
    http::{HeaderMap, StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::{get, patch, post},
};
use bitrouter_cloud::{
    auth::{
        Scope,
        resolver::{CredentialResolver, VerifiedResolution},
    },
    db::FabricDb,
    service::redis_balance::RedisBalanceCache,
};
use ed25519_dalek::VerifyingKey;
use sea_orm::{ConnectionTrait, TransactionTrait};
use serde_json::{Value, json};
use std::{env, sync::Arc};

#[derive(Clone)]
pub struct Config {
    verification_key: Option<VerifyingKey>,
    nearintents: Option<nearintents::Config>,
}

pub fn configuration(is_live: bool) -> Result<Option<Config>> {
    if env::var("PRIVATE_MARKET_MPP_METHOD").as_deref() == Ok("nearintents") {
        ensure!(
            env::var("PRIVATE_MARKET_MPP_TEST_API").is_err(),
            "payment methods are mutually exclusive"
        );
        return Ok(Some(Config {
            verification_key: None,
            nearintents: Some(nearintents::Config::from_env(is_live)?),
        }));
    }
    ensure!(
        env::var("PRIVATE_MARKET_MPP_METHOD").is_err(),
        "unsupported payment method"
    );
    match env::var("PRIVATE_MARKET_MPP_TEST_API").as_deref() {
        Err(env::VarError::NotPresent) => return Ok(None),
        Ok("1") => ensure!(!is_live, "MPP test API cannot run with a live Provider"),
        _ => anyhow::bail!("PRIVATE_MARKET_MPP_TEST_API must be absent or 1"),
    }
    let raw = env::var("PRIVATE_MARKET_MPP_TEST_PUBLIC_KEY")
        .context("controlled MPP requires a test authority public key")?;
    let bytes: [u8; 32] = hex::decode(raw)?
        .try_into()
        .map_err(|_| anyhow::anyhow!("invalid test authority public key length"))?;
    Ok(Some(Config {
        verification_key: Some(VerifyingKey::from_bytes(&bytes)?),
        nearintents: None,
    }))
}

pub async fn initialize(db: &FabricDb, config: &Config) -> Result<()> {
    if let Some(near) = &config.nearintents {
        near.check("initialize").await?;
        db.conn()
            .execute_unprepared(include_str!("bids.sql"))
            .await?;
        return Ok(());
    }
    let tx = db.conn().begin().await?;
    tx.execute_unprepared(include_str!("schema.sql")).await?;
    tx.execute_unprepared(include_str!("bids.sql")).await?;
    tx.execute(sql(
        "INSERT INTO controlled_mpp_configuration(verification_key,mode) VALUES($1,'controlled-test-only')",
        vec![hex::encode(config.verification_key.context("test verification key missing")?.as_bytes()).into()],
    )).await?;
    tx.commit().await?;
    Ok(())
}

#[derive(Clone)]
struct AppState {
    db: Arc<FabricDb>,
    cache: Arc<RedisBalanceCache>,
    resolver: Arc<dyn CredentialResolver>,
    users: Vec<String>,
    config: Config,
}

pub async fn mount(
    router: Router,
    db: Arc<FabricDb>,
    cache: Arc<RedisBalanceCache>,
    resolver: Arc<dyn CredentialResolver>,
    mut users: Vec<String>,
    config: Option<Config>,
) -> Result<Router> {
    let Some(config) = config else {
        return Ok(router);
    };
    if let Some(near) = &config.nearintents {
        near.check("check").await?;
        // The live pilot has one verified refund destination. Do not collect
        // funds from other buyers until per-buyer refund binding is available.
        if near.live {
            ensure!(!users.is_empty(), "live payment pilot requires a buyer");
            users.truncate(1);
        }
    } else {
        let key: String = db.conn().query_one(sql(
        "SELECT verification_key FROM controlled_mpp_configuration WHERE singleton AND mode='controlled-test-only'", vec![],
    )).await?.context("MPP test schema must be installed during fresh initialization")?
        .try_get("", "verification_key")?;
        ensure!(
            key == hex::encode(
                config
                    .verification_key
                    .context("test verification key missing")?
                    .as_bytes()
            ),
            "test payment authority changed"
        );
    }
    let state = AppState {
        db,
        cache,
        resolver,
        users,
        config,
    };
    Ok(router.merge(
        Router::new()
            .route("/market/v1/funding-intents", post(funding::create))
            .route("/market/v1/funding-intents/{id}", get(funding::read))
            .route("/market/v1/funding-intents/{id}/pay", post(funding::pay))
            .route(
                "/market/v1/funding-intents/{id}/reconcile",
                post(nearintents::reconcile),
            )
            .route("/market/v1/funds", get(funding::funds))
            .route("/market/v1/procurement-intents", post(bids::create))
            .route("/market/v1/procurement-intents/{id}", get(bids::read))
            .route(
                "/market/v1/procurement-intents/{id}/bid",
                patch(bids::revise),
            )
            .route("/market/v1/procurement-intents/{id}/tick", post(bids::tick))
            .route(
                "/market/v1/procurement-intents/{id}/cancel",
                post(bids::cancel),
            )
            .layer(DefaultBodyLimit::max(128 * 1024))
            .with_state(state),
    ))
}

struct ApiError(StatusCode, &'static str);
type ApiResult<T> = std::result::Result<T, ApiError>;

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.0,
            [("cache-control", "no-store")],
            Json(json!({"error":self.1})),
        )
            .into_response()
    }
}
impl From<anyhow::Error> for ApiError {
    fn from(error: anyhow::Error) -> Self {
        eprintln!("controlled procurement storage error: {error:#}");
        Self(StatusCode::SERVICE_UNAVAILABLE, "procurement_unavailable")
    }
}
impl From<sea_orm::DbErr> for ApiError {
    fn from(error: sea_orm::DbErr) -> Self {
        anyhow::Error::from(error).into()
    }
}
impl From<serde_json::Error> for ApiError {
    fn from(error: serde_json::Error) -> Self {
        anyhow::Error::from(error).into()
    }
}
fn invalid() -> ApiError {
    ApiError(
        StatusCode::UNPROCESSABLE_ENTITY,
        "invalid_procurement_request",
    )
}
fn conflict() -> ApiError {
    ApiError(StatusCode::CONFLICT, "operation_conflict")
}
fn not_found() -> ApiError {
    ApiError(StatusCode::NOT_FOUND, "resource_not_found")
}

async fn authenticate(state: &AppState, headers: &HeaderMap, uri: &Uri) -> ApiResult<String> {
    if uri.query().is_some() || headers.contains_key("x-namespace-id") {
        return Err(invalid());
    }
    if headers.get_all("authorization").iter().count() != 1 {
        return Err(ApiError(
            StatusCode::UNAUTHORIZED,
            "authentication_required",
        ));
    }
    let token = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .filter(|v| !v.is_empty())
        .ok_or(ApiError(
            StatusCode::UNAUTHORIZED,
            "authentication_required",
        ))?;
    let VerifiedResolution::Allow(proof) = state
        .resolver
        .resolve_verified(token)
        .await
        .map_err(|_| ApiError(StatusCode::UNAUTHORIZED, "authentication_required"))?
    else {
        return Err(ApiError(
            StatusCode::UNAUTHORIZED,
            "authentication_required",
        ));
    };
    let principal = proof.original();
    if proof.source_realm() != ISSUER
        || principal.namespace_id.is_some()
        || !principal.scopes.contains(&Scope::INFERENCE_INVOKE)
        || !state.users.contains(&principal.subject_user_id)
    {
        return Err(ApiError(StatusCode::FORBIDDEN, "buyer_not_authorized"));
    }
    Ok(principal.subject_user_id.clone())
}

fn operation_key(headers: &HeaderMap) -> ApiResult<String> {
    if headers.get_all("idempotency-key").iter().count() != 1 {
        return Err(invalid());
    }
    let key = headers
        .get("idempotency-key")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(invalid)?;
    if key.is_empty()
        || key.len() > 128
        || !key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.:-".contains(&b))
    {
        return Err(invalid());
    }
    Ok(key.to_owned())
}

fn amount(raw: &str) -> ApiResult<i64> {
    if raw.is_empty()
        || raw.len() > 16
        || !raw.bytes().all(|b| b.is_ascii_digit())
        || (raw.len() > 1 && raw.starts_with('0'))
    {
        return Err(invalid());
    }
    raw.parse::<i64>()
        .ok()
        .filter(|n| *n > 0)
        .ok_or_else(invalid)
}

async fn now_ms<C: ConnectionTrait>(conn: &C) -> Result<i64> {
    Ok(conn
        .query_one(sql(
            "SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS now",
            vec![],
        ))
        .await?
        .context("database clock missing")?
        .try_get("", "now")?)
}

async fn fence<C: ConnectionTrait>(conn: &C, user: &str) -> Result<()> {
    conn.execute(sql(
        "SELECT pg_advisory_xact_lock(public.balance_cache_advisory_key($1))",
        vec![user.into()],
    ))
    .await?;
    Ok(())
}

fn response(status: StatusCode, value: Value) -> Response {
    (status, [("cache-control", "no-store")], Json(value)).into_response()
}
