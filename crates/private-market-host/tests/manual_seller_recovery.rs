#![cfg(feature = "sqlite-tools")]
#[allow(dead_code)]
mod common;
#[allow(dead_code)]
#[path = "support/frozen_fixture.rs"]
mod fixture;
#[allow(dead_code)]
#[path = "support/conditional_exchange.rs"]
mod fx;
#[allow(dead_code)]
#[path = "support/manual_seller_fixture.rs"]
mod mf;
#[allow(dead_code)]
#[path = "support/purchase_fixture.rs"]
mod pf;
#[allow(dead_code)]
#[path = "support/seller_fixture.rs"]
mod sf;
use bitrouter_market::durable::*;
use bitrouter_market::exchange::*;
use bitrouter_market::manual_seller_order::*;
use bitrouter_market::order::*;
use std::path::PathBuf;
struct Dir(PathBuf);
impl Dir {
    fn new() -> Self {
        static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "manual-seller-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            N.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        std::fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn market(&self) -> PathBuf {
        self.0.join("market.sqlite")
    }
}
impl Drop for Dir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn submit(m: &mut DurableMarketHost, i: &SubmitManualSellerOrder) -> ManualSellerOrderReceipt {
    match m
        .execute(
            i.idempotency_key.clone(),
            ExchangeCommand::SubmitManualSellerOrder(Box::new(i.clone())),
        )
        .unwrap()
    {
        ExchangeReceipt::ManualSellerOrderSubmitted(r) => r,
        _ => panic!("manual receipt"),
    }
}
#[test]
fn manual_seller_crash_worker() {
    let Some(path) = std::env::var_os("BITROUTER_MANUAL_SELLER_CRASH_DIR") else {
        return;
    };
    let dir = Dir(path.into());
    let mut m = DurableMarketHost::create(dir.market(), sf::bootstrap(false)).unwrap();
    m.set_failpoint(Some(
        if std::env::var("BITROUTER_MANUAL_SELLER_CRASH_ACTION").unwrap() == "before" {
            FaultPoint::MarketBeforeCommit
        } else {
            FaultPoint::MarketAfterCommit
        },
    ));
    submit(&mut m, &mf::input(true));
    panic!("fault point not reached");
}
#[test]
fn before_and_after_commit_recover_either_no_order_or_complete_manual_order_and_original_window() {
    for action in ["before", "after"] {
        let dir = Dir::new();
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "manual_seller_crash_worker", "--nocapture"])
            .env("BITROUTER_MANUAL_SELLER_CRASH_DIR", &dir.0)
            .env("BITROUTER_MANUAL_SELLER_CRASH_ACTION", action)
            .status()
            .unwrap();
        assert_eq!(status.code(), Some(86));
        let i = mf::input(true);
        let mut m = DurableMarketHost::open(dir.market()).unwrap();
        let s = m.host().unwrap().snapshot();
        assert_eq!(
            s.manual_seller_orders()
                .unwrap()
                .contains_key(&i.order.reference),
            action == "after"
        );
        assert_eq!(
            s.seller_service(&fixture::source("a")).is_some(),
            action == "after"
        );
        assert_eq!(
            s.seller_service(&fixture::source("b")).is_some(),
            action == "after"
        );
        let receipt = submit(&mut m, &i);
        assert_eq!(receipt.registration.window.registered_at, s.now());
        assert!(receipt.services.iter().all(|r| r.source_generation == 1));
        let before = m.host().unwrap().snapshot();
        assert_eq!(submit(&mut m, &i), receipt);
        assert_eq!(m.host().unwrap().snapshot(), before);
        m.execute(
            "credit".into(),
            ExchangeCommand::Credit {
                buyer_id: 9,
                amount: MicroUsd(1),
            },
        )
        .unwrap();
        let expected = m.host().unwrap().snapshot();
        drop(m);
        let mut m = DurableMarketHost::open(dir.market()).unwrap();
        assert_eq!(m.host().unwrap().snapshot(), expected);
        assert_eq!(submit(&mut m, &i), receipt);
    }
}
#[test]
fn sql_abort_cannot_leave_a_seller_root_services_source_tombstone_or_successful_key() {
    let dir = Dir::new();
    let mut m = DurableMarketHost::create(dir.market(), sf::bootstrap(false)).unwrap();
    let i = mf::input(false);
    let before = m.host().unwrap().snapshot();
    let conn = rusqlite::Connection::open(dir.market()).unwrap();
    conn.execute_batch("CREATE TRIGGER reject_manual BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'manual registration aborted'); END;").unwrap();
    assert!(m
        .execute(
            i.idempotency_key.clone(),
            ExchangeCommand::SubmitManualSellerOrder(Box::new(i.clone()))
        )
        .is_err());
    assert!(matches!(m.host(), Err(DurableError::Poisoned)));
    conn.execute_batch("DROP TRIGGER reject_manual;").unwrap();
    drop(m);
    let mut m = DurableMarketHost::open(dir.market()).unwrap();
    assert_eq!(m.host().unwrap().snapshot(), before);
    let receipt = submit(&mut m, &i);
    assert!(receipt.services.iter().all(|r| r.source_generation == 1));
}
#[test]
fn atomic_snapshot_keeps_original_manual_submission_immutable_service_and_expiry() {
    let dir = Dir::new();
    let i = mf::input(true);
    let mut m = DurableMarketHost::create(dir.market(), sf::bootstrap(false)).unwrap();
    let receipt = submit(&mut m, &i);
    let mut next = m
        .host()
        .unwrap()
        .snapshot()
        .seller_service(&fixture::source("a"))
        .unwrap()
        .clone();
    let original = next.clone();
    next.schedule.revision += 1;
    next.schedule.bins[0].delivery =
        bitrouter_market::seller_service::DeliveryConditions::PerformanceTarget {
            first_response_within_ms: 150,
            complete_within_ms: 1500,
        };
    assert!(m
        .execute(
            "service-update".into(),
            ExchangeCommand::PublishSellerService(Box::new(next))
        )
        .is_err());
    m.execute(
        "expire".into(),
        ExchangeCommand::AdvanceTime(receipt.registration.window.accept_before),
    )
    .unwrap();
    let expected = m.host().unwrap().snapshot();
    drop(m);
    let mut m = DurableMarketHost::open(dir.market()).unwrap();
    assert_eq!(m.host().unwrap().snapshot(), expected);
    let mut retry = i.clone();
    retry.idempotency_key = "old-manual-retry".into();
    assert_eq!(submit(&mut m, &retry), receipt);
    assert_eq!(
        m.host()
            .unwrap()
            .snapshot()
            .seller_service(&fixture::source("a")),
        Some(&original)
    );
    assert!(
        m.host().unwrap().snapshot().seller_orders().unwrap()[&i.order.reference]
            .closure()
            .is_some()
    );
    assert!(m
        .host()
        .unwrap()
        .snapshot()
        .sources()
        .values()
        .all(|s| s.withdrawn));
}
