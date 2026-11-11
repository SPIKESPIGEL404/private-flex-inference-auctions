use bitrouter_market::formal_order::PlaceFormalOrder;
#[allow(dead_code)]
mod common;
#[allow(dead_code)]
#[path = "support/conditional_exchange.rs"]
mod fx;

use bitrouter_market::cache::*;
use bitrouter_market::candidate::CandidateInput;
use bitrouter_market::cost::CachedInputEstimate;
use bitrouter_market::order::*;
use bitrouter_market::purchase_order::*;
use bitrouter_market::quote::*;
use bitrouter_market::terms::RequestSpec;
use bitrouter_market::throughput::*;

fn policy() -> TimePolicy {
    TimePolicy {
        rules_ref: TIME_RULES_REF.into(),
        immediate_decision_window_ms: 100,
        immediate_total_window_ms: 300,
        grant_acceptance_window_ms: 500,
    }
}
struct Fixture {
    order: PlaceFormalOrder,
    window: OrderWindow,
    context: PurchaseQuoteContext,
    input: CandidateInput,
}
impl Fixture {
    fn new() -> Self {
        Self::for_market("a")
    }
    fn for_market(market: &str) -> Self {
        let request = RequestSpec {
            request_ref: "total-cap".into(),
            request_digest: "digest/total-cap".into(),
            size: fx::profile(market).request_size,
        };
        let spec = fx::spec(market);
        let profile = fx::profile(market);
        let root = RootBinding {
            root: fx::reference(
                bitrouter_market::authorization::OrderSide::Buy,
                1,
                "total-cap",
            ),
            authorization_version: 1,
        };
        let order = PlaceFormalOrder {
            version: bitrouter_market::formal_order::FORMAL_VERSION,
            idempotency_key: "register".into(),
            authorization: OrderAuthorization {
                max_adjudication_wait_ms: 86_400_000,
                version: ORDER_CONTRACT_VERSION,
                binding: root.clone(),
                logical_request_ref: "request/original".into(),
                logical_request_digest: "digest/original".into(),
                options: vec![RequestOption {
                    option_id: bitrouter_market::authorization::OptionId(1),
                    market_spec_ref: spec.reference.clone(),
                    request: request.clone(),
                }],
                max_charge: MicroUsd(100),
                tif: TimeInForce::Gtd {
                    expires_at: UnixMillis(9_000),
                },
            },
            provider_scope: Default::default(),
            selection: Default::default(),
        };
        order
            .validate(&std::collections::BTreeMap::from([(
                market.into(),
                spec.clone(),
            )]))
            .unwrap();
        let window = order
            .authorization
            .tif
            .normalize(fx::NOW, &policy())
            .unwrap();
        let tokens = TokenizedRequest::from_request(&spec, &request, (0..10).collect()).unwrap();
        let context = PurchaseQuoteContext {
            root,
            option_id: bitrouter_market::authorization::OptionId(1),
            spec: spec.clone(),
            tokens,
            profile: profile.clone(),
            throughput_filter: ThroughputFilter {
                minimum: ThroughputRate {
                    output_tokens: 1,
                    completed_requests: 1,
                    interval_ms: 1000,
                },
            },
            output_estimate: profile.output_estimate,
            compared_at: UnixMillis(2_000),
        };
        let offering = ProviderOffering {
            id: 11,
            provider_id: 7,
            market_spec_ref: spec.reference.clone(),
            request_protocol_ref: spec.request_protocol_ref.clone(),
            agent_config_ref: format!("config/{market}"),
            rates: TokenRates {
                input: 1_000_000,
                cache_input: 0,
                output: 1_000_000,
            },
            throughput: ThroughputClaim {
                profile_ref: profile.reference.clone(),
                rate: ThroughputRate {
                    output_tokens: 10,
                    completed_requests: 10,
                    interval_ms: 1000,
                },
            },
            generation: 1,
            update_seq: 1,
            observed_at: fx::NOW,
            valid_until: UnixMillis(9_000),
            readiness: Readiness::Ready,
        };
        let scope = CacheScope {
            market_spec_ref: spec.reference.clone(),
            model_ref: spec.model_ref.clone(),
            agent_config_ref: offering.agent_config_ref.clone(),
            backend_ref: format!("backend-{market}"),
            cache_domain_ref: format!("cache/{market}"),
        };
        let cache = CacheIndex::new(&spec, scope.clone(), UnixMillis(2_000))
            .unwrap()
            .snapshot();
        let input = CandidateInput {
            offer_id: 11,
            offering: offering.clone(),
            scope,
            cache,
            load: LoadSnapshot {
                reference: "load/a".into(),
                version: 1,
                source_ref: "scope/a".into(),
                agent_config_ref: offering.agent_config_ref.clone(),
                backend_ref: format!("backend-{market}"),
                market_requests: 0,
                observed_at: UnixMillis(2_000),
                valid_until: UnixMillis(5_000),
            },
            prediction: None,
            market_requests_after_admission: 1,
            throughput_observation: Some(ThroughputObservation {
                offering,
                profile,
                started_at: fx::NOW,
                ended_at: UnixMillis(2_000),
                valid_until: UnixMillis(5_000),
                demand_sufficient: true,
                completed_requests: 10,
                failed_requests: 0,
                billable_output_tokens: 10,
                p95_e2e_ms: Some(100),
            }),
        };
        Self {
            order,
            window,
            context,
            input,
        }
    }
    fn quote(&self) -> Result<TotalCapCandidateQuote, PurchaseQuoteError> {
        qualify_total_cap(&self.order, self.window, &self.context, &self.input)
    }
    fn predict(&mut self, ttft: u64) {
        let alternative = self
            .order
            .authorization
            .options
            .iter()
            .find(|a| a.option_id == self.context.option_id)
            .unwrap();
        self.input.prediction = Some(CandidatePrediction {
            latency: LatencyPrediction {
                version: 1,
                request_digest: alternative.request.request_digest.clone(),
                backend_ref: self.input.scope.backend_ref.clone(),
                offering: self.input.offering.clone(),
                request_size: alternative.request.size,
                output_estimate: self.context.output_estimate,
                boundary: LatencyBoundary::MarketEndToEnd,
                estimated_ttft_ms: Some(ttft),
                estimated_tpot_ms: None,
                load_ref: self.input.load.reference.clone(),
                max_market_requests: 8,
                updated_at: self.context.compared_at,
                valid_until: UnixMillis(5_000),
            },
            cache_match: match_prefix(
                &self.context.spec,
                &self.context.tokens,
                &self.input.scope,
                &self.input.cache,
                self.context.compared_at,
            )
            .unwrap(),
            cache_assumption: if self.input.cache.observation().is_some() {
                CacheLatencyAssumption::MatchedSnapshot
            } else {
                CacheLatencyAssumption::ColdCache
            },
            load: self.input.load.clone(),
            elapsed_market_wait_ms: self.context.compared_at.0 - self.window.registered_at.0,
            market_requests_after_admission: self.input.market_requests_after_admission,
        });
    }
    fn cache_all_input(&mut self, valid_until: u64) {
        let mut index = CacheIndex::new(
            &self.context.spec,
            self.input.scope.clone(),
            self.context.compared_at,
        )
        .unwrap();
        let tokens = self.context.tokens.token_ids().to_vec();
        index
            .replace(
                CacheObservation {
                    source: CacheSource::Observed,
                    source_ref: "resident/a".into(),
                    observed_at: self.context.compared_at,
                    valid_until: UnixMillis(valid_until),
                    rules: CacheReuseRules {
                        rule_ref: "cache-billing/v1".into(),
                        block_tokens: 1,
                        billing: CacheBilling::ReusedInput,
                    },
                },
                &[&tokens],
            )
            .unwrap();
        self.input.cache = index.snapshot();
    }
}
fn request(input: u64, output: u64) -> RequestSpec {
    RequestSpec {
        request_ref: "request".into(),
        request_digest: "digest".into(),
        size: RequestSize {
            input_tokens: input,
            max_output_tokens: output,
        },
    }
}

#[test]
fn total_cap_prices_seller_rates_independent_from_old_reference_rates_and_maker() {
    let f = Fixture::new();
    let q = f.quote().unwrap();
    assert_eq!(q.terms().rates(), f.input.offering.rates);
    assert_eq!(q.terms().maximum_charge(), MicroUsd(11));
    assert_eq!(q.estimated_charge(), MicroUsd(11));
    let spec = f.context.spec.clone();
    let t = TotalCapQuoteTerms::new(
        spec,
        f.order.authorization.options[0].request.clone(),
        f.input.offering.rates,
        MicroUsd(11),
    )
    .unwrap();
    assert_eq!(t.maximum_charge(), q.terms().maximum_charge());
}

#[test]
fn tiny_token_categories_are_summed_before_one_ceiling() {
    let t = TotalCapQuoteTerms::new(
        common::spec(),
        request(1, 1),
        TokenRates {
            input: 1,
            cache_input: 1,
            output: 1,
        },
        MicroUsd(1),
    )
    .unwrap();
    assert_eq!(t.maximum_charge(), MicroUsd(1));
    assert_eq!(
        t.actual_charge(TokenUsage {
            uncached_input_tokens: 1,
            cached_input_tokens: 0,
            billable_output_tokens: 1
        })
        .unwrap(),
        MicroUsd(1)
    );
}

#[test]
fn cheaper_cache_and_short_output_forecast_never_reduce_full_authorization_cap() {
    let t = TotalCapQuoteTerms::new(
        common::spec(),
        request(10, 20),
        TokenRates {
            input: 1_000_000,
            cache_input: 0,
            output: 1_000_000,
        },
        MicroUsd(30),
    )
    .unwrap();
    let output = OutputEstimate {
        billable_output_tokens: 5,
        visible_output_tokens: 1,
    };
    assert_eq!(
        t.estimated_charge(output, CachedInputEstimate::Tokens(10))
            .unwrap(),
        MicroUsd(5)
    );
    assert_eq!(
        t.estimated_charge(output, CachedInputEstimate::Unknown)
            .unwrap(),
        MicroUsd(15)
    );
    assert_eq!(t.maximum_charge(), MicroUsd(30));
    assert!(matches!(
        TotalCapQuoteTerms::new(common::spec(), request(10, 20), t.rates(), MicroUsd(5)),
        Err(TotalCapPriceError::MaximumExceedsLimit {
            maximum: MicroUsd(30),
            limit: MicroUsd(5)
        })
    ));
    let mut f = Fixture::new();
    f.cache_all_input(4_000);
    f.order.authorization.max_charge = MicroUsd(1);
    assert!(matches!(
        f.quote(),
        Err(PurchaseQuoteError::Price(
            TotalCapPriceError::MaximumExceedsLimit { .. }
        ))
    ));
}

#[test]
fn expensive_cache_branch_is_covered_and_all_legal_usage_fits_frozen_cap() {
    let t = TotalCapQuoteTerms::new(
        common::spec(),
        request(10, 20),
        TokenRates {
            input: 1_000_000,
            cache_input: 3_000_000,
            output: 2_000_000,
        },
        MicroUsd(70),
    )
    .unwrap();
    assert_eq!(t.maximum_charge(), MicroUsd(70));
    for cached in 0..=10 {
        for output in 0..=20 {
            let charge = t
                .actual_charge(TokenUsage {
                    uncached_input_tokens: 10 - cached,
                    cached_input_tokens: cached,
                    billable_output_tokens: output,
                })
                .unwrap();
            assert!(charge <= t.maximum_charge());
        }
    }
    assert!(t
        .actual_charge(TokenUsage {
            uncached_input_tokens: 9,
            cached_input_tokens: 0,
            billable_output_tokens: 20
        })
        .is_err());
    assert!(t
        .actual_charge(TokenUsage {
            uncached_input_tokens: 10,
            cached_input_tokens: 0,
            billable_output_tokens: 21
        })
        .is_err());
}

#[test]
fn free_service_overflow_unknown_rules_and_forged_persisted_maximum_are_distinct() {
    let t = TotalCapQuoteTerms::new(
        common::spec(),
        request(10, 20),
        TokenRates {
            input: 0,
            cache_input: 0,
            output: 0,
        },
        MicroUsd(0),
    )
    .unwrap();
    assert_eq!(t.maximum_charge(), MicroUsd(0));
    let encoded = serde_json::to_value(t).unwrap();
    let mut wrong = encoded.clone();
    wrong["maximum_charge"] = 1.into();
    assert!(serde_json::from_value::<TotalCapQuoteTerms>(wrong).is_err());
    let mut wrong = encoded.clone();
    wrong["rules_ref"] = "unknown-v2".into();
    assert!(serde_json::from_value::<TotalCapQuoteTerms>(wrong).is_err());
    let mut wrong = encoded;
    wrong["multiplier"] = 1.into();
    assert!(serde_json::from_value::<TotalCapQuoteTerms>(wrong).is_err());
    let mut spec = common::spec();
    spec.request_limits = RequestLimits {
        context_window_tokens: u64::MAX,
        max_output_tokens: 1,
    };
    assert!(matches!(
        TotalCapQuoteTerms::new(
            spec,
            request(u64::MAX, 0),
            TokenRates {
                input: u64::MAX,
                cache_input: 0,
                output: 0
            },
            MicroUsd(u64::MAX)
        ),
        Err(TotalCapPriceError::Cost(_))
    ));
}

#[test]
fn missing_prediction_is_unknown_and_does_not_invent_zero_latency() {
    let f = Fixture::new();
    let q = f.quote().unwrap();
    assert_eq!(q.estimated_ttft_ms(), None);
    assert_eq!(q.estimated_completion_ms(), None);
    assert_eq!(
        rank_total_cap_quotes(&f.order, f.window, vec![q.clone()]).unwrap(),
        vec![q.clone()]
    );
    let mut completion_order = f.order.clone();
    completion_order.selection.objective =
        bitrouter_market::formal_order::FormalObjective::EarliestCompletion;
    assert!(rank_total_cap_quotes(&completion_order, f.window, vec![q])
        .unwrap()
        .is_empty());
}

#[test]
fn prediction_keeps_original_t0_and_completion_may_exceed_purchase_tif() {
    let mut f = Fixture::new();
    f.predict(10_000);
    let q = f.quote().unwrap();
    assert_eq!(q.estimated_completion_ms(), Some(10_000));
    assert!(
        f.window.registered_at.0 + q.estimated_completion_ms().unwrap() > f.window.accept_before.0
    );
    let mut f = Fixture::new();
    f.predict(1_100);
    assert_eq!(f.quote().unwrap().estimated_completion_ms(), Some(1_100));
    f.input.prediction.as_mut().unwrap().elapsed_market_wait_ms = 0;
    assert_eq!(f.quote(), Err(PurchaseQuoteError::PredictionBinding));
}

#[test]
fn observed_cache_eligibility_expiry_does_not_become_grant_acceptance_expiry() {
    let mut f = Fixture::new();
    f.cache_all_input(2_100);
    f.predict(1_100);
    let q = f.quote().unwrap();
    assert_eq!(q.estimated_charge(), MicroUsd(1));
    assert_eq!(q.terms().maximum_charge(), MicroUsd(11));
    assert_eq!(q.valid_until(), UnixMillis(2_100));
    q.validate_against(&f.order, f.window, &f.context, &f.input, UnixMillis(2_099))
        .unwrap();
    assert_eq!(
        q.validate_against(&f.order, f.window, &f.context, &f.input, UnixMillis(2_100)),
        Err(PurchaseQuoteError::Stale)
    );
    let window = GrantWindowInputs {
        buyer: f.window,
        seller_accept_before: f.input.offering.valid_until,
        execution_condition_before: None,
        decided_at: UnixMillis(2_099),
    }
    .freeze(&policy())
    .unwrap();
    assert_eq!(window.accept_before, UnixMillis(2_599));
    window.validate_accepted_at(UnixMillis(2_200)).unwrap();
}

#[test]
fn root_leaf_request_tokenizer_and_original_window_must_match() {
    let f = Fixture::new();
    let mut context = f.context.clone();
    context.root.authorization_version += 1;
    assert_eq!(
        qualify_total_cap(&f.order, f.window, &context, &f.input),
        Err(PurchaseQuoteError::RootBinding)
    );
    context = f.context.clone();
    context.option_id = bitrouter_market::authorization::OptionId(99);
    assert_eq!(
        qualify_total_cap(&f.order, f.window, &context, &f.input),
        Err(PurchaseQuoteError::RequestBinding)
    );
    context = f.context.clone();
    let mut changed = f.order.authorization.options[0].request.clone();
    changed.request_digest = "other-content".into();
    context.tokens =
        TokenizedRequest::from_request(&context.spec, &changed, (0..10).collect()).unwrap();
    assert!(matches!(
        qualify_total_cap(&f.order, f.window, &context, &f.input),
        Err(PurchaseQuoteError::Cache(CacheError::RequestMismatch))
    ));
    let wrong_window = OrderWindow {
        registered_at: f.window.registered_at,
        decision_before: UnixMillis(9_001),
        accept_before: UnixMillis(9_001),
    };
    assert_eq!(
        qualify_total_cap(&f.order, wrong_window, &f.context, &f.input),
        Err(PurchaseQuoteError::RootBinding)
    );
}

#[test]
fn ready_declaration_without_observed_throughput_is_not_verified() {
    let mut f = Fixture::new();
    f.input.throughput_observation = None;
    assert!(matches!(f.quote(), Err(PurchaseQuoteError::Throughput(_))));
    let mut f = Fixture::new();
    f.input.offering.readiness = Readiness::NotReady;
    assert_eq!(
        f.quote(),
        Err(PurchaseQuoteError::Validation(ValidationError::NotReady))
    );
    let mut f = Fixture::new();
    f.input
        .throughput_observation
        .as_mut()
        .unwrap()
        .demand_sufficient = false;
    let observation = f.input.throughput_observation.as_mut().unwrap();
    observation.completed_requests = 2;
    observation.billable_output_tokens = 2;
    assert_eq!(
        f.quote(),
        Err(PurchaseQuoteError::Throughput(
            ThroughputVerification::InsufficientDemand
        ))
    );
}

#[test]
fn exact_backend_load_prediction_and_concurrency_bindings_are_rechecked() {
    let mut f = Fixture::new();
    f.input.load.backend_ref = "other-backend".into();
    assert_eq!(f.quote(), Err(PurchaseQuoteError::BackendBinding));
    let mut f = Fixture::new();
    f.input.load.market_requests = 1;
    assert_eq!(f.quote(), Err(PurchaseQuoteError::LoadBinding));
    let mut f = Fixture::new();
    f.predict(1_100);
    f.input
        .prediction
        .as_mut()
        .unwrap()
        .latency
        .max_market_requests = 0;
    assert!(matches!(f.quote(), Err(PurchaseQuoteError::Validation(_))));
    let mut f = Fixture::new();
    f.predict(1_100);
    f.input.prediction.as_mut().unwrap().cache_assumption = CacheLatencyAssumption::MatchedSnapshot;
    assert_eq!(f.quote(), Err(PurchaseQuoteError::CacheAssumption));
}

#[test]
fn quote_revalidation_recomputes_and_rejects_tampered_derived_amounts() {
    let f = Fixture::new();
    let q = f.quote().unwrap();
    let value = serde_json::to_value(&q).unwrap();
    let decoded: TotalCapCandidateQuote = serde_json::from_value(value.clone()).unwrap();
    decoded
        .validate_against(
            &f.order,
            f.window,
            &f.context,
            &f.input,
            f.context.compared_at,
        )
        .unwrap();
    let mut forged = value;
    forged["estimated_charge"] = 0.into();
    let forged: TotalCapCandidateQuote = serde_json::from_value(forged).unwrap();
    assert_eq!(
        forged.validate_against(
            &f.order,
            f.window,
            &f.context,
            &f.input,
            f.context.compared_at
        ),
        Err(PurchaseQuoteError::Stale)
    );
    assert_eq!(
        rank_total_cap_quotes(&f.order, f.window, vec![forged]),
        Err(PurchaseQuoteError::Stale)
    );
    let mut changed = f.input.clone();
    changed.load.version += 1;
    assert_eq!(
        q.validate_against(
            &f.order,
            f.window,
            &f.context,
            &changed,
            f.context.compared_at
        ),
        Err(PurchaseQuoteError::Stale)
    );
}

#[test]
fn root_comparison_keeps_cost_speed_and_unknowns_separate() {
    let mut f = Fixture::new();
    f.predict(1_100);
    let known = f.quote().unwrap();
    let mut g = Fixture::new();
    g.input.offering.id = 12;
    g.input.offer_id = 12;
    g.input.throughput_observation.as_mut().unwrap().offering = g.input.offering.clone();
    let unknown = g.quote().unwrap();
    let ranked =
        rank_total_cap_quotes(&f.order, f.window, vec![unknown.clone(), known.clone()]).unwrap();
    assert_eq!(ranked, vec![known.clone(), unknown.clone()]);
    let mut completion_order = f.order.clone();
    completion_order.selection.objective =
        bitrouter_market::formal_order::FormalObjective::EarliestCompletion;
    assert_eq!(
        rank_total_cap_quotes(&completion_order, f.window, vec![unknown, known.clone()]).unwrap(),
        vec![known]
    );
}

#[test]
fn alternative_models_compete_in_one_root_without_copying_its_cap() {
    let mut a = Fixture::for_market("a");
    let mut b = Fixture::for_market("b");
    b.order.authorization.options[0].option_id = bitrouter_market::authorization::OptionId(2);
    b.context.option_id = bitrouter_market::authorization::OptionId(2);
    a.order
        .authorization
        .options
        .extend(b.order.authorization.options.clone());
    a.order
        .validate(&std::collections::BTreeMap::from([
            ("a".into(), fx::spec("a")),
            ("b".into(), fx::spec("b")),
        ]))
        .unwrap();
    b.order = a.order.clone();
    b.input.offering.rates.input = 500_000;
    b.input.throughput_observation.as_mut().unwrap().offering = b.input.offering.clone();
    a.predict(1_100);
    b.predict(1_400);
    let qa = a.quote().unwrap();
    let qb = b.quote().unwrap();
    let ranked = rank_total_cap_quotes(&a.order, a.window, vec![qa.clone(), qb.clone()]).unwrap();
    assert_eq!(ranked, vec![qb.clone(), qa.clone()]);
    assert_eq!(qa.terms().buyer_cap(), MicroUsd(100));
    assert_eq!(qb.terms().buyer_cap(), MicroUsd(100));
    // Distinct test registration with completion-first policy; the ranking API
    // reads the frozen objective and offers no per-call override argument.
    let mut completion_order = a.order.clone();
    completion_order.selection.objective =
        bitrouter_market::formal_order::FormalObjective::EarliestCompletion;
    let ranked =
        rank_total_cap_quotes(&completion_order, a.window, vec![qb.clone(), qa.clone()]).unwrap();
    assert_eq!(ranked, vec![qa, qb]);
}

#[test]
fn decoded_token_length_cannot_bypass_the_original_request_authorization() {
    let mut f = Fixture::new();
    let mut encoded = serde_json::to_value(&f.context.tokens).unwrap();
    encoded["token_ids"] = serde_json::json!([]);
    f.context.tokens = serde_json::from_value(encoded).unwrap();
    assert_eq!(
        f.quote(),
        Err(PurchaseQuoteError::Cache(CacheError::TokenCountMismatch))
    );
}

#[test]
fn decoded_zero_cache_block_is_rejected_before_any_prefix_rounding() {
    let mut f = Fixture::new();
    f.cache_all_input(4_000);
    let mut encoded = serde_json::to_value(&f.input.cache).unwrap();
    encoded["observation"]["rules"]["block_tokens"] = 0.into();
    f.input.cache = serde_json::from_value(encoded).unwrap();
    assert_eq!(
        f.quote(),
        Err(PurchaseQuoteError::Cache(CacheError::InvalidBlockSize))
    );
}
