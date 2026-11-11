#![cfg(feature = "sqlite-tools")]
use bitrouter_market::formal_order::CloseFormalOrder;
use bitrouter_market::formal_order::PlaceFormalOrder;
#[allow(dead_code)]
mod common;
#[allow(dead_code)]
#[path = "support/frozen_fixture.rs"]
mod fixture;
#[allow(dead_code)]
#[path = "support/conditional_exchange.rs"]
mod fx;

use bitrouter_market::durable::*;
use bitrouter_market::exchange::*;
use bitrouter_market::market_host::{HostError, MarketHost};
use bitrouter_market::order::*;
use bitrouter_market::purchase_order::*;
use std::path::PathBuf;

fn policy() -> RegistrationPolicy {
    RegistrationPolicy {
        funding_rules_ref: REGISTRATION_FUNDING_RULES_REF.into(),
        time: TimePolicy {
            rules_ref: TIME_RULES_REF.into(),
            immediate_decision_window_ms: 100,
            immediate_total_window_ms: 300,
            grant_acceptance_window_ms: 200,
        },
    }
}
fn bootstrap() -> MarketHost {
    fixture::bootstrap(false)
        .with_purchase_orders(policy())
        .unwrap()
}
#[allow(dead_code)]
#[path = "support/purchase_fixture.rs"]
mod pf;
fn input(name: &str, owner: u64, cap: u64) -> PlaceFormalOrder {
    let mut p = pf::registration(name, owner, &["a", "b"], false);
    p.authorization.max_charge = MicroUsd(cap);
    p
}
fn register(h: &mut MarketHost, i: &PlaceFormalOrder) -> ExchangeReceipt {
    h.execute(i.idempotency_key.clone(), command(i)).unwrap()
}
fn command(i: &PlaceFormalOrder) -> ExchangeCommand {
    ExchangeCommand::PlaceFormalOrder(Box::new(i.clone()))
}
fn credit(h: &mut MarketHost, amount: u64, key: &str) {
    fixture::run(
        h,
        key,
        ExchangeCommand::Credit {
            buyer_id: 1,
            amount: MicroUsd(amount),
        },
    );
}
fn close(i: &PlaceFormalOrder, key: &str) -> ExchangeCommand {
    ExchangeCommand::CloseFormalOrder(CloseFormalOrder {
        idempotency_key: key.into(),
        root: i.authorization.binding.clone(),
    })
}
fn record(h: &MarketHost, i: &PlaceFormalOrder) -> RegisteredPurchaseOrder {
    h.snapshot().purchase_orders().unwrap()[&i.authorization.binding.root].clone()
}

#[test]
fn placement_retains_authorization_and_funds_until_qualified_evidence_arrives() {
    let mut h = bootstrap();
    credit(&mut h, 100, "credit");
    fixture::run(
        &mut h,
        "sell",
        ExchangeCommand::SubmitSell(fx::sell("seller", &["a"])),
    );
    fixture::ready(&mut h, "a", 1);
    fixture::run(
        &mut h,
        "scope",
        ExchangeCommand::ScopeReport(fx::report(30, 1, vec![])),
    );
    let i = input("new", 1, 80);
    register(&mut h, &i);
    let r = record(&h, &i);
    assert_eq!(r.registration(), &i);
    assert_eq!(r.funding().unwrap().unassigned(), MicroUsd(80));
    assert_eq!(h.snapshot().accounts()[&1].held(), MicroUsd(80));
    // A real economic quote replacement after registration must also leave
    // this root waiting; it is not merely a no-op tick with unchanged supply.
    fixture::run(
        &mut h,
        "withdraw-before-reprice",
        ExchangeCommand::Close(fx::sell("seller", &["a"]).reference),
    );
    let mut replacement = fx::sell("seller-v2", &["a"]);
    replacement.options[0].expected_binding_generation = 1;
    replacement.options[0].ask.rates.input = 2_000_000;
    fixture::run(&mut h, "reprice", ExchangeCommand::SubmitSell(replacement));
    fixture::ready(&mut h, "a", 2);
    fixture::run(
        &mut h,
        "tick",
        ExchangeCommand::AdvanceTime(UnixMillis(3_000)),
    );
    credit(&mut h, 10, "extra-credit");
    let snapshot = h.snapshot();
    assert!(snapshot.frozen_grants().unwrap().is_empty());
    assert!(snapshot.execution_requests().unwrap().is_empty());
    assert!(record(&h, &i).closure().is_none());
}

#[test]
fn successful_retry_after_expiry_returns_original_time_sequence_and_receipt() {
    let mut h = bootstrap();
    credit(&mut h, 100, "credit");
    let mut i = input("ioc", 1, 80);
    i.authorization.tif = TimeInForce::Ioc {};
    let original = register(&mut h, &i);
    fixture::run(
        &mut h,
        "time",
        ExchangeCommand::AdvanceTime(UnixMillis(1_100)),
    );
    let snapshot = h.snapshot();
    assert_eq!(register(&mut h, &i), original);
    assert_eq!(h.snapshot(), snapshot);
    let r = record(&h, &i);
    assert_eq!(r.receipt().window.registered_at, fx::NOW);
    assert_eq!(r.receipt().window.accept_before, UnixMillis(1_300));
    assert_eq!(r.closure().unwrap().reason, OrderClosureReason::Expired);
    assert_eq!(h.snapshot().accounts()[&1].held(), MicroUsd(0));
    let mut changed = i.clone();
    changed.authorization.binding.authorization_version += 1;
    assert!(matches!(
        h.execute(changed.idempotency_key.clone(), command(&changed)),
        Err(HostError::Market(ExchangeError::Conflict("idempotency")))
    ));
    changed.idempotency_key = "new-key".into();
    assert!(matches!(
        h.execute(changed.idempotency_key.clone(), command(&changed)),
        Err(HostError::Market(ExchangeError::Conflict("order identity")))
    ));
    assert_eq!(h.snapshot(), snapshot);
}

#[test]
fn rejection_and_abandoned_or_stale_prepare_do_not_bind_registration_or_funds() {
    let mut h = bootstrap();
    credit(&mut h, 100, "credit");
    let mut i = input("r", 1, 80);
    i.version = 3;
    let before = h.snapshot();
    assert!(h.execute(i.idempotency_key.clone(), command(&i)).is_err());
    assert_eq!(h.snapshot(), before);
    i.version = bitrouter_market::formal_order::FORMAL_VERSION;
    let PrepareOutcome::Prepared(p) = h.prepare(i.idempotency_key.clone(), command(&i)).unwrap()
    else {
        panic!("prepared")
    };
    assert!(p.record().grants().is_empty());
    assert!(p.record().effects().is_empty());
    assert_eq!(p.next_snapshot().accounts()[&1].held(), MicroUsd(80));
    assert_eq!(h.snapshot(), before);
    drop(p);
    let PrepareOutcome::Prepared(p) = h.prepare(i.idempotency_key.clone(), command(&i)).unwrap()
    else {
        panic!("prepared")
    };
    credit(&mut h, 1, "advance-revision");
    assert!(matches!(
        h.publish(*p),
        Err(HostError::Market(ExchangeError::StalePlan))
    ));
    assert!(h.snapshot().purchase_orders().unwrap().is_empty());
    assert_eq!(h.snapshot().accounts()[&1].held(), MicroUsd(0));
    register(&mut h, &i);
    assert_eq!(record(&h, &i).receipt().registered_seq, 1);
}

#[test]
fn insufficient_funds_wait_then_top_up_funds_original_root_without_retiming() {
    let mut h = bootstrap();
    let i = input("waiting", 1, 80);
    let receipt = register(&mut h, &i);
    assert!(record(&h, &i).funding().is_none());
    fixture::run(
        &mut h,
        "time",
        ExchangeCommand::AdvanceTime(UnixMillis(2_000)),
    );
    credit(&mut h, 79, "partial");
    assert!(record(&h, &i).funding().is_none());
    credit(&mut h, 1, "remaining");
    assert_eq!(record(&h, &i).funding().unwrap().reserve(), MicroUsd(80));
    assert_eq!(register(&mut h, &i), receipt);
    assert_eq!(record(&h, &i).receipt().window.registered_at, fx::NOW);
    assert!(h.snapshot().execution_requests().unwrap().is_empty());
}

#[test]
fn stop_releases_once_and_neither_credit_nor_expiry_nor_new_key_reopens_root() {
    let mut h = bootstrap();
    credit(&mut h, 80, "credit");
    let i = input("stop", 1, 80);
    register(&mut h, &i);
    let original = h.execute("stop".into(), close(&i, "stop")).unwrap();
    assert_eq!(h.snapshot().accounts()[&1].held(), MicroUsd(0));
    fixture::run(
        &mut h,
        "time",
        ExchangeCommand::AdvanceTime(UnixMillis(10_000)),
    );
    credit(&mut h, 10, "top-up");
    let state = h.snapshot();
    assert_eq!(
        h.execute("stop".into(), close(&i, "stop")).unwrap(),
        original
    );
    assert_eq!(h.snapshot(), state);
    assert_eq!(
        h.execute("stop-again".into(), close(&i, "stop-again"))
            .unwrap(),
        original
    );
    assert_eq!(record(&h, &i).funding().unwrap().released(), MicroUsd(80));
    assert_eq!(
        record(&h, &i).closure().unwrap().reason,
        OrderClosureReason::UserRequested
    );
    assert_eq!(h.snapshot().accounts()[&1].balance(), MicroUsd(90));
    assert!(h.snapshot().frozen_grants().unwrap().is_empty());
}

#[test]
fn expired_unfunded_ioc_does_not_receive_future_credit() {
    let mut h = bootstrap();
    let mut i = input("unfunded", 1, 80);
    i.authorization.tif = TimeInForce::Ioc {};
    register(&mut h, &i);
    fixture::run(
        &mut h,
        "expire",
        ExchangeCommand::AdvanceTime(UnixMillis(1_100)),
    );
    credit(&mut h, 100, "late-credit");
    let r = record(&h, &i);
    assert!(r.funding().is_none());
    assert_eq!(r.closure().unwrap().at, UnixMillis(1_100));
    assert_eq!(h.snapshot().accounts()[&1].available(), MicroUsd(100));
}

#[test]
fn enabling_registration_is_explicit_bootstrap_only_and_replay_bound() {
    let i = input("new", 1, 0);
    let mut old = fixture::bootstrap(false);
    assert!(old.execute(i.idempotency_key.clone(), command(&i)).is_err());
    let mut h = bootstrap();
    register(&mut h, &i);
    assert!(h.clone().with_purchase_orders(policy()).is_err());
    let journal = h.journal();
    assert_eq!(MarketHost::replay(bootstrap(), &journal).unwrap(), h);
    assert!(MarketHost::replay(fixture::bootstrap(false), &journal).is_err());
    let mut changed = policy();
    changed.time.immediate_decision_window_ms += 1;
    assert!(MarketHost::replay(
        fixture::bootstrap(false)
            .with_purchase_orders(changed)
            .unwrap(),
        &journal
    )
    .is_err());
}

struct Dir(PathBuf);
impl Dir {
    fn new() -> Self {
        static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let p = std::env::temp_dir().join(format!(
            "bitrouter-register-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        std::fs::create_dir(&p).unwrap();
        Self(p)
    }
    fn path(&self) -> PathBuf {
        self.0.join("market.sqlite")
    }
}
impl Drop for Dir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn durable_snapshot_and_retry_restore_original_authorization_time_and_money() {
    let dir = Dir::new();
    let mut m = DurableMarketHost::create(dir.path(), bootstrap()).unwrap();
    m.execute(
        "credit".into(),
        ExchangeCommand::Credit {
            buyer_id: 1,
            amount: MicroUsd(100),
        },
    )
    .unwrap();
    let i = input("durable", 1, 80);
    let receipt = m.execute(i.idempotency_key.clone(), command(&i)).unwrap();
    m.execute(
        "time".into(),
        ExchangeCommand::AdvanceTime(UnixMillis(2_000)),
    )
    .unwrap();
    let expected = m.host().unwrap().clone();
    drop(m);
    let mut m = DurableMarketHost::open(dir.path()).unwrap();
    assert_eq!(m.host().unwrap(), &expected);
    assert_eq!(record(m.host().unwrap(), &i).registration(), &i);
    assert_eq!(
        m.execute(i.idempotency_key.clone(), command(&i)).unwrap(),
        receipt
    );
    assert_eq!(m.host().unwrap(), &expected);
    m.execute("close".into(), close(&i, "close")).unwrap();
    let closed = m.host().unwrap().clone();
    drop(m);
    let mut m = DurableMarketHost::open(dir.path()).unwrap();
    assert_eq!(m.host().unwrap(), &closed);
    assert_eq!(
        m.execute(i.idempotency_key.clone(), command(&i)).unwrap(),
        receipt
    );
    assert_eq!(m.host().unwrap(), &closed);
    assert_eq!(
        m.host().unwrap().snapshot().accounts()[&1].held(),
        MicroUsd(0)
    );
}

#[test]
fn registration_crash_worker() {
    let Some(path) = std::env::var_os("BITROUTER_REGISTRATION_CRASH_DB") else {
        return;
    };
    let point = std::env::var("BITROUTER_REGISTRATION_CRASH_POINT").unwrap();
    let mut m = DurableMarketHost::create(PathBuf::from(path), bootstrap()).unwrap();
    m.execute(
        "credit".into(),
        ExchangeCommand::Credit {
            buyer_id: 1,
            amount: MicroUsd(100),
        },
    )
    .unwrap();
    m.set_failpoint(Some(match point.as_str() {
        "before" => FaultPoint::MarketBeforeCommit,
        "after" => FaultPoint::MarketAfterCommit,
        _ => panic!("fault point"),
    }));
    let i = input("crash", 1, 80);
    m.execute(i.idempotency_key.clone(), command(&i)).unwrap();
    panic!("fault point did not exit")
}

#[test]
fn abrupt_exit_before_or_after_registration_commit_never_recovers_partial_root() {
    for point in ["before", "after"] {
        let dir = Dir::new();
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "registration_crash_worker", "--nocapture"])
            .env("BITROUTER_REGISTRATION_CRASH_DB", dir.path())
            .env("BITROUTER_REGISTRATION_CRASH_POINT", point)
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(86), "{output:?}");
        let mut m = DurableMarketHost::open(dir.path()).unwrap();
        let i = input("crash", 1, 80);
        let snapshot = m.host().unwrap().snapshot();
        if point == "before" {
            assert!(snapshot.purchase_orders().unwrap().is_empty());
            assert_eq!(snapshot.accounts()[&1].held(), MicroUsd(0));
        } else {
            assert_eq!(record(m.host().unwrap(), &i).registration(), &i);
            assert_eq!(snapshot.accounts()[&1].held(), MicroUsd(80));
        }
        let receipt = m.execute(i.idempotency_key.clone(), command(&i)).unwrap();
        assert_eq!(record(m.host().unwrap(), &i).receipt().registered_seq, 1);
        assert!(matches!(receipt, ExchangeReceipt::FormalOrderPlaced(_)));
        assert_eq!(
            m.host().unwrap().snapshot().accounts()[&1].held(),
            MicroUsd(80)
        );
        assert!(m
            .host()
            .unwrap()
            .snapshot()
            .execution_requests()
            .unwrap()
            .is_empty());
    }
}
