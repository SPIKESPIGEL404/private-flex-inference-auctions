use crate::pf;
use bitrouter_market::admission::AttemptId;
use bitrouter_market::exchange::ExchangeCommand;
use bitrouter_market::execution_coordinator::*;
use bitrouter_market::fake_authority::FakeAuthority;
use bitrouter_market::market_host::MarketHost;
pub fn policy() -> ExecutionCoordinationPolicy {
    ExecutionCoordinationPolicy {
        version: COORDINATION_VERSION,
        reference: "fixture/explicit-coordination".into(),
        revision: 1,
        query_interval_ms: 100,
        unknown_retry_interval_ms: 20,
    }
}
pub fn bootstrap() -> MarketHost {
    pf::bootstrap(false)
        .with_execution_coordination(policy())
        .unwrap()
}
pub fn setup(ioc: bool) -> (MarketHost, FakeAuthority, AttemptId) {
    let (seed, a) = pf::setup(false, false);
    let mut h = bootstrap();
    for (key, c) in seed.journal().commands() {
        h.execute(key.clone(), c.clone()).unwrap();
    }
    let r = pf::registration("coordinate", 1, &["a"], ioc);
    pf::register(&mut h, &r);
    let q = pf::publication(&h, &r, 1, "coordinate");
    pf::publish(&mut h, &q);
    let p = pf::proposal(&h, &r, &[q], "coordinate");
    let id = pf::id(&pf::propose(&mut h, &p));
    assert!(matches!(
        h.journal().commands().last().unwrap().1,
        ExchangeCommand::ProposePurchase(_)
    ));
    (h, a, id)
}
