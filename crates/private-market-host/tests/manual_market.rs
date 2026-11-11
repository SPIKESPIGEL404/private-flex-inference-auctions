#![cfg(feature = "sqlite-tools")]
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
#[path = "support/manual_market_fixture.rs"]
mod mm;
#[allow(dead_code)]
#[path = "support/purchase_fixture.rs"]
mod pf;
#[allow(dead_code)]
#[path = "support/seller_fixture.rs"]
mod sf;
use bitrouter_market::authorization::*;
use bitrouter_market::durable::*;
use bitrouter_market::exchange::*;
use bitrouter_market::manual_market::*;
use bitrouter_market::order::*;
use serde_json::{json, Value};

const ORDERS: &str = "/v4/manual-seller-orders";
const ROOT: &str = "/v4/manual-seller-orders/seller-round";
fn service(dir: &mm::Dir) -> ManualSellerService {
    let c = mm::config(UnixMillis(1000));
    ManualSellerService::new(
        DurableMarketHost::create(dir.market(), c.bootstrap().unwrap()).unwrap(),
        &c,
        7,
    )
    .unwrap()
}
fn call(s: &mut ManualSellerService, method: &str, path: &str, body: Value, now: u64) -> Value {
    s.request(
        method,
        path,
        &serde_json::to_vec(&body).unwrap(),
        UnixMillis(now),
    )
    .unwrap()
}
fn submit(s: &mut ManualSellerService, now: u64) -> Value {
    call(
        s,
        "POST",
        ORDERS,
        serde_json::to_value(mf::input(false)).unwrap(),
        now,
    )
}
#[test]
fn adapter_preserves_exact_authorization_and_original_receipt_across_restart_and_retry() {
    let dir = mm::Dir::new();
    let mut s = service(&dir);
    let result = submit(&mut s, 1500);
    let original = serde_json::to_value(mf::input(false)).unwrap();
    assert_eq!(result["order"]["submission"], original);
    assert_eq!(
        result["receipt"]["registration"]["window"]["registered_at"],
        1500
    );
    assert!(result["order"]["attempts"].as_array().unwrap().is_empty());
    for option in result["order"]["options"].as_array().unwrap() {
        assert_eq!(option["supply_state"]["readiness"], "NotReady");
        assert_eq!(option["source_is_current"], true);
        assert_eq!(option["sale_available"], true);
    }
    assert!(s
        .host()
        .unwrap()
        .snapshot()
        .frozen_grants()
        .unwrap()
        .is_empty());
    assert!(s
        .host()
        .unwrap()
        .snapshot()
        .execution_requests()
        .unwrap()
        .is_empty());
    drop(s);
    let c = mm::config(UnixMillis(1000));
    let mut s =
        ManualSellerService::new(DurableMarketHost::open(dir.market()).unwrap(), &c, 7).unwrap();
    let view = call(&mut s, "GET", ROOT, json!({}), 1800);
    assert_eq!(view["order"], result["order"]);
    let mut retry = original;
    retry["idempotency_key"] = json!("another-transport-key");
    let again = call(&mut s, "POST", ORDERS, retry, 2000);
    assert_eq!(again["receipt"], result["receipt"]);
    assert_eq!(again["order"]["submission"], result["order"]["submission"]);
    assert_eq!(
        s.host()
            .unwrap()
            .snapshot()
            .manual_seller_orders()
            .unwrap()
            .len(),
        1
    );
}
#[test]
fn strict_schema_and_provider_binding_reject_impersonation_controls_and_ambiguous_json() {
    let dir = mm::Dir::new();
    let mut s = service(&dir);
    let original = serde_json::to_value(mf::input(false)).unwrap();
    let before = s.host().unwrap().snapshot();
    for (pointer, value, status) in [
        ("/order/reference/owner_id", json!(8), 403),
        ("/order/reference/exchange_id", json!("foreign"), 403),
        ("/order/reference/side", json!("Buy"), 403),
        ("/order/options/1/ask/provider_id", json!(8), 403),
        ("/services/1/schedule/provider_id", json!(8), 403),
    ] {
        let mut bad = original.clone();
        *bad.pointer_mut(pointer).unwrap() = value;
        assert_eq!(
            s.request(
                "POST",
                ORDERS,
                &serde_json::to_vec(&bad).unwrap(),
                UnixMillis(2000)
            )
            .unwrap_err()
            .status,
            status
        );
    }
    let mut bad = original;
    bad["scheduler"] = json!({"accepted":true});
    for (method, path, bytes, status) in [
        ("POST", ORDERS, serde_json::to_vec(&bad).unwrap(), 400),
        (
            "POST",
            ORDERS,
            br#"{"version":1,"version":1}"#.to_vec(),
            400,
        ),
        ("POST", "/v4/control/credit", b"{}".to_vec(), 404),
        ("POST", "/v4/execution/report", b"{}".to_vec(), 404),
        ("GET", "/v4/manual-seller-orders/%GG", b"{}".to_vec(), 400),
        ("GET", "/healthz?key=1", b"{}".to_vec(), 400),
        ("GET", "/healthz", b"{\"ignored\":true}".to_vec(), 400),
    ] {
        assert_eq!(
            s.request(method, path, &bytes, UnixMillis(2000))
                .unwrap_err()
                .status,
            status
        );
    }
    assert_eq!(s.host().unwrap().snapshot(), before);
}
#[test]
fn ioc_uses_server_time_idle_expiry_is_durable_and_retries_never_reopen_the_window() {
    let dir = mm::Dir::new();
    let mut s = service(&dir);
    let input = serde_json::to_value(mf::input(true)).unwrap();
    let r = call(&mut s, "POST", ORDERS, input.clone(), 2000);
    assert_eq!(
        r["receipt"]["registration"]["window"],
        json!({"registered_at":2000,"decision_before":7000,"accept_before":8000})
    );
    s.poll(UnixMillis(6999)).unwrap();
    assert!(s
        .host()
        .unwrap()
        .snapshot()
        .seller_orders()
        .unwrap()
        .values()
        .next()
        .unwrap()
        .closure()
        .is_none());
    s.poll(UnixMillis(7000)).unwrap();
    let before = s.host().unwrap().snapshot();
    assert_eq!(s.poll(UnixMillis(6999)).unwrap_err().status, 503);
    assert_eq!(s.host().unwrap().snapshot(), before);
    let late = call(&mut s, "POST", ORDERS, input, 8000);
    assert_eq!(late["receipt"], r["receipt"]);
    assert_eq!(late["order"]["closed"], true);
    assert_eq!(late["order"]["closure"]["reason"], "decision_expired");
    drop(s);
    let host = DurableMarketHost::open(dir.market()).unwrap();
    assert!(host
        .host()
        .unwrap()
        .snapshot()
        .sells()
        .values()
        .next()
        .unwrap()
        .allocation()
        .is_closed());
}
#[test]
fn failed_second_service_cannot_leave_a_partial_root_or_a_successful_key() {
    let dir = mm::Dir::new();
    let mut s = service(&dir);
    let mut input = serde_json::to_value(mf::input(false)).unwrap();
    input["services"][1]["schedule"]["model_ref"] = json!("wrong-model");
    assert_eq!(
        s.request(
            "POST",
            ORDERS,
            &serde_json::to_vec(&input).unwrap(),
            UnixMillis(1500)
        )
        .unwrap_err()
        .status,
        422
    );
    let snapshot = s.host().unwrap().snapshot();
    assert_eq!(snapshot.now(), UnixMillis(1500)); // separate trusted clock event
    assert!(snapshot.sells().is_empty());
    assert!(snapshot.sources().is_empty());
    assert!(snapshot.manual_seller_orders().unwrap().is_empty());
    let good = submit(&mut s, 1600);
    assert_eq!(
        good["receipt"]["registration"]["window"]["registered_at"],
        1600
    );
    assert_eq!(good["receipt"]["services"][1]["source_generation"], 1);
}
#[test]
fn close_preserves_accepted_unknown_responsibility_and_never_exposes_buyer_content() {
    let dir = mm::Dir::new();
    let (mut pure, input) = mf::prepare_market(false, false);
    let p = sf::buyer(&mut pure, 1, "a", "manual-api-buyer", false);
    let decision = pf::propose(&mut pure, &p);
    let id = pf::id(&decision);
    let c = mm::config(UnixMillis(1000));
    let mut m = DurableMarketHost::create(dir.market(), c.bootstrap().unwrap()).unwrap();
    for (key, command) in pure.journal().commands() {
        m.execute(key.clone(), command.clone()).unwrap();
    }
    let request = pf::request(
        &pure,
        &id,
        bitrouter_market::execution_contract::ExecutionRequestKind::Submit,
    );
    let mut authority = DurableAuthority::create(
        dir.0.join("authority.sqlite"),
        fixture::authority(false, pure.snapshot().now()),
        m.resolver(),
    )
    .unwrap();
    let report = m.dispatch(&request.effect_id, &mut authority).unwrap();
    m.receive("accepted".into(), (fx::AUTH, 4), report).unwrap();
    m.execute(
        "contact-lost".into(),
        ExchangeCommand::Frozen(Box::new(FrozenCommand::ContactLost(id.clone()))),
    )
    .unwrap();
    let before = m.host().unwrap().snapshot();
    let mut s = ManualSellerService::new(m, &c, 7).unwrap();
    let closed = call(
        &mut s,
        "POST",
        &format!("{ROOT}/close"),
        json!({"idempotency_key":"close-original"}),
        3500,
    );
    assert_eq!(closed["order"]["closed"], true);
    assert_eq!(closed["order"]["closure"]["reason"], "closed");
    assert_eq!(closed["order"]["attempts"][0]["unknown"], true);
    assert_eq!(closed["order"]["attempts"][0]["progress"], "Committed");
    assert!(closed["order"]["attempts"][0]["accepted_at"].is_number());
    let after = s.host().unwrap().snapshot();
    assert_eq!(before.purchase_trades(), after.purchase_trades());
    assert_eq!(before.frozen_grants(), after.frozen_grants());
    assert_eq!(before.execution_requests(), after.execution_requests());
    assert_eq!(
        after.sells()[&input.order.reference]
            .allocation()
            .attempts(),
        before.sells()[&input.order.reference]
            .allocation()
            .attempts()
    );
    let text = serde_json::to_string(&closed).unwrap();
    for private in [
        "token_ids",
        "held_cap",
        "logical_request_digest",
        "manual-api-buyer",
    ] {
        assert!(!text.contains(private));
    }
    let retry = call(
        &mut s,
        "POST",
        &format!("{ROOT}/close"),
        json!({"idempotency_key":"close-original"}),
        3600,
    );
    assert_eq!(retry["receipt"], closed["receipt"]);
    assert_eq!(retry["order"]["closure"], closed["order"]["closure"]);
}
#[test]
fn encoded_identity_and_same_key_conflicts_do_not_rewrite_tree_or_close_another_root() {
    let dir = mm::Dir::new();
    let mut s = service(&dir);
    let mut i = mf::input(false);
    i.order.reference =
        OrderRef::new("exchange".into(), OrderSide::Sell, 7, "中文/order %".into()).unwrap();
    let original = call(
        &mut s,
        "POST",
        ORDERS,
        serde_json::to_value(&i).unwrap(),
        1000,
    );
    let path = "/v4/manual-seller-orders/%E4%B8%AD%E6%96%87%2Forder%20%25";
    assert_eq!(
        call(&mut s, "GET", path, json!({}), 1100)["order"],
        original["order"]
    );
    let err = s
        .request(
            "POST",
            &format!("{path}/close"),
            br#"{"idempotency_key":"manual-submit"}"#,
            UnixMillis(1100),
        )
        .unwrap_err();
    assert_eq!(err.status, 409);
    assert!(!s.host().unwrap().snapshot().sells()[&i.order.reference]
        .allocation()
        .is_closed());
    assert_eq!(
        s.request("GET", ROOT, b"", UnixMillis(1100))
            .unwrap_err()
            .status,
        404
    );
}
#[test]
fn startup_rejects_bootstrap_drift_and_unregistered_provider_without_replacing_the_store() {
    let dir = mm::Dir::new();
    let mut s = service(&dir);
    submit(&mut s, 1000);
    drop(s);
    let mut c = mm::config(UnixMillis(1000));
    c.purchase_policy.time.grant_acceptance_window_ms += 1;
    assert!(
        ManualSellerService::new(DurableMarketHost::open(dir.market()).unwrap(), &c, 7).is_err()
    );
    let c = mm::config(UnixMillis(1000));
    assert!(
        ManualSellerService::new(DurableMarketHost::open(dir.market()).unwrap(), &c, 8).is_err()
    );
    let m = DurableMarketHost::open(dir.market()).unwrap();
    assert_eq!(
        m.host()
            .unwrap()
            .snapshot()
            .manual_seller_orders()
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn historical_view_and_retry_never_adopt_or_overwrite_a_successor_generation() {
    let dir = mm::Dir::new();
    let c = mm::config(UnixMillis(1000));
    let mut m = DurableMarketHost::create(dir.market(), c.bootstrap().unwrap()).unwrap();
    let original = mf::input(false);
    let original_receipt = m
        .execute(
            original.idempotency_key.clone(),
            ExchangeCommand::SubmitManualSellerOrder(Box::new(original.clone())),
        )
        .unwrap();
    m.execute(
        "close-first".into(),
        ExchangeCommand::Close(original.order.reference.clone()),
    )
    .unwrap();
    let mut next = original.clone();
    next.idempotency_key = "next-submit".into();
    next.order.reference =
        OrderRef::new("exchange".into(), OrderSide::Sell, 7, "successor".into()).unwrap();
    next.order.opportunity_id = "successor-opportunity".into();
    for option in &mut next.order.options {
        option.expected_binding_generation = 1;
    }
    for service in &mut next.services {
        service.schedule.reference.push_str("/successor");
    }
    m.execute(
        next.idempotency_key.clone(),
        ExchangeCommand::SubmitManualSellerOrder(Box::new(next)),
    )
    .unwrap();
    let mut s = ManualSellerService::new(m, &c, 7).unwrap();
    let view = call(&mut s, "GET", ROOT, json!({}), 1100);
    for option in view["order"]["options"].as_array().unwrap() {
        assert_eq!(option["source_is_current"], false);
        assert!(option["supply_state"].is_null());
        assert!(option["current_service"].is_null());
    }
    let mut retry = original;
    retry.idempotency_key = "retry-first".into();
    let r = call(
        &mut s,
        "POST",
        ORDERS,
        serde_json::to_value(retry).unwrap(),
        1200,
    );
    let ExchangeReceipt::ManualSellerOrderSubmitted(original_receipt) = original_receipt else {
        panic!("manual receipt")
    };
    assert_eq!(
        r["receipt"],
        serde_json::to_value(original_receipt).unwrap()
    );
    assert!(s
        .host()
        .unwrap()
        .snapshot()
        .sources()
        .values()
        .all(|source| source.generation == 2));
    let next = call(
        &mut s,
        "GET",
        "/v4/manual-seller-orders/successor",
        json!({}),
        1200,
    );
    assert!(next["order"]["options"]
        .as_array()
        .unwrap()
        .iter()
        .all(|option| option["source_is_current"] == true));
}
