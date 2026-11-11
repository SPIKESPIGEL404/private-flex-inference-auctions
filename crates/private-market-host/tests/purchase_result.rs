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
#[allow(dead_code)]
#[path = "support/result_fixture.rs"]
mod rf;
use bitrouter_market::admission::*;
use bitrouter_market::exchange::*;
use bitrouter_market::execution_contract::*;
use bitrouter_market::fake_authority::FakeAuthority;
use bitrouter_market::market_host::{HostError, MarketHost};
use bitrouter_market::order::*;
use bitrouter_market::purchase_result::*;
use pf::*;
fn usage() -> TokenUsage {
    TokenUsage {
        uncached_input_tokens: 10,
        cached_input_tokens: 0,
        billable_output_tokens: 1,
    }
}
fn setup_result() -> (MarketHost, FakeAuthority, AttemptId, ExecutionBinding) {
    let (mut h, mut a) = setup(false, false);
    let r = registration("result", 1, &["a"], false);
    register(&mut h, &r);
    let q = publication(&h, &r, 1, "result");
    publish(&mut h, &q);
    let p = proposal(&h, &r, &[q], "result");
    let id = id(&propose(&mut h, &p));
    let report = h
        .dispatch(
            &request(&h, &id, ExecutionRequestKind::Submit).effect_id,
            &mut a,
        )
        .unwrap();
    let binding = report.binding.clone();
    h.receive("accepted".into(), a.origin(), report).unwrap();
    let now = h.snapshot().now();
    a.start("exchange", &id, now).unwrap();
    a.first_response("exchange", &id, now).unwrap();
    (h, a, id, binding)
}
fn finish(
    h: &mut MarketHost,
    a: &mut FakeAuthority,
    id: &AttemptId,
    outcome: ExecutionOutcome,
    usage: Option<TokenUsage>,
) {
    a.finish("exchange", id, outcome, usage, h.snapshot().now())
        .unwrap();
    let report = query(h, a, id, ExecutionRequestKind::Query, "terminal-query");
    h.receive("terminal".into(), a.origin(), report).unwrap();
}
fn advance(h: &mut MarketHost, n: u64) {
    fixture::run(
        h,
        &format!("clock/{n}"),
        ExchangeCommand::AdvanceTime(UnixMillis(n)),
    );
}
#[test]
fn engine_finish_does_not_claim_market_delivery_and_verified_bytes_commit_at_actual_time() {
    let (mut h, mut a, id, binding) = setup_result();
    let e = h.snapshot().now();
    finish(
        &mut h,
        &mut a,
        &id,
        ExecutionOutcome::Completed,
        Some(usage()),
    );
    let obs = h.snapshot().purchase_service_observation(&id).unwrap();
    assert_eq!(obs.accepted_at, Some(e));
    assert_eq!(obs.engine_ended_at, Some(e));
    assert_eq!(obs.adjudicated_at, None);
    assert_eq!(obs.completion_target_met, None);
    assert!(h.snapshot().purchase_result(&id).is_none());
    let auth = h.snapshot().frozen_grants().unwrap()[&id]
        .authorization
        .clone();
    let bytes = rf::body(&auth, usage());
    let validator = rf::FixtureValidator::new(&auth);
    let delivery_time = obs.completion_target_at.unwrap().0 + 1;
    advance(&mut h, delivery_time);
    let before = h.snapshot().accounts()[&1].clone();
    let receipt = h
        .publish_purchase_result("result/1".into(), binding, bytes.clone(), &validator)
        .unwrap();
    let ExchangeReceipt::PurchaseResultConfirmed(receipt) = receipt else {
        panic!("result receipt")
    };
    assert_eq!(receipt.adjudicated_at, UnixMillis(delivery_time));
    let snapshot = h.snapshot();
    let stored = snapshot.purchase_result(&id).unwrap();
    assert_eq!(stored.publication.bytes(), bytes);
    assert_eq!(stored.publication.artifact(), &receipt.artifact);
    assert_eq!(
        snapshot
            .purchase_service_observation(&id)
            .unwrap()
            .completion_target_met,
        Some(false)
    );
    assert_eq!(snapshot.accounts()[&1].balance().0, before.balance().0 - 11);
    assert_eq!(snapshot.accounts()[&1].held(), MicroUsd(0));
    assert_eq!(snapshot.occupancy(AdmissionScopeId(30)), 0);
    assert_eq!(validator.calls.get(), 1);
    assert_eq!(
        MarketHost::replay(bootstrap(false), &h.journal())
            .unwrap()
            .snapshot(),
        snapshot
    );
}

type DeliveryTest = Result<(), Box<dyn std::error::Error>>;
fn frozen_auth(
    h: &MarketHost,
    id: &AttemptId,
) -> Result<
    bitrouter_market::execution_authorization::ExecutionAuthorization,
    Box<dyn std::error::Error>,
> {
    Ok(h.snapshot()
        .frozen_grants()
        .and_then(|m| m.get(id))
        .ok_or("grant missing")?
        .authorization
        .clone())
}
fn delivery_trade(
    h: &MarketHost,
    id: &AttemptId,
) -> Result<PurchaseTradeRecord, Box<dyn std::error::Error>> {
    Ok(h.snapshot()
        .purchase_trades()
        .and_then(|m| m.get(id))
        .ok_or("trade missing")?
        .clone())
}

#[test]
fn completed_usage_holds_money_until_qualified_publication_and_confirms_provider_earnings(
) -> DeliveryTest {
    let (mut h, mut a, id, b) = setup_result();
    let before = h.snapshot().accounts()[&1].clone();
    finish(
        &mut h,
        &mut a,
        &id,
        ExecutionOutcome::Completed,
        Some(usage()),
    );
    let t = delivery_trade(&h, &id)?;
    assert_eq!(t.settlement, ReservationSettlement::AwaitingDelivery);
    assert_eq!(h.snapshot().accounts()[&1], before);
    assert_eq!(
        h.snapshot().provider_earned(t.source.ask.provider_id),
        MicroUsd(0)
    );
    let auth = frozen_auth(&h, &id)?;
    h.publish_purchase_result(
        "atomic-delivery".into(),
        b,
        rf::body(&auth, usage()),
        &rf::FixtureValidator::new(&auth),
    )?;
    assert_eq!(
        h.snapshot().accounts()[&1].balance().0,
        before.balance().0 - 11
    );
    assert_eq!(h.snapshot().accounts()[&1].held(), MicroUsd(0));
    assert_eq!(
        h.snapshot().provider_earned(t.source.ask.provider_id),
        MicroUsd(11)
    );
    assert!(h.snapshot().purchase_result(&id).is_some());
    Ok(())
}

#[test]
fn strict_hard_deadline_accepts_before_and_rejects_at_or_after_without_provider_income(
) -> DeliveryTest {
    for offset in [-1_i64, 0, 1] {
        let (mut h, mut a, id, b) = setup_result();
        finish(
            &mut h,
            &mut a,
            &id,
            ExecutionOutcome::Completed,
            Some(usage()),
        );
        let t = delivery_trade(&h, &id)?;
        let auth = frozen_auth(&h, &id)?;
        h.execute(
            format!("clock/{offset}"),
            ExchangeCommand::AdvanceTime(UnixMillis(
                t.delivery_deadline.0.saturating_add_signed(offset),
            )),
        )?;
        let r = h.publish_purchase_result(
            "publish".into(),
            b.clone(),
            rf::body(&auth, usage()),
            &rf::FixtureValidator::new(&auth),
        )?;
        if offset < 0 {
            assert!(matches!(r, ExchangeReceipt::PurchaseResultConfirmed(_)));
            assert_eq!(
                h.snapshot().provider_earned(t.source.ask.provider_id),
                MicroUsd(11)
            );
        } else {
            assert!(matches!(r, ExchangeReceipt::PurchaseResultExpired { .. }));
            assert_eq!(h.snapshot().accounts()[&1].balance(), MicroUsd(1000));
            assert_eq!(
                h.snapshot().provider_earned(t.source.ask.provider_id),
                MicroUsd(0)
            );
            assert!(h.snapshot().purchase_result(&id).is_none());
        }
        assert_eq!(h.snapshot().accounts()[&1].held(), MicroUsd(0));
        assert_eq!(
            h.publish_purchase_result(
                "publish".into(),
                b,
                rf::body(&auth, usage()),
                &rf::FixtureValidator::new(&auth)
            )?,
            r
        );
    }
    Ok(())
}

#[test]
fn expired_finances_keep_unknown_execution_and_occupancy_without_inventing_a_terminal(
) -> DeliveryTest {
    let (mut h, _a, id, _b) = setup_result();
    let t = delivery_trade(&h, &id)?;
    h.execute(
        "clock/deadline".into(),
        ExchangeCommand::AdvanceTime(t.delivery_deadline),
    )?;
    let closed = delivery_trade(&h, &id)?;
    assert!(matches!(
        closed.settlement,
        ReservationSettlement::ClosedUnpaid { .. }
    ));
    assert!(closed.terminal.is_none());
    assert_eq!(closed.accepted_at, t.accepted_at);
    assert_eq!(h.snapshot().occupancy(AdmissionScopeId(30)), 1);
    assert_eq!(h.snapshot().accounts()[&1].balance(), MicroUsd(1000));
    assert_eq!(h.snapshot().accounts()[&1].held(), MicroUsd(0));
    h.execute(
        "clock/deadline-again".into(),
        ExchangeCommand::AdvanceTime(UnixMillis(t.delivery_deadline.0 + 100)),
    )?;
    assert_eq!(delivery_trade(&h, &id)?.settlement, closed.settlement);
    Ok(())
}

#[test]
fn late_terminal_and_usage_cannot_reopen_expired_money_or_earnings() -> DeliveryTest {
    let (mut h, mut a, id, b) = setup_result();
    let t = delivery_trade(&h, &id)?;
    let auth = frozen_auth(&h, &id)?;
    h.execute(
        "expired".into(),
        ExchangeCommand::AdvanceTime(t.delivery_deadline),
    )?;
    let closed = delivery_trade(&h, &id)?.settlement;
    finish(
        &mut h,
        &mut a,
        &id,
        ExecutionOutcome::Completed,
        Some(usage()),
    );
    assert_eq!(delivery_trade(&h, &id)?.settlement, closed);
    assert_eq!(h.snapshot().occupancy(AdmissionScopeId(30)), 0);
    assert!(matches!(
        h.publish_purchase_result(
            "late".into(),
            b,
            rf::body(&auth, usage()),
            &rf::FixtureValidator::new(&auth)
        )?,
        ExchangeReceipt::PurchaseResultExpired { .. }
    ));
    assert_eq!(h.snapshot().accounts()[&1].balance(), MicroUsd(1000));
    assert_eq!(h.snapshot().accounts()[&1].held(), MicroUsd(0));
    assert_eq!(
        h.snapshot().provider_earned(t.source.ask.provider_id),
        MicroUsd(0)
    );
    Ok(())
}

#[test]
fn original_paid_receipt_retries_after_deadline_do_not_expire_or_recharge() -> DeliveryTest {
    let (mut h, mut a, id, b) = setup_result();
    finish(
        &mut h,
        &mut a,
        &id,
        ExecutionOutcome::Completed,
        Some(usage()),
    );
    let auth = frozen_auth(&h, &id)?;
    let bytes = rf::body(&auth, usage());
    let validator = rf::FixtureValidator::new(&auth);
    let r = h.publish_purchase_result("paid".into(), b.clone(), bytes.clone(), &validator)?;
    let balance = h.snapshot().accounts()[&1].clone();
    h.execute(
        "after-deadline".into(),
        ExchangeCommand::AdvanceTime(UnixMillis(auth.purchase.delivery_deadline.0 + 1)),
    )?;
    validator.reject.set(true);
    assert_eq!(
        h.publish_purchase_result("paid".into(), b.clone(), bytes.clone(), &validator)?,
        r
    );
    assert_eq!(
        h.publish_purchase_result("paid-new-ack-key".into(), b, bytes, &validator)?,
        r
    );
    assert_eq!(h.snapshot().accounts()[&1], balance);
    assert_eq!(validator.calls.get(), 1);
    Ok(())
}

#[test]
fn queued_preparation_cannot_backdate_delivery_across_the_deadline() -> DeliveryTest {
    let (mut h, mut a, id, b) = setup_result();
    finish(
        &mut h,
        &mut a,
        &id,
        ExecutionOutcome::Completed,
        Some(usage()),
    );
    let auth = frozen_auth(&h, &id)?;
    let bytes = rf::body(&auth, usage());
    let validator = rf::FixtureValidator::new(&auth);
    let prepared =
        h.prepare_purchase_result("stale-result".into(), b.clone(), bytes.clone(), &validator)?;
    h.execute(
        "cross-deadline".into(),
        ExchangeCommand::AdvanceTime(auth.purchase.delivery_deadline),
    )?;
    if let bitrouter_market::exchange::PrepareOutcome::Prepared(p) = prepared {
        assert!(h.publish(*p).is_err());
    } else {
        return Err("expected a prepared publication".into());
    }
    assert!(matches!(
        h.publish_purchase_result("stale-result".into(), b, bytes, &validator)?,
        ExchangeReceipt::PurchaseResultExpired { .. }
    ));
    assert_eq!(h.snapshot().accounts()[&1].balance(), MicroUsd(1000));
    Ok(())
}

#[test]
fn buyer_wait_bound_rejects_slower_service_without_a_grant() -> DeliveryTest {
    let (mut h, _) = setup(false, false);
    let mut r = registration("impatient", 1, &["a"], false);
    r.authorization.max_adjudication_wait_ms = 59_999;
    register(&mut h, &r);
    let q = publication(&h, &r, 1, "too-slow");
    assert!(h
        .execute(
            "slow-quote".into(),
            ExchangeCommand::PurchaseQuote(Box::new(q))
        )
        .is_err());
    assert!(h.snapshot().purchase_trades().is_some_and(|t| t.is_empty()));
    Ok(())
}
#[test]
fn original_qualification_and_completion_time_survive_retries_without_revalidation() {
    let (mut h, mut a, id, binding) = setup_result();
    finish(
        &mut h,
        &mut a,
        &id,
        ExecutionOutcome::Completed,
        Some(usage()),
    );
    let auth = h.snapshot().frozen_grants().unwrap()[&id]
        .authorization
        .clone();
    let bytes = rf::body(&auth, usage());
    let validator = rf::FixtureValidator::new(&auth);
    let receipt = h
        .publish_purchase_result(
            "result/1".into(),
            binding.clone(),
            bytes.clone(),
            &validator,
        )
        .unwrap();
    validator.reject.set(true);
    let revision = h.snapshot().revision();
    assert_eq!(
        h.publish_purchase_result(
            "result/1".into(),
            binding.clone(),
            bytes.clone(),
            &validator
        )
        .unwrap(),
        receipt
    );
    assert_eq!(h.snapshot().revision(), revision);
    advance(&mut h, auth.binding.created_at.0 + 100);
    assert_eq!(
        h.publish_purchase_result(
            "result/alternate".into(),
            binding.clone(),
            bytes,
            &validator
        )
        .unwrap(),
        receipt
    );
    assert_eq!(validator.calls.get(), 1);
    assert!(h
        .publish_purchase_result(
            "result/conflict".into(),
            binding,
            b"changed".to_vec(),
            &validator
        )
        .is_err());
    assert_eq!(validator.calls.get(), 1);
}
#[test]
fn pending_failed_missing_or_invalid_usage_cannot_become_a_delivered_result() {
    for outcome in [
        None,
        Some((ExecutionOutcome::Failed, Some(usage()))),
        Some((ExecutionOutcome::Completed, None)),
        Some((
            ExecutionOutcome::Completed,
            Some(TokenUsage {
                uncached_input_tokens: 11,
                ..usage()
            }),
        )),
    ] {
        let (mut h, mut a, id, binding) = setup_result();
        if let Some((o, u)) = outcome {
            finish(&mut h, &mut a, &id, o, u);
        }
        let auth = h.snapshot().frozen_grants().unwrap()[&id]
            .authorization
            .clone();
        let validator = rf::FixtureValidator::new(&auth);
        let before = h.snapshot();
        assert!(h
            .publish_purchase_result("bad".into(), binding, rf::body(&auth, usage()), &validator)
            .is_err());
        assert_eq!(h.snapshot(), before);
        assert_eq!(validator.calls.get(), 0);
    }
}
#[test]
fn validator_rejects_wrong_complete_contract_and_size_binding_and_protocol_fail_closed() {
    let (mut h, mut a, id, binding) = setup_result();
    finish(
        &mut h,
        &mut a,
        &id,
        ExecutionOutcome::Completed,
        Some(usage()),
    );
    let auth = h.snapshot().frozen_grants().unwrap()[&id]
        .authorization
        .clone();
    let mut validator = rf::FixtureValidator::new(&auth);
    let before = h.snapshot();
    for bytes in [
        b"last-token".to_vec(),
        vec![0; MAX_PURCHASE_RESULT_BYTES + 1],
        {
            let mut body: serde_json::Value =
                serde_json::from_slice(&rf::body(&auth, usage())).unwrap();
            body["complete"] = false.into();
            serde_json::to_vec(&body).unwrap()
        },
    ] {
        assert!(h
            .publish_purchase_result("bad".into(), binding.clone(), bytes, &validator)
            .is_err());
        assert_eq!(h.snapshot(), before);
    }
    validator.protocol = "wrong-protocol".into();
    let calls = validator.calls.get();
    assert!(h
        .publish_purchase_result(
            "bad".into(),
            binding.clone(),
            rf::body(&auth, usage()),
            &validator
        )
        .is_err());
    assert_eq!(validator.calls.get(), calls);
    validator.protocol = auth.request_protocol_ref.clone();
    let mut wrong = binding.clone();
    wrong.backend_incarnation.push('x');
    assert!(h
        .publish_purchase_result("bad".into(), wrong, rf::body(&auth, usage()), &validator)
        .is_err());
    assert_eq!(validator.calls.get(), calls);
    h.publish_purchase_result("good".into(), binding, rf::body(&auth, usage()), &validator)
        .unwrap();
    let c = h.journal().commands().last().unwrap().1.clone();
    assert!(matches!(
        h.execute("bypass".into(), c),
        Err(HostError::InternalCommand)
    ));
}
#[test]
fn result_preparation_cannot_cross_a_newer_market_commit() {
    let (mut h, mut a, id, binding) = setup_result();
    finish(
        &mut h,
        &mut a,
        &id,
        ExecutionOutcome::Completed,
        Some(usage()),
    );
    let auth = h.snapshot().frozen_grants().unwrap()[&id]
        .authorization
        .clone();
    let validator = rf::FixtureValidator::new(&auth);
    let PrepareOutcome::Prepared(prepared) = h
        .prepare_purchase_result(
            "result".into(),
            binding,
            rf::body(&auth, usage()),
            &validator,
        )
        .unwrap()
    else {
        panic!("prepared")
    };
    advance(&mut h, auth.binding.created_at.0 + 1);
    assert!(h.publish(*prepared).is_err());
    assert!(h.snapshot().purchase_result(&id).is_none());
}

#[test]
fn exact_completion_target_is_inclusive_and_replay_rejects_changed_artifact_bytes() {
    let (mut h, mut a, id, binding) = setup_result();
    finish(
        &mut h,
        &mut a,
        &id,
        ExecutionOutcome::Completed,
        Some(usage()),
    );
    let auth = h.snapshot().frozen_grants().unwrap()[&id]
        .authorization
        .clone();
    let validator = rf::FixtureValidator::new(&auth);
    let target = h
        .snapshot()
        .purchase_service_observation(&id)
        .unwrap()
        .completion_target_at
        .unwrap();
    advance(&mut h, target.0);
    h.publish_purchase_result(
        "result".into(),
        binding,
        rf::body(&auth, usage()),
        &validator,
    )
    .unwrap();
    assert_eq!(
        h.snapshot()
            .purchase_service_observation(&id)
            .unwrap()
            .completion_target_met,
        Some(true)
    );
    let mut journal = serde_json::to_value(h.journal()).unwrap();
    let command = &mut journal["commands"]
        .as_array_mut()
        .unwrap()
        .last_mut()
        .unwrap()[1]["PublishPurchaseResult"];
    command["bytes"][0] = serde_json::json!(0);
    let journal = serde_json::from_value(journal).unwrap();
    assert!(MarketHost::replay(bootstrap(false), &journal).is_err());
}

#[test]
fn late_acceptance_receipt_after_expiry_preserves_original_deadline_and_released_funds(
) -> DeliveryTest {
    let (mut h, mut a) = setup(false, false);
    let r = registration("late-e-after-d", 1, &["a"], false);
    register(&mut h, &r);
    let q = publication(&h, &r, 1, "late-e");
    publish(&mut h, &q);
    let p = proposal(&h, &r, &[q], "late-e");
    let id = id(&propose(&mut h, &p));
    let b = frozen_auth(&h, &id)?.binding;
    let report = h.dispatch(
        &request(&h, &id, ExecutionRequestKind::Submit).effect_id,
        &mut a,
    )?;
    let deadline = delivery_trade(&h, &id)?.delivery_deadline;
    h.execute(
        "expire-before-e-receipt".into(),
        ExchangeCommand::AdvanceTime(deadline),
    )?;
    assert_eq!(h.snapshot().accounts()[&1].held(), MicroUsd(0));
    h.receive("late-e".into(), a.origin(), report)?;
    let t = delivery_trade(&h, &id)?;
    assert_eq!(t.delivery_deadline, deadline);
    assert_eq!(b.created_at.0 + 60000, deadline.0);
    assert!(t.accepted_at.is_some());
    assert!(matches!(
        t.settlement,
        ReservationSettlement::ClosedUnpaid { .. }
    ));
    assert_eq!(h.snapshot().accounts()[&1].balance(), MicroUsd(1000));
    assert_eq!(h.snapshot().accounts()[&1].held(), MicroUsd(0));
    assert_eq!(h.snapshot().occupancy(AdmissionScopeId(30)), 1);
    Ok(())
}

#[test]
fn buyer_cancel_after_acceptance_does_not_refund_qualified_on_time_delivery() -> DeliveryTest {
    let (mut h, mut a, id, b) = setup_result();
    let auth = frozen_auth(&h, &id)?;
    h.execute(
        "cancel-after-e".into(),
        ExchangeCommand::CloseFormalOrder(bitrouter_market::formal_order::CloseFormalOrder {
            idempotency_key: "cancel-after-e".into(),
            root: auth.purchase.root.clone(),
        }),
    )?;
    assert!(h.snapshot().accounts()[&1].held().0 > 0);
    finish(
        &mut h,
        &mut a,
        &id,
        ExecutionOutcome::Completed,
        Some(usage()),
    );
    h.publish_purchase_result(
        "deliver-after-cancel".into(),
        b,
        rf::body(&auth, usage()),
        &rf::FixtureValidator::new(&auth),
    )?;
    assert_eq!(h.snapshot().accounts()[&1].balance(), MicroUsd(989));
    assert_eq!(h.snapshot().accounts()[&1].held(), MicroUsd(0));
    assert_eq!(h.snapshot().provider_earned(7), MicroUsd(11));
    Ok(())
}
