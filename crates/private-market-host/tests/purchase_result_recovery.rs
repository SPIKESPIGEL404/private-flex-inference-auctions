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
#[path = "support/purchase_fixture.rs"]
mod pf;
#[allow(dead_code)]
#[path = "support/result_fixture.rs"]
mod rf;
use bitrouter_market::admission::*;
use bitrouter_market::durable::*;
use bitrouter_market::exchange::*;
use bitrouter_market::execution_contract::*;
use bitrouter_market::order::*;
use pf::*;
use std::path::PathBuf;

fn completed_candidate(
    dir: &Dir,
) -> Result<(DurableMarketHost, DurableAuthority, AttemptId), Box<dyn std::error::Error>> {
    let (mut market, mut authority, id, at) = setup_result(dir);
    authority.start_pending(at)?;
    authority.finish(
        "exchange",
        &id,
        ExecutionOutcome::Completed,
        Some(usage()),
        at,
    )?;
    terminal(
        &mut market,
        &mut authority,
        &id,
        at,
        "adjudication-terminal",
    );
    Ok((market, authority, id))
}

#[test]
fn adjudication_commit_crash_worker() -> Result<(), Box<dyn std::error::Error>> {
    let Some(path) = std::env::var_os("BITROUTER_ADJUDICATION_CRASH_DIR") else {
        return Ok(());
    };
    let dir = Dir(path.into());
    let (mut market, _authority, id) = completed_candidate(&dir)?;
    let auth = market
        .host()?
        .snapshot_ref()
        .frozen_grants()
        .and_then(|g| g.get(&id))
        .ok_or("grant missing")?
        .authorization
        .clone();
    let prepared = market.prepare_purchase_result(
        "adjudication/original".into(),
        auth.binding.clone(),
        rf::body(&auth, usage()),
        &rf::FixtureValidator::new(&auth),
    )?;
    market.set_failpoint(Some(
        if std::env::var("BITROUTER_ADJUDICATION_AFTER_COMMIT")? == "yes" {
            FaultPoint::MarketAfterCommit
        } else {
            FaultPoint::MarketBeforeCommit
        },
    ));
    market.publish_qualified_at(prepared, UnixMillis(auth.purchase.delivery_deadline.0 - 1))?;
    Err("adjudication crash point not reached".into())
}

#[test]
fn adjudication_commit_death_recovers_original_decision_or_expires_uncommitted_candidate(
) -> Result<(), Box<dyn std::error::Error>> {
    for committed in [false, true] {
        let dir = Dir::new();
        let child = std::process::Command::new(std::env::current_exe()?)
            .args(["--exact", "adjudication_commit_crash_worker", "--nocapture"])
            .env("BITROUTER_ADJUDICATION_CRASH_DIR", &dir.0)
            .env(
                "BITROUTER_ADJUDICATION_AFTER_COMMIT",
                if committed { "yes" } else { "no" },
            )
            .output()?;
        assert_eq!(
            child.status.code(),
            Some(86),
            "{}",
            String::from_utf8_lossy(&child.stderr)
        );
        let mut market = DurableMarketHost::open(dir.market())?;
        let conn = rusqlite::Connection::open(dir.market())?;
        let blob_count: i64 =
            conn.query_row("SELECT count(*) FROM result_blobs", [], |r| r.get(0))?;
        assert_eq!(blob_count, i64::from(committed));
        let snapshot = market.host()?.snapshot();
        let trade = snapshot
            .purchase_trades()
            .and_then(|t| t.values().next())
            .ok_or("trade missing")?;
        let id = trade.id.clone();
        let deadline = trade.delivery_deadline;
        let auth = snapshot
            .frozen_grants()
            .and_then(|g| g.get(&id))
            .ok_or("grant missing")?
            .authorization
            .clone();
        assert_eq!(
            snapshot.accounts()[&1].balance(),
            MicroUsd(if committed { 989 } else { 1000 })
        );
        assert_eq!(
            snapshot.accounts()[&1].held(),
            MicroUsd(if committed { 0 } else { 11 })
        );
        assert_eq!(
            snapshot.provider_earned(7),
            MicroUsd(if committed { 11 } else { 0 })
        );
        if !committed {
            assert_eq!(
                snapshot.now(),
                trade.accepted_at.ok_or("acceptance missing")?
            );
            assert!(snapshot.purchase_result(&id).is_none());
        }
        market.execute(
            "recover/expiry".into(),
            ExchangeCommand::AdvanceTime(UnixMillis(deadline.0 + 1)),
        )?;
        let prepared = market.prepare_purchase_result(
            "adjudication/original".into(),
            auth.binding.clone(),
            rf::body(&auth, usage()),
            &rf::FixtureValidator::new(&auth),
        )?;
        let receipt = market.publish_qualified_at(prepared, UnixMillis(deadline.0 + 1))?;
        if committed {
            let ExchangeReceipt::PurchaseResultConfirmed(receipt) = receipt else {
                return Err("original decision missing".into());
            };
            assert_eq!(receipt.adjudicated_at, UnixMillis(deadline.0 - 1));
            let json = serde_json::to_value(&receipt)?;
            assert!(json.get("adjudicated_at").is_some());
            assert!(json.get("completed_at").is_none());
            let alias = market.prepare_purchase_result(
                "adjudication/alias".into(),
                auth.binding.clone(),
                rf::body(&auth, usage()),
                &rf::FixtureValidator::new(&auth),
            )?;
            assert_eq!(
                market.publish_qualified_at(alias, UnixMillis(deadline.0 + 2))?,
                ExchangeReceipt::PurchaseResultConfirmed(receipt)
            );
        } else {
            assert!(matches!(
                receipt,
                ExchangeReceipt::PurchaseResultExpired { .. }
            ));
        }
        assert_eq!(
            market.host()?.snapshot_ref().accounts()[&1].held(),
            MicroUsd(0)
        );
        assert_eq!(
            market.host()?.snapshot_ref().provider_earned(7),
            MicroUsd(if committed { 11 } else { 0 })
        );
        let snapshot = market.host()?.snapshot();
        drop(market);
        assert_eq!(
            DurableMarketHost::open(dir.market())?.host()?.snapshot(),
            snapshot
        );
        assert_eq!(
            DurableAuthority::open(dir.authority())?.task_start_count("exchange", &id)?,
            1
        );
    }
    Ok(())
}

#[test]
fn adjudication_sql_abort_rolls_back_clock_result_and_finances_together(
) -> Result<(), Box<dyn std::error::Error>> {
    let dir = Dir::new();
    let (mut market, _authority, id) = completed_candidate(&dir)?;
    let before = market.host()?.snapshot();
    let auth = before
        .frozen_grants()
        .and_then(|g| g.get(&id))
        .ok_or("grant missing")?
        .authorization
        .clone();
    let prepared = market.prepare_purchase_result(
        "adjudication/abort".into(),
        auth.binding.clone(),
        rf::body(&auth, usage()),
        &rf::FixtureValidator::new(&auth),
    )?;
    let conn = rusqlite::Connection::open(dir.market())?;
    conn.execute_batch("CREATE TRIGGER reject_adjudication BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'adjudication aborted'); END;")?;
    assert!(market
        .publish_qualified_at(prepared, UnixMillis(auth.purchase.delivery_deadline.0 - 1))
        .is_err());
    drop(market);
    conn.execute_batch("DROP TRIGGER reject_adjudication;")?;
    let market = DurableMarketHost::open(dir.market())?;
    assert_eq!(market.host()?.snapshot(), before);
    Ok(())
}

#[test]
fn adjudication_rejects_clock_rollback_and_stale_qualification_without_effects(
) -> Result<(), Box<dyn std::error::Error>> {
    let dir = Dir::new();
    let (mut market, _authority, id) = completed_candidate(&dir)?;
    let auth = market
        .host()?
        .snapshot_ref()
        .frozen_grants()
        .and_then(|g| g.get(&id))
        .ok_or("grant missing")?
        .authorization
        .clone();
    let before = market.host()?.snapshot();
    let prepare = |market: &DurableMarketHost| {
        market.prepare_purchase_result(
            "adjudication/stale".into(),
            auth.binding.clone(),
            rf::body(&auth, usage()),
            &rf::FixtureValidator::new(&auth),
        )
    };
    let prepared = prepare(&market)?;
    assert!(market
        .publish_qualified_at(prepared, UnixMillis(before.now().0 - 1))
        .is_err());
    assert_eq!(market.host()?.snapshot(), before);
    let prepared = prepare(&market)?;
    market.execute(
        "advance/basis".into(),
        ExchangeCommand::AdvanceTime(UnixMillis(before.now().0 + 1)),
    )?;
    let changed = market.host()?.snapshot();
    assert!(market
        .publish_qualified_at(prepared, UnixMillis(before.now().0 + 2))
        .is_err());
    assert_eq!(market.host()?.snapshot(), changed);
    Ok(())
}
#[test]
fn adjudication_and_other_trade_expiry_commit_or_roll_back_and_replay_together(
) -> Result<(), Box<dyn std::error::Error>> {
    for abort in [false, true] {
        let dir = Dir::new();
        let (mut market, mut authority, expiring_id, initial) = setup_result(&dir);
        let deadline = market
            .host()?
            .snapshot_ref()
            .purchase_trades()
            .and_then(|t| t.get(&expiring_id))
            .ok_or("expiring trade missing")?
            .delivery_deadline;
        let at = UnixMillis(initial.0 + 1);
        market.execute(
            "clock/second-trade".into(),
            ExchangeCommand::AdvanceTime(at),
        )?;
        let order = registration("second-result", 2, &["b"], false);
        market.execute(
            order.idempotency_key.clone(),
            ExchangeCommand::PlaceFormalOrder(Box::new(order.clone())),
        )?;
        let quote = publication(market.host()?, &order, 1, "second-result");
        market.execute(
            "quote/second-result".into(),
            ExchangeCommand::PurchaseQuote(Box::new(quote.clone())),
        )?;
        let proposal = proposal(market.host()?, &order, &[quote], "second-result");
        let ExchangeReceipt::PurchaseDecided(receipt) = market.execute(
            proposal.idempotency_key.clone(),
            ExchangeCommand::ProposePurchase(Box::new(proposal)),
        )?
        else {
            return Err("purchase decision missing".into());
        };
        let id = id(&receipt);
        let effect = request(market.host()?, &id, ExecutionRequestKind::Submit).effect_id;
        let report = market.dispatch(&effect, &mut authority)?;
        let origin = authority.authority()?.origin();
        market.receive("accepted/second-result".into(), origin, report)?;
        authority.start_pending(at)?;
        authority.finish(
            "exchange",
            &id,
            ExecutionOutcome::Completed,
            Some(usage()),
            at,
        )?;
        terminal(&mut market, &mut authority, &id, at, "second-result");
        let before = market.host()?.snapshot();
        let auth = before
            .frozen_grants()
            .and_then(|g| g.get(&id))
            .ok_or("second grant missing")?
            .authorization
            .clone();
        assert!(deadline < auth.purchase.delivery_deadline);
        let prepared = market.prepare_purchase_result(
            "adjudication/two-trades".into(),
            auth.binding.clone(),
            rf::body(&auth, usage()),
            &rf::FixtureValidator::new(&auth),
        )?;
        let conn = rusqlite::Connection::open(dir.market())?;
        if abort {
            conn.execute_batch("CREATE TRIGGER reject_two_trades BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'two trades aborted'); END;")?;
        }
        let result = market.publish_qualified_at(prepared, deadline);
        if abort {
            assert!(result.is_err());
            conn.execute_batch("DROP TRIGGER reject_two_trades;")?;
        } else {
            assert!(matches!(
                result?,
                ExchangeReceipt::PurchaseResultConfirmed(_)
            ));
        }
        drop(market);
        let market = DurableMarketHost::open(dir.market())?;
        let snapshot = market.host()?.snapshot();
        if abort {
            assert_eq!(snapshot, before);
        } else {
            assert_eq!(snapshot.now(), deadline);
            assert_eq!(snapshot.accounts()[&1].balance(), MicroUsd(1000));
            assert_eq!(snapshot.accounts()[&1].held(), MicroUsd(0));
            assert_eq!(snapshot.accounts()[&2].balance(), MicroUsd(989));
            assert_eq!(snapshot.accounts()[&2].held(), MicroUsd(0));
            assert_eq!(snapshot.provider_earned(7), MicroUsd(11));
            assert_eq!(snapshot.occupancy(AdmissionScopeId(30)), 1);
            assert!(
                matches!(snapshot.purchase_trades().and_then(|t| t.get(&expiring_id))
                .ok_or("expired trade missing")?.settlement, ReservationSettlement::ClosedUnpaid { closed_at } if closed_at == deadline)
            );
        }
        assert_eq!(
            bitrouter_market::market_host::MarketHost::replay(
                bootstrap(false),
                &market.host()?.journal()
            )?
            .snapshot(),
            snapshot
        );
    }
    Ok(())
}

struct Dir(PathBuf);
impl Dir {
    fn new() -> Self {
        static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "market-result-{}-{}-{}",
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
    fn authority(&self) -> PathBuf {
        self.0.join("authority.sqlite")
    }
}
impl Drop for Dir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn usage() -> TokenUsage {
    TokenUsage {
        uncached_input_tokens: 10,
        cached_input_tokens: 0,
        billable_output_tokens: 1,
    }
}
fn setup_result(dir: &Dir) -> (DurableMarketHost, DurableAuthority, AttemptId, UnixMillis) {
    let (h, a) = setup(false, false);
    let mut m = DurableMarketHost::create(dir.market(), bootstrap(false)).unwrap();
    for (key, c) in h.journal().commands() {
        m.execute(key.clone(), c.clone()).unwrap();
    }
    let r = registration("result", 1, &["a"], false);
    m.execute(
        r.idempotency_key.clone(),
        ExchangeCommand::PlaceFormalOrder(Box::new(r.clone())),
    )
    .unwrap();
    let q = publication(m.host().unwrap(), &r, 1, "result");
    m.execute(
        "quote".into(),
        ExchangeCommand::PurchaseQuote(Box::new(q.clone())),
    )
    .unwrap();
    let p = proposal(m.host().unwrap(), &r, &[q], "result");
    let ExchangeReceipt::PurchaseDecided(d) = m
        .execute(
            p.idempotency_key.clone(),
            ExchangeCommand::ProposePurchase(Box::new(p)),
        )
        .unwrap()
    else {
        panic!("decision")
    };
    let id = id(&d);
    let mut a = DurableAuthority::create(dir.authority(), a, m.resolver()).unwrap();
    let report = m
        .dispatch(
            &request(m.host().unwrap(), &id, ExecutionRequestKind::Submit).effect_id,
            &mut a,
        )
        .unwrap();
    m.receive("accepted".into(), a.authority().unwrap().origin(), report)
        .unwrap();
    let e = m.host().unwrap().snapshot().now();
    (m, a, id, e)
}
fn terminal(
    m: &mut DurableMarketHost,
    a: &mut DurableAuthority,
    id: &AttemptId,
    time: UnixMillis,
    label: &str,
) {
    m.execute(format!("clock/{label}"), ExchangeCommand::AdvanceTime(time))
        .unwrap();
    m.execute(
        format!("query/{label}"),
        ExchangeCommand::Frozen(Box::new(FrozenCommand::Request {
            attempt: id.clone(),
            kind: ExecutionRequestKind::Query,
        })),
    )
    .unwrap();
    let effect = request(m.host().unwrap(), id, ExecutionRequestKind::Query).effect_id;
    let report = m.dispatch(&effect, a).unwrap();
    m.receive(
        format!("report/{label}"),
        a.authority().unwrap().origin(),
        report,
    )
    .unwrap();
}
fn publish(m: &mut DurableMarketHost, id: &AttemptId) {
    let auth = m.host().unwrap().snapshot().frozen_grants().unwrap()[id]
        .authorization
        .clone();
    let validator = rf::FixtureValidator::new(&auth);
    m.publish_purchase_result(
        "result/1".into(),
        auth.binding.clone(),
        rf::body(&auth, usage()),
        &validator,
    )
    .unwrap();
}
#[test]
fn result_crash_worker() {
    let Some(path) = std::env::var_os("BITROUTER_RESULT_CRASH_DIR") else {
        return;
    };
    let dir = Dir(path.into());
    let action = std::env::var("BITROUTER_RESULT_CRASH_ACTION").unwrap();
    let (mut m, mut a, id, e) = setup_result(&dir);
    a.start_pending(UnixMillis(e.0 + 10)).unwrap();
    if action == "first-scheduler" {
        a.set_failpoint(Some(FaultPoint::SchedulerFirstResponse));
    }
    if action == "first-recorded" {
        a.set_failpoint(Some(FaultPoint::FirstResponseRecorded));
    }
    a.first_response("exchange", &id, UnixMillis(e.0 + 20))
        .unwrap();
    if action == "terminal-scheduler" {
        a.set_failpoint(Some(FaultPoint::SchedulerCompleted));
    }
    a.finish(
        "exchange",
        &id,
        ExecutionOutcome::Completed,
        Some(usage()),
        UnixMillis(e.0 + 30),
    )
    .unwrap();
    terminal(&mut m, &mut a, &id, UnixMillis(e.0 + 40), "terminal");
    if action == "before-result" {
        m.set_failpoint(Some(FaultPoint::MarketBeforeCommit));
    }
    if action == "after-result" {
        m.set_failpoint(Some(FaultPoint::MarketAfterCommit));
    }
    publish(&mut m, &id);
    panic!("crash point not reached");
}
#[test]
fn original_milestones_and_atomic_result_availability_survive_process_death_and_snapshots() {
    for action in [
        "first-scheduler",
        "first-recorded",
        "terminal-scheduler",
        "before-result",
        "after-result",
    ] {
        let dir = Dir::new();
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "result_crash_worker", "--nocapture"])
            .env("BITROUTER_RESULT_CRASH_DIR", &dir.0)
            .env("BITROUTER_RESULT_CRASH_ACTION", action)
            .status()
            .unwrap();
        assert_eq!(status.code(), Some(86), "{action}");
        let mut m = DurableMarketHost::open(dir.market()).unwrap();
        let mut a = DurableAuthority::open(dir.authority()).unwrap();
        let snapshot = m.host().unwrap().snapshot();
        let id = snapshot
            .purchase_trades()
            .unwrap()
            .keys()
            .next()
            .unwrap()
            .clone();
        let e = snapshot.purchase_trades().unwrap()[&id]
            .accepted_at
            .unwrap();
        let attempt = &a.authority().unwrap().attempts()[&("exchange".into(), id.clone())];
        let milestones = attempt.milestones.as_ref().unwrap();
        assert_eq!(milestones.started_at, Some(UnixMillis(e.0 + 10)));
        assert_eq!(milestones.first_response_at, Some(UnixMillis(e.0 + 20)));
        assert_eq!(a.task_start_count("exchange", &id).unwrap(), 1);
        if action.starts_with("first-") {
            a.finish(
                "exchange",
                &id,
                ExecutionOutcome::Completed,
                Some(usage()),
                UnixMillis(e.0 + 30),
            )
            .unwrap();
        }
        assert_eq!(
            snapshot.purchase_result(&id).is_some(),
            action == "after-result"
        );
        terminal(&mut m, &mut a, &id, UnixMillis(e.0 + 40), "recovered");
        let t = m.host().unwrap().snapshot().purchase_trades().unwrap()[&id].clone();
        assert_eq!(t.started_at, Some(UnixMillis(e.0 + 10)));
        assert_eq!(t.first_response_at, Some(UnixMillis(e.0 + 20)));
        let balance = m.host().unwrap().snapshot().accounts()[&1].balance();
        publish(&mut m, &id);
        let snapshot = m.host().unwrap().snapshot();
        let result = snapshot.purchase_result(&id).unwrap();
        assert_eq!(result.receipt.adjudicated_at, UnixMillis(e.0 + 40));
        let auth = &snapshot.frozen_grants().unwrap()[&id].authorization;
        assert_eq!(result.publication.bytes(), rf::body(auth, usage()));
        assert_eq!(
            snapshot.accounts()[&1].balance(),
            MicroUsd(if action == "after-result" {
                balance.0
            } else {
                balance.0 - 11
            })
        );
        drop(m);
        drop(a);
        let m = DurableMarketHost::open(dir.market()).unwrap();
        assert_eq!(m.host().unwrap().snapshot(), snapshot);
        let a = DurableAuthority::open(dir.authority()).unwrap();
        assert_eq!(a.task_start_count("exchange", &id).unwrap(), 1);
    }
}
#[test]
fn sql_abort_cannot_commit_availability_without_the_verified_bytes_or_consume_its_key() {
    let dir = Dir::new();
    let (mut m, mut a, id, e) = setup_result(&dir);
    a.start_pending(e).unwrap();
    a.finish(
        "exchange",
        &id,
        ExecutionOutcome::Completed,
        Some(usage()),
        e,
    )
    .unwrap();
    terminal(&mut m, &mut a, &id, e, "terminal");
    let auth = m.host().unwrap().snapshot().frozen_grants().unwrap()[&id]
        .authorization
        .clone();
    let validator = rf::FixtureValidator::new(&auth);
    let conn = rusqlite::Connection::open(dir.market()).unwrap();
    conn.execute_batch("CREATE TRIGGER reject_result BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'result transaction aborted'); END;").unwrap();
    let before = m.host().unwrap().snapshot();
    assert!(m
        .publish_purchase_result(
            "result/1".into(),
            auth.binding.clone(),
            rf::body(&auth, usage()),
            &validator
        )
        .is_err());
    assert!(matches!(m.host(), Err(DurableError::Poisoned)));
    conn.execute_batch("DROP TRIGGER reject_result;").unwrap();
    drop(m);
    let mut m = DurableMarketHost::open(dir.market()).unwrap();
    assert_eq!(m.host().unwrap().snapshot(), before);
    publish(&mut m, &id);
    assert!(m.host().unwrap().snapshot().purchase_result(&id).is_some());
}

#[test]
fn inability_to_start_preserves_accepted_failure_without_inventing_a_start_or_delivery() {
    for outcome in [ExecutionOutcome::Failed, ExecutionOutcome::Cancelled] {
        let dir = Dir::new();
        let (mut m, mut a, id, e) = setup_result(&dir);
        assert!(a
            .finish(
                "exchange",
                &id,
                ExecutionOutcome::Completed,
                Some(usage()),
                e
            )
            .is_err());
        a.finish("exchange", &id, outcome, None, e).unwrap();
        terminal(&mut m, &mut a, &id, e, "failed-before-start");
        let snapshot = m.host().unwrap().snapshot();
        let t = &snapshot.purchase_trades().unwrap()[&id];
        assert_eq!(t.accepted_at, Some(e));
        assert_eq!(t.started_at, None);
        assert_eq!(t.first_response_at, None);
        assert_eq!(t.settlement, ReservationSettlement::Pending);
        assert!(t.delivery.is_none());
        assert_eq!(snapshot.occupancy(AdmissionScopeId(30)), 0);
        assert_eq!(snapshot.accounts()[&1].held(), MicroUsd(11));
        assert_eq!(a.task_start_count("exchange", &id).unwrap(), 0);
        drop(m);
        drop(a);
        let mut a = DurableAuthority::open(dir.authority()).unwrap();
        a.start_pending(UnixMillis(e.0 + 1)).unwrap();
        assert_eq!(a.task_start_count("exchange", &id).unwrap(), 0);
        let m = DurableMarketHost::open(dir.market()).unwrap();
        assert_eq!(m.host().unwrap().snapshot(), snapshot);
    }
}

#[test]
fn deadline_crash_worker() -> Result<(), Box<dyn std::error::Error>> {
    let Some(path) = std::env::var_os("BITROUTER_DELIVERY_CRASH_DIR") else {
        return Ok(());
    };
    let dir = Dir(path.into());
    let (mut m, _a, id, _e) = setup_result(&dir);
    let deadline = m
        .host()?
        .snapshot_ref()
        .purchase_trades()
        .and_then(|t| t.get(&id))
        .ok_or("trade missing")?
        .delivery_deadline;
    let after = std::env::var("BITROUTER_DELIVERY_CRASH_AFTER")? == "yes";
    m.set_failpoint(Some(if after {
        FaultPoint::MarketAfterCommit
    } else {
        FaultPoint::MarketBeforeCommit
    }));
    m.execute("expiry".into(), ExchangeCommand::AdvanceTime(deadline))?;
    Err("expiry crash point was not reached".into())
}

#[test]
fn expiry_commit_death_recovers_all_or_none_and_keeps_unknown_execution(
) -> Result<(), Box<dyn std::error::Error>> {
    for after in [false, true] {
        let dir = Dir::new();
        let status = std::process::Command::new(std::env::current_exe()?)
            .args(["--exact", "deadline_crash_worker", "--nocapture"])
            .env("BITROUTER_DELIVERY_CRASH_DIR", &dir.0)
            .env(
                "BITROUTER_DELIVERY_CRASH_AFTER",
                if after { "yes" } else { "no" },
            )
            .output()?
            .status;
        assert!(!status.success());
        let mut m = DurableMarketHost::open(dir.market())?;
        let s = m.host()?.snapshot();
        let t = s
            .purchase_trades()
            .and_then(|t| t.values().next())
            .ok_or("trade missing")?;
        assert_eq!(s.accounts()[&1].balance(), MicroUsd(1000));
        assert_eq!(
            s.accounts()[&1].held(),
            MicroUsd(if after { 0 } else { 11 })
        );
        assert_eq!(s.provider_earned(7), MicroUsd(0));
        assert_eq!(s.occupancy(AdmissionScopeId(30)), 1);
        assert!(t.terminal.is_none());
        let deadline = t.delivery_deadline;
        m.execute("expiry".into(), ExchangeCommand::AdvanceTime(deadline))?;
        let expected = m.host()?.snapshot();
        assert_eq!(expected.accounts()[&1].held(), MicroUsd(0));
        drop(m);
        let m = DurableMarketHost::open(dir.market())?;
        assert_eq!(m.host()?.snapshot(), expected);
    }
    Ok(())
}

#[test]
fn verification_finishing_at_deadline_cannot_backdate_qualified_delivery(
) -> Result<(), Box<dyn std::error::Error>> {
    let dir = Dir::new();
    let (mut m, mut a, id, e) = setup_result(&dir);
    a.start_pending(e)?;
    a.finish(
        "exchange",
        &id,
        ExecutionOutcome::Completed,
        Some(usage()),
        e,
    )?;
    terminal(&mut m, &mut a, &id, e, "completed");
    let auth = m
        .host()?
        .snapshot_ref()
        .frozen_grants()
        .and_then(|g| g.get(&id))
        .ok_or("grant missing")?
        .authorization
        .clone();
    let prepared = m.prepare_purchase_result(
        "validated".into(),
        auth.binding.clone(),
        rf::body(&auth, usage()),
        &rf::FixtureValidator::new(&auth),
    )?;
    assert!(matches!(
        m.publish_qualified_at(prepared, auth.purchase.delivery_deadline)?,
        ExchangeReceipt::PurchaseResultExpired { .. }
    ));
    assert_eq!(
        m.host()?.snapshot_ref().accounts()[&1].balance(),
        MicroUsd(1000)
    );
    assert_eq!(m.host()?.snapshot_ref().accounts()[&1].held(), MicroUsd(0));
    assert_eq!(m.host()?.snapshot_ref().provider_earned(7), MicroUsd(0));
    Ok(())
}

#[test]
fn response_ended_before_a_newer_query_preserves_original_time_through_reopen(
) -> Result<(), Box<dyn std::error::Error>> {
    let dir = Dir::new();
    let (mut m, mut a, id, e) = setup_result(&dir);
    a.start_pending(UnixMillis(e.0 + 10))?;
    // Another observation has already advanced the shared authority clock.
    terminal(&mut m, &mut a, &id, UnixMillis(e.0 + 100), "newer-query");
    let ended_at = UnixMillis(e.0 + 20);
    a.finish_observed(
        "exchange",
        &id,
        ExecutionOutcome::Completed,
        Some(usage()),
        ended_at,
        UnixMillis(e.0 + 110),
    )?;
    terminal(&mut m, &mut a, &id, UnixMillis(e.0 + 110), "old-response");
    let t = m
        .host()?
        .snapshot_ref()
        .purchase_trades()
        .and_then(|t| t.get(&id))
        .cloned()
        .ok_or("trade missing")?;
    assert!(
        matches!(t.terminal,Some(ReservationEvidence::Terminal{ended_at:time,..}) if time==ended_at)
    );
    assert_eq!(t.settlement, ReservationSettlement::AwaitingDelivery);
    publish(&mut m, &id);
    let expected = m.host()?.snapshot();
    assert_eq!(expected.accounts()[&1].balance(), MicroUsd(989));
    drop(m);
    drop(a);
    let m = DurableMarketHost::open(dir.market())?;
    assert_eq!(m.host()?.snapshot(), expected);
    let a = DurableAuthority::open(dir.authority())?;
    assert!(
        matches!(a.authority()?.attempts().get(&("exchange".into(),id)).map(|a|&a.state),Some(ExecutionReportState::Terminal{ended_at:time,..}) if *time==ended_at)
    );
    Ok(())
}

fn large_result_body(
    auth: &bitrouter_market::execution_authorization::ExecutionAuthorization,
) -> Vec<u8> {
    let mut bytes = rf::body(auth, usage());
    // Legal trailing JSON whitespace remains part of the exact retained body.
    bytes.resize(64 * 1024, b' ');
    bytes
}

#[test]
fn result_blobs_share_original_bytes_and_keep_events_and_checkpoints_compact(
) -> Result<(), Box<dyn std::error::Error>> {
    let dir = Dir::new();
    let (mut market, _authority, id) = completed_candidate(&dir)?;
    let auth = market.host()?.snapshot_ref().frozen_grants().unwrap()[&id]
        .authorization
        .clone();
    let bytes = large_result_body(&auth);
    let validator = rf::FixtureValidator::new(&auth);
    for n in 0..16 {
        market.publish_purchase_result(
            format!("blob/result/{n}"),
            auth.binding.clone(),
            bytes.clone(),
            &validator,
        )?;
    }
    assert_eq!(validator.calls.get(), 1);
    market.checkpoint()?;
    let ordinary = serde_json::to_vec(market.host()?)?;
    let conn = rusqlite::Connection::open(dir.market())?;
    let (count, raw_len): (i64, i64) = conn.query_row(
        "SELECT count(*),sum(length(payload)) FROM result_blobs",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    assert_eq!((count, raw_len), (1, bytes.len() as i64));
    let payload: Vec<u8> = conn.query_row("SELECT payload FROM result_blobs", [], |r| r.get(0))?;
    assert_eq!(payload, bytes);
    let checkpoint_size: i64 =
        conn.query_row("SELECT length(payload) FROM state_snapshot", [], |r| {
            r.get(0)
        })?;
    assert!(
        checkpoint_size < ordinary.len() as i64 / 8,
        "checkpoint {checkpoint_size}, inline {}",
        ordinary.len()
    );
    let event_size: i64 = conn.query_row("SELECT max(length(payload)) FROM events WHERE CAST(payload AS TEXT) LIKE '%result_blob_v1%'", [], |r| r.get(0))?;
    assert!(event_size < 8 * 1024);
    assert!(conn
        .execute("UPDATE result_blobs SET payload=payload", [])
        .is_err());
    assert!(conn.execute("DELETE FROM result_blobs", []).is_err());
    let expected = market.host()?.snapshot();
    drop(market);
    let committed = DurableMarketHost::read_committed(dir.market())?;
    assert_eq!(committed.snapshot(), expected);
    let snapshot = committed.snapshot_ref();
    let result = snapshot.purchase_result(&id).unwrap();
    assert_eq!(result.publication.bytes(), bytes);
    let journal = committed.journal();
    for (_, command) in journal.commands() {
        if let ExchangeCommand::PublishPurchaseResult(publication) = command {
            assert_eq!(publication.bytes(), bytes);
            assert_eq!(
                publication.bytes().as_ptr(),
                result.publication.bytes().as_ptr()
            );
        }
    }
    let market = DurableMarketHost::open(dir.market())?;
    assert_eq!(market.host()?.snapshot(), expected);
    Ok(())
}

#[test]
fn result_blob_failures_roll_back_raw_bytes_event_and_result_together(
) -> Result<(), Box<dyn std::error::Error>> {
    for checkpoint_failure in [false, true] {
        let dir = Dir::new();
        let (mut market, _authority, id) = completed_candidate(&dir)?;
        if checkpoint_failure {
            while market.host()?.snapshot_ref().revision() % 64 != 63 {
                let snapshot = market.host()?.snapshot_ref();
                let key = format!("blob/pad/{}", snapshot.revision());
                let now = snapshot.now();
                market.execute(key, ExchangeCommand::AdvanceTime(now))?;
            }
        }
        let before = market.host()?.snapshot();
        let auth = before.frozen_grants().unwrap()[&id].authorization.clone();
        let conn = rusqlite::Connection::open(dir.market())?;
        conn.execute_batch(if checkpoint_failure {
            "CREATE TRIGGER reject_blob_commit BEFORE INSERT ON state_snapshot BEGIN SELECT RAISE(ABORT,'snapshot failed'); END;"
        } else {
            "CREATE TRIGGER reject_blob_commit BEFORE INSERT ON result_blobs BEGIN SELECT RAISE(ABORT,'blob failed'); END;"
        })?;
        assert!(market
            .publish_purchase_result(
                "blob/failed".into(),
                auth.binding.clone(),
                large_result_body(&auth),
                &rf::FixtureValidator::new(&auth)
            )
            .is_err());
        assert!(matches!(market.host(), Err(DurableError::Poisoned)));
        assert_eq!(
            conn.query_row("SELECT count(*) FROM result_blobs", [], |r| r
                .get::<_, i64>(0))?,
            0
        );
        assert_eq!(
            DurableMarketHost::read_committed(dir.market())?.snapshot(),
            before
        );
        drop(market);
        conn.execute_batch("DROP TRIGGER reject_blob_commit;")?;
        let market = DurableMarketHost::open(dir.market())?;
        assert_eq!(market.host()?.snapshot(), before);
    }
    Ok(())
}

#[test]
fn result_blob_corruption_is_rejected_even_when_checkpoint_covers_publication(
) -> Result<(), Box<dyn std::error::Error>> {
    use sha2::{Digest, Sha256};
    for missing in [false, true] {
        let dir = Dir::new();
        let (mut market, _authority, id) = completed_candidate(&dir)?;
        publish(&mut market, &id);
        market.checkpoint()?;
        let inline_checkpoint = serde_json::to_vec(market.host()?)?;
        drop(market);
        let conn = rusqlite::Connection::open(dir.market())?;
        if missing {
            // An inline checkpoint can independently restore every result.
            // The original event's durable BLOB evidence must still exist.
            let checksum = format!("{:x}", Sha256::digest(&inline_checkpoint));
            conn.execute(
                "UPDATE state_snapshot SET payload=?,checksum=?",
                rusqlite::params![inline_checkpoint, checksum],
            )?;
            conn.execute_batch(
                "DROP TRIGGER immutable_result_blob_delete; DELETE FROM result_blobs;",
            )?;
        } else {
            conn.execute_batch("DROP TRIGGER immutable_result_blob_update; UPDATE result_blobs SET payload=zeroblob(length);")?;
        }
        assert!(DurableMarketHost::read_committed(dir.market()).is_err());
        assert!(DurableMarketHost::open(dir.market()).is_err());
    }
    Ok(())
}

#[test]
fn typed_checkpoint_decode_rejects_corrupt_result_references_without_event_corruption(
) -> Result<(), Box<dyn std::error::Error>> {
    use serde_json::{json, Value};
    use sha2::{Digest, Sha256};
    fn corrupt_first(value: &mut Value, change: &dyn Fn(&mut Value)) -> bool {
        match value {
            Value::Object(object) if object.contains_key("result_blob_v1") => {
                change(value);
                true
            }
            Value::Object(object) => object.values_mut().any(|v| corrupt_first(v, change)),
            Value::Array(array) => array.iter_mut().any(|v| corrupt_first(v, change)),
            _ => false,
        }
    }
    let dir = Dir::new();
    let (mut market, _authority, id) = completed_candidate(&dir)?;
    publish(&mut market, &id);
    market.checkpoint()?;
    let expected = market.host()?.snapshot();
    drop(market);
    let conn = rusqlite::Connection::open(dir.market())?;
    let original: Vec<u8> =
        conn.query_row("SELECT payload FROM state_snapshot", [], |r| r.get(0))?;
    let original: Value = serde_json::from_slice(&original)?;
    // Each independent holder is decoded even when it is unrelated to replay.
    for location in ["commands", "journal", "trades"] {
        for corruption in 0..10 {
            let mut snapshot = original.clone();
            let target = if location == "trades" {
                &mut snapshot["kernel"]["state"]["purchase"]["trades"]
            } else {
                &mut snapshot["kernel"][location]
            };
            assert!(
                corrupt_first(target, &|reference| match corruption {
                    0 => reference["result_blob_v1"] = json!(format!("sha256/{}", "0".repeat(64))),
                    1 => reference["length"] = json!(reference["length"].as_u64().unwrap() + 1),
                    2 => reference["result_blob_v1"] = json!(0),
                    3 => reference["length"] = json!("181"),
                    4 => {
                        reference.as_object_mut().unwrap().remove("length");
                    }
                    5 => reference["extra"] = json!(false),
                    6 =>
                        reference["extra"] = json!({"result_blob_v1": reference["result_blob_v1"], "length": reference["length"]}),
                    7 => reference["result_blob_v1"] = json!({"nested": "reference"}),
                    8 => {
                        reference.as_object_mut().unwrap().remove("result_blob_v1");
                    }
                    9 => reference["length"] = json!(-1),
                    _ => unreachable!(),
                }),
                "missing result reference in {location}"
            );
            let payload = serde_json::to_vec(&snapshot)?;
            let checksum = format!("{:x}", Sha256::digest(&payload));
            conn.execute(
                "UPDATE state_snapshot SET payload=?,checksum=?",
                rusqlite::params![payload, checksum],
            )?;
            // Every event, its chain and the original immutable BLOB remain
            // unchanged. Rejection must come from typed checkpoint decoding.
            assert!(
                matches!(
                    DurableMarketHost::read_committed(dir.market()),
                    Err(DurableError::Codec(_))
                ),
                "read {location}/{corruption}"
            );
            assert!(
                matches!(
                    DurableMarketHost::open(dir.market()),
                    Err(DurableError::Codec(_))
                ),
                "open {location}/{corruption}"
            );
        }
    }
    let payload = serde_json::to_vec(&original)?;
    let checksum = format!("{:x}", Sha256::digest(&payload));
    conn.execute(
        "UPDATE state_snapshot SET payload=?,checksum=?",
        rusqlite::params![payload, checksum],
    )?;
    assert_eq!(
        DurableMarketHost::read_committed(dir.market())?.snapshot(),
        expected
    );
    assert_eq!(
        DurableMarketHost::open(dir.market())?.host()?.snapshot(),
        expected
    );
    Ok(())
}

#[test]
fn old_inline_result_ledger_and_checkpoint_remain_readable_and_can_checkpoint_again(
) -> Result<(), Box<dyn std::error::Error>> {
    use sha2::{Digest, Sha256};
    fn digest(bytes: &[u8]) -> String {
        format!("{:x}", Sha256::digest(bytes))
    }
    fn inline(value: &mut serde_json::Value, bytes: &[u8]) {
        match value {
            serde_json::Value::Object(object) if object.contains_key("result_blob_v1") => {
                *value = serde_json::to_value(bytes).unwrap();
            }
            serde_json::Value::Object(object) => {
                for child in object.values_mut() {
                    inline(child, bytes);
                }
            }
            serde_json::Value::Array(array) => {
                for child in array {
                    inline(child, bytes);
                }
            }
            _ => {}
        }
    }
    let dir = Dir::new();
    let (mut market, _authority, id) = completed_candidate(&dir)?;
    let auth = market.host()?.snapshot_ref().frozen_grants().unwrap()[&id]
        .authorization
        .clone();
    let bytes = large_result_body(&auth);
    market.publish_purchase_result(
        "blob/old-format".into(),
        auth.binding.clone(),
        bytes.clone(),
        &rf::FixtureValidator::new(&auth),
    )?;
    let expected_host = market.host()?.clone();
    let checkpoint = serde_json::to_vec(&expected_host)?;
    let expected = expected_host.snapshot();
    drop(market);
    let mut conn = rusqlite::Connection::open(dir.market())?;
    let mut previous: String =
        conn.query_row("SELECT seed_hash FROM metadata", [], |r| r.get(0))?;
    let events: Vec<(i64, Vec<u8>)> = conn
        .prepare("SELECT seq,payload FROM events ORDER BY seq")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<Result<_, _>>()?;
    let tx = conn.transaction()?;
    for (seq, payload) in events {
        let mut value: serde_json::Value = serde_json::from_slice(&payload)?;
        inline(&mut value, &bytes);
        let payload = serde_json::to_vec(&value)?;
        let mut chain = previous.as_bytes().to_vec();
        chain.push(0);
        chain.extend_from_slice(&payload);
        let hash = digest(&chain);
        tx.execute(
            "UPDATE events SET previous_hash=?,payload=?,checksum=?,event_hash=? WHERE seq=?",
            rusqlite::params![previous, payload, digest(&payload), hash, seq],
        )?;
        previous = hash;
    }
    tx.execute("UPDATE metadata SET head_hash=?", [&previous])?;
    tx.execute("UPDATE state_snapshot SET revision=(SELECT head FROM metadata),payload=?,checksum=?,event_hash=?", rusqlite::params![checkpoint,digest(&checkpoint),previous])?;
    tx.execute_batch("DROP TABLE result_blobs;")?;
    tx.commit()?;
    assert_eq!(
        DurableMarketHost::read_committed(dir.market())?.snapshot(),
        expected
    );
    let exists: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='result_blobs')",
        [],
        |r| r.get(0),
    )?;
    assert!(!exists, "read_committed must leave old schema untouched");
    let mut market = DurableMarketHost::open(dir.market())?;
    assert_eq!(market.host()?.snapshot(), expected);
    market.checkpoint()?;
    assert_eq!(
        conn.query_row("SELECT count(*) FROM result_blobs", [], |r| r
            .get::<_, i64>(0))?,
        1
    );
    drop(market);
    assert_eq!(
        DurableMarketHost::read_committed(dir.market())?.snapshot(),
        expected
    );
    Ok(())
}
