// Adapted from the pinned Cloud native-market acceptance fixture.
use super::*;
use bitrouter_cloud::market::{
    inference::{AuthorizedOption, InferenceServiceType, OUTPUT_METER_VERSION},
    pg::{Candidate, Config, MarketCandidate, PgMarket},
};
use bitrouter_market::{
    authorization::{OptionId, OrderRef, OrderSide},
    cache::{CacheIndex, CacheScope, TokenizedRequest},
    candidate::CandidateInput,
    exchange::{ExchangeCommand, ExecutionCommand, GlobalScopeReport, OfferingKey},
    order::{Readiness, TokenRates, UnixMillis},
    purchase_order::{PurchaseQuoteContext, RootBinding},
    quote::LoadSnapshot,
    terms::{RequestSpec, SupplyState},
    throughput::{ThroughputClaim, ThroughputFilter, ThroughputObservation, ThroughputRate},
};
use std::collections::BTreeMap;

/// Loopback fixture published in the deploy catalog / golden file.
pub const DEPLOY_FIXTURE_ADDR: &str = "127.0.0.1:18080";
/// Catalog "at" clock: fixed past instant (2023-11-14T22:13:20Z). Always ≥24h
/// older than real time for any deploy after that date.
pub const DEPLOY_CATALOG_AT_MS: u64 = 1_700_000_000_000;
/// Far-future validity bound (2099-12-31T00:00:00Z). Wall-clock-sensitive
/// fields (seller `valid_until` / GTD `expires_at`, supply `valid_until`,
/// throughput observation `valid_until`, load snapshot `valid_until`, scope
/// report `valid_until`) use this instead of `at + 30m` so a past frozen
/// clock cannot expire live purchases.
pub const DEPLOY_CATALOG_VALID_UNTIL_MS: u64 = 4_102_444_800_000;
/// Golden catalog path baked into the deploy image.
pub const DEPLOY_GOLDEN_CATALOG: &str = "/etc/market/catalog.json";

fn ms() -> UnixMillis {
    UnixMillis(chrono::Utc::now().timestamp_millis() as u64)
}

/// Lab path: wall-clock schedule (unchanged).
pub async fn create(
    db: sea_orm::DatabaseConnection,
    tokenizer_url: &str,
    seller_url: &str,
) -> Result<Value> {
    let at = ms();
    create_with_schedule(
        db,
        tokenizer_url,
        seller_url,
        at,
        UnixMillis(at.0 + 1_800_000),
    )
    .await
}

/// Deploy path: frozen past `at`, far-future `until`. Deterministic given an
/// empty DB and fixed fixture URLs.
pub async fn create_deploy(
    db: sea_orm::DatabaseConnection,
    tokenizer_url: &str,
    seller_url: &str,
) -> Result<Value> {
    create_with_schedule(
        db,
        tokenizer_url,
        seller_url,
        UnixMillis(DEPLOY_CATALOG_AT_MS),
        UnixMillis(DEPLOY_CATALOG_VALID_UNTIL_MS),
    )
    .await
}

async fn create_with_schedule(
    db: sea_orm::DatabaseConnection,
    tokenizer_url: &str,
    seller_url: &str,
    at: UnixMillis,
    until: UnixMillis,
) -> Result<Value> {
    bitrouter_cloud::market::pg::install(&db).await?;
    let work = Workload {
        token_ids: vec![42, 43],
    };
    let sellers = &[
        (11, 7, "controlled"),
        (12, 7, "controlled"),
        (13, 7, "controlled"),
    ];
    let protocol = "chat_completions";
    let mut config = catalog::config(&work, at, protocol, sellers);
    // Three one-use sell orders from one Provider share one physical slot.
    let shared_backend = config.scopes[0].members[0].offering.backend_refs.clone();
    for member in &mut config.scopes[0].members {
        member.offering.backend_refs.clone_from(&shared_backend);
    }
    let cfg = Config {
        market_id: catalog::EXCHANGE.into(),
        issuer: ISSUER.into(),
        offer_service_types: BTreeMap::from([(
            catalog::MARKET.into(),
            sellers
                .iter()
                .map(|&(id, _, _)| (id, InferenceServiceType::OnDemand))
                .collect(),
        )]),
        seller_payables: sellers
            .iter()
            .map(|&(_, provider, _)| {
                (
                    provider,
                    if provider == 7 {
                        "seller-fixture".into()
                    } else {
                        format!("seller-fixture-{provider}")
                    },
                )
            })
            .collect(),
    };
    let mut market = PgMarket::create(db, cfg.clone(), config.bootstrap()?).await?;
    for &(id, provider_id, _) in sellers {
        let sale = catalog::seller(
            id,
            provider_id,
            TokenRates {
                input: 1_000_000,
                cache_input: 1_000_000,
                output: 11_000_000,
            },
            until,
            180_000,
            protocol,
        )?;
        market
            .publish_supply(
                sale.idempotency_key.clone(),
                ExchangeCommand::SubmitManualSellerOrder(Box::new(sale)),
            )
            .await?;
        market
            .publish_supply(
                format!("ready/{id}"),
                ExchangeCommand::Execution(Box::new(ExecutionCommand::RefreshSupply {
                    provider_id,
                    source: OfferingKey {
                        market_id: catalog::MARKET.into(),
                        offering_id: id,
                    },
                    generation: 1,
                    state: SupplyState {
                        readiness: Readiness::Ready,
                        throughput: ThroughputClaim {
                            profile_ref: catalog::spec(protocol).throughput_profile_ref,
                            rate: ThroughputRate {
                                output_tokens: 1,
                                completed_requests: 1,
                                interval_ms: 1_000,
                            },
                        },
                        observed_at: at,
                        valid_until: until,
                    },
                })),
            )
            .await?;
    }
    // Deterministic relative to `at` (lab and deploy). Do not call wall clock.
    let observed = UnixMillis(at.0 + 1);
    market
        .publish_supply(
            "observation-clock".into(),
            ExchangeCommand::AdvanceTime(observed),
        )
        .await?;
    for &(id, _, _) in sellers {
        let offering = market.host().snapshot_ref().books()[catalog::MARKET]
            .get_offering(id)
            .and_then(|o| o.offering())
            .context("missing seller offering")?
            .clone();
        market
            .publish_supply(
                format!("throughput/{id}"),
                ExchangeCommand::Execution(Box::new(ExecutionCommand::Throughput(Box::new(
                    ThroughputObservation {
                        offering,
                        profile: catalog::profile(&work, protocol),
                        started_at: at,
                        ended_at: observed,
                        valid_until: until,
                        demand_sufficient: true,
                        completed_requests: 1,
                        failed_requests: 0,
                        billable_output_tokens: 48,
                        p95_e2e_ms: Some(1),
                    },
                )))),
            )
            .await?;
    }
    let scope: GlobalScopeReport = serde_json::from_value(json!({
        "metadata":{"scope_id":30,"authority_id":7,"version":{"generation":1,"sequence":1},"observed_at":observed,"valid_until":until},
        "open":true,"responsibilities":[]
    }))?;
    market
        .publish_supply("scope".into(), ExchangeCommand::ScopeReport(scope))
        .await?;
    let snapshot = market.host().snapshot_ref();
    let request = RequestSpec {
        request_ref: "template".into(),
        request_digest: "template".into(),
        size: catalog::profile(&work, protocol).request_size,
    };
    let option = AuthorizedOption {
        id: OptionId(1),
        model: catalog::spec(protocol),
        request,
        providers: cfg.seller_payables.keys().copied().collect(),
    };
    let mut candidates = Vec::new();
    for &(id, _, _) in sellers {
        let source_key = OfferingKey {
            market_id: catalog::MARKET.into(),
            offering_id: id,
        };
        let source = snapshot.sources().get(&source_key).context("source")?;
        let (scope, member) = snapshot.scope_member(&source_key)?;
        let report = snapshot.scope_report(scope.id).context("scope report")?;
        let book = &snapshot.books()[catalog::MARKET];
        let offering = book
            .get_offering(id)
            .and_then(|o| o.offering())
            .context("offering")?
            .clone();
        let backend = member
            .offering
            .backend_refs
            .first()
            .context("backend")?
            .clone();
        let cache_scope = CacheScope {
            market_spec_ref: book.spec().reference.clone(),
            model_ref: MODEL.into(),
            agent_config_ref: offering.agent_config_ref.clone(),
            backend_ref: backend.clone(),
            cache_domain_ref: "controlled-cache".into(),
        };
        let context = PurchaseQuoteContext {
            root: RootBinding {
                root: OrderRef::new(
                    catalog::EXCHANGE.into(),
                    OrderSide::Buy,
                    999,
                    "template".into(),
                )?,
                authorization_version: 1,
            },
            option_id: option.id,
            spec: book.spec().clone(),
            tokens: TokenizedRequest::from_request(
                book.spec(),
                &option.request,
                work.token_ids.clone(),
            )?,
            profile: member.profile.clone(),
            throughput_filter: ThroughputFilter {
                minimum: ThroughputRate {
                    output_tokens: 0,
                    completed_requests: 0,
                    interval_ms: 1000,
                },
            },
            output_estimate: member.profile.output_estimate,
            compared_at: observed,
        };
        candidates.push(MarketCandidate {
            candidate: Candidate {
                context,
                input: CandidateInput {
                    offer_id: id,
                    offering,
                    scope: cache_scope.clone(),
                    cache: CacheIndex::new(book.spec(), cache_scope, observed)?.snapshot(),
                    load: LoadSnapshot {
                        reference: format!("load-{id}"),
                        version: report.metadata.version.sequence,
                        source_ref: "controlled-exclusive-slot".into(),
                        agent_config_ref: member.offering.agent_config_ref.clone(),
                        backend_ref: backend,
                        observed_at: observed,
                        valid_until: until,
                        market_requests: 0,
                    },
                    prediction: None,
                    throughput_observation: book.get_throughput_observation(id).cloned(),
                    market_requests_after_admission: 1,
                },
                source_generation: source.generation,
                seller_option: source.option.clone(),
                load_report: report.metadata.clone(),
                service: snapshot
                    .seller_service(&source_key)
                    .context("seller service")?
                    .schedule
                    .freeze(option.request.size)?,
            },
            output_meter: OUTPUT_METER_VERSION.into(),
            output_limit: 64,
            schema_profile: Some(bitrouter_cloud::market::inference::SCHEMA_PROFILE.into()),
            client_tools: true,
        });
    }

    let routes: Vec<_> = candidates
        .iter()
        .map(|product| {
            json!({
                "backend":product.candidate.input.load.backend_ref,
                "incarnation":"delegation-v1", "offering_id":product.candidate.input.offering.id,
                "native_model":"native-a", "base_url":seller_url,
                "credential_env":"PRIVATE_MARKET_SELLER_KEY"
            })
        })
        .collect();
    market.close().await?;
    Ok(json!({
      "market": cfg,
      "strategy": {"wait_budget_ms":15000,"max_attempts":1,"default_output_tokens":64,"order_time":config.purchase_policy.time},
      "products":[{"protocol":"chat_completions","option":option,"candidates":candidates,
       "tokenizer_url":format!("{tokenizer_url}/tokenize"),"tokenizer_ref":"controlled/tokenizer-v1",
       "routes":routes}]
    }))
}
