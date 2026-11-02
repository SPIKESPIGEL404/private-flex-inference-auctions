//! Local spool -> independent durable mock sink -> ACK -> cleanup walkthrough.
#[path = "../tests/common/mod.rs"]
mod common;
#[path = "../tests/common/http.rs"]
mod http;
use common::*;
use flex_scheduler::*;
use http::{MockServer, Script, success};
use std::{
    collections::BTreeMap,
    fs::{self, File},
    path::{Path, PathBuf},
};

fn policy() -> SpoolPolicy {
    SpoolPolicy {
        acknowledged_retention_ms: 100,
        max_artifact_bytes: 4096,
        max_physical_bytes: 8192,
        max_owner_physical_bytes: 8192,
    }
}
fn sink_result(scheduler: &mut Scheduler, execution: &str, sink: &Path) -> ResultArtifact {
    let artifact = scheduler
        .get_result_artifact(execution, "opaque-owner")
        .unwrap();
    let file = File::create_new(sink.join(format!("{execution}.json"))).unwrap();
    serde_json::to_writer(&file, &artifact).unwrap();
    file.sync_all().unwrap();
    File::open(sink).unwrap().sync_all().unwrap();
    artifact
}

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() -> std::result::Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().collect();
    if args.len() != 3 || args[1] != "--db" {
        return Err("usage: phase3_spool --db NEW_DATABASE_PATH".into());
    }
    let path = Path::new(&args[2]);
    let mut spool = path.as_os_str().to_os_string();
    spool.push(".spool");
    let mut sink = path.as_os_str().to_os_string();
    sink.push(".mock-sink");
    let sink = PathBuf::from(sink);
    if path.exists() || PathBuf::from(spool).exists() || sink.exists() {
        return Err("walkthrough requires fresh journal, spool and mock sink paths".into());
    }
    let mut scheduler = Scheduler::open_with_spool(path, config(), policy())?;
    scheduler.reconcile_spool("fixture-empty-spool-verified".into())?;
    scheduler.activate(activation("mock-epoch-1"))?;
    scheduler.register(plan(1, GENESIS, 3))?;
    let server = MockServer::start(
        (1..=3)
            .map(|i| {
                let e = format!("exec-1-{i}");
                (e.clone(), Script::sse(success(&e)))
            })
            .collect::<BTreeMap<_, _>>(),
    )
    .await;
    let runner = MockHttpRunner::new(http::config(&server.endpoint))?;
    let initial = runner.run_until_idle(&mut scheduler).await?;
    assert_eq!(initial.dispatch_order, ["exec-1-1", "exec-1-2"]);
    assert_eq!(initial.blocked, Some(BlockReason::PhysicalSpoolCapacity));
    assert_eq!(initial.final_snapshot.capacity.physical_spool_bytes, 8192);
    assert_eq!(scheduler.collect_results(9_999_999)?, 0);
    fs::create_dir(&sink)?;
    File::open(sink.parent().unwrap())?.sync_all()?;
    let mut artifacts = vec![
        sink_result(&mut scheduler, "exec-1-1", &sink),
        sink_result(&mut scheduler, "exec-1-2", &sink),
    ];
    // Sink is synced, but its first ACK was lost. Reopen never sends another POST.
    drop(scheduler);
    let mut scheduler = Scheduler::open_with_spool(path, config(), policy())?;
    assert_eq!(scheduler.snapshot()?.mode, Mode::RecoveryRequired);
    assert!(matches!(
        runner.run_until_idle(&mut scheduler).await,
        Err(Error::NotActive)
    ));
    assert_eq!(server.count(), 2);
    scheduler.reconcile_spool("fixture-reopen-and-sink-receipts-verified".into())?;
    for a in &artifacts {
        let receipt = format!("mock-sink-{}", a.binding.execution_id);
        assert_eq!(
            scheduler.ack_result(
                &a.binding.execution_id,
                "opaque-owner",
                &a.metadata.digest,
                &receipt,
                1000
            )?,
            ObservationOutcome::Recorded
        );
        assert_eq!(
            scheduler.ack_result(
                &a.binding.execution_id,
                "opaque-owner",
                &a.metadata.digest,
                &receipt,
                1200
            )?,
            ObservationOutcome::AlreadyRecorded
        );
    }
    assert_eq!(scheduler.collect_results(1099)?, 0);
    assert_eq!(scheduler.collect_results(1100)?, 2);
    assert_eq!(scheduler.snapshot()?.capacity.physical_spool_bytes, 0);
    scheduler.activate(activation("mock-epoch-2"))?;
    let resumed = runner.run_until_idle(&mut scheduler).await?;
    assert_eq!(resumed.dispatch_order, ["exec-1-3"]);
    let last = sink_result(&mut scheduler, "exec-1-3", &sink);
    scheduler.ack_result(
        "exec-1-3",
        "opaque-owner",
        &last.metadata.digest,
        "mock-sink-exec-1-3",
        2000,
    )?;
    assert_eq!(scheduler.collect_results(2100)?, 1);
    artifacts.push(last);
    for a in &artifacts {
        let received: ResultArtifact = serde_json::from_slice(&fs::read(
            sink.join(format!("{}.json", a.binding.execution_id)),
        )?)?;
        assert!(received == *a);
        assert_eq!(received.text, "世");
        assert_eq!(received.token_ids, [99]);
    }
    let events = scheduler.events_after(0, 1000)?;
    assert_eq!(
        events
            .iter()
            .filter(|e| e.kind == EventKind::DispatchIntent)
            .count(),
        3
    );
    assert_eq!(
        events
            .iter()
            .filter(|e| e.kind == EventKind::ResultDurable)
            .count(),
        3
    );
    assert_eq!(
        events
            .iter()
            .filter(|e| e.kind == EventKind::ResultHandedOff)
            .count(),
        3
    );
    assert_eq!(
        events
            .iter()
            .filter(|e| e.kind == EventKind::ResultCleaned)
            .count(),
        3
    );
    assert_eq!(scheduler.snapshot()?, scheduler.replay_snapshot()?);
    assert_eq!(server.count(), 3);
    drop(scheduler);
    let scheduler = Scheduler::open_with_spool(path, config(), policy())?;
    assert_eq!(scheduler.snapshot()?.capacity.physical_spool_bytes, 0);
    assert_eq!(scheduler.snapshot()?, scheduler.replay_snapshot()?);
    println!(
        "{}",
        serde_json::to_string_pretty(&serde_json::json!({
            "phase_two_commit":"085a09b","scope":"local-loopback-mock-with-physical-spool-and-independent-mock-sink",
            "real_vllm_or_gpu_executed":false,"real_bitrouter_or_tee_integrated":false,
            "http_requests":server.count(),"dispatch_order":["exec-1-1","exec-1-2","exec-1-3"],
            "initial_backpressure":initial.blocked,"peak_physical_slot_bytes":8192,
            "unacknowledged_age_cleanup_count":0,"sink_synced_before_ack":true,"reopen_reposts":0,
            "duplicate_ack_extends_retention":false,"durable_results":3,"handed_off_results":3,"cleaned_results":3,
            "sink_results_readable_after_cleanup":true,"snapshot_replay_matches":true,
            "final_snapshot":scheduler.snapshot()?,"artifacts":artifacts.iter().map(|a|serde_json::json!({"binding":a.binding,"metadata":a.metadata})).collect::<Vec<_>>()
        }))?
    );
    Ok(())
}
