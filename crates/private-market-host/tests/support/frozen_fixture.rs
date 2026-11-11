//! Shared pure B-policy fixture; no network or durability.
use crate::fx::*;
use bitrouter_market::exchange::*;
use bitrouter_market::execution_authorization::*;
use bitrouter_market::fake_authority::*;
use bitrouter_market::market_host::*;
use bitrouter_market::order::*;
use bitrouter_market::terms::*;
use bitrouter_market::throughput::*;

pub(crate) fn control(e: &mut MarketHost, key: &str, command: ExecutionCommand) {
    e.execute(key.into(), ExchangeCommand::Execution(Box::new(command)))
        .unwrap();
}
pub(crate) fn source(market: &str) -> OfferingKey {
    OfferingKey {
        market_id: market.into(),
        offering_id: 11,
    }
}
pub(crate) fn ready(e: &mut MarketHost, market: &str, generation: u64) {
    ready_source(e, &source(market), generation);
}
pub(crate) fn ready_source(e: &mut MarketHost, key: &OfferingKey, generation: u64) {
    let market = &key.market_id;
    let now = e.snapshot().now();
    control(
        e,
        &format!("ready-{market}-{generation}-{}", now.0),
        ExecutionCommand::RefreshSupply {
            provider_id: 7,
            source: key.clone(),
            generation,
            state: SupplyState {
                readiness: Readiness::Ready,
                throughput: ThroughputClaim {
                    profile_ref: profile(market).reference,
                    rate: ThroughputRate {
                        output_tokens: 1,
                        completed_requests: 1,
                        interval_ms: 1000,
                    },
                },
                observed_at: now,
                valid_until: UnixMillis(9_000),
            },
        },
    );
    run(
        e,
        &format!("measure-until-{market}-{generation}-{}", now.0),
        ExchangeCommand::AdvanceTime(UnixMillis(now.0 + 1000)),
    );
    throughput_source(e, key, true);
}
pub(crate) fn throughput(e: &mut MarketHost, market: &str, sufficient: bool) {
    throughput_source(e, &source(market), sufficient);
}
pub(crate) fn throughput_source(e: &mut MarketHost, key: &OfferingKey, sufficient: bool) {
    let market = &key.market_id;
    let snapshot = e.snapshot();
    let offering = snapshot.books()[market]
        .get_offering(key.offering_id)
        .unwrap()
        .offering()
        .unwrap()
        .clone();
    control(
        e,
        &format!("throughput-{market}-{}-{sufficient}", snapshot.now().0),
        ExecutionCommand::Throughput(Box::new(ThroughputObservation {
            offering,
            profile: profile(market),
            started_at: UnixMillis(snapshot.now().0 - 1000),
            ended_at: snapshot.now(),
            valid_until: UnixMillis(8_000),
            demand_sufficient: sufficient,
            completed_requests: 10,
            failed_requests: 0,
            billable_output_tokens: 10,
            p95_e2e_ms: Some(if sufficient { 100 } else { 700 }),
        })),
    );
}

pub(crate) fn run(h: &mut MarketHost, key: &str, command: ExchangeCommand) {
    h.execute(key.into(), command).unwrap();
}
pub(crate) fn bootstrap(shared: bool) -> MarketHost {
    let identities = scopes(shared)
        .iter()
        .flat_map(|s| &s.members)
        .flat_map(|m| &m.offering.backend_refs)
        .map(|b| {
            (
                b.clone(),
                FrozenIdentity {
                    source_epoch: 4,
                    backend_incarnation: "instance-1".into(),
                },
            )
        })
        .collect();
    MarketHost::new(
        "exchange".into(),
        vec![spec("a"), spec("b")],
        scopes(shared),
        identities,
        NOW,
    )
    .unwrap()
}
pub(crate) fn authority(shared: bool, now: UnixMillis) -> FakeAuthority {
    let targets = scopes(shared)
        .iter()
        .flat_map(|s| {
            s.members.iter().flat_map(move |m| {
                m.offering
                    .backend_refs
                    .iter()
                    .map(move |backend| ExecutionTarget {
                        scope_id: s.id,
                        spec: m.market_spec_ref.clone(),
                        model_ref: spec(&m.market_spec_ref.market_id).model_ref,
                        offering_id: m.offering.offering_id,
                        agent_config_ref: m.offering.agent_config_ref.clone(),
                        backend_ref: backend.clone(),
                        backend_incarnation: "instance-1".into(),
                    })
            })
        })
        .collect();
    FakeAuthority::new(
        AUTH,
        4,
        targets,
        scopes(shared)
            .iter()
            .map(|s| AuthorityScope {
                id: s.id,
                capacity: s.max_unresolved_requests,
                ready: true,
            })
            .collect(),
        now,
    )
    .unwrap()
}
pub(crate) fn usage() -> TokenUsage {
    TokenUsage {
        uncached_input_tokens: 10,
        cached_input_tokens: 0,
        billable_output_tokens: 1,
    }
}
