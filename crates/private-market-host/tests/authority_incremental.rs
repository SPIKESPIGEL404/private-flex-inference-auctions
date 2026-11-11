#![cfg(feature = "sqlite-tools")]
//! Authority history remains immutable while bounded tails recover original reports.
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
use bitrouter_market::execution_contract::*;
use bitrouter_market::order::*;
use rusqlite::Connection;
use std::path::PathBuf;

struct Dir(PathBuf);
impl Dir {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "authority-incremental-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
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
fn setup(
    dir: &Dir,
) -> (
    DurableMarketHost,
    DurableAuthority,
    ExecutionRequest,
    UnixMillis,
) {
    let (h, a, id) = cf::setup(false);
    let mut market = DurableMarketHost::create(dir.market(), cf::bootstrap()).unwrap();
    for (key, command) in h.journal().commands() {
        market.execute(key.clone(), command.clone()).unwrap();
    }
    let request = pf::request(market.host().unwrap(), &id, ExecutionRequestKind::Submit);
    let now = market.host().unwrap().snapshot().now();
    let authority = DurableAuthority::create(dir.authority(), a, market.resolver()).unwrap();
    (market, authority, request, now)
}
fn bytes<T: serde::Serialize>(value: &T) -> Vec<u8> {
    serde_json::to_vec(value).unwrap()
}

#[test]
fn checkpoints_bound_tails_without_rewriting_task_facts_or_original_effects() {
    let dir = Dir::new();
    let (market, mut a, submit, now) = setup(&dir);
    let accepted = a.handle(&submit, now).unwrap();
    let original = bytes(&accepted);
    a.start_attempt(&submit.binding.exchange_id, &submit.binding.attempt_id, now)
        .unwrap();
    a.first_response(&submit.binding.exchange_id, &submit.binding.attempt_id, now)
        .unwrap();
    a.finish(
        &submit.binding.exchange_id,
        &submit.binding.attempt_id,
        ExecutionOutcome::Completed,
        Some(fixture::usage()),
        now,
    )
    .unwrap();
    let c = Connection::open(dir.authority()).unwrap();
    c.execute_batch("CREATE TRIGGER original_scheduler_facts BEFORE UPDATE ON tasks BEGIN SELECT RAISE(ABORT,'original task rewritten'); END;").unwrap();
    for n in 0..70 {
        let mut query = submit.clone();
        query.kind = ExecutionRequestKind::Query;
        query.effect_id = EffectId::new(format!("incremental-query-{n:03}")).unwrap();
        a.handle(&query, now).unwrap();
    }
    let (head, checkpoint, last_event, snapshot): (i64, i64, i64, i64) = c.query_row(
        "SELECT head,(SELECT revision FROM state_snapshot),(SELECT length(payload) FROM events ORDER BY seq DESC LIMIT 1),(SELECT length(payload) FROM state_snapshot) FROM metadata", [],
        |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).unwrap();
    assert_eq!(checkpoint, 64);
    assert!(head > checkpoint && head - checkpoint < 64);
    assert!(
        snapshot > last_event * 20,
        "history accidentally copied into incremental event"
    );
    let events: Vec<Vec<u8>> = c
        .prepare("SELECT payload FROM events ORDER BY seq")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    let expected = bytes(a.authority().unwrap());
    let fence: i64 = c
        .query_row("SELECT fence FROM metadata", [], |r| r.get(0))
        .unwrap();
    assert_eq!(
        bytes(&DurableAuthority::read_committed(dir.authority()).unwrap()),
        expected
    );
    assert_eq!(
        c.query_row("SELECT fence FROM metadata", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        fence
    );
    drop(a);
    drop(market);
    // Recovery and duplicate effects need only the original durable grant/report;
    // removing the source market catches any accidental fresh grant resolution.
    std::fs::rename(dir.market(), dir.0.join("market-offline.sqlite")).unwrap();
    let mut a = DurableAuthority::open(dir.authority()).unwrap();
    assert_eq!(bytes(a.authority().unwrap()), expected);
    assert_eq!(
        bytes(&a.handle(&submit, UnixMillis(now.0 + 10)).unwrap()),
        original
    );
    assert_eq!(
        a.task_start_count(&submit.binding.exchange_id, &submit.binding.attempt_id)
            .unwrap(),
        1
    );
    let after: Vec<Vec<u8>> = c
        .prepare("SELECT payload FROM events ORDER BY seq")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert_eq!(events, after);
}

#[test]
fn historical_full_snapshots_continue_with_incremental_controls_and_restore_occupancy() {
    let dir = Dir::new();
    let (_market, mut a, _, _) = setup(&dir);
    a.accept_other(AdmissionScopeId(30), "historical-other".into())
        .unwrap();
    a.checkpoint().unwrap();
    let original = bytes(a.authority().unwrap());
    // This is the old format: a current full snapshot, the same ordered-entry
    // arrays, and no derived index persisted into the JSON.
    let c = Connection::open(dir.authority()).unwrap();
    let stored: Vec<u8> = c
        .query_row("SELECT payload FROM state_snapshot", [], |r| r.get(0))
        .unwrap();
    assert_eq!(stored, original);
    assert!(!serde_json::from_slice::<serde_json::Value>(&stored)
        .unwrap()
        .as_object()
        .unwrap()
        .contains_key("occupancy"));
    drop(a);
    c.execute_batch("DROP INDEX authority_tasks_pending")
        .unwrap();
    let mut a = DurableAuthority::open(dir.authority()).unwrap();
    assert_eq!(a.authority().unwrap().occupancy(AdmissionScopeId(30)), 1);
    a.finish_other(AdmissionScopeId(30), "historical-other".into())
        .unwrap();
    a.set_ready(AdmissionScopeId(30), false).unwrap();
    assert!(a
        .accept_other(AdmissionScopeId(30), "blocked".into())
        .is_err());
    a.set_ready(AdmissionScopeId(30), true).unwrap();
    a.accept_other(AdmissionScopeId(30), "new-other".into())
        .unwrap();
    let expected = bytes(a.authority().unwrap());
    assert_eq!(
        c.query_row("SELECT revision FROM state_snapshot", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
    drop(a);
    let a = DurableAuthority::open(dir.authority()).unwrap();
    assert_eq!(bytes(a.authority().unwrap()), expected);
    assert_eq!(a.authority().unwrap().occupancy(AdmissionScopeId(30)), 1);
}

#[test]
fn authority_read_transaction_stays_on_original_revision() {
    let dir = Dir::new();
    let (_market, mut a, _, _) = setup(&dir);
    a.set_ready(AdmissionScopeId(30), false).unwrap();
    let mut c = Connection::open(dir.authority()).unwrap();
    let tx = c.transaction().unwrap();
    let original = bytes(&DurableAuthority::read_committed_in(&tx).unwrap());
    a.set_ready(AdmissionScopeId(30), true).unwrap();
    assert_eq!(
        bytes(&DurableAuthority::read_committed_in(&tx).unwrap()),
        original
    );
    tx.commit().unwrap();
    assert_eq!(
        bytes(&DurableAuthority::read_committed(dir.authority()).unwrap()),
        bytes(a.authority().unwrap())
    );
}

#[test]
fn authority_incremental_crash_worker() {
    let Some(path) = std::env::var_os("AUTHORITY_INCREMENTAL_CRASH_DIR") else {
        return;
    };
    let dir = Dir(path.into());
    // The parent already created an accepted task and a checkpoint. Every
    // worker action therefore crashes on a genuine checkpoint tail.
    let mut a = DurableAuthority::open(dir.authority()).unwrap();
    let attempt = a
        .authority()
        .unwrap()
        .attempts()
        .keys()
        .next()
        .unwrap()
        .clone();
    let now = a
        .authority()
        .unwrap()
        .effect_reports()
        .next()
        .unwrap()
        .produced_at;
    match std::env::var("AUTHORITY_INCREMENTAL_CRASH_ACTION")
        .unwrap()
        .as_str()
    {
        "before" => {
            a.set_failpoint(Some(FaultPoint::AuthorityBeforeCommit));
            a.set_ready(AdmissionScopeId(30), false).unwrap();
        }
        "after" => {
            a.set_failpoint(Some(FaultPoint::AuthorityAfterCommit));
            a.set_ready(AdmissionScopeId(30), false).unwrap();
        }
        "dispatch" => {
            a.set_failpoint(Some(FaultPoint::StartDispatched));
            a.start_attempt(&attempt.0, &attempt.1, now).unwrap();
        }
        "start" => {
            a.set_failpoint(Some(FaultPoint::SchedulerStarted));
            a.start_attempt(&attempt.0, &attempt.1, now).unwrap();
        }
        "first" => {
            a.start_attempt(&attempt.0, &attempt.1, now).unwrap();
            a.set_failpoint(Some(FaultPoint::SchedulerFirstResponse));
            a.first_response(&attempt.0, &attempt.1, now).unwrap();
        }
        "finish" => {
            a.start_attempt(&attempt.0, &attempt.1, now).unwrap();
            a.set_failpoint(Some(FaultPoint::SchedulerCompleted));
            a.finish(
                &attempt.0,
                &attempt.1,
                ExecutionOutcome::Completed,
                Some(fixture::usage()),
                now,
            )
            .unwrap();
        }
        _ => panic!("unknown action"),
    }
    panic!("crash not reached");
}

#[test]
fn checkpoint_tail_crashes_preserve_raw_scheduler_markers_and_single_start() {
    for action in ["before", "after", "dispatch", "start", "first", "finish"] {
        let dir = Dir::new();
        let (market, mut a, submit, now) = setup(&dir);
        let original = bytes(&a.handle(&submit, now).unwrap());
        drop(a);
        drop(market);
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "authority_incremental_crash_worker",
                "--nocapture",
            ])
            .env("AUTHORITY_INCREMENTAL_CRASH_DIR", &dir.0)
            .env("AUTHORITY_INCREMENTAL_CRASH_ACTION", action)
            .status()
            .unwrap();
        assert_eq!(status.code(), Some(86), "{action}");
        let c = Connection::open(dir.authority()).unwrap();
        let marker: (i64, i64) = c
            .query_row("SELECT phase,starts FROM tasks", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        let fence: i64 = c
            .query_row("SELECT fence FROM metadata", [], |r| r.get(0))
            .unwrap();
        let view = DurableAuthority::read_committed(dir.authority()).unwrap();
        // Reading must leave the scheduler observation ahead of committed
        // reports until the writer explicitly performs reconciliation.
        assert_eq!(
            c.query_row("SELECT phase,starts FROM tasks", [], |r| Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, i64>(1)?
            )))
            .unwrap(),
            marker
        );
        assert_eq!(
            c.query_row("SELECT fence FROM metadata", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            fence
        );
        if action == "start" {
            assert!(matches!(
                view.attempts().values().next().unwrap().state,
                ExecutionReportState::Accepted { .. }
            ));
        }
        let mut a = DurableAuthority::open(dir.authority()).unwrap();
        assert_eq!(bytes(&a.handle(&submit, now).unwrap()), original);
        if action != "finish" {
            a.start_attempt(&submit.binding.exchange_id, &submit.binding.attempt_id, now)
                .unwrap();
        }
        assert_eq!(
            a.task_start_count(&submit.binding.exchange_id, &submit.binding.attempt_id)
                .unwrap(),
            1
        );
        assert_eq!(
            a.authority().unwrap().occupancy(AdmissionScopeId(30)),
            usize::from(action != "finish")
        );
        if action == "finish" {
            assert!(matches!(
                a.authority()
                    .unwrap()
                    .attempts()
                    .values()
                    .next()
                    .unwrap()
                    .state,
                ExecutionReportState::Terminal { .. }
            ));
        }
        if action == "first" {
            assert_eq!(
                a.authority()
                    .unwrap()
                    .attempts()
                    .values()
                    .next()
                    .unwrap()
                    .milestones
                    .as_ref()
                    .unwrap()
                    .first_response_at,
                Some(now)
            );
        }
    }
}

#[test]
fn changed_report_with_recomputed_chain_is_rejected_in_authority_tail() {
    use sha2::{Digest, Sha256};
    let hash = |v: &[u8]| format!("{:x}", Sha256::digest(v));
    let dir = Dir::new();
    let (_market, mut a, submit, now) = setup(&dir);
    a.handle(&submit, now).unwrap();
    let mut query = submit.clone();
    query.kind = ExecutionRequestKind::Query;
    query.effect_id = EffectId::new("query-for-corruption".into()).unwrap();
    a.handle(&query, now).unwrap();
    drop(a);
    let c = Connection::open(dir.authority()).unwrap();
    let (payload, previous): (Vec<u8>, String) = c
        .query_row(
            "SELECT payload,previous_hash FROM events WHERE seq=2",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    let mut event: serde_json::Value = serde_json::from_slice(&payload).unwrap();
    event["operation"]["Handle"]["report"]["source_sequence"] = 999.into();
    let payload = bytes(&event);
    let mut bound = previous.into_bytes();
    bound.push(0);
    bound.extend_from_slice(&payload);
    let event_hash = hash(&bound);
    c.execute(
        "UPDATE events SET payload=?,checksum=?,event_hash=? WHERE seq=2",
        rusqlite::params![payload, hash(&payload), event_hash],
    )
    .unwrap();
    c.execute("UPDATE metadata SET head_hash=?", [event_hash])
        .unwrap();
    assert!(DurableAuthority::read_committed(dir.authority()).is_err());
    assert!(DurableAuthority::open(dir.authority()).is_err());
}

#[test]
fn authority_fence_precedes_duplicate_effects_and_scheduler_facts() {
    let dir = Dir::new();
    let (_market, mut a, submit, now) = setup(&dir);
    a.handle(&submit, now).unwrap();
    let c = Connection::open(dir.authority()).unwrap();
    c.execute("UPDATE metadata SET fence=fence+1", []).unwrap();
    assert!(matches!(a.handle(&submit, now), Err(DurableError::Fenced)));
    assert!(matches!(
        a.start_attempt(&submit.binding.exchange_id, &submit.binding.attempt_id, now),
        Err(DurableError::Fenced)
    ));
    assert!(matches!(
        a.set_ready(AdmissionScopeId(30), false),
        Err(DurableError::Fenced)
    ));
    assert!(matches!(
        a.task_start_count(&submit.binding.exchange_id, &submit.binding.attempt_id),
        Err(DurableError::Fenced)
    ));
    assert_eq!(
        c.query_row("SELECT starts FROM tasks", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        c.query_row("SELECT count(*) FROM events", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );
}

#[test]
fn failed_running_publication_poisoning_keeps_original_scheduler_start_for_recovery() {
    let dir = Dir::new();
    let (_market, mut a, submit, now) = setup(&dir);
    let original = bytes(&a.handle(&submit, now).unwrap());
    let c = Connection::open(dir.authority()).unwrap();
    c.execute_batch("CREATE TRIGGER reject_authority_publication BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT,'publication failure'); END;").unwrap();
    assert!(a
        .start_attempt(&submit.binding.exchange_id, &submit.binding.attempt_id, now)
        .is_err());
    assert!(matches!(a.authority(), Err(DurableError::Poisoned)));
    assert!(matches!(
        a.handle(&submit, now),
        Err(DurableError::Poisoned)
    ));
    let committed = DurableAuthority::read_committed(dir.authority()).unwrap();
    assert!(matches!(
        committed.attempts().values().next().unwrap().state,
        ExecutionReportState::Accepted { .. }
    ));
    assert_eq!(
        c.query_row("SELECT phase,starts FROM tasks", [], |r| Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, i64>(1)?
        )))
        .unwrap(),
        (2, 1)
    );
    drop(a);
    c.execute_batch("DROP TRIGGER reject_authority_publication")
        .unwrap();
    let mut a = DurableAuthority::open(dir.authority()).unwrap();
    assert!(matches!(
        a.authority()
            .unwrap()
            .attempts()
            .values()
            .next()
            .unwrap()
            .state,
        ExecutionReportState::Running { .. }
    ));
    assert_eq!(bytes(&a.handle(&submit, now).unwrap()), original);
    a.start_attempt(&submit.binding.exchange_id, &submit.binding.attempt_id, now)
        .unwrap();
    assert_eq!(
        a.task_start_count(&submit.binding.exchange_id, &submit.binding.attempt_id)
            .unwrap(),
        1
    );
}
