#[allow(dead_code)]
mod common;
#[allow(dead_code)]
#[path = "support/frozen_fixture.rs"]
mod fixture;
#[allow(dead_code)]
#[path = "support/conditional_exchange.rs"]
mod fx;
#[allow(dead_code)]
#[path = "support/manual_seller_fixture.rs"]
mod mf;
#[allow(dead_code)]
#[path = "support/purchase_fixture.rs"]
mod pf;
#[allow(dead_code)]
#[path = "support/seller_fixture.rs"]
mod sf;
use bitrouter_market::admission::*;
use bitrouter_market::authorization::*;
use bitrouter_market::exchange::*;
use bitrouter_market::manual_seller_order::*;
use bitrouter_market::market_host::MarketHost;
use bitrouter_market::order::*;
use bitrouter_market::purchase_order::*;
use bitrouter_market::seller_order::*;
fn command(i: &SubmitManualSellerOrder) -> ExchangeCommand {
    ExchangeCommand::SubmitManualSellerOrder(Box::new(i.clone()))
}
#[test]
fn one_manual_command_registers_whole_authorization_and_services_without_execution_or_synthetic_evidence(
) {
    let mut h = sf::bootstrap(false);
    let i = mf::input(false);
    let now = h.snapshot().now();
    let receipt = mf::submit(&mut h, &i);
    let s = h.snapshot();
    assert_eq!(s.revision(), 1);
    assert_eq!(h.journal().commands().len(), 1);
    assert_eq!(receipt.registration.window.registered_at, now);
    assert_eq!(receipt.services.len(), 2);
    assert_eq!(
        s.manual_seller_orders().unwrap()[&i.order.reference].submission(),
        &i
    );
    assert!(s.purchase_trades().unwrap().is_empty());
    assert!(s.frozen_grants().unwrap().is_empty());
    assert!(s.execution_requests().unwrap().is_empty());
    assert!(s.accounts().is_empty());
    for r in &receipt.services {
        assert_eq!(r.source_generation, 1);
        assert_eq!(
            r.quote_version,
            bitrouter_market::orderbook::OfferingVersion {
                generation: 1,
                update_seq: 1
            }
        );
        let service = s.seller_service(&r.offering).unwrap();
        assert_eq!(service.schedule.reference, r.service.reference);
        let book = &s.books()[&r.offering.market_id];
        let offering = book
            .get_offering(r.offering.offering_id)
            .unwrap()
            .offering()
            .unwrap();
        assert_eq!(offering.readiness, Readiness::NotReady);
        assert!(book
            .get_throughput_observation(r.offering.offering_id)
            .is_none());
        assert!(s
            .scope_report(if r.offering.market_id == "a" {
                AdmissionScopeId(30)
            } else {
                AdmissionScopeId(31)
            })
            .is_none());
    }
    assert_eq!(
        MarketHost::replay(sf::bootstrap(false), &h.journal())
            .unwrap()
            .snapshot(),
        s
    );
}
#[test]
fn invalid_later_service_rolls_back_seller_source_generation_opportunity_and_key() {
    let mut h = sf::bootstrap(false);
    let i = mf::input(true);
    let before = h.snapshot();
    let mut invalid = i.clone();
    invalid.services[1].schedule.rates.output += 1;
    assert!(h
        .execute(invalid.idempotency_key.clone(), command(&invalid))
        .is_err());
    assert_eq!(h.snapshot(), before);
    let receipt = mf::submit(&mut h, &i);
    assert!(receipt.services.iter().all(|s| s.source_generation == 1));
    assert_eq!(h.snapshot().manual_seller_orders().unwrap().len(), 1);
}
#[test]
fn missing_duplicate_foreign_and_mismatched_service_sets_fail_atomically() {
    let i = mf::input(false);
    for variant in 0..8 {
        let mut h = sf::bootstrap(false);
        let before = h.snapshot();
        let mut bad = i.clone();
        match variant {
            0 => {
                bad.services.pop();
            }
            1 => bad.services[1].option_id = bad.services[0].option_id,
            2 => bad.services[1].option_id = OptionId(999),
            3 => bad.services[1].schedule.provider_id += 1,
            4 => bad.services[1].schedule.model_ref = "foreign-model".into(),
            5 => bad.version += 1,
            6 => bad.rules_ref = "unknown".into(),
            _ => bad.services[1].schedule.reference = bad.services[0].schedule.reference.clone(),
        }
        assert!(
            h.execute(bad.idempotency_key.clone(), command(&bad))
                .is_err(),
            "variant {variant}"
        );
        assert_eq!(h.snapshot(), before);
    }
}
#[test]
fn transport_retries_keep_original_receipt_and_never_restore_an_old_service_revision() {
    let mut h = sf::bootstrap(false);
    let i = mf::input(false);
    let receipt = mf::submit(&mut h, &i);
    let before = h.snapshot();
    assert_eq!(mf::submit(&mut h, &i), receipt);
    assert_eq!(h.snapshot(), before);
    let mut next = h
        .snapshot()
        .seller_service(&receipt.services[0].offering)
        .unwrap()
        .clone();
    next.schedule.revision += 1;
    next.schedule.bins[0].delivery =
        bitrouter_market::seller_service::DeliveryConditions::PerformanceTarget {
            first_response_within_ms: 200,
            complete_within_ms: 2000,
        };
    let original = h
        .snapshot()
        .seller_service(&receipt.services[0].offering)
        .unwrap()
        .clone();
    assert!(h
        .execute(
            "new-service".into(),
            ExchangeCommand::PublishSellerService(Box::new(next))
        )
        .is_err());
    let mut retry = i.clone();
    retry.idempotency_key = "alternate-transport".into();
    assert_eq!(mf::submit(&mut h, &retry), receipt);
    assert_eq!(
        h.snapshot().seller_service(&receipt.services[0].offering),
        Some(&original)
    );
    let mut conflict = retry;
    conflict.idempotency_key = "changed".into();
    conflict.services[0].schedule.revision += 1;
    assert!(h
        .execute(conflict.idempotency_key.clone(), command(&conflict))
        .is_err());
}
#[test]
fn expiry_and_renaming_cannot_reopen_the_original_manual_opportunity() {
    let mut h = sf::bootstrap(false);
    let i = mf::input(true);
    let receipt = mf::submit(&mut h, &i);
    fixture::run(
        &mut h,
        "deadline",
        ExchangeCommand::AdvanceTime(receipt.registration.window.accept_before),
    );
    let mut retry = i.clone();
    retry.idempotency_key = "late".into();
    assert_eq!(mf::submit(&mut h, &retry), receipt);
    assert!(h.snapshot().seller_orders().unwrap()[&i.order.reference]
        .closure()
        .is_some());
    let mut renamed = i;
    renamed.idempotency_key = "renamed".into();
    renamed.order.reference =
        OrderRef::new("exchange".into(), OrderSide::Sell, 7, "renamed".into()).unwrap();
    assert!(h
        .execute(renamed.idempotency_key.clone(), command(&renamed))
        .is_err());
    assert_eq!(h.snapshot().manual_seller_orders().unwrap().len(), 1);
}
#[test]
fn preparation_is_invisible_and_stale_cas_cannot_publish_a_partial_manual_order() {
    let mut h = sf::bootstrap(false);
    let i = mf::input(false);
    let PrepareOutcome::Prepared(p) = h.prepare(i.idempotency_key.clone(), command(&i)).unwrap()
    else {
        panic!("prepare")
    };
    assert!(h.snapshot().manual_seller_orders().unwrap().is_empty());
    assert_eq!(p.next_snapshot().manual_seller_orders().unwrap().len(), 1);
    assert!(p
        .next_snapshot()
        .seller_service(&fixture::source("a"))
        .is_some());
    fixture::run(
        &mut h,
        "unrelated",
        ExchangeCommand::Credit {
            buyer_id: 99,
            amount: MicroUsd(1),
        },
    );
    assert!(h.publish(*p).is_err());
    assert!(h.snapshot().manual_seller_orders().unwrap().is_empty());
    mf::submit(&mut h, &i);
}
#[test]
fn manual_orders_use_original_ioc_gtd_choice_and_scope_rules_when_proposals_arrive() {
    for (shared, expected) in [(false, 1), (true, 1)] {
        let (mut h, i) = mf::prepare_market(shared, true);
        let _p1 = sf::buyer(&mut h, 1, "a", "first", false);
        let _p2 = sf::buyer(&mut h, 2, "b", "second", false);
        let result = sf::drive(&mut h, "manual-drive");
        assert_eq!(
            result
                .reviewed
                .iter()
                .filter(|(_, r)| r
                    .decision
                    .as_ref()
                    .is_some_and(|d| matches!(d.result, PurchaseResult::Granted { .. })))
                .count(),
            expected
        );
        let manual = h.snapshot().manual_seller_orders().unwrap()[&i.order.reference]
            .receipt()
            .clone();
        let mut retry = i.clone();
        retry.idempotency_key = "after-g".into();
        assert_eq!(mf::submit(&mut h, &retry), manual);
        assert_eq!(h.snapshot().purchase_trades().unwrap().len(), expected);
        assert!(h
            .snapshot()
            .purchase_trades()
            .unwrap()
            .values()
            .all(|t| t.accepted_at.is_none()));
        assert_eq!(
            MarketHost::replay(sf::bootstrap(shared), &h.journal())
                .unwrap()
                .snapshot(),
            h.snapshot()
        );
    }
    let (mut h, _) = mf::prepare_market(false, false);
    let p = sf::buyer(&mut h, 1, "a", "gtd", false);
    assert!(matches!(
        pf::propose(&mut h, &p).result,
        PurchaseResult::Granted { .. }
    ));
}
#[test]
fn handoff_keeps_both_manual_histories_and_old_retry_does_not_claim_the_new_generation() {
    let mut h = sf::bootstrap(false);
    let i = mf::input(false);
    let first = mf::submit(&mut h, &i);
    fixture::run(
        &mut h,
        "close",
        ExchangeCommand::Close(i.order.reference.clone()),
    );
    let mut next = i.clone();
    next.idempotency_key = "next".into();
    next.order.reference =
        OrderRef::new("exchange".into(), OrderSide::Sell, 7, "next-root".into()).unwrap();
    next.order.opportunity_id = "next-opportunity".into();
    for option in &mut next.order.options {
        option.expected_binding_generation = 1;
    }
    for s in &mut next.services {
        s.schedule.reference.push_str("/next");
    }
    let second = mf::submit(&mut h, &next);
    assert!(second.services.iter().all(|s| s.source_generation == 2));
    let mut retry = i;
    retry.idempotency_key = "old-again".into();
    assert_eq!(mf::submit(&mut h, &retry), first);
    assert!(h
        .snapshot()
        .sources()
        .values()
        .all(|s| s.generation == 2 && s.option.as_ref().unwrap().order == next.order.reference));
    assert_eq!(h.snapshot().manual_seller_orders().unwrap().len(), 2);
}
#[test]
fn standalone_registration_and_parent_key_cannot_be_used_to_attach_or_replace_manual_contracts() {
    let mut h = sf::bootstrap(false);
    let i = mf::input(false);
    mf::submit(&mut h, &i);
    let r = RegisterSellerOrder {
        version: SELLER_ORDER_VERSION,
        idempotency_key: i.idempotency_key.clone(),
        order: i.order.clone(),
    };
    assert!(h
        .execute(
            r.idempotency_key.clone(),
            ExchangeCommand::RegisterSellerOrder(Box::new(r.clone()))
        )
        .is_err());
    let mut h = sf::bootstrap(false);
    h.execute(
        r.idempotency_key.clone(),
        ExchangeCommand::RegisterSellerOrder(Box::new(r)),
    )
    .unwrap();
    let before = h.snapshot();
    let mut attach = i;
    attach.idempotency_key = "attach".into();
    assert!(h
        .execute(attach.idempotency_key.clone(), command(&attach))
        .is_err());
    assert_eq!(h.snapshot(), before);
}
#[test]
fn manual_wire_cannot_inject_readiness_capacity_or_execution_acceptance() {
    let i = mf::input(false);
    for field in ["ready", "actual_capacity", "accepted_at", "scheduler"] {
        let mut json = serde_json::to_value(&i).unwrap();
        json[field] = serde_json::json!(true);
        assert!(serde_json::from_value::<SubmitManualSellerOrder>(json).is_err());
    }
}
