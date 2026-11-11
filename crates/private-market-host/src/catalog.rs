// Adapted from Cloud PR 667 controlled seller catalog; see upstream/SOURCES.md.
use super::{MODEL, Workload};
use bitrouter_market::{
    admission::{AdmissionScopeId, ReportAuthorityId, ScopeOffering},
    authorization::{OptionId, OrderRef, OrderSide},
    cost::NUMERICAL_RULES_REF,
    exchange::{PhysicalScope, ScopeMember, SellOptionInput},
    execution_authorization::FrozenIdentity,
    manual_market::{MANUAL_MARKET_RULES, ManualMarketConfig},
    manual_seller_order::{
        MANUAL_SELLER_ORDER_RULES, ManualSellerService, SubmitManualSellerOrder,
    },
    market_spec::{MarketSpec, MeteringSpec},
    order::*,
    purchase_order::*,
    seller_order::SellOfferAuthorization,
    seller_service::*,
    terms::{AskOrder, SupplyBinding},
    throughput::*,
};
pub(crate) const MARKET: &str = "controlled-chat";
pub(crate) const EXCHANGE: &str = "private-market-batch-a";
pub(crate) const BACKEND: &str = "controlled-native";

pub(super) const AUTH: ReportAuthorityId = ReportAuthorityId(7);
pub(crate) fn spec(protocol: &str) -> MarketSpec {
    MarketSpec {
        reference: MarketSpecRef {
            market_id: MARKET.into(),
            revision: 1,
        },
        model_ref: MODEL.into(),
        request_protocol_ref: protocol.into(),
        throughput_profile_ref: "public-api/synthetic-text-v1".into(),
        request_limits: RequestLimits {
            context_window_tokens: 262144,
            max_output_tokens: 64,
        },
        metering: MeteringSpec {
            output_metering_ref: bitrouter_cloud::market::inference::OUTPUT_METER_VERSION.into(),
            numerical_rules_ref: NUMERICAL_RULES_REF.into(),
        },
    }
}
pub(crate) fn profile(w: &Workload, protocol: &str) -> ThroughputProfile {
    ThroughputProfile {
        reference: spec(protocol).throughput_profile_ref,
        market_spec_ref: spec(protocol).reference,
        request_size: RequestSize {
            input_tokens: w.token_ids.len() as u64,
            max_output_tokens: 64,
        },
        output_estimate: OutputEstimate {
            billable_output_tokens: 2,
            visible_output_tokens: 2,
        },
        cache_condition_ref: "upstream-managed-cache/actual-usage-observed".into(),
        min_window_ms: 1,
        min_sample_requests: 1,
        max_p95_e2e_ms: 90000,
        max_failure_bps: 1,
    }
}
pub(crate) fn config(
    w: &Workload,
    at: UnixMillis,
    protocol: &str,
    sellers: &[(u64, u64, &str)],
) -> ManualMarketConfig {
    ManualMarketConfig {
        version: 1,
        rules_ref: MANUAL_MARKET_RULES.into(),
        exchange_id: EXCHANGE.into(),
        specs: vec![spec(protocol)],
        scopes: vec![PhysicalScope {
            id: AdmissionScopeId(30),
            authority_id: AUTH,
            max_unresolved_requests: 1,
            members: sellers
                .iter()
                .map(|&(id, provider_id, _)| ScopeMember {
                    market_spec_ref: spec(protocol).reference,
                    profile: profile(w, protocol),
                    offering: ScopeOffering {
                        offering_id: id,
                        provider_id,
                        agent_config_ref: "public-api/delegation-v1".into(),
                        backend_refs: vec![format!("{BACKEND}-{id}")],
                    },
                })
                .collect(),
        }],
        identities: sellers
            .iter()
            .map(|&(id, _, _)| {
                (
                    format!("{BACKEND}-{id}"),
                    FrozenIdentity {
                        source_epoch: 1,
                        backend_incarnation: "delegation-v1".into(),
                    },
                )
            })
            .collect(),
        initial_time: at,
        purchase_policy: RegistrationPolicy {
            funding_rules_ref: REGISTRATION_INTERRUPTIBLE_FUNDING_RULES_REF.into(),
            time: TimePolicy {
                rules_ref: TIME_RULES_REF.into(),
                immediate_decision_window_ms: 10000,
                immediate_total_window_ms: 120000,
                grant_acceptance_window_ms: 10_000,
            },
        },
        runtime: None,
    }
}
pub(crate) fn seller(
    id: u64,
    provider_id: u64,
    rates: TokenRates,
    until: UnixMillis,
    hard_delivery_within_ms: u64,
    protocol: &str,
) -> anyhow::Result<SubmitManualSellerOrder> {
    let ask = AskOrder {
        offering_id: id,
        provider_id,
        market_spec_ref: spec(protocol).reference,
        supply: SupplyBinding {
            agent_config_ref: "public-api/delegation-v1".into(),
            throughput_profile_ref: spec(protocol).throughput_profile_ref,
        },
        rates,
        valid_until: until,
    };
    Ok(SubmitManualSellerOrder {
        version: bitrouter_market::manual_seller_order::MANUAL_SELLER_ORDER_VERSION,
        rules_ref: MANUAL_SELLER_ORDER_RULES.into(),
        idempotency_key: format!("seller/{id}"),
        order: SellOfferAuthorization {
            reference: OrderRef::new(
                EXCHANGE.into(),
                OrderSide::Sell,
                provider_id,
                format!("seller-{id}"),
            )?,
            opportunity_id: format!("quote/{id}"),
            options: vec![SellOptionInput {
                option_id: OptionId(1),
                ask,
                expected_binding_generation: 0,
            }],
            tif: TimeInForce::Gtd { expires_at: until },
        },
        services: vec![ManualSellerService {
            option_id: OptionId(1),
            schedule: SellerServiceSchedule {
                version: 1,
                rules_ref: SERVICE_RULES_REF.into(),
                reference: format!("service/{id}"),
                revision: 1,
                provider_id,
                market_spec_ref: spec(protocol).reference,
                model_ref: MODEL.into(),
                request_protocol_ref: protocol.into(),
                numerical_rules_ref: NUMERICAL_RULES_REF.into(),
                output_metering_ref: spec(protocol).metering.output_metering_ref,
                rates,
                bins: vec![ServiceBin {
                    hard_delivery_within_ms,
                    bin_id: "bounded-text".into(),
                    input_tokens: TokenRange {
                        min_inclusive: 0,
                        max_inclusive: 262144,
                    },
                    max_billable_output_tokens: TokenRange {
                        min_inclusive: 1,
                        max_inclusive: 64,
                    },
                    delivery: DeliveryConditions::PerformanceTarget {
                        first_response_within_ms: 60000,
                        complete_within_ms: 90000,
                    },
                }],
            },
        }],
    })
}
