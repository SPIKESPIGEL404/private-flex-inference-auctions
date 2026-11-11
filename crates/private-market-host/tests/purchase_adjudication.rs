use bitrouter_market::formal_order::PlaceFormalOrder;
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
use bitrouter_market::execution_authorization::*;
use bitrouter_market::execution_contract::*;
use bitrouter_market::market_host::{HostError, MarketHost};
use bitrouter_market::order::*;
use bitrouter_market::purchase_order::*;
use pf::*;

fn grant_setup(
    ioc: bool,
) -> (
    MarketHost,
    bitrouter_market::fake_authority::FakeAuthority,
    PlaceFormalOrder,
    ProposePurchase,
    AttemptId,
) {
    let (mut h, a) = setup(false, false);
    let r = registration("root", 1, &["a", "b"], ioc);
    register(&mut h, &r);
    let q = publication(&h, &r, 1, "a");
    publish(&mut h, &q);
    let p = proposal(&h, &r, &[q], "first");
    let granted = propose(&mut h, &p);
    let id = id(&granted);
    (h, a, r, p, id)
}
#[test]
fn g_freezes_single_selected_trade_effect_and_root_hold_then_e_releases_excess() {
    let (mut h, mut a, r, p, id) = grant_setup(false);
    let s = h.snapshot();
    assert_eq!(s.purchase_trades().unwrap().len(), 1);
    assert_eq!(s.execution_requests().unwrap().len(), 1);
    assert_eq!(s.accounts()[&1].held(), MicroUsd(100));
    assert_eq!(s.occupancy(AdmissionScopeId(30)), 1);
    assert!(s.purchase_trades().unwrap()[&id].accepted_at.is_none());
    let grant = &s.frozen_grants().unwrap()[&id];
    assert_eq!(grant.authorization.policy, PURCHASE_EXECUTION_POLICY);
    assert_eq!(grant.authorization.purchase.proposal_id, p.proposal_id);
    assert_eq!(grant.authorization.trade_cap, MicroUsd(11));
    let report = h
        .dispatch(
            &request(&h, &id, ExecutionRequestKind::Submit).effect_id,
            &mut a,
        )
        .unwrap();
    h.receive("accepted".into(), a.origin(), report).unwrap();
    let s = h.snapshot();
    assert_eq!(s.accounts()[&1].held(), MicroUsd(11));
    assert_eq!(
        s.purchase_orders().unwrap()[&r.authorization.binding.root]
            .funding()
            .unwrap()
            .released(),
        MicroUsd(89)
    );
    assert_eq!(
        s.purchase_orders().unwrap()[&r.authorization.binding.root]
            .closure()
            .unwrap()
            .reason,
        OrderClosureReason::Accepted
    );
}

#[test]
fn duplicate_proposal_identity_and_unresolved_root_cannot_create_another_g() {
    let (mut h, _a, r, p, id) = grant_setup(false);
    let before = h.snapshot();
    let first = before.purchase_decisions().unwrap()
        [&(r.authorization.binding.root.clone(), p.proposal_id.clone())]
        .receipt
        .clone();
    assert_eq!(propose(&mut h, &p), first);
    assert_eq!(h.snapshot(), before);
    let mut alternate_key = p.clone();
    alternate_key.idempotency_key = "new-transport-key".into();
    assert_eq!(propose(&mut h, &alternate_key), first);
    assert_eq!(h.snapshot().purchase_trades().unwrap().len(), 1);
    let mut next = p.clone();
    next.idempotency_key = "new-p".into();
    next.proposal_id = "new-p".into();
    next.decision_id = "new-d".into();
    next.basis.evidence = purchase_proposal_basis(&next).unwrap();
    assert!(matches!(
        h.execute(
            next.idempotency_key.clone(),
            ExchangeCommand::ProposePurchase(Box::new(next))
        ),
        Err(HostError::Market(ExchangeError::Conflict(
            "unresolved purchase"
        )))
    ));
    assert_eq!(
        h.snapshot().purchase_trades().unwrap().keys().next(),
        Some(&id)
    );
    let mut conflict = p.clone();
    conflict.candidates[0].source_generation += 1;
    assert!(h
        .execute(
            conflict.idempotency_key.clone(),
            ExchangeCommand::ProposePurchase(Box::new(conflict))
        )
        .is_err());
}

#[test]
fn list_can_skip_stale_first_candidate_but_never_procures_an_unlisted_model() {
    let (mut h, _) = setup(false, false);
    let r = registration("multi", 1, &["a", "b"], false);
    register(&mut h, &r);
    let qa = publication(&h, &r, 1, "qa");
    let qb = publication(&h, &r, 2, "qb");
    publish(&mut h, &qa);
    publish(&mut h, &qb);
    let p = proposal(&h, &r, &[qa.clone(), qb], "list");
    let newer = publication(&h, &r, 1, "newer-a");
    publish(&mut h, &newer);
    let result = propose(&mut h, &p);
    let id = id(&result);
    assert_eq!(id.market_id, "b");
    let s = h.snapshot();
    let decision = &s.purchase_decisions().unwrap()
        [&(r.authorization.binding.root.clone(), p.proposal_id.clone())];
    assert_eq!(decision.assessments.len(), 1);
    assert!(matches!(
        decision.assessments[0].rejection,
        CandidateRejection::EvidenceChanged { .. }
    ));
    assert_eq!(s.purchase_trades().unwrap().len(), 1);
    let r2 = registration("only-a", 2, &["a", "b"], false);
    register(&mut h, &r2);
    let qa = publication(&h, &r2, 1, "only-a");
    publish(&mut h, &qa);
    let p = proposal(&h, &r2, &[qa], "only-a");
    let fresh = publication(&h, &r2, 1, "fresher-a");
    publish(&mut h, &fresh);
    assert!(matches!(
        propose(&mut h, &p).result,
        PurchaseResult::StaleCandidates { .. }
    ));
    assert_eq!(h.snapshot().purchase_trades().unwrap().len(), 1);
}

#[test]
fn competition_starts_at_proposal_not_registration_and_failed_gtd_round_gets_new_sequence() {
    let (mut h, _) = setup(true, false);
    let early = registration("early-wait", 1, &["a", "b"], false);
    let later = registration("later-immediate", 2, &["a"], false);
    register(&mut h, &early);
    register(&mut h, &later);
    let qe = publication(&h, &early, 1, "early");
    let ql = publication(&h, &later, 1, "later");
    publish(&mut h, &qe);
    publish(&mut h, &ql);
    let pl = proposal(&h, &later, &[ql], "later-first");
    assert_eq!(propose(&mut h, &pl).competition_seq, 1);
    let pe = proposal(&h, &early, &[qe], "early-second");
    let result = propose(&mut h, &pe);
    assert_eq!(result.competition_seq, 2);
    assert!(matches!(
        result.result,
        PurchaseResult::NoOpportunity { .. }
    ));
    assert!(
        h.snapshot().purchase_orders().unwrap()[&early.authorization.binding.root]
            .closure()
            .is_none()
    );
    let mut new = pe;
    new.idempotency_key = "third".into();
    new.proposal_id = "third".into();
    new.decision_id = "third".into();
    new.basis.evidence = purchase_proposal_basis(&new).unwrap();
    assert_eq!(propose(&mut h, &new).competition_seq, 3);
}

#[test]
fn old_market_revision_does_not_reject_proposal_but_stale_prepared_plan_cannot_publish() {
    let (mut h, _) = setup(false, false);
    let r = registration("cas", 1, &["a"], false);
    register(&mut h, &r);
    let q = publication(&h, &r, 1, "cas");
    publish(&mut h, &q);
    let p = proposal(&h, &r, &[q], "cas");
    fixture::run(
        &mut h,
        "unrelated",
        ExchangeCommand::Credit {
            buyer_id: 3,
            amount: MicroUsd(1),
        },
    );
    let PrepareOutcome::Prepared(prepared) = h
        .prepare(
            p.idempotency_key.clone(),
            ExchangeCommand::ProposePurchase(Box::new(p.clone())),
        )
        .unwrap()
    else {
        panic!("prepared")
    };
    assert_eq!(prepared.record().grants().len(), 1);
    assert_eq!(prepared.record().effects().len(), 1);
    assert!(h.snapshot().purchase_trades().unwrap().is_empty());
    fixture::run(
        &mut h,
        "another-unrelated",
        ExchangeCommand::Credit {
            buyer_id: 3,
            amount: MicroUsd(1),
        },
    );
    assert!(matches!(
        h.publish(*prepared),
        Err(HostError::Market(ExchangeError::StalePlan))
    ));
    assert!(h.snapshot().purchase_trades().unwrap().is_empty());
    assert!(matches!(
        propose(&mut h, &p).result,
        PurchaseResult::Granted { .. }
    ));
}

#[test]
fn query_not_found_and_close_keep_unknown_responsibility_until_fence() {
    let (mut h, mut a, r, _p, id) = grant_setup(false);
    // Query is sent first; original Submit remains potentially in flight.
    let report = query(&mut h, &mut a, &id, ExecutionRequestKind::Query, "query");
    assert!(matches!(
        report.observation,
        ExecutionReportState::NotFound {}
    ));
    h.receive("not-found".into(), a.origin(), report).unwrap();
    assert!(h.snapshot().purchase_trades().unwrap()[&id].unknown);
    close(&mut h, &r, "stop");
    assert_eq!(h.snapshot().accounts()[&1].held(), MicroUsd(100));
    assert_eq!(h.snapshot().occupancy(AdmissionScopeId(30)), 1);
    let fence = query(
        &mut h,
        &mut a,
        &id,
        ExecutionRequestKind::FenceUnaccepted,
        "fence",
    );
    h.receive("fenced".into(), a.origin(), fence).unwrap();
    assert_eq!(h.snapshot().accounts()[&1].held(), MicroUsd(0));
    assert_eq!(h.snapshot().occupancy(AdmissionScopeId(30)), 0);
    let late = h
        .dispatch(
            &request(&h, &id, ExecutionRequestKind::Submit).effect_id,
            &mut a,
        )
        .unwrap();
    assert!(matches!(
        late.observation,
        ExecutionReportState::NotExecutedFence { .. }
    ));
}

#[test]
fn fence_allows_only_open_gtd_to_retry_and_never_reopens_ioc() {
    for ioc in [false, true] {
        let (mut h, mut a, r, _, id) = grant_setup(ioc);
        let fence = query(
            &mut h,
            &mut a,
            &id,
            ExecutionRequestKind::FenceUnaccepted,
            "fence",
        );
        h.receive("fenced".into(), a.origin(), fence).unwrap();
        let q = publication_for_closed_root(&h, &r);
        if !ioc {
            publish(&mut h, &q);
        }
        let p = proposal(&h, &r, &[q], "retry");
        let result = h.execute(
            p.idempotency_key.clone(),
            ExchangeCommand::ProposePurchase(Box::new(p)),
        );
        if ioc {
            assert!(matches!(
                result,
                Err(HostError::Market(ExchangeError::Closed))
            ));
            assert_eq!(h.snapshot().accounts()[&1].held(), MicroUsd(0));
        } else {
            let ExchangeReceipt::PurchaseDecided(result) = result.unwrap() else {
                panic!("decision")
            };
            let next = pf::id(&result);
            assert_eq!(next.order_id, id.order_id);
            assert_eq!(next.sequence, id.sequence + 1);
            assert_eq!(result.competition_seq, 2);
            assert_eq!(h.snapshot().accounts()[&1].held(), MicroUsd(100));
        }
    }
}
fn publication_for_closed_root(h: &MarketHost, r: &PlaceFormalOrder) -> PurchaseQuotePublication {
    publication(h, r, 1, "retry")
}

#[test]
fn completion_waits_for_delivery_and_invalid_usage_stays_pending() {
    for invalid in [false, true] {
        let (mut h, mut a, r, _p, id) = grant_setup(false);
        let report = h
            .dispatch(
                &request(&h, &id, ExecutionRequestKind::Submit).effect_id,
                &mut a,
            )
            .unwrap();
        h.receive("accepted".into(), a.origin(), report).unwrap();
        let now = h.snapshot().now();
        a.start("exchange", &id, now).unwrap();
        a.finish(
            "exchange",
            &id,
            ExecutionOutcome::Completed,
            Some(TokenUsage {
                uncached_input_tokens: if invalid { 9 } else { 10 },
                cached_input_tokens: 0,
                billable_output_tokens: 1,
            }),
            now,
        )
        .unwrap();
        let terminal = query(
            &mut h,
            &mut a,
            &id,
            ExecutionRequestKind::Query,
            "terminal-query",
        );
        h.receive("terminal".into(), a.origin(), terminal.clone())
            .unwrap();
        let expected = if invalid {
            ReservationSettlement::Pending
        } else {
            ReservationSettlement::AwaitingDelivery
        };
        assert_eq!(
            h.snapshot().purchase_trades().unwrap()[&id].settlement,
            expected
        );
        assert_eq!(h.snapshot().accounts()[&1].held(), MicroUsd(11));
        assert_eq!(h.snapshot().accounts()[&1].balance(), MicroUsd(1_000));
        assert_eq!(h.snapshot().occupancy(AdmissionScopeId(30)), 0);
        h.receive("terminal-again".into(), a.origin(), terminal)
            .unwrap();
        assert_eq!(h.snapshot().accounts()[&1].balance(), MicroUsd(1_000));
        assert!(
            h.snapshot().purchase_orders().unwrap()[&r.authorization.binding.root]
                .closure()
                .is_some()
        );
    }
}

#[test]
fn quote_ttl_at_g_does_not_shorten_e_and_late_acceptance_report_preserves_frozen_trade() {
    let (mut h, mut a) = setup(false, false);
    fixture::run(
        &mut h,
        "near-ttl",
        ExchangeCommand::AdvanceTime(UnixMillis(7_999)),
    );
    let r = registration("late", 1, &["a"], false);
    register(&mut h, &r);
    let q = publication(&h, &r, 1, "near-ttl");
    assert_eq!(q.quote.valid_until(), UnixMillis(8_000));
    publish(&mut h, &q);
    let p = proposal(&h, &r, &[q], "near-ttl");
    let id = id(&propose(&mut h, &p));
    assert_eq!(
        h.snapshot().purchase_trades().unwrap()[&id].accept_before,
        UnixMillis(8_499)
    );
    fixture::run(
        &mut h,
        "past-observation",
        ExchangeCommand::AdvanceTime(UnixMillis(8_001)),
    );
    let report = h
        .dispatch(
            &request(&h, &id, ExecutionRequestKind::Submit).effect_id,
            &mut a,
        )
        .unwrap();
    assert!(matches!(
        report.observation,
        ExecutionReportState::Accepted {
            accepted_at: UnixMillis(8_001)
        }
    ));
    fixture::run(
        &mut h,
        "past-root",
        ExchangeCommand::AdvanceTime(UnixMillis(9_001)),
    );
    h.receive("late-receipt".into(), a.origin(), report)
        .unwrap();
    assert_eq!(
        h.snapshot().purchase_trades().unwrap()[&id].accepted_at,
        Some(UnixMillis(8_001))
    );
    assert_eq!(h.snapshot().accounts()[&1].held(), MicroUsd(11));
}

#[test]
fn finite_xor_seller_choice_and_shared_physical_scope_are_not_copied_between_roots() {
    let (mut h, mut a) = setup(true, true);
    let r1 = registration("r1", 1, &["a"], false);
    let r2 = registration("r2", 2, &["b"], false);
    register(&mut h, &r1);
    register(&mut h, &r2);
    let q1 = publication(&h, &r1, 1, "r1");
    let q2 = publication(&h, &r2, 1, "r2");
    publish(&mut h, &q1);
    publish(&mut h, &q2);
    let p1 = proposal(&h, &r1, &[q1], "r1");
    let id = id(&propose(&mut h, &p1));
    let p2 = proposal(&h, &r2, &[q2], "r2");
    assert!(matches!(
        propose(&mut h, &p2).result,
        PurchaseResult::NoOpportunity { .. }
    ));
    let accepted = h
        .dispatch(
            &request(&h, &id, ExecutionRequestKind::Submit).effect_id,
            &mut a,
        )
        .unwrap();
    h.receive("accepted".into(), a.origin(), accepted).unwrap();
    assert!(
        h.snapshot().sells()[&fx::sell("seller", &["a", "b"]).reference]
            .allocation()
            .is_closed()
    );
    assert_eq!(h.snapshot().purchase_trades().unwrap().len(), 1);
}

#[test]
fn ioc_no_g_is_final_and_original_receipt_survives_retries() {
    let (mut h, _) = setup(false, false);
    let r = registration("ioc-no-g", 1, &["a"], true);
    register(&mut h, &r);
    let q = publication(&h, &r, 1, "ioc-old");
    publish(&mut h, &q);
    let p = proposal(&h, &r, &[q], "ioc-old");
    let fresh = publication(&h, &r, 1, "ioc-new");
    publish(&mut h, &fresh);
    let original = propose(&mut h, &p);
    assert!(matches!(
        original.result,
        PurchaseResult::StaleCandidates { .. }
    ));
    assert!(
        h.snapshot().purchase_orders().unwrap()[&r.authorization.binding.root]
            .closure()
            .is_some()
    );
    assert_eq!(h.snapshot().accounts()[&1].held(), MicroUsd(0));
    assert_eq!(propose(&mut h, &p), original);
    let next = proposal(&h, &r, &[fresh], "ioc-again");
    assert!(h
        .execute(
            next.idempotency_key.clone(),
            ExchangeCommand::ProposePurchase(Box::new(next))
        )
        .is_err());
    assert!(h.snapshot().purchase_trades().unwrap().is_empty());
}

#[test]
fn prepared_purchase_is_not_resolvable_and_changed_immutable_evidence_cannot_publish() {
    let (mut h, mut a) = setup(false, false);
    let r = registration("prepared", 1, &["a"], false);
    register(&mut h, &r);
    let q = publication(&h, &r, 1, "prepared");
    publish(&mut h, &q);
    let p = proposal(&h, &r, std::slice::from_ref(&q), "prepared");
    fixture::run(
        &mut h,
        "unrelated-time",
        ExchangeCommand::AdvanceTime(UnixMillis(3_001)),
    );
    let PrepareOutcome::Prepared(prepared) = h
        .prepare(
            p.idempotency_key.clone(),
            ExchangeCommand::ProposePurchase(Box::new(p)),
        )
        .unwrap()
    else {
        panic!("prepared")
    };
    let request = &prepared.record().effects()[0];
    assert!(a
        .handle(request, h.committed_grants(), h.snapshot().now())
        .is_err());
    assert!(a.attempts().is_empty());
    assert!(h.snapshot().purchase_trades().unwrap().is_empty());
    drop(prepared);
    let before = h.snapshot();
    let mut conflicting = q;
    conflicting.source_generation += 1;
    assert!(h
        .execute(
            "conflicting-evidence".into(),
            ExchangeCommand::PurchaseQuote(Box::new(conflicting))
        )
        .is_err());
    assert_eq!(h.snapshot(), before);
}

#[test]
fn close_and_market_withdrawal_after_g_do_not_revoke_frozen_authority_acceptance() {
    let (mut h, mut a, r, _, id) = grant_setup(false);
    close(&mut h, &r, "close-new-procurement");
    let seller = h.snapshot().sources()[&fixture::source("a")]
        .option
        .as_ref()
        .unwrap()
        .order
        .clone();
    fixture::run(&mut h, "withdraw", ExchangeCommand::Close(seller));
    let accepted = h
        .dispatch(
            &request(&h, &id, ExecutionRequestKind::Submit).effect_id,
            &mut a,
        )
        .unwrap();
    h.receive("accepted".into(), a.origin(), accepted).unwrap();
    assert_eq!(h.snapshot().accounts()[&1].held(), MicroUsd(11));
    assert!(h.snapshot().purchase_trades().unwrap()[&id]
        .accepted_at
        .is_some());
    assert_eq!(
        h.snapshot()
            .order_status(&r.authorization.binding.root)
            .unwrap(),
        OrderStatus::ClosedWithResponsibility
    );
}

#[test]
fn failed_and_cancelled_execution_keep_pending_funds_and_cannot_restore_purchase_right() {
    for outcome in [ExecutionOutcome::Failed, ExecutionOutcome::Cancelled] {
        let (mut h, mut a, r, original, id) = grant_setup(false);
        let accepted = h
            .dispatch(
                &request(&h, &id, ExecutionRequestKind::Submit).effect_id,
                &mut a,
            )
            .unwrap();
        h.receive("accepted".into(), a.origin(), accepted).unwrap();
        a.finish("exchange", &id, outcome, None, h.snapshot().now())
            .unwrap();
        let terminal = query(&mut h, &mut a, &id, ExecutionRequestKind::Query, "terminal");
        h.receive("terminal-report".into(), a.origin(), terminal)
            .unwrap();
        let s = h.snapshot();
        assert_eq!(
            s.purchase_trades().unwrap()[&id].settlement,
            ReservationSettlement::Pending
        );
        assert_eq!(s.accounts()[&1].held(), MicroUsd(11));
        assert_eq!(s.accounts()[&1].balance(), MicroUsd(1_000));
        assert_eq!(s.occupancy(AdmissionScopeId(30)), 0);
        assert_eq!(
            s.order_status(&r.authorization.binding.root).unwrap(),
            OrderStatus::ClosedWithPendingSettlement
        );
        let mut retry = original;
        retry.idempotency_key = "retry-after-execution".into();
        retry.proposal_id = "retry-after-execution".into();
        retry.decision_id = "retry-after-execution".into();
        retry.basis.evidence = purchase_proposal_basis(&retry).unwrap();
        assert!(h
            .execute(
                retry.idempotency_key.clone(),
                ExchangeCommand::ProposePurchase(Box::new(retry))
            )
            .is_err());
        assert_eq!(h.snapshot().purchase_trades().unwrap().len(), 1);
    }
}
