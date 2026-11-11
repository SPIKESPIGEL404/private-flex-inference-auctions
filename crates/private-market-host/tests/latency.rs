use bitrouter_market::cost::{estimated_base_charge, CachedInputEstimate};
use bitrouter_market::latency::{estimated_e2e, E2eEstimate, LatencyError};
use bitrouter_market::order::*;
use bitrouter_market::quote::{LatencyBoundary, LatencyPrediction};

#[allow(dead_code)]
mod common;
use common::*;

fn prediction(visible: u64, ttft: u64, tpot: u64) -> LatencyPrediction {
    let mut request_size = profile().request_size;
    request_size.max_output_tokens = request_size.max_output_tokens.max(visible);
    LatencyPrediction {
        version: 1,
        request_digest: buy().request_digest,
        backend_ref: "fixture/backend-1".into(),
        offering: offering(),
        request_size,
        output_estimate: OutputEstimate {
            billable_output_tokens: visible,
            visible_output_tokens: visible,
        },
        boundary: LatencyBoundary::MarketEndToEnd,
        estimated_ttft_ms: (visible > 0).then_some(ttft),
        estimated_tpot_ms: (visible > 1).then_some(tpot),
        load_ref: "fixture/load-1".into(),
        max_market_requests: 2,
        updated_at: NOW,
        valid_until: UnixMillis(1_500),
    }
}

#[test]
fn market_ttft_is_used_once_and_only_visible_decode_gaps_are_added() {
    let mut prediction = prediction(128, 1_000, 20);
    prediction.output_estimate.billable_output_tokens = 200;
    assert_eq!(
        estimated_e2e(&spec(), Some(&prediction), NOW),
        Ok(E2eEstimate::Millis(3_540))
    );
}

#[test]
fn zero_visible_output_has_no_speed_value_even_when_hidden_output_is_billable() {
    let mut prediction = prediction(0, 0, 0);
    prediction.output_estimate.billable_output_tokens = 200;
    assert_eq!(
        estimated_e2e(&spec(), Some(&prediction), NOW),
        Ok(E2eEstimate::NoVisibleOutput)
    );
    assert_eq!(
        estimated_base_charge(
            &spec(),
            prediction.request_size,
            prediction.output_estimate,
            prediction.offering.rates,
            CachedInputEstimate::Unknown
        ),
        Ok(MicroUsd(1_600))
    );
}

#[test]
fn one_visible_token_has_no_decode_gap_and_can_represent_maximum_ttft() {
    let prediction = prediction(1, u64::MAX, 0);
    assert_eq!(
        estimated_e2e(&spec(), Some(&prediction), NOW),
        Ok(E2eEstimate::Millis(u64::MAX))
    );
}

#[test]
fn an_earlier_first_token_can_finish_later_and_output_length_can_reverse_the_order() {
    for (visible, expected_a, expected_b) in [(10, 920, 1_180), (1_000, 80_120, 20_980)] {
        let a = prediction(visible, 200, 80);
        let b = prediction(visible, 1_000, 20);
        assert!(a.estimated_ttft_ms.unwrap() < b.estimated_ttft_ms.unwrap());
        let E2eEstimate::Millis(a_ms) = estimated_e2e(&spec(), Some(&a), NOW).unwrap() else {
            panic!("visible output")
        };
        let E2eEstimate::Millis(b_ms) = estimated_e2e(&spec(), Some(&b), NOW).unwrap() else {
            panic!("visible output")
        };
        assert_eq!((a_ms, b_ms), (expected_a, expected_b));
        assert_eq!(a_ms < b_ms, visible == 10);
    }
}

#[test]
fn missing_predictions_are_errors_rather_than_zero_or_inapplicable_results() {
    assert_eq!(
        estimated_e2e(&spec(), None, NOW),
        Err(LatencyError::MissingPrediction)
    );
}

#[test]
fn malformed_ttft_and_tpot_are_rejected_before_calculation() {
    for visible in [0, 1, 2] {
        let mut missing_or_extra_ttft = prediction(visible, 200, 20);
        missing_or_extra_ttft.estimated_ttft_ms = if visible == 0 { Some(0) } else { None };
        assert_eq!(
            estimated_e2e(&spec(), Some(&missing_or_extra_ttft), NOW),
            Err(LatencyError::Validation(
                ValidationError::InvalidLatencyApplicability
            ))
        );
        let mut missing_or_extra_tpot = prediction(visible, 200, 20);
        missing_or_extra_tpot.estimated_tpot_ms = if visible <= 1 { Some(0) } else { None };
        assert_eq!(
            estimated_e2e(&spec(), Some(&missing_or_extra_tpot), NOW),
            Err(LatencyError::Validation(
                ValidationError::InvalidLatencyApplicability
            ))
        );
    }
}

#[test]
fn stale_future_and_engine_only_predictions_cannot_produce_a_completion_time() {
    for visible in [0, 2] {
        let mut prediction = prediction(visible, 200, 20);
        assert!(estimated_e2e(&spec(), Some(&prediction), UnixMillis(1_499)).is_ok());
        assert_eq!(
            estimated_e2e(&spec(), Some(&prediction), UnixMillis(1_500)),
            Err(LatencyError::Validation(ValidationError::Expired))
        );
        prediction.valid_until = UnixMillis(2_000);
        assert_eq!(
            estimated_e2e(&spec(), Some(&prediction), UnixMillis(1_800)),
            Err(LatencyError::Validation(ValidationError::Expired))
        );
        prediction.updated_at = UnixMillis(NOW.0 + 1);
        assert_eq!(
            estimated_e2e(&spec(), Some(&prediction), NOW),
            Err(LatencyError::Validation(ValidationError::FutureObservation))
        );
        prediction.updated_at = NOW;
        prediction.boundary = LatencyBoundary::ProviderEngine;
        assert_eq!(
            estimated_e2e(&spec(), Some(&prediction), NOW),
            Err(LatencyError::Validation(
                ValidationError::MeasurementBoundaryMismatch
            ))
        );
    }
}

#[test]
fn invalid_market_binding_shape_and_output_are_not_hidden_by_arithmetic() {
    let mut prediction = prediction(2, 200, 20);
    prediction.offering.market_spec_ref.revision += 1;
    assert_eq!(
        estimated_e2e(&spec(), Some(&prediction), NOW),
        Err(LatencyError::Validation(
            ValidationError::MarketSpecMismatch
        ))
    );
    prediction.offering = offering();
    prediction.request_size.input_tokens = 4_000;
    assert_eq!(
        estimated_e2e(&spec(), Some(&prediction), NOW),
        Err(LatencyError::Validation(
            ValidationError::ContextWindowExceeded
        ))
    );
    prediction.request_size = buy().request_size;
    prediction.output_estimate.billable_output_tokens = 1;
    assert_eq!(
        estimated_e2e(&spec(), Some(&prediction), NOW),
        Err(LatencyError::Validation(
            ValidationError::VisibleOutputExceedsBillableOutput
        ))
    );
}

#[test]
fn multiplication_and_addition_overflow_are_reported_without_saturation() {
    for prediction in [prediction(3, 0, u64::MAX), prediction(2, u64::MAX, 1)] {
        assert_eq!(
            estimated_e2e(&spec(), Some(&prediction), NOW),
            Err(LatencyError::DurationOverflow)
        );
    }
    let maximum = prediction(3, 1, u64::MAX / 2);
    assert_eq!(
        estimated_e2e(&spec(), Some(&maximum), NOW),
        Ok(E2eEstimate::Millis(u64::MAX))
    );
}

#[test]
fn zero_duration_is_a_valid_supplied_value_distinct_from_missing_data() {
    let prediction = prediction(2, 0, 0);
    assert_eq!(
        estimated_e2e(&spec(), Some(&prediction), NOW),
        Ok(E2eEstimate::Millis(0))
    );
}

#[test]
fn replay_uses_the_explicit_comparison_time_without_changing_inputs() {
    let prediction = prediction(128, 200, 20);
    let before = prediction.clone();
    let first = estimated_e2e(&spec(), Some(&prediction), NOW);
    assert_eq!(first, Ok(E2eEstimate::Millis(2_740)));
    assert_eq!(estimated_e2e(&spec(), Some(&prediction), NOW), first);
    assert_eq!(prediction, before);
}
