use crate::{fixture, fx};
use bitrouter_market::admission::*;
use bitrouter_market::authorization::*;
use bitrouter_market::cache::*;
use bitrouter_market::candidate::CandidateInput;
use bitrouter_market::exchange::*;
use bitrouter_market::execution_contract::*;
use bitrouter_market::fake_authority::FakeAuthority;
use bitrouter_market::formal_order::CloseFormalOrder;
use bitrouter_market::formal_order::PlaceFormalOrder;
use bitrouter_market::market_host::MarketHost;
use bitrouter_market::order::*;
use bitrouter_market::purchase_order::*;
use bitrouter_market::quote::LoadSnapshot;
use bitrouter_market::seller_service::*;
use bitrouter_market::throughput::*;

pub fn policy() -> RegistrationPolicy {
    RegistrationPolicy {
        funding_rules_ref: REGISTRATION_FUNDING_RULES_REF.into(),
        time: TimePolicy {
            rules_ref: TIME_RULES_REF.into(),
            immediate_decision_window_ms: 100,
            immediate_total_window_ms: 300,
            grant_acceptance_window_ms: 500,
        },
    }
}
pub fn bootstrap(shared: bool) -> MarketHost {
    fixture::bootstrap(shared)
        .with_purchase_orders(policy())
        .unwrap()
}
pub fn setup(shared: bool, finite: bool) -> (MarketHost, FakeAuthority) {
    let mut h = bootstrap(shared);
    for owner in 1..=3 {
        fixture::run(
            &mut h,
            &format!("credit-{owner}"),
            ExchangeCommand::Credit {
                buyer_id: owner,
                amount: MicroUsd(1_000),
            },
        );
    }
    if finite {
        let mut sell = fx::sell("seller", &["a", "b"]);
        for l in &mut sell.options {
            l.ask.rates.output = 1_000_000;
        }
        fixture::run(&mut h, "sell", ExchangeCommand::SubmitSell(sell));
    } else {
        for market in ["a", "b"] {
            let mut offer = fx::sell(&format!("independent-{market}"), &[market]);
            offer.options[0].ask.rates.output = 1_000_000;
            fixture::run(
                &mut h,
                &format!("offer-{market}"),
                ExchangeCommand::SubmitSell(offer),
            );
        }
    }
    for market in ["a", "b"] {
        fixture::ready(&mut h, market, 1);
        let service = service_publication(&h, market);
        fixture::run(
            &mut h,
            &format!("service-{market}"),
            ExchangeCommand::PublishSellerService(Box::new(service)),
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
    let authority = fixture::authority(shared, h.snapshot().now());
    (h, authority)
}
pub fn service_publication(h: &MarketHost, market: &str) -> SellerServicePublication {
    let s = h.snapshot();
    let key = fixture::source(market);
    let source = &s.sources()[&key];
    let spec = s.books()[market].spec();
    SellerServicePublication {
        offering: key,
        source_generation: source.generation,
        quote_version: s.books()[market].get_offering(11).unwrap().version(),
        schedule: SellerServiceSchedule {
            version: SERVICE_VERSION,
            rules_ref: SERVICE_RULES_REF.into(),
            reference: format!("service/{market}/{}", source.generation),
            revision: 1,
            provider_id: source.ask.provider_id,
            market_spec_ref: spec.reference.clone(),
            model_ref: spec.model_ref.clone(),
            request_protocol_ref: spec.request_protocol_ref.clone(),
            numerical_rules_ref: spec.metering.numerical_rules_ref.clone(),
            output_metering_ref: spec.metering.output_metering_ref.clone(),
            rates: source.ask.rates,
            bins: vec![ServiceBin {
                hard_delivery_within_ms: 60_000,
                bin_id: "fixture-range".into(),
                input_tokens: TokenRange {
                    min_inclusive: 0,
                    max_inclusive: spec.request_limits.context_window_tokens,
                },
                max_billable_output_tokens: TokenRange {
                    min_inclusive: 1,
                    max_inclusive: spec.request_limits.max_output_tokens,
                },
                delivery: DeliveryConditions::PerformanceTarget {
                    first_response_within_ms: 100,
                    complete_within_ms: 1_000,
                },
            }],
        },
    }
}
pub fn registration(name: &str, owner: u64, markets: &[&str], ioc: bool) -> PlaceFormalOrder {
    PlaceFormalOrder {
        version: bitrouter_market::formal_order::FORMAL_VERSION,
        idempotency_key: format!("register-{owner}-{name}"),
        authorization: OrderAuthorization {
            max_adjudication_wait_ms: 86_400_000,
            version: ORDER_CONTRACT_VERSION,
            binding: RootBinding {
                root: fx::reference(OrderSide::Buy, owner, name),
                authorization_version: 1,
            },
            logical_request_ref: format!("request/{name}"),
            logical_request_digest: format!("digest/{name}"),
            options: markets
                .iter()
                .enumerate()
                .map(|(i, m)| RequestOption {
                    option_id: OptionId(i as u32 + 1),
                    market_spec_ref: fx::spec(m).reference,
                    request: bitrouter_market::terms::RequestSpec {
                        request_ref: format!("request/{m}/{i}"),
                        request_digest: format!("digest/{m}/{i}"),
                        size: fx::profile(m).request_size,
                    },
                })
                .collect(),
            max_charge: MicroUsd(100),
            tif: if ioc {
                TimeInForce::Ioc {}
            } else {
                TimeInForce::Gtd {
                    expires_at: UnixMillis(9000),
                }
            },
        },
        provider_scope: Default::default(),
        selection: Default::default(),
    }
}
pub fn register(h: &mut MarketHost, r: &PlaceFormalOrder) {
    h.execute(
        r.idempotency_key.clone(),
        ExchangeCommand::PlaceFormalOrder(Box::new(r.clone())),
    )
    .unwrap();
}
pub fn publication(
    h: &MarketHost,
    r: &PlaceFormalOrder,
    option: u32,
    label: &str,
) -> PurchaseQuotePublication {
    let s = h.snapshot();
    let root = &s.purchase_orders().unwrap()[&r.authorization.binding.root];
    let alternative = r
        .authorization
        .options
        .iter()
        .find(|a| a.option_id == OptionId(option))
        .unwrap();
    let key = OfferingKey {
        market_id: alternative.market_spec_ref.market_id.clone(),
        offering_id: 11,
    };
    let (scope, member) = s.scope_member(&key).unwrap();
    let book = &s.books()[&key.market_id];
    let offering = book.get_offering(11).unwrap().offering().unwrap().clone();
    let backend = member.offering.backend_refs[0].clone();
    let report = s.scope_report(scope.id).unwrap();
    let cache_scope = CacheScope {
        market_spec_ref: book.spec().reference.clone(),
        model_ref: book.spec().model_ref.clone(),
        agent_config_ref: offering.agent_config_ref.clone(),
        backend_ref: backend.clone(),
        cache_domain_ref: "cold".into(),
    };
    let cache = CacheIndex::new(book.spec(), cache_scope.clone(), s.now())
        .unwrap()
        .snapshot();
    let context = PurchaseQuoteContext {
        root: r.authorization.binding.clone(),
        option_id: OptionId(option),
        spec: book.spec().clone(),
        tokens: TokenizedRequest::from_request(
            book.spec(),
            &alternative.request,
            (0..alternative.request.size.input_tokens as u32).collect(),
        )
        .unwrap(),
        profile: member.profile.clone(),
        throughput_filter: ThroughputFilter {
            minimum: ThroughputRate {
                output_tokens: 1,
                completed_requests: 1,
                interval_ms: 1000,
            },
        },
        output_estimate: member.profile.output_estimate,
        compared_at: s.now(),
    };
    let count = s.occupancy(scope.id) as u64;
    let input = CandidateInput {
        offer_id: 11,
        offering,
        scope: cache_scope,
        cache,
        load: LoadSnapshot {
            reference: format!("load/{label}"),
            version: report.metadata.version.sequence,
            source_ref: "global-scope".into(),
            agent_config_ref: member.offering.agent_config_ref.clone(),
            backend_ref: backend,
            market_requests: count,
            observed_at: report.metadata.observed_at,
            valid_until: report.metadata.valid_until,
        },
        prediction: None,
        throughput_observation: book.get_throughput_observation(11).cloned(),
        market_requests_after_admission: count + 1,
    };
    PurchaseQuotePublication {
        quote_ref: format!("quote/{label}"),
        evidence_ref: format!("evidence/{label}"),
        source_generation: s.sources()[&key].generation,
        seller_option: s.sources()[&key].option.clone(),
        load_report: report.metadata.clone(),
        service: s
            .seller_service(&key)
            .unwrap()
            .schedule
            .freeze(alternative.request.size)
            .unwrap(),
        quote: qualify_total_cap(r, root.receipt().window, &context, &input).unwrap(),
    }
}
pub fn publish(h: &mut MarketHost, p: &PurchaseQuotePublication) {
    h.execute(
        format!("publish/{}", p.evidence_ref),
        ExchangeCommand::PurchaseQuote(Box::new(p.clone())),
    )
    .unwrap();
}
pub fn proposal(
    h: &MarketHost,
    r: &PlaceFormalOrder,
    pubs: &[PurchaseQuotePublication],
    label: &str,
) -> ProposePurchase {
    let s = h.snapshot();
    let mut p = ProposePurchase {
        version: ORDER_CONTRACT_VERSION,
        idempotency_key: format!("propose/{label}"),
        proposal_id: format!("proposal/{label}"),
        decision_id: format!("decision/{label}"),
        root: r.authorization.binding.clone(),
        basis: ProposalBasis {
            exchange_revision: s.revision(),
            observed_at: s.now(),
            evidence: ContentBinding {
                reference: format!("basis/{label}"),
                sha256: "0".repeat(64),
            },
        },
        candidates: pubs.iter().map(|p| p.candidate().unwrap()).collect(),
    };
    p.basis.evidence = purchase_proposal_basis(&p).unwrap();
    p
}
pub fn propose(h: &mut MarketHost, p: &ProposePurchase) -> PurchaseDecisionReceipt {
    match h
        .execute(
            p.idempotency_key.clone(),
            ExchangeCommand::ProposePurchase(Box::new(p.clone())),
        )
        .unwrap()
    {
        ExchangeReceipt::PurchaseDecided(r) => r,
        _ => panic!("purchase receipt"),
    }
}
pub fn id(r: &PurchaseDecisionReceipt) -> AttemptId {
    match &r.result {
        PurchaseResult::Granted { attempt_id, .. } => attempt_id.clone(),
        _ => panic!("expected grant: {r:?}"),
    }
}
pub fn request(h: &MarketHost, id: &AttemptId, kind: ExecutionRequestKind) -> ExecutionRequest {
    h.snapshot()
        .execution_requests()
        .unwrap()
        .values()
        .find(|r| {
            r.binding.attempt_id == *id
                && r.kind == kind
                && !h.snapshot().execution_request_sent(&r.effect_id)
        })
        .unwrap()
        .clone()
}
pub fn query(
    h: &mut MarketHost,
    a: &mut FakeAuthority,
    id: &AttemptId,
    kind: ExecutionRequestKind,
    label: &str,
) -> ExecutionReport {
    fixture::run(
        h,
        label,
        ExchangeCommand::Frozen(Box::new(FrozenCommand::Request {
            attempt: id.clone(),
            kind,
        })),
    );
    h.dispatch(&request(h, id, kind).effect_id, a).unwrap()
}
pub fn close(h: &mut MarketHost, r: &PlaceFormalOrder, label: &str) {
    fixture::run(
        h,
        label,
        ExchangeCommand::CloseFormalOrder(CloseFormalOrder {
            idempotency_key: label.into(),
            root: r.authorization.binding.clone(),
        }),
    );
}
