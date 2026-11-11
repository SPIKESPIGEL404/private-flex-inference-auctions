use bitrouter_market::formal_order::PlaceFormalOrder;
#[allow(dead_code)]
mod common;
#[allow(dead_code)]
#[path = "support/frozen_fixture.rs"]
mod fixture;
#[allow(dead_code)]
#[path = "support/conditional_exchange.rs"]
mod fx;
#[allow(dead_code)]
#[path = "support/purchase_fixture.rs"]
mod pf;
#[allow(dead_code)]
#[path = "support/seller_fixture.rs"]
mod sf;
use bitrouter_market::{
    exchange::*, execution_contract::*, formal_order::*, market_host::MarketHost,
};

fn predict(
    h: &MarketHost,
    p: &PlaceFormalOrder,
    option: u32,
    label: &str,
    ttft: u64,
) -> PurchaseQuotePublication {
    use bitrouter_market::{cache::*, quote::*};
    let mut q = pf::publication(h, &p.clone(), option, label);
    let context = q.quote.context().clone();
    let mut input = q.quote.input().clone();
    let request = q.quote.terms().request();
    input.prediction = Some(CandidatePrediction {
        latency: LatencyPrediction {
            version: 1,
            request_digest: request.request_digest.clone(),
            backend_ref: input.scope.backend_ref.clone(),
            offering: input.offering.clone(),
            request_size: request.size,
            output_estimate: context.output_estimate,
            boundary: LatencyBoundary::MarketEndToEnd,
            estimated_ttft_ms: Some(ttft),
            estimated_tpot_ms: None,
            load_ref: input.load.reference.clone(),
            max_market_requests: 8,
            updated_at: context.compared_at,
            valid_until: bitrouter_market::order::UnixMillis(8000),
        },
        cache_match: match_prefix(
            &context.spec,
            &context.tokens,
            &input.scope,
            &input.cache,
            context.compared_at,
        )
        .unwrap(),
        cache_assumption: CacheLatencyAssumption::ColdCache,
        load: input.load.clone(),
        elapsed_market_wait_ms: context.compared_at.0
            - h.snapshot().purchase_orders().unwrap()[&p.authorization.binding.root]
                .receipt()
                .window
                .registered_at
                .0,
        market_requests_after_admission: input.market_requests_after_admission,
    });
    q.quote = bitrouter_market::purchase_order::qualify_total_cap(
        &p.clone(),
        h.snapshot().purchase_orders().unwrap()[&p.authorization.binding.root]
            .receipt()
            .window,
        &context,
        &input,
    )
    .unwrap();
    q
}

#[test]
fn both_objectives_use_the_same_complete_comparator_including_missing_secondary() {
    for objective in [
        FormalObjective::LowestEstimatedCost,
        FormalObjective::EarliestCompletion,
    ] {
        let (mut h, _) = pf::setup(false, false);
        let mut p = input("rank", 1);
        p.selection.objective = objective;
        place(&mut h, &p);
        let a = pf::publication(&h, &p.clone(), 1, "no-prediction");
        pf::publish(&mut h, &a);
        let b = predict(&h, &p, 2, "fast", 25);
        pf::publish(&mut h, &b);
        let result = drive(&mut h, 32);
        let id = pf::id(result.reviewed[0].1.decision.as_ref().unwrap());
        assert_eq!(h.snapshot().purchase_trades().unwrap()[&id].option_id.0, 2);
    }
}

#[test]
fn accepted_failure_never_reopens_a_formal_order_or_releases_pending_money() {
    let (mut h, mut a) = pf::setup(false, false);
    let p = input("failed", 1);
    place(&mut h, &p);
    quotes(&mut h, &p);
    let result = drive(&mut h, 32);
    let id = pf::id(result.reviewed[0].1.decision.as_ref().unwrap());
    let report = h
        .dispatch(
            &pf::request(&h, &id, ExecutionRequestKind::Submit).effect_id,
            &mut a,
        )
        .unwrap();
    h.receive("accepted".into(), a.origin(), report).unwrap();
    a.finish(
        "exchange",
        &id,
        ExecutionOutcome::Failed,
        None,
        h.snapshot().now(),
    )
    .unwrap();
    let report = pf::query(&mut h, &mut a, &id, ExecutionRequestKind::Query, "terminal");
    h.receive("failed".into(), a.origin(), report).unwrap();
    drive(&mut h, 32);
    let s = h.snapshot();
    assert_eq!(s.purchase_trades().unwrap().len(), 1);
    assert!(s.purchase_orders().unwrap()[&p.authorization.binding.root]
        .closure()
        .is_some());
    assert!(s.accounts()[&1].held().0 > 0);
    assert_eq!(
        s.purchase_trades().unwrap()[&id].settlement,
        ReservationSettlement::Pending
    );
}

#[test]
fn dynamic_catalog_registration_is_append_only_and_retains_existing_responsibility() {
    use bitrouter_market::{admission::AdmissionScopeId, execution_authorization::FrozenIdentity};
    for count in [1, 129] {
        let (mut h, _) = pf::setup(false, false);
        let p = input("new-provider", 1);
        place(&mut h, &p);
        let mut member = fx::member("a", "backend-new");
        member.offering.backend_refs = (0..count)
            .map(|i| {
                if i == 0 {
                    "backend-new".into()
                } else {
                    format!("backend-new/{i}")
                }
            })
            .collect();
        let identities = member
            .offering
            .backend_refs
            .iter()
            .map(|b| {
                (
                    b.clone(),
                    FrozenIdentity {
                        source_epoch: 4,
                        backend_incarnation: "new-instance".into(),
                    },
                )
            })
            .collect();
        member.offering.provider_id = 8;
        member.offering.offering_id = 21;
        let input = RegisterSupplyScope {
            idempotency_key: "register-provider-8".into(),
            scope: PhysicalScope {
                id: AdmissionScopeId(50),
                authority_id: fx::AUTH,
                max_unresolved_requests: 1,
                members: vec![member],
            },
            identities,
        };
        let before = h.snapshot().scopes().len();
        h.execute(
            input.idempotency_key.clone(),
            ExchangeCommand::RegisterSupplyScope(Box::new(input.clone())),
        )
        .unwrap();
        assert_eq!(h.snapshot().scopes().len(), before + 1);
        let mut bad = input.clone();
        bad.idempotency_key = "replace-scope".into();
        bad.scope.max_unresolved_requests = 5;
        assert!(h
            .execute(
                bad.idempotency_key.clone(),
                ExchangeCommand::RegisterSupplyScope(Box::new(bad))
            )
            .is_err());
        let mut alias = input.clone();
        alias.idempotency_key = "alias-resource".into();
        alias.scope.id = AdmissionScopeId(51);
        alias.scope.members[0].offering.offering_id = 22;
        assert!(h
            .execute(
                alias.idempotency_key.clone(),
                ExchangeCommand::RegisterSupplyScope(Box::new(alias))
            )
            .is_err());
        // The newly registered provider publishes a real domain offer and independent
        // qualification after the buyer was already placed; only then may it get G.
        use bitrouter_market::{
            cache::CacheIndex, order::*, purchase_order::qualify_total_cap, terms::SupplyState,
        };
        let mut ask = fx::sell("ordinary-new", &["a"]).options.remove(0).ask;
        ask.provider_id = 8;
        ask.offering_id = 21;
        ask.rates.input = 0;
        ask.rates.output = 1_000_000;
        let mut offer = fx::sell("independent-new", &["a"]);
        offer.reference = fx::reference(
            bitrouter_market::authorization::OrderSide::Sell,
            8,
            "independent-new",
        );
        offer.options[0].ask = ask;
        fixture::run(&mut h, "offer-new", ExchangeCommand::SubmitSell(offer));
        let start = h.snapshot().now();
        let throughput = h.snapshot().books()["a"]
            .get_offering(11)
            .unwrap()
            .offering()
            .unwrap()
            .throughput
            .clone();
        fixture::control(
            &mut h,
            "ready-new",
            ExecutionCommand::RefreshSupply {
                provider_id: 8,
                source: OfferingKey {
                    market_id: "a".into(),
                    offering_id: 21,
                },
                generation: 1,
                state: SupplyState {
                    readiness: Readiness::Ready,
                    throughput,
                    observed_at: start,
                    valid_until: UnixMillis(9000),
                },
            },
        );
        h.execute(
            "measure-new".into(),
            ExchangeCommand::AdvanceTime(UnixMillis(start.0 + 1000)),
        )
        .unwrap();
        let new_offering = h.snapshot().books()["a"]
            .get_offering(21)
            .unwrap()
            .offering()
            .unwrap()
            .clone();
        let mut observation = h.snapshot().books()["a"]
            .get_throughput_observation(11)
            .unwrap()
            .clone();
        observation.offering = new_offering.clone();
        observation.started_at = start;
        observation.ended_at = h.snapshot().now();
        fixture::control(
            &mut h,
            "throughput-new",
            ExecutionCommand::Throughput(Box::new(observation.clone())),
        );
        h.execute(
            "report-new".into(),
            ExchangeCommand::ScopeReport(fx::report(50, 1, vec![])),
        )
        .unwrap();
        let mut service = pf::service_publication(&h, "a");
        service.offering.offering_id = 21;
        service.schedule.provider_id = 8;
        service.schedule.reference = "service-new".into();
        service.schedule.rates = new_offering.rates;
        h.execute(
            "service-new".into(),
            ExchangeCommand::PublishSellerService(Box::new(service)),
        )
        .unwrap();
        let mut q = pf::publication(&h, &p.clone(), 1, "new-provider");
        let context = q.quote.context().clone();
        let mut candidate = q.quote.input().clone();
        candidate.offer_id = 21;
        candidate.offering = new_offering;
        candidate.scope.backend_ref = "backend-new".into();
        candidate.cache =
            CacheIndex::new(&context.spec, candidate.scope.clone(), context.compared_at)
                .unwrap()
                .snapshot();
        candidate.load.backend_ref = "backend-new".into();
        candidate.throughput_observation = Some(observation);
        q.load_report = h
            .snapshot()
            .scope_report(AdmissionScopeId(50))
            .unwrap()
            .metadata
            .clone();
        candidate.load.version = q.load_report.version.sequence;
        candidate.load.observed_at = q.load_report.observed_at;
        candidate.load.valid_until = q.load_report.valid_until;
        q.service = h
            .snapshot()
            .seller_service(&OfferingKey {
                market_id: "a".into(),
                offering_id: 21,
            })
            .unwrap()
            .schedule
            .freeze(p.authorization.options[0].request.size)
            .unwrap();
        q.quote = qualify_total_cap(
            &p.clone(),
            h.snapshot().purchase_orders().unwrap()[&p.authorization.binding.root]
                .receipt()
                .window,
            &context,
            &candidate,
        )
        .unwrap();
        q.seller_option = h.snapshot().sources()[&OfferingKey {
            market_id: "a".into(),
            offering_id: 21,
        }]
            .option
            .clone();
        pf::publish(&mut h, &q);
        for i in 1..count {
            let mut other = q.clone();
            other.quote_ref = format!("quote/new-provider-{i}");
            other.evidence_ref = format!("evidence/new-provider-{i}");
            let mut candidate = q.quote.input().clone();
            candidate.scope.backend_ref = format!("backend-new/{i}");
            candidate.load.backend_ref = candidate.scope.backend_ref.clone();
            candidate.cache =
                CacheIndex::new(&context.spec, candidate.scope.clone(), context.compared_at)
                    .unwrap()
                    .snapshot();
            other.quote = qualify_total_cap(
                &p.clone(),
                h.snapshot().purchase_orders().unwrap()[&p.authorization.binding.root]
                    .receipt()
                    .window,
                &context,
                &candidate,
            )
            .unwrap();
            pf::publish(&mut h, &other);
        }
        let result = drive(&mut h, 32);
        if count == 1 {
            let id = pf::id(result.reviewed[0].1.decision.as_ref().unwrap());
            assert_eq!(
                h.snapshot().purchase_trades().unwrap()[&id]
                    .quote
                    .quote
                    .input()
                    .offering
                    .provider_id,
                8
            );
        } else {
            assert_eq!(
                result.reviewed[0].1.status,
                FormalReviewStatus::CandidateLimit
            );
            assert!(h.snapshot().purchase_trades().unwrap().is_empty());
        }
        assert_eq!(
            h.snapshot().purchase_orders().unwrap()[&p.authorization.binding.root]
                .input
                .provider_scope,
            ProviderScope::AnyQualified
        );
        assert_eq!(
            MarketHost::replay(pf::bootstrap(false), &h.journal())
                .unwrap()
                .snapshot(),
            h.snapshot()
        );
    }
}

fn input(name: &str, owner: u64) -> PlaceFormalOrder {
    PlaceFormalOrder {
        version: bitrouter_market::formal_order::FORMAL_VERSION,
        idempotency_key: format!("formal-{name}-{owner}"),
        authorization: pf::registration(name, owner, &["a", "b"], false).authorization,
        provider_scope: ProviderScope::AnyQualified,
        selection: FormalSelection::default(),
    }
}
fn place(h: &mut MarketHost, p: &PlaceFormalOrder) -> FormalOrderReceipt {
    match h
        .execute(
            p.idempotency_key.clone(),
            ExchangeCommand::PlaceFormalOrder(Box::new(p.clone())),
        )
        .unwrap()
    {
        ExchangeReceipt::FormalOrderPlaced(r) => *r,
        _ => panic!(),
    }
}
fn drive(h: &mut MarketHost, budget: usize) -> FormalDriveReceipt {
    let key = format!("drive/{}", h.snapshot().revision());
    match h
        .execute(
            key.clone(),
            ExchangeCommand::DriveFormalOrders(DriveFormalOrders {
                idempotency_key: key,
                observed_at: h.snapshot().now(),
                budget,
            }),
        )
        .unwrap()
    {
        ExchangeReceipt::FormalOrdersDriven(r) => r,
        _ => panic!(),
    }
}
fn quotes(h: &mut MarketHost, p: &PlaceFormalOrder) {
    for (option, label) in [(1, "a"), (2, "b")] {
        let q = pf::publication(
            h,
            &p.clone(),
            option,
            &format!("{}-{label}", p.idempotency_key),
        );
        pf::publish(h, &q);
    }
}

#[test]
fn formal_buyers_compete_for_one_flat_offer_sale() {
    let (mut h, _, seller) = sf::setup(false, true);
    for owner in [1, 2] {
        let p = input(&format!("joint-{owner}"), owner);
        place(&mut h, &p);
        let q = pf::publication(&h, &p.clone(), owner as u32, &format!("joint-{owner}"));
        pf::publish(&mut h, &q);
    }
    let r = drive(&mut h, 32);
    assert_eq!(r.reviewed.len(), 2);
    assert_eq!(h.snapshot().purchase_trades().unwrap().len(), 1);
    assert!(h.snapshot().sells()[&seller.order.reference]
        .allocation()
        .is_closed());
    let rounds: std::collections::BTreeSet<_> = h
        .snapshot()
        .frozen_grants()
        .unwrap()
        .values()
        .map(|g| {
            g.authorization
                .purchase
                .seller_ioc
                .as_ref()
                .unwrap()
                .round_id
                .clone()
        })
        .collect();
    assert_eq!(rounds.len(), 1);
    assert_eq!(
        MarketHost::replay(sf::bootstrap(false), &h.journal())
            .unwrap()
            .snapshot(),
        h.snapshot()
    );
}

#[test]
fn stale_formal_preparation_never_publishes_and_next_review_uses_other_supply() {
    use bitrouter_market::{order::Readiness, terms::SupplyState};
    let (mut h, _) = pf::setup(false, false);
    let p = input("stale", 1);
    place(&mut h, &p);
    quotes(&mut h, &p);
    let prepared = h
        .prepare(
            "stale-drive".into(),
            ExchangeCommand::DriveFormalOrders(DriveFormalOrders {
                idempotency_key: "stale-drive".into(),
                observed_at: h.snapshot().now(),
                budget: 32,
            }),
        )
        .unwrap();
    let PrepareOutcome::Prepared(prepared) = prepared else {
        panic!()
    };
    assert_eq!(prepared.record().grants().len(), 1);
    assert!(h.snapshot().frozen_grants().unwrap().is_empty());
    let old = h.snapshot().books()["a"]
        .get_offering(11)
        .unwrap()
        .offering()
        .unwrap()
        .clone();
    fixture::control(
        &mut h,
        "paused-first",
        ExecutionCommand::RefreshSupply {
            provider_id: 7,
            source: fixture::source("a"),
            generation: 1,
            state: SupplyState {
                readiness: Readiness::NotReady,
                throughput: old.throughput,
                observed_at: old.observed_at,
                valid_until: old.valid_until,
            },
        },
    );
    assert!(h.publish(*prepared).is_err());
    assert!(h.snapshot().frozen_grants().unwrap().is_empty());
    let r = drive(&mut h, 32);
    let id = pf::id(r.reviewed[0].1.decision.as_ref().unwrap());
    assert_eq!(h.snapshot().purchase_trades().unwrap()[&id].option_id.0, 2);
}

#[test]
fn zero_cap_formal_order_cannot_use_a_quote_for_a_paid_authorization() {
    use bitrouter_market::order::MicroUsd;
    let (mut h, _) = pf::setup(false, false);
    let p = input("budget", 1);
    place(&mut h, &p);
    let q = pf::publication(&h, &p.clone(), 1, "paid");
    let (mut other, _) = pf::setup(false, false);
    let mut free = p.clone();
    free.authorization.max_charge = MicroUsd(0);
    place(&mut other, &free);
    assert!(other
        .execute(
            "invalid-paid-quote".into(),
            ExchangeCommand::PurchaseQuote(Box::new(q))
        )
        .is_err());
    drive(&mut other, 32);
    assert!(other.snapshot().purchase_trades().unwrap().is_empty());
    assert_eq!(other.snapshot().accounts()[&1].held(), MicroUsd(0));
}

#[test]
fn manual_and_agent_origins_have_identical_selection_and_grants_for_the_same_market_facts() {
    let (mut manual, _) = pf::setup(false, false);
    let mut agent = manual.clone();
    let p = input("same-authorization", 1);
    place(&mut manual, &p);
    agent
        .execute(
            p.idempotency_key.clone(),
            ExchangeCommand::PlaceFormalOrderByAgent {
                input: Box::new(p.clone()),
                agent_id: 42,
            },
        )
        .unwrap();
    quotes(&mut manual, &p);
    quotes(&mut agent, &p);
    assert_eq!(drive(&mut manual, 32), drive(&mut agent, 32));
    assert_eq!(
        manual.snapshot().frozen_grants(),
        agent.snapshot().frozen_grants()
    );
}

#[test]
fn formal_revision_overflow_rejects_the_entire_preparation_without_panicking() {
    let (mut h, _) = pf::setup(false, false);
    let p = input("overflow", 1);
    place(&mut h, &p);
    quotes(&mut h, &p);
    // Trusted counter-boundary fixture; no damaged ledger is opened or repaired.
    let mut encoded = serde_json::to_value(h).unwrap();
    encoded["kernel"]["state"]["revision"] = serde_json::json!(u64::MAX);
    let h: MarketHost = serde_json::from_value(encoded).unwrap();
    let before = h.snapshot();
    let result = h
        .prepare(
            "overflow-drive".into(),
            ExchangeCommand::DriveFormalOrders(DriveFormalOrders {
                idempotency_key: "overflow-drive".into(),
                observed_at: before.now(),
                budget: 32,
            }),
        )
        .unwrap();
    assert!(matches!(
        result,
        PrepareOutcome::Rejected(ExchangeError::Overflow)
    ));
    assert_eq!(h.snapshot(), before);
    assert!(h.snapshot().frozen_grants().unwrap().is_empty());
}
#[test]
fn formal_defaults_canonicalization_and_unknown_rules_are_strict() {
    let mut value = serde_json::to_value(input("defaults", 1)).unwrap();
    value.as_object_mut().unwrap().remove("selection");
    value.as_object_mut().unwrap().remove("provider_scope");
    assert_eq!(
        serde_json::from_value::<PlaceFormalOrder>(value.clone()).unwrap(),
        input("defaults", 1)
    );
    value["selection"] = serde_json::json!(null);
    assert!(serde_json::from_value::<PlaceFormalOrder>(value).is_err());
    let mut i = input("set", 1);
    i.provider_scope = ProviderScope::Only {
        provider_ids: vec![9, 7],
    };
    i.canonicalize().unwrap();
    assert_eq!(
        i.provider_scope,
        ProviderScope::Only {
            provider_ids: vec![7, 9]
        }
    );
    i.selection.rules_ref = "future".into();
    assert!(i.canonicalize().is_err());
}
#[test]
fn formal_order_drives_and_preserves_original_receipt() {
    let (mut h, _) = pf::setup(false, false);
    let p = input("auto", 1);
    let receipt = place(&mut h, &p);
    assert!(h.snapshot().purchase_trades().unwrap().is_empty());
    quotes(&mut h, &p);
    let result = drive(&mut h, 32);
    assert_eq!(result.reviewed.len(), 1);
    let id = pf::id(result.reviewed[0].1.decision.as_ref().unwrap());
    assert_eq!(h.snapshot().purchase_trades().unwrap()[&id].option_id.0, 1);
    assert_eq!(place(&mut h, &p), receipt);
    assert_eq!(h.snapshot().purchase_trades().unwrap().len(), 1);
    assert_eq!(
        h.formal_command_receipt(1, &p.idempotency_key),
        Some(ExchangeReceipt::FormalOrderPlaced(Box::new(receipt)))
    );
    assert!(h.formal_command_receipt(2, &p.idempotency_key).is_none());
}
#[test]
fn denied_provider_and_missing_completion_never_fall_back_to_another_objective() {
    let (mut h, _) = pf::setup(false, false);
    let mut p = input("speed", 1);
    p.selection.objective = FormalObjective::EarliestCompletion;
    place(&mut h, &p);
    quotes(&mut h, &p);
    drive(&mut h, 32);
    assert!(h.snapshot().purchase_trades().unwrap().is_empty());
    let (mut h, _) = pf::setup(false, false);
    let mut p = input("scope", 1);
    p.provider_scope = ProviderScope::Only {
        provider_ids: vec![99],
    };
    place(&mut h, &p);
    let q = pf::publication(&h, &p.clone(), 1, "denied");
    assert!(h
        .execute(
            "denied-quote".into(),
            ExchangeCommand::PurchaseQuote(Box::new(q))
        )
        .is_err());
    drive(&mut h, 32);
    assert!(h.snapshot().purchase_trades().unwrap().is_empty());
}
#[test]
fn original_unknown_blocks_replacement_and_authoritative_fence_allows_gtd_retry() {
    let (mut h, mut a) = pf::setup(false, false);
    let p = input("unknown", 1);
    place(&mut h, &p);
    quotes(&mut h, &p);
    let result = drive(&mut h, 32);
    let id = pf::id(result.reviewed[0].1.decision.as_ref().unwrap());
    let submit = pf::request(&h, &id, ExecutionRequestKind::Submit);
    h.set_resolver_available(false);
    assert!(h.dispatch(&submit.effect_id, &mut a).is_err());
    h.set_resolver_available(true);
    let report = pf::query(&mut h, &mut a, &id, ExecutionRequestKind::Query, "missing");
    assert!(matches!(
        report.observation,
        ExecutionReportState::NotFound {}
    ));
    h.receive("query-report".into(), a.origin(), report)
        .unwrap();
    drive(&mut h, 32);
    assert_eq!(h.snapshot().purchase_trades().unwrap().len(), 1);
    let fence = pf::query(
        &mut h,
        &mut a,
        &id,
        ExecutionRequestKind::FenceUnaccepted,
        "fenced",
    );
    h.receive("fence-report".into(), a.origin(), fence).unwrap();
    quotes(&mut h, &p);
    let result = drive(&mut h, 32);
    assert!(result.reviewed[0].1.decision.is_some());
    assert_eq!(h.snapshot().purchase_trades().unwrap().len(), 2);
}
#[test]
fn bounded_round_robin_continues_after_a_budget() {
    let (mut h, _) = pf::setup(false, false);
    let a = input("a", 1);
    let b = input("b", 2);
    place(&mut h, &a);
    place(&mut h, &b);
    let first = drive(&mut h, 1);
    let second = drive(&mut h, 1);
    assert_ne!(first.reviewed[0].0, second.reviewed[0].0);
    assert_eq!(h.snapshot().formal_pending(), 0);
    assert_eq!(h.snapshot().purchase_orders().unwrap().len(), 2);
    assert!(h.snapshot().purchase_trades().unwrap().is_empty());
}
#[test]
fn journal_replay_retains_original_receipt_queue_grant_and_no_network() {
    let (mut h, _) = pf::setup(false, false);
    let p = input("replay", 1);
    place(&mut h, &p);
    quotes(&mut h, &p);
    drive(&mut h, 32);
    let expected = h.snapshot();
    let j = h.journal();
    let restored = MarketHost::replay(pf::bootstrap(false), &j).unwrap();
    assert_eq!(restored.snapshot(), expected);
}
