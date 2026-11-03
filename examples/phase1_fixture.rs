//! Offline acceptance walkthrough. No HTTP/SSE, physical spool, GPU or money.
#[path = "../tests/common/mod.rs"]
mod common;
use common::*;
use flex_scheduler::*;
use std::path::Path;

fn main() -> std::result::Result<(), Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args().collect();
    if args.len() != 3 || args[1] != "--db" {
        return Err("usage: phase1_fixture --db NEW_DATABASE_PATH".into());
    }
    let path = Path::new(&args[2]);
    if path.exists() {
        return Err("fixture requires a new database; existing journals are never reset".into());
    }
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/phase1");
    let c: SchedulerConfig = serde_json::from_slice(&std::fs::read(dir.join("config.json"))?)?;
    let one =
        ExecutionPlan::from_json(&std::fs::read(dir.join("plan-001.json"))?, c.max_plan_bytes)?;
    let two =
        ExecutionPlan::from_json(&std::fs::read(dir.join("plan-002.json"))?, c.max_plan_bytes)?;
    let mut s = Scheduler::open(path, c.clone())?;
    s.activate(activation("fixture-epoch-1"))?;
    assert_eq!(
        s.register(two)?,
        RegisterOutcome::Registered {
            awaiting_predecessor: true
        }
    );
    assert_blocked(&mut s, BlockReason::MissingPredecessor);
    s.register(one.clone())?;
    assert_eq!(s.register(one)?, RegisterOutcome::AlreadyRegistered);
    let a = claim(&mut s);
    assert_eq!(a.binding.execution_id, "exec-1-1");
    assert_blocked(&mut s, BlockReason::PreviousGateClosed);
    s.observe(progress("exec-1-1", "fixture-epoch-1", 1))?;
    let b = claim(&mut s);
    assert_eq!(b.binding.execution_id, "exec-1-2");
    assert_eq!(s.snapshot()?.capacity.inflight_requests, 2);
    // B legitimately ends without visible output; A continues in flight.
    s.observe(terminal("exec-1-2", "fixture-epoch-1", 1))?;
    let third = claim(&mut s);
    assert_eq!(third.binding.execution_id, "exec-2-1");
    s.observe(progress("exec-2-1", "fixture-epoch-1", 1))?;
    s.observe(terminal("exec-1-1", "fixture-epoch-1", 2))?;
    s.observe(terminal("exec-2-1", "fixture-epoch-1", 2))?;
    assert_eq!(s.snapshot()?, s.replay_snapshot()?);
    drop(s);
    let mut s = Scheduler::open(path, c)?;
    assert_eq!(s.snapshot()?.mode, Mode::RecoveryRequired);
    s.activate(activation("fixture-epoch-2"))?;
    assert_blocked(&mut s, BlockReason::NoPlan);
    let events = s.events_after(0, 1000)?;
    let intents: Vec<_> = events
        .iter()
        .filter(|e| e.kind == EventKind::DispatchIntent)
        .map(|e| e.binding.as_ref().unwrap().execution_id.clone())
        .collect();
    assert_eq!(intents, ["exec-1-1", "exec-1-2", "exec-2-1"]);
    println!(
        "{}",
        serde_json::to_string_pretty(&serde_json::json!({
            "scope": "phase-one-offline-core-only", "dispatch_order": intents,
            "events": events.len(), "snapshot_replay_matches": s.snapshot()? == s.replay_snapshot()?,
            "physical_spool_implemented": false, "http_or_gpu_executed": false, "snapshot": s.snapshot()?
        }))?
    );
    Ok(())
}
