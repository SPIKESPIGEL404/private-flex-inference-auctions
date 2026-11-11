#![cfg(feature = "sqlite-tools")]
use bitrouter_market::formal_order::PlaceFormalOrder;
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
use bitrouter_market::{durable::*, exchange::*, execution_contract::*};
use std::{path::PathBuf, process::Command};
struct Dir(PathBuf);
impl Dir {
    fn new() -> Self {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let p = std::env::temp_dir().join(format!(
            "formal-recovery-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        std::fs::create_dir(&p).unwrap();
        Self(p)
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
fn input() -> PlaceFormalOrder {
    PlaceFormalOrder {
        version: bitrouter_market::formal_order::FORMAL_VERSION,
        idempotency_key: "formal-crash-place".into(),
        authorization: pf::registration("crash", 1, &["a", "b"], false).authorization,
        provider_scope: Default::default(),
        selection: Default::default(),
    }
}
fn setup(dir: &Dir, place: bool) -> DurableMarketHost {
    let (original, _) = pf::setup(false, false);
    let mut m = DurableMarketHost::create(dir.market(), pf::bootstrap(false)).unwrap();
    for (key, command) in original.journal().commands() {
        m.execute(key.clone(), command.clone()).unwrap();
    }
    if place {
        let p = input();
        m.execute(
            p.idempotency_key.clone(),
            ExchangeCommand::PlaceFormalOrder(Box::new(p.clone())),
        )
        .unwrap();
        // Use the actual persisted registration for each immutable quote.
        for option in [1, 2] {
            let q = pf::publication(
                m.host().unwrap(),
                &p.clone(),
                option,
                &format!("crash-{option}"),
            );
            m.execute(
                format!("quote-{option}"),
                ExchangeCommand::PurchaseQuote(Box::new(q)),
            )
            .unwrap();
        }
    }
    m
}
#[test]
fn formal_crash_worker() {
    let Ok(path) = std::env::var("FORMAL_CRASH_PATH") else {
        return;
    };
    let action = std::env::var("FORMAL_CRASH_ACTION").unwrap();
    let fault = match std::env::var("FORMAL_CRASH_FAULT").unwrap().as_str() {
        "before" => FaultPoint::MarketBeforeCommit,
        "after" => FaultPoint::MarketAfterCommit,
        "sent" => FaultPoint::AfterSendMarker,
        _ => panic!(),
    };
    let mut m = DurableMarketHost::open(path).unwrap();
    m.set_failpoint(Some(fault));
    match action.as_str() {
        "place" => {
            let p = input();
            m.execute(
                p.idempotency_key.clone(),
                ExchangeCommand::PlaceFormalOrder(Box::new(p)),
            )
            .unwrap();
        }
        "drive" => {
            m.drive_formal_due(32).unwrap();
        }
        "sent" => {
            let s = m.host().unwrap().snapshot();
            let req = s
                .execution_requests()
                .unwrap()
                .values()
                .find(|r| r.kind == ExecutionRequestKind::Submit)
                .unwrap();
            m.mark_sent(&req.effect_id).unwrap();
        }
        _ => panic!(),
    };
    panic!("fault not reached")
}
fn crash(dir: &Dir, action: &str, fault: &str) {
    let status = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "formal_crash_worker", "--nocapture"])
        .env("FORMAL_CRASH_PATH", dir.market())
        .env("FORMAL_CRASH_ACTION", action)
        .env("FORMAL_CRASH_FAULT", fault)
        .status()
        .unwrap();
    assert_eq!(status.code(), Some(86));
}
#[test]
fn registration_and_g_crashes_keep_all_or_nothing_with_original_queue_and_receipt() {
    for action in ["place", "drive"] {
        for fault in ["before", "after"] {
            let dir = Dir::new();
            drop(setup(&dir, action == "drive"));
            crash(&dir, action, fault);
            let mut m = DurableMarketHost::open(dir.market()).unwrap();
            let s = m.host().unwrap().snapshot();
            if action == "place" {
                assert_eq!(
                    s.purchase_orders().unwrap().len(),
                    usize::from(fault == "after")
                );
                if fault == "after" {
                    assert_eq!(s.formal_pending(), 1);
                    assert!(m
                        .host()
                        .unwrap()
                        .formal_command_receipt(1, &input().idempotency_key)
                        .is_some());
                }
            } else {
                assert_eq!(
                    s.purchase_trades().unwrap().len(),
                    usize::from(fault == "after")
                );
                if fault == "before" {
                    assert_eq!(s.formal_pending(), 1);
                    m.drive_formal_due(32).unwrap();
                }
                assert_eq!(
                    m.host()
                        .unwrap()
                        .snapshot()
                        .purchase_trades()
                        .unwrap()
                        .len(),
                    1
                );
                let expected = m.host().unwrap().snapshot();
                drop(m);
                let m = DurableMarketHost::open(dir.market()).unwrap();
                assert_eq!(m.host().unwrap().snapshot(), expected);
            }
        }
    }
}
#[test]
fn marked_submit_survives_crash_and_cannot_be_sent_or_replaced_again() {
    let dir = Dir::new();
    let mut m = setup(&dir, true);
    m.drive_formal_due(32).unwrap();
    drop(m);
    crash(&dir, "sent", "sent");
    let mut m = DurableMarketHost::open(dir.market()).unwrap();
    let s = m.host().unwrap().snapshot();
    let req = s
        .execution_requests()
        .unwrap()
        .values()
        .find(|r| r.kind == ExecutionRequestKind::Submit)
        .unwrap();
    assert!(s.execution_request_sent(&req.effect_id));
    assert!(m.mark_sent(&req.effect_id).is_err());
    m.drive_formal_due(32).unwrap();
    assert_eq!(
        m.host()
            .unwrap()
            .snapshot()
            .purchase_trades()
            .unwrap()
            .len(),
        1
    );
    assert!(m.host().unwrap().snapshot().accounts()[&1].held().0 > 0);
}

#[test]
fn pending_recovery_uses_current_clock_and_never_creates_g_from_expired_evidence() {
    use bitrouter_market::order::UnixMillis;
    let dir = Dir::new();
    let m = setup(&dir, true);
    let before = m.host().unwrap().snapshot().now();
    assert!(before < UnixMillis(8100));
    drop(m);
    let mut m = DurableMarketHost::open(dir.market()).unwrap();
    m.drive_formal_due_at(UnixMillis(8100), 32).unwrap();
    let s = m.host().unwrap().snapshot();
    assert_eq!(s.now(), UnixMillis(8100));
    assert!(s.purchase_trades().unwrap().is_empty());
    assert!(
        s.purchase_orders().unwrap()[&input().authorization.binding.root]
            .last_review
            .is_some()
    );
    assert!(m.drive_formal_due_at(UnixMillis(8000), 32).is_err());
}

#[test]
fn unknown_storage_version_does_not_reinitialize_formal_history() {
    let dir = Dir::new();
    let m = setup(&dir, true);
    let expected = m.host().unwrap().snapshot().revision();
    drop(m);
    let conn = rusqlite::Connection::open(dir.market()).unwrap();
    conn.execute("UPDATE metadata SET version=999", []).unwrap();
    drop(conn);
    assert!(DurableMarketHost::open(dir.market()).is_err());
    let conn = rusqlite::Connection::open(dir.market()).unwrap();
    let rows: i64 = conn
        .query_row("SELECT count(*) FROM events", [], |r| r.get(0))
        .unwrap();
    assert_eq!(u64::try_from(rows).unwrap(), expected);
}
