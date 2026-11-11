use crate::{fixture, pf, sf};
use bitrouter_market::exchange::*;
use bitrouter_market::manual_seller_order::*;
use bitrouter_market::market_host::MarketHost;
pub fn input(ioc: bool) -> SubmitManualSellerOrder {
    let r = sf::registration(ioc);
    // Construct explicit service terms from the test catalog. This temporary
    // model is not the receiving host and contributes no capacity evidence.
    let mut catalog = sf::bootstrap(false);
    catalog
        .execute(
            r.idempotency_key.clone(),
            ExchangeCommand::RegisterSellerOrder(Box::new(r.clone())),
        )
        .unwrap();
    let services = r
        .order
        .options
        .iter()
        .map(|l| ManualSellerService {
            option_id: l.option_id,
            schedule: pf::service_publication(&catalog, &l.ask.market_spec_ref.market_id).schedule,
        })
        .collect();
    SubmitManualSellerOrder {
        version: MANUAL_SELLER_ORDER_VERSION,
        rules_ref: MANUAL_SELLER_ORDER_RULES.into(),
        idempotency_key: "manual-submit".into(),
        order: r.order,
        services,
    }
}
pub fn submit(h: &mut MarketHost, i: &SubmitManualSellerOrder) -> ManualSellerOrderReceipt {
    match h
        .execute(
            i.idempotency_key.clone(),
            ExchangeCommand::SubmitManualSellerOrder(Box::new(i.clone())),
        )
        .unwrap()
    {
        ExchangeReceipt::ManualSellerOrderSubmitted(r) => r,
        _ => panic!("manual receipt"),
    }
}
pub fn prepare_market(shared: bool, ioc: bool) -> (MarketHost, SubmitManualSellerOrder) {
    let mut h = sf::bootstrap(shared);
    let i = input(ioc);
    submit(&mut h, &i);
    for owner in 1..=2 {
        fixture::run(
            &mut h,
            &format!("credit-{owner}"),
            ExchangeCommand::Credit {
                buyer_id: owner,
                amount: bitrouter_market::order::MicroUsd(1000),
            },
        );
    }
    for market in ["a", "b"] {
        fixture::ready(&mut h, market, 1);
    }
    fixture::run(
        &mut h,
        "scope-a",
        ExchangeCommand::ScopeReport(crate::fx::report(30, 1, vec![])),
    );
    if !shared {
        fixture::run(
            &mut h,
            "scope-b",
            ExchangeCommand::ScopeReport(crate::fx::report(31, 1, vec![])),
        );
    }
    (h, i)
}
