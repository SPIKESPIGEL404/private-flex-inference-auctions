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
use bitrouter_market::exchange::*;
use bitrouter_market::execution_contract::*;
use bitrouter_market::execution_coordinator::*;
use bitrouter_market::fake_authority::FakeAuthority;
use bitrouter_market::market_host::{HostError, MarketHost};
use bitrouter_market::order::*;

#[test]
fn explicit_worker_sends_once_then_polls_without_starting_or_reprocurement() {
    let (mut h, mut a, id) = cf::setup(false);
    let e = h.snapshot().now();
    assert_eq!(h.next_execution_timer_at().unwrap(), Some(e));
    assert_eq!(h.next_work_timer_at().unwrap(), Some(e));
    assert!(a.attempts().is_empty());
    assert_eq!(h.drive_execution_due(&mut a, 1).unwrap(), 1);
    let t = h.snapshot().purchase_trades().unwrap()[&id].clone();
    assert_eq!(t.accepted_at, Some(e));
    assert_eq!(t.started_at, None);
    assert_eq!(
        h.next_execution_timer_at().unwrap(),
        Some(UnixMillis(e.0 + 100))
    );
    assert_eq!(h.next_work_timer_at().unwrap(), Some(UnixMillis(e.0 + 100)));
    assert_eq!(h.drive_execution_due(&mut a, 10).unwrap(), 0);
    a.start("exchange", &id, UnixMillis(e.0 + 10)).unwrap();
    assert_eq!(
        h.tick_execution("clock".into(), UnixMillis(e.0 + 100), &mut a, 10)
            .unwrap(),
        2
    );
    assert_eq!(
        h.snapshot().purchase_trades().unwrap()[&id].started_at,
        Some(UnixMillis(e.0 + 10))
    );
    assert_eq!(h.snapshot().purchase_trades().unwrap().len(), 1);
    assert_eq!(a.attempts().len(), 1);
    assert_eq!(
        h.snapshot()
            .execution_requests()
            .unwrap()
            .values()
            .filter(|r| r.kind == ExecutionRequestKind::Submit)
            .count(),
        1
    );
}
#[test]
fn lost_accepted_response_is_recovered_by_new_query_effect_not_submit_resend() {
    let (mut h, mut a, id) = cf::setup(false);
    let e = h.snapshot().now();
    let submit = pf::request(&h, &id, ExecutionRequestKind::Submit);
    let _lost = h.dispatch(&submit.effect_id, &mut a).unwrap();
    assert!(h.snapshot().purchase_trades().unwrap()[&id].unknown);
    assert_eq!(h.snapshot().accounts()[&1].held(), MicroUsd(100));
    assert_eq!(
        h.tick_execution("early".into(), UnixMillis(e.0 + 19), &mut a, 10)
            .unwrap(),
        0
    );
    assert_eq!(
        h.tick_execution("due".into(), UnixMillis(e.0 + 20), &mut a, 10)
            .unwrap(),
        2
    );
    assert_eq!(
        h.snapshot().purchase_trades().unwrap()[&id].accepted_at,
        Some(e)
    );
    assert!(!h.snapshot().purchase_trades().unwrap()[&id].unknown);
    assert_eq!(h.snapshot().accounts()[&1].held(), MicroUsd(11));
    assert!(matches!(
        h.dispatch(&submit.effect_id, &mut a),
        Err(HostError::Unsent)
    ));
    assert_eq!(a.attempts().len(), 1);
}
#[test]
fn not_found_keeps_unknown_until_original_deadline_fence_and_ioc_never_reopens() {
    for ioc in [false, true] {
        let (mut h, mut a, id) = cf::setup(ioc);
        let e = h.snapshot().now();
        let until = h.snapshot().purchase_trades().unwrap()[&id].accept_before;
        let mut wrong =
            FakeAuthority::new(ReportAuthorityId(999), 1, Vec::new(), Vec::new(), e).unwrap();
        let before = h.snapshot();
        assert_eq!(h.drive_execution_due(&mut wrong, 10).unwrap(), 0);
        assert_eq!(h.snapshot(), before);
        // Explicitly model a transport failure after the original send marker.
        let submit = pf::request(&h, &id, ExecutionRequestKind::Submit);
        assert!(h.dispatch(&submit.effect_id, &mut wrong).is_err());
        assert_eq!(
            h.tick_execution("query".into(), UnixMillis(e.0 + 20), &mut a, 10)
                .unwrap(),
            2
        );
        let t = h.snapshot().purchase_trades().unwrap()[&id].clone();
        assert!(t.unknown);
        assert!(t.terminal.is_none());
        assert_eq!(h.snapshot().accounts()[&1].held(), MicroUsd(100));
        assert_eq!(
            h.tick_execution("expiry".into(), until, &mut a, 10)
                .unwrap(),
            2
        );
        let t = h.snapshot().purchase_trades().unwrap()[&id].clone();
        assert_eq!(t.settlement, ReservationSettlement::NotExecuted);
        assert_eq!(h.snapshot().occupancy(AdmissionScopeId(30)), 0);
        assert_eq!(h.next_execution_timer_at().unwrap(), None);
        assert_eq!(h.snapshot().purchase_trades().unwrap().len(), 1);
        assert_eq!(
            h.snapshot().accounts()[&1].held(),
            MicroUsd(if ioc { 0 } else { 100 })
        );
        assert_eq!(h.drive_execution_due(&mut a, 10).unwrap(), 0);
    }
}
#[test]
fn accepted_work_after_tif_is_queried_and_never_timed_out_fenced_or_released() {
    let (mut h, mut a, id) = cf::setup(false);
    h.drive_execution_due(&mut a, 10).unwrap();
    let until = h.snapshot().purchase_trades().unwrap()[&id].accept_before;
    h.tick_execution("later".into(), UnixMillis(until.0 + 100), &mut a, 10)
        .unwrap();
    assert_eq!(
        h.snapshot()
            .execution_requests()
            .unwrap()
            .values()
            .filter(|r| r.kind == ExecutionRequestKind::FenceUnaccepted)
            .count(),
        0
    );
    assert_eq!(h.snapshot().accounts()[&1].held(), MicroUsd(11));
    assert_eq!(h.snapshot().occupancy(AdmissionScopeId(30)), 1);
    assert!(h.snapshot().purchase_trades().unwrap()[&id]
        .terminal
        .is_none());
}
#[test]
fn operation_budget_can_stop_between_query_commit_and_send_and_resume_same_effect() {
    let (mut h, mut a, id) = cf::setup(false);
    let e = h.snapshot().now();
    h.drive_execution_due(&mut a, 1).unwrap();
    assert_eq!(
        h.tick_execution("due".into(), UnixMillis(e.0 + 100), &mut a, 1)
            .unwrap(),
        1
    );
    let request = pf::request(&h, &id, ExecutionRequestKind::Query);
    let expected = h.execution_work().unwrap();
    assert_eq!(
        expected[0].kind,
        ExecutionWorkKind::Dispatch {
            effect_id: request.effect_id.clone()
        }
    );
    let replay = MarketHost::replay(cf::bootstrap(), &h.journal()).unwrap();
    assert_eq!(replay.execution_work().unwrap(), expected);
    assert_eq!(h.drive_execution_due(&mut a, 1).unwrap(), 1);
    assert_eq!(h.snapshot().execution_requests().unwrap().len(), 2);
    assert!(h.snapshot().execution_request_sent(&request.effect_id));
}
#[test]
fn terminal_removes_polling_without_claiming_complete_result_and_replay_never_dispatches() {
    let (mut h, mut a, id) = cf::setup(false);
    let e = h.snapshot().now();
    h.drive_execution_due(&mut a, 10).unwrap();
    a.start("exchange", &id, e).unwrap();
    a.finish(
        "exchange",
        &id,
        ExecutionOutcome::Completed,
        Some(TokenUsage {
            uncached_input_tokens: 10,
            cached_input_tokens: 0,
            billable_output_tokens: 1,
        }),
        e,
    )
    .unwrap();
    h.tick_execution("done".into(), UnixMillis(e.0 + 100), &mut a, 10)
        .unwrap();
    assert!(h.execution_work().unwrap().is_empty());
    assert!(h.snapshot().purchase_result(&id).is_none());
    assert_eq!(
        MarketHost::replay(cf::bootstrap(), &h.journal())
            .unwrap()
            .snapshot(),
        h.snapshot()
    );
    assert!(MarketHost::replay(pf::bootstrap(false), &h.journal()).is_err());
}
#[test]
fn policy_is_explicit_bootstrap_only_and_invalid_ticks_do_not_change_clock_or_state() {
    let mut disabled = pf::bootstrap(false);
    assert_eq!(disabled.next_work_timer_at().unwrap(), None);
    assert!(matches!(
        disabled.execution_work(),
        Err(HostError::Coordination(CoordinationError::Disabled))
    ));
    let (_, mut a) = pf::setup(false, false);
    let before = disabled.snapshot();
    assert!(disabled
        .tick_execution(
            "disabled".into(),
            UnixMillis(before.now().0 + 1),
            &mut a,
            10
        )
        .is_err());
    assert_eq!(disabled.snapshot(), before);
    for field in 0..4 {
        let mut p = cf::policy();
        match field {
            0 => p.version += 1,
            1 => p.revision = 0,
            2 => p.query_interval_ms = 0,
            _ => p.unknown_retry_interval_ms = 0,
        };
        assert!(pf::bootstrap(false).with_execution_coordination(p).is_err());
    }
    let (mut h, mut a, _) = cf::setup(false);
    let before = h.snapshot();
    assert!(h.clone().with_execution_coordination(cf::policy()).is_err());
    assert!(h
        .tick_execution(
            "bad".into(),
            UnixMillis(before.now().0 + 1),
            &mut a,
            MAX_EXECUTION_WORK + 1
        )
        .is_err());
    assert_eq!(h.snapshot(), before);
}
#[test]
fn a_manual_query_before_initial_dispatch_does_not_discard_the_original_unsent_submit() {
    let (mut h, mut a, id) = cf::setup(false);
    fixture::run(
        &mut h,
        "manual-query",
        ExchangeCommand::Frozen(Box::new(FrozenCommand::Request {
            attempt: id.clone(),
            kind: ExecutionRequestKind::Query,
        })),
    );
    let submit = pf::request(&h, &id, ExecutionRequestKind::Submit);
    assert_eq!(
        h.execution_work().unwrap()[0].kind,
        ExecutionWorkKind::Dispatch {
            effect_id: submit.effect_id.clone()
        }
    );
    h.drive_execution_due(&mut a, 10).unwrap();
    assert!(h.snapshot().purchase_trades().unwrap()[&id]
        .accepted_at
        .is_some());
    assert_eq!(a.attempts().len(), 1);
}

#[test]
fn an_unsent_grant_past_its_original_window_is_fenced_without_ever_sending_submit() {
    let (mut h, mut a, id) = cf::setup(false);
    let submit = pf::request(&h, &id, ExecutionRequestKind::Submit);
    let until = submit.binding.accept_before;
    assert_eq!(
        h.tick_execution("expired".into(), until, &mut a, 10)
            .unwrap(),
        2
    );
    assert!(!h.snapshot().execution_request_sent(&submit.effect_id));
    assert_eq!(
        h.snapshot().purchase_trades().unwrap()[&id].settlement,
        ReservationSettlement::NotExecuted
    );
    assert!(a.attempts()[&("exchange".into(), id)].task_id.is_none());
}
#[test]
fn exhausted_timestamp_arithmetic_is_an_explicit_error_and_never_releases_accepted_work() {
    let (mut h, mut a, id) = cf::setup(false);
    h.drive_execution_due(&mut a, 10).unwrap();
    fixture::run(
        &mut h,
        "last-clock",
        ExchangeCommand::AdvanceTime(UnixMillis(u64::MAX)),
    );
    let report = pf::query(
        &mut h,
        &mut a,
        &id,
        ExecutionRequestKind::Query,
        "last-query",
    );
    h.receive("last-report".into(), a.origin(), report).unwrap();
    let before = h.snapshot();
    assert!(matches!(
        h.next_execution_timer_at(),
        Err(HostError::Coordination(CoordinationError::TimeOverflow))
    ));
    assert!(h.drive_execution_due(&mut a, 10).is_err());
    assert_eq!(h.snapshot(), before);
    assert_eq!(h.snapshot().accounts()[&1].held(), MicroUsd(0));
    assert!(h.snapshot().purchase_trades().unwrap()[&id]
        .terminal
        .is_none());
}
