// Migrated from pinned Cloud inference/tests.rs; adaptations in upstream/SOURCES.md.
use bitrouter_cloud::market::inference::*;
type Result<T> = std::result::Result<T, InferenceError>;
use bitrouter_cloud::{market::NanoUsd, platform_billing::meter::ApiProtocol};
use bitrouter_market::{
    admission::{AttemptId, ReportAuthorityId},
    authorization::OptionId,
    cost::NUMERICAL_RULES_REF,
    execution_contract::{ExecutionBinding, GrantRef},
    market_spec::{MarketSpec, MeteringSpec},
    order::{
        MarketSpecRef, MicroUsd, RequestLimits, RequestSize, TokenRates, TokenUsage, UnixMillis,
    },
    purchase_order::{TIME_RULES_REF, TimeInForce, TimePolicy, TotalCapQuoteTerms},
    terms::RequestSpec,
};
use serde_json::{Value, json};

const CAP: u64 = 100;
const INPUT: u64 = 120;
const REQUEST: &str = "logical-1";

fn nano(n: i128) -> NanoUsd {
    NanoUsd::new(n).unwrap()
}

fn option(id: u32) -> AuthorizedOption {
    AuthorizedOption {
        id: OptionId(id),
        model: MarketSpec {
            reference: MarketSpecRef {
                market_id: "market".into(),
                revision: u64::from(id),
            },
            model_ref: format!("model-rev-{id}"),
            request_protocol_ref: "native-v1".into(),
            throughput_profile_ref: "test-profile".into(),
            request_limits: RequestLimits {
                context_window_tokens: 500,
                max_output_tokens: 300,
            },
            metering: MeteringSpec {
                output_metering_ref: OUTPUT_METER_VERSION.into(),
                numerical_rules_ref: NUMERICAL_RULES_REF.into(),
            },
        },
        request: RequestSpec {
            request_ref: format!("request-{id}"),
            request_digest: "c".repeat(64),
            size: RequestSize {
                input_tokens: INPUT,
                max_output_tokens: CAP,
            },
        },
        providers: vec![u64::from(id)],
    }
}

fn delivery_options(fallback: FallbackMode) -> DeliveryOptions {
    DeliveryOptions {
        stream: true,
        background: false,
        recovery: RecoveryMode::StreamV1,
        fallback,
    }
}

fn terms(protocol: ApiProtocol, output: OutputContract, delivery: DeliveryOptions) -> RequestTerms {
    RequestTerms {
        service_type: InferenceServiceType::Interruptible,
        exchange_id: "exchange".into(),
        request_id: REQUEST.into(),
        buyer_id: 7,
        idempotency_key: "key-1".into(),
        protocol,
        delivery,
        funding: FundingAuthorization {
            id: "hold-1".into(),
            provider_cap: MicroUsd(1_000),
            total_cap: nano(2_000_000),
        },
        output_limit: CAP,
        output,
        stop_sequences: if protocol == ApiProtocol::Responses {
            vec![]
        } else {
            vec!["<end>".into()]
        },
        options: vec![option(1), option(2)],
    }
}

fn policy() -> StrategyPolicy {
    StrategyPolicy {
        wait_budget_ms: 30_000,
        max_attempts: 2,
        default_output_tokens: std::num::NonZeroU64::new(CAP).unwrap(),
        order_time: TimePolicy {
            rules_ref: TIME_RULES_REF.into(),
            immediate_decision_window_ms: 500,
            immediate_total_window_ms: 2_000,
            grant_acceptance_window_ms: 10_000,
        },
    }
}

fn schema() -> Value {
    json!({"type":"object","properties":{"answer":{"type":"string"}},"required":["answer"],"additionalProperties":false})
}

fn body_for(terms: &RequestTerms) -> Value {
    let mut body = match terms.protocol {
        ApiProtocol::ChatCompletions => {
            json!({"model":"test","stop":"<end>","messages":[{"role":"user","content":"hello"}]})
        }
        ApiProtocol::Responses => json!({"model":"test","input":"hello"}),
        ApiProtocol::Messages => {
            json!({"model":"test","stop_sequences":["<end>"],"max_tokens":CAP,"messages":[{"role":"user","content":"hello"}]})
        }
    };
    let options = terms.delivery;
    body["stream"] = json!(options.stream);
    body["bitrouter_delivery"] =
        json!({"recovery":options.recovery,"auto_fallback":options.fallback});
    if terms.protocol == ApiProtocol::Responses || options.background {
        body["background"] = json!(options.background);
    }

    match terms.output {
        OutputContract::Text => {}
        OutputContract::JsonSchema { .. } => match terms.protocol {
            ApiProtocol::Responses => {
                body["text"] = json!({"format":{"type":"json_schema","name":"answer","strict":true,"schema":schema()}})
            }
            ApiProtocol::ChatCompletions => {
                body["response_format"] = json!({"type":"json_schema","json_schema":{"name":"answer","strict":true,"schema":schema()}})
            }
            ApiProtocol::Messages => {
                body["output_config"] = json!({"format":{"type":"json_schema","schema":schema()}})
            }
        },
        OutputContract::Tools { .. } | OutputContract::TextOrTools { .. } => {
            let required = matches!(terms.output, OutputContract::Tools { .. });
            body["tools"] = match terms.protocol {
                ApiProtocol::ChatCompletions => {
                    json!([{"type":"function","function":{"name":"foo","parameters":schema()}}])
                }
                ApiProtocol::Responses => {
                    json!([{"type":"function","name":"foo","parameters":schema()}])
                }
                ApiProtocol::Messages => json!([{"name":"foo","input_schema":schema()}]),
            };
            if required {
                body["tool_choice"] = if terms.protocol == ApiProtocol::Messages {
                    json!({"type":"any"})
                } else {
                    json!("required")
                };
            }
        }
    }
    body
}

fn purchase(terms: &RequestTerms) -> PurchaseControls {
    PurchaseControls {
        service_type: terms.service_type,
        provider_cap: terms.funding.provider_cap,
        total_cap: terms.funding.total_cap,
        wait_budget_ms: None,
        max_attempts: None,
        options: terms
            .options
            .iter()
            .map(|option| PurchaseScope {
                id: option.id,
                model_ref: option.model.model_ref.clone(),
                providers: option.providers.clone(),
            })
            .collect(),
    }
}

fn build_strategy(terms: RequestTerms) -> Result<Strategy> {
    let body = body_for(&terms);
    let purchase = purchase(&terms);
    let protocol = terms.protocol;
    Strategy::new(
        terms,
        policy(),
        Submission {
            protocol,
            body: &body,
            purchase: &purchase,
        },
        UnixMillis(0),
    )
}

fn strategy(protocol: ApiProtocol, output: OutputContract, delivery: DeliveryOptions) -> Strategy {
    let mut terms = terms(protocol, output, delivery);
    let body = body_for(&terms);
    terms.output = output_contract(protocol, &body).unwrap();
    build_strategy(terms).unwrap()
}

fn flex() -> Strategy {
    strategy(
        ApiProtocol::ChatCompletions,
        OutputContract::Text,
        delivery_options(FallbackMode::ReplaceAttempt),
    )
}

fn typed_strategy(protocol: ApiProtocol, service_type: InferenceServiceType) -> Strategy {
    let mut terms = terms(
        protocol,
        OutputContract::Text,
        delivery_options(FallbackMode::ReplaceAttempt),
    );
    terms.service_type = service_type;
    build_strategy(terms).unwrap()
}

#[test]
fn on_demand_freezes_type_window_and_settlement_for_every_protocol() {
    for end in [
        chat("stop"),
        NativeEnd::Responses {
            status: "completed".into(),
            incomplete_reason: None,
            explicit_refusal: false,
        },
        NativeEnd::Messages {
            stop_reason: "end_turn".into(),
            stop_sequence: None,
        },
    ] {
        let mut s = typed_strategy(end.protocol(), InferenceServiceType::OnDemand);
        let body = body_for(s.terms());
        let mut controls = purchase(s.terms());
        s.check_replay(
            7,
            "key-1",
            Submission {
                protocol: end.protocol(),
                body: &body,
                purchase: &controls,
            },
        )
        .unwrap();
        controls.service_type = InferenceServiceType::Interruptible;
        assert_eq!(
            s.check_replay(
                7,
                "key-1",
                Submission {
                    protocol: end.protocol(),
                    body: &body,
                    purchase: &controls,
                }
            ),
            Err(InferenceError::Conflict)
        );
        s.open_order(1, TimeInForce::Ioc {}, UnixMillis(0)).unwrap();
        let mut g = grant(&s, 1, 1, 1, 2_000);
        g.offer.service_type = InferenceServiceType::Interruptible;
        assert!(matches!(
            s.grant(g.clone(), UnixMillis(1)),
            Err(InferenceError::Contract(_))
        ));
        g.offer.service_type = InferenceServiceType::OnDemand;
        let binding = g.binding.clone();
        s.grant(g, UnixMillis(1)).unwrap();
        s = serde_json::from_value(serde_json::to_value(s).unwrap()).unwrap();
        // Internal validator is private; exercise persisted public state/terminal APIs below.
        assert!(!s.contract_version().is_empty());
        assert_eq!(s.contract_version(), CONTRACT_VERSION);
        assert_eq!(
            s.attempts()[0].grant.binding.accept_before,
            UnixMillis(2_000)
        );
        s.mark_unknown(&binding, UnixMillis(2_000)).unwrap();
        accept(&mut s, &binding, 1_999, 2_100);
        s.record_terminal(
            terminal(&binding, 2_101, native(end, OutputCheck::Text, None)),
            UnixMillis(2_101),
        )
        .unwrap();
        s.record_usage(usage(&binding, 10), UnixMillis(2_101))
            .unwrap();
        let Settlement::Ready(plan) = s.settlement() else {
            panic!("expected a charge");
        };
        assert_eq!(plan.service_type, InferenceServiceType::OnDemand);
        assert_eq!(plan.contract, s.contract_version());
        assert_eq!(plan.binding, binding);
    }
}

#[test]
fn capacity_rejection_requires_unaccepted_evidence_and_depends_on_frozen_type() {
    for (service, reason, party) in [
        (
            InferenceServiceType::Interruptible,
            FulfillmentReason::CapacityWithdrawal,
            ResponsibleParty::None,
        ),
        (
            InferenceServiceType::OnDemand,
            FulfillmentReason::AcceptanceFailure,
            ResponsibleParty::Seller,
        ),
    ] {
        let mut s = typed_strategy(ApiProtocol::ChatCompletions, service);
        s.open_order(1, TimeInForce::Ioc {}, UnixMillis(0)).unwrap();
        let g = grant(&s, 1, 1, 1, 2_000);
        let b = g.binding.clone();
        s.grant(g, UnixMillis(1)).unwrap();
        s.mark_unknown(&b, UnixMillis(2_000)).unwrap();
        assert_eq!(s.status(), RequestStatus::Unknown);
        assert!(s.attempts()[0].fee_protection.is_none());
        assert!(s.attempts()[0].fulfillment.is_none());
        assert_eq!(
            s.open_order(2, TimeInForce::Ioc {}, UnixMillis(2_000)),
            Err(InferenceError::State)
        );
        let mut accepted = s.clone();
        accept(&mut accepted, &b, 10, 2_000);
        let report = terminal(&b, 2_001, TerminalOutcome::CapacityRejected);
        assert_eq!(
            accepted.record_terminal(report.clone(), UnixMillis(2_001)),
            Err(InferenceError::Evidence)
        );
        s.record_terminal(report.clone(), UnixMillis(2_001))
            .unwrap();
        assert!(s.attempts()[0].acceptance.is_none());
        let mut changed = report.clone();
        changed.proof_ref = "different-proof".into();
        let original = s.clone();
        s.record_terminal(report, UnixMillis(2_002)).unwrap();
        assert_eq!(s, original);
        assert_eq!(
            s.record_terminal(changed, UnixMillis(2_002)),
            Err(InferenceError::Conflict)
        );
        let a = &s.attempts()[0];
        assert_eq!(
            a.fee_protection.as_ref().unwrap().reason,
            Failure::CapacityRejected
        );
        assert_eq!(a.fulfillment.as_ref().unwrap().reason, reason);
        assert_eq!(
            a.fulfillment.as_ref().unwrap().attribution,
            Attribution::Confirmed(party)
        );
        assert_eq!(s.settlement(), &Settlement::Unavailable);
        s.open_order(2, TimeInForce::Ioc {}, UnixMillis(2_002))
            .unwrap();
    }
}

#[test]
fn failed_partial_attempts_stay_free_and_keep_their_own_findings_after_replacement() {
    for (service, failure, attribution) in [
        (
            InferenceServiceType::Interruptible,
            TerminalOutcome::Failed { retryable: true },
            Attribution::Pending,
        ),
        (
            InferenceServiceType::OnDemand,
            TerminalOutcome::SellerFailed { retryable: true },
            Attribution::Confirmed(ResponsibleParty::Seller),
        ),
    ] {
        let mut s = typed_strategy(ApiProtocol::ChatCompletions, service);
        let a = start(&mut s);
        s.mark_public_output(&a, UnixMillis(10)).unwrap();
        s.record_terminal(terminal(&a, 11, failure), UnixMillis(11))
            .unwrap();
        assert_eq!(
            s.record_usage(usage(&a, 4), UnixMillis(11)),
            Err(InferenceError::State)
        );
        assert_eq!(
            s.attempts()[0].fulfillment.as_ref().unwrap().attribution,
            attribution
        );
        let original = s.attempts()[0].clone();
        s.open_order(2, TimeInForce::Ioc {}, UnixMillis(12))
            .unwrap();
        let g = grant(&s, 2, 2, 13, 2_000);
        let b = g.binding.clone();
        s.grant(g, UnixMillis(13)).unwrap();
        accept(&mut s, &b, 14, 14);
        s.record_terminal(
            terminal(&b, 15, native(chat("stop"), OutputCheck::Text, None)),
            UnixMillis(15),
        )
        .unwrap();
        assert_eq!(
            s.record_usage(usage(&a, 4), UnixMillis(15)),
            Err(InferenceError::Evidence)
        );
        s.record_usage(usage(&b, 4), UnixMillis(15)).unwrap();
        assert_eq!(s.attempts()[0], original);
        assert_eq!(
            original.fee_protection.as_ref().unwrap().reason,
            Failure::RetryableExecution
        );
        let Settlement::Ready(plan) = s.settlement() else {
            panic!("replacement should settle");
        };
        assert_eq!(plan.binding, b);
    }
}

#[test]
fn shared_empty_protection_requires_terminal_and_preserves_reasoning_cap_exception() {
    for service in [
        InferenceServiceType::Interruptible,
        InferenceServiceType::OnDemand,
    ] {
        let mut s = typed_strategy(ApiProtocol::ChatCompletions, service);
        // The private OutputConstraints validator is covered by host HTTP empty-output tests.
        let empty = OutputCheck::Empty;
        let b = start(&mut s);
        let mut ended_empty = s.clone();
        ended_empty
            .record_terminal(
                terminal(&b, 11, native(chat("stop"), empty.clone(), None)),
                UnixMillis(11),
            )
            .unwrap();
        assert_eq!(
            ended_empty.attempts()[0]
                .fee_protection
                .as_ref()
                .unwrap()
                .reason,
            Failure::EmptyDelivery
        );
        assert_eq!(
            ended_empty.record_usage(usage(&b, 0), UnixMillis(11)),
            Err(InferenceError::State)
        );

        s.record_terminal(
            terminal(&b, 11, native(chat("length"), empty, None)),
            UnixMillis(11),
        )
        .unwrap();
        assert_eq!(s.status(), RequestStatus::PendingDeliveryProof);
        assert!(s.attempts()[0].fee_protection.is_none());
        assert_eq!(
            s.record_usage(usage(&b, CAP), UnixMillis(11)),
            Err(InferenceError::State)
        );
        let mut disproven = s.clone();
        disproven
            .record_cap_evidence(&b, &"d".repeat(64), cap(CAP, CAP - 1), UnixMillis(12))
            .unwrap();
        let waived = disproven.attempts()[0].fee_protection.as_ref().unwrap();
        assert_eq!(waived.reason, Failure::EmptyDelivery);
        assert_eq!(waived.proof_ref, "engine-cap-proof");
        s.record_cap_evidence(&b, &"d".repeat(64), cap(CAP, CAP), UnixMillis(12))
            .unwrap();
        assert_eq!(
            s.record_usage(usage(&b, CAP - 1), UnixMillis(12)),
            Err(InferenceError::Evidence)
        );
        s.record_usage(usage(&b, CAP), UnixMillis(12)).unwrap();
        assert_eq!(s.delivery().unwrap().kind, DeliveryKind::OutputLimit);
        assert!(s.attempts()[0].fee_protection.is_none());
    }
}

#[test]
fn historical_interruptible_contract_keeps_old_adjudication_and_settlement_version() {
    let mut s = flex();
    let b = start(&mut s);
    let mut old = serde_json::to_value(s).unwrap();
    old["contract"] = json!(LEGACY_CONTRACT_VERSION);
    assert!(old["attempts"][0].get("fee_protection").is_none());
    s = serde_json::from_value(old.clone()).unwrap();
    // Internal validator is private; exercise persisted public state/terminal APIs below.
    assert!(!s.contract_version().is_empty());
    assert_eq!(serde_json::to_value(&s).unwrap(), old);
    let mut empty = s.clone();
    empty
        .record_terminal(
            terminal(&b, 11, native(chat("stop"), OutputCheck::Empty, None)),
            UnixMillis(11),
        )
        .unwrap();
    assert_eq!(empty.attempts()[0].failure, Some(Failure::InvalidDelivery));
    assert!(empty.attempts()[0].fee_protection.is_none());
    s.record_terminal(
        terminal(&b, 11, native(chat("stop"), OutputCheck::Text, None)),
        UnixMillis(11),
    )
    .unwrap();
    s.record_usage(usage(&b, 2), UnixMillis(11)).unwrap();
    let Settlement::Ready(plan) = s.settlement() else {
        panic!("old contract should settle");
    };
    assert_eq!(plan.contract, LEGACY_CONTRACT_VERSION);
}

fn grant(state: &Strategy, id: u64, choice: u32, created: u64, before: u64) -> Grant {
    let selected = &state.terms().options[(choice - 1) as usize];
    Grant {
        binding: ExecutionBinding {
            exchange_id: "exchange".into(),
            attempt_id: AttemptId {
                market_id: "market".into(),
                order_id: id,
                sequence: 1,
            },
            grant_ref: GrantRef::new(format!("grant-{id}")).unwrap(),
            authority_id: ReportAuthorityId(3),
            source_epoch: 4,
            backend_ref: format!("backend-{choice}"),
            backend_incarnation: "incarnation-1".into(),
            created_at: UnixMillis(created),
            accept_before: UnixMillis(before),
        },
        option_id: selected.id,
        offer: SelectedOffer {
            service_type: state.terms().service_type,
            offering_id: u64::from(choice),
            provider_id: u64::from(choice),
            authority_id: ReportAuthorityId(3),
            source_epoch: 4,
            backend_ref: format!("backend-{choice}"),
            backend_incarnation: "incarnation-1".into(),
            protocol: state.terms().protocol,
            output_meter: OUTPUT_METER_VERSION.into(),
            max_output_tokens: 200,
            schema_profile: Some(SCHEMA_PROFILE.into()),
            client_tools: true,
            quote: TotalCapQuoteTerms::new(
                selected.model.clone(),
                selected.request.clone(),
                TokenRates {
                    input: 1_000_000,
                    cache_input: 500_000,
                    output: 2_000_000,
                },
                MicroUsd(1_000),
            )
            .unwrap(),
        },
    }
}

fn accept(state: &mut Strategy, binding: &ExecutionBinding, occurred: u64, observed: u64) {
    state
        .record_acceptance(
            Acceptance {
                binding: binding.clone(),
                accepted_at: UnixMillis(occurred),
                proof_ref: "accept-proof".into(),
            },
            UnixMillis(observed),
        )
        .unwrap();
}

fn start(state: &mut Strategy) -> ExecutionBinding {
    state
        .open_order(1, TimeInForce::Ioc {}, UnixMillis(0))
        .unwrap();
    let g = grant(state, 1, 1, 1, 2_000);
    let binding = g.binding.clone();
    state.grant(g, UnixMillis(1)).unwrap();
    accept(state, &binding, 10, 10);
    binding
}

fn terminal(binding: &ExecutionBinding, ended_at: u64, outcome: TerminalOutcome) -> TerminalReport {
    TerminalReport {
        binding: binding.clone(),
        ended_at: UnixMillis(ended_at),
        proof_ref: "terminal-proof".into(),
        outcome,
    }
}

fn native(end: NativeEnd, output: OutputCheck, cap: Option<CapEvidence>) -> TerminalOutcome {
    TerminalOutcome::Delivered(Box::new(NativeDelivery {
        native: end,
        result_digest: "d".repeat(64),
        validation_ref: "validator-proof".into(),
        output,
        cap,
    }))
}

fn chat(reason: &str) -> NativeEnd {
    NativeEnd::ChatCompletions {
        finish_reason: reason.into(),
        explicit_refusal: false,
    }
}

fn usage(binding: &ExecutionBinding, output: u64) -> UsageEvidence {
    UsageEvidence {
        binding: binding.clone(),
        result_digest: "d".repeat(64),
        verification_ref: "meter-proof".into(),
        source: VerifiedUsageSource::AttestedExecutionMeter,
        usage: TokenUsage {
            uncached_input_tokens: 100,
            cached_input_tokens: 20,
            billable_output_tokens: output,
        },
    }
}

fn cap(effective: u64, generated: u64) -> CapEvidence {
    CapEvidence {
        effective_generation_limit: effective,
        generated_tokens: generated,
        proof_ref: "engine-cap-proof".into(),
    }
}

#[test]
fn long_execution_pauses_wait_and_fallback_spends_only_the_remainder() {
    let mut s = flex();
    s.open_order(
        1,
        TimeInForce::Gtd {
            expires_at: UnixMillis(100_000),
        },
        UnixMillis(0),
    )
    .unwrap();
    assert_eq!(s.orders()[0].window.accept_before, UnixMillis(30_000));
    let g = grant(&s, 1, 1, 500, 10_500);
    let first = g.binding.clone();
    s.grant(g, UnixMillis(500)).unwrap();
    accept(&mut s, &first, 2_000, 2_000);
    assert_eq!(s.remaining_wait_ms(UnixMillis(92_000)), 28_000);
    let recalled = terminal(&first, 92_000, TerminalOutcome::Recalled);
    s.record_terminal(recalled.clone(), UnixMillis(92_000))
        .unwrap();
    s.open_order(2, TimeInForce::Ioc {}, UnixMillis(92_000))
        .unwrap();
    s.record_terminal(recalled, UnixMillis(92_001)).unwrap();
    let next = grant(&s, 2, 2, 92_001, 94_000);
    let second = next.binding.clone();
    s.grant(next, UnixMillis(92_001)).unwrap();
    accept(&mut s, &second, 92_010, 92_020);
    assert_eq!(s.remaining_wait_ms(UnixMillis(1_000_000)), 27_990);
    assert_eq!(s.attempts().len(), 2);
    assert_eq!(s.terms().funding.id, "hold-1");

    let late = terminal(
        &first,
        92_000,
        native(chat("stop"), OutputCheck::Text, None),
    );
    assert_eq!(
        s.record_terminal(late, UnixMillis(93_000)),
        Err(InferenceError::Conflict)
    );
    s.record_terminal(
        terminal(
            &second,
            93_000,
            native(chat("stop"), OutputCheck::Text, None),
        ),
        UnixMillis(93_000),
    )
    .unwrap();
    assert_eq!(
        s.record_usage(usage(&first, 55), UnixMillis(93_001)),
        Err(InferenceError::Evidence)
    );
    s.record_usage(usage(&second, 20), UnixMillis(93_001))
        .unwrap();
    let Settlement::Ready(plan) = s.settlement() else {
        panic!("second attempt must be ready")
    };
    assert_eq!(plan.provider_id, 2);
    assert_eq!(plan.provider_amount, nano(150_000));
    assert_eq!(
        plan.buyer_debit,
        plan.provider_amount
            .checked_add(plan.platform_amount)
            .unwrap()
    );
    assert_eq!(
        plan.platform_amount,
        NanoUsd::from_micro_usd(i128::from(
            bitrouter_cloud::platform_billing::money::MicroUsd::from_input_tokens(u128::from(
                s.platform_snapshot().billable_input_tokens
            ))
            .unwrap()
            .value()
        ))
        .unwrap()
    );
}

#[test]
fn unknown_blocks_new_grant_and_late_in_window_acceptance_survives_expiry() {
    let mut s = flex();
    s.open_order(
        1,
        TimeInForce::Gtd {
            expires_at: UnixMillis(1_000),
        },
        UnixMillis(10),
    )
    .unwrap();
    let g = grant(&s, 1, 1, 20, 1_000);
    let b = g.binding.clone();
    s.grant(g, UnixMillis(20)).unwrap();
    s.mark_unknown(&b, UnixMillis(30_020)).unwrap();
    assert_eq!(s.remaining_wait_ms(UnixMillis(30_020)), 0);
    assert_eq!(s.status(), RequestStatus::Unknown);
    assert_eq!(
        s.open_order(2, TimeInForce::Ioc {}, UnixMillis(30_021)),
        Err(InferenceError::State)
    );
    assert_eq!(s.settlement(), &Settlement::Unavailable);
    assert_eq!(
        s.record_acceptance(
            Acceptance {
                binding: b.clone(),
                accepted_at: UnixMillis(1_000),
                proof_ref: "late-accept".into(),
            },
            UnixMillis(30_022)
        ),
        Err(InferenceError::Evidence)
    );
    accept(&mut s, &b, 999, 30_023);
    assert_eq!(s.remaining_wait_ms(UnixMillis(31_000)), 29_001);
    assert_eq!(s.status(), RequestStatus::Unknown);
    s.record_terminal(
        terminal(&b, 60_000, native(chat("stop"), OutputCheck::Text, None)),
        UnixMillis(60_000),
    )
    .unwrap();
    assert_eq!(s.status(), RequestStatus::Delivered);
}

#[test]
fn every_native_cap_terminal_keeps_its_wire_status_and_uses_total_generated_tokens() {
    let endings = [
        NativeEnd::Responses {
            status: "incomplete".into(),
            incomplete_reason: Some("max_output_tokens".into()),
            explicit_refusal: false,
        },
        chat("length"),
        NativeEnd::Messages {
            stop_reason: "max_tokens".into(),
            stop_sequence: None,
        },
    ];
    for end in endings {
        let mut s = strategy(
            end.protocol(),
            OutputContract::Tools {
                tools_digest: "b".repeat(64),
            },
            delivery_options(FallbackMode::ReplaceAttempt),
        );
        let b = start(&mut s);
        let result = native(
            end.clone(),
            OutputCheck::InvalidOrEmpty,
            Some(cap(CAP, CAP)),
        );
        s.record_terminal(terminal(&b, 100_000, result), UnixMillis(100_000))
            .unwrap();
        let d = s.delivery().unwrap();
        assert_eq!(d.kind, DeliveryKind::OutputLimit);
        assert!(!d.tool_calls_executable());
        assert_eq!(d.evidence.native, end);
        assert_eq!(s.settlement(), &Settlement::PendingMetering);
        assert_eq!(
            s.record_usage(usage(&b, CAP - 1), UnixMillis(100_001)),
            Err(InferenceError::Evidence)
        );
        assert_eq!(
            s.open_order(2, TimeInForce::Ioc {}, UnixMillis(100_001)),
            Err(InferenceError::State)
        );
        s.record_usage(usage(&b, CAP), UnixMillis(100_001)).unwrap();
        assert!(matches!(s.settlement(), Settlement::Ready(_)));
    }
}

#[test]
fn length_signal_needs_proof_of_agreed_limit_and_context_stop_is_unpaid() {
    for (end, proof) in [
        (chat("length"), Some(cap(CAP - 1, CAP - 1))),
        (chat("length"), Some(cap(CAP, CAP - 1))),
        (
            NativeEnd::Messages {
                stop_reason: "model_context_window_exceeded".into(),
                stop_sequence: None,
            },
            Some(cap(CAP, CAP)),
        ),
    ] {
        let mut s = strategy(
            end.protocol(),
            OutputContract::Text,
            delivery_options(FallbackMode::Off),
        );
        let b = start(&mut s);
        s.record_terminal(
            terminal(&b, 11, native(end, OutputCheck::Text, proof)),
            UnixMillis(11),
        )
        .unwrap();
        assert_eq!(
            s.status(),
            RequestStatus::Closed {
                reason: Failure::InvalidDelivery
            }
        );
        assert_eq!(s.settlement(), &Settlement::Unavailable);
    }

    let mut s = flex();
    let b = start(&mut s);
    let original = terminal(&b, 11, native(chat("length"), OutputCheck::Text, None));
    s.record_terminal(original.clone(), UnixMillis(11)).unwrap();
    assert_eq!(s.attempts()[0].terminal.as_ref(), Some(&original));
    assert_eq!(s.status(), RequestStatus::PendingDeliveryProof);
    assert_eq!(
        s.open_order(2, TimeInForce::Ioc {}, UnixMillis(12)),
        Err(InferenceError::State)
    );

    let mut cancelled = s.clone();
    cancelled.cancel(UnixMillis(12)).unwrap();
    assert_eq!(
        cancelled.record_cap_evidence(&b, &"d".repeat(64), cap(CAP, CAP), UnixMillis(13)),
        Err(InferenceError::State)
    );
    assert_eq!(
        cancelled.status(),
        RequestStatus::Closed {
            reason: Failure::Cancelled
        }
    );
    assert_eq!(cancelled.settlement(), &Settlement::Unavailable);

    assert_eq!(
        s.record_cap_evidence(&b, &"e".repeat(64), cap(CAP, CAP), UnixMillis(12)),
        Err(InferenceError::Evidence)
    );
    s.record_cap_evidence(&b, &"d".repeat(64), cap(CAP, CAP), UnixMillis(12))
        .unwrap();
    assert_eq!(s.cancel(UnixMillis(13)).unwrap(), RequestStatus::Delivered);
    assert_eq!(s.settlement(), &Settlement::PendingMetering);
    s.record_usage(usage(&b, CAP), UnixMillis(14)).unwrap();
    assert!(matches!(s.settlement(), Settlement::Ready(_)));
    assert_eq!(s.attempts()[0].terminal.as_ref(), Some(&original));
}

#[test]
fn natural_schema_and_tool_success_require_the_promised_output() {
    let schema = "b".repeat(64);
    for (end, promised, mut checked, expected) in [
        (
            chat("stop"),
            OutputContract::JsonSchema {
                schema_digest: schema.clone(),
            },
            OutputCheck::Schema {
                digest: schema.clone(),
            },
            Some(DeliveryKind::Complete),
        ),
        (
            chat("stop"),
            OutputContract::JsonSchema {
                schema_digest: schema.clone(),
            },
            OutputCheck::Text,
            None,
        ),
        (
            chat("tool_calls"),
            OutputContract::Text,
            OutputCheck::Tools {
                digest: schema.clone(),
            },
            None,
        ),
        (
            chat("tool_calls"),
            OutputContract::Tools {
                tools_digest: schema.clone(),
            },
            OutputCheck::Tools {
                digest: schema.clone(),
            },
            Some(DeliveryKind::ClientTools),
        ),
        (
            chat("tool_calls"),
            OutputContract::Tools {
                tools_digest: schema.clone(),
            },
            OutputCheck::InvalidOrEmpty,
            None,
        ),
        (
            NativeEnd::Messages {
                stop_reason: "stop_sequence".into(),
                stop_sequence: Some("<end>".into()),
            },
            OutputContract::JsonSchema {
                schema_digest: schema.clone(),
            },
            OutputCheck::InvalidOrEmpty,
            None,
        ),
        (
            NativeEnd::Messages {
                stop_reason: "stop_sequence".into(),
                stop_sequence: Some("undeclared".into()),
            },
            OutputContract::Text,
            OutputCheck::Text,
            None,
        ),
    ] {
        let mut s = strategy(
            end.protocol(),
            promised,
            delivery_options(FallbackMode::Off),
        );
        match (&s.terms().output, &mut checked) {
            (OutputContract::JsonSchema { schema_digest }, OutputCheck::Schema { digest }) => {
                *digest = schema_digest.clone()
            }
            (OutputContract::Tools { tools_digest }, OutputCheck::Tools { digest }) => {
                *digest = tools_digest.clone()
            }
            _ => {}
        }
        let b = start(&mut s);
        s.record_terminal(terminal(&b, 11, native(end, checked, None)), UnixMillis(11))
            .unwrap();
        assert_eq!(s.delivery().map(|d| d.kind), expected);
        if expected.is_some() {
            s.record_usage(usage(&b, 1), UnixMillis(12)).unwrap();
        } else {
            assert_eq!(s.settlement(), &Settlement::Unavailable);
        }
    }
}

#[test]
fn refusal_is_unpaid_and_cannot_trigger_reprocurement() {
    for end in [
        NativeEnd::ChatCompletions {
            finish_reason: "stop".into(),
            explicit_refusal: true,
        },
        NativeEnd::Responses {
            status: "incomplete".into(),
            incomplete_reason: Some("content_filter".into()),
            explicit_refusal: false,
        },
        NativeEnd::Messages {
            stop_reason: "refusal".into(),
            stop_sequence: None,
        },
    ] {
        let mut s = strategy(
            end.protocol(),
            OutputContract::Text,
            delivery_options(FallbackMode::ReplaceAttempt),
        );
        let b = start(&mut s);
        s.record_terminal(
            terminal(&b, 11, native(end, OutputCheck::Text, Some(cap(CAP, CAP)))),
            UnixMillis(11),
        )
        .unwrap();
        assert_eq!(
            s.status(),
            RequestStatus::Closed {
                reason: Failure::Refusal
            }
        );
        assert_eq!(
            s.open_order(2, TimeInForce::Ioc {}, UnixMillis(12)),
            Err(InferenceError::State)
        );
        assert_eq!(
            s.record_usage(usage(&b, CAP), UnixMillis(12)),
            Err(InferenceError::State)
        );
    }
}

#[test]
fn cancellation_and_success_follow_adjudication_order_with_metering_late() {
    let mut s = flex();
    let b = start(&mut s);
    let success = terminal(&b, 11, native(chat("stop"), OutputCheck::Text, None));
    let mut cancellation_first = s.clone();
    assert_eq!(
        cancellation_first.cancel(UnixMillis(12)).unwrap(),
        RequestStatus::Cancelling
    );
    assert_eq!(
        cancellation_first.open_order(2, TimeInForce::Ioc {}, UnixMillis(13)),
        Err(InferenceError::State)
    );
    cancellation_first
        .record_terminal(success.clone(), UnixMillis(13))
        .unwrap();
    assert_eq!(
        cancellation_first.status(),
        RequestStatus::Closed {
            reason: Failure::Cancelled
        }
    );
    assert_eq!(cancellation_first.settlement(), &Settlement::Unavailable);

    s.record_terminal(success, UnixMillis(12)).unwrap();
    assert_eq!(s.cancel(UnixMillis(13)).unwrap(), RequestStatus::Delivered);
    assert_eq!(s.settlement(), &Settlement::PendingMetering);
    let mut mismatched = usage(&b, 8);
    mismatched.result_digest = "e".repeat(64);
    assert_eq!(
        s.record_usage(mismatched, UnixMillis(14)),
        Err(InferenceError::Evidence)
    );
    s.record_usage(usage(&b, 8), UnixMillis(15)).unwrap();
    let Settlement::Ready(plan) = s.settlement().clone() else {
        panic!("missing settlement plan")
    };
    s.mark_commit_unknown(&plan, UnixMillis(16)).unwrap();
    assert!(matches!(s.settlement(), Settlement::CommitUnknown(_)));
    let receipt = SettlementReceipt {
        id: "receipt-1".into(),
        plan: *plan,
    };
    s.record_settlement(receipt.clone(), UnixMillis(17))
        .unwrap();
    s.record_settlement(receipt, UnixMillis(18)).unwrap();
    assert_eq!(
        s.record_usage(usage(&b, 9), UnixMillis(19)),
        Err(InferenceError::Conflict)
    );
}

#[test]
fn only_fence_releases_unaccepted_responsibility() {
    let mut s = flex();
    s.open_order(1, TimeInForce::Ioc {}, UnixMillis(0)).unwrap();
    let g = grant(&s, 1, 1, 1, 2_000);
    let b = g.binding.clone();
    s.grant(g, UnixMillis(1)).unwrap();
    s.mark_unknown(&b, UnixMillis(2_000)).unwrap();
    let mut foreign = b.clone();
    foreign.source_epoch += 1;
    assert_eq!(
        s.record_terminal(
            terminal(&foreign, 2_100, TerminalOutcome::FencedUnaccepted),
            UnixMillis(2_100)
        ),
        Err(InferenceError::Evidence)
    );
    assert_eq!(
        s.record_terminal(
            terminal(&b, 2_100, TerminalOutcome::Recalled),
            UnixMillis(2_100)
        ),
        Err(InferenceError::Evidence)
    );
    s.record_terminal(
        terminal(&b, 2_100, TerminalOutcome::FencedUnaccepted),
        UnixMillis(2_100),
    )
    .unwrap();
    assert_eq!(s.status(), RequestStatus::ReadyToProcure);
    assert_eq!(s.remaining_wait_ms(UnixMillis(2_101)), 27_899);
}

#[test]
fn ioc_closes_once_and_grant_consumes_the_single_option_and_attempt_slot() {
    let mut s = flex();
    s.open_order(1, TimeInForce::Ioc {}, UnixMillis(0)).unwrap();
    s.close_unmatched(1, UnixMillis(1)).unwrap();
    assert_eq!(
        s.orders()[0].status,
        OrderStatus::Closed {
            reason: Failure::NoSupply
        }
    );
    assert!(s.attempts().is_empty());
    s.open_order(2, TimeInForce::Ioc {}, UnixMillis(2)).unwrap();
    let g = grant(&s, 2, 1, 3, 2_002);
    s.grant(g.clone(), UnixMillis(3)).unwrap();
    s.grant(g, UnixMillis(4)).unwrap();
    assert_eq!(
        s.grant(grant(&s, 2, 2, 3, 2_002), UnixMillis(4)),
        Err(InferenceError::Conflict)
    );
    assert_eq!(s.attempts().len(), 1);
    let body = body_for(s.terms());
    let scope = purchase(s.terms());
    let original = Submission {
        protocol: s.terms().protocol,
        body: &body,
        purchase: &scope,
    };
    assert_eq!(s.check_replay(7, "key-1", original), Ok(()));
    let changed = PurchaseControls {
        wait_budget_ms: Some(100),
        ..scope.clone()
    };
    assert_eq!(
        s.check_replay(
            7,
            "key-1",
            Submission {
                purchase: &changed,
                ..original
            }
        ),
        Err(InferenceError::Conflict)
    );
}

#[test]
fn pre_dispatch_rejects_unauthorized_model_provider_cap_and_price() {
    let mut s = flex();
    s.open_order(1, TimeInForce::Ioc {}, UnixMillis(0)).unwrap();
    let valid = grant(&s, 1, 1, 1, 2_000);
    for mutated in [
        Grant {
            option_id: OptionId(999),
            ..valid.clone()
        },
        Grant {
            offer: SelectedOffer {
                provider_id: 9,
                ..valid.offer.clone()
            },
            ..valid.clone()
        },
        Grant {
            offer: SelectedOffer {
                max_output_tokens: CAP - 1,
                ..valid.offer.clone()
            },
            ..valid.clone()
        },
        Grant {
            offer: SelectedOffer {
                output_meter: "visible-only".into(),
                ..valid.offer.clone()
            },
            ..valid.clone()
        },
    ] {
        assert!(matches!(
            s.grant(mutated, UnixMillis(1)),
            Err(InferenceError::Contract(_))
        ));
        assert!(s.attempts().is_empty());
    }
    let mut limit = s.terms().clone();
    limit.funding.total_cap = nano(1);
    assert!(matches!(
        build_strategy(limit),
        Err(InferenceError::Funding)
    ));

    let mut limit = s.terms().clone();
    limit.funding.provider_cap = MicroUsd(319);
    let mut low = build_strategy(limit).unwrap();
    low.open_order(1, TimeInForce::Ioc {}, UnixMillis(0))
        .unwrap();
    assert_eq!(
        low.grant(valid, UnixMillis(1)),
        Err(InferenceError::Funding)
    );
}

#[test]
fn before_output_fallback_cannot_replace_a_public_native_response() {
    for exposed in [false, true] {
        let mut s = strategy(
            ApiProtocol::ChatCompletions,
            OutputContract::Text,
            DeliveryOptions {
                recovery: RecoveryMode::Native,
                ..delivery_options(FallbackMode::BeforeOutput)
            },
        );
        let b = start(&mut s);
        if exposed {
            s.mark_public_output(&b, UnixMillis(11)).unwrap();
        }
        s.record_terminal(terminal(&b, 12, TerminalOutcome::Recalled), UnixMillis(12))
            .unwrap();
        assert_eq!(
            s.status(),
            if exposed {
                RequestStatus::Closed {
                    reason: Failure::Recalled,
                }
            } else {
                RequestStatus::ReadyToProcure
            }
        );
    }
    assert!(
        DeliveryOptions {
            recovery: RecoveryMode::Native,
            ..delivery_options(FallbackMode::ReplaceAttempt)
        }
        .validate(ApiProtocol::Responses)
        .is_err()
    );
}

#[test]
fn native_caps_are_resolved_without_silent_clamping_or_ambiguous_controls() {
    let default = std::num::NonZeroU64::new(100).unwrap();
    assert_eq!(
        freeze_output_limit(ApiProtocol::Responses, &json!({}), default),
        Ok(100)
    );
    assert_eq!(
        freeze_output_limit(
            ApiProtocol::ChatCompletions,
            &json!({"max_tokens":200}),
            default
        ),
        Ok(200)
    );
    assert!(
        freeze_output_limit(
            ApiProtocol::ChatCompletions,
            &json!({"max_tokens":200,"max_completion_tokens":100}),
            default
        )
        .is_err()
    );
    assert!(freeze_output_limit(ApiProtocol::Messages, &json!({}), default).is_err());
    assert!(freeze_output_limit(ApiProtocol::Messages, &json!({"max_tokens":0}), default).is_err());
}

#[test]
fn wait_budget_continues_between_ioc_probe_and_next_order() {
    let mut s = flex();
    s.open_order(1, TimeInForce::Ioc {}, UnixMillis(2_000))
        .unwrap();
    s.close_unmatched(1, UnixMillis(2_100)).unwrap();
    assert_eq!(s.remaining_wait_ms(UnixMillis(3_000)), 27_000);
    s.open_order(
        2,
        TimeInForce::Gtd {
            expires_at: UnixMillis(100_000),
        },
        UnixMillis(3_000),
    )
    .unwrap();
    assert_eq!(s.orders()[1].window.accept_before, UnixMillis(30_000));
    s.expire_wait(UnixMillis(30_000)).unwrap();
    assert_eq!(
        s.status(),
        RequestStatus::Closed {
            reason: Failure::WaitExhausted
        }
    );
}

#[test]
fn native_delivery_controls_are_separate_and_disconnect_respects_background() {
    let (native, _) =
        DeliveryOptions::parse(ApiProtocol::Responses, &json!({"background":true})).unwrap();
    assert!(native.background);
    assert!(!native.stream);
    assert_eq!(native.fallback, FallbackMode::Off);

    let (extended, body) = DeliveryOptions::parse(
        ApiProtocol::Messages,
        &json!({
            "stream":true, "max_tokens":CAP, "background":true,
            "bitrouter_delivery":{"recovery":"bitrouter.stream.v1","auto_fallback":"replace_attempt"}
        }),
    )
    .unwrap();
    assert_eq!(body, json!({"stream":true,"max_tokens":CAP}));
    assert!(extended.background && extended.stream && extended.allows_retry(true));
    for protocol in [ApiProtocol::ChatCompletions, ApiProtocol::Messages] {
        let (native, body) = DeliveryOptions::parse(protocol, &json!({"background":true})).unwrap();
        assert!(native.background);
        assert_eq!(native.recovery, RecoveryMode::Native);
        assert_eq!(native.fallback, FallbackMode::Off);
        assert!(body.get("background").is_none());
        assert!(DeliveryOptions::parse(protocol, &json!({"background":"true"})).is_err());
        assert!(
            DeliveryOptions::parse(protocol, &json!({"bitrouter_delivery":{"background":true}}))
                .is_err()
        );
    }
    assert!(
        DeliveryOptions::parse(
            ApiProtocol::Responses,
            &json!({
                "background":true,"bitrouter_delivery":{"background":false}
            })
        )
        .is_err()
    );

    let mut foreground = flex();
    let original = start(&mut foreground);
    assert_eq!(
        foreground.client_disconnected(UnixMillis(11)).unwrap(),
        RequestStatus::Cancelling
    );
    assert!(foreground.attempts()[0].terminal.is_none());
    assert_eq!(foreground.attempts()[0].grant.binding, original);

    let mut background = strategy(ApiProtocol::Messages, OutputContract::Text, extended);
    start(&mut background);
    assert_eq!(
        background.client_disconnected(UnixMillis(11)).unwrap(),
        RequestStatus::Executing
    );
}

#[test]
fn unknown_native_reason_and_pause_turn_cannot_end_execution() {
    let mut s = strategy(
        ApiProtocol::Messages,
        OutputContract::Text,
        delivery_options(FallbackMode::ReplaceAttempt),
    );
    let b = start(&mut s);
    s.mark_unknown(&b, UnixMillis(11)).unwrap();
    for stop_reason in ["pause_turn", "unexpected"] {
        let end = NativeEnd::Messages {
            stop_reason: stop_reason.into(),
            stop_sequence: None,
        };
        let outcome = native(end, OutputCheck::Text, None);
        assert_eq!(
            s.record_terminal(terminal(&b, 12, outcome), UnixMillis(12)),
            Err(InferenceError::Evidence)
        );
        assert_eq!(s.status(), RequestStatus::Unknown);
    }
}

#[test]
fn response_terminal_with_a_refusal_never_enters_cap_billing() {
    let mut s = strategy(
        ApiProtocol::Responses,
        OutputContract::Text,
        delivery_options(FallbackMode::ReplaceAttempt),
    );
    let b = start(&mut s);
    let end = NativeEnd::Responses {
        status: "incomplete".into(),
        incomplete_reason: Some("max_output_tokens".into()),
        explicit_refusal: true,
    };
    s.record_terminal(
        terminal(
            &b,
            11,
            native(end, OutputCheck::InvalidOrEmpty, Some(cap(CAP, CAP))),
        ),
        UnixMillis(11),
    )
    .unwrap();
    assert_eq!(
        s.status(),
        RequestStatus::Closed {
            reason: Failure::Refusal
        }
    );
    assert_eq!(s.settlement(), &Settlement::Unavailable);
}

#[test]
fn confirmed_terminal_after_cancel_closes_without_proving_chargeability() {
    let mut s = flex();
    let b = start(&mut s);
    s.cancel(UnixMillis(11)).unwrap();
    s.record_terminal(
        terminal(
            &b,
            12,
            native(chat("length"), OutputCheck::InvalidOrEmpty, None),
        ),
        UnixMillis(12),
    )
    .unwrap();
    assert_eq!(
        s.status(),
        RequestStatus::Closed {
            reason: Failure::Cancelled
        }
    );
    assert_eq!(s.settlement(), &Settlement::Unavailable);
}

#[test]
fn original_submission_binds_platform_meter_and_frozen_constraints() {
    let controls = DeliveryOptions {
        background: true,
        recovery: RecoveryMode::Native,
        ..delivery_options(FallbackMode::Off)
    };
    let terms = terms(ApiProtocol::Responses, OutputContract::Text, controls);
    let body = body_for(&terms);
    let scope = purchase(&terms);
    let original = Submission {
        protocol: terms.protocol,
        body: &body,
        purchase: &scope,
    };
    let s = Strategy::new(terms.clone(), policy(), original, UnixMillis(0)).unwrap();
    let mut metered = body.clone();
    metered.as_object_mut().unwrap().remove("background");
    metered
        .as_object_mut()
        .unwrap()
        .remove("bitrouter_delivery");
    assert_eq!(
        s.platform_snapshot(),
        &bitrouter_cloud::platform_billing::meter::freeze(ApiProtocol::Responses, &metered)
            .unwrap()
    );
    assert!(s.terms().delivery.background);
    let mut other = body.clone();
    other["input"] = json!("hello from a different prompt with more platform input tokens");
    assert_eq!(
        s.check_replay(
            7,
            "key-1",
            Submission {
                body: &other,
                ..original
            }
        ),
        Err(InferenceError::Conflict)
    );
    let different_input = Strategy::new(
        terms.clone(),
        policy(),
        Submission {
            body: &other,
            ..original
        },
        UnixMillis(0),
    )
    .unwrap();
    assert!(
        different_input.platform_snapshot().billable_input_tokens
            > s.platform_snapshot().billable_input_tokens
    );

    other["text"] = json!({"format":{"type":"json_schema","strict":true,"schema":schema()}});
    assert!(matches!(
        Strategy::new(
            terms.clone(),
            policy(),
            Submission {
                body: &other,
                ..original
            },
            UnixMillis(0)
        ),
        Err(InferenceError::Contract(_))
    ));
    other["text"]["format"]["schema"]["properties"]["answer"]["$ref"] =
        json!("https://example.com/unsupported");
    assert!(output_contract(ApiProtocol::Responses, &other).is_err());

    let changed_scope = PurchaseControls {
        max_attempts: Some(1),
        ..scope.clone()
    };
    assert!(matches!(
        Strategy::new(
            terms,
            policy(),
            Submission {
                purchase: &changed_scope,
                ..original
            },
            UnixMillis(0)
        ),
        Err(InferenceError::Contract(_))
    ));
}

#[test]
fn required_client_tool_must_use_native_shape_and_reference_a_declared_name() {
    for (protocol, valid, invalid, parameter_path) in [
        (
            ApiProtocol::ChatCompletions,
            json!({"type":"function","function":{"name":"foo"}}),
            json!("function"),
            "/tools/0/function/parameters",
        ),
        (
            ApiProtocol::Responses,
            json!({"type":"function","name":"foo"}),
            json!({"type":"function","name":"unknown"}),
            "/tools/0/parameters",
        ),
        (
            ApiProtocol::Messages,
            json!({"type":"tool","name":"foo"}),
            json!({"type":"tool"}),
            "/tools/0/input_schema",
        ),
    ] {
        let terms = terms(
            protocol,
            OutputContract::Tools {
                tools_digest: "b".repeat(64),
            },
            delivery_options(FallbackMode::Off),
        );
        let mut body = body_for(&terms);
        body["tool_choice"] = valid.clone();
        assert!(matches!(
            output_contract(protocol, &body),
            Ok(OutputContract::Tools { .. })
        ));
        body["tool_choice"] = invalid;
        assert!(matches!(
            output_contract(protocol, &body),
            Err(InferenceError::Contract(_))
        ));
        body["tool_choice"] = valid;
        *body.pointer_mut(parameter_path).unwrap() =
            json!({"$ref":"https://example.com/unsupported"});
        assert!(matches!(
            output_contract(protocol, &body),
            Err(InferenceError::Contract(_))
        ));
    }
}
