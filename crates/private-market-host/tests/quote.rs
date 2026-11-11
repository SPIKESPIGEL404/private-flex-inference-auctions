use bitrouter_market::order::*;
use bitrouter_market::quote::{LatencyBoundary, LatencyPrediction};
use bitrouter_market::throughput::{
    assess_throughput, ThroughputObservation, ThroughputVerification,
};

#[allow(dead_code)]
mod common;
use common::*;

fn prediction() -> LatencyPrediction {
    let buy = buy();
    LatencyPrediction {
        version: 1,
        request_digest: buy.request_digest,
        backend_ref: "fixture/backend-1".into(),
        offering: offering(),
        request_size: buy.request_size,
        output_estimate: buy.output_estimate,
        boundary: LatencyBoundary::MarketEndToEnd,
        estimated_ttft_ms: Some(200),
        estimated_tpot_ms: Some(20),
        load_ref: "fixture/load-1".into(),
        max_market_requests: 2,
        updated_at: NOW,
        valid_until: UnixMillis(1_500),
    }
}

#[test]
fn same_size_different_request_cannot_reuse_a_prediction() {
    let prediction = prediction();
    let mut buy = buy();
    let offering = offering();
    assert_eq!(
        prediction.validate_request(
            &spec(),
            &buy.request(),
            buy.output_estimate,
            &offering,
            NOW,
            1
        ),
        Ok(())
    );
    buy.request_digest = "fixture/another-prompt-same-size".into();
    assert_eq!(
        prediction.validate_request(
            &spec(),
            &buy.request(),
            buy.output_estimate,
            &offering,
            NOW,
            1
        ),
        Err(ValidationError::PredictionRequestMismatch)
    );
}

#[test]
fn changed_supply_identity_terms_and_versions_invalidate_a_prediction() {
    let prediction = prediction();
    for change in 0..7 {
        let mut offering = offering();
        match change {
            0 => offering.id += 1,
            1 => offering.provider_id += 1,
            2 => offering.generation += 1,
            3 => offering.update_seq += 1,
            4 => offering.rates.input += 1,
            5 => offering.agent_config_ref.push_str("-changed"),
            _ => offering.throughput.rate.output_tokens += 1,
        }
        assert_eq!(
            prediction.validate_request(
                &spec(),
                &buy().request(),
                buy().output_estimate,
                &offering,
                NOW,
                1
            ),
            Err(ValidationError::PredictionOfferingMismatch)
        );
    }
}

#[test]
fn prediction_and_declaration_have_independent_exclusive_expiry() {
    let mut prediction = prediction();
    let spec = spec();
    assert_eq!(prediction.validate(&spec, UnixMillis(1_499)), Ok(()));
    assert_eq!(
        prediction.validate(&spec, UnixMillis(1_500)),
        Err(ValidationError::Expired)
    );
    assert_eq!(
        prediction.offering.validate(&spec, UnixMillis(1_500)),
        Ok(())
    );
    prediction.valid_until = UnixMillis(2_000);
    assert_eq!(
        prediction.validate(&spec, UnixMillis(1_800)),
        Err(ValidationError::Expired)
    );
}

#[test]
fn predictions_preserve_shape_output_capacity_and_measurement_checks() {
    let spec = spec();
    let buy = buy();
    let offering = offering();
    let mut prediction = prediction();
    for count in [0, 3] {
        assert_eq!(
            prediction.validate_request(
                &spec,
                &buy.request(),
                buy.output_estimate,
                &offering,
                NOW,
                count
            ),
            Err(ValidationError::PredictionCapacityExceeded)
        );
    }
    prediction.request_size.input_tokens += 1;
    assert_eq!(
        prediction.validate_request(
            &spec,
            &buy.request(),
            buy.output_estimate,
            &offering,
            NOW,
            1
        ),
        Err(ValidationError::PredictionSizeMismatch)
    );
    prediction.request_size = buy.request_size;
    prediction.output_estimate.visible_output_tokens -= 1;
    assert_eq!(
        prediction.validate_request(
            &spec,
            &buy.request(),
            buy.output_estimate,
            &offering,
            NOW,
            1
        ),
        Err(ValidationError::PredictionOutputMismatch)
    );
    prediction.boundary = LatencyBoundary::ProviderEngine;
    assert_eq!(
        prediction.validate(&spec, NOW),
        Err(ValidationError::MeasurementBoundaryMismatch)
    );
    prediction.boundary = LatencyBoundary::MarketEndToEnd;
    prediction.max_market_requests = 0;
    assert_eq!(
        prediction.validate(&spec, NOW),
        Err(ValidationError::InvalidPredictionCapacity)
    );
}

#[test]
fn missing_bindings_and_invalid_prediction_windows_are_rejected() {
    let original = prediction();
    for (field, label) in [
        (0, "prediction.request_digest"),
        (1, "prediction.backend_ref"),
        (2, "load_ref"),
    ] {
        let mut prediction = original.clone();
        match field {
            0 => prediction.request_digest.clear(),
            1 => prediction.backend_ref.clear(),
            _ => prediction.load_ref.clear(),
        }
        assert_eq!(
            prediction.validate(&spec(), NOW),
            Err(ValidationError::MissingField(label))
        );
    }
    let mut prediction = original;
    prediction.updated_at = UnixMillis(NOW.0 + 1);
    assert_eq!(
        prediction.validate(&spec(), NOW),
        Err(ValidationError::FutureObservation)
    );
    prediction.valid_until = prediction.updated_at;
    assert_eq!(
        prediction.validate(&spec(), NOW),
        Err(ValidationError::InvalidValidityWindow)
    );
}

#[test]
fn zero_and_one_visible_token_predictions_use_explicit_not_applicable_latency() {
    let mut prediction = prediction();
    for visible in [0, 1, 2] {
        prediction.output_estimate.visible_output_tokens = visible;
        prediction.estimated_ttft_ms = (visible > 0).then_some(200);
        prediction.estimated_tpot_ms = (visible > 1).then_some(20);
        assert_eq!(prediction.validate(&spec(), NOW), Ok(()));
        prediction.estimated_tpot_ms = if visible > 1 { None } else { Some(0) };
        assert_eq!(
            prediction.validate(&spec(), NOW),
            Err(ValidationError::InvalidLatencyApplicability)
        );
    }
}

#[test]
fn refreshing_request_predictions_preserves_throughput_evidence() {
    let mut prediction = prediction();
    let mut offering = offering();
    offering.valid_until = UnixMillis(5_000);
    prediction.offering = offering.clone();
    prediction.valid_until = UnixMillis(4_500);
    let mut buy = buy();
    buy.expires_at = UnixMillis(5_000);
    let check_at = UnixMillis(2_000);
    let observation = ThroughputObservation {
        offering: offering.clone(),
        profile: profile(),
        started_at: NOW,
        ended_at: check_at,
        valid_until: UnixMillis(2_500),
        demand_sufficient: true,
        completed_requests: 20,
        failed_requests: 0,
        billable_output_tokens: 4_000,
        p95_e2e_ms: Some(500),
    };
    for _ in 0..2 {
        prediction
            .validate_request(
                &spec(),
                &buy.request(),
                buy.output_estimate,
                &offering,
                check_at,
                1,
            )
            .unwrap();
        assert_eq!(
            assess_throughput(&spec(), &offering, &profile(), Some(&observation), check_at),
            Ok(ThroughputVerification::Verified)
        );
        prediction.version += 1;
        prediction.estimated_ttft_ms = Some(900);
        prediction.load_ref = "fixture/new-load".into();
        prediction.updated_at = check_at;
    }
}
