#[allow(dead_code)]
mod common;
#[allow(dead_code)]
#[path = "support/conditional_exchange.rs"]
mod fx;
use bitrouter_market::order::*;
use bitrouter_market::seller_service::*;

fn schedule() -> SellerServiceSchedule {
    let spec = fx::spec("a");
    let ask = fx::sell("seller", &["a"]).options.remove(0).ask;
    SellerServiceSchedule {
        version: SERVICE_VERSION,
        rules_ref: SERVICE_RULES_REF.into(),
        reference: "service/a".into(),
        revision: 1,
        provider_id: ask.provider_id,
        market_spec_ref: spec.reference,
        model_ref: spec.model_ref,
        request_protocol_ref: spec.request_protocol_ref,
        numerical_rules_ref: spec.metering.numerical_rules_ref,
        output_metering_ref: spec.metering.output_metering_ref,
        rates: ask.rates,
        bins: vec![bin("small", 0, 10, 1, 20), bin("large", 11, 100, 1, 100)],
    }
}
fn bin(id: &str, imin: u64, imax: u64, omin: u64, omax: u64) -> ServiceBin {
    ServiceBin {
        hard_delivery_within_ms: 60_000,
        bin_id: id.into(),
        input_tokens: TokenRange {
            min_inclusive: imin,
            max_inclusive: imax,
        },
        max_billable_output_tokens: TokenRange {
            min_inclusive: omin,
            max_inclusive: omax,
        },
        delivery: DeliveryConditions::PerformanceTarget {
            first_response_within_ms: 100,
            complete_within_ms: 1_000,
        },
    }
}
fn size(input: u64, output: u64) -> RequestSize {
    RequestSize {
        input_tokens: input,
        max_output_tokens: output,
    }
}
fn validate(s: &SellerServiceSchedule) -> Result<(), ServiceError> {
    s.validate(
        &fx::spec("a"),
        &fx::sell("seller", &["a"]).options.remove(0).ask,
    )
}

#[test]
fn inclusive_boundaries_and_full_output_authorization_choose_one_whole_bin() {
    let s = schedule();
    validate(&s).unwrap();
    for (input, output, expected) in [
        (0, 1, "small"),
        (10, 20, "small"),
        (11, 20, "large"),
        (100, 100, "large"),
    ] {
        let frozen = s.freeze(size(input, output)).unwrap();
        assert_eq!(frozen.bin.bin_id, expected);
        assert_eq!(frozen.rates, s.rates);
        frozen.validate_for(size(input, output)).unwrap();
    }
    for request in [size(10, 21), size(10, 0), size(101, 1)] {
        assert_eq!(s.freeze(request), Err(ServiceError::OutsideService));
    }
    // The estimate of 2 tokens cannot select the small bin for a 21-token
    // authorization. No estimate is accepted by this API.
    assert!(s.freeze(size(10, 2)).is_ok());
    assert!(s.freeze(size(10, 21)).is_err());
}

#[test]
fn overlapping_rectangles_rejected_but_disjoint_output_bins_allowed() {
    let mut s = schedule();
    s.bins[1].input_tokens.min_inclusive = 10;
    assert_eq!(validate(&s), Err(ServiceError::OverlappingBins));
    s.bins[1].max_billable_output_tokens.min_inclusive = 21;
    validate(&s).unwrap();
    assert_eq!(s.freeze(size(10, 21)).unwrap().bin.bin_id, "large");
    assert_eq!(s.freeze(size(10, 20)).unwrap().bin.bin_id, "small");
    s.bins.reverse();
    assert_eq!(s.freeze(size(10, 21)).unwrap().bin.bin_id, "large");
}

#[test]
fn bins_are_bounded_unique_and_checked_after_json_decode() {
    let base = schedule();
    let mut bad = base.clone();
    bad.bins.clear();
    assert_eq!(validate(&bad), Err(ServiceError::BinCount));
    bad.bins = vec![base.bins[0].clone(); MAX_SERVICE_BINS + 1];
    assert_eq!(validate(&bad), Err(ServiceError::BinCount));
    bad = base.clone();
    bad.bins[1].bin_id = "small".into();
    assert_eq!(validate(&bad), Err(ServiceError::DuplicateBin));
    bad = base;
    bad.bins[0].input_tokens.min_inclusive = 11;
    let decoded: SellerServiceSchedule =
        serde_json::from_slice(&serde_json::to_vec(&bad).unwrap()).unwrap();
    assert_eq!(validate(&decoded), Err(ServiceError::InvalidRange));
    assert_eq!(decoded.freeze(size(10, 1)), Err(ServiceError::InvalidRange));
}

#[test]
fn registered_model_tokenizer_protocol_metering_rates_and_owner_are_exact() {
    let s = schedule();
    let mut variants = vec![];
    let mut b = s.clone();
    b.model_ref.push_str("-other-tokenizer");
    variants.push(b);
    let mut b = s.clone();
    b.request_protocol_ref.push_str("-other-feature");
    variants.push(b);
    let mut b = s.clone();
    b.market_spec_ref.revision += 1;
    variants.push(b);
    let mut b = s.clone();
    b.numerical_rules_ref.push_str("-other-rounding");
    variants.push(b);
    let mut b = s.clone();
    b.output_metering_ref.push_str("-other-hidden-output");
    variants.push(b);
    let mut b = s.clone();
    b.rates.output += 1;
    variants.push(b);
    let mut b = s;
    b.provider_id += 1;
    variants.push(b);
    for b in variants {
        assert_eq!(validate(&b), Err(ServiceError::Binding));
    }
}

#[test]
fn unknown_rules_revisions_fields_and_hard_sla_are_not_silently_accepted() {
    let s = schedule();
    let mut b = s.clone();
    b.version += 1;
    assert_eq!(validate(&b), Err(ServiceError::UnsupportedVersion));
    b = s.clone();
    b.rules_ref.push_str("-unknown");
    assert_eq!(validate(&b), Err(ServiceError::UnsupportedVersion));
    b = s.clone();
    b.revision = 0;
    assert_eq!(validate(&b), Err(ServiceError::Binding));
    b = s.clone();
    b.reference = " ".into();
    assert_eq!(validate(&b), Err(ServiceError::InvalidReference));
    let mut json = serde_json::to_value(&s).unwrap();
    json["bins"][0]["delivery"]["kind"] = "hard_deadline".into();
    assert!(serde_json::from_value::<SellerServiceSchedule>(json).is_err());
    let mut json = serde_json::to_value(&s).unwrap();
    json["bins"][0]["delivery"]["compensation"] = 100.into();
    assert!(serde_json::from_value::<SellerServiceSchedule>(json).is_err());
}

#[test]
fn target_clock_starts_at_acceptance_and_checks_overflow() {
    let s = schedule();
    let frozen = s.freeze(size(10, 1)).unwrap();
    assert_eq!(
        frozen.targets_after(UnixMillis(5_000)).unwrap(),
        DeliveryTargets {
            first_response_target_at: UnixMillis(5_100),
            completion_target_at: UnixMillis(6_000),
        }
    );
    assert_eq!(
        frozen.targets_after(UnixMillis(u64::MAX - 999)),
        Err(ServiceError::TimeOverflow)
    );
    assert_eq!(
        frozen
            .targets_after(UnixMillis(u64::MAX - 1_000))
            .unwrap()
            .completion_target_at,
        UnixMillis(u64::MAX)
    );
    for (first, complete) in [(0, 0), (10, 9)] {
        let mut b = s.clone();
        b.bins[0].delivery = DeliveryConditions::PerformanceTarget {
            first_response_within_ms: first,
            complete_within_ms: complete,
        };
        assert_eq!(validate(&b), Err(ServiceError::InvalidTargets));
    }
}

#[test]
fn selected_terms_revalidate_decoded_fields_and_revision_changes_binding() {
    let s = schedule();
    let f = s.freeze(size(10, 1)).unwrap();
    let mut next = s.clone();
    next.revision += 1;
    assert_ne!(f.schedule, next.freeze(size(10, 1)).unwrap().schedule);
    let mut b = f.clone();
    b.bin.max_billable_output_tokens.min_inclusive = 2;
    assert_eq!(
        b.validate_for(size(10, 1)),
        Err(ServiceError::OutsideService)
    );
    b = f.clone();
    b.schedule.sha256 = "0".into();
    assert_eq!(b.validate_for(size(10, 1)), Err(ServiceError::Binding));
    b = f;
    b.version += 1;
    assert_eq!(
        b.validate_for(size(10, 1)),
        Err(ServiceError::UnsupportedVersion)
    );
}

#[test]
fn hard_delivery_is_explicit_bounded_and_checked_for_absolute_time_overflow(
) -> Result<(), Box<dyn std::error::Error>> {
    let mut s = schedule();
    for duration in [0, MAX_HARD_DELIVERY_MS + 1] {
        s.bins[0].hard_delivery_within_ms = duration;
        assert!(validate(&s).is_err());
    }
    s.bins[0].hard_delivery_within_ms = MAX_HARD_DELIVERY_MS;
    assert!(validate(&s).is_ok());
    let frozen = s.freeze(size(1, 1))?;
    assert!(frozen.deadline_after(UnixMillis(u64::MAX)).is_err());
    assert_eq!(
        frozen.deadline_after(UnixMillis(100))?,
        UnixMillis(100 + MAX_HARD_DELIVERY_MS)
    );
    let mut missing = serde_json::to_value(&s)?;
    missing["bins"][0]
        .as_object_mut()
        .ok_or("bin missing")?
        .remove("hard_delivery_within_ms");
    assert!(serde_json::from_value::<SellerServiceSchedule>(missing).is_err());
    Ok(())
}
