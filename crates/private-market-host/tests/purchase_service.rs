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
#[path = "support/purchase_fixture.rs"]
mod pf;
use bitrouter_market::durable::*;
use bitrouter_market::exchange::*;
use bitrouter_market::execution_contract::*;
use bitrouter_market::market_host::MarketHost;
use bitrouter_market::order::*;
use bitrouter_market::purchase_order::*;
use bitrouter_market::seller_service::*;
use pf::*;

fn revised(h: &MarketHost) -> SellerServicePublication {
    let mut p = h
        .snapshot()
        .seller_service(&fixture::source("a"))
        .unwrap()
        .clone();
    p.schedule.revision += 1;
    p.schedule.bins[0].hard_delivery_within_ms = 90_000;
    p.schedule.bins[0].delivery = DeliveryConditions::PerformanceTarget {
        first_response_within_ms: 200,
        complete_within_ms: 2_000,
    };
    p
}
fn service(h: &mut MarketHost, key: &str, p: SellerServicePublication) {
    fixture::run(h, key, ExchangeCommand::PublishSellerService(Box::new(p)));
}
fn prepared(h: &mut MarketHost) -> (PlaceFormalOrder, PurchaseQuotePublication) {
    let r = registration("root", 1, &["a"], false);
    register(h, &r);
    let q = publication(h, &r, 1, "first");
    publish(h, &q);
    (r, q)
}

#[test]
fn throughput_and_ready_without_explicit_seller_contract_cannot_publish_purchase() {
    let (mut full, _) = setup(false, false);
    let mut missing = bootstrap(false);
    for (key, command) in full.journal().commands() {
        if !matches!(command, ExchangeCommand::PublishSellerService(_)) {
            missing.execute(key.clone(), command.clone()).unwrap();
        }
    }
    let (r, q) = prepared(&mut full);
    register(&mut missing, &r);
    let before = missing.snapshot();
    assert!(missing
        .execute(
            "no-service".into(),
            ExchangeCommand::PurchaseQuote(Box::new(q))
        )
        .is_err());
    assert_eq!(missing.snapshot(), before);
    assert!(before.purchase_trades().unwrap().is_empty());
    let first = service_publication(&missing, "a");
    service(&mut missing, "first-service", first.clone());
    let mut rebound = service_publication(&missing, "b");
    rebound.schedule.reference = first.schedule.reference;
    rebound.schedule.revision = 2;
    let before = missing.snapshot();
    assert!(missing
        .execute(
            "rebound".into(),
            ExchangeCommand::PublishSellerService(Box::new(rebound))
        )
        .is_err());
    assert_eq!(missing.snapshot(), before);
}

#[test]
fn service_terms_are_immutable_even_before_g_and_replay_keeps_original() {
    let (mut h, _) = setup(false, false);
    let (r, q) = prepared(&mut h);
    let original = h
        .snapshot()
        .seller_service(&fixture::source("a"))
        .unwrap()
        .clone();
    let before = h.snapshot();
    assert!(h
        .execute(
            "revision-2".into(),
            ExchangeCommand::PublishSellerService(Box::new(revised(&h)))
        )
        .is_err());
    assert_eq!(h.snapshot(), before);
    service(&mut h, "historical-retry", original.clone());
    assert_eq!(
        h.snapshot().seller_service(&fixture::source("a")),
        Some(&original)
    );
    let p = proposal(&h, &r, &[q], "original-still-valid");
    id(&propose(&mut h, &p));
}

fn initial_service(change: impl FnOnce(&mut SellerServicePublication)) -> MarketHost {
    let (h, _) = setup(false, false);
    let mut p = h
        .snapshot()
        .seller_service(&fixture::source("a"))
        .unwrap()
        .clone();
    change(&mut p);
    let mut target = bootstrap(false);
    for (key, command) in h.journal().commands() {
        if !matches!(command, ExchangeCommand::PublishSellerService(s) if s.offering == fixture::source("a"))
        {
            target.execute(key.clone(), command.clone()).unwrap();
        }
    }
    service(&mut target, "initial-service", p);
    target
}

#[test]
fn forged_bin_price_time_or_content_cannot_pass_current_contract_revalidation() {
    let (mut h, _) = setup(false, false);
    let (_r, q) = prepared(&mut h);
    let mut variants = vec![];
    let mut b = q.clone();
    b.service.rates.output += 1;
    variants.push(b);
    let mut b = q.clone();
    b.service.bin.delivery = DeliveryConditions::PerformanceTarget {
        first_response_within_ms: 1,
        complete_within_ms: 2,
    };
    variants.push(b);
    let mut b = q.clone();
    b.service.bin.bin_id = "other-bin".into();
    variants.push(b);
    let mut b = q;
    b.service.schedule.sha256 = "0".repeat(64);
    variants.push(b);
    for (i, mut b) in variants.into_iter().enumerate() {
        b.quote_ref = format!("forged/quote/{i}");
        b.evidence_ref = format!("forged/evidence/{i}");
        let before = h.snapshot();
        assert!(h
            .execute(
                format!("forged/{i}"),
                ExchangeCommand::PurchaseQuote(Box::new(b))
            )
            .is_err());
        assert_eq!(h.snapshot(), before);
    }
}

#[test]
fn service_publication_checks_owner_source_version_identity_and_whole_range() {
    let (mut h, _) = setup(false, false);
    let next = revised(&h);
    let mut variants = vec![];
    let mut b = next.clone();
    b.schedule.provider_id += 1;
    variants.push(b);
    let mut b = next.clone();
    b.source_generation += 1;
    variants.push(b);
    let mut b = next.clone();
    b.quote_version.update_seq += 1;
    variants.push(b);
    let mut b = next.clone();
    b.schedule.reference = "new-identity-same-source".into();
    variants.push(b);
    let mut b = next.clone();
    b.schedule.bins.push(b.schedule.bins[0].clone());
    b.schedule.bins[1].bin_id = "overlap".into();
    variants.push(b);
    for (i, b) in variants.into_iter().enumerate() {
        let before = h.snapshot();
        assert!(h
            .execute(
                format!("bad-service/{i}"),
                ExchangeCommand::PublishSellerService(Box::new(b))
            )
            .is_err());
        assert_eq!(h.snapshot(), before);
    }
    let h = initial_service(|p| p.schedule.bins[0].max_billable_output_tokens.min_inclusive = 2);
    let r = registration("narrow", 1, &["a"], false);
    assert!(h
        .snapshot()
        .seller_service(&fixture::source("a"))
        .unwrap()
        .schedule
        .freeze(r.authorization.options[0].request.size)
        .is_err());
    // A valid narrow service cannot be widened by forged frozen terms.
    let prior = service_publication(&h, "a")
        .schedule
        .freeze(r.authorization.options[0].request.size)
        .unwrap();
    let mut json = serde_json::to_value(prior).unwrap();
    json["bin"]["max_billable_output_tokens"]["min_inclusive"] = 2.into();
    let decoded: FrozenServiceTerms = serde_json::from_value(json).unwrap();
    assert_eq!(
        decoded.validate_for(r.authorization.options[0].request.size),
        Err(ServiceError::OutsideService)
    );
}

#[test]
fn target_overflow_at_possible_e_time_cannot_create_a_partial_g() {
    let mut h = initial_service(|p| {
        p.schedule.bins[0].delivery = DeliveryConditions::PerformanceTarget {
            first_response_within_ms: 1,
            complete_within_ms: u64::MAX,
        }
    });
    let (r, q) = prepared(&mut h);
    let p = proposal(&h, &r, &[q], "overflow");
    assert!(matches!(
        propose(&mut h, &p).result,
        PurchaseResult::NoOpportunity { .. }
    ));
    let s = h.snapshot();
    assert!(s.purchase_trades().unwrap().is_empty());
    assert!(s.frozen_grants().unwrap().is_empty());
    assert!(s.execution_requests().unwrap().is_empty());
    assert_eq!(
        s.occupancy(bitrouter_market::admission::AdmissionScopeId(30)),
        0
    );
    assert_eq!(s.accounts()[&1].held(), MicroUsd(100));
}

#[test]
fn g_freezes_old_service_for_e_and_acceptance_clock_includes_queue_past_tif() {
    let (mut h, mut a) = setup(false, false);
    let mut r = registration("short-tif", 1, &["a"], false);
    let t0 = h.snapshot().now();
    r.authorization.tif = TimeInForce::Gtd {
        expires_at: UnixMillis(t0.0 + 200),
    };
    register(&mut h, &r);
    let q = publication(&h, &r, 1, "short-tif");
    publish(&mut h, &q);
    let frozen = q.service.clone();
    let p = proposal(&h, &r, &[q], "short-tif");
    let id = id(&propose(&mut h, &p));
    let next = revised(&h);
    assert!(h
        .execute(
            "new-service-after-g".into(),
            ExchangeCommand::PublishSellerService(Box::new(next))
        )
        .is_err());
    let seller = h.snapshot().sources()[&fixture::source("a")]
        .option
        .as_ref()
        .unwrap()
        .order
        .clone();
    fixture::run(&mut h, "withdraw", ExchangeCommand::Close(seller));
    let accepted_at = UnixMillis(t0.0 + 100);
    fixture::run(
        &mut h,
        "accept-time",
        ExchangeCommand::AdvanceTime(accepted_at),
    );
    let effect = request(&h, &id, ExecutionRequestKind::Submit).effect_id;
    let report = h.dispatch(&effect, &mut a).unwrap();
    assert_eq!(
        report.observation,
        ExecutionReportState::Accepted { accepted_at }
    );
    h.receive("accepted".into(), a.origin(), report).unwrap();
    let auth = &a.attempts()[&("exchange".into(), id.clone())].authorization;
    assert_eq!(auth.purchase.service, frozen);
    let targets = frozen.targets_after(accepted_at).unwrap();
    assert_eq!(targets.completion_target_at, UnixMillis(t0.0 + 1_100));
    assert!(targets.completion_target_at.0 > t0.0 + 200);
    let started_at = UnixMillis(t0.0 + 400);
    a.start("exchange", &id, started_at).unwrap();
    fixture::run(
        &mut h,
        "queue-time",
        ExchangeCommand::AdvanceTime(started_at),
    );
    let running = query(
        &mut h,
        &mut a,
        &id,
        ExecutionRequestKind::Query,
        "running-query",
    );
    h.receive("running".into(), a.origin(), running).unwrap();
    assert_eq!(
        h.snapshot().purchase_trades().unwrap()[&id].started_at,
        Some(started_at)
    );
    // A missed performance target creates no invented penalty or cancellation.
    let ended_at = UnixMillis(t0.0 + 1_500);
    a.finish(
        "exchange",
        &id,
        ExecutionOutcome::Completed,
        Some(TokenUsage {
            uncached_input_tokens: 10,
            cached_input_tokens: 0,
            billable_output_tokens: 1,
        }),
        ended_at,
    )
    .unwrap();
    fixture::run(&mut h, "end-time", ExchangeCommand::AdvanceTime(ended_at));
    let terminal = query(
        &mut h,
        &mut a,
        &id,
        ExecutionRequestKind::Query,
        "terminal-query",
    );
    h.receive("terminal".into(), a.origin(), terminal).unwrap();
    assert_eq!(
        h.snapshot().purchase_trades().unwrap()[&id].settlement,
        ReservationSettlement::AwaitingDelivery
    );
}

#[test]
fn execution_projection_rejects_unknown_service_and_mismatched_request_rate_or_model() {
    let (mut h, _) = setup(false, false);
    let (r, q) = prepared(&mut h);
    let p = proposal(&h, &r, &[q], "g");
    let id = id(&propose(&mut h, &p));
    let auth = h.snapshot().frozen_grants().unwrap()[&id]
        .authorization
        .clone();
    let mut variants = vec![];
    let mut b = auth.clone();
    b.purchase.service.version += 1;
    variants.push(b);
    let mut b = auth.clone();
    b.purchase.service.rates.input += 1;
    variants.push(b);
    let mut b = auth.clone();
    b.purchase.service.model_ref.push_str("-other");
    variants.push(b);
    let mut b = auth.clone();
    b.purchase.service.bin.input_tokens.max_inclusive = 0;
    variants.push(b);
    let mut b = auth;
    b.policy = "total-cap-frozen-execution-v1".into();
    variants.push(b);
    for b in variants {
        assert!(b.validate().is_err());
    }
}

struct Dir(std::path::PathBuf);
impl Dir {
    fn new() -> Self {
        static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let p = std::env::temp_dir().join(format!(
            "bitrouter-service-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        std::fs::create_dir(&p).unwrap();
        Self(p)
    }
}
impl Drop for Dir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn atomic_snapshot_keeps_immutable_offer_and_original_g_and_e_terms() {
    let dir = Dir::new();
    let market = dir.0.join("market.sqlite");
    let authority = dir.0.join("authority.sqlite");
    let (mut h, a) = setup(false, false);
    let (r, q) = prepared(&mut h);
    let p = proposal(&h, &r, std::slice::from_ref(&q), "durable");
    let id = id(&propose(&mut h, &p));
    let mut m = DurableMarketHost::create(&market, bootstrap(false)).unwrap();
    for (key, c) in h.journal().commands() {
        m.execute(key.clone(), c.clone()).unwrap();
    }
    let original = m
        .host()
        .unwrap()
        .snapshot()
        .seller_service(&fixture::source("a"))
        .unwrap()
        .clone();
    assert!(m
        .execute(
            "new-service".into(),
            ExchangeCommand::PublishSellerService(Box::new(revised(m.host().unwrap())))
        )
        .is_err());
    drop(m);
    let mut m = DurableMarketHost::open(&market).unwrap();
    assert_eq!(
        m.host()
            .unwrap()
            .snapshot()
            .seller_service(&fixture::source("a")),
        Some(&original)
    );
    assert_eq!(
        m.host().unwrap().snapshot().frozen_grants().unwrap()[&id]
            .authorization
            .purchase
            .service,
        q.service
    );
    let mut a = DurableAuthority::create(&authority, a, m.resolver()).unwrap();
    let effect = request(m.host().unwrap(), &id, ExecutionRequestKind::Submit).effect_id;
    let report = m.dispatch(&effect, &mut a).unwrap();
    assert!(matches!(
        report.observation,
        ExecutionReportState::Accepted { .. }
    ));
    m.receive("accepted".into(), a.authority().unwrap().origin(), report)
        .unwrap();
    drop(a);
    drop(m);
    let a = DurableAuthority::open(&authority).unwrap();
    let m = DurableMarketHost::open(&market).unwrap();
    assert_eq!(
        a.authority().unwrap().attempts()[&("exchange".into(), id.clone())]
            .authorization
            .purchase
            .service,
        q.service
    );
    assert_eq!(
        m.host()
            .unwrap()
            .snapshot()
            .purchase_trades()
            .unwrap()
            .len(),
        1
    );
}
