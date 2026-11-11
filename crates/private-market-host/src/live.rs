//! Explicit, two-phase registration for a measured native Chat seller.
//! Register before probing: throughput cannot predate the original offering.
use super::*;
use bitrouter_cloud::market::{
    inference::{AuthorizedOption, InferenceServiceType, OUTPUT_METER_VERSION},
    pg::{Candidate, Config, MarketCandidate, PgMarket},
};
use bitrouter_market::{
    admission::ScopeOffering,
    authorization::{OptionId, OrderRef, OrderSide},
    cache::{CacheIndex, CacheScope, TokenizedRequest},
    candidate::CandidateInput,
    exchange::{ExchangeCommand, ExecutionCommand, GlobalScopeReport, OfferingKey},
    execution_authorization::FrozenIdentity,
    manual_market::ManualMarketConfig,
    market_spec::MarketSpec,
    order::{OutputEstimate, Readiness, TokenRates, UnixMillis},
    purchase_order::{PurchaseQuoteContext, RootBinding},
    quote::LoadSnapshot,
    terms::{RequestSpec, SupplyState},
    throughput::{
        ThroughputClaim, ThroughputFilter, ThroughputObservation, ThroughputProfile, ThroughputRate,
    },
};
use std::collections::BTreeMap;

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Registration {
    pub version: u32,
    pub market_id: String,
    pub seller_principal: String,
    pub project_authorizes_on_demand_terms: bool,
    pub project_pays_upstream_costs: bool,
    pub origin: String,
    pub model: String,
    pub model_revision_ref: String,
    pub tokenizer_ref: String,
    pub tokenizer_url: String,
    pub tokenizer_files_sha256: BTreeMap<String, String>,
    pub token_ids: Vec<u32>,
    pub max_output_tokens: u64,
    pub context_window_tokens: u64,
    pub rates: TokenRates,
    pub request_sha256: String,
    pub offer_valid_until_ms: u64,
    pub upstream_budget_micro_usd: u64,
    pub maximum_upstream_calls: u64,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Measurement {
    pub registration_sha256: String,
    pub request_sha256: String,
    pub response_file: String,
    pub response_sha256: String,
    pub started_at_ms: u64,
    pub ended_at_ms: u64,
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub total_tokens: u64,
    pub response_model: String,
    pub finish_reason: String,
}

pub fn read<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T> {
    let bytes = fs::read(path).context("read private live-registration file")?;
    ensure!(
        bytes.len() <= 4 * 1024 * 1024,
        "live-registration file exceeds size limit"
    );
    serde_json::from_slice(&bytes).map_err(|_| anyhow::anyhow!("invalid live-registration file"))
}

fn hash(bytes: &[u8]) -> String {
    bitrouter_market::persistence_codec::digest(bytes)
}
fn ms() -> u64 {
    chrono::Utc::now().timestamp_millis() as u64
}
fn digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|v| v.is_ascii_digit() || (b'a'..=b'f').contains(&v))
}

fn verify_stream(registration: &Registration, measurement: &Measurement, raw: &[u8]) -> Result<()> {
    let text = std::str::from_utf8(raw).context("calibration is not UTF-8 SSE")?;
    let mut done = false;
    let mut usage = None;
    let mut finish = None;
    let mut visible = false;
    for line in text.lines().filter_map(|line| line.strip_prefix("data:")) {
        ensure!(!done, "calibration contains data after its terminator");
        let line = line.trim();
        if line == "[DONE]" {
            done = true;
            continue;
        }
        let frame: Value =
            serde_json::from_str(line).context("invalid native calibration frame")?;
        ensure!(
            frame["model"] == registration.model && frame["object"] == "chat.completion.chunk",
            "calibration model/protocol changed"
        );
        if let Some(value) = frame.get("usage").filter(|value| !value.is_null()) {
            usage = Some(value.clone());
        }
        for choice in frame["choices"]
            .as_array()
            .context("invalid native choices")?
        {
            ensure!(
                choice["index"] == 0,
                "calibration has unexpected output choices"
            );
            visible |= choice["delta"]["content"]
                .as_str()
                .is_some_and(|s| !s.is_empty());
            ensure!(
                choice["delta"]["refusal"]
                    .as_str()
                    .is_none_or(str::is_empty),
                "calibration was refused"
            );
            if let Some(reason) = choice["finish_reason"].as_str() {
                finish = Some(reason.to_owned());
            }
        }
    }
    let usage = usage.context("calibration lacks original usage")?;
    ensure!(
        done && visible
            && finish.as_deref() == Some(&measurement.finish_reason)
            && usage["prompt_tokens"].as_u64() == Some(measurement.prompt_tokens)
            && usage["completion_tokens"].as_u64() == Some(measurement.completion_tokens)
            && usage["total_tokens"].as_u64() == Some(measurement.total_tokens)
            && (measurement.finish_reason != "length"
                || measurement.completion_tokens == registration.max_output_tokens),
        "calibration summary contradicts original terminal/output/usage"
    );
    Ok(())
}

impl Registration {
    pub fn validate(&self) -> Result<()> {
        let origin = url::Url::parse(&self.origin).context("invalid registered HTTPS origin")?;
        let local = url::Url::parse(&self.tokenizer_url).context("invalid local tokenizer URL")?;
        ensure!(
            self.version == 1
                && self.project_authorizes_on_demand_terms
                && self.project_pays_upstream_costs,
            "live seller requires explicit project responsibility for its market terms and upstream costs"
        );
        ensure!(
            origin.scheme() == "https"
                && origin.host_str().is_some()
                && origin.username().is_empty()
                && origin.password().is_none()
                && origin.query().is_none()
                && origin.fragment().is_none(),
            "registered native seller must use HTTPS without credentials or URL options"
        );
        ensure!(
            local.scheme() == "http"
                && local.host_str() == Some("127.0.0.1")
                && local.port().is_some()
                && local.path() == "/tokenize"
                && local.query().is_none()
                && local.fragment().is_none()
                && local.username().is_empty()
                && local.password().is_none(),
            "tokenizer must be an explicit local qualifier"
        );
        for value in [
            &self.market_id,
            &self.seller_principal,
            &self.model,
            &self.model_revision_ref,
            &self.tokenizer_ref,
        ] {
            ensure!(
                !value.trim().is_empty() && value.len() <= 256,
                "invalid live registration reference"
            );
        }
        ensure!(
            digest(&self.request_sha256)
                && (2..=3).contains(&self.tokenizer_files_sha256.len())
                && ["tokenizer.json", "tokenizer_config.json"]
                    .iter()
                    .all(|name| self.tokenizer_files_sha256.contains_key(*name))
                && self
                    .tokenizer_files_sha256
                    .iter()
                    .all(|(name, value)| digest(value)
                        && matches!(
                            name.as_str(),
                            "tokenizer.json"
                                | "tokenizer_config.json"
                                | "chat_template.jinja"
                                | "chat_template.json"
                        )),
            "live registration needs pinned tokenizer files and request identity"
        );
        ensure!(
            !self.token_ids.is_empty()
                && self.token_ids.len() <= 8192
                && (1..=512).contains(&self.max_output_tokens)
                && self.token_ids.len() as u64 + self.max_output_tokens
                    <= self.context_window_tokens,
            "live workload is outside the bounded qualification size"
        );
        ensure!(
            self.offer_valid_until_ms > ms()
                && self.offer_valid_until_ms <= ms() + 3_600_000
                && self.upstream_budget_micro_usd > 0
                && self.maximum_upstream_calls == 4,
            "live run requires a bounded approval, four calls and offers valid for at most one hour"
        );
        let spec = self.spec();
        let request = self.profile().request_size;
        ensure!(
            bitrouter_market::cost::base_charge_cap(&spec, request, self.rates)?.0 > 0,
            "live offer must have a positive integer quote"
        );
        Ok(())
    }
    fn backend(&self) -> String {
        format!("live/{}", hash(self.origin.as_bytes()))
    }
    fn spec(&self) -> MarketSpec {
        let mut spec = catalog::spec("chat_completions");
        spec.reference.market_id = self.market_id.clone();
        spec.model_ref = self.model.clone();
        spec.throughput_profile_ref = format!("live/{}", self.request_sha256);
        spec.request_limits.context_window_tokens = self.context_window_tokens;
        spec.request_limits.max_output_tokens = self.max_output_tokens;
        spec
    }
    fn profile(&self) -> ThroughputProfile {
        let mut profile = catalog::profile(
            &Workload {
                token_ids: self.token_ids.clone(),
            },
            "chat_completions",
        );
        profile.reference = self.spec().throughput_profile_ref;
        profile.market_spec_ref = self.spec().reference;
        profile.request_size.max_output_tokens = self.max_output_tokens;
        profile.output_estimate = OutputEstimate {
            billable_output_tokens: self.max_output_tokens,
            visible_output_tokens: self.max_output_tokens,
        };
        profile.cache_condition_ref = "native-cache-unknown/usage-observed".into();
        profile.max_p95_e2e_ms = 90_000;
        profile
    }
    fn config(&self) -> Config {
        Config {
            market_id: self.market_id.clone(),
            issuer: ISSUER.into(),
            seller_payables: BTreeMap::from([(7, self.seller_principal.clone())]),
            offer_service_types: BTreeMap::from([(
                self.market_id.clone(),
                (11..=13)
                    .map(|id| (id, InferenceServiceType::OnDemand))
                    .collect(),
            )]),
        }
    }
    fn bootstrap(&self, at: UnixMillis) -> ManualMarketConfig {
        let mut config = catalog::config(
            &Workload {
                token_ids: self.token_ids.clone(),
            },
            at,
            "chat_completions",
            &[],
        );
        config.exchange_id = self.market_id.clone();
        config.specs = vec![self.spec()];
        config.scopes[0].members = (11..=13)
            .map(|id| bitrouter_market::exchange::ScopeMember {
                market_spec_ref: self.spec().reference,
                profile: self.profile(),
                offering: ScopeOffering {
                    offering_id: id,
                    provider_id: 7,
                    agent_config_ref: self.model_revision_ref.clone(),
                    backend_refs: vec![self.backend()],
                },
            })
            .collect();
        config.identities = BTreeMap::from([(
            self.backend(),
            FrozenIdentity {
                source_epoch: 1,
                backend_incarnation: self.model_revision_ref.clone(),
            },
        )]);
        config
    }
}

pub async fn register(db: sea_orm::DatabaseConnection, registration: &Registration) -> Result<()> {
    registration.validate()?;
    bitrouter_cloud::market::pg::install(&db).await?;
    let at = UnixMillis(ms());
    let until = UnixMillis(registration.offer_valid_until_ms);
    let config = registration.bootstrap(at);
    let mut market = PgMarket::create(db, registration.config(), config.bootstrap()?).await?;
    for id in 11..=13 {
        let mut seller = catalog::seller(
            id,
            7,
            registration.rates,
            until,
            180_000,
            "chat_completions",
        )?;
        seller.order.reference = OrderRef::new(
            registration.market_id.clone(),
            OrderSide::Sell,
            7,
            format!("seller-{id}"),
        )?;
        let ask = &mut seller.order.options[0].ask;
        ask.market_spec_ref = registration.spec().reference;
        ask.supply.agent_config_ref = registration.model_revision_ref.clone();
        ask.supply.throughput_profile_ref = registration.spec().throughput_profile_ref;
        let schedule = &mut seller.services[0].schedule;
        schedule.market_spec_ref = registration.spec().reference;
        schedule.model_ref = registration.model.clone();
        schedule.bins[0].input_tokens.max_inclusive = registration.context_window_tokens;
        schedule.bins[0].max_billable_output_tokens.max_inclusive = registration.max_output_tokens;
        market
            .publish_supply(
                seller.idempotency_key.clone(),
                ExchangeCommand::SubmitManualSellerOrder(Box::new(seller)),
            )
            .await?;
        market
            .publish_supply(
                format!("live-ready/{id}"),
                ExchangeCommand::Execution(Box::new(ExecutionCommand::RefreshSupply {
                    provider_id: 7,
                    source: OfferingKey {
                        market_id: registration.market_id.clone(),
                        offering_id: id,
                    },
                    generation: 1,
                    state: SupplyState {
                        readiness: Readiness::Ready,
                        throughput: ThroughputClaim {
                            profile_ref: registration.spec().throughput_profile_ref,
                            rate: ThroughputRate {
                                output_tokens: 1,
                                completed_requests: 1,
                                interval_ms: 90_000,
                            },
                        },
                        observed_at: at,
                        valid_until: until,
                    },
                })),
            )
            .await?;
    }
    market.close().await
}

pub async fn qualify(
    db: sea_orm::DatabaseConnection,
    registration: &Registration,
    registration_bytes: &[u8],
    measurement: Measurement,
) -> Result<Value> {
    registration.validate()?;
    let raw = fs::read(&measurement.response_file).context("read original calibration stream")?;
    ensure!(
        raw.len() <= 2 * 1024 * 1024
            && hash(registration_bytes) == measurement.registration_sha256
            && measurement.request_sha256 == registration.request_sha256
            && hash(&raw) == measurement.response_sha256,
        "calibration evidence does not match original registration/request/response"
    );
    ensure!(
        measurement.started_at_ms < measurement.ended_at_ms
            && measurement.ended_at_ms <= ms()
            && ms() - measurement.ended_at_ms <= 300_000
            && measurement.ended_at_ms - measurement.started_at_ms <= 90_000
            && measurement.response_model == registration.model
            && matches!(measurement.finish_reason.as_str(), "stop" | "length")
            && measurement.prompt_tokens == registration.token_ids.len() as u64
            && measurement.completion_tokens > 0
            && measurement.completion_tokens <= registration.max_output_tokens
            && measurement.total_tokens
                == measurement.prompt_tokens + measurement.completion_tokens,
        "calibration lacks a recent bounded model/terminal/usage qualification"
    );
    verify_stream(registration, &measurement, &raw)?;
    // The external collector validates the original SSE. Retain its bytes and
    // hash with the private run; this is trusted collector evidence, not a TEE proof.
    let mut market = PgMarket::open(db, registration.config()).await?;
    let observed = UnixMillis(ms());
    let until = UnixMillis(registration.offer_valid_until_ms);
    market
        .publish_supply(
            "live-observation-clock".into(),
            ExchangeCommand::AdvanceTime(observed),
        )
        .await?;
    for id in 11..=13 {
        let offering = market.host().snapshot_ref().books()[&registration.market_id]
            .get_offering(id)
            .and_then(|o| o.offering())
            .context("registered live offering missing")?
            .clone();
        market
            .publish_supply(
                format!("live-throughput/{id}"),
                ExchangeCommand::Execution(Box::new(ExecutionCommand::Throughput(Box::new(
                    ThroughputObservation {
                        offering,
                        profile: registration.profile(),
                        started_at: UnixMillis(measurement.started_at_ms),
                        ended_at: UnixMillis(measurement.ended_at_ms),
                        valid_until: until,
                        demand_sufficient: true,
                        completed_requests: 1,
                        failed_requests: 0,
                        billable_output_tokens: measurement.completion_tokens,
                        p95_e2e_ms: Some(measurement.ended_at_ms - measurement.started_at_ms),
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
        .publish_supply("live-scope".into(), ExchangeCommand::ScopeReport(scope))
        .await?;
    let request = RequestSpec {
        request_ref: "live-template".into(),
        request_digest: registration.request_sha256.clone(),
        size: registration.profile().request_size,
    };
    let option = AuthorizedOption {
        id: OptionId(1),
        model: registration.spec(),
        request,
        providers: vec![7],
    };
    let snapshot = market.host().snapshot_ref();
    let mut candidates = Vec::new();
    for id in 11..=13 {
        let key = OfferingKey {
            market_id: registration.market_id.clone(),
            offering_id: id,
        };
        let source = snapshot
            .sources()
            .get(&key)
            .context("live source missing")?;
        let (scope, member) = snapshot.scope_member(&key)?;
        let report = snapshot
            .scope_report(scope.id)
            .context("live scope missing")?;
        let book = &snapshot.books()[&registration.market_id];
        let offering = book
            .get_offering(id)
            .and_then(|o| o.offering())
            .context("live offering missing")?
            .clone();
        let cache_scope = CacheScope {
            market_spec_ref: book.spec().reference.clone(),
            model_ref: registration.model.clone(),
            agent_config_ref: registration.model_revision_ref.clone(),
            backend_ref: registration.backend(),
            cache_domain_ref: "upstream-cache-unknown".into(),
        };
        candidates.push(MarketCandidate {
            candidate: Candidate {
                context: PurchaseQuoteContext {
                    root: RootBinding {
                        root: OrderRef::new(
                            registration.market_id.clone(),
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
                        registration.token_ids.clone(),
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
                },
                input: CandidateInput {
                    offer_id: id,
                    offering,
                    scope: cache_scope.clone(),
                    cache: CacheIndex::new(book.spec(), cache_scope, observed)?.snapshot(),
                    load: LoadSnapshot {
                        reference: format!("live-load-{id}"),
                        version: 1,
                        source_ref: "project-authorized-market-quota".into(),
                        agent_config_ref: registration.model_revision_ref.clone(),
                        backend_ref: registration.backend(),
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
                    .seller_service(&key)
                    .context("live service missing")?
                    .schedule
                    .freeze(option.request.size)?,
            },
            output_meter: OUTPUT_METER_VERSION.into(),
            output_limit: registration.max_output_tokens,
            schema_profile: None,
            client_tools: false,
        });
    }
    let routes: Vec<_> = (11..=13).map(|id| json!({"backend":registration.backend(),"incarnation":registration.model_revision_ref,"offering_id":id,
        "native_model":registration.model,"base_url":registration.origin,"credential_env":"PRIVATE_MARKET_SELLER_KEY"})).collect();
    let order_time = registration
        .bootstrap(UnixMillis(ms()))
        .purchase_policy
        .time;
    market.close().await?;
    Ok(
        json!({"market":registration.config(),"strategy":{"wait_budget_ms":15000,"max_attempts":1,"default_output_tokens":registration.max_output_tokens,"order_time":order_time},
        "products":[{"protocol":"chat_completions","option":option,"candidates":candidates,"tokenizer_url":registration.tokenizer_url,"tokenizer_ref":registration.tokenizer_ref,"routes":routes}]}),
    )
}
