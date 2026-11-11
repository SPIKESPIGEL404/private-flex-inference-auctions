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

use bitrouter_market::{
    admission::ReportAuthorityId,
    durable::*,
    exchange::ExchangeCommand,
    execution_contract::*,
    order::{MicroUsd, UnixMillis},
};
use std::path::PathBuf;
fn digest(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(bytes))
}
struct Dir(PathBuf);
impl Dir {
    fn new() -> Self {
        static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let p = std::env::temp_dir().join(format!(
            "execution-ingress-{}-{}-{}",
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
fn setup(dir: &Dir) -> (DurableMarketHost, DurableAuthority) {
    let (h, a, _) = cf::setup(false);
    let mut m = DurableMarketHost::create(dir.market(), cf::bootstrap()).unwrap();
    for (k, c) in h.journal().commands() {
        m.execute(k.clone(), c.clone()).unwrap();
    }
    let a = DurableAuthority::create(dir.authority(), a, m.resolver()).unwrap();
    (m, a)
}
fn accepted(m: &mut DurableMarketHost, a: &mut DurableAuthority) -> ExecutionReport {
    let now = m.host().unwrap().snapshot().now();
    let request = m
        .claim_execution(a.authority().unwrap().origin())
        .unwrap()
        .unwrap();
    a.handle(&request, now).unwrap()
}

#[test]
fn claims_preserve_binding_and_recover_only_original_query_or_fence() {
    let dir = Dir::new();
    let (mut m, mut a) = setup(&dir);
    let origin = a.authority().unwrap().origin();
    assert!(m
        .claim_execution((ReportAuthorityId(999), 4))
        .unwrap()
        .is_none());
    let submit = m.claim_execution(origin).unwrap().unwrap();
    assert_eq!(submit.kind, ExecutionRequestKind::Submit);
    assert!(m.claim_execution(origin).unwrap().is_none());
    let s = m.host().unwrap().snapshot();
    let now = s.now();
    assert!(s.purchase_trades().unwrap()[&submit.binding.attempt_id].unknown);
    drop(m);
    let mut m = DurableMarketHost::open(dir.market()).unwrap();
    assert!(m.claim_execution(origin).unwrap().is_none());
    m.execute(
        "query-time".into(),
        ExchangeCommand::AdvanceTime(UnixMillis(now.0 + 20)),
    )
    .unwrap();
    let query = m.claim_execution(origin).unwrap().unwrap();
    assert_eq!(query.kind, ExecutionRequestKind::Query);
    assert_eq!(query.binding, submit.binding);
    assert_ne!(query.effect_id, submit.effect_id);
    let report = a.handle(&query, UnixMillis(now.0 + 20)).unwrap();
    assert!(matches!(
        report.observation,
        ExecutionReportState::NotFound {}
    ));
    m.record_execution_report("not-found", origin, &serde_json::to_vec(&report).unwrap())
        .unwrap();
    assert!(
        m.host().unwrap().snapshot().purchase_trades().unwrap()[&submit.binding.attempt_id].unknown
    );
    assert_eq!(
        m.host().unwrap().snapshot().accounts()[&1].held(),
        MicroUsd(100)
    );
    m.execute(
        "fence-time".into(),
        ExchangeCommand::AdvanceTime(submit.binding.accept_before),
    )
    .unwrap();
    let fence = m.claim_execution(origin).unwrap().unwrap();
    assert_eq!(fence.kind, ExecutionRequestKind::FenceUnaccepted);
    assert_eq!(fence.binding, submit.binding);
}

#[test]
fn report_receipts_bind_bytes_preserve_original_disposition_and_survive_reopen() {
    let dir = Dir::new();
    let (mut m, mut a) = setup(&dir);
    let report = accepted(&mut m, &mut a);
    let origin = a.authority().unwrap().origin();
    let bytes = serde_json::to_vec(&report).unwrap();
    let first = m
        .record_execution_report("accepted", origin, &bytes)
        .unwrap();
    assert_eq!(first.disposition, ReportDisposition::Applied);
    assert_eq!(
        m.record_execution_report("accepted", origin, &bytes)
            .unwrap(),
        first
    );
    assert_eq!(m.inbox_counts().unwrap(), (0, 1, 0));
    let duplicate = m
        .record_execution_report("another-key", origin, &bytes)
        .unwrap();
    assert_eq!(duplicate.disposition, ReportDisposition::Duplicate);
    assert!(matches!(
        m.record_execution_report("accepted", origin, b"different"),
        Err(ReportRecordError::KeyConflict)
    ));
    assert_eq!(m.inbox_counts().unwrap(), (0, 2, 0));
    drop(m);
    let mut m = DurableMarketHost::open(dir.market()).unwrap();
    assert_eq!(
        m.execution_report_receipt("accepted", origin).unwrap(),
        Some(first.clone())
    );
    assert_eq!(
        m.record_execution_report("accepted", origin, &bytes)
            .unwrap(),
        first
    );
    assert_eq!(
        m.execution_report_receipt("another-key", origin).unwrap(),
        Some(duplicate)
    );
    let db = rusqlite::Connection::open(dir.market()).unwrap();
    assert_eq!(
        db.query_row("SELECT version FROM metadata", [], |r| r.get::<_, u32>(0))
            .unwrap(),
        6
    );
}

#[test]
fn malformed_conflicting_and_foreign_evidence_is_retained_without_releasing_holds() {
    let dir = Dir::new();
    let (mut m, mut a) = setup(&dir);
    let report = accepted(&mut m, &mut a);
    let origin = a.authority().unwrap().origin();
    let rejected = m
        .record_execution_report("malformed", origin, b"not-json")
        .unwrap();
    assert!(matches!(
        rejected.disposition,
        ReportDisposition::Rejected { .. }
    ));
    assert_eq!(
        m.record_execution_report("malformed", origin, b"not-json")
            .unwrap(),
        rejected
    );
    let bytes = serde_json::to_vec(&report).unwrap();
    let foreign = m
        .record_execution_report("same-key", (ReportAuthorityId(999), 4), &bytes)
        .unwrap();
    assert!(matches!(
        foreign.disposition,
        ReportDisposition::Rejected { .. }
    ));
    assert_eq!(
        m.host().unwrap().snapshot().accounts()[&1].held(),
        MicroUsd(100)
    );
    assert_eq!(
        m.record_execution_report("same-key", origin, &bytes)
            .unwrap()
            .disposition,
        ReportDisposition::Applied
    );
    let mut conflict = report.clone();
    conflict.produced_at.0 += 1;
    m.execute(
        "one-ms".into(),
        ExchangeCommand::AdvanceTime(conflict.produced_at),
    )
    .unwrap();
    let receipt = m
        .record_execution_report(
            "sequence-conflict",
            origin,
            &serde_json::to_vec(&conflict).unwrap(),
        )
        .unwrap();
    assert!(matches!(
        receipt.disposition,
        ReportDisposition::Rejected { .. }
    ));
    drop(m);
    let m = DurableMarketHost::open(dir.market()).unwrap();
    assert_eq!(
        m.execution_report_receipt("malformed", origin).unwrap(),
        Some(rejected)
    );
    assert_eq!(
        m.execution_report_receipt("sequence-conflict", origin)
            .unwrap(),
        Some(receipt)
    );
}

#[test]
fn sql_commit_failure_is_not_a_rejection_and_pending_report_replays_after_recovery() {
    let dir = Dir::new();
    let (mut m, mut a) = setup(&dir);
    let report = accepted(&mut m, &mut a);
    let origin = a.authority().unwrap().origin();
    let bytes = serde_json::to_vec(&report).unwrap();
    let db = rusqlite::Connection::open(dir.market()).unwrap();
    db.execute_batch("CREATE TRIGGER abort_report BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT,'report test fault'); END;").unwrap();
    assert!(matches!(
        m.record_execution_report("report", origin, &bytes),
        Err(ReportRecordError::Storage(_))
    ));
    assert!(matches!(m.host(), Err(DurableError::Poisoned)));
    drop(m);
    db.execute_batch("DROP TRIGGER abort_report").unwrap();
    drop(db);
    let mut m = DurableMarketHost::open(dir.market()).unwrap();
    let old = m
        .execution_report_receipt("report", origin)
        .unwrap()
        .unwrap();
    assert_eq!(old.disposition, ReportDisposition::Applied);
    assert_eq!(
        m.record_execution_report("report", origin, &bytes).unwrap(),
        old
    );
    assert_eq!(m.inbox_counts().unwrap(), (0, 1, 0));
}

#[test]
fn ingress_crash_worker() {
    let Some(path) = std::env::var_os("MARKET_INGRESS_CRASH_DIR") else {
        return;
    };
    let dir = Dir(path.into());
    let (mut m, mut a) = setup(&dir);
    let fault = std::env::var("MARKET_INGRESS_CRASH_FAULT").unwrap();
    if fault == "marker" {
        m.set_failpoint(Some(FaultPoint::AfterSendMarker));
        m.claim_execution(a.authority().unwrap().origin()).unwrap();
    } else {
        let report = accepted(&mut m, &mut a);
        m.set_failpoint(Some(match fault.as_str() {
            "inbox" => FaultPoint::InboxStored,
            "before" => FaultPoint::ReportBeforeCommit,
            "after" => FaultPoint::ReportAfterCommit,
            _ => panic!(),
        }));
        m.record_execution_report(
            "original-report",
            a.authority().unwrap().origin(),
            &serde_json::to_vec(&report).unwrap(),
        )
        .unwrap();
    }
    panic!("crash point not reached");
}

#[test]
fn process_crashes_keep_send_markers_and_report_receipts_without_replaying_submit() {
    for fault in ["marker", "inbox", "before", "after"] {
        let dir = Dir::new();
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "ingress_crash_worker", "--nocapture"])
            .env("MARKET_INGRESS_CRASH_DIR", &dir.0)
            .env("MARKET_INGRESS_CRASH_FAULT", fault)
            .output()
            .unwrap();
        assert_eq!(
            output.status.code(),
            Some(86),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let mut m = DurableMarketHost::open(dir.market()).unwrap();
        let a = DurableAuthority::open(dir.authority()).unwrap();
        let origin = a.authority().unwrap().origin();
        assert!(m.claim_execution(origin).unwrap().is_none());
        let s = m.host().unwrap().snapshot();
        assert_eq!(
            s.execution_requests()
                .unwrap()
                .values()
                .filter(|r| r.kind == ExecutionRequestKind::Submit)
                .count(),
            1
        );
        if fault == "marker" {
            assert!(m
                .execution_report_receipt("original-report", origin)
                .unwrap()
                .is_none());
            assert_eq!(s.accounts()[&1].held(), MicroUsd(100));
        } else {
            let receipt = m
                .execution_report_receipt("original-report", origin)
                .unwrap()
                .unwrap();
            let report = m.host().unwrap().raw_reports()[0].report.clone();
            assert_eq!(
                m.record_execution_report(
                    "original-report",
                    origin,
                    &serde_json::to_vec(&report).unwrap()
                )
                .unwrap(),
                receipt
            );
        }
    }
}

#[test]
fn semantic_duplicates_compare_reports_while_submission_keys_bind_exact_bytes() {
    let dir = Dir::new();
    let (mut m, mut a) = setup(&dir);
    let report = accepted(&mut m, &mut a);
    let origin = a.authority().unwrap().origin();
    let bytes = serde_json::to_vec(&report).unwrap();
    let pretty = serde_json::to_vec_pretty(&report).unwrap();
    let original = m.record_execution_report("first", origin, &bytes).unwrap();
    let duplicate = m
        .record_execution_report("pretty", origin, &pretty)
        .unwrap();
    assert_eq!(duplicate.disposition, ReportDisposition::Duplicate);
    assert!(matches!(
        m.record_execution_report("first", origin, &pretty),
        Err(ReportRecordError::KeyConflict)
    ));
    drop(m);
    let m = DurableMarketHost::open(dir.market()).unwrap();
    assert_eq!(
        m.execution_report_receipt("first", origin).unwrap(),
        Some(original)
    );
    assert_eq!(
        m.execution_report_receipt("pretty", origin).unwrap(),
        Some(duplicate)
    );
}

#[test]
fn old_inbox_without_indexes_rebuilds_original_receipts_and_pending_rows() {
    let dir = Dir::new();
    let (mut m, mut a) = setup(&dir);
    let report = accepted(&mut m, &mut a);
    let origin = a.authority().unwrap().origin();
    let bytes = serde_json::to_vec(&report).unwrap();
    drop(m);
    let db = rusqlite::Connection::open(dir.market()).unwrap();
    db.execute_batch("DROP INDEX inbox_submission; DROP INDEX inbox_pending;")
        .unwrap();
    let key = format!(
        "runtime/report/{}",
        digest(&serde_json::to_vec(&(origin, "legacy")).unwrap())
    );
    db.execute("INSERT INTO inbox(command_key,authority,epoch,payload,checksum,status) VALUES(?,?,?,?,?,0)",
        rusqlite::params![key, origin.0.0.to_string(), origin.1.to_string(), bytes,
            digest(&bytes)]).unwrap();
    let mut m = DurableMarketHost::open(dir.market()).unwrap();
    let original = m
        .execution_report_receipt("legacy", origin)
        .unwrap()
        .unwrap();
    assert_eq!(original.disposition, ReportDisposition::Applied);
    // Legacy receive_raw can retain repeated same-key rows. Query the earliest
    // resolved submission and its original revision, even after later commits.
    let now = m.host().unwrap().snapshot_ref().now();
    m.execute(
        "later".into(),
        ExchangeCommand::AdvanceTime(UnixMillis(now.0 + 1)),
    )
    .unwrap();
    m.receive_raw(key, origin, &serde_json::to_vec_pretty(&report).unwrap())
        .unwrap();
    assert_eq!(
        m.execution_report_receipt("legacy", origin).unwrap(),
        Some(original.clone())
    );
    assert_eq!(
        m.record_execution_report("new-key", origin, &bytes)
            .unwrap()
            .disposition,
        ReportDisposition::Duplicate
    );
    drop(m);
    db.execute_batch("DROP INDEX inbox_submission; DROP INDEX inbox_pending;")
        .unwrap();
    let m = DurableMarketHost::open(dir.market()).unwrap();
    assert_eq!(
        m.execution_report_receipt("legacy", origin).unwrap(),
        Some(original)
    );
    // EXPLAIN can use a connection's cached schema from before the owner
    // recreated the indexes. Inspect the migrated database on a new connection.
    drop(db);
    let db = rusqlite::Connection::open(dir.market()).unwrap();
    for (sql, expected) in [
        ("EXPLAIN QUERY PLAN SELECT id FROM inbox WHERE authority='77' AND epoch='1' AND command_key='key' ORDER BY id LIMIT 1", "inbox_submission"),
        ("EXPLAIN QUERY PLAN SELECT id FROM inbox WHERE status=0 AND id<100 ORDER BY id LIMIT 1", "inbox_pending"),
    ] {
        let plan: String = db.query_row(sql, [], |r| r.get(3)).unwrap();
        assert!(plan.contains(expected), "{plan}");
    }
}

#[test]
fn receipt_lookup_detects_direct_row_and_committed_event_corruption() {
    for mutation in [
        "payload",
        "status",
        "revision",
        "key",
        "authority",
        "epoch",
        "delete",
        "event",
    ] {
        let dir = Dir::new();
        let (mut m, mut a) = setup(&dir);
        let report = accepted(&mut m, &mut a);
        let origin = a.authority().unwrap().origin();
        let original = m
            .record_execution_report("target", origin, &serde_json::to_vec(&report).unwrap())
            .unwrap();
        // Keep a later event so a forged but existing revision still fails.
        let now = m.host().unwrap().snapshot_ref().now();
        m.execute(
            "later".into(),
            ExchangeCommand::AdvanceTime(UnixMillis(now.0 + 1)),
        )
        .unwrap();
        let db = rusqlite::Connection::open(dir.market()).unwrap();
        match mutation {
            "payload" => {
                let bytes = serde_json::to_vec_pretty(&report).unwrap();
                db.execute(
                    "UPDATE inbox SET payload=?,checksum=? WHERE id=?",
                    rusqlite::params![bytes, digest(&bytes), original.inbox_id],
                )
                .unwrap();
            }
            "status" => {
                db.execute(
                    "UPDATE inbox SET status=2,domain_seq=NULL,reason='forged' WHERE id=?",
                    [original.inbox_id],
                )
                .unwrap();
            }
            "revision" => {
                db.execute(
                    "UPDATE inbox SET domain_seq=(SELECT head FROM metadata) WHERE id=?",
                    [original.inbox_id],
                )
                .unwrap();
            }
            "key" => {
                db.execute(
                    "UPDATE inbox SET command_key='forged' WHERE id=?",
                    [original.inbox_id],
                )
                .unwrap();
            }
            "authority" => {
                db.execute(
                    "UPDATE inbox SET authority='999' WHERE id=?",
                    [original.inbox_id],
                )
                .unwrap();
            }
            "epoch" => {
                db.execute(
                    "UPDATE inbox SET epoch='999' WHERE id=?",
                    [original.inbox_id],
                )
                .unwrap();
            }
            "delete" => {
                db.execute("DELETE FROM inbox WHERE id=?", [original.inbox_id])
                    .unwrap();
            }
            "event" => {
                let bytes: Vec<u8> = db
                    .query_row(
                        "SELECT payload FROM events WHERE seq=?",
                        [original.committed_revision.unwrap()],
                        |r| r.get(0),
                    )
                    .unwrap();
                let mut event: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
                event["record"]["idempotency_key"] = "forged".into();
                let bytes = serde_json::to_vec(&event).unwrap();
                db.execute(
                    "UPDATE events SET payload=?,checksum=? WHERE seq=?",
                    rusqlite::params![bytes, digest(&bytes), original.committed_revision.unwrap()],
                )
                .unwrap();
            }
            _ => unreachable!(),
        }
        assert!(
            matches!(
                m.execution_report_receipt("target", origin),
                Err(ReportRecordError::Storage(DurableError::Corrupt(_)))
            ),
            "{mutation}"
        );
        assert!(
            matches!(
                m.record_execution_report("target", origin, &serde_json::to_vec(&report).unwrap()),
                Err(ReportRecordError::Storage(DurableError::Corrupt(_)))
            ),
            "{mutation}"
        );
    }
}

#[test]
fn duplicate_receipt_checks_original_report_but_unrelated_corruption_waits_for_audit() {
    let dir = Dir::new();
    let (mut m, mut a) = setup(&dir);
    let report = accepted(&mut m, &mut a);
    let origin = a.authority().unwrap().origin();
    let bytes = serde_json::to_vec(&report).unwrap();
    let first = m.record_execution_report("first", origin, &bytes).unwrap();
    let duplicate = m
        .record_execution_report("duplicate", origin, &bytes)
        .unwrap();
    let unrelated = m
        .record_execution_report("unrelated", origin, b"not-json")
        .unwrap();
    let db = rusqlite::Connection::open(dir.market()).unwrap();
    db.execute(
        "UPDATE inbox SET checksum='broken' WHERE id=?",
        [unrelated.inbox_id],
    )
    .unwrap();
    assert_eq!(
        m.execution_report_receipt("first", origin).unwrap(),
        Some(first.clone())
    );
    assert_eq!(
        m.execution_report_receipt("duplicate", origin).unwrap(),
        Some(duplicate)
    );
    // An unrelated damaged rejected row must not force a global scan on ingest.
    let next = m.record_execution_report("next", origin, &bytes).unwrap();
    assert_eq!(next.disposition, ReportDisposition::Duplicate);
    assert!(matches!(m.inbox_counts(), Err(DurableError::Corrupt(_))));
    db.execute(
        "UPDATE inbox SET checksum='broken' WHERE id=?",
        [first.inbox_id],
    )
    .unwrap();
    assert!(matches!(
        m.execution_report_receipt("duplicate", origin),
        Err(ReportRecordError::Storage(DurableError::Corrupt(_)))
    ));
    drop(m);
    assert!(matches!(
        DurableMarketHost::open(dir.market()),
        Err(DurableError::Corrupt(_))
    ));
}

#[test]
fn rejected_receipt_metadata_and_earlier_pending_rows_cannot_be_ignored() {
    let dir = Dir::new();
    let (mut m, mut a) = setup(&dir);
    let report = accepted(&mut m, &mut a);
    let origin = a.authority().unwrap().origin();
    let rejected = m
        .record_execution_report("rejected", origin, b"invalid")
        .unwrap();
    let later = m
        .record_execution_report("later", origin, &serde_json::to_vec(&report).unwrap())
        .unwrap();
    let db = rusqlite::Connection::open(dir.market()).unwrap();
    db.execute(
        "UPDATE inbox SET reason='forged' WHERE id=?",
        [rejected.inbox_id],
    )
    .unwrap();
    assert!(matches!(
        m.execution_report_receipt("rejected", origin),
        Err(ReportRecordError::Storage(DurableError::Corrupt(_)))
    ));
    db.execute(
        "UPDATE inbox SET status=0,reason=NULL WHERE id=?",
        [rejected.inbox_id],
    )
    .unwrap();
    assert!(matches!(
        m.execution_report_receipt("later", origin),
        Err(ReportRecordError::Storage(DurableError::Corrupt(
            "earlier report processing is unresolved"
        )))
    ));
    assert_eq!(later.disposition, ReportDisposition::Applied);
}

#[test]
fn legacy_raw_rejection_does_not_hide_a_later_committed_command_with_the_same_key() {
    let dir = Dir::new();
    let (mut m, mut a) = setup(&dir);
    let report = accepted(&mut m, &mut a);
    let origin = a.authority().unwrap().origin();
    let bytes = serde_json::to_vec(&report).unwrap();
    assert!(matches!(
        m.receive_raw("raw-key".into(), origin, b"not-json"),
        Err(DurableError::Codec(_))
    ));
    let receipt = m.receive_raw("raw-key".into(), origin, &bytes).unwrap();
    assert_eq!(
        m.receive_raw("raw-key".into(), origin, &bytes).unwrap(),
        receipt
    );
    assert_eq!(m.inbox_counts().unwrap(), (0, 2, 1));
    drop(m);
    let mut m = DurableMarketHost::open(dir.market()).unwrap();
    assert_eq!(
        m.receive_raw("raw-key".into(), origin, &bytes).unwrap(),
        receipt
    );
    assert_eq!(m.inbox_counts().unwrap(), (0, 3, 1));
}
