#![cfg(feature = "sqlite-tools")]
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
#[path = "support/local_runtime_fixture.rs"]
mod lf;
#[allow(dead_code)]
#[path = "support/manual_seller_fixture.rs"]
mod mf;
#[allow(dead_code)]
#[path = "support/manual_market_fixture.rs"]
mod mm;
#[allow(dead_code)]
#[path = "support/purchase_fixture.rs"]
mod pf;
#[allow(dead_code)]
#[path = "support/seller_fixture.rs"]
mod sf;
use bitrouter_market::{
    durable::*, formal_order::*, manual_market::*, order::*, purchase_order::*,
};
use serde_json::{json, Value};

fn input() -> PlaceFormalOrder {
    PlaceFormalOrder {
        version: bitrouter_market::formal_order::FORMAL_VERSION,
        idempotency_key: "formal-place".into(),
        authorization: lf::registration("formal", 1).authorization,
        provider_scope: ProviderScope::AnyQualified,
        selection: FormalSelection::default(),
    }
}
fn call(
    s: &mut ManualSellerService,
    who: LocalPrincipal,
    method: &str,
    path: &str,
    body: Value,
    time: u64,
) -> Value {
    lf::call(s, who, method, path, body, time)
}
fn service(dir: &mm::Dir, sim: bool) -> (ManualSellerService, ManualMarketConfig) {
    let c = lf::config(UnixMillis(1000), sim);
    let mut s = ManualSellerService::shared(
        DurableMarketHost::create(dir.market(), c.bootstrap().unwrap()).unwrap(),
        &c,
    )
    .unwrap();
    if sim {
        s.open_local_simulation(dir.0.join("authority.sqlite"), true)
            .unwrap();
    }
    (s, c)
}
fn supply(s: &mut ManualSellerService) {
    call(
        s,
        lf::PROVIDER,
        "POST",
        "/v4/manual-seller-orders",
        serde_json::to_value(mf::input(false)).unwrap(),
        1000,
    );
    lf::declare(s, 1000, 9000);
    call(
        s,
        lf::OPERATOR,
        "POST",
        "/v4/qualification/scope-reports",
        json!({"idempotency_key":"scope-a","evidence":fx::report(30,1,vec![])}),
        2000,
    );
    let data: QualificationOfferingContext = serde_json::from_value(call(
        s,
        lf::OPERATOR,
        "GET",
        "/v4/qualification/offerings/a/11",
        json!({}),
        2000,
    ))
    .unwrap();
    let evidence = lf::observation(&data, UnixMillis(1000), UnixMillis(2000), UnixMillis(8000));
    call(
        s,
        lf::OPERATOR,
        "POST",
        "/v4/qualification/throughput",
        json!({"idempotency_key":"throughput-a","evidence":evidence}),
        2000,
    );
}
fn publish(s: &mut ManualSellerService, p: &PlaceFormalOrder, receipt: &Value) {
    let data: QualificationOfferingContext = serde_json::from_value(call(
        s,
        lf::OPERATOR,
        "GET",
        "/v4/qualification/offerings/a/11",
        json!({}),
        2000,
    ))
    .unwrap();
    let window =
        serde_json::from_value(receipt["order"]["registration_receipt"]["window"].clone()).unwrap();
    let evidence = lf::quote(&p.clone(), window, &data, "formal");
    call(
        s,
        lf::OPERATOR,
        "POST",
        "/v4/qualification/purchase-quotes",
        json!({"idempotency_key":"formal-quote","evidence":evidence}),
        2000,
    );
}
#[test]
fn no_router_policy_is_needed_for_full_execution_delivery_and_durable_receipt() {
    let dir = mm::Dir::new();
    let (mut s, c) = service(&dir, true);
    let p = input();
    let receipt = call(
        &mut s,
        lf::BUYER,
        "POST",
        "/v4/formal-orders",
        serde_json::to_value(&p).unwrap(),
        1000,
    );
    s.poll(UnixMillis(1000)).unwrap();
    supply(&mut s);
    publish(&mut s, &p, &receipt);
    s.poll(UnixMillis(2000)).unwrap();
    assert!(s
        .host()
        .unwrap()
        .snapshot()
        .purchase_trades()
        .unwrap()
        .is_empty());
    call(
        &mut s,
        lf::OPERATOR,
        "POST",
        "/v4/accounts/1/credits",
        json!({"idempotency_key":"credit","amount":1000}),
        2000,
    );
    for t in [2000, 2010, 2030, 2050, 2100] {
        s.poll(UnixMillis(t)).unwrap();
    }
    let result = call(
        &mut s,
        lf::BUYER,
        "GET",
        "/v4/formal-orders/formal/results",
        json!({}),
        2100,
    );
    assert_eq!(result["results"].as_array().unwrap().len(), 1);
    assert_eq!(
        s.host().unwrap().snapshot().accounts()[&1].held(),
        MicroUsd(0)
    );
    assert_eq!(
        s.host()
            .unwrap()
            .snapshot()
            .purchase_trades()
            .unwrap()
            .len(),
        1
    );
    let original = call(
        &mut s,
        lf::BUYER,
        "GET",
        "/v4/formal-commands/formal-place",
        json!({}),
        2100,
    );
    assert_eq!(original["receipt"], receipt["receipt"]);
    drop(s);
    let mut s =
        ManualSellerService::shared(DurableMarketHost::open(dir.market()).unwrap(), &c).unwrap();
    s.open_local_simulation(dir.0.join("authority.sqlite"), false)
        .unwrap();
    let retry = call(
        &mut s,
        lf::BUYER,
        "POST",
        "/v4/formal-orders",
        serde_json::to_value(p).unwrap(),
        2100,
    );
    assert_eq!(retry["receipt"], receipt["receipt"]);
    assert_eq!(
        call(
            &mut s,
            lf::BUYER,
            "GET",
            "/v4/formal-orders/formal/results",
            json!({}),
            2100
        )["results"],
        result["results"]
    );
}
#[test]
fn delegated_credentials_limit_operations_and_record_original_agent() {
    let dir = mm::Dir::new();
    let (mut s, _) = service(&dir, false);
    let p = input();
    let agent = LocalPrincipal::BuyerAgent {
        buyer_id: 1,
        agent_id: 42,
        can_place: true,
        can_close: false,
    };
    let receipt = call(
        &mut s,
        agent,
        "POST",
        "/v4/formal-orders",
        serde_json::to_value(&p).unwrap(),
        1000,
    );
    assert_eq!(receipt["formal_order"]["receipt"]["submitted_by_agent"], 42);
    for (path, body) in [
        (
            "/v4/accounts/1/credits",
            json!({"idempotency_key":"steal","amount":1}),
        ),
        (
            "/v4/formal-orders/formal/close",
            json!({"idempotency_key":"close","authorization_version":1}),
        ),
    ] {
        assert_eq!(
            s.request_as(
                agent,
                "POST",
                path,
                &serde_json::to_vec(&body).unwrap(),
                UnixMillis(1000)
            )
            .unwrap_err()
            .status,
            403
        );
    }
    let other = LocalPrincipal::BuyerAgent {
        buyer_id: 2,
        agent_id: 42,
        can_place: true,
        can_close: true,
    };
    assert_eq!(
        s.request_as(
            other,
            "POST",
            "/v4/formal-orders",
            &serde_json::to_vec(&p).unwrap(),
            UnixMillis(1000)
        )
        .unwrap_err()
        .status,
        403
    );
    assert_eq!(
        s.request_as(
            other,
            "GET",
            "/v4/formal-commands/formal-place",
            b"{}",
            UnixMillis(1000)
        )
        .unwrap_err()
        .status,
        404
    );
    let mut forged = serde_json::to_value(&p).unwrap();
    forged["agent_id"] = json!(99);
    assert_eq!(
        s.request_as(
            agent,
            "POST",
            "/v4/formal-orders",
            &serde_json::to_vec(&forged).unwrap(),
            UnixMillis(1000)
        )
        .unwrap_err()
        .status,
        400
    );
    let close = call(
        &mut s,
        lf::BUYER,
        "POST",
        "/v4/formal-orders/formal/close",
        json!({"idempotency_key":"close","authorization_version":1}),
        1000,
    );
    assert_eq!(close["order"]["closed"], true);
    assert_eq!(
        call(
            &mut s,
            agent,
            "POST",
            "/v4/formal-orders",
            serde_json::to_value(p).unwrap(),
            1000
        )["receipt"],
        receipt["receipt"]
    );
}
#[test]
fn no_runtime_profile_still_drives_formal_orders_and_ioc_keeps_original_deadline() {
    let dir = mm::Dir::new();
    let mut c = lf::config(UnixMillis(1000), false);
    c.runtime = None;
    let mut s = ManualSellerService::shared(
        DurableMarketHost::create(dir.market(), c.bootstrap().unwrap()).unwrap(),
        &c,
    )
    .unwrap();
    let mut p = input();
    p.authorization.tif = TimeInForce::Ioc {};
    let receipt = call(
        &mut s,
        lf::BUYER,
        "POST",
        "/v4/formal-orders",
        serde_json::to_value(&p).unwrap(),
        1000,
    );
    s.poll(UnixMillis(1000)).unwrap();
    assert_eq!(s.host().unwrap().snapshot().formal_pending(), 0);
    let end = receipt["order"]["registration_receipt"]["window"]["decision_before"]
        .as_u64()
        .unwrap();
    s.poll(UnixMillis(end)).unwrap();
    let retry = call(
        &mut s,
        lf::BUYER,
        "POST",
        "/v4/formal-orders",
        serde_json::to_value(p).unwrap(),
        end,
    );
    assert_eq!(retry["receipt"], receipt["receipt"]);
    assert_eq!(retry["order"]["closed"], true);
    assert!(s
        .host()
        .unwrap()
        .snapshot()
        .purchase_trades()
        .unwrap()
        .is_empty());
}
