//! E3 fixture helpers with one visible output token; no real Provider calls.
use crate::common;
use bitrouter_market::admission::*;
use bitrouter_market::authorization::*;
use bitrouter_market::exchange::*;
use bitrouter_market::market_spec::MarketSpec;
use bitrouter_market::order::*;
use bitrouter_market::terms::*;
use bitrouter_market::throughput::ThroughputProfile;

pub const NOW: UnixMillis = UnixMillis(1_000);
pub const AUTH: ReportAuthorityId = ReportAuthorityId(7);

pub fn spec(market: &str) -> MarketSpec {
    let mut s = common::spec();
    s.reference = MarketSpecRef {
        market_id: market.into(),
        revision: 3,
    };
    s.model_ref = format!("model/{market}");
    s.throughput_profile_ref = format!("profile/{market}");
    s
}
pub fn profile(market: &str) -> ThroughputProfile {
    let mut p = common::profile();
    p.reference = spec(market).throughput_profile_ref;
    p.market_spec_ref = spec(market).reference;
    p.request_size = RequestSize {
        input_tokens: 10,
        max_output_tokens: 1,
    };
    p.output_estimate = OutputEstimate {
        billable_output_tokens: 1,
        visible_output_tokens: 1,
    };
    p
}
pub fn member(market: &str, backend: &str) -> ScopeMember {
    ScopeMember {
        market_spec_ref: spec(market).reference,
        profile: profile(market),
        offering: ScopeOffering {
            offering_id: 11,
            provider_id: 7,
            agent_config_ref: format!("config/{market}"),
            backend_refs: vec![backend.into()],
        },
    }
}
pub fn scopes(shared: bool) -> Vec<PhysicalScope> {
    if shared {
        vec![PhysicalScope {
            id: AdmissionScopeId(30),
            authority_id: AUTH,
            max_unresolved_requests: 1,
            members: vec![member("a", "shared"), member("b", "shared")],
        }]
    } else {
        vec![
            PhysicalScope {
                id: AdmissionScopeId(30),
                authority_id: AUTH,
                max_unresolved_requests: 1,
                members: vec![member("a", "backend-a")],
            },
            PhysicalScope {
                id: AdmissionScopeId(31),
                authority_id: AUTH,
                max_unresolved_requests: 1,
                members: vec![member("b", "backend-b")],
            },
        ]
    }
}
pub fn reference(side: OrderSide, owner: u64, name: &str) -> OrderRef {
    OrderRef::new("exchange".into(), side, owner, name.into()).unwrap()
}
pub fn sell(name: &str, markets: &[&str]) -> SellOfferInput {
    SellOfferInput {
        reference: reference(OrderSide::Sell, 7, name),
        opportunity_id: format!("opportunity/{name}"),
        rules_ref: RULES_REF.into(),
        expires_at: UnixMillis(9_000),
        options: markets
            .iter()
            .enumerate()
            .map(|(i, m)| SellOptionInput {
                option_id: OptionId(i as u32 + 1),
                ask: AskOrder {
                    offering_id: 11,
                    provider_id: 7,
                    market_spec_ref: spec(m).reference,
                    supply: SupplyBinding {
                        agent_config_ref: format!("config/{m}"),
                        throughput_profile_ref: format!("profile/{m}"),
                    },
                    rates: TokenRates {
                        input: 1_000_000,
                        cache_input: 0,
                        output: 0,
                    },
                    valid_until: UnixMillis(9_000),
                },
                expected_binding_generation: 0,
            })
            .collect(),
    }
}
pub fn report(scope: u64, seq: u64, items: Vec<ScopeResponsibility>) -> GlobalScopeReport {
    GlobalScopeReport {
        metadata: SchedulerReportMetadata {
            scope_id: AdmissionScopeId(scope),
            authority_id: AUTH,
            version: SchedulerReportVersion {
                generation: 1,
                sequence: seq,
            },
            observed_at: NOW,
            valid_until: UnixMillis(9_000),
        },
        open: true,
        responsibilities: items,
    }
}
