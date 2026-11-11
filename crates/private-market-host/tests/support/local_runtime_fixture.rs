use crate::{fx, mm, pf};
use bitrouter_market::admission::*;
use bitrouter_market::cache::*;
use bitrouter_market::candidate::CandidateInput;
use bitrouter_market::exchange::*;
use bitrouter_market::execution_coordinator::*;
use bitrouter_market::formal_order::PlaceFormalOrder;
use bitrouter_market::manual_market::*;
use bitrouter_market::order::*;
use bitrouter_market::purchase_order::*;
use bitrouter_market::quote::LoadSnapshot;
use bitrouter_market::terms::SupplyState;
use bitrouter_market::throughput::*;
// Shared by Rust 2021 domain fixtures and the Rust 2024 Cloud harness.
#[rustfmt::skip]
use serde_json::{json, Value};

pub const BUYER: LocalPrincipal = LocalPrincipal::Buyer { buyer_id: 1 };
pub const PROVIDER: LocalPrincipal = LocalPrincipal::Provider { provider_id: 7 };
pub const OPERATOR: LocalPrincipal = LocalPrincipal::Operator;
pub fn config(now: UnixMillis, simulation: bool) -> ManualMarketConfig {
    let mut c = mm::config(now);
    c.runtime = Some(LocalRuntimePolicy {
        version: 1,
        reference: "fixture/local-market-runtime".into(),
        revision: 1,
        formal_budget: 16,
        execution_budget: 16,
        worker_budget: 16,
        coordination: ExecutionCoordinationPolicy {
            version: 1,
            reference: "fixture/local-coordinate".into(),
            revision: 1,
            query_interval_ms: 50,
            unknown_retry_interval_ms: 20,
        },
        simulation: simulation.then(|| LocalSimulationPolicy {
            rules_ref: "bitrouter-market/local-exact-simulation-v1".into(),
            authority_id: fx::AUTH,
            source_epoch: 4,
            ready_scopes: vec![AdmissionScopeId(30), AdmissionScopeId(31)],
            protocol_ref: c.specs[0].request_protocol_ref.clone(),
            start_after_ms: 0,
            first_response_after_ms: 10,
            complete_after_ms: 30,
            output_tokens: 1,
            text: "explicit-local-fixture-result".into(),
        }),
    });
    c
}
pub fn registration(name: &str, owner: u64) -> PlaceFormalOrder {
    pf::registration(name, owner, &["a"], false)
}
pub fn call(
    s: &mut ManualSellerService,
    p: LocalPrincipal,
    method: &str,
    path: &str,
    body: Value,
    now: u64,
) -> Value {
    s.request_as(
        p,
        method,
        path,
        &serde_json::to_vec(&body).unwrap(),
        UnixMillis(now),
    )
    .unwrap()
}
pub fn declare(s: &mut ManualSellerService, now: u64, until: u64) -> Value {
    call(
        s,
        PROVIDER,
        "POST",
        "/v4/supply-declarations",
        json!({"idempotency_key":"provider-ready-a",
        "source":{"market_id":"a","offering_id":11},"generation":1,"state":SupplyState {
            readiness:Readiness::Ready,throughput:ThroughputClaim {profile_ref:fx::profile("a").reference,
                rate:ThroughputRate {output_tokens:1,completed_requests:1,interval_ms:1000}},observed_at:UnixMillis(now),valid_until:UnixMillis(until)}}),
        now,
    )
}
pub fn observation(
    context: &QualificationOfferingContext,
    start: UnixMillis,
    end: UnixMillis,
    until: UnixMillis,
) -> ThroughputObservation {
    ThroughputObservation {
        offering: context.offering.clone().unwrap(),
        profile: context.member.profile.clone(),
        started_at: start,
        ended_at: end,
        valid_until: until,
        demand_sufficient: true,
        completed_requests: 10,
        failed_requests: 0,
        billable_output_tokens: 10,
        p95_e2e_ms: Some(100),
    }
}
pub fn quote(
    r: &PlaceFormalOrder,
    window: OrderWindow,
    data: &QualificationOfferingContext,
    label: &str,
) -> PurchaseQuotePublication {
    let spec = &data.spec;
    let alternative = &r.authorization.options[0];
    let offering = data.offering.clone().unwrap();
    let backend = data.member.offering.backend_refs[0].clone();
    let report = data.report.as_ref().unwrap();
    let scope = CacheScope {
        market_spec_ref: spec.reference.clone(),
        model_ref: spec.model_ref.clone(),
        agent_config_ref: offering.agent_config_ref.clone(),
        backend_ref: backend.clone(),
        cache_domain_ref: "explicit-cold-fixture".into(),
    };
    let cache = CacheIndex::new(spec, scope.clone(), data.market_time)
        .unwrap()
        .snapshot();
    let context = PurchaseQuoteContext {
        root: r.authorization.binding.clone(),
        option_id: alternative.option_id,
        spec: spec.clone(),
        tokens: TokenizedRequest::from_request(
            spec,
            &alternative.request,
            (0..alternative.request.size.input_tokens as u32).collect(),
        )
        .unwrap(),
        profile: data.member.profile.clone(),
        throughput_filter: ThroughputFilter {
            minimum: ThroughputRate {
                output_tokens: 1,
                completed_requests: 1,
                interval_ms: 1000,
            },
        },
        output_estimate: data.member.profile.output_estimate,
        compared_at: data.market_time,
    };
    let input = CandidateInput {
        offer_id: offering.id,
        offering,
        scope,
        cache,
        load: LoadSnapshot {
            reference: format!("load/{label}"),
            version: report.metadata.version.sequence,
            source_ref: "explicit-local-scope".into(),
            agent_config_ref: data.member.offering.agent_config_ref.clone(),
            backend_ref: backend,
            market_requests: data.occupancy,
            observed_at: report.metadata.observed_at,
            valid_until: report.metadata.valid_until,
        },
        prediction: None,
        throughput_observation: data.throughput.clone(),
        market_requests_after_admission: data.occupancy + 1,
    };
    PurchaseQuotePublication {
        quote_ref: format!("quote/{label}"),
        evidence_ref: format!("evidence/{label}"),
        source_generation: data.source.generation,
        seller_option: data.source.option.clone(),
        load_report: report.metadata.clone(),
        service: data
            .service
            .as_ref()
            .unwrap()
            .schedule
            .freeze(alternative.request.size)
            .unwrap(),
        quote: qualify_total_cap(r, window, &context, &input).unwrap(),
    }
}
