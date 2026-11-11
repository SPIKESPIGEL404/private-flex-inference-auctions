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
use bitrouter_market::admission::*;
use bitrouter_market::durable::*;
use bitrouter_market::execution_contract::*;
use bitrouter_market::manual_market::*;
use bitrouter_market::order::*;
use lf::*;
use serde_json::{json, Value};

const ORDERS: &str = "/v4/formal-orders";
const ROOT: &str = "/v4/formal-orders/local-buyer";
fn service(dir: &mm::Dir, sim: bool) -> ManualSellerService {
    let c = lf::config(UnixMillis(1000), sim);
    ManualSellerService::shared(
        DurableMarketHost::create(dir.market(), c.bootstrap().unwrap()).unwrap(),
        &c,
    )
    .unwrap()
}
fn prepare(dir: &mm::Dir, attach: bool) -> (ManualSellerService, PlaceFormalOrder, Value) {
    prepare_mode(dir, attach, false)
}
fn prepare_mode(
    dir: &mm::Dir,
    attach: bool,
    ioc: bool,
) -> (ManualSellerService, PlaceFormalOrder, Value) {
    prepare_config(dir, attach, ioc, lf::config(UnixMillis(1000), true))
}
fn prepare_config(
    dir: &mm::Dir,
    attach: bool,
    ioc: bool,
    c: ManualMarketConfig,
) -> (ManualSellerService, PlaceFormalOrder, Value) {
    let mut s = ManualSellerService::shared(
        DurableMarketHost::create(dir.market(), c.bootstrap().unwrap()).unwrap(),
        &c,
    )
    .unwrap();
    if attach {
        s.open_local_simulation(dir.0.join("authority.sqlite"), true)
            .unwrap();
    }
    call(
        &mut s,
        PROVIDER,
        "POST",
        "/v4/manual-seller-orders",
        serde_json::to_value(mf::input(ioc)).unwrap(),
        1000,
    );
    call(
        &mut s,
        OPERATOR,
        "POST",
        "/v4/accounts/1/credits",
        json!({"idempotency_key":"credit-1","amount":1000}),
        1000,
    );
    let r = registration("local-buyer", 1);
    let receipt = call(
        &mut s,
        BUYER,
        "POST",
        ORDERS,
        serde_json::to_value(&r).unwrap(),
        1000,
    );
    s.poll(UnixMillis(1000)).unwrap();
    assert!(s
        .host()
        .unwrap()
        .snapshot()
        .frozen_grants()
        .unwrap()
        .is_empty());
    declare(&mut s, 1000, 9000);
    s.poll(UnixMillis(1000)).unwrap();
    assert!(s
        .host()
        .unwrap()
        .snapshot()
        .frozen_grants()
        .unwrap()
        .is_empty());
    let report = fx::report(30, 1, vec![]);
    call(
        &mut s,
        OPERATOR,
        "POST",
        "/v4/qualification/scope-reports",
        json!({"idempotency_key":"scope-a","evidence":report}),
        2000,
    );
    let data: QualificationOfferingContext = serde_json::from_value(call(
        &mut s,
        OPERATOR,
        "GET",
        "/v4/qualification/offerings/a/11",
        json!({}),
        2000,
    ))
    .unwrap();
    let throughput = observation(&data, UnixMillis(1000), UnixMillis(2000), UnixMillis(8000));
    call(
        &mut s,
        OPERATOR,
        "POST",
        "/v4/qualification/throughput",
        json!({"idempotency_key":"measured-a","evidence":throughput}),
        2000,
    );
    let data: QualificationOfferingContext = serde_json::from_value(call(
        &mut s,
        OPERATOR,
        "GET",
        "/v4/qualification/offerings/a/11",
        json!({}),
        2000,
    ))
    .unwrap();
    let window =
        serde_json::from_value(receipt["order"]["registration_receipt"]["window"].clone()).unwrap();
    let q = quote(&r, window, &data, "local-buyer");
    call(
        &mut s,
        OPERATOR,
        "POST",
        "/v4/qualification/purchase-quotes",
        json!({"idempotency_key":"quote-a","evidence":q}),
        2000,
    );
    s.poll(UnixMillis(2000)).unwrap();
    (s, r, receipt)
}
fn finish(s: &mut ManualSellerService) {
    for now in [2010, 2030, 2050, 2100] {
        s.poll(UnixMillis(now)).unwrap();
    }
}
#[test]
fn authenticated_manual_supply_and_buyer_flow_routes_executes_and_delivers_on_one_writer() {
    let dir = mm::Dir::new();
    let (mut s, r, original) = prepare(&dir, true);
    let state = call(&mut s, BUYER, "GET", ROOT, json!({}), 2000);
    assert_eq!(
        state["order"]["registration"],
        serde_json::to_value(&r).unwrap()
    );
    assert_eq!(state["order"]["trades"].as_array().unwrap().len(), 1);
    assert_eq!(state["order"]["trades"][0]["accepted_at"], 2000);
    finish(&mut s);
    let results = call(
        &mut s,
        BUYER,
        "GET",
        &format!("{ROOT}/results"),
        json!({}),
        2100,
    );
    assert_eq!(results["results"].as_array().unwrap().len(), 1);
    let bytes: Vec<u8> = serde_json::from_value(results["results"][0]["bytes"].clone()).unwrap();
    let response: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(response["text"], "explicit-local-fixture-result");
    assert_eq!(response["complete"], true);
    let snapshot = s.host().unwrap().snapshot();
    assert_eq!(
        response["binding"],
        serde_json::to_value(
            &snapshot
                .frozen_grants()
                .unwrap()
                .values()
                .next()
                .unwrap()
                .authorization
                .binding
        )
        .unwrap()
    );
    assert_eq!(snapshot.accounts()[&1].held(), MicroUsd(0));
    assert_eq!(snapshot.accounts()[&1].balance(), MicroUsd(989));
    assert_eq!(snapshot.occupancy(AdmissionScopeId(30)), 0);
    assert_eq!(
        snapshot
            .execution_requests()
            .unwrap()
            .values()
            .filter(|r| r.kind == ExecutionRequestKind::Submit)
            .count(),
        1
    );
    assert_eq!(snapshot.frozen_grants().unwrap().len(), 1);
    let retry = call(
        &mut s,
        BUYER,
        "POST",
        ORDERS,
        serde_json::to_value(r).unwrap(),
        2200,
    );
    assert_eq!(retry["receipt"], original["receipt"]);
    assert_eq!(
        s.host().unwrap().snapshot().accounts()[&1].balance(),
        MicroUsd(989)
    );
}
#[test]
fn buyer_and_provider_cannot_impersonate_or_submit_operator_qualification_or_credit() {
    let dir = mm::Dir::new();
    let mut s = service(&dir, false);
    let original = s.host().unwrap().snapshot();
    for (principal, method, path, body, status) in [
        (
            BUYER,
            "POST",
            ORDERS,
            serde_json::to_value(registration("wrong", 2)).unwrap(),
            403,
        ),
        (
            BUYER,
            "POST",
            "/v4/accounts/1/credits",
            json!({"idempotency_key":"x","amount":1000}),
            403,
        ),
        (
            PROVIDER,
            "POST",
            ORDERS,
            serde_json::to_value(registration("wrong", 1)).unwrap(),
            403,
        ),
        (
            PROVIDER,
            "POST",
            "/v4/qualification/scope-reports",
            json!({}),
            403,
        ),
        (
            BUYER,
            "GET",
            "/v4/qualification/offerings/a/11",
            json!({}),
            403,
        ),
        (
            OPERATOR,
            "POST",
            ORDERS,
            serde_json::to_value(registration("wrong", 1)).unwrap(),
            403,
        ),
        (
            BUYER,
            "POST",
            ORDERS,
            json!({"idempotency_key":"duplicate","scheduler":{"accepted":true}}),
            400,
        ),
    ] {
        assert_eq!(
            s.request_as(
                principal,
                method,
                path,
                &serde_json::to_vec(&body).unwrap(),
                UnixMillis(2000)
            )
            .unwrap_err()
            .status,
            status
        );
    }
    assert_eq!(s.host().unwrap().snapshot(), original);
    let r = registration("local-buyer", 1);
    call(
        &mut s,
        BUYER,
        "POST",
        ORDERS,
        serde_json::to_value(&r).unwrap(),
        1000,
    );
    let other = LocalPrincipal::Buyer { buyer_id: 2 };
    assert_eq!(
        s.request_as(other, "GET", ROOT, b"", UnixMillis(1000))
            .unwrap_err()
            .status,
        404
    );
    assert_eq!(
        s.request_as(
            other,
            "POST",
            &format!("{ROOT}/close"),
            br#"{"idempotency_key":"steal-close","authorization_version":1}"#,
            UnixMillis(1000)
        )
        .unwrap_err()
        .status,
        404
    );
    assert_eq!(
        s.request_as(
            other,
            "GET",
            &format!("{ROOT}/results"),
            b"",
            UnixMillis(1000)
        )
        .unwrap_err()
        .status,
        404
    );
}
#[test]
fn unfunded_registration_waits_credit_wakes_it_and_user_close_returns_original_receipt() {
    let dir = mm::Dir::new();
    let mut s = service(&dir, false);
    let r = registration("local-buyer", 1);
    let original = call(
        &mut s,
        BUYER,
        "POST",
        ORDERS,
        serde_json::to_value(&r).unwrap(),
        1000,
    );
    let view = call(&mut s, BUYER, "GET", ROOT, json!({}), 1000);
    assert!(view["order"]["funding"].is_null());
    assert_eq!(view["order"]["last_review"]["status"], "waiting_funds");
    call(
        &mut s,
        OPERATOR,
        "POST",
        "/v4/accounts/1/credits",
        json!({"idempotency_key":"credit","amount":1000}),
        1000,
    );
    let view = call(&mut s, BUYER, "GET", ROOT, json!({}), 1000);
    assert!(!view["order"]["funding"].is_null());
    assert_eq!(view["order"]["last_review"]["status"], "waiting_supply");
    let closed = call(
        &mut s,
        BUYER,
        "POST",
        &format!("{ROOT}/close"),
        json!({"idempotency_key":"close-buyer","authorization_version":1}),
        1100,
    );
    assert_eq!(closed["order"]["closure"]["reason"], "user_requested");
    let retry = call(
        &mut s,
        BUYER,
        "POST",
        &format!("{ROOT}/close"),
        json!({"idempotency_key":"close-buyer","authorization_version":1}),
        1200,
    );
    assert_eq!(retry["receipt"], closed["receipt"]);
    assert_eq!(
        s.host().unwrap().snapshot().accounts()[&1].held(),
        MicroUsd(0)
    );
    let retry = call(
        &mut s,
        BUYER,
        "POST",
        ORDERS,
        serde_json::to_value(r).unwrap(),
        1300,
    );
    assert_eq!(retry["receipt"], original["receipt"]);
    assert_eq!(retry["order"]["closed"], true);
}
#[test]
fn restart_after_send_marker_queries_then_fences_original_unknown_without_resubmitting() {
    let dir = mm::Dir::new();
    let (s, _, _) = prepare(&dir, false);
    let before = s.host().unwrap().snapshot();
    assert_eq!(before.purchase_trades().unwrap().len(), 1);
    let submit = before
        .execution_requests()
        .unwrap()
        .values()
        .find(|r| r.kind == ExecutionRequestKind::Submit)
        .unwrap()
        .clone();
    drop(s);
    let mut m = DurableMarketHost::open(dir.market()).unwrap();
    m.mark_sent(&submit.effect_id).unwrap(); // crash/lost delivery boundary
    drop(m);
    let c = lf::config(UnixMillis(1000), true);
    let mut s =
        ManualSellerService::shared(DurableMarketHost::open(dir.market()).unwrap(), &c).unwrap();
    s.open_local_simulation(dir.0.join("authority.sqlite"), true)
        .unwrap();
    s.poll(UnixMillis(2020)).unwrap();
    let view = call(
        &mut s,
        BUYER,
        "POST",
        &format!("{ROOT}/close"),
        json!({"idempotency_key":"close-unknown","authorization_version":1}),
        2021,
    );
    assert_eq!(view["order"]["trades"][0]["unknown"], true);
    assert!(view["order"]["trades"][0]["accepted_at"].is_null());
    assert_eq!(
        s.host().unwrap().snapshot().accounts()[&1].held(),
        MicroUsd(100)
    );
    s.poll(UnixMillis(2500)).unwrap();
    assert_eq!(
        s.host().unwrap().snapshot().accounts()[&1].held(),
        MicroUsd(0)
    );
    assert_eq!(
        s.host().unwrap().snapshot().frozen_grants().unwrap().len(),
        1
    );
    assert_eq!(
        s.host()
            .unwrap()
            .snapshot()
            .execution_requests()
            .unwrap()
            .values()
            .filter(|r| r.kind == ExecutionRequestKind::Submit)
            .count(),
        1
    );
    drop(s);
    let a = DurableAuthority::open(dir.0.join("authority.sqlite")).unwrap();
    assert_eq!(
        a.task_start_count("exchange", &submit.binding.attempt_id)
            .unwrap(),
        0
    );
}
#[test]
fn successful_result_and_charge_survive_both_stores_reopening_and_no_reexecution() {
    let dir = mm::Dir::new();
    let (mut s, r, _) = prepare(&dir, true);
    finish(&mut s);
    let result = call(
        &mut s,
        BUYER,
        "GET",
        &format!("{ROOT}/results"),
        json!({}),
        2100,
    );
    let snapshot = s.host().unwrap().snapshot();
    drop(s);
    let c = lf::config(UnixMillis(1000), true);
    let mut s =
        ManualSellerService::shared(DurableMarketHost::open(dir.market()).unwrap(), &c).unwrap();
    s.open_local_simulation(dir.0.join("authority.sqlite"), false)
        .unwrap();
    let recovered = call(
        &mut s,
        BUYER,
        "GET",
        &format!("{ROOT}/results"),
        json!({}),
        2200,
    );
    assert_eq!(recovered["results"], result["results"]);
    assert_eq!(s.host().unwrap().snapshot().accounts(), snapshot.accounts());
    call(
        &mut s,
        BUYER,
        "POST",
        ORDERS,
        serde_json::to_value(r).unwrap(),
        2300,
    );
    s.poll(UnixMillis(2400)).unwrap();
    let id = snapshot
        .purchase_trades()
        .unwrap()
        .keys()
        .next()
        .unwrap()
        .clone();
    drop(s);
    let a = DurableAuthority::open(dir.0.join("authority.sqlite")).unwrap();
    assert_eq!(a.task_start_count("exchange", &id).unwrap(), 1);
}
#[test]
fn runtime_policy_drift_and_an_authority_bound_to_another_market_store_are_rejected() {
    let first = mm::Dir::new();
    let (s, _, _) = prepare(&first, true);
    drop(s);
    let mut c = lf::config(UnixMillis(1000), true);
    c.runtime.as_mut().unwrap().worker_budget += 1;
    assert!(
        ManualSellerService::shared(DurableMarketHost::open(first.market()).unwrap(), &c).is_err()
    );
    let second = mm::Dir::new();
    let mut s = service(&second, true);
    assert!(s
        .open_local_simulation(first.0.join("authority.sqlite"), false)
        .is_err());
    let mut c = lf::config(UnixMillis(1000), false);
    c.runtime.as_mut().unwrap().execution_budget = 0;
    assert!(c.bootstrap().is_err());
}

#[test]
fn continuous_loop_uses_the_original_finite_seller_ioc_round_and_delivers_its_single_opportunity() {
    let dir = mm::Dir::new();
    let (mut s, _, _) = prepare_mode(&dir, true, true);
    let snapshot = s.host().unwrap().snapshot();
    let seller = snapshot.seller_orders().unwrap().values().next().unwrap();
    assert!(seller.closure().is_some());
    assert_eq!(seller.receipt().window.registered_at, UnixMillis(1000));
    assert_eq!(seller.receipt().window.decision_before, UnixMillis(6000));
    assert_eq!(snapshot.frozen_grants().unwrap().len(), 1);
    finish(&mut s);
    let result = call(
        &mut s,
        BUYER,
        "GET",
        &format!("{ROOT}/results"),
        json!({}),
        2100,
    );
    assert_eq!(result["results"].as_array().unwrap().len(), 1);
    assert_eq!(
        s.host().unwrap().snapshot().frozen_grants().unwrap().len(),
        1
    );
}

#[test]
fn each_poll_respects_worker_and_execution_budgets_and_resumes_the_same_pending_work() {
    let dir = mm::Dir::new();
    let mut c = lf::config(UnixMillis(1000), true);
    let p = c.runtime.as_mut().unwrap();
    p.formal_budget = 1;
    p.execution_budget = 1;
    p.worker_budget = 1;
    let sim = p.simulation.as_mut().unwrap();
    sim.first_response_after_ms = 0;
    sim.complete_after_ms = 0;
    let (s, _, _) = prepare_config(&dir, true, false, c.clone());
    let id = s
        .host()
        .unwrap()
        .snapshot()
        .purchase_trades()
        .unwrap()
        .keys()
        .next()
        .unwrap()
        .clone();
    drop(s);
    let a = DurableAuthority::open(dir.0.join("authority.sqlite")).unwrap();
    let attempt = a.authority().unwrap().attempts().values().next().unwrap();
    assert!(matches!(
        attempt.state,
        ExecutionReportState::Running { .. }
    ));
    assert!(attempt
        .milestones
        .as_ref()
        .unwrap()
        .first_response_at
        .is_none());
    assert_eq!(a.task_start_count("exchange", &id).unwrap(), 1);
    drop(a);
    let mut s =
        ManualSellerService::shared(DurableMarketHost::open(dir.market()).unwrap(), &c).unwrap();
    s.open_local_simulation(dir.0.join("authority.sqlite"), false)
        .unwrap();
    s.poll(UnixMillis(2000)).unwrap(); // one first-response worker action
    drop(s);
    let a = DurableAuthority::open(dir.0.join("authority.sqlite")).unwrap();
    let attempt = a.authority().unwrap().attempts().values().next().unwrap();
    assert!(matches!(
        attempt.state,
        ExecutionReportState::Running { .. }
    ));
    assert!(attempt
        .milestones
        .as_ref()
        .unwrap()
        .first_response_at
        .is_some());
    drop(a);
    let mut s =
        ManualSellerService::shared(DurableMarketHost::open(dir.market()).unwrap(), &c).unwrap();
    s.open_local_simulation(dir.0.join("authority.sqlite"), false)
        .unwrap();
    s.poll(UnixMillis(2000)).unwrap(); // one terminal worker action
    s.poll(UnixMillis(2050)).unwrap(); // create Query only, budget = 1
    let snapshot = s.host().unwrap().snapshot();
    let query = snapshot
        .execution_requests()
        .unwrap()
        .values()
        .find(|r| r.kind == ExecutionRequestKind::Query)
        .unwrap();
    assert!(!snapshot.execution_request_sent(&query.effect_id));
    assert!(snapshot.purchase_result(&id).is_none());
    s.poll(UnixMillis(2050)).unwrap(); // dispatch same Query; publish once
    assert!(s.host().unwrap().snapshot().purchase_result(&id).is_some());
    assert_eq!(
        s.host().unwrap().snapshot().accounts()[&1].balance(),
        MicroUsd(989)
    );
}
