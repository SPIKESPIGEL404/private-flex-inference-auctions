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
#[allow(dead_code)]
#[path = "support/purchase_fixture.rs"]
mod pf;
use bitrouter_market::durable::*;
use bitrouter_market::exchange::*;
use bitrouter_market::execution_contract::*;
use bitrouter_market::order::*;
use bitrouter_market::purchase_order::*;
use pf::*;
use std::path::PathBuf;

struct Dir(PathBuf);
impl Dir {
    fn new() -> Self {
        static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let p = std::env::temp_dir().join(format!(
            "bitrouter-purchase-{}-{}-{}",
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
fn durable_setup(
    dir: &Dir,
    ioc: bool,
) -> (
    DurableMarketHost,
    DurableAuthority,
    PlaceFormalOrder,
    ProposePurchase,
) {
    let (h, a) = setup(false, false);
    let mut m = DurableMarketHost::create(dir.market(), bootstrap(false)).unwrap();
    for (key, command) in h.journal().commands() {
        m.execute(key.clone(), command.clone()).unwrap();
    }
    let r = registration("durable", 1, &["a", "b"], ioc);
    m.execute(
        r.idempotency_key.clone(),
        ExchangeCommand::PlaceFormalOrder(Box::new(r.clone())),
    )
    .unwrap();
    let q = publication(m.host().unwrap(), &r, 1, "durable");
    m.execute(
        "publish".into(),
        ExchangeCommand::PurchaseQuote(Box::new(q.clone())),
    )
    .unwrap();
    let p = proposal(m.host().unwrap(), &r, &[q], "durable");
    let a = DurableAuthority::create(dir.authority(), a, m.resolver()).unwrap();
    (m, a, r, p)
}
fn g(m: &mut DurableMarketHost, p: &ProposePurchase) -> bitrouter_market::admission::AttemptId {
    let ExchangeReceipt::PurchaseDecided(receipt) = m
        .execute(
            p.idempotency_key.clone(),
            ExchangeCommand::ProposePurchase(Box::new(p.clone())),
        )
        .unwrap()
    else {
        panic!("receipt")
    };
    pf::id(&receipt)
}
fn query(
    m: &mut DurableMarketHost,
    a: &mut DurableAuthority,
    id: &bitrouter_market::admission::AttemptId,
    kind: ExecutionRequestKind,
    label: &str,
) -> ExecutionReport {
    m.execute(
        label.into(),
        ExchangeCommand::Frozen(Box::new(FrozenCommand::Request {
            attempt: id.clone(),
            kind,
        })),
    )
    .unwrap();
    let effect = request(m.host().unwrap(), id, kind).effect_id;
    m.dispatch(&effect, a).unwrap()
}
fn receive(m: &mut DurableMarketHost, a: &DurableAuthority, label: &str, report: ExecutionReport) {
    m.receive(label.into(), a.authority().unwrap().origin(), report)
        .unwrap();
}
fn finish(
    m: &mut DurableMarketHost,
    a: &mut DurableAuthority,
    id: &bitrouter_market::admission::AttemptId,
) -> ExecutionReport {
    let now = m.host().unwrap().snapshot().now();
    a.start_pending(now).unwrap();
    a.finish(
        "exchange",
        id,
        ExecutionOutcome::Completed,
        Some(TokenUsage {
            uncached_input_tokens: 10,
            cached_input_tokens: 0,
            billable_output_tokens: 1,
        }),
        now,
    )
    .unwrap();
    query(m, a, id, ExecutionRequestKind::Query, "terminal-query")
}

#[test]
fn purchase_crash_worker() {
    let Some(path) = std::env::var_os("BITROUTER_PURCHASE_CRASH_DIR") else {
        return;
    };
    let dir = Dir(PathBuf::from(path));
    let action = std::env::var("BITROUTER_PURCHASE_CRASH_ACTION").unwrap();
    let (mut m, mut a, r, p) = durable_setup(&dir, false);
    std::fs::write(
        dir.0.join("registration.json"),
        serde_json::to_vec(&r).unwrap(),
    )
    .unwrap();
    std::fs::write(dir.0.join("proposal.json"), serde_json::to_vec(&p).unwrap()).unwrap();
    if action == "before-g" || action == "after-g" {
        m.set_failpoint(Some(if action == "before-g" {
            FaultPoint::MarketBeforeCommit
        } else {
            FaultPoint::MarketAfterCommit
        }));
        g(&mut m, &p);
    } else {
        let id = g(&mut m, &p);
        if action == "sent" {
            m.set_failpoint(Some(FaultPoint::AfterSendMarker));
        }
        if action == "e" {
            a.set_failpoint(Some(FaultPoint::AuthorityAfterCommit));
        }
        let effect = request(m.host().unwrap(), &id, ExecutionRequestKind::Submit).effect_id;
        let accepted = m.dispatch(&effect, &mut a).unwrap();
        receive(&mut m, &a, "accepted", accepted);
        let terminal = finish(&mut m, &mut a, &id);
        m.set_failpoint(Some(match action.as_str() {
            "inbox" => FaultPoint::InboxStored,
            "report-before" => FaultPoint::ReportBeforeCommit,
            "report-after" => FaultPoint::ReportAfterCommit,
            _ => panic!("crash action"),
        }));
        receive(&mut m, &a, "terminal", terminal);
    }
    panic!("failpoint did not exit")
}
fn crash(dir: &Dir, action: &str) -> (PlaceFormalOrder, ProposePurchase) {
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "purchase_crash_worker", "--nocapture"])
        .env("BITROUTER_PURCHASE_CRASH_DIR", &dir.0)
        .env("BITROUTER_PURCHASE_CRASH_ACTION", action)
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(86), "{output:?}");
    (
        serde_json::from_slice(&std::fs::read(dir.0.join("registration.json")).unwrap()).unwrap(),
        serde_json::from_slice(&std::fs::read(dir.0.join("proposal.json")).unwrap()).unwrap(),
    )
}

#[test]
fn g_commit_crashes_recover_original_or_no_g_without_duplicate_holds_or_competition() {
    for action in ["before-g", "after-g"] {
        let dir = Dir::new();
        let (_r, p) = crash(&dir, action);
        let mut m = DurableMarketHost::open(dir.market()).unwrap();
        let s = m.host().unwrap().snapshot();
        assert_eq!(s.accounts()[&1].held(), MicroUsd(100));
        assert_eq!(
            s.purchase_trades().unwrap().len(),
            usize::from(action == "after-g")
        );
        assert_eq!(
            s.frozen_grants().unwrap().len(),
            usize::from(action == "after-g")
        );
        let id = g(&mut m, &p);
        let s = m.host().unwrap().snapshot();
        assert_eq!(s.purchase_trades().unwrap().len(), 1);
        assert_eq!(
            s.purchase_decisions()
                .unwrap()
                .values()
                .next()
                .unwrap()
                .receipt
                .competition_seq,
            1
        );
        assert_eq!(s.execution_requests().unwrap().len(), 1);
        assert_eq!(id.sequence, 1);
        assert_eq!(s.accounts()[&1].held(), MicroUsd(100));
    }
}

#[test]
fn committed_send_marker_cannot_resubmit_and_not_found_does_not_release() {
    let dir = Dir::new();
    let (r, _p) = crash(&dir, "sent");
    let mut m = DurableMarketHost::open(dir.market()).unwrap();
    let mut a = DurableAuthority::open(dir.authority()).unwrap();
    let id = m
        .host()
        .unwrap()
        .snapshot()
        .purchase_trades()
        .unwrap()
        .keys()
        .next()
        .unwrap()
        .clone();
    let submit = m
        .host()
        .unwrap()
        .snapshot()
        .execution_requests()
        .unwrap()
        .values()
        .find(|r| r.kind == ExecutionRequestKind::Submit)
        .unwrap()
        .clone();
    assert!(m.host().unwrap().snapshot().purchase_trades().unwrap()[&id].unknown);
    assert!(m.dispatch(&submit.effect_id, &mut a).is_err());
    let not_found = query(&mut m, &mut a, &id, ExecutionRequestKind::Query, "query");
    assert!(matches!(
        not_found.observation,
        ExecutionReportState::NotFound {}
    ));
    receive(&mut m, &a, "not-found", not_found);
    assert_eq!(
        m.host().unwrap().snapshot().accounts()[&1].held(),
        MicroUsd(100)
    );
    m.execute(
        "stop".into(),
        ExchangeCommand::CloseFormalOrder(CloseFormalOrder {
            idempotency_key: "stop".into(),
            root: r.authorization.binding,
        }),
    )
    .unwrap();
    let fence = query(
        &mut m,
        &mut a,
        &id,
        ExecutionRequestKind::FenceUnaccepted,
        "fence",
    );
    receive(&mut m, &a, "fenced", fence);
    assert_eq!(
        m.host().unwrap().snapshot().accounts()[&1].held(),
        MicroUsd(0)
    );
}

#[test]
fn authority_commit_loss_recovers_same_task_and_atomic_snapshot_settles_once() {
    let dir = Dir::new();
    let (_r, p) = crash(&dir, "e");
    let mut m = DurableMarketHost::open(dir.market()).unwrap();
    let mut a = DurableAuthority::open(dir.authority()).unwrap();
    let id = m
        .host()
        .unwrap()
        .snapshot()
        .purchase_trades()
        .unwrap()
        .keys()
        .next()
        .unwrap()
        .clone();
    let task = a
        .authority()
        .unwrap()
        .attempts()
        .values()
        .next()
        .unwrap()
        .task_id
        .clone();
    assert!(task.is_some());
    assert!(m.host().unwrap().snapshot().purchase_trades().unwrap()[&id].unknown);
    let accepted = query(
        &mut m,
        &mut a,
        &id,
        ExecutionRequestKind::Query,
        "reconcile",
    );
    receive(&mut m, &a, "accepted", accepted);
    assert_eq!(
        m.host().unwrap().snapshot().accounts()[&1].held(),
        MicroUsd(11)
    );
    let terminal = finish(&mut m, &mut a, &id);
    assert_eq!(a.task_start_count("exchange", &id).unwrap(), 1);
    receive(&mut m, &a, "terminal", terminal.clone());
    let expected = m.host().unwrap().snapshot();
    assert_eq!(expected.accounts()[&1].balance(), MicroUsd(1000));
    assert_eq!(expected.accounts()[&1].held(), MicroUsd(11));
    drop(m);
    drop(a);
    let mut m = DurableMarketHost::open(dir.market()).unwrap();
    let a = DurableAuthority::open(dir.authority()).unwrap();
    assert_eq!(a.task_start_count("exchange", &id).unwrap(), 1);
    assert_eq!(m.host().unwrap().snapshot(), expected);
    assert_eq!(
        a.authority()
            .unwrap()
            .attempts()
            .values()
            .next()
            .unwrap()
            .task_id,
        task
    );
    receive(&mut m, &a, "terminal-duplicate", terminal);
    assert_eq!(
        m.host().unwrap().snapshot().accounts()[&1].balance(),
        MicroUsd(1000)
    );
    g(&mut m, &p);
    assert_eq!(
        m.host()
            .unwrap()
            .snapshot()
            .purchase_trades()
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn terminal_inbox_crashes_recover_without_execution_database_and_do_not_charge_twice() {
    for action in ["inbox", "report-before", "report-after"] {
        let dir = Dir::new();
        let (_r, p) = crash(&dir, action);
        std::fs::rename(dir.authority(), dir.0.join("authority-offline.sqlite")).unwrap();
        let mut m = DurableMarketHost::open(dir.market()).unwrap();
        let s = m.host().unwrap().snapshot();
        assert_eq!(s.accounts()[&1].balance(), MicroUsd(1000), "{action}");
        assert_eq!(s.accounts()[&1].held(), MicroUsd(11));
        assert!(matches!(
            s.purchase_trades()
                .unwrap()
                .values()
                .next()
                .unwrap()
                .settlement,
            ReservationSettlement::AwaitingDelivery
        ));
        g(&mut m, &p);
        assert_eq!(
            m.host().unwrap().snapshot().accounts()[&1].balance(),
            MicroUsd(1000)
        );
        drop(m);
        let m = DurableMarketHost::open(dir.market()).unwrap();
        assert_eq!(
            m.host().unwrap().snapshot().accounts()[&1].balance(),
            MicroUsd(1000)
        );
    }
}

#[test]
fn sql_failure_rolls_back_purchase_g_decision_grant_outbox_and_original_key() {
    let dir = Dir::new();
    let (mut m, _a, _r, p) = durable_setup(&dir, false);
    let db = rusqlite::Connection::open(dir.market()).unwrap();
    db.execute_batch("CREATE TRIGGER reject_purchase BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT,'purchase failure'); END;").unwrap();
    assert!(m
        .execute(
            p.idempotency_key.clone(),
            ExchangeCommand::ProposePurchase(Box::new(p.clone()))
        )
        .is_err());
    assert!(matches!(m.host(), Err(DurableError::Poisoned)));
    drop(m);
    db.execute_batch("DROP TRIGGER reject_purchase").unwrap();
    drop(db);
    let mut m = DurableMarketHost::open(dir.market()).unwrap();
    assert!(m
        .host()
        .unwrap()
        .snapshot()
        .purchase_trades()
        .unwrap()
        .is_empty());
    assert!(m
        .host()
        .unwrap()
        .snapshot()
        .purchase_decisions()
        .unwrap()
        .is_empty());
    assert!(m
        .host()
        .unwrap()
        .snapshot()
        .frozen_grants()
        .unwrap()
        .is_empty());
    let id = g(&mut m, &p);
    assert_eq!(id.sequence, 1);
    assert_eq!(
        m.host().unwrap().snapshot().accounts()[&1].held(),
        MicroUsd(100)
    );
}
