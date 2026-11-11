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
use bitrouter_market::admission::*;
use bitrouter_market::exchange::*;
use bitrouter_market::execution_contract::*;
use bitrouter_market::fake_authority::FakeAuthority;
use bitrouter_market::market_host::{HostError, MarketHost};
use bitrouter_market::order::*;
use pf::*;

fn accepted() -> (MarketHost, FakeAuthority, AttemptId, UnixMillis) {
    let (mut h, mut a) = setup(false, false);
    let r = registration("milestones", 1, &["a"], false);
    register(&mut h, &r);
    let q = publication(&h, &r, 1, "milestones");
    publish(&mut h, &q);
    let p = proposal(&h, &r, &[q], "milestones");
    let id = id(&propose(&mut h, &p));
    let report = h
        .dispatch(
            &request(&h, &id, ExecutionRequestKind::Submit).effect_id,
            &mut a,
        )
        .unwrap();
    assert_eq!(report.version, EXECUTION_CONTRACT_VERSION);
    assert_eq!(report.milestones, Some(ExecutionMilestones::default()));
    h.receive("accepted".into(), a.origin(), report).unwrap();
    let now = h.snapshot().now();
    (h, a, id, now)
}
fn at(h: &mut MarketHost, time: UnixMillis) {
    fixture::run(
        h,
        &format!("clock/{}", time.0),
        ExchangeCommand::AdvanceTime(time),
    );
}
fn usage() -> TokenUsage {
    TokenUsage {
        uncached_input_tokens: 10,
        cached_input_tokens: 0,
        billable_output_tokens: 1,
    }
}
#[test]
fn terminal_retains_original_start_and_first_response_when_intermediate_reports_are_lost() {
    let (mut h, mut a, id, e) = accepted();
    assert_eq!(
        h.snapshot().purchase_trades().unwrap()[&id].started_at,
        None
    );
    a.start("exchange", &id, UnixMillis(e.0 + 10)).unwrap();
    a.first_response("exchange", &id, UnixMillis(e.0 + 25))
        .unwrap();
    a.finish(
        "exchange",
        &id,
        ExecutionOutcome::Completed,
        Some(usage()),
        UnixMillis(e.0 + 40),
    )
    .unwrap();
    at(&mut h, UnixMillis(e.0 + 100));
    let terminal = query(
        &mut h,
        &mut a,
        &id,
        ExecutionRequestKind::Query,
        "terminal-query",
    );
    assert_eq!(
        terminal.milestones,
        Some(ExecutionMilestones {
            started_at: Some(UnixMillis(e.0 + 10)),
            first_response_at: Some(UnixMillis(e.0 + 25))
        })
    );
    h.receive("terminal".into(), a.origin(), terminal.clone())
        .unwrap();
    let t = h.snapshot().purchase_trades().unwrap()[&id].clone();
    assert_eq!(t.accepted_at, Some(e));
    assert_eq!(t.started_at, Some(UnixMillis(e.0 + 10)));
    assert_eq!(t.first_response_at, Some(UnixMillis(e.0 + 25)));
    assert_eq!(h.snapshot().occupancy(AdmissionScopeId(30)), 0);
    let replay = MarketHost::replay(bootstrap(false), &h.journal()).unwrap();
    assert_eq!(replay.snapshot(), h.snapshot());
    h.receive("duplicate-terminal".into(), a.origin(), terminal)
        .unwrap();
    assert_eq!(h.snapshot().purchase_trades().unwrap()[&id], t);
}
#[test]
fn missing_response_is_unknown_and_is_never_inferred_from_start_or_terminal() {
    let (mut h, mut a, id, e) = accepted();
    a.start("exchange", &id, e).unwrap();
    a.finish(
        "exchange",
        &id,
        ExecutionOutcome::Completed,
        Some(usage()),
        e,
    )
    .unwrap();
    let report = query(
        &mut h,
        &mut a,
        &id,
        ExecutionRequestKind::Query,
        "terminal-query",
    );
    h.receive("terminal".into(), a.origin(), report).unwrap();
    assert_eq!(
        h.snapshot().purchase_trades().unwrap()[&id].first_response_at,
        None
    );
    assert!(a.first_response("exchange", &id, e).is_err());
}
#[test]
fn first_response_is_one_immutable_observation_and_does_not_release_responsibility() {
    let (mut h, mut a, id, e) = accepted();
    assert!(a.first_response("exchange", &id, e).is_err());
    a.start("exchange", &id, UnixMillis(e.0 + 10)).unwrap();
    assert!(a.first_response("exchange", &id, e).is_err());
    let first = UnixMillis(e.0 + 20);
    a.first_response("exchange", &id, first).unwrap();
    a.first_response("exchange", &id, first).unwrap();
    assert!(a
        .first_response("exchange", &id, UnixMillis(first.0 + 1))
        .is_err());
    at(&mut h, first);
    let report = query(
        &mut h,
        &mut a,
        &id,
        ExecutionRequestKind::Query,
        "response-query",
    );
    h.receive("response".into(), a.origin(), report).unwrap();
    assert_eq!(
        h.snapshot().purchase_trades().unwrap()[&id].first_response_at,
        Some(first)
    );
    assert_eq!(h.snapshot().accounts()[&1].held(), MicroUsd(11));
    assert_eq!(h.snapshot().occupancy(AdmissionScopeId(30)), 1);
}
#[test]
fn changed_or_lost_timing_in_a_later_snapshot_is_rejected_without_unlocking() {
    let (mut h, mut a, id, e) = accepted();
    a.start("exchange", &id, e).unwrap();
    a.first_response("exchange", &id, e).unwrap();
    let running = query(
        &mut h,
        &mut a,
        &id,
        ExecutionRequestKind::Query,
        "running-query",
    );
    h.receive("running".into(), a.origin(), running).unwrap();
    let report = query(
        &mut h,
        &mut a,
        &id,
        ExecutionRequestKind::Query,
        "next-query",
    );
    let before = h.snapshot();
    for change in 0..4 {
        let mut invalid = report.clone();
        match change {
            0 => invalid.milestones.as_mut().unwrap().first_response_at = None,
            1 => invalid.milestones.as_mut().unwrap().started_at = Some(UnixMillis(e.0 + 1)),
            2 => invalid.milestones = None,
            _ => {
                invalid.version = EXECUTION_CONTRACT_VERSION + 1;
                invalid.milestones = None;
            }
        }
        assert!(matches!(
            h.receive(format!("invalid/{change}"), a.origin(), invalid),
            Err(HostError::Market(_))
        ));
        assert_eq!(h.snapshot(), before);
    }
    assert_eq!(h.raw_reports().len(), 6);
    h.receive("valid".into(), a.origin(), report).unwrap();
}
#[test]
fn current_milestones_reject_impossible_times_and_unknown_versions() {
    let (mut h, mut a, id, e) = accepted();
    a.start("exchange", &id, e).unwrap();
    let report = query(&mut h, &mut a, &id, ExecutionRequestKind::Query, "query");
    let mut invalid = report.clone();
    invalid.milestones.as_mut().unwrap().first_response_at = Some(UnixMillis(e.0 + 1));
    assert_eq!(
        invalid.validate_for(&report.binding),
        Err(ContractError::InvalidTimestamp)
    );
    invalid = report.clone();
    invalid.version = EXECUTION_CONTRACT_VERSION + 1;
    assert_eq!(
        invalid.validate_for(&report.binding),
        Err(ContractError::UnsupportedVersion)
    );
}

#[test]
fn historical_running_after_terminal_retains_all_original_facts_and_never_reopens_execution() {
    let (mut h, mut a, id, e) = accepted();
    a.start("exchange", &id, e).unwrap();
    a.first_response("exchange", &id, e).unwrap();
    let old = query(
        &mut h,
        &mut a,
        &id,
        ExecutionRequestKind::Query,
        "old-running-query",
    );
    a.finish(
        "exchange",
        &id,
        ExecutionOutcome::Completed,
        Some(usage()),
        e,
    )
    .unwrap();
    let terminal = query(
        &mut h,
        &mut a,
        &id,
        ExecutionRequestKind::Query,
        "terminal-query",
    );
    h.receive("terminal".into(), a.origin(), terminal).unwrap();
    let before = h.snapshot().purchase_trades().unwrap()[&id].clone();
    let balance = h.snapshot().accounts()[&1].balance();
    h.receive("historical".into(), a.origin(), old).unwrap();
    assert_eq!(h.snapshot().purchase_trades().unwrap()[&id], before);
    assert_eq!(h.snapshot().accounts()[&1].balance(), balance);
    assert_eq!(h.snapshot().occupancy(AdmissionScopeId(30)), 0);
}

#[test]
fn persistence_record_replay_checks_every_field_before_publication(
) -> Result<(), Box<dyn std::error::Error>> {
    let (original, _, _, now) = accepted();
    let saved = serde_json::to_vec(&original)?;
    let mut live = original.clone();
    let PrepareOutcome::Prepared(prepared) = live.prepare(
        "replay-clock".into(),
        ExchangeCommand::AdvanceTime(UnixMillis(now.0 + 1)),
    )?
    else {
        return Err(std::io::Error::other("expected new clock transition").into());
    };
    let record = prepared.record().clone();
    let receipt = live.publish(*prepared)?;
    let mut restored: MarketHost = serde_json::from_slice(&saved)?;
    assert_eq!(restored.replay_transition(&record)?, receipt);
    assert_eq!(serde_json::to_vec(&restored)?, serde_json::to_vec(&live)?);
    let committed = serde_json::to_vec(&restored)?;
    assert!(restored.replay_transition(&record).is_err());
    assert_eq!(serde_json::to_vec(&restored)?, committed);

    let snapshot = original.snapshot_ref();
    let effect = snapshot
        .execution_requests()
        .and_then(|items| items.values().next())
        .ok_or_else(|| std::io::Error::other("original request missing"))?;
    let grant = snapshot
        .frozen_grants()
        .and_then(|items| items.values().next())
        .ok_or_else(|| std::io::Error::other("original grant missing"))?;
    let modifications = [
        ("exchange_id", serde_json::json!("another-exchange")),
        (
            "expected_revision",
            serde_json::json!(record.expected_revision() + 1),
        ),
        (
            "next_revision",
            serde_json::json!(record.next_revision() + 1),
        ),
        (
            "receipt",
            serde_json::to_value(ExchangeReceipt::Time(UnixMillis(now.0 + 2)))?,
        ),
        ("effects", serde_json::json!([effect])),
        ("grants", serde_json::json!([grant])),
    ];
    for (field, replacement) in modifications {
        let mut changed = serde_json::to_value(&record)?;
        changed[field] = replacement;
        let corrupted: TransitionRecord = serde_json::from_value(changed)?;
        let mut restored: MarketHost = serde_json::from_slice(&saved)?;
        assert!(
            restored.replay_transition(&corrupted).is_err(),
            "accepted corrupt {field}"
        );
        assert_eq!(
            serde_json::to_vec(&restored)?,
            saved,
            "mutated state on corrupt {field}"
        );
    }
    Ok(())
}

#[test]
fn prepared_report_preserves_receive_order_and_rejected_raw_evidence(
) -> Result<(), Box<dyn std::error::Error>> {
    let (host, _, _, _) = accepted();
    let raw = host
        .raw_reports()
        .last()
        .cloned()
        .ok_or_else(|| std::io::Error::other("original accepted report missing"))?;
    let mut invalid = raw.report.clone();
    invalid.version = 0;
    let cases = [
        ("accepted", raw.origin, raw.report.clone()),
        ("host/forbidden", raw.origin, raw.report.clone()),
        ("fresh-observation", raw.origin, raw.report.clone()),
        ("invalid-version", raw.origin, invalid),
        (
            "wrong-origin",
            (raw.origin.0, raw.origin.1 + 1),
            raw.report.clone(),
        ),
    ];
    let mut received = host.clone();
    let mut prepared_host = host;
    for (key, origin, report) in cases {
        let before_count = prepared_host.raw_reports().len();
        let expected = received.receive(key.into(), origin, report.clone());
        let actual = match prepared_host.prepare_received_report(key.into(), origin, report) {
            Ok(PrepareOutcome::Prepared(prepared)) => prepared_host.publish(*prepared),
            Ok(PrepareOutcome::Duplicate(receipt)) => Ok(receipt),
            Ok(PrepareOutcome::Rejected(error)) => Err(HostError::from(error)),
            Err(error) => Err(error),
        };
        assert_eq!(actual, expected);
        assert_eq!(prepared_host.raw_reports().len(), before_count + 1);
        assert_eq!(
            serde_json::to_vec(&prepared_host)?,
            serde_json::to_vec(&received)?
        );
    }
    Ok(())
}

#[test]
fn persistence_bootstrap_validation_rejects_changed_or_nonempty_basis(
) -> Result<(), Box<dyn std::error::Error>> {
    let bootstrap = fixture::bootstrap(false);
    let mut host = bootstrap.clone();
    host.execute(
        "credit".into(),
        ExchangeCommand::Credit {
            buyer_id: 1,
            amount: MicroUsd(10),
        },
    )?;
    host.validate_bootstrap(&bootstrap)?;
    assert!(host.validate_bootstrap(&fixture::bootstrap(true)).is_err());
    assert!(host.validate_bootstrap(&host).is_err());
    Ok(())
}
