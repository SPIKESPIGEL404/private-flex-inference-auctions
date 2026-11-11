use bitrouter_market::admission::{AttemptId, ReportAuthorityId};
use bitrouter_market::execution_contract::*;
use bitrouter_market::order::{TokenUsage, UnixMillis};

fn binding() -> ExecutionBinding {
    ExecutionBinding {
        exchange_id: "exchange".into(),
        attempt_id: AttemptId {
            market_id: "a".into(),
            order_id: 1,
            sequence: 1,
        },
        grant_ref: GrantRef::new("grant/1".into()).unwrap(),
        authority_id: ReportAuthorityId(7),
        source_epoch: 3,
        backend_ref: "worker/a".into(),
        backend_incarnation: "boot/5".into(),
        created_at: UnixMillis(100),
        accept_before: UnixMillis(200),
    }
}
fn request(id: &str, kind: ExecutionRequestKind) -> ExecutionRequest {
    ExecutionRequest {
        version: EXECUTION_CONTRACT_VERSION,
        effect_id: EffectId::new(id.into()).unwrap(),
        binding: binding(),
        kind,
    }
}
fn report(sequence: u64, observation: ExecutionReportState) -> ExecutionReport {
    ExecutionReport {
        version: EXECUTION_CONTRACT_VERSION,
        binding: binding(),
        source_sequence: sequence,
        produced_at: UnixMillis(300),
        response_to: None,
        milestones: match &observation {
            ExecutionReportState::NotFound {} | ExecutionReportState::NotExecutedFence { .. } => {
                None
            }
            ExecutionReportState::Accepted { .. } => Some(ExecutionMilestones::default()),
            ExecutionReportState::Running { started_at, .. } => Some(ExecutionMilestones {
                started_at: Some(*started_at),
                first_response_at: None,
            }),
            ExecutionReportState::Terminal { accepted_at, .. } => Some(ExecutionMilestones {
                started_at: Some(*accepted_at),
                first_response_at: None,
            }),
        },
        observation,
    }
}
fn accepted() -> ExecutionReportState {
    ExecutionReportState::Accepted {
        accepted_at: UnixMillis(150),
    }
}

#[test]
fn only_three_operations_cross_the_wire_and_references_are_validated() {
    for kind in [
        ExecutionRequestKind::Submit,
        ExecutionRequestKind::Query,
        ExecutionRequestKind::FenceUnaccepted,
    ] {
        let value = request("effect/1", kind);
        let encoded = serde_json::to_value(&value).unwrap();
        let decoded: ExecutionRequest = serde_json::from_value(encoded).unwrap();
        decoded.validate().unwrap();
        assert_eq!(decoded, value);
    }
    for forbidden in ["start", "finish", "close", "drop", "hold", "cancel"] {
        let mut value = serde_json::to_value(request("e", ExecutionRequestKind::Query)).unwrap();
        value["kind"] = forbidden.into();
        assert!(serde_json::from_value::<ExecutionRequest>(value).is_err());
    }
    assert!(serde_json::from_str::<EffectId>("\" \"").is_err());
    assert!(GrantRef::new("x".repeat(129)).is_err());
    let mut value = serde_json::to_value(request("e", ExecutionRequestKind::Query)).unwrap();
    value["decision"] = "accept".into();
    assert!(serde_json::from_value::<ExecutionRequest>(value).is_err());
    let mut value = serde_json::to_value(request("e", ExecutionRequestKind::Query)).unwrap();
    value["binding"]["exchange_id"] = " ".into();
    let decoded: ExecutionRequest = serde_json::from_value(value).unwrap();
    assert_eq!(decoded.validate(), Err(ContractError::InvalidReference));
    let mut value = serde_json::to_value(report(1, accepted())).unwrap();
    value["observation"]["simulation_decision"] = "accept".into();
    assert!(serde_json::from_value::<ExecutionReport>(value).is_err());
}

#[test]
fn first_acceptance_deadline_does_not_expire_reports_or_original_responsibility() {
    let binding = binding();
    binding
        .validate_first_acceptance_time(UnixMillis(199))
        .unwrap();
    assert_eq!(
        binding.validate_first_acceptance_time(UnixMillis(200)),
        Err(ContractError::FirstAcceptanceExpired)
    );
    // A historical acceptance remains reportable well after the deadline.
    report(1, accepted()).validate_for(&binding).unwrap();
    let late = report(
        2,
        ExecutionReportState::Accepted {
            accepted_at: UnixMillis(200),
        },
    );
    assert_eq!(
        late.validate_for(&binding),
        Err(ContractError::FirstAcceptanceExpired)
    );
    request("query/late", ExecutionRequestKind::Query)
        .validate()
        .unwrap();
    request("fence/late", ExecutionRequestKind::FenceUnaccepted)
        .validate()
        .unwrap();
}

#[test]
fn not_found_cannot_answer_submit_or_fence_as_non_execution_proof() {
    let unsolicited = report(1, ExecutionReportState::NotFound {});
    let encoded = serde_json::to_vec(&unsolicited).unwrap();
    let decoded: ExecutionReport = serde_json::from_slice(&encoded).unwrap();
    assert_eq!(
        decoded.validate_for(&binding()),
        Err(ContractError::InvalidResponse)
    );
    let mut inbox = ReportInbox::new(binding()).unwrap();
    let before = inbox.clone();
    assert_eq!(
        inbox.observe(&decoded, None),
        Err(ContractError::InvalidResponse)
    );
    assert_eq!(inbox, before);
    for kind in [
        ExecutionRequestKind::Submit,
        ExecutionRequestKind::FenceUnaccepted,
    ] {
        let request = request("effect", kind);
        let mut absent = report(1, ExecutionReportState::NotFound {});
        absent.response_to = Some(request.effect_id.clone());
        assert_eq!(
            absent.validate_response_to(&request),
            Err(ContractError::InvalidResponse)
        );
    }
    let query = request("query", ExecutionRequestKind::Query);
    let mut absent = report(1, ExecutionReportState::NotFound {});
    absent.response_to = Some(query.effect_id.clone());
    absent.validate_response_to(&query).unwrap();
    let mut forged = serde_json::to_value(report(
        2,
        ExecutionReportState::Terminal {
            outcome: ExecutionOutcome::Completed,
            accepted_at: UnixMillis(150),
            ended_at: UnixMillis(250),
            usage: None,
        },
    ))
    .unwrap();
    forged["observation"]["outcome"] = "not_executed".into();
    assert!(serde_json::from_value::<ExecutionReport>(forged).is_err());
    report(
        3,
        ExecutionReportState::NotExecutedFence {
            fenced_at: UnixMillis(250),
        },
    )
    .validate_for(&binding())
    .unwrap();
}

#[test]
fn not_found_rejects_extra_fields_before_full_report_admission() {
    fn ingest(
        inbox: &mut ReportInbox,
        query: &ExecutionRequest,
        json: &str,
    ) -> Result<ReportAdmission, String> {
        let decoded: ExecutionReport = serde_json::from_str(json).map_err(|e| e.to_string())?;
        decoded
            .validate_response_to(query)
            .map_err(|e| e.to_string())?;
        inbox
            .observe(&decoded, Some(query))
            .map_err(|e| e.to_string())
    }

    let query = request("query/strict", ExecutionRequestKind::Query);
    let mut absent = report(1, ExecutionReportState::NotFound {});
    absent.response_to = Some(query.effect_id.clone());
    let valid = serde_json::to_value(&absent).unwrap();
    assert_eq!(
        valid["observation"],
        serde_json::json!({"state": "not_found"})
    );

    let mut inbox = ReportInbox::new(binding()).unwrap();
    let admitted = ingest(&mut inbox, &query, &valid.to_string()).unwrap();
    assert_eq!(admitted.order, ReportOrder::Newest);
    assert!(admitted.answers_current_query);
    assert_eq!(inbox.reports().get(&1), Some(&absent));
    let before = inbox.clone();

    for extra in [
        serde_json::json!({"simulation_decision": "accept"}),
        serde_json::json!({"simulation_decision": "reject"}),
        serde_json::json!({"usage": null}),
        serde_json::json!({"accepted_at": 150}),
    ] {
        let mut invalid = valid.clone();
        invalid["observation"]
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        assert!(
            serde_json::from_str::<ExecutionReportState>(&invalid["observation"].to_string())
                .is_err()
        );
        assert!(serde_json::from_str::<ExecutionReport>(&invalid.to_string()).is_err());
        assert!(ingest(&mut inbox, &query, &invalid.to_string()).is_err());
        assert_eq!(inbox, before);
    }
}

#[test]
fn binding_authority_epoch_and_backend_are_not_learned_from_the_report() {
    let original = report(1, accepted());
    let changes: [fn(&mut ExecutionBinding); 8] = [
        |b| b.exchange_id = "other-exchange".into(),
        |b| b.attempt_id.sequence += 1,
        |b| b.grant_ref = GrantRef::new("other".into()).unwrap(),
        |b| b.authority_id = ReportAuthorityId(8),
        |b| b.source_epoch += 1,
        |b| b.backend_incarnation = "new-boot".into(),
        |b| b.backend_ref = "other-worker".into(),
        |b| b.accept_before = UnixMillis(201),
    ];
    let mut inbox = ReportInbox::new(binding()).unwrap();
    for change in changes {
        let mut wrong = original.clone();
        change(&mut wrong.binding);
        assert_eq!(
            inbox.observe(&wrong, None),
            Err(ContractError::BindingMismatch)
        );
        assert!(inbox.reports().is_empty());
    }
}

#[test]
fn old_sequence_conflicts_are_detected_and_old_queries_do_not_prove_current_contact() {
    let old_query = request("query/1", ExecutionRequestKind::Query);
    let current_query = request("query/2", ExecutionRequestKind::Query);
    let mut inbox = ReportInbox::new(binding()).unwrap();
    let mut old_answer = report(10, accepted());
    old_answer.response_to = Some(old_query.effect_id.clone());
    let admitted = inbox.observe(&old_answer, Some(&current_query)).unwrap();
    assert_eq!(admitted.order, ReportOrder::Newest);
    assert!(!admitted.answers_current_query);

    let mut current = report(
        20,
        ExecutionReportState::Running {
            accepted_at: UnixMillis(150),
            started_at: UnixMillis(160),
        },
    );
    current.response_to = Some(current_query.effect_id.clone());
    assert!(
        inbox
            .observe(&current, Some(&current_query))
            .unwrap()
            .answers_current_query
    );
    assert_eq!(
        inbox
            .observe(&old_answer, Some(&current_query))
            .unwrap()
            .order,
        ReportOrder::Duplicate
    );
    let historical = report(15, accepted());
    assert_eq!(
        inbox.observe(&historical, None).unwrap().order,
        ReportOrder::Historical
    );
    let before = inbox.clone();
    old_answer.observation = ExecutionReportState::NotFound {};
    old_answer.milestones = None;
    assert_eq!(
        inbox.observe(&old_answer, None),
        Err(ContractError::SequenceConflict)
    );
    assert_eq!(inbox, before);

    // Even a newly received historical response to the current query is older
    // than the source high water. Correlation alone does not establish contact.
    let mut stale = report(16, accepted());
    stale.response_to = Some(current_query.effect_id.clone());
    assert!(
        !inbox
            .observe(&stale, Some(&current_query))
            .unwrap()
            .answers_current_query
    );
}

#[test]
fn structural_admission_preserves_terminal_usage_for_later_domain_settlement() {
    let terminal = report(
        1,
        ExecutionReportState::Terminal {
            outcome: ExecutionOutcome::Failed,
            accepted_at: UnixMillis(150),
            ended_at: UnixMillis(250),
            usage: Some(TokenUsage {
                uncached_input_tokens: u64::MAX,
                cached_input_tokens: 1,
                billable_output_tokens: 99,
            }),
        },
    );
    // Bad billing evidence cannot make an authoritative terminal disappear.
    terminal.validate_for(&binding()).unwrap();
    let encoded = serde_json::to_vec(&terminal).unwrap();
    assert_eq!(
        serde_json::from_slice::<ExecutionReport>(&encoded).unwrap(),
        terminal
    );
    let mut invalid = terminal.clone();
    invalid.produced_at = UnixMillis(200);
    assert_eq!(
        invalid.validate_for(&binding()),
        Err(ContractError::InvalidTimestamp)
    );
    invalid = terminal.clone();
    invalid.version = 3;
    assert_eq!(
        invalid.validate_for(&binding()),
        Err(ContractError::UnsupportedVersion)
    );
    invalid = terminal;
    invalid.source_sequence = 0;
    assert_eq!(
        invalid.validate_for(&binding()),
        Err(ContractError::InvalidSequence)
    );
}
