//! Self-contained loopback mock walkthrough. No real vLLM/GPU or result spool.
#[path = "../tests/common/mod.rs"]
mod common;
#[path = "../tests/common/http.rs"]
mod http;
use common::*;
use flex_scheduler::*;
use http::{MockServer, Script, Step, choice, frame, success, usage};
use std::{collections::BTreeMap, path::Path, sync::Arc, time::Duration};
use tokio::sync::Notify;

#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() -> std::result::Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().collect();
    if args.len() != 3 || args[1] != "--db" {
        return Err("usage: phase2_mock --db NEW_DATABASE_PATH".into());
    }
    let path = Path::new(&args[2]);
    if path.exists() {
        return Err("mock requires a new database; existing journals are never reset".into());
    }
    let mut scheduler = Scheduler::open(path, config())?;
    scheduler.activate(activation("mock-epoch-1"))?;
    let first = plan(1, GENESIS, 2);
    let second = plan(2, &first.manifest_hash, 1);
    scheduler.register(second)?;
    scheduler.register(first)?;
    let release_a = Arc::new(Notify::new());
    let mut a = Script::sse(vec![]);
    a.steps = vec![
        Step::Bytes(frame(choice("exec-1-1", vec![99], "", None))),
        Step::Wait(release_a.clone()),
        Step::Bytes(
            [
                frame(choice("exec-1-1", vec![], "", Some("stop"))),
                frame(usage("exec-1-1", 1)),
                b"data: [DONE]\n\n".to_vec(),
            ]
            .concat(),
        ),
    ];
    let server = MockServer::start(BTreeMap::from([
        ("exec-1-1".into(), a),
        ("exec-1-2".into(), Script::sse(success("exec-1-2"))),
        ("exec-2-1".into(), Script::sse(success("exec-2-1"))),
    ]))
    .await;
    let runner = MockHttpRunner::new(http::config(&server.endpoint))?;
    let controller = async {
        tokio::time::timeout(Duration::from_secs(3),async {
            loop {
                let raw=rusqlite::Connection::open(path).unwrap();
                let b_done:bool=raw.query_row("SELECT EXISTS(SELECT 1 FROM journal WHERE event_json LIKE '%EXECUTION_TERMINAL%' AND event_json LIKE '%exec-1-2%')",[],|r|r.get(0)).unwrap();
                if b_done { release_a.notify_one(); break; }
                tokio::time::sleep(Duration::from_millis(2)).await;
            }
        }).await
    };
    let (report, control) = tokio::join!(runner.run_until_idle(&mut scheduler), controller);
    control?;
    let mut report = report?;
    assert_eq!(report.dispatch_order, ["exec-1-1", "exec-1-2", "exec-2-1"]);
    assert!(
        report
            .streams
            .iter()
            .all(|s| s.protocol == ProtocolStatus::CompleteProtocol)
    );
    let events = scheduler.events_after(0, 1000)?;
    let terminal_seq = |execution: &str| {
        events
            .iter()
            .find(|e| {
                e.kind == EventKind::ExecutionTerminal
                    && e.binding
                        .as_ref()
                        .is_some_and(|b| b.execution_id == execution)
            })
            .unwrap()
            .event_seq
    };
    let overlap = terminal_seq("exec-1-2") < terminal_seq("exec-1-1");
    assert!(overlap);
    assert_eq!(scheduler.snapshot()?, scheduler.replay_snapshot()?);
    report
        .streams
        .sort_by(|a, b| a.execution_id.cmp(&b.execution_id));
    drop(scheduler);
    let mut reopened = Scheduler::open(path, config())?;
    assert_eq!(reopened.snapshot()?.mode, Mode::RecoveryRequired);
    assert!(matches!(
        runner.run_until_idle(&mut reopened).await,
        Err(Error::NotActive)
    ));
    assert_eq!(server.count(), 3);
    println!(
        "{}",
        serde_json::to_string_pretty(&serde_json::json!({
            "phase_one_commit": "b5bcc26", "loopback_http_executed":true,
            "real_vllm_or_gpu_executed":false,"physical_spool_implemented":false,
            "http_requests":server.count(),"b_terminal_before_a_terminal":overlap,
            "snapshot_replay_matches":true,"reopen_requires_recovery":true,"reopen_reposts":0,
            "report":report
        }))?
    );
    Ok(())
}
