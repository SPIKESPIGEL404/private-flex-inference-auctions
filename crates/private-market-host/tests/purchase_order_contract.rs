use bitrouter_market::formal_order::CloseFormalOrder;
use bitrouter_market::formal_order::PlaceFormalOrder;
#[allow(dead_code)]
mod common;

use bitrouter_market::authorization::*;
use bitrouter_market::order::*;
use bitrouter_market::orderbook::OfferingVersion;
use bitrouter_market::purchase_order::*;
use bitrouter_market::terms::RequestSpec;
use std::collections::BTreeMap;

fn policy() -> TimePolicy {
    TimePolicy {
        rules_ref: TIME_RULES_REF.into(),
        immediate_decision_window_ms: 100,
        immediate_total_window_ms: 300,
        grant_acceptance_window_ms: 200,
    }
}
fn registration() -> PlaceFormalOrder {
    let spec = common::spec();
    let request = RequestSpec {
        request_ref: "rendered-request".into(),
        request_digest: "rendered-digest".into(),
        size: RequestSize {
            input_tokens: 10,
            max_output_tokens: 20,
        },
    };
    PlaceFormalOrder {
        version: bitrouter_market::formal_order::FORMAL_VERSION,
        idempotency_key: "register/1".into(),
        authorization: OrderAuthorization {
            max_adjudication_wait_ms: 86_400_000,
            version: ORDER_CONTRACT_VERSION,
            binding: RootBinding {
                root: OrderRef::new("exchange".into(), OrderSide::Buy, 7, "request/1".into())
                    .unwrap(),
                authorization_version: 1,
            },
            logical_request_ref: "original-request".into(),
            logical_request_digest: "original-digest".into(),
            options: [10, 20]
                .map(|option| RequestOption {
                    option_id: OptionId(option),
                    market_spec_ref: spec.reference.clone(),
                    request: request.clone(),
                })
                .to_vec(),
            max_charge: MicroUsd(100),
            tif: TimeInForce::Gtd {
                expires_at: UnixMillis(10_000),
            },
        },
        provider_scope: Default::default(),
        selection: Default::default(),
    }
}
fn catalog() -> BTreeMap<String, bitrouter_market::market_spec::MarketSpec> {
    let spec = common::spec();
    BTreeMap::from([(spec.reference.market_id.clone(), spec)])
}
fn content(reference: &str) -> ContentBinding {
    ContentBinding {
        reference: reference.into(),
        sha256: "a".repeat(64),
    }
}
fn proposal(registration: &PlaceFormalOrder) -> ProposePurchase {
    ProposePurchase {
        version: ORDER_CONTRACT_VERSION,
        idempotency_key: "propose/1".into(),
        proposal_id: "proposal/1".into(),
        decision_id: "decision/1".into(),
        root: registration.authorization.binding.clone(),
        basis: ProposalBasis {
            exchange_revision: 17,
            observed_at: UnixMillis(1_000),
            evidence: content("snapshot/17"),
        },
        candidates: vec![PurchaseCandidate {
            option_id: OptionId(10),
            market_spec_ref: common::spec().reference,
            provider_id: 9,
            offering_id: 3,
            source_generation: 1,
            quote_version: OfferingVersion {
                generation: 1,
                update_seq: 2,
            },
            seller_option: None,
            quote: content("quote/3/2"),
            evidence: content("evidence/3/2"),
        }],
    }
}

#[test]
fn alternatives_preserve_one_root_cap() {
    let mut registration = registration();
    registration.validate(&catalog()).unwrap();
    let cap = registration.authorization.max_charge;
    registration.authorization.options.pop();
    registration.validate(&catalog()).unwrap();
    assert_eq!(registration.authorization.max_charge, cap);
    // Free service is a valid authorization, not a missing limit.
    registration.authorization.max_charge = MicroUsd(0);
    registration.validate(&catalog()).unwrap();
}

#[test]
fn flat_alternatives_reject_duplicate_empty_and_tree_payloads() {
    let mut p = registration();
    p.authorization.options[1].option_id = p.authorization.options[0].option_id;
    assert_eq!(
        p.validate(&catalog()),
        Err(OrderContractError::OptionSetMismatch)
    );
    p.authorization.options.clear();
    assert_eq!(
        p.validate(&catalog()),
        Err(OrderContractError::OptionSetMismatch)
    );
    let mut value = serde_json::to_value(registration()).unwrap();
    value["authorization"]["tree"] = serde_json::json!({});
    assert!(serde_json::from_value::<PlaceFormalOrder>(value).is_err());
}

#[test]
fn model_revision_request_size_and_root_authority_are_checked() {
    let original = registration();
    let mut registration = original.clone();
    registration.authorization.options[0]
        .market_spec_ref
        .revision += 1;
    assert_eq!(
        registration.validate(&catalog()),
        Err(OrderContractError::Demand(
            ValidationError::MarketSpecMismatch
        ))
    );
    let mut registration = original.clone();
    registration.authorization.options[0]
        .request
        .size
        .max_output_tokens = u64::MAX;
    assert!(matches!(
        registration.validate(&catalog()),
        Err(OrderContractError::Demand(_))
    ));
    let mut registration = original.clone();
    registration.authorization.binding.authorization_version = 0;
    assert_eq!(
        registration.validate(&catalog()),
        Err(OrderContractError::InvalidAuthorizationVersion)
    );
    registration.authorization.binding.root =
        OrderRef::new("exchange".into(), OrderSide::Sell, 7, "request/1".into()).unwrap();
    assert_eq!(
        registration.validate(&catalog()),
        Err(OrderContractError::WrongSide)
    );
}

#[test]
fn ioc_uses_original_t0_for_decision_and_remote_acceptance() {
    let window = TimeInForce::Ioc {}
        .normalize(UnixMillis(1_000), &policy())
        .unwrap();
    assert_eq!(window.decision_before, UnixMillis(1_100));
    assert_eq!(window.accept_before, UnixMillis(1_300));
    window.validate_decision(UnixMillis(1_099)).unwrap();
    assert_eq!(
        window.validate_decision(UnixMillis(1_100)),
        Err(OrderContractError::DecisionExpired)
    );
    assert_eq!(
        window.validate_decision(UnixMillis(999)),
        Err(OrderContractError::BeforeRegistration)
    );
    let grant = GrantWindowInputs {
        buyer: window,
        seller_accept_before: UnixMillis(9_000),
        execution_condition_before: None,
        decided_at: UnixMillis(1_099),
    }
    .freeze(&policy())
    .unwrap();
    assert_eq!(grant.accept_before, UnixMillis(1_299));
    let mut long_grant = policy();
    long_grant.grant_acceptance_window_ms = 1_000;
    assert_eq!(
        GrantWindowInputs {
            buyer: window,
            seller_accept_before: UnixMillis(9_000),
            execution_condition_before: None,
            decided_at: UnixMillis(1_099),
        }
        .freeze(&long_grant)
        .unwrap()
        .accept_before,
        UnixMillis(1_300)
    );
}

#[test]
fn gtd_can_accept_before_expiry_and_deliver_later() {
    let buyer = TimeInForce::Gtd {
        expires_at: UnixMillis(10_000),
    }
    .normalize(UnixMillis(1_000), &policy())
    .unwrap();
    let grant = GrantWindowInputs {
        buyer,
        seller_accept_before: UnixMillis(9_000),
        execution_condition_before: None,
        decided_at: UnixMillis(2_000),
    }
    .freeze(&policy())
    .unwrap();
    assert_eq!(grant.accept_before, UnixMillis(2_200));
    grant.validate_accepted_at(UnixMillis(2_199)).unwrap();
    assert_eq!(
        grant.validate_accepted_at(UnixMillis(2_200)),
        Err(OrderContractError::AcceptanceExpired)
    );
    // Validation consumes accepted_at, not later report/finish wall time.
    let late_report_time = UnixMillis(20_000);
    assert!(late_report_time > buyer.accept_before);
    grant.validate_accepted_at(UnixMillis(2_199)).unwrap();
    // One millisecond left in GTD does not impose a one-millisecond service SLA.
    let last = GrantWindowInputs {
        decided_at: UnixMillis(9_999),
        seller_accept_before: UnixMillis(20_000),
        ..GrantWindowInputs {
            buyer,
            seller_accept_before: UnixMillis(9_000),
            execution_condition_before: None,
            decided_at: UnixMillis(2_000),
        }
    }
    .freeze(&policy())
    .unwrap();
    assert_eq!(last.accept_before, UnixMillis(10_000));
}

#[test]
fn minimum_deadline_only_includes_explicit_execution_conditions() {
    let buyer = TimeInForce::Gtd {
        expires_at: UnixMillis(10_000),
    }
    .normalize(UnixMillis(1_000), &policy())
    .unwrap();
    let mut inputs = GrantWindowInputs {
        buyer,
        seller_accept_before: UnixMillis(2_100),
        execution_condition_before: Some(UnixMillis(2_050)),
        decided_at: UnixMillis(2_000),
    };
    assert_eq!(
        inputs.freeze(&policy()).unwrap().accept_before,
        UnixMillis(2_050)
    );
    inputs.execution_condition_before = None;
    assert_eq!(
        inputs.freeze(&policy()).unwrap().accept_before,
        UnixMillis(2_100)
    );
    inputs.seller_accept_before = UnixMillis(2_000);
    assert_eq!(
        inputs.freeze(&policy()),
        Err(OrderContractError::InvalidWindow)
    );
}

#[test]
fn bad_policies_expired_windows_and_timestamp_overflow_fail_closed() {
    let mut config = policy();
    config.immediate_decision_window_ms = 0;
    assert_eq!(
        TimeInForce::Ioc {}.normalize(UnixMillis(1), &config),
        Err(OrderContractError::InvalidTimePolicy)
    );
    config = policy();
    config.immediate_total_window_ms = 99;
    assert_eq!(
        config.validate(),
        Err(OrderContractError::InvalidTimePolicy)
    );
    config = policy();
    config.rules_ref = "unknown-v2".into();
    assert_eq!(
        config.validate(),
        Err(OrderContractError::UnsupportedVersion)
    );
    assert_eq!(
        TimeInForce::Ioc {}.normalize(UnixMillis(u64::MAX - 100), &policy()),
        Err(OrderContractError::TimeOverflow)
    );
    assert_eq!(
        TimeInForce::Gtd {
            expires_at: UnixMillis(1_000)
        }
        .normalize(UnixMillis(1_000), &policy()),
        Err(OrderContractError::InvalidWindow)
    );
    let inputs = GrantWindowInputs {
        buyer: TimeInForce::Gtd {
            expires_at: UnixMillis(u64::MAX),
        }
        .normalize(UnixMillis(1), &policy())
        .unwrap(),
        seller_accept_before: UnixMillis(u64::MAX),
        execution_condition_before: None,
        decided_at: UnixMillis(u64::MAX - 100),
    };
    assert_eq!(
        inputs.freeze(&policy()),
        Err(OrderContractError::TimeOverflow)
    );
}

#[test]
fn proposal_binds_the_full_root_policy_and_authorized_leaf() {
    let registration = registration();
    let original = proposal(&registration);
    original.validate_for(&registration).unwrap();
    let mut p = original.clone();
    p.root.authorization_version += 1;
    assert_eq!(
        p.validate_for(&registration),
        Err(OrderContractError::RootMismatch)
    );
    let _p = original.clone();
    let mut p = original.clone();
    p.candidates[0].option_id = OptionId(99);
    assert_eq!(
        p.validate_for(&registration),
        Err(OrderContractError::CandidateBinding)
    );
    let mut p = original.clone();
    p.candidates[0].market_spec_ref.revision += 1;
    assert_eq!(
        p.validate_for(&registration),
        Err(OrderContractError::CandidateBinding)
    );
}

#[test]
fn candidates_are_bounded_unique_and_finite_sellers_have_full_identity() {
    let registration = registration();
    let original = proposal(&registration);
    let mut p = original.clone();
    p.candidates.clear();
    assert_eq!(
        p.validate_for(&registration),
        Err(OrderContractError::CandidateCount)
    );
    p.candidates = vec![original.candidates[0].clone(); MAX_CANDIDATES + 1];
    assert_eq!(
        p.validate_for(&registration),
        Err(OrderContractError::CandidateCount)
    );
    p.candidates.truncate(2);
    p.candidates[1].quote_version.update_seq += 1;
    assert_eq!(
        p.validate_for(&registration),
        Err(OrderContractError::DuplicateCandidate)
    );
    let mut p = original.clone();
    p.candidates[0].seller_option = Some(OptionExecutionKey {
        order: OrderRef::new("exchange".into(), OrderSide::Sell, 9, "sell/1".into()).unwrap(),
        option_id: OptionId(1),
    });
    p.validate_for(&registration).unwrap();
    p.candidates[0].seller_option.as_mut().unwrap().order =
        OrderRef::new("other-exchange".into(), OrderSide::Sell, 9, "sell/1".into()).unwrap();
    assert_eq!(
        p.validate_for(&registration),
        Err(OrderContractError::CandidateBinding)
    );
    let mut p = original;
    p.candidates[0].source_generation = 0;
    assert_eq!(
        p.validate_for(&registration),
        Err(OrderContractError::CandidateBinding)
    );
}

#[test]
fn slightly_old_snapshot_is_advisory_but_future_snapshot_is_rejected() {
    let registration = registration();
    let mut p = proposal(&registration);
    let window = registration
        .authorization
        .tif
        .normalize(UnixMillis(1_500), &policy())
        .unwrap();
    // A quote snapshot may predate registration; G must revalidate relevance.
    p.validate_time(window, UnixMillis(2_000)).unwrap();
    p.basis.exchange_revision = 0;
    p.validate_time(window, UnixMillis(2_000)).unwrap();
    p.basis.observed_at = UnixMillis(2_001);
    assert_eq!(
        p.validate_time(window, UnixMillis(2_000)),
        Err(OrderContractError::InvalidSnapshot)
    );
}

#[test]
fn current_wire_rejects_unknown_fields_public_priority_and_unknown_versions() {
    let original = registration();
    let encoded = serde_json::to_value(&original).unwrap();
    let decoded: PlaceFormalOrder = serde_json::from_value(encoded.clone()).unwrap();
    decoded.validate(&catalog()).unwrap();
    assert_eq!(decoded, original);
    let mut value = encoded.clone();
    value["authorization"]["time_cap_ms"] = 1.into();
    assert!(serde_json::from_value::<PlaceFormalOrder>(value).is_err());
    let mut value = encoded;
    value["version"] = 3.into();
    assert_eq!(
        serde_json::from_value::<PlaceFormalOrder>(value)
            .unwrap()
            .validate(&catalog()),
        Err(OrderContractError::UnsupportedVersion)
    );
    let mut value = serde_json::to_value(proposal(&original)).unwrap();
    value["competition_seq"] = 1.into();
    assert!(serde_json::from_value::<ProposePurchase>(value).is_err());
    assert!(serde_json::from_str::<TimeInForce>(r#"{"kind":"ioc","expires_at":123}"#).is_err());
    assert!(serde_json::from_str::<TimeInForce>(r#"{"kind":"gtc"}"#).is_err());
}

#[test]
fn invalid_content_binding_is_not_silently_accepted_as_evidence() {
    let registration = registration();
    let mut p = proposal(&registration);
    p.candidates[0].evidence.sha256 = "opaque-unverified-reference".into();
    assert_eq!(
        p.validate_for(&registration),
        Err(OrderContractError::InvalidReference)
    );
    let mut binding = content("quote/1");
    binding.sha256 = "A".repeat(64);
    assert_eq!(
        binding.validate(),
        Err(OrderContractError::InvalidReference)
    );
}

#[test]
fn close_command_targets_exact_root_without_claiming_execution_cancellation() {
    let registration = registration();
    let root = &registration.authorization.binding;
    let mut close = CloseFormalOrder {
        idempotency_key: "close/1".into(),
        root: root.clone(),
    };
    close.validate_for(root).unwrap();
    close.root.authorization_version += 1;
    assert_eq!(
        close.validate_for(root),
        Err(OrderContractError::RootMismatch)
    );
}
