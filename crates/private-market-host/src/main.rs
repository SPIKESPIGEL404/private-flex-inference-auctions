//! Batch A: controlled, loopback-only host for the pinned Cloud Market.
//! No attestation or real-provider claim is made by this executable.
mod attestation;
mod catalog;
mod e2ee;
mod fixtures;
mod live;
mod provision;
mod purchase_auth;

use anyhow::{Context, Result, ensure};
use axum::{Router, routing::get};
use bitrouter_cloud::{
    auth::{principal_cache::PrincipalCache, remote_resolver::RemoteIntrospectionResolver},
    core_gateway::market_inference::launch,
    db::{BillingMigrationPhase, FabricDb},
    service::redis_balance::RedisBalanceCache,
};
use sea_orm::{ConnectionTrait, Database, DbBackend, Statement, TransactionTrait};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{env, fs, net::SocketAddr, path::Path, sync::Arc, time::Duration};
use uuid::Uuid;

const ISSUER: &str = "private-market-batch-a";
const MODEL: &str = "m/external";
const CASH: i64 = 25_000;
struct Workload {
    token_ids: Vec<u32>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(deny_unknown_fields)]
struct Buyer {
    user: String,
    credential_id: String,
    token: String,
    /// NEAR-format verifying key: `ed25519:` + base58(32-byte public key).
    public_key: String,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct State {
    database: String,
    redis: String,
    binding: String,
    cutover: String,
    fixture_addr: SocketAddr,
    buyers: Vec<Buyer>,
    #[serde(default)]
    registration_sha256: Option<String>,
    #[serde(default)]
    catalog_sha256: Option<String>,
    /// When true, every serve compares state catalog bytes to the image golden.
    #[serde(default)]
    deploy_golden: bool,
}

fn required(name: &str) -> Result<String> {
    env::var(name).with_context(|| format!("{name} is required"))
}
fn targets() -> Result<(String, String)> {
    let database = required("DATABASE_URL")?;
    let redis = required("REDIS_URL")?;
    for (raw, schemes) in [
        (&database, &["postgres", "postgresql"][..]),
        (&redis, &["redis"][..]),
    ] {
        let url = url::Url::parse(raw).context("invalid local service URL")?;
        ensure!(
            schemes.contains(&url.scheme())
                && url.host_str() == Some("127.0.0.1")
                && url.port().is_some_and(|p| p > 0)
                && url.query().is_none()
                && url.fragment().is_none(),
            "Batch A requires explicit IPv4 loopback service URLs without URL options"
        );
    }
    let url = url::Url::parse(&database)?;
    let name = url.path().trim_start_matches('/');
    ensure!(
        name.starts_with("private_market_")
            && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_'),
        "database name must start with private_market_ and contain only letters, digits and underscores"
    );
    Ok((database, redis))
}
fn sql(query: &str, values: Vec<sea_orm::Value>) -> Statement {
    Statement::from_sql_and_values(DbBackend::Postgres, query, values)
}
fn catalog_policy_digest(path: &Path) -> Result<String> {
    // One generic failure for a missing, oversized, or replaced catalog.
    // Callers must not attach hashes, paths, or file bytes.
    let bytes =
        fs::read(path).map_err(|_| anyhow::anyhow!("catalog identity changed during startup"))?;
    ensure!(
        bytes.len() <= 4 * 1024 * 1024,
        "catalog identity changed during startup"
    );
    Ok(format!(
        "sha256:{}",
        bitrouter_market::persistence_codec::digest(&bytes)
    ))
}

fn write_private(path: &Path, value: &impl Serialize) -> Result<()> {
    write_private_bytes(path, &serde_json::to_vec_pretty(value)?)
}

fn write_private_bytes(path: &Path, bytes: &[u8]) -> Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(())
}

fn issue_buyer_keys(dir: &Path, index: usize) -> Result<String> {
    use std::io::Read;
    let mut seed = [0u8; 32];
    fs::File::open("/dev/urandom")?.read_exact(&mut seed)?;
    let signing = ed25519_dalek::SigningKey::from_bytes(&seed);
    let public = signing.verifying_key().to_bytes();
    let public_key = purchase_auth::encode_public_key(&public);
    let secret = purchase_auth::encode_secret_key(&seed, &public);
    let key_dir = dir.join("signing");
    fs::create_dir_all(&key_dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&key_dir, fs::Permissions::from_mode(0o700))?;
    }
    write_private_bytes(
        &key_dir.join(format!("buyer-{index}.key")),
        secret.as_bytes(),
    )?;
    Ok(public_key)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct DeployBuyers {
    /// Exactly three NEAR-format verifying keys supplied by the buyers.
    public_keys: [String; 3],
}

fn deploy_buyer_tokens() -> Result<[String; 3]> {
    let tokens = [
        required("PRIVATE_MARKET_BUYER_TOKEN_0")?,
        required("PRIVATE_MARKET_BUYER_TOKEN_1")?,
        required("PRIVATE_MARKET_BUYER_TOKEN_2")?,
    ];
    for token in &tokens {
        ensure!(
            (32..=512).contains(&token.len()) && token.starts_with("brk_"),
            "deploy buyer token rejected"
        );
    }
    ensure!(
        tokens[0] != tokens[1] && tokens[0] != tokens[2] && tokens[1] != tokens[2],
        "deploy buyer tokens must be distinct"
    );
    Ok(tokens)
}

fn deploy_public_keys(path: &Path) -> Result<[String; 3]> {
    let cfg: DeployBuyers = live::read(path)?;
    for key in &cfg.public_keys {
        ensure!(
            purchase_auth::parse_public_key_str(key).is_ok(),
            "deploy buyer public key rejected"
        );
    }
    ensure!(
        cfg.public_keys[0] != cfg.public_keys[1]
            && cfg.public_keys[0] != cfg.public_keys[2]
            && cfg.public_keys[1] != cfg.public_keys[2],
        "deploy buyer public keys must be distinct"
    );
    Ok(cfg.public_keys)
}

async fn initialize(
    dir: &Path,
    registration: Option<live::Registration>,
    deploy_buyers: Option<&Path>,
) -> Result<()> {
    if let Some(input) = &registration {
        input.validate()?;
    }
    let (database, redis) = targets()?;
    let binding = required("BITROUTER_PREVIEW_BOOTSTRAP_BINDING")?;
    let cutover = required("REDIS_BALANCE_CUTOVER_TOKEN")?;
    // Refuse any existing state; never refill a previous market or adopt its money.
    fs::create_dir(dir)
        .context("state directory must be new; do not reuse a failed or previous run")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;
    }
    let conn = Database::connect(database.clone()).await?;
    let row = conn.query_one(sql("SELECT EXISTS(SELECT FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND c.relkind IN('r','p','v','m','S','f')) AS occupied", vec![])).await?.context("database preflight")?;
    ensure!(
        !row.try_get::<bool>("", "occupied")?,
        "initialization requires a new empty database"
    );
    conn.close().await?;
    FabricDb::migrate_billing_schema(&database, BillingMigrationPhase::IsolatedBootstrap).await?;
    let db = FabricDb::connect(&database).await?;
    for text in [
        include_str!("../upstream/sql/settings-up.sql"),
        include_str!("../upstream/sql/promo-up.sql"),
        include_str!("../upstream/sql/inference-up.sql"),
        include_str!("../upstream/sql/cash-up.sql"),
    ] {
        db.conn().execute_unprepared(text).await?;
    }
    let mut buyers = Vec::with_capacity(3);
    if let Some(path) = deploy_buyers {
        // Deployment path: buyer signing secrets stay on buyer machines.
        // Public keys are public config; bearer tokens arrive as encrypted secrets.
        let public_keys = deploy_public_keys(path)?;
        let tokens = deploy_buyer_tokens()?;
        for index in 0..3 {
            let id = Uuid::new_v4().to_string();
            buyers.push(Buyer {
                user: Uuid::new_v4().to_string(),
                token: tokens[index].clone(),
                credential_id: id,
                public_key: public_keys[index].clone(),
            });
        }
    } else {
        for index in 0..3 {
            let id = Uuid::new_v4().to_string();
            buyers.push(Buyer {
                user: Uuid::new_v4().to_string(),
                token: format!(
                    "brk_{id}.{}{}",
                    Uuid::new_v4().simple(),
                    Uuid::new_v4().simple()
                ),
                credential_id: id,
                public_key: issue_buyer_keys(dir, index)?,
            });
        }
    }
    let tx = db.conn().begin().await?;
    for buyer in &buyers {
        let account = Uuid::new_v4().to_string();
        let entry = Uuid::new_v4().to_string();
        tx.execute(sql(
            "INSERT INTO credit_accounts(id,user_id,balance_micro_usd) VALUES($1,$2,$3)",
            vec![
                account.clone().into(),
                buyer.user.clone().into(),
                CASH.into(),
            ],
        ))
        .await?;
        tx.execute(sql("INSERT INTO credit_ledger_entries(id,credit_account_id,entry_type,amount_micro_usd,idempotency_key,metadata) VALUES($1,$2,'test_credit',$3,$1,'{\"source\":\"batch-a-isolated-test-credit\"}'::jsonb)", vec![entry.into(), account.into(), CASH.into()])).await?;
    }
    tx.commit().await?;
    let deploy = deploy_buyers.is_some();
    let mut registration_sha256 = None;
    let (fixture_addr, deploy_golden) = if deploy {
        // Measured deploy fixture: fixed loopback port (not operator env).
        let fixture_addr: SocketAddr = provision::DEPLOY_FIXTURE_ADDR.parse()?;
        ensure!(
            fixture_addr.ip().is_loopback() && fixture_addr.port() == 18080,
            "deploy fixture must be 127.0.0.1:18080"
        );
        let _hold = tokio::net::TcpListener::bind(fixture_addr)
            .await
            .context("deploy fixture 127.0.0.1:18080 is not available")?;
        drop(_hold);
        let origin = format!("http://{fixture_addr}");
        let catalog = provision::create_deploy(db.conn().clone(), &origin, &origin).await?;
        let raw = serde_json::to_vec_pretty(&catalog)?;
        let golden = fs::read(provision::DEPLOY_GOLDEN_CATALOG)
            .context("deploy golden catalog missing from image (/etc/market/catalog.json)")?;
        ensure!(
            raw == golden,
            "deploy catalog does not match the golden file baked into the image"
        );
        write_private_bytes(&dir.join("catalog.json"), &raw)?;
        (fixture_addr, true)
    } else {
        // Lab path: ephemeral loopback fixture (unchanged).
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let fixture_addr = listener.local_addr()?;
        let origin = format!("http://{fixture_addr}");
        if let Some(input) = &registration {
            live::register(db.conn().clone(), input).await?;
            write_private(&dir.join("registration.json"), input)?;
            registration_sha256 = Some(bitrouter_market::persistence_codec::digest(&fs::read(
                dir.join("registration.json"),
            )?));
        } else {
            let catalog = provision::create(db.conn().clone(), &origin, &origin).await?;
            write_private(&dir.join("catalog.json"), &catalog)?;
        }
        (fixture_addr, false)
    };
    let state = State {
        database,
        redis,
        binding,
        cutover,
        fixture_addr,
        buyers,
        registration_sha256,
        catalog_sha256: None,
        deploy_golden,
    };
    write_private(&dir.join("state.json"), &state)?;
    db.shutdown_handle()
        .close(tokio::time::Instant::now() + Duration::from_secs(5))
        .await?;
    println!(
        "{}",
        json!({"initialized":true,"buyers":3,"test_credit_micro_usd":CASH,"attested":false})
    );
    Ok(())
}

fn ensure_deploy_catalog_matches_golden(catalog_path: &Path) -> Result<()> {
    let golden = fs::read(provision::DEPLOY_GOLDEN_CATALOG)
        .context("deploy golden catalog missing from image")?;
    let live = fs::read(catalog_path).context("state catalog missing")?;
    ensure!(
        live == golden,
        "deploy catalog does not match the golden file baked into the image"
    );
    Ok(())
}

async fn qualify_live(dir: &Path, evidence: &Path) -> Result<()> {
    let (database, redis) = targets()?;
    let mut state: State = live::read(&dir.join("state.json"))?;
    ensure!(
        state.database == database
            && state.redis == redis
            && state.binding == required("BITROUTER_PREVIEW_BOOTSTRAP_BINDING")?
            && state.cutover == required("REDIS_BALANCE_CUTOVER_TOKEN")?,
        "live state ownership differs"
    );
    let registration_bytes = fs::read(dir.join("registration.json"))?;
    ensure!(
        state.registration_sha256.as_deref()
            == Some(&bitrouter_market::persistence_codec::digest(
                &registration_bytes
            ))
            && state.catalog_sha256.is_none()
            && !dir.join("catalog.json").exists(),
        "live qualification requires the original unqualified registration"
    );
    let registration: live::Registration = live::read(&dir.join("registration.json"))?;
    let measurement = live::read(evidence)?;
    let db = FabricDb::connect(&database).await?;
    let catalog = live::qualify(
        db.conn().clone(),
        &registration,
        &registration_bytes,
        measurement,
    )
    .await?;
    write_private(&dir.join("catalog.json"), &catalog)?;
    state.catalog_sha256 = Some(bitrouter_market::persistence_codec::digest(&fs::read(
        dir.join("catalog.json"),
    )?));
    write_private(&dir.join("qualified-state.json"), &state)?;
    // Publish qualified startup state only after the complete source catalog is durable.
    fs::rename(dir.join("qualified-state.json"), dir.join("state.json"))?;
    fs::File::open(dir)?.sync_all()?;
    db.shutdown_handle()
        .close(tokio::time::Instant::now() + Duration::from_secs(5))
        .await?;
    println!("{}", json!({"qualified":true,"offers":3,"attested":false}));
    Ok(())
}

async fn serve(dir: &Path) -> Result<()> {
    let (database, redis_url) = targets()?;
    let state: State =
        serde_json::from_slice(&fs::read(dir.join("state.json"))?).context("invalid state file")?;
    ensure!(
        state.database == database
            && state.redis == redis_url
            && state.binding == required("BITROUTER_PREVIEW_BOOTSTRAP_BINDING")?
            && state.cutover == required("REDIS_BALANCE_CUTOVER_TOKEN")?,
        "state does not match the configured isolated services and ownership"
    );
    let catalog_path = dir.join("catalog.json");
    ensure!(
        fs::canonicalize(required("INFERENCE_MARKET_CONFIG_PATH")?)?
            == fs::canonicalize(&catalog_path)?,
        "catalog must belong to this state directory"
    );
    if state.deploy_golden {
        ensure_deploy_catalog_matches_golden(&catalog_path)?;
    }
    // Hash before any Market load. Launch reads the same path on its own.
    let policy_digest = catalog_policy_digest(&catalog_path)?;
    let is_live = state.registration_sha256.is_some();
    if is_live {
        ensure!(
            state.catalog_sha256.as_deref() == policy_digest.strip_prefix("sha256:"),
            "live catalog requires completed qualification and its original identity"
        );
    }
    let address: SocketAddr = env::var("PRIVATE_MARKET_LISTEN")
        .unwrap_or_else(|_| "127.0.0.1:0".into())
        .parse()?;
    ensure!(
        address.ip().is_loopback(),
        "Batch A HTTP host must bind loopback"
    );
    ensure!(
        state.fixture_addr.ip().is_loopback(),
        "controlled fixture must bind loopback"
    );
    let db = Arc::new(FabricDb::connect(&database).await?);
    let redis =
        Arc::new(RedisBalanceCache::connect_for_startup(Some(&redis_url), db.clone()).await?);
    for buyer in &state.buyers {
        redis.reconcile_balance(&buyer.user).await?;
    }
    let cash_users: Vec<_> = state
        .buyers
        .iter()
        .map(|buyer| buyer.user.clone())
        .collect();
    // Batch B owns a separate loopback seller so killing this host does not
    // implicitly kill or prove termination of a provider execution.
    let external_fixture = is_live
        || match env::var("PRIVATE_MARKET_EXTERNAL_FIXTURE").as_deref() {
            Err(env::VarError::NotPresent) => false,
            Ok("1") => true,
            _ => anyhow::bail!("PRIVATE_MARKET_EXTERNAL_FIXTURE must be absent or 1"),
        };
    let authority = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let authority_url = format!("http://{}", authority.local_addr()?);
    let internal = Uuid::new_v4().to_string();
    let authority_router = fixtures::authority(state.buyers.clone(), internal.clone());
    let resolver = Arc::new(
        RemoteIntrospectionResolver::new(
            authority_url.clone(),
            internal.clone(),
            Arc::new(PrincipalCache::with_ttl(Duration::ZERO)),
        )
        .with_source_realm(ISSUER.into())?,
    );
    let process_start = chrono::Utc::now().timestamp();
    let (stop, stopped) = tokio::sync::watch::channel(false);
    let mut tasks = tokio::task::JoinSet::new();
    let mut servers = vec![(authority, authority_router)];
    if !external_fixture {
        let fixture = tokio::net::TcpListener::bind(state.fixture_addr).await?;
        servers.push((
            fixture,
            fixtures::seller(required("PRIVATE_MARKET_SELLER_KEY")?),
        ));
    }
    for (listener, router) in servers {
        let mut shutdown = stopped.clone();
        tasks.spawn(async move {
            axum::serve(listener, router)
                .with_graceful_shutdown(async move {
                    let _ = shutdown.wait_for(|v| *v).await;
                })
                .await
                .context("fixture server")
        });
    }
    let cash_cache = redis.clone();
    let mut cash_stop = stopped.clone();
    tasks.spawn(async move {
        loop {
            tokio::select! {
                biased;
                _ = cash_stop.wait_for(|v| *v) => return Ok(()),
                _ = tokio::time::sleep(Duration::from_millis(250)) => {}
            }
            // Only the three configured test identities can admit purchases.
            // The original repair API applies the durable outbox under its
            // locks/CAS; it cannot invent settlement or release Unknown holds.
            for user in &cash_users {
                cash_cache
                    .reconcile_balance(user)
                    .await
                    .context("recover test-account cash projection")?;
            }
        }
    });
    let market = launch::start_configured(db.clone(), redis, resolver, ISSUER)
        .await?
        .context("market catalog is required")?;
    // The Market loaded INFERENCE_MARKET_CONFIG_PATH itself. Refuse to listen
    // unless that file is still the exact bytes sealed into the keyset subject.
    ensure!(
        catalog_policy_digest(&catalog_path)? == policy_digest,
        "catalog identity changed during startup"
    );
    // The catalog qualifies Chat only; other native protocols have no product.
    let native = market.router();
    let mode = if is_live {
        "live-provider"
    } else {
        "controlled"
    };
    let health_digest = policy_digest.clone();
    let health_deploy = state.deploy_golden;
    let router = Router::new()
        .route(
            "/healthz",
            get(move || async move {
                let mut body = json!({"ready":true,"mode":mode,"attested":false});
                if health_deploy {
                    body["catalog_policy_digest"] = json!(health_digest);
                }
                axum::Json(body)
            }),
        )
        .nest("/market", native);
    let (router, mounted) = attestation::mount(router, &policy_digest).await?;
    let attestation_available = mounted.is_some();
    // Deploy/local may require signed purchases without ACI by setting
    // PRIVATE_MARKET_SIGNED_PURCHASES=1 (keyset = catalog policy digest).
    // E2EE for bitrouter_purchase is required only when attestation mounted.
    let signed_without_aci = env::var("PRIVATE_MARKET_SIGNED_PURCHASES").as_deref() == Ok("1");
    let router = match mounted {
        Some(mounted) => {
            let guard = purchase_auth::Guard::new(
                mounted.keyset_digest,
                process_start,
                authority_url,
                internal,
                &state.buyers,
                Some((mounted.e2ee_secret, mounted.e2ee_public_hex)),
            )?;
            router.layer(axum::middleware::from_fn_with_state(
                guard,
                purchase_auth::layer,
            ))
        }
        None if signed_without_aci => {
            let guard = purchase_auth::Guard::new(
                Arc::from(policy_digest.clone()),
                process_start,
                authority_url,
                internal,
                &state.buyers,
                None,
            )?;
            router.layer(axum::middleware::from_fn_with_state(
                guard,
                purchase_auth::layer,
            ))
        }
        None => router,
    };
    let listener = tokio::net::TcpListener::bind(address).await?;
    let url = format!("http://{}", listener.local_addr()?);
    let mut http_stop = stopped.clone();
    tasks.spawn(async move {
        axum::serve(listener, router)
            .with_graceful_shutdown(async move {
                let _ = http_stop.wait_for(|v| *v).await;
            })
            .await
            .context("market HTTP server")
    });
    tasks.spawn(market.run(stopped));
    println!(
        "{}",
        json!({"url":url,"mode":mode,"attested":false,"attestation_available":attestation_available})
    );
    let outcome = tokio::select! {
        signal = tokio::signal::ctrl_c() => signal.context("shutdown signal"),
        result = tasks.join_next() => match result {
            Some(Ok(Err(e))) => Err(e),
            _ => Err(anyhow::anyhow!("market or fixture owner exited unexpectedly")),
        },
    };
    stop.send_replace(true);
    let drained = tokio::time::timeout(Duration::from_secs(10), async {
        while let Some(result) = tasks.join_next().await {
            result??;
        }
        Ok::<_, anyhow::Error>(())
    })
    .await
    .context("market shutdown timed out")?;
    db.shutdown_handle()
        .close(tokio::time::Instant::now() + Duration::from_secs(5))
        .await?;
    outcome.and(drained)
}

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<_> = env::args().collect();
    ensure!(
        args.len() >= 3,
        "usage: private-market-host <init|init-deploy|serve|emit-deploy-catalog|init-live|qualify-live|validate-live> <state-or-profile> [input]"
    );
    match (args[1].as_str(), args.len()) {
        ("init", 3) => initialize(Path::new(&args[2]), None, None).await,
        ("init-deploy", 4) => {
            initialize(Path::new(&args[2]), None, Some(Path::new(&args[3]))).await
        }
        ("emit-deploy-catalog", 3) => emit_deploy_catalog(Path::new(&args[2])).await,
        ("init-live", 4) => {
            initialize(
                Path::new(&args[2]),
                Some(live::read(Path::new(&args[3]))?),
                None,
            )
            .await
        }
        ("qualify-live", 4) => qualify_live(Path::new(&args[2]), Path::new(&args[3])).await,
        ("validate-live", 3) => {
            let input: live::Registration = live::read(Path::new(&args[2]))?;
            input.validate()?;
            println!("live registration is structurally valid; not yet qualified");
            Ok(())
        }
        ("validate-native-chat", 3) => {
            let body: Value = live::read(Path::new(&args[2]))?;
            let protocol = bitrouter_cloud::platform_billing::meter::ApiProtocol::ChatCompletions;
            bitrouter_cloud::platform_billing::meter::freeze(protocol, &body)?;
            bitrouter_cloud::market::inference::output_contract(protocol, &body)?;
            println!("native request passes the fixed platform meter and output contract");
            Ok(())
        }
        ("serve", 3) => serve(Path::new(&args[2])).await,
        _ => anyhow::bail!("expected init, init-deploy, serve, or emit-deploy-catalog"),
    }
}

/// Regenerate the deploy golden catalog into `out` using committed constants.
/// Requires DATABASE_URL to an empty private_market_* database, plus the usual
/// ownership env placeholders (unused in catalog bytes).
async fn emit_deploy_catalog(out: &Path) -> Result<()> {
    let (database, _) = targets()?;
    let _ = required("BITROUTER_PREVIEW_BOOTSTRAP_BINDING")?;
    let _ = required("REDIS_BALANCE_CUTOVER_TOKEN")?;
    let conn = Database::connect(database.clone()).await?;
    let row = conn.query_one(sql("SELECT EXISTS(SELECT FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' AND c.relkind IN('r','p','v','m','S','f')) AS occupied", vec![])).await?.context("database preflight")?;
    ensure!(
        !row.try_get::<bool>("", "occupied")?,
        "emit-deploy-catalog requires a new empty database"
    );
    conn.close().await?;
    FabricDb::migrate_billing_schema(&database, BillingMigrationPhase::IsolatedBootstrap).await?;
    let db = FabricDb::connect(&database).await?;
    for text in [
        include_str!("../upstream/sql/settings-up.sql"),
        include_str!("../upstream/sql/promo-up.sql"),
        include_str!("../upstream/sql/inference-up.sql"),
        include_str!("../upstream/sql/cash-up.sql"),
    ] {
        db.conn().execute_unprepared(text).await?;
    }
    let origin = format!("http://{}", provision::DEPLOY_FIXTURE_ADDR);
    let catalog = provision::create_deploy(db.conn().clone(), &origin, &origin).await?;
    let raw = serde_json::to_vec_pretty(&catalog)?;
    fs::write(out, &raw)?;
    db.shutdown_handle()
        .close(tokio::time::Instant::now() + Duration::from_secs(5))
        .await?;
    println!(
        "{}",
        json!({
            "wrote": out,
            "bytes": raw.len(),
            "sha256": format!("sha256:{}", bitrouter_market::persistence_codec::digest(&raw)),
            "fixture": provision::DEPLOY_FIXTURE_ADDR,
            "at_ms": provision::DEPLOY_CATALOG_AT_MS,
            "valid_until_ms": provision::DEPLOY_CATALOG_VALID_UNTIL_MS,
        })
    );
    Ok(())
}

#[cfg(test)]
mod policy_digest {
    use super::*;

    #[test]
    fn persistence_codec_digest_is_sha256_of_the_file_bytes() {
        // FIPS 180-4 / SHA-256("abc"). A buyer can reproduce this with any
        // independent SHA-256 implementation.
        assert_eq!(
            bitrouter_market::persistence_codec::digest(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        let dir = std::env::temp_dir().join(format!("market-policy-{}", Uuid::new_v4()));
        fs::create_dir(&dir).unwrap();
        let path = dir.join("catalog.json");
        fs::write(&path, br#"{"catalog":1}"#).unwrap();
        let bytes = fs::read(&path).unwrap();
        assert_eq!(
            format!(
                "sha256:{}",
                bitrouter_market::persistence_codec::digest(&bytes)
            ),
            aci_protocol::digest::sha256_hex(&bytes)
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn committed_deploy_golden_catalog_matches_constants() {
        // Byte identity with emit-deploy-catalog is checked by
        // accept-market-dstack-local.sh (regen into a temp DB). This unit test
        // pins the committed file to the same constants used by create_deploy.
        let bytes = include_bytes!("../../../deploy/market/catalog.json");
        let catalog: Value = serde_json::from_slice(bytes).expect("golden JSON");
        let text = String::from_utf8(bytes.to_vec()).unwrap();
        assert!(
            text.contains(provision::DEPLOY_FIXTURE_ADDR),
            "golden must publish the fixed fixture address"
        );
        assert!(
            text.contains(&provision::DEPLOY_CATALOG_AT_MS.to_string()),
            "golden must embed the frozen catalog clock"
        );
        assert!(
            text.contains(&provision::DEPLOY_CATALOG_VALID_UNTIL_MS.to_string()),
            "golden must embed the far-future validity bound"
        );
        // Wall-clock-sensitive validity fields must not use short at+30m windows.
        let at = provision::DEPLOY_CATALOG_AT_MS;
        let until = provision::DEPLOY_CATALOG_VALID_UNTIL_MS;
        let short = at + 1_800_000;
        assert_ne!(until, short);
        assert!(until > at + 86_400_000);
        let routes = catalog["products"][0]["routes"].as_array().expect("routes");
        for route in routes {
            let base = route["base_url"].as_str().unwrap();
            assert_eq!(base, &format!("http://{}", provision::DEPLOY_FIXTURE_ADDR));
        }
    }
}
