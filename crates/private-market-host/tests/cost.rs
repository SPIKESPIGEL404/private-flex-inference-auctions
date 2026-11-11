use bitrouter_market::cost::{
    actual_base_charge, base_charge_cap, estimated_base_charge, CachedInputEstimate, CostError,
};
use bitrouter_market::order::*;

#[allow(dead_code)]
mod common;
use common::*;

fn rates() -> TokenRates {
    TokenRates {
        cache_input: 250_000,
        ..offering().rates
    }
}

#[test]
fn documented_request_separates_forecast_authorization_and_observed_usage() {
    let request = profile().request_size;
    let output = buy().output_estimate;
    assert_eq!(
        estimated_base_charge(
            &spec(),
            request,
            output,
            rates(),
            CachedInputEstimate::Tokens(1_024)
        ),
        Ok(MicroUsd(832))
    );
    assert_eq!(
        estimated_base_charge(
            &spec(),
            request,
            output,
            rates(),
            CachedInputEstimate::Tokens(0)
        ),
        Ok(MicroUsd(1_600))
    );
    assert_eq!(
        base_charge_cap(&spec(), request, rates()),
        Ok(MicroUsd(1_712))
    );
    assert_eq!(
        actual_base_charge(
            &spec(),
            request,
            TokenUsage {
                uncached_input_tokens: 800,
                cached_input_tokens: 400,
                billable_output_tokens: 180,
            },
            rates()
        ),
        Ok(MicroUsd(1_260))
    );
}

#[test]
fn unknown_cache_is_an_explicit_uncached_forecast_and_does_not_reduce_the_cap() {
    let buy = buy();
    let forecast = estimated_base_charge(
        &spec(),
        buy.request_size,
        buy.output_estimate,
        rates(),
        CachedInputEstimate::Unknown,
    )
    .unwrap();
    assert_eq!(forecast, MicroUsd(1_600));
    let expensive_cache = TokenRates {
        cache_input: 2_000_000,
        ..rates()
    };
    assert_eq!(
        estimated_base_charge(
            &spec(),
            buy.request_size,
            buy.output_estimate,
            expensive_cache,
            CachedInputEstimate::Unknown
        ),
        Ok(forecast)
    );
    assert_eq!(
        base_charge_cap(&spec(), buy.request_size, expensive_cache),
        Ok(MicroUsd(2_912))
    );
}

#[test]
fn forecast_below_budget_cannot_substitute_for_an_affordable_cap() {
    let buy = buy();
    let forecast = estimated_base_charge(
        &spec(),
        buy.request_size,
        buy.output_estimate,
        rates(),
        CachedInputEstimate::Tokens(1_024),
    )
    .unwrap();
    let cap = base_charge_cap(&spec(), buy.request_size, rates()).unwrap();
    assert!(forecast <= MicroUsd(1_000));
    assert!(cap > MicroUsd(1_000));
}

#[test]
fn all_categories_are_summed_before_one_upward_rounding() {
    let request = RequestSize {
        input_tokens: 2,
        max_output_tokens: 1,
    };
    let rates = TokenRates {
        input: 400_000,
        cache_input: 400_000,
        output: 400_000,
    };
    let usage = TokenUsage {
        uncached_input_tokens: 1,
        cached_input_tokens: 1,
        billable_output_tokens: 1,
    };
    // Three fractional charges of 0.4 sum to 1.2, rounded to 2, rather than 3.
    assert_eq!(
        actual_base_charge(&spec(), request, usage, rates),
        Ok(MicroUsd(2))
    );
    assert_eq!(
        estimated_base_charge(
            &spec(),
            request,
            OutputEstimate {
                billable_output_tokens: 1,
                visible_output_tokens: 1,
            },
            rates,
            CachedInputEstimate::Tokens(1)
        ),
        Ok(MicroUsd(2))
    );
    assert_eq!(base_charge_cap(&spec(), request, rates), Ok(MicroUsd(2)));
}

#[test]
fn exact_and_fractional_micro_usd_boundaries_have_no_minimum_fee() {
    let request = RequestSize {
        input_tokens: 1,
        max_output_tokens: 0,
    };
    for (rate, expected) in [(0, 0), (1, 1), (999_999, 1), (1_000_000, 1), (1_000_001, 2)] {
        let rates = TokenRates {
            input: rate,
            cache_input: rate,
            output: 0,
        };
        assert_eq!(
            base_charge_cap(&spec(), request, rates),
            Ok(MicroUsd(expected))
        );
    }
    let zero = RequestSize {
        input_tokens: 0,
        max_output_tokens: 0,
    };
    assert_eq!(
        actual_base_charge(
            &spec(),
            zero,
            TokenUsage {
                uncached_input_tokens: 0,
                cached_input_tokens: 0,
                billable_output_tokens: 0,
            },
            rates()
        ),
        Ok(MicroUsd(0))
    );
}

#[test]
fn output_forecast_never_replaces_the_full_authorization_in_the_cap() {
    let buy = buy();
    let short = OutputEstimate {
        billable_output_tokens: 1,
        visible_output_tokens: 1,
    };
    assert_eq!(
        estimated_base_charge(
            &spec(),
            buy.request_size,
            short,
            rates(),
            CachedInputEstimate::Tokens(1_024)
        ),
        Ok(MicroUsd(434))
    );
    assert_eq!(
        base_charge_cap(&spec(), buy.request_size, rates()),
        Ok(MicroUsd(1_712))
    );
    assert_eq!(buy.request_size.max_output_tokens, 256);
}

#[test]
fn hidden_billable_output_is_charged_even_without_visible_output() {
    let buy = buy();
    for visible in [0, 1, 128] {
        let output = OutputEstimate {
            visible_output_tokens: visible,
            ..buy.output_estimate
        };
        assert_eq!(
            estimated_base_charge(
                &spec(),
                buy.request_size,
                output,
                rates(),
                CachedInputEstimate::Tokens(1_024)
            ),
            Ok(MicroUsd(832))
        );
    }
}

#[test]
fn invalid_estimates_are_rejected_without_clamping() {
    let buy = buy();
    assert_eq!(
        estimated_base_charge(
            &spec(),
            buy.request_size,
            buy.output_estimate,
            rates(),
            CachedInputEstimate::Tokens(1_201)
        ),
        Err(CostError::CachedInputExceedsRequest)
    );
    for (output, error) in [
        (
            OutputEstimate {
                billable_output_tokens: 257,
                visible_output_tokens: 128,
            },
            ValidationError::OutputEstimateExceedsAuthorization,
        ),
        (
            OutputEstimate {
                billable_output_tokens: 1,
                visible_output_tokens: 2,
            },
            ValidationError::VisibleOutputExceedsBillableOutput,
        ),
    ] {
        assert_eq!(
            estimated_base_charge(
                &spec(),
                buy.request_size,
                output,
                rates(),
                CachedInputEstimate::Unknown
            ),
            Err(CostError::Validation(error))
        );
    }
}

#[test]
fn actual_usage_requires_complete_input_and_authorized_output() {
    let buy = buy();
    for (uncached, cached, output, error) in [
        (800, 399, 180, ValidationError::InputUsageMismatch),
        (
            800,
            400,
            257,
            ValidationError::UsageExceedsOutputAuthorization,
        ),
        (u64::MAX, 1, 0, ValidationError::TokenCountOverflow),
    ] {
        assert_eq!(
            actual_base_charge(
                &spec(),
                buy.request_size,
                TokenUsage {
                    uncached_input_tokens: uncached,
                    cached_input_tokens: cached,
                    billable_output_tokens: output,
                },
                rates()
            ),
            Err(CostError::Validation(error))
        );
    }
}

#[test]
fn unsupported_numerical_versions_cannot_fall_back_to_current_arithmetic() {
    let buy = buy();
    let mut spec = spec();
    spec.metering.numerical_rules_ref = "unknown-or-future-version".into();
    assert_eq!(
        estimated_base_charge(
            &spec,
            buy.request_size,
            buy.output_estimate,
            rates(),
            CachedInputEstimate::Unknown
        ),
        Err(CostError::UnsupportedNumericalRules)
    );
    assert_eq!(
        base_charge_cap(&spec, buy.request_size, rates()),
        Err(CostError::UnsupportedNumericalRules)
    );
    assert_eq!(
        actual_base_charge(
            &spec,
            buy.request_size,
            TokenUsage {
                uncached_input_tokens: 1_200,
                cached_input_tokens: 0,
                billable_output_tokens: 0,
            },
            rates()
        ),
        Err(CostError::UnsupportedNumericalRules)
    );
}

#[test]
fn all_public_cost_functions_check_market_request_limits() {
    let buy = buy();
    let request = RequestSize {
        input_tokens: 4_000,
        ..buy.request_size
    };
    let error = Err(CostError::Validation(
        ValidationError::ContextWindowExceeded,
    ));
    assert_eq!(
        estimated_base_charge(
            &spec(),
            request,
            buy.output_estimate,
            rates(),
            CachedInputEstimate::Unknown
        ),
        error
    );
    assert_eq!(base_charge_cap(&spec(), request, rates()), error);
    assert_eq!(
        actual_base_charge(
            &spec(),
            request,
            TokenUsage {
                uncached_input_tokens: 4_000,
                cached_input_tokens: 0,
                billable_output_tokens: 0,
            },
            rates()
        ),
        error
    );
}

#[test]
fn wide_intermediates_support_maximum_amount_and_reject_one_rate_step_beyond_it() {
    let mut spec = spec();
    spec.request_limits = RequestLimits {
        context_window_tokens: u64::MAX,
        max_output_tokens: u64::MAX,
    };
    let request = RequestSize {
        input_tokens: u64::MAX,
        max_output_tokens: 0,
    };
    let usage = TokenUsage {
        uncached_input_tokens: u64::MAX,
        cached_input_tokens: 0,
        billable_output_tokens: 0,
    };
    let output = OutputEstimate {
        billable_output_tokens: 0,
        visible_output_tokens: 0,
    };
    for (input, result) in [
        (1_000_000, Ok(MicroUsd(u64::MAX))),
        (1_000_001, Err(CostError::AmountOverflow)),
    ] {
        let rates = TokenRates {
            input,
            cache_input: 0,
            output: 0,
        };
        assert_eq!(
            estimated_base_charge(&spec, request, output, rates, CachedInputEstimate::Unknown),
            result
        );
        assert_eq!(base_charge_cap(&spec, request, rates), result);
        assert_eq!(actual_base_charge(&spec, request, usage, rates), result);
    }
}

#[test]
fn cap_bounds_every_input_split_and_authorized_output_in_a_small_exhaustive_grid() {
    for (input, cache, output) in [
        (0, 0, 0),
        (1, 2, 3),
        (1_000_000, 250_000, 2_000_000),
        (250_000, 1_000_000, 1),
    ] {
        let rates = TokenRates {
            input,
            cache_input: cache,
            output,
        };
        for input_tokens in 0..=8 {
            let request = RequestSize {
                input_tokens,
                max_output_tokens: 5,
            };
            let cap = base_charge_cap(&spec(), request, rates).unwrap();
            for cached in 0..=input_tokens {
                for output in 0..=5 {
                    let usage = TokenUsage {
                        uncached_input_tokens: input_tokens - cached,
                        cached_input_tokens: cached,
                        billable_output_tokens: output,
                    };
                    let actual = actual_base_charge(&spec(), request, usage, rates).unwrap();
                    let estimated = estimated_base_charge(
                        &spec(),
                        request,
                        OutputEstimate {
                            billable_output_tokens: output,
                            visible_output_tokens: output,
                        },
                        rates,
                        CachedInputEstimate::Tokens(cached),
                    )
                    .unwrap();
                    assert!(actual <= cap);
                    assert_eq!(estimated, actual);
                }
            }
        }
    }
}
