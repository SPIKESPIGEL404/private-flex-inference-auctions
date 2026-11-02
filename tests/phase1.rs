mod common;
use common::*;
use flex_scheduler::*;
use rusqlite::Connection;
use std::path::{Path, PathBuf};
use std::process::Command;
use tempfile::TempDir;

fn harness(c: SchedulerConfig) -> (TempDir, PathBuf, Scheduler) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("journal.sqlite");
    let mut s = Scheduler::open(&path, c).unwrap();
    s.activate(activation("epoch-1")).unwrap();
    (dir, path, s)
}

fn event_count(s: &Scheduler) -> usize {
    s.events_after(0, 1000).unwrap().len()
}

#[test]
fn checked_in_fixtures_are_signed_reproducible_and_strict() {
    let c = config();
    let directory = Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/phase1");
    let saved_config: SchedulerConfig =
        serde_json::from_slice(&std::fs::read(directory.join("config.json")).unwrap()).unwrap();
    assert_eq!(saved_config, c);
    let one = plan(1, GENESIS, 2);
    let two = plan(2, &one.manifest_hash, 1);
    for (name, expected) in [("plan-001.json", one), ("plan-002.json", two)] {
        let bytes = std::fs::read(directory.join(name)).unwrap();
        let parsed = ExecutionPlan::from_json(&bytes, c.max_plan_bytes).unwrap();
        assert!(parsed == expected);
        let (_dir, _path, mut s) = harness(c.clone());
        assert!(s.register(parsed).is_ok());
        let mut value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        value["budget"] = 100.into();
        assert!(
            ExecutionPlan::from_json(&serde_json::to_vec(&value).unwrap(), c.max_plan_bytes)
                .is_err()
        );
        value.as_object_mut().unwrap().remove("budget");
        value["ordered_requests"][0]["priority_payment"] = 10.into();
        assert!(
            ExecutionPlan::from_json(&serde_json::to_vec(&value).unwrap(), c.max_plan_bytes)
                .is_err()
        );
        assert!(ExecutionPlan::from_json(&bytes, 10).is_err());
    }
}

#[test]
fn canonical_hashes_do_not_depend_on_json_key_order() {
    let a: serde_json::Value = serde_json::from_str(r#"{"z":1,"a":{"y":2,"b":3}}"#).unwrap();
    let b: serde_json::Value = serde_json::from_str(r#"{"a":{"b":3,"y":2},"z":1}"#).unwrap();
    assert_eq!(canonical_bytes(&a).unwrap(), canonical_bytes(&b).unwrap());
    assert_ne!(
        digest("domain-a", &a).unwrap(),
        digest("domain-b", &a).unwrap()
    );
}

#[test]
fn registration_rejects_tampering_bad_auth_and_incomplete_membership_atomically() {
    let (_dir, _path, mut s) = harness(config());
    let original = plan(1, GENESIS, 2);
    let before = event_count(&s);
    let mut cases = Vec::new();
    let mut p = original.clone();
    p.ordered_requests[1].prompt_token_ids.push(4);
    cases.push(p);
    let mut p = original.clone();
    p.authorization_binding.signature = "00".repeat(64);
    cases.push(p);
    let mut p = original.clone();
    p.authorization_binding.issuer_id = "unknown-issuer".into();
    seal(&mut p);
    cases.push(p);
    let mut p = original.clone();
    p.request_count = 3;
    seal(&mut p);
    cases.push(p);
    let mut p = original.clone();
    p.ordered_requests[1].rank = 1;
    seal(&mut p);
    cases.push(p);
    let mut p = original.clone();
    p.ordered_requests[1].execution_id = p.ordered_requests[0].execution_id.clone();
    seal(&mut p);
    cases.push(p);
    let mut p = original.clone();
    p.ordered_requests[1].grant_id = p.ordered_requests[0].grant_id.clone();
    seal(&mut p);
    cases.push(p);
    let mut p = original.clone();
    p.model_profile_id = "wrong-model".into();
    seal(&mut p);
    cases.push(p);
    let mut p = original.clone();
    p.target_scheduler_id = "other-scheduler".into();
    seal(&mut p);
    cases.push(p);
    let mut p = original.clone();
    p.ordered_requests[1].context_reservation = 1;
    seal(&mut p);
    cases.push(p);
    let mut p = original.clone();
    p.ordered_requests[1].max_result_bytes = 1;
    seal(&mut p);
    cases.push(p);
    let mut p = original.clone();
    p.ordered_requests[1].prompt_token_ids = vec![999_999];
    seal(&mut p);
    cases.push(p);
    let mut p = original.clone();
    p.ordered_requests[1].max_output_tokens = 0;
    seal(&mut p);
    cases.push(p);
    for p in cases {
        assert!(s.register(p).is_err());
        assert_eq!(event_count(&s), before);
        assert_eq!(s.snapshot().unwrap().capacity.queued_requests, 0);
        assert_blocked(&mut s, BlockReason::NoPlan);
    }
    assert!(s.register(original).is_ok());
    assert_eq!(s.snapshot().unwrap().capacity.queued_requests, 2);
}

#[test]
fn out_of_order_plans_wait_for_genesis_and_preserve_cross_plan_gates() {
    let (_dir, _path, mut s) = harness(config());
    let one = plan(1, GENESIS, 2);
    let two = plan(2, &one.manifest_hash, 1);
    assert_eq!(
        s.register(two).unwrap(),
        RegisterOutcome::Registered {
            awaiting_predecessor: true
        }
    );
    assert_blocked(&mut s, BlockReason::MissingPredecessor);
    s.register(one.clone()).unwrap();
    let before = event_count(&s);
    assert_eq!(s.register(one).unwrap(), RegisterOutcome::AlreadyRegistered);
    assert_eq!(event_count(&s), before);
    assert_eq!(claim(&mut s).binding.execution_id, "exec-1-1");
    assert_blocked(&mut s, BlockReason::PreviousGateClosed);
    s.observe(progress("exec-1-1", "epoch-1", 1)).unwrap();
    assert_eq!(claim(&mut s).binding.execution_id, "exec-1-2");
    assert_blocked(&mut s, BlockReason::PreviousGateClosed);
    s.observe(terminal("exec-1-2", "epoch-1", 1)).unwrap();
    assert_eq!(claim(&mut s).binding.execution_id, "exec-2-1");
    // The earlier long request is still running; completion order is unrestricted.
    assert_eq!(
        s.plan_state("plan-1").unwrap().unwrap().executions[0].dispatch,
        DispatchState::Streaming
    );
    let events = s.events_after(0, 1000).unwrap();
    let dispatches: Vec<_> = events
        .iter()
        .filter(|e| e.kind == EventKind::DispatchIntent)
        .collect();
    for pair in dispatches.windows(2) {
        let previous_id = &pair[0].binding.as_ref().unwrap().execution_id;
        assert!(events.iter().any(|e| {
            e.event_seq > pair[0].event_seq
                && e.event_seq < pair[1].event_seq
                && matches!(
                    e.kind,
                    EventKind::OutputProgress | EventKind::ExecutionTerminal
                )
                && e.binding
                    .as_ref()
                    .is_some_and(|b| &b.execution_id == previous_id)
        }));
    }
}

#[test]
fn plan_identity_conflicts_are_persistent_and_cannot_be_resumed_blindly() {
    let (_dir, path, mut s) = harness(config());
    let one = plan(1, GENESIS, 1);
    s.register(one.clone()).unwrap();
    let mut conflicting = one;
    conflicting.authorization_ref = "different-valid-authorization".into();
    seal(&mut conflicting);
    assert!(matches!(s.register(conflicting), Err(Error::PlanConflict)));
    assert!(s.snapshot().unwrap().integrity_fault);
    assert!(s.activate(activation("epoch-2")).is_err());
    drop(s);
    let mut s = Scheduler::open(path, config()).unwrap();
    assert!(s.snapshot().unwrap().integrity_fault);
    assert!(s.activate(activation("epoch-3")).is_err());
    assert!(matches!(s.claim_next(), Err(Error::NotActive)));
}

#[test]
fn wrong_predecessor_hash_pauses_even_when_successor_arrived_first() {
    let (_dir, _path, mut s) = harness(config());
    s.register(plan(2, &"aa".repeat(32), 1)).unwrap();
    assert!(matches!(
        s.register(plan(1, GENESIS, 1)),
        Err(Error::PlanConflict)
    ));
    assert!(s.plan_state("plan-1").unwrap().is_none());
    assert_eq!(s.snapshot().unwrap().mode, Mode::RecoveryRequired);
}

#[test]
fn an_execution_or_grant_cannot_be_registered_in_another_plan() {
    for change_execution in [true, false] {
        let (_dir, _path, mut s) = harness(config());
        let one = plan(1, GENESIS, 1);
        let mut two = plan(2, &one.manifest_hash, 1);
        if change_execution {
            two.ordered_requests[0].execution_id = "exec-1-1".into();
        } else {
            two.ordered_requests[0].grant_id = "grant-1-1".into();
        }
        seal(&mut two);
        s.register(one).unwrap();
        let before = event_count(&s);
        assert!(matches!(s.register(two), Err(Error::DuplicateExecution)));
        assert_eq!(event_count(&s), before);
        assert!(s.plan_state("plan-2").unwrap().is_none());
    }
}

#[test]
fn queued_request_byte_and_out_of_order_bounds_are_atomic() {
    let mut configs = vec![];
    let mut c = config();
    c.max_queued_requests = 1;
    configs.push(c);
    let mut c = config();
    c.max_queued_bytes = 1;
    configs.push(c);
    for c in configs {
        let (_dir, _path, mut s) = harness(c);
        assert!(matches!(
            s.register(plan(1, GENESIS, 2)),
            Err(Error::Backpressure(_))
        ));
        assert_eq!(s.snapshot().unwrap().capacity.queued_requests, 0);
    }
    let mut c = config();
    c.max_out_of_order_plans = 1;
    let (_dir, _path, mut s) = harness(c);
    let one = plan(1, GENESIS, 1);
    let two = plan(2, &one.manifest_hash, 1);
    let three = plan(3, &two.manifest_hash, 1);
    s.register(three).unwrap();
    assert!(matches!(
        s.register(two.clone()),
        Err(Error::Backpressure(_))
    ));
    s.register(one).unwrap();
    s.register(two).unwrap();
    assert_eq!(s.snapshot().unwrap().contiguous_through, 3);
}

#[test]
fn terminal_without_progress_releases_execution_capacity_but_not_result_reservation() {
    let mut c = config();
    c.max_inflight_requests = 1;
    let (_dir, _path, mut s) = harness(c);
    s.register(plan(1, GENESIS, 2)).unwrap();
    claim(&mut s);
    s.observe(progress("exec-1-1", "epoch-1", 1)).unwrap();
    assert_blocked(&mut s, BlockReason::RequestCapacity);
    s.observe(terminal("exec-1-1", "epoch-1", 2)).unwrap();
    assert_eq!(s.snapshot().unwrap().capacity.reserved_spool_bytes, 384);
    assert_eq!(claim(&mut s).binding.execution_id, "exec-1-2");
    s.observe(terminal("exec-1-2", "epoch-1", 1)).unwrap();
    let state = s.plan_state("plan-1").unwrap().unwrap();
    assert_eq!(state.executions[1].gate, GateState::SatisfiedByTerminal);
    assert_eq!(s.snapshot().unwrap().capacity.inflight_requests, 0);
    assert_eq!(s.snapshot().unwrap().capacity.reserved_spool_bytes, 768);
}

#[test]
fn context_and_spool_backpressure_do_not_skip_to_smaller_later_requests() {
    for (context, spool, owner, expected) in [
        (21, 8192, 4096, BlockReason::ContextCapacity),
        (64, 700, 700, BlockReason::SpoolCapacity),
        (64, 8192, 700, BlockReason::OwnerSpoolCapacity),
    ] {
        let mut c = config();
        c.max_reserved_context_tokens = context;
        c.max_spool_bytes = spool;
        c.max_owner_spool_bytes = owner;
        let (_dir, _path, mut s) = harness(c);
        let mut p = plan(1, GENESIS, 3);
        p.ordered_requests[2].max_output_tokens = 1;
        p.ordered_requests[2].context_reservation = 4;
        p.ordered_requests[2].max_result_bytes = 160;
        seal(&mut p);
        s.register(p).unwrap();
        claim(&mut s);
        s.observe(progress("exec-1-1", "epoch-1", 1)).unwrap();
        assert_blocked(&mut s, expected);
        assert_eq!(s.snapshot().unwrap().next_rank, 2);
        assert_eq!(
            s.plan_state("plan-1").unwrap().unwrap().executions[2].dispatch,
            DispatchState::Unsent
        );
    }
}

#[test]
fn repeated_token_content_is_not_deduplicated_but_replayed_observation_is() {
    let (_dir, _path, mut s) = harness(config());
    s.register(plan(1, GENESIS, 1)).unwrap();
    claim(&mut s);
    let first = progress("exec-1-1", "epoch-1", 1);
    assert_eq!(
        s.observe(first.clone()).unwrap(),
        ObservationOutcome::Recorded
    );
    let before = event_count(&s);
    assert_eq!(
        s.observe(first).unwrap(),
        ObservationOutcome::AlreadyRecorded
    );
    assert_eq!(event_count(&s), before);
    s.observe(progress("exec-1-1", "epoch-1", 2)).unwrap();
    assert_eq!(event_count(&s), before + 1);
}

#[test]
fn conflicting_observation_sequence_pauses_dispatch() {
    let (_dir, _path, mut s) = harness(config());
    s.register(plan(1, GENESIS, 2)).unwrap();
    claim(&mut s);
    s.observe(progress("exec-1-1", "epoch-1", 1)).unwrap();
    let mut different = progress("exec-1-1", "epoch-1", 1);
    different.evidence_ref = "conflicting-evidence".into();
    assert!(matches!(
        s.observe(different),
        Err(Error::ObservationConflict)
    ));
    assert!(s.snapshot().unwrap().integrity_fault);
    assert!(matches!(s.claim_next(), Err(Error::NotActive)));
}

#[test]
fn first_generation_and_terminal_are_committed_in_one_observation() {
    let (_dir, _path, mut s) = harness(config());
    s.register(plan(1, GENESIS, 2)).unwrap();
    claim(&mut s);
    let mut combined = terminal("exec-1-1", "epoch-1", 1);
    combined.observation = ObservationKind::ExecutionTerminal {
        outcome: TerminalOutcome::Length,
        generated_token_ids: vec![99, 99],
    };
    let before = event_count(&s);
    s.observe(combined.clone()).unwrap();
    assert_eq!(event_count(&s), before + 1);
    let view = s.plan_state("plan-1").unwrap().unwrap();
    assert_eq!(view.executions[0].dispatch, DispatchState::Terminal);
    assert_eq!(view.executions[0].gate, GateState::SatisfiedByOutput);
    assert_eq!(view.executions[0].generated_tokens, 2);
    assert_eq!(s.snapshot().unwrap().capacity.inflight_requests, 0);
    let event = s.events_after(before as u64, 1).unwrap().remove(0);
    assert_eq!(event.kind, EventKind::ExecutionTerminal);
    assert_eq!(event.generated_token_count, Some(2));
    assert_eq!(
        s.observe(combined).unwrap(),
        ObservationOutcome::AlreadyRecorded
    );
    assert_eq!(claim(&mut s).binding.execution_id, "exec-1-2");
    assert_eq!(s.snapshot().unwrap(), s.replay_snapshot().unwrap());
}

#[test]
fn generation_limit_and_rejection_evidence_are_validated_before_commit() {
    let (_dir, _path, mut s) = harness(config());
    s.register(plan(1, GENESIS, 2)).unwrap();
    claim(&mut s);
    let mut too_many = progress("exec-1-1", "epoch-1", 1);
    too_many.observation = ObservationKind::OutputProgress {
        generated_token_ids: vec![99; 9],
    };
    assert!(s.observe(too_many).is_err());
    assert_blocked(&mut s, BlockReason::PreviousGateClosed);
    s.observe(progress("exec-1-1", "epoch-1", 1)).unwrap();
    let mut rejection = terminal("exec-1-1", "epoch-1", 2);
    rejection.observation = ObservationKind::ExecutionTerminal {
        outcome: TerminalOutcome::RejectedBeforeExecution,
        generated_token_ids: vec![],
    };
    let before = event_count(&s);
    assert!(s.observe(rejection).is_err());
    assert_eq!(event_count(&s), before);
    assert_eq!(
        s.plan_state("plan-1").unwrap().unwrap().executions[0].dispatch,
        DispatchState::Streaming
    );
}

#[test]
fn invalid_empty_or_unbound_observations_never_open_a_gate() {
    let (_dir, _path, mut s) = harness(config());
    s.register(plan(1, GENESIS, 2)).unwrap();
    assert!(s.observe(progress("exec-1-1", "epoch-1", 1)).is_err());
    claim(&mut s);
    let mut empty = progress("exec-1-1", "epoch-1", 1);
    empty.observation = ObservationKind::OutputProgress {
        generated_token_ids: vec![],
    };
    let mut excessive = empty.clone();
    excessive.observation = ObservationKind::OutputProgress {
        generated_token_ids: vec![1; 33],
    };
    let mut invalid = empty.clone();
    invalid.observation = ObservationKind::OutputProgress {
        generated_token_ids: vec![1024],
    };
    let mut wrong_epoch = progress("exec-1-1", "other-epoch", 1);
    wrong_epoch.evidence_ref = "wrong-epoch".into();
    for obs in [
        empty,
        excessive,
        invalid,
        wrong_epoch,
        progress("exec-1-1", "epoch-1", 2),
    ] {
        let before = event_count(&s);
        assert!(s.observe(obs).is_err());
        assert_eq!(event_count(&s), before);
        assert_blocked(&mut s, BlockReason::PreviousGateClosed);
    }
}

#[test]
fn unknown_preserves_gate_and_capacity_and_requires_explicit_reconciliation() {
    let (_dir, _path, mut s) = harness(config());
    s.register(plan(1, GENESIS, 2)).unwrap();
    claim(&mut s);
    s.observe(progress("exec-1-1", "epoch-1", 1)).unwrap();
    s.observe(unknown("exec-1-1", "epoch-1", 2)).unwrap();
    let snapshot = s.snapshot().unwrap();
    assert_eq!(snapshot.mode, Mode::RecoveryRequired);
    assert_eq!(snapshot.capacity.inflight_requests, 1);
    assert_eq!(snapshot.capacity.reserved_context_tokens, 11);
    assert_eq!(
        s.plan_state("plan-1").unwrap().unwrap().executions[0].gate,
        GateState::SatisfiedByOutput
    );
    assert!(s.activate(activation("epoch-2")).is_err());
    assert!(s.register(plan(3, &"aa".repeat(32), 1)).is_err());
    // A trusted terminal observation resolves responsibility, not the global pause.
    s.observe(terminal("exec-1-1", "epoch-1", 3)).unwrap();
    assert_eq!(s.snapshot().unwrap().capacity.inflight_requests, 0);
    assert!(matches!(s.claim_next(), Err(Error::NotActive)));
    s.activate(activation("epoch-2")).unwrap();
    assert_eq!(claim(&mut s).binding.execution_id, "exec-1-2");
}

#[test]
fn activation_requires_complete_evidence_a_fresh_epoch_and_unchanged_profile() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state.sqlite");
    let mut s = Scheduler::open(&path, config()).unwrap();
    assert!(matches!(s.claim_next(), Err(Error::NotActive)));
    let mut evidence = activation("epoch-1");
    evidence.profile_verified_ref.clear();
    assert!(s.activate(evidence).is_err());
    s.activate(activation("epoch-1")).unwrap();
    s.pause("operator-pause".into()).unwrap();
    assert!(s.activate(activation("epoch-1")).is_err());
    drop(s);
    let mut different = config();
    different.model.profile_id = "different-model".into();
    assert!(matches!(
        Scheduler::open(&path, different),
        Err(Error::ConfigMismatch)
    ));
}

#[test]
fn external_replay_is_stable_paginated_and_redacted() {
    let (_dir, _path, mut s) = harness(config());
    s.register(plan(1, GENESIS, 1)).unwrap();
    claim(&mut s);
    s.observe(progress("exec-1-1", "epoch-1", 1)).unwrap();
    let all = s.events_after(0, 1000).unwrap();
    let mut collected = vec![];
    let mut cursor = 0;
    loop {
        let page = s.events_after(cursor, 2).unwrap();
        if page.is_empty() {
            break;
        }
        cursor = page.last().unwrap().event_seq;
        collected.extend(page);
    }
    assert_eq!(collected, all);
    assert_eq!(s.events_after(0, 1000).unwrap(), all);
    assert!(
        all.windows(2)
            .all(|p| p[1].event_seq == p[0].event_seq + 1 && p[1].event_id != p[0].event_id)
    );
    let bytes = serde_json::to_string(&all).unwrap();
    for forbidden in [
        "prompt_token_ids",
        "generated_token_ids",
        "signature",
        "authorization_ref",
        "priority_payment",
        "budget",
        "hold_id",
    ] {
        assert!(!bytes.contains(forbidden));
    }
    assert_eq!(s.snapshot().unwrap(), s.replay_snapshot().unwrap());
    assert!(s.events_after(0, 0).is_err());
    assert!(s.events_after(u64::MAX, 10).is_err());
}

#[test]
fn reopening_never_auto_activates_or_reissues_an_existing_intent() {
    let (_dir, path, mut s) = harness(config());
    let p = plan(1, GENESIS, 2);
    s.register(p.clone()).unwrap();
    claim(&mut s);
    let events = s.events_after(0, 1000).unwrap();
    drop(s);
    let mut s = Scheduler::open(&path, config()).unwrap();
    assert_eq!(s.snapshot().unwrap().mode, Mode::RecoveryRequired);
    assert_eq!(
        s.plan_state("plan-1").unwrap().unwrap().executions[0].dispatch,
        DispatchState::Unknown
    );
    assert_eq!(s.register(p).unwrap(), RegisterOutcome::AlreadyRegistered);
    assert_eq!(
        &s.events_after(0, 1000).unwrap()[..events.len()],
        events.as_slice()
    );
    assert!(s.activate(activation("epoch-2")).is_err());
    s.record_epoch_isolation("epoch-1".into(), "operator-old-process-isolated".into())
        .unwrap();
    s.activate(activation("epoch-2")).unwrap();
    assert_eq!(claim(&mut s).binding.execution_id, "exec-1-2");
    let before = s.snapshot().unwrap().capacity;
    assert_eq!(
        s.observe(terminal("exec-1-1", "epoch-1", 1)).unwrap(),
        ObservationOutcome::LateEvidence
    );
    assert_eq!(s.snapshot().unwrap().capacity, before);
    assert!(s.plan_state("plan-1").unwrap().unwrap().executions[0].fenced);
    assert_eq!(s.snapshot().unwrap(), s.replay_snapshot().unwrap());
}

#[test]
fn sqlite_failure_rolls_back_intent_and_poison_stops_further_actions() {
    let (_dir, path, mut s) = harness(config());
    s.register(plan(1, GENESIS, 1)).unwrap();
    let before = event_count(&s);
    let raw = Connection::open(&path).unwrap();
    raw.execute_batch("CREATE TRIGGER fail_metadata BEFORE UPDATE ON metadata BEGIN SELECT RAISE(ABORT, 'injected write failure'); END;").unwrap();
    assert!(matches!(s.claim_next(), Err(Error::Sqlite(_))));
    assert!(matches!(s.claim_next(), Err(Error::Poisoned)));
    let rows: i64 = raw
        .query_row("SELECT COUNT(*) FROM journal", [], |r| r.get(0))
        .unwrap();
    assert_eq!(rows as usize, before);
    raw.execute_batch("DROP TRIGGER fail_metadata").unwrap();
    drop(raw);
    drop(s);
    let mut s = Scheduler::open(path, config()).unwrap();
    assert_eq!(
        s.plan_state("plan-1").unwrap().unwrap().executions[0].dispatch,
        DispatchState::Unsent
    );
    s.activate(activation("epoch-2")).unwrap();
    assert_eq!(claim(&mut s).binding.execution_id, "exec-1-1");
}

#[test]
fn failed_progress_commit_cannot_release_the_next_request() {
    let (_dir, path, mut s) = harness(config());
    s.register(plan(1, GENESIS, 2)).unwrap();
    claim(&mut s);
    let raw = Connection::open(&path).unwrap();
    raw.execute_batch("CREATE TRIGGER fail_progress BEFORE UPDATE ON metadata BEGIN SELECT RAISE(ABORT, 'injected write failure'); END;").unwrap();
    assert!(s.observe(progress("exec-1-1", "epoch-1", 1)).is_err());
    assert!(matches!(s.claim_next(), Err(Error::Poisoned)));
    raw.execute_batch("DROP TRIGGER fail_progress").unwrap();
    drop(raw);
    drop(s);
    let s = Scheduler::open(path, config()).unwrap();
    let view = s.plan_state("plan-1").unwrap().unwrap();
    assert_eq!(view.executions[0].gate, GateState::Closed);
    assert_eq!(view.executions[1].dispatch, DispatchState::Unsent);
}

#[test]
fn journal_action_projection_and_snapshot_tampering_are_detected() {
    for sql in [
        "UPDATE journal SET action_json='{}' WHERE event_seq=1",
        "UPDATE journal SET event_json='{}' WHERE event_seq=1",
        "UPDATE metadata SET snapshot_json='{}' WHERE singleton=1",
        "DELETE FROM journal WHERE event_seq=1",
    ] {
        let (_dir, path, s) = harness(config());
        drop(s);
        let raw = Connection::open(&path).unwrap();
        raw.execute_batch(sql).unwrap();
        drop(raw);
        assert!(matches!(
            Scheduler::open(&path, config()),
            Err(Error::Corrupt(_))
        ));
    }
}

#[test]
fn writer_lock_rejects_second_handles_and_symlink_aliases() {
    let (_dir, path, s) = harness(config());
    assert!(matches!(
        Scheduler::open(&path, config()),
        Err(Error::WriterLocked)
    ));
    #[cfg(unix)]
    {
        let alias = path.with_extension("alias");
        std::os::unix::fs::symlink(&path, &alias).unwrap();
        assert!(matches!(
            Scheduler::open(&alias, config()),
            Err(Error::WriterLocked)
        ));
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    drop(s);
    assert!(Scheduler::open(path, config()).is_ok());
}

fn child(mode: &str, path: &Path) -> std::process::ExitStatus {
    Command::new(std::env::current_exe().unwrap())
        .args(["--ignored", "--exact", "process_child", "--nocapture"])
        .env("FLEX_PHASE1_CHILD_MODE", mode)
        .env("FLEX_PHASE1_CHILD_DB", path)
        .status()
        .unwrap()
}

#[test]
fn another_process_cannot_become_a_second_writer() {
    let (_dir, path, _s) = harness(config());
    assert!(child("locked", &path).success());
}

#[test]
fn abrupt_process_exit_before_and_after_intent_has_safe_recovery() {
    for mode in ["before-intent", "after-intent"] {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("child.sqlite");
        assert_eq!(child(mode, &path).code(), Some(71));
        let mut s = Scheduler::open(&path, config()).unwrap();
        assert_eq!(s.snapshot().unwrap().mode, Mode::RecoveryRequired);
        if mode == "before-intent" {
            assert_eq!(s.snapshot().unwrap().capacity.inflight_requests, 0);
            s.activate(activation("epoch-2")).unwrap();
            assert_eq!(claim(&mut s).binding.execution_id, "exec-1-1");
        } else {
            assert_eq!(s.snapshot().unwrap().capacity.inflight_requests, 1);
            assert!(s.activate(activation("epoch-2")).is_err());
            s.record_epoch_isolation("epoch-1".into(), "test-process-exit-proof".into())
                .unwrap();
            s.activate(activation("epoch-2")).unwrap();
            assert_eq!(claim(&mut s).binding.execution_id, "exec-1-2");
        }
        assert_eq!(s.snapshot().unwrap(), s.replay_snapshot().unwrap());
    }
}

#[test]
#[ignore = "subprocess-only entrypoint; invoked by parent acceptance tests"]
fn process_child() {
    let mode = std::env::var("FLEX_PHASE1_CHILD_MODE").expect("parent invocation required");
    let path = std::env::var("FLEX_PHASE1_CHILD_DB").unwrap();
    if mode == "locked" {
        assert!(matches!(
            Scheduler::open(path, config()),
            Err(Error::WriterLocked)
        ));
        return;
    }
    let mut s = Scheduler::open(path, config()).unwrap();
    s.activate(activation("epoch-1")).unwrap();
    s.register(plan(1, GENESIS, 2)).unwrap();
    if mode == "after-intent" {
        claim(&mut s);
    }
    std::process::exit(71); // No Rust destructors / clean journal shutdown.
}

#[test]
fn plan_arrival_permutations_and_inflight_limits_preserve_the_same_order() {
    for order in [
        [0, 1, 2],
        [0, 2, 1],
        [1, 0, 2],
        [1, 2, 0],
        [2, 0, 1],
        [2, 1, 0],
    ] {
        for limit in 1..=3 {
            let mut c = config();
            c.max_inflight_requests = limit;
            let (_dir, _path, mut s) = harness(c);
            let p1 = plan(1, GENESIS, 2);
            let p2 = plan(2, &p1.manifest_hash, 2);
            let p3 = plan(3, &p2.manifest_hash, 2);
            let plans = [p1, p2, p3];
            for i in order {
                s.register(plans[i].clone()).unwrap();
            }
            let expected = [
                "exec-1-1", "exec-1-2", "exec-2-1", "exec-2-2", "exec-3-1", "exec-3-2",
            ];
            let mut active = std::collections::VecDeque::new();
            for execution_id in expected {
                if active.len() as u64 == limit {
                    let old = active.pop_front().unwrap();
                    s.observe(terminal(old, "epoch-1", 2)).unwrap();
                }
                assert_eq!(claim(&mut s).binding.execution_id, execution_id);
                s.observe(progress(execution_id, "epoch-1", 1)).unwrap();
                active.push_back(execution_id);
                assert!(s.snapshot().unwrap().capacity.inflight_requests <= limit);
                assert_eq!(s.snapshot().unwrap(), s.replay_snapshot().unwrap());
            }
            assert_blocked(&mut s, BlockReason::NoPlan);
        }
    }
}
