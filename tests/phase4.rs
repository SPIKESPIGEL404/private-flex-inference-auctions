mod common;
#[path = "common/http.rs"]
mod http;
use common::*;
use flex_scheduler::*;
use http::{MockServer, Script, choice, frame, usage};
use std::collections::BTreeMap;

fn session() -> VllmSession {
    serde_json::from_slice(include_bytes!("../fixtures/phase4/session.json")).unwrap()
}
fn policy() -> SpoolPolicy {
    SpoolPolicy {
        acknowledged_retention_ms: 0,
        max_artifact_bytes: 4096,
        max_physical_bytes: 16384,
        max_owner_physical_bytes: 16384,
    }
}
fn core(count: u32) -> (tempfile::TempDir, Scheduler, ExecutionPlan) {
    let d = tempfile::tempdir().unwrap();
    let mut s =
        Scheduler::open_with_spool(d.path().join("journal.sqlite"), config(), policy()).unwrap();
    s.reconcile_spool("fixture-no-gpu".into()).unwrap();
    s.activate(activation("mock-epoch-1")).unwrap();
    let p = plan(1, GENESIS, count);
    s.register(p.clone()).unwrap();
    (d, s, p)
}
fn binding(plan: &ExecutionPlan, index: usize) -> ExecutionBinding {
    let r = &plan.ordered_requests[index];
    ExecutionBinding {
        plan_id: plan.plan_id.clone(),
        plan_seq: plan.plan_seq,
        manifest_hash: plan.manifest_hash.clone(),
        grant_id: r.grant_id.clone(),
        execution_id: r.execution_id.clone(),
        request_digest: r.request_digest.clone(),
        engine_epoch: Some("mock-epoch-1".into()),
    }
}
fn identity(b: &ExecutionBinding) -> Vec<u8> {
    let id = StreamIdentity {
        engine_epoch: session().engine_epoch,
        profile_digest: session().profile_digest,
        binding_digest: digest("flex-scheduler/result-binding/v1", b).unwrap(),
    };
    format!(
        "event: flex.identity\ndata: {}\n\n",
        serde_json::to_string(&id).unwrap()
    )
    .into_bytes()
}
fn success(execution: &str) -> Vec<u8> {
    let mut c = choice(execution, vec![99], "世", Some("stop"));
    c["choices"][0]["prompt_token_ids"] = serde_json::json!([1, 2, 3]);
    [
        frame(c),
        frame(usage(execution, 1)),
        b"data: [DONE]\n\n".to_vec(),
    ]
    .concat()
}

#[test]
fn python_and_rust_profile_canonical_digests_match() {
    let s = session();
    s.validate().unwrap();
    assert_eq!(s.profile.model_profile(), config().model);
    let mut changed = s.clone();
    changed.profile.max_output_tokens += 1;
    assert!(changed.validate().is_err());
    let mut changed = s;
    changed.profile.scheduler_only = false;
    changed.profile_digest = changed.profile.computed_digest().unwrap();
    assert!(changed.validate().is_err());
}

#[test]
fn remote_transport_requires_exact_https_origin_path_profile_and_safe_credential() {
    let mut cfg = VllmHttpConfig {
        transport: http::config("https://fixture.chutes.ai/scheduler/completions"),
        session: session(),
    };
    assert!(VllmHttpRunner::new(cfg.clone(), "synthetic-test-token").is_ok());
    for endpoint in [
        "http://fixture.chutes.ai/scheduler/completions",
        "https://127.0.0.1/scheduler/completions",
        "https://fixture.chutes.ai.evil.test/scheduler/completions",
        "https://fixture.chutes.ai/scheduler/completions?token=x",
        "https://u:p@fixture.chutes.ai/scheduler/completions",
        "https://fixture.chutes.ai:444/scheduler/completions",
        "https://fixture.chutes.ai/v1/chat/completions",
    ] {
        cfg.transport.endpoint = endpoint.into();
        assert!(
            VllmHttpRunner::new(cfg.clone(), "synthetic-test-token").is_err(),
            "{endpoint}"
        );
    }
    cfg.transport = http::config("https://fixture.chutes.ai/scheduler/completions");
    for token in ["", "synthetic\nAuthorization: bad", "a b"] {
        assert!(VllmHttpRunner::new(cfg.clone(), token).is_err());
    }
    cfg.transport.served_model = "other-model".into();
    assert!(VllmHttpRunner::new(cfg, "synthetic-test-token").is_err());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn identity_verified_stream_preserves_durable_result_and_records_monotonic_timings() {
    let (_d, mut s, p) = core(1);
    let wire = [identity(&binding(&p, 0)), success("exec-1-1")].concat();
    let server = MockServer::start(BTreeMap::from([("exec-1-1".into(), Script::sse(wire))])).await;
    let r = MockHttpRunner::new_profiled_mock(http::config(&server.endpoint), session())
        .unwrap()
        .run_until_idle(&mut s)
        .await
        .unwrap();
    assert_eq!(r.streams[0].protocol, ProtocolStatus::CompleteProtocol);
    let a = s.get_result_artifact("exec-1-1", "opaque-owner").unwrap();
    assert_eq!(a.text, "世");
    assert_eq!(a.token_ids, [99]);
    assert_eq!(a.binding, binding(&p, 0));
    let capture = &server.captures.lock().unwrap()[0].body;
    assert_eq!(capture["_flex"]["engine_epoch"], "mock-epoch-1");
    assert_eq!(
        capture["_flex"]["request"]["request_digest"],
        p.ordered_requests[0].request_digest
    );
    let t = &r.measurements[0];
    assert!(t.dispatch_at_us <= t.headers_at_us.unwrap());
    assert!(t.headers_at_us.unwrap() <= t.first_token_received_at_us.unwrap());
    assert!(t.first_token_received_at_us.unwrap() <= t.first_progress_committed_at_us.unwrap());
    assert!(t.first_progress_committed_at_us.unwrap() <= t.terminal_committed_at_us.unwrap());
    assert!(t.terminal_committed_at_us.unwrap() <= t.finished_at_us);
    assert_eq!(s.snapshot().unwrap(), s.replay_snapshot().unwrap());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn missing_wrong_or_repeated_stream_identity_never_opens_the_first_gate() {
    for variant in 0..5 {
        let (_d, mut s, p) = core(2);
        let good = identity(&binding(&p, 0));
        let prefix = match variant {
            0 => vec![],
            1 => String::from_utf8(good.clone())
                .unwrap()
                .replace("mock-epoch-1", "wrong-epoch")
                .into_bytes(),
            2 => String::from_utf8(good.clone())
                .unwrap()
                .replace(&session().profile_digest, &"ff".repeat(32))
                .into_bytes(),
            3 => identity(&binding(&p, 1)),
            4 => [good.clone(), good].concat(),
            _ => unreachable!(),
        };
        let wire = [prefix, success("exec-1-1")].concat();
        let server =
            MockServer::start(BTreeMap::from([("exec-1-1".into(), Script::sse(wire))])).await;
        let r = MockHttpRunner::new_profiled_mock(http::config(&server.endpoint), session())
            .unwrap()
            .run_until_idle(&mut s)
            .await
            .unwrap();
        assert_eq!(server.count(), 1);
        assert_eq!(
            r.streams[0].protocol,
            ProtocolStatus::IncompleteProtocol(StreamFailure::EngineIdentity)
        );
        let p = s.plan_state("plan-1").unwrap().unwrap();
        assert_eq!(p.executions[0].dispatch, DispatchState::Unknown);
        assert_eq!(p.executions[0].gate, GateState::Closed);
        assert_eq!(p.executions[1].dispatch, DispatchState::Unsent);
        assert_eq!(r.final_snapshot.capacity.inflight_requests, 1);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn prompt_echo_is_required_and_must_equal_the_frozen_token_sequence() {
    for ids in [None, Some(vec![1, 2, 9])] {
        let (_d, mut s, p) = core(2);
        let mut c = choice("exec-1-1", vec![99], "世", Some("stop"));
        if let Some(ids) = ids {
            c["choices"][0]["prompt_token_ids"] = serde_json::json!(ids);
        }
        let wire = [
            identity(&binding(&p, 0)),
            frame(c),
            frame(usage("exec-1-1", 1)),
            b"data: [DONE]\n\n".to_vec(),
        ]
        .concat();
        let server =
            MockServer::start(BTreeMap::from([("exec-1-1".into(), Script::sse(wire))])).await;
        let r = MockHttpRunner::new_profiled_mock(http::config(&server.endpoint), session())
            .unwrap()
            .run_until_idle(&mut s)
            .await
            .unwrap();
        assert_eq!(server.count(), 1);
        assert_eq!(
            r.streams[0].protocol,
            ProtocolStatus::IncompleteProtocol(StreamFailure::PromptMismatch)
        );
        assert_eq!(
            s.plan_state("plan-1").unwrap().unwrap().executions[0].generated_tokens,
            0
        );
    }
}

#[tokio::test]
async fn entire_engine_profile_is_bound_to_signed_policy_before_any_network_dispatch() {
    let (_d, mut s, _p) = core(1);
    let cfg = VllmHttpConfig {
        transport: http::config("https://fixture.chutes.ai/scheduler/completions"),
        session: session(),
    };
    let runner = VllmHttpRunner::new(cfg, "synthetic-fixture-token").unwrap();
    assert!(matches!(
        runner.run_until_idle(&mut s).await,
        Err(Error::ConfigMismatch)
    ));
    assert_eq!(
        s.plan_state("plan-1").unwrap().unwrap().executions[0].dispatch,
        DispatchState::Unsent
    );
    let original = session();
    let mut changed = original.clone();
    changed.profile.image_ref = "different-image".into();
    changed.profile_digest = changed.profile.computed_digest().unwrap();
    assert_ne!(
        original.scheduler_policy_version(),
        changed.scheduler_policy_version()
    );
}
