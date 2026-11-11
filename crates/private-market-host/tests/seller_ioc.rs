//! Conditional offers have one sale and independent, Market-owned IOC rounds.
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
#[path = "support/seller_fixture.rs"]
mod sf;
use bitrouter_market::{
    admission::*, exchange::*, execution_contract::*, market_host::*, order::*, purchase_order::*,
    seller_order::*,
};

#[test]
fn flat_options_share_exactly_one_sale_even_with_independent_capacity() {
    for shared in [false, true] {
        let (mut h, _, r) = sf::setup(shared, true);
        sf::buyer(&mut h, 1, "a", "first", false);
        sf::buyer(&mut h, 2, "b", "second", false);
        let receipt = sf::drive(&mut h, "drive");
        assert_eq!(
            receipt
                .reviewed
                .iter()
                .filter(|(_, r)| r
                    .decision
                    .as_ref()
                    .is_some_and(|d| matches!(d.result, PurchaseResult::Granted { .. })))
                .count(),
            1
        );
        let s = h.snapshot();
        let offer = &s.sells()[&r.order.reference];
        assert_eq!(offer.allocation().attempts().len(), 1);
        assert!(offer.allocation().is_closed());
        assert!(s.sources().values().all(|s| s.withdrawn));
        assert_eq!(
            s.seller_orders().unwrap()[&r.order.reference]
                .round()
                .unwrap()
                .unallocated_options
                .len(),
            1
        );
        assert_eq!(s.purchase_trades().unwrap().len(), 1);
    }
}

#[test]
fn separate_offers_have_independent_sale_but_share_physical_capacity() {
    for (shared, expected) in [(false, 2), (true, 1)] {
        let (mut h, _, sellers) = sf::independent_setup(shared, true);
        sf::buyer(&mut h, 1, "a", "first", false);
        sf::buyer(&mut h, 2, "b", "second", false);
        sf::drive(&mut h, "drive");
        let s = h.snapshot();
        assert_eq!(s.purchase_trades().unwrap().len(), expected);
        for seller in &sellers {
            assert!(s.sells()[&seller.order.reference].allocation().is_closed());
        }
        let rounds: std::collections::BTreeSet<_> = s
            .frozen_grants()
            .unwrap()
            .values()
            .map(|g| {
                g.authorization
                    .purchase
                    .seller_ioc
                    .as_ref()
                    .unwrap()
                    .round_id
                    .clone()
            })
            .collect();
        assert_eq!(rounds.len(), expected);
        assert_eq!(
            MarketHost::replay(sf::bootstrap(shared), &h.journal())
                .unwrap()
                .snapshot(),
            s
        );
    }
}

#[test]
fn public_commands_cannot_program_combinations_or_competing_buyers() {
    for name in ["SellerIocRound", "SellerIocBatch"] {
        let json = serde_json::json!({name: {"sellers":[],"proposals":[]}});
        assert!(serde_json::from_value::<ExchangeCommand>(json).is_err());
    }
    let r = sf::registration(true);
    for field in ["tree", "quantity", "expression", "depends_on"] {
        let mut json = serde_json::to_value(&r).unwrap();
        json["order"][field] = serde_json::json!({"kind":"xor","children":[]});
        assert!(serde_json::from_value::<RegisterSellerOrder>(json).is_err());
    }
    let mut old = r;
    old.version = 1;
    let mut h = sf::bootstrap(false);
    assert!(h
        .execute(
            old.idempotency_key.clone(),
            ExchangeCommand::RegisterSellerOrder(Box::new(old))
        )
        .is_err());
}

#[test]
fn standalone_proposal_cannot_open_an_ioc_round() {
    let (mut h, _, _) = sf::setup(false, true);
    let p = sf::buyer(&mut h, 1, "a", "buyer", false);
    let before = h.snapshot();
    assert!(h
        .execute(
            p.idempotency_key.clone(),
            ExchangeCommand::ProposePurchase(Box::new(p))
        )
        .is_err());
    assert_eq!(h.snapshot(), before);
}

#[test]
fn original_round_and_windows_survive_replay_and_aliases() {
    let (mut h, _, seller) = sf::setup(false, true);
    sf::buyer(&mut h, 1, "a", "buyer", false);
    let input = sf::drive_input(&h, "drive");
    let receipt = sf::drive(&mut h, "drive");
    let before = h.snapshot();
    assert_eq!(
        h.execute("drive".into(), ExchangeCommand::DriveFormalOrders(input))
            .unwrap(),
        ExchangeReceipt::FormalOrdersDriven(receipt)
    );
    assert_eq!(h.snapshot(), before);
    let mut retry = seller.clone();
    retry.idempotency_key = "register-alias".into();
    h.execute(
        retry.idempotency_key.clone(),
        ExchangeCommand::RegisterSellerOrder(Box::new(retry)),
    )
    .unwrap();
    assert_eq!(
        h.snapshot().seller_orders().unwrap()[&seller.order.reference]
            .receipt()
            .window,
        before.seller_orders().unwrap()[&seller.order.reference]
            .receipt()
            .window
    );
    sf::drive(&mut h, "next-drive");
    assert_eq!(h.snapshot().purchase_trades().unwrap().len(), 1);
}

#[test]
fn unknown_and_authoritative_fence_do_not_reopen_ioc_offer() {
    let (mut h, mut a, seller) = sf::setup(false, true);
    sf::buyer(&mut h, 1, "a", "buyer", false);
    let receipt = sf::drive(&mut h, "drive");
    let id = pf::id(receipt.reviewed[0].1.decision.as_ref().unwrap());
    let grant = h.snapshot().frozen_grants().unwrap()[&id].clone();
    let unknown = pf::query(&mut h, &mut a, &id, ExecutionRequestKind::Query, "query");
    h.receive("unknown".into(), a.origin(), unknown).unwrap();
    assert!(h.snapshot().purchase_trades().unwrap()[&id].unknown);
    assert_eq!(h.snapshot().accounts()[&1].held(), MicroUsd(100));
    let fence = pf::query(
        &mut h,
        &mut a,
        &id,
        ExecutionRequestKind::FenceUnaccepted,
        "fence-query",
    );
    h.receive("fenced".into(), a.origin(), fence).unwrap();
    sf::drive(&mut h, "retry-drive");
    let s = h.snapshot();
    assert_eq!(s.occupancy(AdmissionScopeId(30)), 0);
    assert!(s.sells()[&seller.order.reference].allocation().is_closed());
    assert_eq!(s.purchase_trades().unwrap().len(), 1);
    assert_eq!(s.frozen_grants().unwrap()[&id], grant);
}

#[test]
fn accepted_failure_permanently_consumes_sale_and_purchase() {
    let (mut h, mut a, seller) = sf::setup(false, true);
    sf::buyer(&mut h, 1, "a", "buyer", false);
    let receipt = sf::drive(&mut h, "drive");
    let id = pf::id(receipt.reviewed[0].1.decision.as_ref().unwrap());
    let report = h
        .dispatch(
            &pf::request(&h, &id, ExecutionRequestKind::Submit).effect_id,
            &mut a,
        )
        .unwrap();
    h.receive("accepted".into(), a.origin(), report).unwrap();
    let now = h.snapshot().now();
    a.start("exchange", &id, now).unwrap();
    a.finish("exchange", &id, ExecutionOutcome::Failed, None, now)
        .unwrap();
    let report = pf::query(
        &mut h,
        &mut a,
        &id,
        ExecutionRequestKind::Query,
        "terminal-query",
    );
    h.receive("failed".into(), a.origin(), report).unwrap();
    sf::drive(&mut h, "retry-drive");
    let s = h.snapshot();
    assert!(s.sells()[&seller.order.reference]
        .allocation()
        .is_consumed());
    assert_eq!(s.purchase_trades().unwrap().len(), 1);
    assert_eq!(s.occupancy(AdmissionScopeId(30)), 0);
}

#[test]
fn acceptance_at_exclusive_boundary_cannot_consume_or_reopen_offer() {
    let (mut h, mut a, seller) = sf::setup(false, true);
    sf::buyer(&mut h, 1, "a", "buyer", false);
    let receipt = sf::drive(&mut h, "drive");
    let id = pf::id(receipt.reviewed[0].1.decision.as_ref().unwrap());
    let deadline = h.snapshot().purchase_trades().unwrap()[&id].accept_before;
    fixture::run(&mut h, "deadline", ExchangeCommand::AdvanceTime(deadline));
    let request = pf::request(&h, &id, ExecutionRequestKind::Submit);
    assert!(matches!(
        h.dispatch(&request.effect_id, &mut a),
        Err(HostError::Expired)
    ));
    let late = a.handle(&request, h.committed_grants(), deadline).unwrap();
    assert!(matches!(
        late.observation,
        ExecutionReportState::NotExecutedFence { .. }
    ));
    assert!(h.snapshot().sells()[&seller.order.reference]
        .allocation()
        .is_closed());
}

#[test]
fn stale_prepared_drive_publishes_no_sale_money_capacity_or_outbox() {
    let (mut h, _, _) = sf::setup(false, true);
    sf::buyer(&mut h, 1, "a", "buyer", false);
    let input = sf::drive_input(&h, "drive");
    let PrepareOutcome::Prepared(p) = h
        .prepare("drive".into(), ExchangeCommand::DriveFormalOrders(input))
        .unwrap()
    else {
        panic!("prepared")
    };
    assert_eq!(p.record().grants().len(), 1);
    assert!(h.snapshot().frozen_grants().unwrap().is_empty());
    fixture::run(
        &mut h,
        "credit",
        ExchangeCommand::Credit {
            buyer_id: 99,
            amount: MicroUsd(1),
        },
    );
    assert!(h.publish(*p).is_err());
    assert!(h.snapshot().frozen_grants().unwrap().is_empty());
    sf::drive(&mut h, "next-drive");
    assert_eq!(h.snapshot().purchase_trades().unwrap().len(), 1);
}

#[test]
fn maximum_byte_length_offer_id_keeps_a_bounded_replayable_ioc_identity() {
    use bitrouter_market::authorization::{OrderRef, OrderSide, MAX_ID_BYTES};
    for name in ["x".repeat(MAX_ID_BYTES), "é".repeat(MAX_ID_BYTES / 2)] {
        let (seed, _, _) = sf::setup(false, true);
        let mut h = sf::bootstrap(false);
        let reference = OrderRef::new("exchange".into(), OrderSide::Sell, 7, name).unwrap();
        for (key, command) in seed.journal().commands() {
            let mut command = command.clone();
            if let ExchangeCommand::RegisterSellerOrder(i) = &mut command {
                i.order.reference = reference.clone();
            }
            h.execute(key.clone(), command).unwrap();
        }
        sf::buyer(&mut h, 1, "a", "buyer", false);
        let result = sf::drive(&mut h, "long-id-drive");
        let id = pf::id(result.reviewed[0].1.decision.as_ref().unwrap());
        let grant = h.snapshot().frozen_grants().unwrap()[&id].clone();
        let frozen = grant.authorization.purchase.seller_ioc.as_ref().unwrap();
        assert_eq!(frozen.seller, reference);
        assert!(frozen.round_id.len() <= MAX_ID_BYTES);
        grant.authorization.validate().unwrap();
        assert_eq!(
            MarketHost::replay(sf::bootstrap(false), &h.journal())
                .unwrap()
                .snapshot(),
            h.snapshot()
        );
    }
}
