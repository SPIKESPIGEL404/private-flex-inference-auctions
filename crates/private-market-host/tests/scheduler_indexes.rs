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
#[path = "support/scheduler_oracle.rs"]
mod oracle;
#[allow(dead_code)]
#[path = "support/purchase_fixture.rs"]
mod pf;
#[allow(dead_code)]
#[path = "support/result_fixture.rs"]
mod rf;

use bitrouter_market::{
    admission::*,
    exchange::*,
    execution_contract::*,
    execution_coordinator::*,
    market_host::{HostError, MarketHost},
    order::*,
};

fn scan_timer(s: &ExchangeSnapshot) -> Option<UnixMillis> {
    s.purchase_trades()
        .into_iter()
        .flat_map(|d| d.values())
        .filter(|t| !t.settlement.is_final())
        .map(|t| t.delivery_deadline)
        .chain(
            s.purchase_orders()
                .into_iter()
                .flat_map(|d| d.values())
                .filter(|r| r.closure().is_none())
                .map(|r| r.receipt().window.decision_before),
        )
        .chain(
            s.seller_orders()
                .into_iter()
                .flat_map(|d| d.values())
                .filter(|r| r.closure().is_none())
                .map(|r| r.receipt().window.decision_before),
        )
        .chain(
            s.sources()
                .values()
                .filter(|supply| !supply.withdrawn && supply.ask.valid_until > s.now())
                .map(|supply| supply.ask.valid_until),
        )
        .chain(s.formal_next_timer_at())
        .min()
}
fn check(h: &MarketHost) {
    let s = h.snapshot_ref();
    let p = h.execution_coordination_policy().unwrap();
    let expected = oracle::scan_plan(&s, p);
    assert_eq!(plan(&s, p), expected);
    assert_eq!(
        h.execution_work().map_err(|e| match e {
            HostError::Coordination(e) => e,
            _ => panic!("unexpected host error"),
        }),
        expected
    );
    assert_eq!(h.next_timer_at(), scan_timer(&s));
    if let Ok(expected) = expected {
        assert_eq!(
            h.next_execution_timer_at().unwrap(),
            expected.first().map(|w| w.at)
        );
        for origin in [
            (ReportAuthorityId(7), 4),
            (ReportAuthorityId(7), 5),
            (ReportAuthorityId(999), 1),
        ] {
            let filtered: Vec<_> = expected
                .iter()
                .filter(|w| {
                    let b = &s.frozen_grants().unwrap()[&w.attempt].authorization.binding;
                    (b.authority_id, b.source_epoch) == origin
                })
                .cloned()
                .collect();
            assert_eq!(h.execution_work_for(origin).unwrap(), filtered);
            for budget in [1, 2, MAX_EXECUTION_WORK] {
                let due: Vec<_> = filtered
                    .iter()
                    .filter(|w| w.at <= s.now())
                    .take(budget)
                    .cloned()
                    .collect();
                assert_eq!(
                    h.execution_work_due_for(origin, s.now(), budget).unwrap(),
                    due
                );
            }
            assert_eq!(
                h.next_execution_timer_at_for(origin).unwrap(),
                filtered.first().map(|w| w.at)
            );
            let pending: Vec<_> = s
                .purchase_trades()
                .unwrap()
                .values()
                .filter(|t| !t.settlement.is_final())
                .filter(|t| {
                    let b = &s.frozen_grants().unwrap()[&t.id].authorization.binding;
                    (b.authority_id, b.source_epoch) == origin
                })
                .map(|t| &t.id)
                .collect();
            assert_eq!(
                s.pending_result_trades_for(origin)
                    .map(|t| &t.id)
                    .collect::<Vec<_>>(),
                pending
            );
        }
    }
    let mut alternate = p.clone();
    alternate.query_interval_ms = u64::MAX;
    alternate.unknown_retry_interval_ms = u64::MAX;
    assert_eq!(plan(&s, &alternate), oracle::scan_plan(&s, &alternate));
}
fn add_trade(h: &mut MarketHost, market: &str, owner: u64, label: &str) -> AttemptId {
    let r = pf::registration(label, owner, &[market], false);
    pf::register(h, &r);
    let q = pf::publication(h, &r, 1, label);
    pf::publish(h, &q);
    let p = pf::proposal(h, &r, &[q], label);
    pf::id(&pf::propose(h, &p))
}

#[test]
fn indexed_planner_matches_scan_through_manual_effects_deadlines_and_unknown_financial_closure() {
    let (mut h, mut a, id) = cf::setup(false);
    check(&h);
    // Sequence 10 sorts before 2 by EffectId; latest must use metadata sequence.
    for n in 0..16 {
        fixture::run(
            &mut h,
            &format!("manual-{n}"),
            ExchangeCommand::Frozen(Box::new(FrozenCommand::Request {
                attempt: id.clone(),
                kind: ExecutionRequestKind::Query,
            })),
        );
        check(&h);
    }
    let submit = pf::request(&h, &id, ExecutionRequestKind::Submit);
    h.dispatch(&submit.effect_id, &mut a).unwrap(); // response deliberately lost
    check(&h);
    let deadline = h.snapshot_ref().purchase_trades().unwrap()[&id].delivery_deadline;
    h.execute(
        "past-delivery".into(),
        ExchangeCommand::AdvanceTime(deadline),
    )
    .unwrap();
    check(&h);
    let s = h.snapshot_ref();
    assert!(matches!(
        s.purchase_trades().unwrap()[&id].settlement,
        ReservationSettlement::ClosedUnpaid { .. }
    ));
    assert_eq!(s.pending_result_trades_for(a.origin()).count(), 0);
    assert_eq!(
        s.purchase_trades()
            .unwrap()
            .values()
            .filter(|t| t.terminal.is_none())
            .count(),
        1
    );
    assert!(!h.execution_work().unwrap().is_empty());
    let recovered: MarketHost = serde_json::from_slice(&serde_json::to_vec(&h).unwrap()).unwrap();
    assert_eq!(recovered, h);
    check(&recovered);
}

#[test]
fn due_queue_preserves_ties_origin_budget_and_staged_clock_visibility() {
    let (mut h, _a, _) = cf::setup(false);
    let _second = add_trade(&mut h, "b", 2, "second");
    check(&h);
    let original = h.execution_work().unwrap();
    assert_eq!(original.len(), 2);
    assert_eq!(original[0].at, original[1].at);
    assert!(original[0].attempt < original[1].attempt);
    let deadline = h
        .snapshot_ref()
        .purchase_trades()
        .unwrap()
        .values()
        .map(|t| t.accept_before)
        .max()
        .unwrap();
    let PrepareOutcome::Prepared(p) = h
        .prepare(
            "prepared-clock".into(),
            ExchangeCommand::AdvanceTime(deadline),
        )
        .unwrap()
    else {
        panic!()
    };
    assert_eq!(h.execution_work().unwrap(), original);
    check(&h);
    h.publish(*p).unwrap();
    check(&h);
    assert!(h.execution_work().unwrap().iter().all(|w| matches!(
        w.kind,
        ExecutionWorkKind::Request {
            kind: ExecutionRequestKind::FenceUnaccepted,
            ..
        }
    )));
    let before = h.snapshot();
    for budget in [0, MAX_EXECUTION_WORK + 1] {
        assert!(matches!(
            h.execution_work_due_for((ReportAuthorityId(7), 1), deadline, budget),
            Err(HostError::Coordination(CoordinationError::InvalidBudget))
        ));
    }
    assert_eq!(h.snapshot(), before);
}

#[test]
fn one_clock_jump_reduces_multiple_delivery_deadlines_and_rebuilds_old_serialization() {
    let (mut h, mut a, first) = cf::setup(false);
    h.drive_execution_due(&mut a, 1).unwrap();
    h.execute(
        "one-ms".into(),
        ExchangeCommand::AdvanceTime(UnixMillis(h.snapshot_ref().now().0 + 1)),
    )
    .unwrap();
    let second = add_trade(&mut h, "b", 2, "second-deadline");
    let deadlines: Vec<_> = h
        .snapshot_ref()
        .purchase_trades()
        .unwrap()
        .values()
        .map(|t| t.delivery_deadline)
        .collect();
    assert_ne!(deadlines[0], deadlines[1]);
    let at = *deadlines.iter().max().unwrap();
    let mut rebuilt: MarketHost = serde_json::from_slice(&serde_json::to_vec(&h).unwrap()).unwrap();
    for host in [&mut h, &mut rebuilt] {
        host.execute("jump-all".into(), ExchangeCommand::AdvanceTime(at))
            .unwrap();
        check(host);
        for id in [&first, &second] {
            assert_eq!(
                host.snapshot_ref().purchase_trades().unwrap()[id].settlement,
                ReservationSettlement::ClosedUnpaid { closed_at: at }
            );
        }
    }
    assert_eq!(rebuilt, h);
}

#[test]
fn corrupt_serialized_effect_or_grant_is_an_error_without_panicking() {
    let (mut h, _, id) = cf::setup(false);
    fixture::run(
        &mut h,
        "extra-effect",
        ExchangeCommand::Frozen(Box::new(FrozenCommand::Request {
            attempt: id,
            kind: ExecutionRequestKind::Query,
        })),
    );
    for field in ["effects", "grants"] {
        let mut value = serde_json::to_value(&h).unwrap();
        value["kernel"]["state"]["frozen"][field] = serde_json::json!([]);
        let decoded = std::panic::catch_unwind(|| serde_json::from_value::<MarketHost>(value));
        assert!(decoded.is_ok(), "corrupt {field} panicked");
        assert!(decoded.unwrap().is_err());
    }
    let mut value = serde_json::to_value(&h).unwrap();
    value["kernel"]["state"]["frozen"]["request_metadata"]
        .as_array_mut()
        .unwrap()
        .remove(0);
    assert!(serde_json::from_value::<MarketHost>(value).is_err());
}

#[test]
fn terminal_keeps_result_job_until_complete_bytes_are_committed() {
    let (mut h, mut a, id) = cf::setup(false);
    h.drive_execution_due(&mut a, 1).unwrap();
    let now = h.snapshot_ref().now();
    let usage = TokenUsage {
        uncached_input_tokens: 10,
        cached_input_tokens: 0,
        billable_output_tokens: 1,
    };
    a.start("exchange", &id, now).unwrap();
    a.finish(
        "exchange",
        &id,
        ExecutionOutcome::Completed,
        Some(usage),
        now,
    )
    .unwrap();
    let report = pf::query(
        &mut h,
        &mut a,
        &id,
        ExecutionRequestKind::Query,
        "completed-query",
    );
    h.receive("completed-report".into(), a.origin(), report)
        .unwrap();
    check(&h);
    assert!(h.execution_work().unwrap().is_empty());
    assert_eq!(
        h.snapshot_ref()
            .pending_result_trades_for(a.origin())
            .count(),
        1
    );
    let auth = h.snapshot_ref().frozen_grants().unwrap()[&id]
        .authorization
        .clone();
    let validator = rf::FixtureValidator::new(&auth);
    h.publish_purchase_result(
        "result".into(),
        auth.binding.clone(),
        rf::body(&auth, usage),
        &validator,
    )
    .unwrap();
    check(&h);
    assert_eq!(
        h.snapshot_ref()
            .pending_result_trades_for(a.origin())
            .count(),
        0
    );
}

#[test]
fn disabled_coordination_keeps_business_timer_and_result_projection_available() {
    let (mut h, _, id) = cf::setup(false);
    // Replay the same committed domain commands on an explicitly disabled host.
    let mut disabled = pf::bootstrap(false);
    for (key, c) in h.journal().commands() {
        disabled.execute(key.clone(), c.clone()).unwrap();
    }
    assert_eq!(disabled.next_timer_at(), h.next_timer_at());
    assert_eq!(
        disabled.next_work_timer_at().unwrap(),
        disabled.next_timer_at()
    );
    assert!(matches!(
        disabled.next_execution_timer_at(),
        Err(HostError::Coordination(CoordinationError::Disabled))
    ));
    let until = h.snapshot_ref().purchase_trades().unwrap()[&id].delivery_deadline;
    for host in [&mut h, &mut disabled] {
        host.execute("expire".into(), ExchangeCommand::AdvanceTime(until))
            .unwrap();
        assert_eq!(host.next_timer_at(), scan_timer(&host.snapshot_ref()));
    }
    assert_eq!(disabled.snapshot(), h.snapshot());
}

#[test]
fn direct_snapshot_roundtrip_rebuilds_public_plan_jobs_and_preserves_historical_grants() {
    let (mut h, a, first) = cf::setup(false);
    let _second = add_trade(&mut h, "b", 2, "snapshot-second");
    for n in 0..12 {
        fixture::run(
            &mut h,
            &format!("snapshot-query-{n}"),
            ExchangeCommand::Frozen(Box::new(FrozenCommand::Request {
                attempt: first.clone(),
                kind: ExecutionRequestKind::Query,
            })),
        );
    }
    let expected = h.snapshot_ref();
    let bytes = serde_json::to_vec(&expected).unwrap();
    let restored: ExchangeSnapshot<'static> = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(restored, expected);
    assert_eq!(
        plan(&restored, &cf::policy()),
        plan(&expected, &cf::policy())
    );
    assert_eq!(
        plan(&restored, &cf::policy()),
        oracle::scan_plan(&expected, &cf::policy())
    );
    assert_eq!(
        restored
            .pending_result_trades_for(a.origin())
            .collect::<Vec<_>>(),
        expected
            .pending_result_trades_for(a.origin())
            .collect::<Vec<_>>()
    );
    assert_eq!(restored.pending_result_trades_for(a.origin()).count(), 2);
    assert_eq!(restored.frozen_grants(), expected.frozen_grants());
    assert_eq!(restored.execution_requests(), expected.execution_requests());
    assert_eq!(
        restored.execution_request_metadata(),
        expected.execution_request_metadata()
    );
    assert_eq!(
        restored.formal_next_timer_at(),
        expected.formal_next_timer_at()
    );
    assert_eq!(serde_json::to_vec(&restored).unwrap(), bytes);
    // The snapshot entry point also rejects a corrupt historical effect before
    // projection can hide it, just like the enclosing Exchange/Host entry point.
    let mut corrupt = serde_json::to_value(&expected).unwrap();
    corrupt["state"]["frozen"]["request_metadata"]
        .as_array_mut()
        .unwrap()
        .remove(0);
    assert!(serde_json::from_value::<ExchangeSnapshot<'static>>(corrupt).is_err());
}
