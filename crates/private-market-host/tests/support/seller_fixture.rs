//! Explicit long-enough local windows allow the fixture's two 1s throughput
//! measurements. These durations are test inputs, never production defaults.
use crate::{fixture, fx, pf};
use bitrouter_market::exchange::*;
use bitrouter_market::fake_authority::FakeAuthority;
use bitrouter_market::market_host::MarketHost;
use bitrouter_market::order::*;
use bitrouter_market::purchase_order::*;
use bitrouter_market::seller_order::*;

pub fn bootstrap(shared: bool) -> MarketHost {
    let mut p = pf::policy();
    p.time.immediate_decision_window_ms = 5_000;
    p.time.immediate_total_window_ms = 6_000;
    fixture::bootstrap(shared).with_purchase_orders(p).unwrap()
}
pub fn registration(ioc: bool) -> RegisterSellerOrder {
    let mut old = fx::sell("seller-round", &["a", "b"]);
    for l in &mut old.options {
        l.ask.rates.output = 1_000_000;
    }
    RegisterSellerOrder {
        version: SELLER_ORDER_VERSION,
        idempotency_key: "register-seller".into(),
        order: SellOfferAuthorization {
            reference: old.reference,
            opportunity_id: old.opportunity_id,
            options: old.options,
            tif: if ioc {
                TimeInForce::Ioc {}
            } else {
                TimeInForce::Gtd {
                    expires_at: UnixMillis(9_000),
                }
            },
        },
    }
}
pub fn setup(shared: bool, ioc: bool) -> (MarketHost, FakeAuthority, RegisterSellerOrder) {
    let mut h = bootstrap(shared);
    for buyer in 1..=4 {
        fixture::run(
            &mut h,
            &format!("credit-{buyer}"),
            ExchangeCommand::Credit {
                buyer_id: buyer,
                amount: MicroUsd(1_000),
            },
        );
    }
    let r = registration(ioc);
    h.execute(
        r.idempotency_key.clone(),
        ExchangeCommand::RegisterSellerOrder(Box::new(r.clone())),
    )
    .unwrap();
    for market in ["a", "b"] {
        fixture::ready(&mut h, market, 1);
        let s = pf::service_publication(&h, market);
        fixture::run(
            &mut h,
            &format!("service-{market}"),
            ExchangeCommand::PublishSellerService(Box::new(s)),
        );
    }
    fixture::run(
        &mut h,
        "scope-a",
        ExchangeCommand::ScopeReport(fx::report(30, 1, vec![])),
    );
    if !shared {
        fixture::run(
            &mut h,
            "scope-b",
            ExchangeCommand::ScopeReport(fx::report(31, 1, vec![])),
        );
    }
    let a = fixture::authority(shared, h.snapshot().now());
    (h, a, r)
}
pub fn buyer(
    h: &mut MarketHost,
    owner: u64,
    market: &str,
    label: &str,
    ioc: bool,
) -> ProposePurchase {
    let r = pf::registration(label, owner, &[market], ioc);
    pf::register(h, &r);
    let q = pf::publication(h, &r, 1, label);
    pf::publish(h, &q);
    pf::proposal(h, &r, &[q], label)
}
pub fn drive_input(h: &MarketHost, key: &str) -> bitrouter_market::formal_order::DriveFormalOrders {
    bitrouter_market::formal_order::DriveFormalOrders {
        idempotency_key: key.into(),
        observed_at: h.snapshot().now(),
        budget: 32,
    }
}
pub fn drive(h: &mut MarketHost, key: &str) -> bitrouter_market::formal_order::FormalDriveReceipt {
    let i = drive_input(h, key);
    match h
        .execute(key.into(), ExchangeCommand::DriveFormalOrders(i))
        .unwrap()
    {
        ExchangeReceipt::FormalOrdersDriven(r) => r,
        _ => panic!("drive receipt"),
    }
}
/// Separate sale authorizations may use the same physical pool.
pub fn independent_setup(
    shared: bool,
    ioc: bool,
) -> (MarketHost, FakeAuthority, Vec<RegisterSellerOrder>) {
    let mut h = bootstrap(shared);
    for buyer in 1..=4 {
        fixture::run(
            &mut h,
            &format!("credit-{buyer}"),
            ExchangeCommand::Credit {
                buyer_id: buyer,
                amount: MicroUsd(1000),
            },
        );
    }
    let mut sellers = Vec::new();
    for (index, market) in ["a", "b"].iter().enumerate() {
        let mut r = registration(ioc);
        r.idempotency_key = format!("register-{market}");
        r.order.reference = fx::reference(
            bitrouter_market::authorization::OrderSide::Sell,
            7,
            &format!("offer-{market}"),
        );
        r.order.opportunity_id = format!("sale-{market}");
        r.order.options = vec![r.order.options[index].clone()];
        h.execute(
            r.idempotency_key.clone(),
            ExchangeCommand::RegisterSellerOrder(Box::new(r.clone())),
        )
        .unwrap();
        sellers.push(r);
    }
    for market in ["a", "b"] {
        fixture::ready(&mut h, market, 1);
        let s = pf::service_publication(&h, market);
        fixture::run(
            &mut h,
            &format!("service-{market}"),
            ExchangeCommand::PublishSellerService(Box::new(s)),
        );
    }
    fixture::run(
        &mut h,
        "scope-a",
        ExchangeCommand::ScopeReport(fx::report(30, 1, vec![])),
    );
    if !shared {
        fixture::run(
            &mut h,
            "scope-b",
            ExchangeCommand::ScopeReport(fx::report(31, 1, vec![])),
        );
    }
    let a = fixture::authority(shared, h.snapshot().now());
    (h, a, sellers)
}
