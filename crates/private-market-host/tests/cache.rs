use bitrouter_market::cache::*;
use bitrouter_market::cost::{base_charge_cap, estimated_base_charge, CachedInputEstimate};
use bitrouter_market::order::*;

#[allow(dead_code)]
mod common;
use common::*;

fn request(tokens: &[TokenId]) -> TokenizedRequest {
    let mut buy = buy();
    buy.request_size = profile().request_size;
    buy.request_size.input_tokens = tokens.len() as u64;
    TokenizedRequest::from_request(&spec(), &buy.request(), tokens.to_vec()).unwrap()
}

fn scope(backend: &str) -> CacheScope {
    CacheScope {
        market_spec_ref: spec().reference,
        model_ref: spec().model_ref,
        agent_config_ref: offering().agent_config_ref,
        backend_ref: backend.into(),
        cache_domain_ref: "fixture/shared-domain-1".into(),
    }
}

fn observation() -> CacheObservation {
    CacheObservation {
        source: CacheSource::Observed,
        source_ref: "fixture/resident-prefixes-1".into(),
        observed_at: NOW,
        valid_until: UnixMillis(1_500),
        rules: CacheReuseRules {
            rule_ref: "fixture/token-granular-reused-billing-v1".into(),
            block_tokens: 1,
            billing: CacheBilling::ReusedInput,
        },
    }
}

fn index() -> CacheIndex {
    CacheIndex::new(&spec(), scope("A"), NOW).unwrap()
}

fn query(index: &CacheIndex, request: &TokenizedRequest, at: UnixMillis) -> CacheMatch {
    let snapshot = index.snapshot();
    match_prefix(&spec(), request, snapshot.scope(), &snapshot, at).unwrap()
}

fn counts(result: &CacheMatch) -> CacheCounts {
    match result.status() {
        CacheMatchStatus::Observed(counts) => counts,
        other => panic!("expected observed counts, got {other:?}"),
    }
}

#[test]
fn compressed_branches_handle_duplicates_shorter_prefixes_and_mid_edge_endings() {
    let mut index = index();
    index
        .replace(
            observation(),
            &[&[1, 2, 3, 4], &[1, 2, 9], &[1, 2], &[1, 2, 3, 4], &[2, 7]],
        )
        .unwrap();
    for (tokens, expected) in [
        (vec![1, 2, 3, 4], 4),
        (vec![1, 2, 9, 8], 3),
        (vec![1, 2, 3, 8], 3),
        (vec![1], 1),
        (vec![2, 7, 8], 2),
        (vec![9, 1, 2], 0),
        (vec![], 0),
    ] {
        assert_eq!(
            counts(&query(&index, &request(&tokens), NOW)).matched_prefix_tokens,
            expected
        );
    }
}

#[test]
fn radix_results_match_a_linear_prefix_oracle_over_2016_cases() {
    let pool: [&[TokenId]; 5] = [&[0], &[0, 0, 1], &[0, 1], &[1, 0], &[1, 1, 0]];
    let mut index = index();
    for mask in 0..32 {
        let prefixes: Vec<_> = pool
            .iter()
            .enumerate()
            .filter(|(n, _)| mask & (1 << n) != 0)
            .map(|(_, p)| *p)
            .collect();
        let mut observation = observation();
        observation.rules.block_tokens = mask % 4 + 1;
        index.replace(observation, &prefixes).unwrap();
        for len in 0..=5 {
            for bits in 0..(1 << len) {
                let tokens: Vec<_> = (0..len).map(|n| (bits >> n) & 1).collect();
                let expected = prefixes
                    .iter()
                    .map(|p| p.iter().zip(&tokens).take_while(|(a, b)| a == b).count())
                    .max()
                    .unwrap_or(0);
                let counts = counts(&query(&index, &request(&tokens), NOW));
                assert_eq!(counts.matched_prefix_tokens, expected as u64);
                assert!(counts.reusable_input_tokens <= counts.matched_prefix_tokens);
                assert!(counts.matched_prefix_tokens <= tokens.len() as u64);
                assert_eq!(
                    counts.estimated_billable_cached_input_tokens,
                    counts.reusable_input_tokens
                );
            }
        }
    }
}

#[test]
fn unknown_view_and_observed_empty_cache_remain_distinct() {
    let mut index = index();
    let request = request(&[1, 2, 3]);
    let unknown = query(&index, &request, NOW);
    assert_eq!(
        unknown.status(),
        CacheMatchStatus::Unknown(CacheUnknownReason::NoObservation)
    );
    assert_eq!(
        unknown.billable_cache_estimate(),
        CachedInputEstimate::Unknown
    );
    index.replace(observation(), &[]).unwrap();
    let empty = query(&index, &request, NOW);
    assert_eq!(
        counts(&empty),
        CacheCounts {
            matched_prefix_tokens: 0,
            reusable_input_tokens: 0,
            estimated_billable_cached_input_tokens: 0
        }
    );
    assert_eq!(
        empty.billable_cache_estimate(),
        CachedInputEstimate::Tokens(0)
    );
}

#[test]
fn two_backends_have_independent_hits_and_feed_the_existing_cost_functions() {
    let tokens: Vec<_> = (0..1_200).collect();
    let request = request(&tokens);
    let mut a = index();
    let mut b = CacheIndex::new(&spec(), scope("B"), NOW).unwrap();
    a.replace(observation(), &[&tokens[..1_024]]).unwrap();
    b.replace(observation(), &[&tokens[..512]]).unwrap();
    let rates = TokenRates {
        cache_input: 250_000,
        ..offering().rates
    };
    for (index, cached, charge) in [(&a, 1_024, 832), (&b, 512, 1_216)] {
        let result = query(index, &request, NOW);
        index
            .validate_match(&spec(), &request, &result, NOW)
            .unwrap();
        assert_eq!(counts(&result).reusable_input_tokens, cached);
        assert_eq!(
            estimated_base_charge(
                &spec(),
                request.request_size(),
                buy().output_estimate,
                rates,
                result.billable_cache_estimate()
            ),
            Ok(MicroUsd(charge))
        );
        assert_eq!(
            base_charge_cap(&spec(), request.request_size(), rates),
            Ok(MicroUsd(1_712))
        );
    }
}

#[test]
fn logical_match_physical_reuse_and_billing_are_separate_quantities() {
    let tokens: Vec<_> = (0..1_200).collect();
    let request = request(&tokens);
    let mut index = index();
    let mut observation = observation();
    observation.rules.block_tokens = 64;
    observation.rules.rule_ref = "fixture/whole-block-normal-billing-v1".into();
    observation.rules.billing = CacheBilling::AllUncached;
    index
        .replace(observation.clone(), &[&tokens[..1_030]])
        .unwrap();
    let old = query(&index, &request, NOW);
    assert_eq!(
        counts(&old),
        CacheCounts {
            matched_prefix_tokens: 1_030,
            reusable_input_tokens: 1_024,
            estimated_billable_cached_input_tokens: 0
        }
    );
    observation.rules.billing = CacheBilling::ReusedInput;
    observation.rules.rule_ref = "fixture/whole-block-reused-billing-v1".into();
    index.replace(observation, &[&tokens[..1_030]]).unwrap();
    assert_eq!(
        index.validate_match(&spec(), &request, &old, NOW),
        Err(CacheError::StaleMatch)
    );
    assert_eq!(
        counts(&query(&index, &request, NOW)).estimated_billable_cached_input_tokens,
        1_024
    );
}

#[test]
fn backend_configuration_domain_model_and_market_do_not_cross_match() {
    let mut index = index();
    index.replace(observation(), &[&[1, 2, 3]]).unwrap();
    let snapshot = index.snapshot();
    let request = request(&[1, 2, 3]);
    for change in 0..5 {
        let mut wrong = scope("A");
        let expected = match change {
            0 => {
                wrong.backend_ref = "B".into();
                CacheError::ScopeMismatch
            }
            1 => {
                wrong.agent_config_ref.push_str("-other");
                CacheError::ScopeMismatch
            }
            2 => {
                wrong.cache_domain_ref.push_str("-private");
                CacheError::ScopeMismatch
            }
            3 => {
                wrong.model_ref.push_str("-other");
                CacheError::ScopeMismatch
            }
            _ => {
                wrong.market_spec_ref.revision += 1;
                CacheError::Validation(ValidationError::MarketSpecMismatch)
            }
        };
        assert_eq!(
            match_prefix(&spec(), &request, &wrong, &snapshot, NOW),
            Err(expected)
        );
    }
    let mut changed_spec = spec();
    changed_spec
        .metering
        .output_metering_ref
        .push_str("-changed-without-revision");
    assert_eq!(
        match_prefix(&changed_spec, &request, snapshot.scope(), &snapshot, NOW),
        Err(CacheError::Validation(ValidationError::MarketSpecMismatch))
    );
}

#[test]
fn speculative_pending_prefixes_do_not_become_observed_until_a_new_observation() {
    let mut a = index();
    let mut b = CacheIndex::new(&spec(), scope("B"), NOW).unwrap();
    let request = request(&[1, 2, 3]);
    let mut speculative = observation();
    speculative.source = CacheSource::Speculative;
    a.replace(speculative, &[request.token_ids()]).unwrap();
    b.replace(observation(), &[]).unwrap();
    let before = query(&a, &request, NOW);
    assert_eq!(
        before.status(),
        CacheMatchStatus::Unknown(CacheUnknownReason::Speculative)
    );
    assert_eq!(
        before.billable_cache_estimate(),
        CachedInputEstimate::Unknown
    );
    assert_eq!(query(&a, &request, NOW), before);
    a.replace(observation(), &[request.token_ids()]).unwrap();
    assert_eq!(counts(&query(&a, &request, NOW)).reusable_input_tokens, 3);
    assert_eq!(counts(&query(&b, &request, NOW)).reusable_input_tokens, 0);
}

#[test]
fn exclusive_expiry_returns_unknown_and_invalidates_a_previously_observed_match() {
    let mut index = index();
    let request = request(&[1, 2]);
    index
        .replace(observation(), &[request.token_ids()])
        .unwrap();
    let original = query(&index, &request, NOW);
    index
        .validate_match(&spec(), &request, &original, UnixMillis(1_499))
        .unwrap();
    let expired = query(&index, &request, UnixMillis(1_500));
    assert_eq!(
        expired.status(),
        CacheMatchStatus::Unknown(CacheUnknownReason::Expired)
    );
    assert_eq!(
        expired.billable_cache_estimate(),
        CachedInputEstimate::Unknown
    );
    assert_eq!(
        index.validate_match(&spec(), &request, &original, UnixMillis(1_500)),
        Err(CacheError::StaleMatch)
    );
    assert_eq!(
        match_prefix(
            &spec(),
            &request,
            original.snapshot().scope(),
            original.snapshot(),
            UnixMillis(999)
        ),
        Err(CacheError::Validation(ValidationError::FutureObservation))
    );
}

#[test]
fn eviction_invalidates_live_matches_but_frozen_snapshots_still_replay() {
    let mut index = index();
    let request = request(&[1, 2, 3]);
    index
        .replace(observation(), &[request.token_ids()])
        .unwrap();
    let original = query(&index, &request, NOW);
    let frozen = index.snapshot();
    index.replace(observation(), &[]).unwrap();
    assert_eq!(
        index.validate_match(&spec(), &request, &original, NOW),
        Err(CacheError::StaleMatch)
    );
    assert_eq!(
        counts(&query(&index, &request, NOW)).matched_prefix_tokens,
        0
    );
    assert_eq!(
        match_prefix(&spec(), &request, frozen.scope(), &frozen, NOW),
        Ok(original)
    );
}

#[test]
fn complete_replacement_removes_old_branches_instead_of_refreshing_their_age() {
    let mut index = index();
    index
        .replace(observation(), &[&[1, 2, 3], &[1, 9, 8]])
        .unwrap();
    let mut fresh = observation();
    fresh.observed_at = UnixMillis(1_100);
    fresh.valid_until = UnixMillis(1_600);
    index.replace(fresh, &[&[1, 9, 8]]).unwrap();
    assert_eq!(
        counts(&query(&index, &request(&[1, 2, 3]), UnixMillis(1_100))).matched_prefix_tokens,
        1
    );
    assert_eq!(
        counts(&query(&index, &request(&[1, 9, 8]), UnixMillis(1_100))).matched_prefix_tokens,
        3
    );
}

#[test]
fn invalidation_and_restart_preserve_history_and_advance_versions() {
    let mut index = index();
    let request = request(&[1, 2]);
    index
        .replace(observation(), &[request.token_ids()])
        .unwrap();
    let result = query(&index, &request, NOW);
    index.invalidate(UnixMillis(1_001)).unwrap();
    assert_eq!(
        query(&index, &request, UnixMillis(1_001)).status(),
        CacheMatchStatus::Unknown(CacheUnknownReason::NoObservation)
    );
    assert_eq!(
        index.validate_match(&spec(), &request, &result, UnixMillis(1_001)),
        Err(CacheError::StaleMatch)
    );
    let old = index.snapshot();
    index.restart(UnixMillis(1_001)).unwrap();
    assert_eq!(
        index.snapshot().version(),
        CacheVersion {
            generation: old.version().generation + 1,
            update_seq: 0
        }
    );
    assert_eq!(
        query(&index, &request, UnixMillis(1_001)).status(),
        CacheMatchStatus::Unknown(CacheUnknownReason::NoObservation)
    );
    assert_eq!(
        match_prefix(
            &spec(),
            &request,
            result.snapshot().scope(),
            result.snapshot(),
            NOW
        ),
        Ok(result)
    );
}

#[test]
fn exact_token_binding_rejects_reused_digests_and_changed_request_records() {
    let mut index = index();
    let original = request(&[1, 2, 3]);
    index
        .replace(observation(), &[original.token_ids()])
        .unwrap();
    let result = query(&index, &original, NOW);
    let other = request(&[1, 9, 3]);
    assert_eq!(original.request_digest(), other.request_digest());
    assert_eq!(
        index.validate_match(&spec(), &other, &result, NOW),
        Err(CacheError::RequestMismatch)
    );
    let mut buy = buy();
    buy.request_size = original.request_size();
    original.validate_request(&spec(), &buy.request()).unwrap();
    buy.request_digest.push_str("-changed");
    assert_eq!(
        original.validate_request(&spec(), &buy.request()),
        Err(CacheError::RequestMismatch)
    );
}

#[test]
fn identical_version_numbers_cannot_hide_different_snapshot_contents() {
    let mut a = index();
    let mut b = index();
    let request = request(&[1, 2, 3]);
    a.replace(observation(), &[&[1, 2, 3]]).unwrap();
    b.replace(observation(), &[&[1, 9, 3]]).unwrap();
    assert_eq!(a.snapshot().version(), b.snapshot().version());
    assert_eq!(
        b.validate_match(&spec(), &request, &query(&a, &request, NOW), NOW),
        Err(CacheError::StaleMatch)
    );
}

#[test]
fn malformed_and_out_of_order_updates_fail_without_mutating_the_view() {
    let mut index = index();
    index.replace(observation(), &[&[1, 2]]).unwrap();
    let original = index.snapshot();
    for change in 0..4 {
        let mut malformed = observation();
        match change {
            0 => malformed.rules.block_tokens = 0,
            1 => malformed.valid_until = NOW,
            2 => malformed.source_ref.clear(),
            _ => malformed.observed_at = UnixMillis(NOW.0 - 1),
        }
        assert!(index.replace(malformed, &[]).is_err());
        assert_eq!(index.snapshot(), original);
    }
    assert_eq!(
        index.invalidate(UnixMillis(999)),
        Err(CacheError::OutOfOrderObservation)
    );
    assert_eq!(
        index.restart(UnixMillis(999)),
        Err(CacheError::OutOfOrderObservation)
    );
    assert_eq!(index.snapshot(), original);
}

#[test]
fn request_lengths_scope_fields_and_large_block_sizes_are_checked() {
    assert_eq!(
        TokenizedRequest::from_request(&spec(), &buy().request(), vec![1]),
        Err(CacheError::TokenCountMismatch)
    );
    let mut bad = scope("A");
    bad.cache_domain_ref.clear();
    assert!(CacheIndex::new(&spec(), bad, NOW).is_err());
    let mut index = index();
    let mut observation = observation();
    observation.rules.block_tokens = u64::MAX;
    index.replace(observation, &[&[1, 2]]).unwrap();
    assert_eq!(
        counts(&query(&index, &request(&[1, 2]), NOW)).reusable_input_tokens,
        0
    );
}

#[test]
fn insertion_order_does_not_change_snapshot_representation_or_query_results() {
    let mut a = index();
    let mut b = index();
    a.replace(observation(), &[&[1, 2, 3], &[1, 2], &[1, 9], &[2, 3]])
        .unwrap();
    b.replace(observation(), &[&[2, 3], &[1, 9], &[1, 2], &[1, 2, 3]])
        .unwrap();
    assert_eq!(a.snapshot(), b.snapshot());
    let request = request(&[1, 2, 3, 4]);
    assert_eq!(query(&a, &request, NOW), query(&b, &request, NOW));
    // Redundant shorter paths must not create uncompressed single-child nodes.
    a.replace(observation(), &[&[1], &[1, 2], &[1, 2, 3]])
        .unwrap();
    b.replace(observation(), &[&[1, 2, 3]]).unwrap();
    assert_eq!(a.snapshot(), b.snapshot());
}
