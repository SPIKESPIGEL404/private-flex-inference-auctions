mod common;
#[path = "common/http.rs"]
mod http;
use common::*;
use flex_scheduler::*;
use http::{MockServer, Script, choice, frame, success, usage};
use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    io::{Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

fn policy() -> SpoolPolicy {
    SpoolPolicy {
        acknowledged_retention_ms: 100,
        max_artifact_bytes: 4096,
        max_physical_bytes: 32768,
        max_owner_physical_bytes: 16384,
    }
}

#[derive(Default)]
struct Fault(Mutex<Option<(SpoolOperation, u64)>>);
impl Fault {
    fn arm(&self, op: SpoolOperation, nth: u64) {
        *self.0.lock().unwrap() = Some((op, nth));
    }
}
impl SpoolFaults for Fault {
    fn before(&self, op: SpoolOperation) -> std::io::Result<()> {
        let mut f = self.0.lock().unwrap();
        if let Some((target, left)) = f.as_mut()
            && *target == op
        {
            *left -= 1;
            if *left == 0 {
                *f = None;
                return Err(std::io::Error::from_raw_os_error(28));
            }
        }
        Ok(())
    }
}
fn core(
    c: SchedulerConfig,
    p: SpoolPolicy,
    count: u32,
    f: Arc<Fault>,
) -> (tempfile::TempDir, PathBuf, Scheduler) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("journal.sqlite");
    let mut s = Scheduler::open_with_spool_and_faults(&path, c, p, f).unwrap();
    s.reconcile_spool("fixture-local-fresh-spool".into())
        .unwrap();
    s.activate(activation("mock-epoch-1")).unwrap();
    s.register(plan(1, GENESIS, count)).unwrap();
    (dir, path, s)
}
fn normal(count: u32) -> (tempfile::TempDir, PathBuf, Scheduler) {
    core(config(), policy(), count, Arc::new(Fault::default()))
}
fn slot(path: &Path, execution: &str) -> PathBuf {
    let mut root = path.as_os_str().to_os_string();
    root.push(".spool");
    PathBuf::from(root).join(format!(
        "{}.slot",
        digest("flex-scheduler/result-slot/v1", &execution).unwrap()
    ))
}
fn view(s: &Scheduler, index: usize) -> ExecutionView {
    s.plan_state("plan-1").unwrap().unwrap().executions[index].clone()
}
fn report(execution: &str, text_bytes: u64) -> StreamReport {
    StreamReport {
        execution_id: execution.into(),
        engine_epoch: "mock-epoch-1".into(),
        response_id: Some(format!("cmpl-{execution}")),
        usage: Some(Usage {
            prompt_tokens: 3,
            completion_tokens: 1,
            total_tokens: 4,
        }),
        protocol: ProtocolStatus::CompleteProtocol,
        generated_tokens: 1,
        wire_bytes: 1000,
        text_bytes,
    }
}
fn complete(s: &mut Scheduler, execution: &str) {
    claim(s);
    s.observe_delta(progress(execution, "mock-epoch-1", 1), "世")
        .unwrap();
    s.observe_delta(terminal(execution, "mock-epoch-1", 2), "")
        .unwrap();
    s.finish_stream(report(execution, 3)).unwrap();
    s.finalize_result(execution).unwrap();
}
fn fail_action(path: &Path, action: &str) {
    let raw = rusqlite::Connection::open(path).unwrap();
    raw.execute_batch(&format!("CREATE TRIGGER fail_phase3 BEFORE INSERT ON journal WHEN NEW.action_json LIKE '%\"action\":\"{action}\"%' BEGIN SELECT RAISE(ABORT, 'injected phase-three commit failure'); END;")).unwrap();
}
fn clear_failure(path: &Path) {
    rusqlite::Connection::open(path)
        .unwrap()
        .execute_batch("DROP TRIGGER fail_phase3")
        .unwrap();
}
fn assert_replay(s: &Scheduler) {
    assert_eq!(s.snapshot().unwrap(), s.replay_snapshot().unwrap());
}

#[test]
fn physical_space_and_binding_exist_before_dispatch_intent_is_returned() {
    let (_dir, path, mut s) = normal(1);
    let intent = claim(&mut s);
    let meta = fs::metadata(slot(&path, "exec-1-1")).unwrap();
    assert_eq!(meta.len(), 4096);
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        assert_eq!(meta.blocks() * 512, 4096);
        assert_eq!(meta.mode() & 0o777, 0o600);
    }
    let cap = s.snapshot().unwrap().capacity;
    assert_eq!(cap.reserved_spool_bytes, 384);
    assert_eq!(cap.physical_spool_bytes, 4096);
    let bytes = fs::read(slot(&path, "exec-1-1")).unwrap();
    assert_eq!(&bytes[..8], b"FLEXR01\n");
    assert_eq!(
        encode_hex(&bytes[8..40]),
        digest("flex-scheduler/result-binding/v1", &intent.binding).unwrap()
    );
    assert_replay(&s);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn http_output_is_durable_and_redacted_events_bind_original_identity() {
    let (_dir, path, mut s) = normal(1);
    let server = MockServer::start(BTreeMap::from([(
        "exec-1-1".into(),
        Script::sse(success("exec-1-1")),
    )]))
    .await;
    let r = MockHttpRunner::new(http::config(&server.endpoint))
        .unwrap()
        .run_until_idle(&mut s)
        .await
        .unwrap();
    assert_eq!(r.streams[0].protocol, ProtocolStatus::CompleteProtocol);
    assert_eq!(server.count(), 1);
    let a = s.get_result_artifact("exec-1-1", "opaque-owner").unwrap();
    assert_eq!(a.text, "世");
    assert_eq!(a.token_ids, [99]);
    assert_eq!(a.metadata.used_bytes, 87);
    assert_eq!(a.binding, view(&s, 0).binding);
    assert_eq!(view(&s, 0).result, ResultState::DurableComplete);
    let es = s.events_after(0, 1000).unwrap();
    let sequence = |kind| es.iter().find(|e| e.kind == kind).unwrap().event_seq;
    assert!(sequence(EventKind::ExecutionTerminal) < sequence(EventKind::StreamFinished));
    assert!(sequence(EventKind::StreamFinished) < sequence(EventKind::ResultDurable));
    let public = serde_json::to_string(&es).unwrap();
    assert!(!public.contains("世"));
    assert!(!public.contains("token_ids"));
    assert_replay(&s);
    drop(s);
    let mut s = Scheduler::open_with_spool(&path, config(), policy()).unwrap();
    assert!(s.activate(activation("mock-epoch-2")).is_err());
    s.reconcile_spool("fixture-reopen-fresh".into()).unwrap();
    assert_eq!(
        s.get_result_artifact("exec-1-1", "opaque-owner")
            .unwrap()
            .text,
        "世"
    );
    assert_eq!(s.snapshot().unwrap().mode, Mode::RecoveryRequired);
    assert_eq!(server.count(), 1);
}

#[test]
fn ack_loss_owner_digest_and_receipt_checks_and_retention_are_idempotent() {
    let (dir, path, mut s) = normal(1);
    complete(&mut s, "exec-1-1");
    assert_eq!(s.collect_results(1_000_000).unwrap(), 0); // no ACK: no age-based eviction
    assert!(matches!(
        s.get_result_artifact("exec-1-1", "other"),
        Err(Error::Unauthorized)
    ));
    let a = s.get_result_artifact("exec-1-1", "opaque-owner").unwrap();
    let sink = dir.path().join("durable-mock-sink.json");
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&sink)
        .unwrap();
    serde_json::to_writer(&file, &a).unwrap();
    file.sync_all().unwrap();
    fs::File::open(dir.path()).unwrap().sync_all().unwrap();
    // Simulated lost ACK: the independent sink is synced, scheduler still owns output.
    drop(s);
    let mut s = Scheduler::open_with_spool(&path, config(), policy()).unwrap();
    s.reconcile_spool("fixture-sink-replay".into()).unwrap();
    assert_eq!(view(&s, 0).result, ResultState::DurableComplete);
    assert!(
        s.ack_result(
            "exec-1-1",
            "wrong-owner",
            &a.metadata.digest,
            "sink-1",
            1000
        )
        .is_err()
    );
    assert!(
        s.ack_result("exec-1-1", "opaque-owner", &"ff".repeat(32), "sink-1", 1000)
            .is_err()
    );
    assert_eq!(
        s.ack_result(
            "exec-1-1",
            "opaque-owner",
            &a.metadata.digest,
            "sink-1",
            1000
        )
        .unwrap(),
        ObservationOutcome::Recorded
    );
    let before = s.events_after(0, 1000).unwrap().len();
    assert_eq!(
        s.ack_result(
            "exec-1-1",
            "opaque-owner",
            &a.metadata.digest,
            "sink-1",
            9000
        )
        .unwrap(),
        ObservationOutcome::AlreadyRecorded
    );
    assert_eq!(s.events_after(0, 1000).unwrap().len(), before);
    assert!(
        s.ack_result(
            "exec-1-1",
            "opaque-owner",
            &a.metadata.digest,
            "different-receipt",
            1001
        )
        .is_err()
    );
    assert_eq!(view(&s, 0).handoff.unwrap().cleanup_after_ms, 1100);
    assert_eq!(s.collect_results(1099).unwrap(), 0);
    assert!(slot(&path, "exec-1-1").exists());
    assert_eq!(s.collect_results(1100).unwrap(), 1);
    assert!(!slot(&path, "exec-1-1").exists());
    assert_eq!(s.snapshot().unwrap().capacity.physical_spool_bytes, 0);
    assert_eq!(s.snapshot().unwrap().capacity.reserved_spool_bytes, 0);
    assert_eq!(s.collect_results(9000).unwrap(), 0);
    assert!(s.get_result_artifact("exec-1-1", "opaque-owner").is_err());
    assert_eq!(
        s.ack_result(
            "exec-1-1",
            "opaque-owner",
            &a.metadata.digest,
            "sink-1",
            9999
        )
        .unwrap(),
        ObservationOutcome::AlreadyRecorded
    );
    let saved: ResultArtifact = serde_json::from_slice(&fs::read(sink).unwrap()).unwrap();
    assert_eq!(saved.text, "世");
    assert_replay(&s);
}

#[test]
fn quotas_hold_unacknowledged_results_and_release_only_after_cleanup() {
    for (mut c, mut p, reason) in [
        (config(), policy(), BlockReason::SpoolCapacity),
        (config(), policy(), BlockReason::OwnerSpoolCapacity),
        (config(), policy(), BlockReason::PhysicalSpoolCapacity),
        (config(), policy(), BlockReason::OwnerPhysicalSpoolCapacity),
    ] {
        match reason {
            BlockReason::SpoolCapacity => {
                c.max_spool_bytes = 384;
                c.max_owner_spool_bytes = 384;
            }
            BlockReason::OwnerSpoolCapacity => c.max_owner_spool_bytes = 384,
            BlockReason::PhysicalSpoolCapacity => {
                p.max_physical_bytes = 4096;
                p.max_owner_physical_bytes = 4096;
            }
            BlockReason::OwnerPhysicalSpoolCapacity => p.max_owner_physical_bytes = 4096,
            _ => unreachable!(),
        }
        let (_dir, path, mut s) = core(c, p, 2, Arc::new(Fault::default()));
        complete(&mut s, "exec-1-1");
        assert_blocked(&mut s, reason.clone());
        let a = view(&s, 0).artifact.unwrap();
        s.ack_result("exec-1-1", "opaque-owner", &a.digest, "sink-1", 1000)
            .unwrap();
        assert_blocked(&mut s, reason);
        s.collect_results(1100).unwrap();
        assert!(!slot(&path, "exec-1-1").exists());
        assert_eq!(claim(&mut s).binding.execution_id, "exec-1-2");
        assert_replay(&s);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stalled_sink_bounds_live_http_spool_without_reposting_existing_requests() {
    let mut p = policy();
    p.max_owner_physical_bytes = 8192;
    let (_dir, _path, mut s) = core(config(), p, 3, Arc::new(Fault::default()));
    let server = MockServer::start(
        (1..=3)
            .map(|i| {
                let e = format!("exec-1-{i}");
                (e.clone(), Script::sse(success(&e)))
            })
            .collect(),
    )
    .await;
    let runner = MockHttpRunner::new(http::config(&server.endpoint)).unwrap();
    let r = runner.run_until_idle(&mut s).await.unwrap();
    assert_eq!(r.dispatch_order, ["exec-1-1", "exec-1-2"]);
    assert_eq!(r.blocked, Some(BlockReason::OwnerPhysicalSpoolCapacity));
    assert_eq!(server.count(), 2);
    assert_eq!(s.collect_results(9_999_999).unwrap(), 0);
    let digest = view(&s, 0).artifact.unwrap().digest;
    s.ack_result("exec-1-1", "opaque-owner", &digest, "sink-1", 100)
        .unwrap();
    s.collect_results(200).unwrap();
    let r = runner.run_until_idle(&mut s).await.unwrap();
    assert_eq!(r.dispatch_order, ["exec-1-3"]);
    assert_eq!(server.count(), 3);
    assert_eq!(s.snapshot().unwrap().capacity.physical_spool_bytes, 8192);
    assert_replay(&s);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn enospc_during_allocation_never_submits_and_reconciliation_removes_orphan() {
    let f = Arc::new(Fault::default());
    let (_dir, path, mut s) = core(config(), policy(), 1, f.clone());
    f.arm(SpoolOperation::Allocate, 1);
    let server = MockServer::start(BTreeMap::from([(
        "exec-1-1".into(),
        Script::sse(success("exec-1-1")),
    )]))
    .await;
    let runner = MockHttpRunner::new(http::config(&server.endpoint)).unwrap();
    assert!(runner.run_until_idle(&mut s).await.is_err());
    assert_eq!(server.count(), 0);
    assert_eq!(view(&s, 0).dispatch, DispatchState::Unsent);
    assert_eq!(s.snapshot().unwrap().mode, Mode::RecoveryRequired);
    assert!(slot(&path, "exec-1-1").exists());
    s.reconcile_spool("fixture-orphan-sweep".into()).unwrap();
    assert!(!slot(&path, "exec-1-1").exists());
    s.activate(activation("mock-epoch-2")).unwrap();
    runner.run_until_idle(&mut s).await.unwrap();
    assert_eq!(server.count(), 1);
    assert_eq!(view(&s, 0).result, ResultState::DurableComplete);
    assert_replay(&s);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn write_failure_and_result_overflow_halt_dispatch_but_drain_terminal_evidence() {
    for overflowing in [false, true] {
        let f = Arc::new(Fault::default());
        let (_dir, path, mut s) = core(config(), policy(), 2, f.clone());
        if !overflowing {
            f.arm(SpoolOperation::Write, 1);
        }
        let text = if overflowing {
            "x".repeat(360)
        } else {
            "世".into()
        };
        let wire = [
            frame(choice("exec-1-1", vec![99], &text, None)),
            frame(choice("exec-1-1", vec![], "", Some("stop"))),
            frame(usage("exec-1-1", 1)),
            b"data: [DONE]\n\n".to_vec(),
        ]
        .concat();
        let server =
            MockServer::start(BTreeMap::from([("exec-1-1".into(), Script::sse(wire))])).await;
        let r = MockHttpRunner::new(http::config(&server.endpoint))
            .unwrap()
            .run_until_idle(&mut s)
            .await
            .unwrap();
        assert_eq!(server.count(), 1);
        assert_eq!(r.streams[0].protocol, ProtocolStatus::CompleteProtocol);
        assert_eq!(view(&s, 0).dispatch, DispatchState::Terminal);
        assert_eq!(view(&s, 0).result, ResultState::Unavailable);
        assert_eq!(view(&s, 1).dispatch, DispatchState::Unsent);
        assert_eq!(r.final_snapshot.mode, Mode::RecoveryRequired);
        assert_eq!(r.final_snapshot.capacity.inflight_requests, 0);
        assert_eq!(r.final_snapshot.capacity.physical_spool_bytes, 4096);
        assert!(
            !s.events_after(0, 1000)
                .unwrap()
                .iter()
                .any(|e| e.kind == EventKind::ResultDurable)
        );
        s.discard_unavailable_result("exec-1-1", "fixture-notify-upstream-unavailable".into())
            .unwrap();
        assert!(!slot(&path, "exec-1-1").exists());
        assert_replay(&s);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn footer_write_failure_cannot_publish_a_durable_result() {
    for (op, nth) in [(SpoolOperation::Write, 2), (SpoolOperation::SyncFile, 3)] {
        let f = Arc::new(Fault::default());
        let (_dir, _path, mut s) = core(config(), policy(), 1, f.clone());
        f.arm(op, nth);
        let server = MockServer::start(BTreeMap::from([(
            "exec-1-1".into(),
            Script::sse(success("exec-1-1")),
        )]))
        .await;
        MockHttpRunner::new(http::config(&server.endpoint))
            .unwrap()
            .run_until_idle(&mut s)
            .await
            .unwrap();
        assert_eq!(view(&s, 0).result, ResultState::Unavailable);
        assert!(view(&s, 0).artifact.is_none());
        assert_eq!(view(&s, 0).dispatch, DispatchState::Terminal);
        assert_replay(&s);
    }
}

#[test]
fn disk_progress_precedes_gate_and_failed_journal_commit_retains_only_old_prefix() {
    let (_dir, path, mut s) = normal(2);
    claim(&mut s);
    fail_action(&path, "OBSERVED");
    assert!(
        s.observe_delta(progress("exec-1-1", "mock-epoch-1", 1), "世")
            .is_err()
    );
    let bytes = fs::read(slot(&path, "exec-1-1")).unwrap();
    assert_eq!(&bytes[48..51], "世".as_bytes());
    assert!(matches!(s.claim_next(), Err(Error::Poisoned)));
    assert!(matches!(
        s.get_result_artifact("exec-1-1", "opaque-owner"),
        Err(Error::Poisoned)
    ));
    drop(s);
    clear_failure(&path);
    let mut s = Scheduler::open_with_spool(&path, config(), policy()).unwrap();
    assert_eq!(view(&s, 0).generated_tokens, 0);
    assert_eq!(view(&s, 0).gate, GateState::Closed);
    assert_eq!(view(&s, 0).dispatch, DispatchState::Unknown);
    s.reconcile_spool("fixture-uncommitted-tail-ignored".into())
        .unwrap();
    assert!(
        s.discard_unavailable_result("exec-1-1", "unsafe-unknown".into())
            .is_err()
    );
    assert!(s.activate(activation("mock-epoch-2")).is_err());
    s.record_epoch_isolation("mock-epoch-1".into(), "fixture-old-engine-isolated".into())
        .unwrap();
    s.discard_unavailable_result("exec-1-1", "fixture-lost-result".into())
        .unwrap();
    s.activate(activation("mock-epoch-2")).unwrap();
    assert_eq!(claim(&mut s).binding.execution_id, "exec-1-2");
    assert_replay(&s);
}

#[test]
fn physical_reservation_without_committed_intent_is_reaped_on_reopen() {
    let (_dir, path, mut s) = normal(1);
    fail_action(&path, "DISPATCH_INTENDED");
    assert!(s.claim_next().is_err());
    assert!(slot(&path, "exec-1-1").exists());
    drop(s);
    clear_failure(&path);
    let mut s = Scheduler::open_with_spool(&path, config(), policy()).unwrap();
    assert_eq!(view(&s, 0).dispatch, DispatchState::Unsent);
    s.reconcile_spool("fixture-no-intent-no-submit".into())
        .unwrap();
    assert!(!slot(&path, "exec-1-1").exists());
    assert_eq!(s.snapshot().unwrap().capacity.physical_spool_bytes, 0);
    assert_replay(&s);
}

#[test]
fn cleanup_failures_before_delete_or_after_delete_keep_quota_until_recovery_commit() {
    for failure in 0..3 {
        let f = Arc::new(Fault::default());
        let (_dir, path, mut s) = core(config(), policy(), 1, f.clone());
        complete(&mut s, "exec-1-1");
        let digest = view(&s, 0).artifact.unwrap().digest;
        s.ack_result("exec-1-1", "opaque-owner", &digest, "sink-1", 1000)
            .unwrap();
        if failure == 1 {
            fail_action(&path, "RESULT_CLEANED");
        } else if failure == 2 {
            f.arm(SpoolOperation::SyncDirectory, 1);
        } else {
            f.arm(SpoolOperation::Remove, 1);
        }
        assert!(s.collect_results(1100).is_err());
        assert_eq!(slot(&path, "exec-1-1").exists(), failure == 0);
        drop(s);
        if failure == 1 {
            clear_failure(&path);
        }
        let mut s = Scheduler::open_with_spool(&path, config(), policy()).unwrap();
        assert_eq!(s.snapshot().unwrap().capacity.physical_spool_bytes, 4096);
        s.reconcile_spool("fixture-recover-cleanup-intent".into())
            .unwrap();
        assert_eq!(view(&s, 0).cleanup_complete, Some(true));
        assert!(!slot(&path, "exec-1-1").exists());
        assert_eq!(s.snapshot().unwrap().capacity.physical_spool_bytes, 0);
        assert_eq!(s.collect_results(9000).unwrap(), 0);
        assert_replay(&s);
    }
}

#[test]
fn missing_or_corrupt_artifact_is_unavailable_and_preserves_quota_until_explicit_discard() {
    for missing in [false, true] {
        let (_dir, path, mut s) = normal(1);
        complete(&mut s, "exec-1-1");
        drop(s);
        if missing {
            fs::remove_file(slot(&path, "exec-1-1")).unwrap();
        } else {
            let mut f = OpenOptions::new()
                .write(true)
                .open(slot(&path, "exec-1-1"))
                .unwrap();
            f.seek(SeekFrom::Start(48)).unwrap();
            f.write_all(b"bad").unwrap();
            f.sync_all().unwrap();
        }
        let mut s = Scheduler::open_with_spool(&path, config(), policy()).unwrap();
        assert!(
            s.reconcile_spool("fixture-detect-data-loss".into())
                .is_err()
        );
        assert_eq!(view(&s, 0).result, ResultState::Unavailable);
        assert_eq!(s.snapshot().unwrap().capacity.physical_spool_bytes, 4096);
        assert!(s.activate(activation("mock-epoch-2")).is_err());
        s.discard_unavailable_result("exec-1-1", "fixture-unavailable-notified".into())
            .unwrap();
        s.reconcile_spool("fixture-after-discard".into()).unwrap();
        s.activate(activation("mock-epoch-2")).unwrap();
        assert_blocked(&mut s, BlockReason::NoPlan);
        assert_replay(&s);
    }
}

#[test]
fn delta_replay_binds_text_and_invalid_late_data_cannot_modify_finalized_artifact() {
    let (_dir, path, mut s) = normal(1);
    complete(&mut s, "exec-1-1");
    let before = fs::read(slot(&path, "exec-1-1")).unwrap();
    assert_eq!(
        s.observe_delta(progress("exec-1-1", "mock-epoch-1", 1), "世")
            .unwrap(),
        ObservationOutcome::AlreadyRecorded
    );
    assert!(
        s.observe_delta(progress("exec-1-1", "mock-epoch-1", 3), "late")
            .is_err()
    );
    assert_eq!(fs::read(slot(&path, "exec-1-1")).unwrap(), before);
    assert!(matches!(
        s.observe_delta(progress("exec-1-1", "mock-epoch-1", 1), "different"),
        Err(Error::ObservationConflict)
    ));
    assert!(s.snapshot().unwrap().integrity_fault);
    assert_replay(&s);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn incomplete_protocol_needs_explicit_unavailable_closure_before_discard() {
    let (_dir, path, mut s) = normal(1);
    let wire = frame(choice("exec-1-1", vec![99], "世", Some("stop")));
    let server = MockServer::start(BTreeMap::from([("exec-1-1".into(), Script::sse(wire))])).await;
    MockHttpRunner::new(http::config(&server.endpoint))
        .unwrap()
        .run_until_idle(&mut s)
        .await
        .unwrap();
    assert_eq!(view(&s, 0).dispatch, DispatchState::Terminal);
    assert_eq!(view(&s, 0).result, ResultState::Pending);
    assert!(s.finalize_result("exec-1-1").is_err());
    assert_eq!(s.collect_results(9000).unwrap(), 0);
    assert!(
        s.discard_unavailable_result("exec-1-1", "not-yet-unavailable".into())
            .is_err()
    );
    s.declare_result_unavailable("exec-1-1", "fixture-incomplete-protocol-reviewed".into())
        .unwrap();
    s.discard_unavailable_result("exec-1-1", "fixture-result-lost-notified".into())
        .unwrap();
    assert!(!slot(&path, "exec-1-1").exists());
    assert_eq!(server.count(), 1);
    assert_replay(&s);
}

#[test]
fn spool_binding_and_metadata_only_reopen_cannot_bypass_reconciliation() {
    let (_dir, path, s) = normal(1);
    drop(s);
    let mut s = Scheduler::open(&path, config()).unwrap();
    assert!(s.activate(activation("mock-epoch-2")).is_err());
    assert!(s.claim_next().is_err());
    drop(s);
    let mut changed = policy();
    changed.acknowledged_retention_ms += 1;
    assert!(matches!(
        Scheduler::open_with_spool(&path, config(), changed),
        Err(Error::ConfigMismatch)
    ));
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("legacy.sqlite");
    let mut s = Scheduler::open(&path, config()).unwrap();
    s.activate(activation("legacy-epoch")).unwrap();
    s.register(plan(1, GENESIS, 1)).unwrap();
    claim(&mut s);
    drop(s);
    assert!(Scheduler::open_with_spool(&path, config(), policy()).is_err()); // submitted work had no physical slot
}

#[test]
fn process_exit_after_synced_file_before_durable_journal_recovers_without_resubmission() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("crash.sqlite");
    let status = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "phase3_crash_child", "--ignored"])
        .env("FLEX_PHASE3_CRASH_PATH", &path)
        .output()
        .unwrap();
    assert_eq!(
        status.status.code(),
        Some(91),
        "{}",
        String::from_utf8_lossy(&status.stderr)
    );
    clear_failure(&path);
    let mut s = Scheduler::open_with_spool(&path, config(), policy()).unwrap();
    assert_eq!(view(&s, 0).result, ResultState::Pending);
    assert_eq!(view(&s, 0).dispatch, DispatchState::Terminal);
    s.reconcile_spool("fixture-post-crash-freshness".into())
        .unwrap();
    assert_eq!(view(&s, 0).result, ResultState::DurableComplete);
    assert_eq!(
        s.get_result_artifact("exec-1-1", "opaque-owner")
            .unwrap()
            .text,
        "世"
    );
    let events = s.events_after(0, 1000).unwrap();
    assert_eq!(
        events
            .iter()
            .filter(|e| e.kind == EventKind::DispatchIntent)
            .count(),
        1
    );
    assert_eq!(
        events
            .iter()
            .filter(|e| e.kind == EventKind::ResultDurable)
            .count(),
        1
    );
    assert_replay(&s);
}

#[test]
#[ignore = "subprocess-only crash point, invoked by parent acceptance test"]
fn phase3_crash_child() {
    let path = PathBuf::from(std::env::var_os("FLEX_PHASE3_CRASH_PATH").unwrap());
    let mut s = Scheduler::open_with_spool(&path, config(), policy()).unwrap();
    s.reconcile_spool("fixture-new-spool".into()).unwrap();
    s.activate(activation("mock-epoch-1")).unwrap();
    s.register(plan(1, GENESIS, 1)).unwrap();
    claim(&mut s);
    s.observe_delta(progress("exec-1-1", "mock-epoch-1", 1), "世")
        .unwrap();
    s.observe_delta(terminal("exec-1-1", "mock-epoch-1", 2), "")
        .unwrap();
    s.finish_stream(report("exec-1-1", 3)).unwrap();
    fail_action(&path, "RESULT_DURABLE");
    assert!(s.finalize_result("exec-1-1").is_err());
    std::process::exit(91);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn full_multichunk_text_tokens_empty_text_and_zero_output_are_preserved() {
    let (_dir, _path, mut s) = normal(2);
    let wire = [
        frame(choice("exec-1-1", vec![99], "世", None)),
        frame(choice("exec-1-1", vec![99], "", None)),
        frame(choice("exec-1-1", vec![101], "界", Some("length"))),
        frame(usage("exec-1-1", 3)),
        b"data: [DONE]\n\n".to_vec(),
    ]
    .concat();
    let mut script = Script::sse(vec![]);
    script.steps = wire
        .chunks(1)
        .map(|b| http::Step::Bytes(b.to_vec()))
        .collect();
    let zero = [
        frame(choice("exec-1-2", vec![], "", Some("stop"))),
        frame(usage("exec-1-2", 0)),
        b"data: [DONE]\n\n".to_vec(),
    ]
    .concat();
    let server = MockServer::start(BTreeMap::from([
        ("exec-1-1".into(), script),
        ("exec-1-2".into(), Script::sse(zero)),
    ]))
    .await;
    MockHttpRunner::new(http::config(&server.endpoint))
        .unwrap()
        .run_until_idle(&mut s)
        .await
        .unwrap();
    let a = s.get_result_artifact("exec-1-1", "opaque-owner").unwrap();
    assert_eq!(a.text, "世界");
    assert_eq!(a.token_ids, [99, 99, 101]);
    assert_eq!(a.metadata.records, 3);
    assert_eq!(a.metadata.usage.completion_tokens, 3);
    let a = s.get_result_artifact("exec-1-2", "opaque-owner").unwrap();
    assert!(a.text.is_empty());
    assert!(a.token_ids.is_empty());
    assert_eq!(a.metadata.used_bytes, 72);
    assert_eq!(a.metadata.usage.completion_tokens, 0);
    assert_replay(&s);
}

#[test]
fn ack_commit_failure_retains_file_and_original_receipt_can_be_replayed() {
    let (_dir, path, mut s) = normal(1);
    complete(&mut s, "exec-1-1");
    let digest = view(&s, 0).artifact.unwrap().digest;
    fail_action(&path, "RESULT_HANDED_OFF");
    assert!(
        s.ack_result(
            "exec-1-1",
            "opaque-owner",
            &digest,
            "durable-sink-receipt",
            1000
        )
        .is_err()
    );
    assert!(slot(&path, "exec-1-1").exists());
    assert!(matches!(s.collect_results(9000), Err(Error::Poisoned)));
    drop(s);
    clear_failure(&path);
    let mut s = Scheduler::open_with_spool(&path, config(), policy()).unwrap();
    s.reconcile_spool("fixture-ack-retry-no-inference".into())
        .unwrap();
    assert_eq!(view(&s, 0).result, ResultState::DurableComplete);
    assert_eq!(s.snapshot().unwrap().capacity.physical_spool_bytes, 4096);
    assert_eq!(
        s.ack_result(
            "exec-1-1",
            "opaque-owner",
            &digest,
            "durable-sink-receipt",
            2000
        )
        .unwrap(),
        ObservationOutcome::Recorded
    );
    assert_eq!(s.collect_results(2099).unwrap(), 0);
    assert_eq!(s.collect_results(2100).unwrap(), 1);
    assert_replay(&s);
}

#[test]
fn failed_sync_before_intent_and_before_progress_cannot_open_next_gate() {
    for progress_sync in [false, true] {
        let f = Arc::new(Fault::default());
        let (_dir, path, mut s) = core(config(), policy(), 2, f.clone());
        if progress_sync {
            claim(&mut s);
        }
        f.arm(SpoolOperation::SyncFile, 1);
        if progress_sync {
            s.observe_delta(progress("exec-1-1", "mock-epoch-1", 1), "世")
                .unwrap();
            assert_eq!(view(&s, 0).result, ResultState::Unavailable);
            assert_eq!(view(&s, 0).dispatch, DispatchState::Streaming);
            assert_eq!(s.snapshot().unwrap().capacity.inflight_requests, 1);
            s.observe_delta(terminal("exec-1-1", "mock-epoch-1", 2), "")
                .unwrap();
            s.discard_unavailable_result("exec-1-1", "fixture-sync-failure-closed".into())
                .unwrap();
        } else {
            assert!(s.claim_next().is_err());
            assert_eq!(view(&s, 0).dispatch, DispatchState::Unsent);
            s.reconcile_spool("fixture-unsynced-orphan".into()).unwrap();
        }
        assert_eq!(s.snapshot().unwrap().mode, Mode::RecoveryRequired);
        assert_eq!(view(&s, 1).dispatch, DispatchState::Unsent);
        assert!(!slot(&path, "exec-1-1").exists());
        assert_replay(&s);
    }
}

#[test]
fn corrupt_artifact_cannot_be_acknowledged_and_ack_deadline_cannot_overflow() {
    let (_dir, path, mut s) = normal(1);
    complete(&mut s, "exec-1-1");
    let digest = view(&s, 0).artifact.unwrap().digest;
    assert!(
        s.ack_result(
            "exec-1-1",
            "opaque-owner",
            &digest,
            "sink-1",
            i64::MAX as u64
        )
        .is_err()
    );
    assert!(view(&s, 0).handoff.is_none());
    let mut f = OpenOptions::new()
        .write(true)
        .open(slot(&path, "exec-1-1"))
        .unwrap();
    f.seek(SeekFrom::Start(48)).unwrap();
    f.write_all(b"bad").unwrap();
    f.sync_all().unwrap();
    assert!(
        s.ack_result("exec-1-1", "opaque-owner", &digest, "sink-1", 1000)
            .is_err()
    );
    assert!(view(&s, 0).handoff.is_none());
    assert_eq!(view(&s, 0).result, ResultState::Unavailable);
    assert_eq!(s.snapshot().unwrap().mode, Mode::RecoveryRequired);
    assert_replay(&s);
}

#[test]
fn committed_phase_two_journal_replays_without_inventing_missing_result_files() {
    let fixture: serde_json::Value = serde_json::from_slice(include_bytes!(
        "../fixtures/phase3/phase2-journal-085a09b.json"
    ))
    .unwrap();
    assert_eq!(fixture["source_commit"], "085a09b");
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("upgrade.sqlite");
    let raw = rusqlite::Connection::open(&path).unwrap();
    raw.execute_batch("CREATE TABLE journal(event_seq INTEGER PRIMARY KEY,previous_hash TEXT,record_hash TEXT UNIQUE,action_json TEXT,event_json TEXT); CREATE TABLE metadata(singleton INTEGER PRIMARY KEY,config_hash TEXT,head_seq INTEGER,head_hash TEXT,snapshot_json TEXT); PRAGMA user_version=1;").unwrap();
    for row in fixture["metadata"].as_array().unwrap() {
        raw.execute(
            "INSERT INTO metadata VALUES (?1,?2,?3,?4,?5)",
            rusqlite::params![
                row[0].as_i64().unwrap(),
                row[1].as_str().unwrap(),
                row[2].as_i64().unwrap(),
                row[3].as_str().unwrap(),
                row[4].as_str().unwrap()
            ],
        )
        .unwrap();
    }
    for row in fixture["journal"].as_array().unwrap() {
        raw.execute(
            "INSERT INTO journal VALUES (?1,?2,?3,?4,?5)",
            rusqlite::params![
                row[0].as_i64().unwrap(),
                row[1].as_str().unwrap(),
                row[2].as_str().unwrap(),
                row[3].as_str().unwrap(),
                row[4].as_str().unwrap()
            ],
        )
        .unwrap();
    }
    drop(raw);
    let s = Scheduler::open(&path, config()).unwrap();
    assert_eq!(s.snapshot().unwrap().mode, Mode::RecoveryRequired);
    assert_eq!(s.snapshot().unwrap().next_plan_seq, 3);
    for plan_id in ["plan-1", "plan-2"] {
        for e in s.plan_state(plan_id).unwrap().unwrap().executions {
            assert_eq!(e.dispatch, DispatchState::Terminal);
            assert_eq!(
                e.stream_report.unwrap().protocol,
                ProtocolStatus::CompleteProtocol
            );
            assert_eq!(e.result, ResultState::Pending);
            assert!(e.artifact.is_none());
        }
    }
    assert_replay(&s);
    drop(s);
    assert!(Scheduler::open_with_spool(&path, config(), policy()).is_err());
}

#[test]
fn missing_journal_or_binding_cannot_silently_adopt_or_recreate_old_spool() {
    let (_dir, path, s) = normal(1);
    drop(s);
    let mut root = path.as_os_str().to_os_string();
    root.push(".spool");
    let root = PathBuf::from(root);
    let marker = root.join("binding.json");
    let original = fs::read(&marker).unwrap();
    fs::remove_file(&marker).unwrap();
    assert!(Scheduler::open_with_spool(&path, config(), policy()).is_err());
    assert!(!marker.exists());
    fs::write(&marker, original).unwrap();
    // Move the full journal aside: the surviving spool cannot bootstrap a fresh database.
    fs::rename(&path, path.with_extension("sqlite.saved")).unwrap();
    assert!(Scheduler::open_with_spool(&path, config(), policy()).is_err());
    assert!(Scheduler::open_with_spool(&path, config(), policy()).is_err());
}
