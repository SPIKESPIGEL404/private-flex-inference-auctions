use bitrouter_market::order::*;
use bitrouter_market::throughput::*;

#[allow(dead_code)]
mod common;
use common::*;

const CHECK_AT: UnixMillis = UnixMillis(11_000);

fn evidence() -> ThroughputObservation {
    let mut offering = offering();
    offering.valid_until = UnixMillis(20_000);
    ThroughputObservation {
        offering,
        profile: profile(),
        started_at: NOW,
        ended_at: CHECK_AT,
        valid_until: UnixMillis(15_000),
        demand_sufficient: true,
        completed_requests: 20,
        failed_requests: 0,
        billable_output_tokens: 4_000,
        p95_e2e_ms: Some(500),
    }
}

fn assess(observation: &ThroughputObservation) -> Result<ThroughputVerification, ValidationError> {
    assess_throughput(
        &spec(),
        &observation.offering,
        &observation.profile,
        Some(observation),
        CHECK_AT,
    )
}

fn filter(observation: Option<&ThroughputObservation>) -> Result<bool, ValidationError> {
    let original = evidence();
    ThroughputFilter {
        minimum: original.offering.throughput.rate,
    }
    .matches(
        &spec(),
        &original.offering,
        &original.profile,
        observation,
        CHECK_AT,
    )
}

#[test]
fn fractional_rps_and_tps_are_compared_without_truncation_or_overflow() {
    let half_rps = ThroughputRate {
        output_tokens: 500,
        completed_requests: 1,
        interval_ms: 2_000,
    };
    assert!(half_rps
        .meets(ThroughputRate {
            output_tokens: 250,
            completed_requests: 1,
            interval_ms: 4_000,
        })
        .unwrap());
    assert!(!half_rps
        .meets(ThroughputRate {
            output_tokens: 250,
            completed_requests: 1,
            interval_ms: 1_000,
        })
        .unwrap());
    let maximum = ThroughputRate {
        output_tokens: u64::MAX,
        completed_requests: u64::MAX,
        interval_ms: u64::MAX,
    };
    assert!(maximum.meets(maximum).unwrap());
    assert_eq!(
        half_rps.meets(ThroughputRate {
            interval_ms: 0,
            ..half_rps
        }),
        Err(ValidationError::InvalidThroughputRate)
    );
}

#[test]
fn a_declaration_is_not_evidence_and_both_rates_must_be_supported() {
    let mut observation = evidence();
    assert_eq!(
        assess_throughput(
            &spec(),
            &observation.offering,
            &observation.profile,
            None,
            CHECK_AT
        ),
        Ok(ThroughputVerification::Unverified)
    );
    assert_eq!(filter(None), Ok(false));
    assert_eq!(assess(&observation), Ok(ThroughputVerification::Verified));
    assert_eq!(filter(Some(&observation)), Ok(true));
    // Adequate RPS does not compensate for inadequate TPS.
    observation.billable_output_tokens = 3_999;
    assert_eq!(
        assess(&observation),
        Ok(ThroughputVerification::Underperforming)
    );
    assert_eq!(filter(Some(&observation)), Ok(false));
    // Adequate TPS does not compensate for inadequate RPS.
    observation.completed_requests = 19;
    observation.billable_output_tokens = 4_000;
    assert_eq!(
        assess(&observation),
        Ok(ThroughputVerification::Underperforming)
    );
}

#[test]
fn low_demand_is_inconclusive_but_observed_target_delivery_can_pass() {
    let mut observation = evidence();
    observation.demand_sufficient = false;
    assert_eq!(assess(&observation), Ok(ThroughputVerification::Verified));
    observation.completed_requests = 10;
    observation.billable_output_tokens = 2_000;
    assert_eq!(
        assess(&observation),
        Ok(ThroughputVerification::InsufficientDemand)
    );
    assert_eq!(filter(Some(&observation)), Ok(false));
    observation.demand_sufficient = true;
    assert_eq!(
        assess(&observation),
        Ok(ThroughputVerification::Underperforming)
    );
}

#[test]
fn short_windows_and_small_samples_cannot_certify_capacity() {
    let mut observation = evidence();
    observation.profile.min_window_ms = 10_001;
    assert_eq!(
        assess(&observation),
        Ok(ThroughputVerification::InsufficientObservation)
    );
    observation.profile.min_window_ms = 10_000;
    observation.profile.min_sample_requests = 21;
    assert_eq!(
        assess(&observation),
        Ok(ThroughputVerification::InsufficientObservation)
    );
}

#[test]
fn high_throughput_does_not_hide_bad_latency_or_failed_requests() {
    let mut observation = evidence();
    observation.p95_e2e_ms = Some(501);
    assert_eq!(
        assess(&observation),
        Ok(ThroughputVerification::Underperforming)
    );
    observation.p95_e2e_ms = Some(500);
    observation.failed_requests = 1;
    assert_eq!(
        assess(&observation),
        Ok(ThroughputVerification::Underperforming)
    );
    observation.failed_requests = 0;
    assert_eq!(assess(&observation), Ok(ThroughputVerification::Verified));
    observation.completed_requests = 0;
    observation.billable_output_tokens = 0;
    observation.p95_e2e_ms = None;
    observation.failed_requests = 20;
    assert_eq!(
        assess(&observation),
        Ok(ThroughputVerification::Underperforming)
    );
}

#[test]
fn failure_threshold_uses_all_terminal_requests_and_an_inclusive_boundary() {
    let mut observation = evidence();
    observation.completed_requests = 99;
    observation.failed_requests = 1;
    observation.billable_output_tokens = 19_800;
    assert_eq!(assess(&observation), Ok(ThroughputVerification::Verified));
    observation.failed_requests = 2;
    assert_eq!(
        assess(&observation),
        Ok(ThroughputVerification::Underperforming)
    );
}

#[test]
fn evidence_cannot_be_reused_after_a_declaration_or_policy_change() {
    let observation = evidence();
    for changed in 0..5 {
        let mut offering = observation.offering.clone();
        match changed {
            0 => offering.update_seq += 1,
            1 => offering.generation += 1,
            2 => offering.id += 1,
            3 => offering.throughput.rate.output_tokens += 1,
            _ => offering.agent_config_ref.push_str("-new"),
        }
        assert_eq!(
            assess_throughput(
                &spec(),
                &offering,
                &observation.profile,
                Some(&observation),
                CHECK_AT
            ),
            Err(ValidationError::ThroughputObservationMismatch)
        );
    }
    let mut changed_profile = observation.profile.clone();
    changed_profile.max_p95_e2e_ms += 1;
    assert_eq!(
        assess_throughput(
            &spec(),
            &observation.offering,
            &changed_profile,
            Some(&observation),
            CHECK_AT
        ),
        Err(ValidationError::ThroughputObservationMismatch)
    );
}

#[test]
fn stale_future_and_impossible_measurements_cannot_pass() {
    let mut observation = evidence();
    observation.valid_until = CHECK_AT;
    assert_eq!(
        assess(&observation),
        Err(ValidationError::InvalidValidityWindow)
    );
    observation.valid_until = UnixMillis(15_000);
    assert_eq!(
        assess_throughput(
            &spec(),
            &observation.offering,
            &observation.profile,
            Some(&observation),
            UnixMillis(15_000)
        ),
        Err(ValidationError::Expired)
    );
    observation.ended_at = UnixMillis(CHECK_AT.0 + 1);
    assert_eq!(
        assess(&observation),
        Err(ValidationError::FutureObservation)
    );
    observation.ended_at = observation.started_at;
    assert_eq!(
        assess(&observation),
        Err(ValidationError::InvalidThroughputObservation)
    );
    observation.ended_at = CHECK_AT;
    observation.started_at = UnixMillis(NOW.0 - 1);
    assert_eq!(
        assess(&observation),
        Err(ValidationError::InvalidThroughputObservation)
    );
    observation.started_at = NOW;
    observation.billable_output_tokens = 20 * 256 + 1;
    assert_eq!(
        assess(&observation),
        Err(ValidationError::InvalidThroughputObservation)
    );
    observation.billable_output_tokens = 4_000;
    observation.p95_e2e_ms = None;
    assert_eq!(
        assess(&observation),
        Err(ValidationError::InvalidThroughputObservation)
    );
}

#[test]
fn profile_and_request_scope_are_enforced_without_extrapolation() {
    let mut offering = offering();
    offering.throughput.profile_ref = "other-workload".into();
    assert_eq!(
        offering.validate(&spec(), NOW),
        Err(ValidationError::ThroughputProfileMismatch)
    );
    let mut profile = profile();
    profile.cache_condition_ref.clear();
    assert_eq!(
        profile.validate(&spec()),
        Err(ValidationError::MissingField(
            "throughput_profile.cache_condition_ref"
        ))
    );
    profile.cache_condition_ref = "fixture/cold-cache-v1".into();
    profile.max_failure_bps = 10_000;
    assert_eq!(
        profile.validate(&spec()),
        Err(ValidationError::InvalidThroughputProfile)
    );
    profile.max_failure_bps = 100;
    let mut request = buy();
    request.request_size.input_tokens += 1;
    assert_eq!(
        profile.validate_workload(&spec(), request.request_size, request.output_estimate),
        Err(ValidationError::ThroughputWorkloadMismatch)
    );
    request = buy();
    request.market_spec_ref.market_id = "other-market".into();
    assert_eq!(
        spec().validate_reference(&request.market_spec_ref),
        Err(ValidationError::MarketSpecMismatch)
    );
}

#[test]
fn malformed_claims_and_policy_limits_are_rejected() {
    let mut offering = offering();
    offering.throughput.rate.interval_ms = 0;
    assert_eq!(
        offering.validate(&spec(), NOW),
        Err(ValidationError::InvalidThroughputRate)
    );
    offering.throughput.rate.interval_ms = 1_000;
    offering.throughput.rate.completed_requests = 0;
    assert_eq!(
        offering.validate(&spec(), NOW),
        Err(ValidationError::InvalidThroughputRate)
    );
    for invalid in 0..3 {
        let mut profile = profile();
        match invalid {
            0 => profile.min_window_ms = 0,
            1 => profile.min_sample_requests = 0,
            _ => profile.max_p95_e2e_ms = 0,
        }
        assert_eq!(
            profile.validate(&spec()),
            Err(ValidationError::InvalidThroughputProfile)
        );
    }
}

#[test]
fn zero_output_workloads_can_have_verified_positive_rps() {
    let mut observation = evidence();
    observation.profile.output_estimate = OutputEstimate {
        billable_output_tokens: 0,
        visible_output_tokens: 0,
    };
    observation.offering.throughput.rate.output_tokens = 0;
    observation.billable_output_tokens = 0;
    assert_eq!(assess(&observation), Ok(ThroughputVerification::Verified));
}

#[test]
fn filters_apply_thresholds_and_do_not_reopen_closed_supply() {
    let mut observation = evidence();
    let filter = ThroughputFilter {
        minimum: ThroughputRate {
            completed_requests: 3,
            ..observation.offering.throughput.rate
        },
    };
    assert_eq!(
        filter.matches(
            &spec(),
            &observation.offering,
            &observation.profile,
            Some(&observation),
            CHECK_AT
        ),
        Ok(false)
    );
    observation.offering.readiness = Readiness::NotReady;
    let any_verified = ThroughputFilter {
        minimum: ThroughputRate {
            output_tokens: 0,
            completed_requests: 0,
            interval_ms: 1_000,
        },
    };
    assert_eq!(
        any_verified.matches(
            &spec(),
            &observation.offering,
            &observation.profile,
            Some(&observation),
            CHECK_AT
        ),
        Ok(false)
    );
    observation.offering.readiness = Readiness::Ready;
    observation.offering.throughput.rate.output_tokens = 0;
    observation.offering.throughput.rate.completed_requests = 0;
    assert_eq!(
        any_verified.matches(
            &spec(),
            &observation.offering,
            &observation.profile,
            Some(&observation),
            CHECK_AT
        ),
        Ok(false)
    );
}
