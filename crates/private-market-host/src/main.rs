//! Batch A: controlled, loopback-only host for the pinned Cloud Market.
//! No attestation or real-provider claim is made by this executable.
mod attestation;
mod catalog;
mod fixtures;
mod live;
mod provision;

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

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Buyer {
    user: String,
    credential_id: String,
    token: String,
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
fn write_private(path: &Path, value: &impl Serialize) -> Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)?;
    file.write_all(&serde_json::to_vec_pretty(value)?)?;
    file.sync_all()?;
    Ok(())
}

async fn initialize(dir: &Path, registration: Option<live::Registration>) -> Result<()> {
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
    let buyers: Vec<_> = (0..3)
        .map(|_| {
            let id = Uuid::new_v4().to_string();
            Buyer {
                user: Uuid::new_v4().to_string(),
                token: format!(
                    "brk_{id}.{}{}",
                    Uuid::new_v4().simple(),
                    Uuid::new_v4().simple()
                ),
                credential_id: id,
            }
        })
        .collect();
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
    // Reserve an available local fixture address for the catalog. A collision
    // at serve time fails binding before the market can dispatch.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let fixture_addr = listener.local_addr()?;
    let origin = format!("http://{fixture_addr}");
    let mut registration_sha256 = None;
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
    let state = State {
        database,
        redis,
        binding,
        cutover,
        fixture_addr,
        buyers,
        registration_sha256,
        catalog_sha256: None,
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
    ensure!(
        fs::canonicalize(required("INFERENCE_MARKET_CONFIG_PATH")?)?
            == fs::canonicalize(dir.join("catalog.json"))?,
        "catalog must belong to this state directory"
    );
    let is_live = state.registration_sha256.is_some();
    if is_live {
        ensure!(
            state.catalog_sha256.as_deref()
                == Some(&bitrouter_market::persistence_codec::digest(&fs::read(
                    dir.join("catalog.json")
                )?)),
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
    let authority_router = fixtures::authority(state.buyers, internal.clone());
    let resolver = Arc::new(
        RemoteIntrospectionResolver::new(
            authority_url,
            internal,
            Arc::new(PrincipalCache::with_ttl(Duration::ZERO)),
        )
        .with_source_realm(ISSUER.into())?,
    );
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
    // The catalog qualifies Chat only; other native protocols have no product.
    let native = market.router();
    let mode = if is_live {
        "live-provider"
    } else {
        "controlled"
    };
    let router =
        Router::new()
            .route(
                "/healthz",
                get(move || async move {
                    axum::Json(json!({"ready":true,"mode":mode,"attested":false}))
                }),
            )
            .nest("/market", native);
    let (router, attestation_available) = attestation::mount(router).await?;
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
        "usage: private-market-host <init|serve|init-live|qualify-live|validate-live> <state-or-profile> [input]"
    );
    match (args[1].as_str(), args.len()) {
        ("init", 3) => initialize(Path::new(&args[2]), None).await,
        ("init-live", 4) => {
            initialize(Path::new(&args[2]), Some(live::read(Path::new(&args[3]))?)).await
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
        _ => anyhow::bail!("expected init or serve"),
    }
}
