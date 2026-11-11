#![cfg(feature = "sqlite-tools")]
#[allow(dead_code)]
#[path = "support/coordination_fixture.rs"]
mod cf;
#[allow(dead_code)]
mod common;
#[allow(dead_code)]
#[path = "support/frozen_fixture.rs"]
mod fixture;
#[allow(dead_code)]
#[path = "support/conditional_exchange.rs"]
mod fx;
#[allow(dead_code)]
#[path = "support/purchase_fixture.rs"]
mod pf;
use bitrouter_market::admission::*;
use bitrouter_market::durable::*;
use bitrouter_market::exchange::*;
use bitrouter_market::execution_contract::*;
use bitrouter_market::execution_coordinator::*;
use bitrouter_market::order::*;
use std::path::PathBuf;
struct Dir(PathBuf);
impl Dir {
    fn new() -> Self {
        static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let p = std::env::temp_dir().join(format!(
            "market-coordinator-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            N.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        std::fs::create_dir(&p).unwrap();
        Self(p)
    }
    fn market(&self) -> PathBuf {
        self.0.join("market.sqlite")
    }
    fn authority(&self) -> PathBuf {
        self.0.join("authority.sqlite")
    }
}
impl Drop for Dir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn setup(dir: &Dir, ioc: bool) -> (DurableMarketHost, DurableAuthority, AttemptId, UnixMillis) {
    let (h, a, id) = cf::setup(ioc);
    let mut m = DurableMarketHost::create(dir.market(), cf::bootstrap()).unwrap();
    for (key, c) in h.journal().commands() {
        m.execute(key.clone(), c.clone()).unwrap();
    }
    let a = DurableAuthority::create(dir.authority(), a, m.resolver()).unwrap();
    let now = m.host().unwrap().snapshot().now();
    (m, a, id, now)
}
#[test]
fn coordinator_crash_worker() {
    let Some(path) = std::env::var_os("BITROUTER_COORD_CRASH_DIR") else {
        return;
    };
    let dir = Dir(path.into());
    let action = std::env::var("BITROUTER_COORD_CRASH_ACTION").unwrap();
    let (mut m, mut a, id, e) = setup(&dir, false);
    if action == "submit-marker" {
        m.set_failpoint(Some(FaultPoint::AfterSendMarker));
    }
    if action == "e" {
        a.set_failpoint(Some(FaultPoint::AuthorityAfterCommit));
    }
    m.drive_execution_due(&mut a, 1).unwrap();
    m.execute(
        "clock".into(),
        ExchangeCommand::AdvanceTime(UnixMillis(e.0 + 100)),
    )
    .unwrap();
    if action == "query-request" {
        m.set_failpoint(Some(FaultPoint::MarketAfterCommit));
    }
    m.drive_execution_due(&mut a, 1).unwrap();
    if action == "query-marker" {
        m.set_failpoint(Some(FaultPoint::AfterSendMarker));
    }
    if action == "inbox" {
        m.set_failpoint(Some(FaultPoint::InboxStored));
    }
    m.drive_execution_due(&mut a, 1).unwrap();
    panic!("crash point not reached for {action}: {id:?}");
}
#[test]
fn crashes_recover_original_operations_timers_and_inbox_without_resending_marked_effects() {
    for action in [
        "submit-marker",
        "e",
        "query-request",
        "query-marker",
        "inbox",
    ] {
        let dir = Dir::new();
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "coordinator_crash_worker", "--nocapture"])
            .env("BITROUTER_COORD_CRASH_DIR", &dir.0)
            .env("BITROUTER_COORD_CRASH_ACTION", action)
            .status()
            .unwrap();
        assert_eq!(status.code(), Some(86), "{action}");
        let mut m = DurableMarketHost::open(dir.market()).unwrap();
        let mut a = DurableAuthority::open(dir.authority()).unwrap();
        let s = m.host().unwrap().snapshot();
        let id = s.purchase_trades().unwrap().keys().next().unwrap().clone();
        let t = &s.purchase_trades().unwrap()[&id];
        let e = t.created_at;
        assert_eq!(
            s.execution_requests()
                .unwrap()
                .values()
                .filter(|r| r.kind == ExecutionRequestKind::Submit)
                .count(),
            1
        );
        let submit = s
            .execution_requests()
            .unwrap()
            .values()
            .find(|r| r.kind == ExecutionRequestKind::Submit)
            .unwrap()
            .clone();
        assert!(s.execution_request_sent(&submit.effect_id));
        assert!(m.dispatch(&submit.effect_id, &mut a).is_err());
        assert_eq!(a.task_start_count("exchange", &id).unwrap(), 0);
        match action {
            "submit-marker" | "e" => {
                assert_eq!(
                    m.next_execution_timer_at().unwrap(),
                    Some(UnixMillis(e.0 + 20))
                );
                m.tick_execution("recover-query".into(), UnixMillis(e.0 + 20), &mut a, 10)
                    .unwrap();
                let s = m.host().unwrap().snapshot();
                let t = &s.purchase_trades().unwrap()[&id];
                if action == "submit-marker" {
                    assert!(t.unknown);
                    assert!(t.accepted_at.is_none());
                    assert_eq!(s.accounts()[&1].held(), MicroUsd(100));
                    let until = t.accept_before;
                    m.tick_execution("recover-fence".into(), until, &mut a, 10)
                        .unwrap();
                    assert_eq!(
                        m.host().unwrap().snapshot().purchase_trades().unwrap()[&id].settlement,
                        ReservationSettlement::NotExecuted
                    );
                } else {
                    assert_eq!(t.accepted_at, Some(e));
                    assert_eq!(s.accounts()[&1].held(), MicroUsd(11));
                }
            }
            "query-request" => {
                let work = m.execution_work().unwrap();
                assert!(matches!(work[0].kind, ExecutionWorkKind::Dispatch { .. }));
                let count = s.execution_requests().unwrap().len();
                assert_eq!(m.drive_execution_due(&mut a, 1).unwrap(), 1);
                assert_eq!(
                    m.host()
                        .unwrap()
                        .snapshot()
                        .execution_requests()
                        .unwrap()
                        .len(),
                    count
                );
            }
            "query-marker" => {
                assert_eq!(
                    m.next_execution_timer_at().unwrap(),
                    Some(UnixMillis(e.0 + 120))
                );
                assert_eq!(m.drive_execution_due(&mut a, 10).unwrap(), 0);
                m.tick_execution("next-query".into(), UnixMillis(e.0 + 120), &mut a, 10)
                    .unwrap();
                assert_eq!(
                    m.host()
                        .unwrap()
                        .snapshot()
                        .execution_requests()
                        .unwrap()
                        .len(),
                    3
                );
            }
            "inbox" => {
                assert!(!t.unknown);
                assert_eq!(
                    m.next_execution_timer_at().unwrap(),
                    Some(UnixMillis(e.0 + 200))
                );
                assert_eq!(m.drive_execution_due(&mut a, 10).unwrap(), 0);
            }
            _ => unreachable!(),
        }
        let snapshot = m.host().unwrap().snapshot();
        let work = m.execution_work().unwrap();
        drop(m);
        drop(a);
        let m = DurableMarketHost::open(dir.market()).unwrap();
        assert_eq!(m.host().unwrap().snapshot(), snapshot);
        assert_eq!(m.execution_work().unwrap(), work);
        let a = DurableAuthority::open(dir.authority()).unwrap();
        assert_eq!(a.task_start_count("exchange", &id).unwrap(), 0);
    }
}
#[test]
fn lost_fence_response_is_reconciled_on_original_ioc_without_reopening_or_releasing_early() {
    let dir = Dir::new();
    let (mut m, mut a, id, e) = setup(&dir, true);
    let submit = pf::request(m.host().unwrap(), &id, ExecutionRequestKind::Submit);
    m.mark_sent(&submit.effect_id).unwrap();
    m.tick_execution("absence".into(), UnixMillis(e.0 + 20), &mut a, 10)
        .unwrap();
    assert!(m.host().unwrap().snapshot().purchase_trades().unwrap()[&id].unknown);
    let until = submit.binding.accept_before;
    m.tick_execution("fence-request".into(), until, &mut a, 1)
        .unwrap();
    let fence = pf::request(
        m.host().unwrap(),
        &id,
        ExecutionRequestKind::FenceUnaccepted,
    );
    let _lost = m.dispatch(&fence.effect_id, &mut a).unwrap();
    assert_eq!(
        m.host().unwrap().snapshot().accounts()[&1].held(),
        MicroUsd(100)
    );
    drop(m);
    drop(a);
    let mut m = DurableMarketHost::open(dir.market()).unwrap();
    let mut a = DurableAuthority::open(dir.authority()).unwrap();
    m.tick_execution(
        "fence-reconcile".into(),
        UnixMillis(until.0 + 20),
        &mut a,
        10,
    )
    .unwrap();
    let s = m.host().unwrap().snapshot();
    assert_eq!(s.accounts()[&1].held(), MicroUsd(0));
    assert_eq!(
        s.purchase_trades().unwrap()[&id].settlement,
        ReservationSettlement::NotExecuted
    );
    assert_eq!(s.purchase_trades().unwrap().len(), 1);
    assert!(m.execution_work().unwrap().is_empty());
    assert_eq!(a.task_start_count("exchange", &id).unwrap(), 0);
}
