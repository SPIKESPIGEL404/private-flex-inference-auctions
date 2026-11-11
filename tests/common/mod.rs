#![allow(dead_code)]
use ed25519_dalek::{Signer, SigningKey};
use flex_scheduler::*;
use std::collections::BTreeMap;

// Public, deterministic fixture seed. Never a production credential.
pub fn fixture_signer() -> SigningKey {
    SigningKey::from_bytes(&[7; 32])
}

pub fn config() -> SchedulerConfig {
    SchedulerConfig {
        scheduler_id: "fixture-scheduler".into(),
        stream_id: "fixture-stream".into(),
        scheduler_policy_version: "external-gate-v1".into(),
        model: ModelProfile {
            profile_id: "fixture-only-no-gpu".into(),
            tokenizer_digest: "11".repeat(32),
            chat_template_digest: "22".repeat(32),
            max_prompt_tokens: 64,
            max_output_tokens: 32,
            max_model_len: 128,
            vocab_size: 1024,
            result_bytes_per_output_token: 32,
            result_overhead_bytes: 128,
        },
        authorized_issuers: BTreeMap::from([(
            "fixture-issuer".into(),
            encode_hex(fixture_signer().verifying_key().as_bytes()),
        )]),
        max_inflight_requests: 2,
        max_reserved_context_tokens: 64,
        max_spool_bytes: 8192,
        max_owner_spool_bytes: 4096,
        max_queued_requests: 20,
        max_queued_bytes: 32_768,
        max_out_of_order_plans: 4,
        max_plan_bytes: 65_536,
        max_requests_per_plan: 10,
        max_observation_tokens: 32,
    }
}

pub fn activation(epoch: &str) -> ActivationEvidence {
    ActivationEvidence {
        engine_epoch: epoch.into(),
        writer_isolation_ref: "fixture-writer-proof".into(),
        source_continuity_ref: "fixture-source-proof".into(),
        state_freshness_ref: "fixture-freshness-proof".into(),
        profile_verified_ref: "fixture-not-gpu-calibration".into(),
    }
}

pub fn request(seq: u64, rank: u32) -> ExecutionRequest {
    let mut r = ExecutionRequest {
        grant_id: format!("grant-{seq}-{rank}"),
        execution_id: format!("exec-{seq}-{rank}"),
        request_ref: format!("request-{seq}-{rank}"),
        owner_ref: "opaque-owner".into(),
        rank,
        request_digest: String::new(),
        prompt_token_ids: vec![1, 2, 3],
        sampling_config: SamplingConfig {
            temperature_milli: 0,
            top_p_millionths: 1_000_000,
            top_k: 50,
            seed: 42,
            stop_token_ids: vec![0],
        },
        max_output_tokens: 8,
        cache_namespace: "public-synthetic-fixture".into(),
        context_reservation: 11,
        max_result_bytes: 384,
    };
    r.request_digest = r.computed_digest().unwrap();
    r
}

pub fn seal(plan: &mut ExecutionPlan) {
    for q in &mut plan.ordered_requests {
        q.request_digest = q.computed_digest().unwrap();
    }
    plan.manifest_hash = plan.computed_manifest_hash().unwrap();
    plan.authorization_binding.signature = encode_hex(
        &fixture_signer()
            .sign(&plan.signing_bytes().unwrap())
            .to_bytes(),
    );
}

pub fn plan(seq: u64, previous: &str, count: u32) -> ExecutionPlan {
    let mut p = ExecutionPlan {
        schema_version: SCHEMA_VERSION,
        plan_id: format!("plan-{seq}"),
        stream_id: "fixture-stream".into(),
        plan_seq: seq,
        predecessor_plan_hash: previous.into(),
        upstream_commit_ref: format!("bitrouter-fixture-commit-{seq}"),
        target_scheduler_id: "fixture-scheduler".into(),
        model_profile_id: "fixture-only-no-gpu".into(),
        scheduler_policy_version: "external-gate-v1".into(),
        manifest_hash: String::new(),
        request_count: u64::from(count),
        authorization_ref: format!("fixture-authorization-{seq}"),
        authorization_binding: AuthorizationBinding {
            issuer_id: "fixture-issuer".into(),
            signature: String::new(),
        },
        ordered_requests: (1..=count).map(|r| request(seq, r)).collect(),
    };
    seal(&mut p);
    p
}

pub fn progress(execution: &str, epoch: &str, seq: u64) -> Observation {
    Observation {
        execution_id: execution.into(),
        engine_epoch: epoch.into(),
        source_seq: seq,
        evidence_ref: format!("fixture-progress-{execution}-{seq}"),
        observation: ObservationKind::OutputProgress {
            generated_token_ids: vec![99],
        },
    }
}

pub fn terminal(execution: &str, epoch: &str, seq: u64) -> Observation {
    Observation {
        execution_id: execution.into(),
        engine_epoch: epoch.into(),
        source_seq: seq,
        evidence_ref: format!("fixture-terminal-{execution}-{seq}"),
        observation: ObservationKind::ExecutionTerminal {
            outcome: TerminalOutcome::Stop,
            generated_token_ids: vec![],
        },
    }
}

pub fn unknown(execution: &str, epoch: &str, seq: u64) -> Observation {
    Observation {
        execution_id: execution.into(),
        engine_epoch: epoch.into(),
        source_seq: seq,
        evidence_ref: format!("fixture-timeout-{execution}-{seq}"),
        observation: ObservationKind::ExecutionUnknown {
            reason: UnknownReason::Timeout,
        },
    }
}

pub fn claim(s: &mut Scheduler) -> DispatchIntent {
    match s.claim_next().unwrap() {
        ClaimOutcome::Intent(i) => *i,
        ClaimOutcome::Blocked(r) => panic!("unexpected block: {r:?}"),
    }
}

pub fn assert_blocked(s: &mut Scheduler, reason: BlockReason) {
    match s.claim_next().unwrap() {
        ClaimOutcome::Blocked(r) => assert_eq!(r, reason),
        ClaimOutcome::Intent(_) => panic!("unexpected dispatch"),
    }
}
