mod common;
#[path = "common/http.rs"]
mod http;
use common::*;
use flex_scheduler::*;
use http::{MockServer, Script, Step, choice, frame, success, usage};
use serde_json::json;
use std::{collections::BTreeMap, sync::Arc, time::Duration};
use tokio::sync::Notify;

fn core(count: u32) -> (tempfile::TempDir, std::path::PathBuf, Scheduler) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("phase2.sqlite");
    let mut s = Scheduler::open(&path, config()).unwrap();
    s.activate(activation("mock-epoch-1")).unwrap();
    s.register(plan(1, GENESIS, count)).unwrap();
    (dir, path, s)
}

#[test]
fn framing_is_identical_at_every_byte_boundary_and_handles_bom_crlf_cr_multiline() {
    let wire = "\u{feff}: hello\r\nid: ignored\r\nretry: 0\r\ndata: {\r\ndata: \"word\":\"世界\"}\r\n\r\ndata: [DONE]\r\r".as_bytes();
    for split in 0..=wire.len() {
        let mut parser = SseDecoder::new(1024, 4096);
        let first = parser.feed(&wire[..split]);
        let second = parser.feed(&wire[split..]);
        assert!(first.failure.is_none() && second.failure.is_none());
        let events: Vec<_> = first.events.into_iter().chain(second.events).collect();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].data, "{\n\"word\":\"世界\"}".as_bytes());
        assert_eq!(events[1].data, b"[DONE]");
        assert!(parser.finish().is_ok());
    }
}

#[test]
fn framing_bounds_preserve_valid_prefix_events_and_reject_bad_utf8_or_eof() {
    let mut parser = SseDecoder::new(16, 32);
    let output = parser.feed(b"data: good\n\ndata: 12345678901234567890");
    assert_eq!(output.events.len(), 1);
    assert_eq!(output.failure, Some(StreamFailure::LineTooLarge));
    let mut parser = SseDecoder::new(16, 20);
    assert_eq!(
        parser.feed(b":12345678\n:12345678\n:12345678\n").failure,
        Some(StreamFailure::EventTooLarge)
    );
    let mut parser = SseDecoder::new(16, 32);
    assert_eq!(
        parser.feed(b"data: \xff\n\n").failure,
        Some(StreamFailure::InvalidUtf8)
    );
    let mut parser = SseDecoder::new(128, 256);
    parser.feed(b"data: {}\n");
    assert_eq!(parser.finish(), Err(StreamFailure::TruncatedEvent));
}

#[test]
fn completion_validation_prioritizes_whole_event_errors_and_known_duplicate_keys() {
    let r = request(1, 1);
    let mut bad = choice("exec-1-1", vec![99], "", None);
    bad["error"] = json!({"message":"synthetic failure"});
    let duplicate = b"{\"id\":\"wrong\",\"id\":\"cmpl-exec-1-1\",\"object\":\"text_completion\",\"model\":\"mock-model\",\"choices\":[{\"index\":0,\"text\":\"\",\"token_ids\":[99],\"finish_reason\":null}]}".to_vec();
    for bytes in [serde_json::to_vec(&bad).unwrap(), duplicate] {
        let mut parser = CompletionDecoder::new(&r, "mock-model", 1024);
        assert!(
            parser
                .accept(SseEvent {
                    event_type: String::new(),
                    data: bytes
                })
                .is_err()
        );
        assert_eq!(parser.generated_tokens, 0);
        assert!(!parser.terminal);
    }
    let mut combined = choice("exec-1-1", vec![99], "", Some("stop"));
    combined["usage"] = json!({"prompt_tokens":3,"completion_tokens":9,"total_tokens":12});
    let mut parser = CompletionDecoder::new(&r, "mock-model", 1024);
    assert_eq!(
        parser
            .accept(SseEvent {
                event_type: String::new(),
                data: serde_json::to_vec(&combined).unwrap()
            })
            .err(),
        Some(StreamFailure::Usage)
    );
    assert!(!parser.terminal);
    assert_eq!(parser.generated_tokens, 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn actual_chunked_http_preserves_inputs_and_supports_fragmented_utf8() {
    let wire = success("exec-1-1");
    let mut script = Script::sse(vec![]);
    script.steps = wire.chunks(1).map(|b| Step::Bytes(b.to_vec())).collect();
    let server = MockServer::start(BTreeMap::from([("exec-1-1".into(), script)])).await;
    let (_dir, path, mut s) = core(1);
    let report = MockHttpRunner::new(http::config(&server.endpoint))
        .unwrap()
        .run_until_idle(&mut s)
        .await
        .unwrap();
    assert_eq!(report.streams[0].protocol, ProtocolStatus::CompleteProtocol);
    assert_eq!(
        report.streams[0].usage.as_ref().unwrap().completion_tokens,
        1
    );
    assert_eq!(report.streams[0].text_bytes, 3);
    assert_eq!(server.count(), 1);
    let requests = server.captures.lock().unwrap();
    let captured = &requests[0];
    assert_eq!(captured.target, "POST /v1/completions HTTP/1.1");
    let body = &captured.body;
    assert_eq!(body["prompt"], json!([1, 2, 3]));
    assert_eq!(body["max_tokens"], 8);
    assert_eq!(body["return_token_ids"], true);
    assert_eq!(body["echo"], false);
    assert_eq!(body["add_special_tokens"], false);
    assert_eq!(body["top_p"], 1.0);
    assert_eq!(body["temperature"], 0.0);
    assert_eq!(body["cache_salt"], "public-synthetic-fixture");
    for field in ["budget", "priority_bid", "priority_payment", "hold_id"] {
        assert!(body.get(field).is_none());
    }
    assert!(!captured.headers.to_lowercase().contains("last-event-id"));
    drop(requests);
    let view = s.plan_state("plan-1").unwrap().unwrap();
    assert!(view.executions[0].stream_report.is_some());
    assert_eq!(view.executions[0].result, ResultState::Pending);
    assert_eq!(s.snapshot().unwrap(), s.replay_snapshot().unwrap());
    drop(s);
    let s = Scheduler::open(path, config()).unwrap();
    assert_eq!(
        s.plan_state("plan-1").unwrap().unwrap().executions[0]
            .stream_report
            .as_ref()
            .unwrap()
            .protocol,
        ProtocolStatus::CompleteProtocol
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mock_http_overlaps_requests_without_waiting_for_previous_completion() {
    let release_a = Arc::new(Notify::new());
    let mut a = Script::sse(vec![]);
    a.steps = vec![
        Step::Bytes(frame(choice("exec-1-1", vec![99], "", None))),
        Step::Wait(release_a.clone()),
        Step::Bytes(
            [
                frame(choice("exec-1-1", vec![], "", Some("stop"))),
                frame(usage("exec-1-1", 1)),
                b"data: [DONE]\n\n".to_vec(),
            ]
            .concat(),
        ),
    ];
    let server = MockServer::start(BTreeMap::from([
        ("exec-1-1".into(), a),
        ("exec-1-2".into(), Script::sse(success("exec-1-2"))),
    ]))
    .await;
    let (_dir, path, mut s) = core(2);
    let runner = MockHttpRunner::new(http::config(&server.endpoint)).unwrap();
    let controller = async {
        tokio::time::timeout(Duration::from_secs(3),async {
            loop {
                let raw=rusqlite::Connection::open(&path).unwrap();
                let found:bool=raw.query_row("SELECT EXISTS(SELECT 1 FROM journal WHERE event_json LIKE '%EXECUTION_TERMINAL%' AND event_json LIKE '%exec-1-2%')",[],|r|r.get(0)).unwrap();
                if found { release_a.notify_one(); break; }
                tokio::time::sleep(Duration::from_millis(2)).await;
            }
        }).await.unwrap();
    };
    let (report, ()) = tokio::join!(runner.run_until_idle(&mut s), controller);
    let report = report.unwrap();
    assert_eq!(report.dispatch_order, ["exec-1-1", "exec-1-2"]);
    assert!(
        report
            .streams
            .iter()
            .all(|r| r.protocol == ProtocolStatus::CompleteProtocol)
    );
    let events = s.events_after(0, 1000).unwrap();
    let b_terminal = events
        .iter()
        .find(|e| {
            e.kind == EventKind::ExecutionTerminal
                && e.binding.as_ref().unwrap().execution_id == "exec-1-2"
        })
        .unwrap()
        .event_seq;
    let a_terminal = events
        .iter()
        .find(|e| {
            e.kind == EventKind::ExecutionTerminal
                && e.binding.as_ref().unwrap().execution_id == "exec-1-1"
        })
        .unwrap()
        .event_seq;
    assert!(b_terminal < a_terminal);
    assert_eq!(server.count(), 2);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn invalid_first_events_never_open_gate_or_dispatch_the_next_request() {
    let mut wrong_id = choice("exec-1-1", vec![99], "", None);
    wrong_id["id"] = "cmpl-other".into();
    let mut wrong_choice = choice("exec-1-1", vec![99], "", None);
    wrong_choice["choices"][0]["index"] = 1.into();
    let mut wrong_prompt = choice("exec-1-1", vec![99], "", None);
    wrong_prompt["choices"][0]["prompt_token_ids"] = json!([1, 2, 4]);
    let mut root_error = choice("exec-1-1", vec![99], "", None);
    root_error["error"] = json!({"message":"public synthetic error"});
    let mut error_reason = choice("exec-1-1", vec![99], "", Some("error"));
    error_reason["choices"][0]["text"] = "".into();
    let inputs = vec![
        frame(wrong_id),
        frame(wrong_choice),
        frame(wrong_prompt),
        frame(root_error),
        frame(error_reason),
        frame(choice("exec-1-1", vec![1024], "", None)),
        frame(choice("exec-1-1", vec![], "echo cannot be progress", None)),
        b"data: [DONE]\n\n".to_vec(),
        b"data: {broken}\n\n".to_vec(),
        b"event: error\ndata: {}\n\n".to_vec(),
    ];
    for wire in inputs {
        let server =
            MockServer::start(BTreeMap::from([("exec-1-1".into(), Script::sse(wire))])).await;
        let (_dir, _path, mut s) = core(2);
        let report = MockHttpRunner::new(http::config(&server.endpoint))
            .unwrap()
            .run_until_idle(&mut s)
            .await
            .unwrap();
        assert_eq!(report.final_snapshot.mode, Mode::RecoveryRequired);
        assert_eq!(report.blocked, None);
        assert_eq!(server.count(), 1);
        let view = s.plan_state("plan-1").unwrap().unwrap();
        assert_eq!(view.executions[0].gate, GateState::Closed);
        assert_eq!(view.executions[1].dispatch, DispatchState::Unsent);
        assert_eq!(report.final_snapshot.capacity.inflight_requests, 1);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn metadata_and_prompt_ids_are_not_progress_and_eof_is_not_terminal() {
    let mut metadata = choice("exec-1-1", vec![], "", None);
    metadata["choices"][0]["prompt_token_ids"] = json!([1, 2, 3]);
    let server = MockServer::start(BTreeMap::from([(
        "exec-1-1".into(),
        Script::sse([b": heartbeat\n\n".to_vec(), frame(metadata)].concat()),
    )]))
    .await;
    let (_dir, _path, mut s) = core(2);
    let report = MockHttpRunner::new(http::config(&server.endpoint))
        .unwrap()
        .run_until_idle(&mut s)
        .await
        .unwrap();
    assert_eq!(
        report.streams[0].protocol,
        ProtocolStatus::IncompleteProtocol(StreamFailure::MissingTerminal)
    );
    assert_eq!(
        s.plan_state("plan-1").unwrap().unwrap().executions[0].gate,
        GateState::Closed
    );
    assert_eq!(server.count(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn terminal_proof_survives_missing_usage_done_or_malformed_trailing_events() {
    let terminal = frame(choice("exec-1-1", vec![], "", Some("stop")));
    let cases = vec![
        (terminal.clone(), StreamFailure::MissingUsage),
        (
            [terminal.clone(), frame(usage("exec-1-1", 0))].concat(),
            StreamFailure::MissingDone,
        ),
        (
            [terminal.clone(), b"data: [DONE]\n\n".to_vec()].concat(),
            StreamFailure::MissingUsage,
        ),
        (
            [terminal.clone(), b"data: {broken}\n\n".to_vec()].concat(),
            StreamFailure::InvalidJson,
        ),
        (
            [terminal.clone(), b"data: ".to_vec(), vec![b'a'; 20_000]].concat(),
            StreamFailure::LineTooLarge,
        ),
    ];
    for (wire, failure) in cases {
        let server =
            MockServer::start(BTreeMap::from([("exec-1-1".into(), Script::sse(wire))])).await;
        let (_dir, _path, mut s) = core(1);
        let report = MockHttpRunner::new(http::config(&server.endpoint))
            .unwrap()
            .run_until_idle(&mut s)
            .await
            .unwrap();
        assert_eq!(
            report.streams[0].protocol,
            ProtocolStatus::IncompleteProtocol(failure)
        );
        let view = s.plan_state("plan-1").unwrap().unwrap();
        assert_eq!(view.executions[0].dispatch, DispatchState::Terminal);
        assert_eq!(view.executions[0].gate, GateState::SatisfiedByTerminal);
        assert_eq!(report.final_snapshot.capacity.inflight_requests, 0);
        assert_eq!(report.final_snapshot.mode, Mode::Active);
        assert_eq!(view.executions[0].result, ResultState::Pending);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn http_errors_redirects_and_disconnects_are_never_retried() {
    for status in [302, 400, 429, 500, 502, 503] {
        let target = MockServer::start(BTreeMap::new()).await;
        let script = Script {
            status,
            headers: vec![("Location".into(), target.endpoint.clone())],
            steps: vec![],
            header_delay_ms: 0,
        };
        let server = MockServer::start(BTreeMap::from([("exec-1-1".into(), script)])).await;
        let (_dir, _path, mut s) = core(2);
        let runner = MockHttpRunner::new(http::config(&server.endpoint)).unwrap();
        let report = runner.run_until_idle(&mut s).await.unwrap();
        assert_eq!(
            report.streams[0].protocol,
            ProtocolStatus::IncompleteProtocol(StreamFailure::HttpStatus(status))
        );
        assert_eq!(server.count(), 1);
        assert_eq!(target.count(), 0);
        assert!(matches!(
            runner.run_until_idle(&mut s).await,
            Err(Error::NotActive)
        ));
        assert_eq!(server.count(), 1);
    }
    let mut script = Script::sse(vec![]);
    script.steps = vec![Step::AbruptClose];
    let server = MockServer::start(BTreeMap::from([("exec-1-1".into(), script)])).await;
    let (_dir, _path, mut s) = core(1);
    let report = MockHttpRunner::new(http::config(&server.endpoint))
        .unwrap()
        .run_until_idle(&mut s)
        .await
        .unwrap();
    assert_eq!(
        report.streams[0].protocol,
        ProtocolStatus::IncompleteProtocol(StreamFailure::Connection)
    );
    assert_eq!(server.count(), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn response_headers_and_wire_budgets_are_enforced() {
    for headers in [
        vec![("Content-Type".into(), "application/json".into())],
        vec![
            ("Content-Type".into(), "text/event-stream".into()),
            ("Content-Encoding".into(), "gzip".into()),
        ],
    ] {
        let script = Script {
            status: 200,
            headers,
            steps: vec![],
            header_delay_ms: 0,
        };
        let server = MockServer::start(BTreeMap::from([("exec-1-1".into(), script)])).await;
        let (_dir, _path, mut s) = core(1);
        let report = MockHttpRunner::new(http::config(&server.endpoint))
            .unwrap()
            .run_until_idle(&mut s)
            .await
            .unwrap();
        assert_eq!(report.final_snapshot.mode, Mode::RecoveryRequired);
    }
    let server = MockServer::start(BTreeMap::from([(
        "exec-1-1".into(),
        Script::sse(b": ping\n\n".repeat(20)),
    )]))
    .await;
    let mut c = http::config(&server.endpoint);
    c.max_line_bytes = 32;
    c.max_event_bytes = 32;
    c.max_stream_bytes = 50;
    let (_dir, _path, mut s) = core(1);
    let report = MockHttpRunner::new(c)
        .unwrap()
        .run_until_idle(&mut s)
        .await
        .unwrap();
    assert!(matches!(
        report.streams[0].protocol,
        ProtocolStatus::IncompleteProtocol(StreamFailure::StreamTooLarge)
    ));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn headers_first_progress_idle_and_total_deadlines_stop_without_releasing_unknown() {
    for phase in [
        TimeoutPhase::Headers,
        TimeoutPhase::FirstProgress,
        TimeoutPhase::Idle,
        TimeoutPhase::Total,
    ] {
        let mut script = Script::sse(vec![]);
        let mut cfg = http::config("http://127.0.0.1:1/v1/completions");
        cfg.first_progress_timeout_ms = 500;
        cfg.idle_timeout_ms = 500;
        cfg.total_timeout_ms = 800;
        match phase {
            TimeoutPhase::Headers => {
                script.header_delay_ms = 200;
                cfg.first_progress_timeout_ms = 40;
            }
            TimeoutPhase::FirstProgress => {
                cfg.first_progress_timeout_ms = 50;
                script.steps = (0..30)
                    .flat_map(|_| [Step::Bytes(b": heartbeat\n\n".to_vec()), Step::Delay(10)])
                    .collect();
            }
            TimeoutPhase::Idle => {
                cfg.idle_timeout_ms = 40;
                script.steps = vec![
                    Step::Bytes(frame(choice("exec-1-1", vec![99], "", None))),
                    Step::Delay(200),
                ];
            }
            TimeoutPhase::Total => {
                cfg.total_timeout_ms = 100;
                cfg.first_progress_timeout_ms = 100;
                script.steps = vec![Step::Bytes(frame(choice("exec-1-1", vec![99], "", None)))];
                script.steps.extend(
                    (0..30)
                        .flat_map(|_| [Step::Bytes(b": heartbeat\n\n".to_vec()), Step::Delay(10)]),
                );
            }
        }
        let server = MockServer::start(BTreeMap::from([("exec-1-1".into(), script)])).await;
        cfg.endpoint = server.endpoint.clone();
        let (_dir, _path, mut s) = core(1);
        let report = MockHttpRunner::new(cfg)
            .unwrap()
            .run_until_idle(&mut s)
            .await
            .unwrap();
        assert_eq!(
            report.streams[0].protocol,
            ProtocolStatus::IncompleteProtocol(StreamFailure::Timeout(phase))
        );
        assert_eq!(report.final_snapshot.mode, Mode::RecoveryRequired);
        assert_eq!(report.final_snapshot.capacity.inflight_requests, 1);
        assert_eq!(server.count(), 1);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancelling_the_runner_durably_latches_recovery() {
    let mut script = Script::sse(vec![]);
    script.steps = vec![
        Step::Bytes(frame(choice("exec-1-1", vec![99], "", None))),
        Step::Delay(1000),
    ];
    let server = MockServer::start(BTreeMap::from([("exec-1-1".into(), script)])).await;
    let (_dir, path, mut s) = core(1);
    let runner = MockHttpRunner::new(http::config(&server.endpoint)).unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(100), runner.run_until_idle(&mut s))
            .await
            .is_err()
    );
    assert_eq!(s.snapshot().unwrap().mode, Mode::RecoveryRequired);
    assert_eq!(s.snapshot().unwrap().capacity.inflight_requests, 1);
    assert!(matches!(
        runner.run_until_idle(&mut s).await,
        Err(Error::NotActive)
    ));
    drop(s);
    let s = Scheduler::open(path, config()).unwrap();
    assert_eq!(
        s.plan_state("plan-1").unwrap().unwrap().executions[0].dispatch,
        DispatchState::Unknown
    );
}

#[test]
fn mock_endpoint_restrictions_are_explicit() {
    for endpoint in [
        "https://127.0.0.1:8080/v1/completions",
        "http://192.0.2.1:8080/v1/completions",
        "http://localhost:8080/v1/completions",
        "http://user:secret@127.0.0.1:8080/v1/completions",
        "http://127.0.0.1:8080/other",
        "http://127.0.0.1:8080/v1/completions?q=1",
    ] {
        assert!(MockHttpRunner::new(http::config(endpoint)).is_err());
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn request_and_live_stream_limits_hold_before_another_post() {
    for live_stream_limit in [false, true] {
        let release = Arc::new(Notify::new());
        let first = if live_stream_limit {
            choice("exec-1-1", vec![99], "", Some("stop"))
        } else {
            choice("exec-1-1", vec![99], "", None)
        };
        let mut rest = Vec::new();
        if !live_stream_limit {
            rest.extend(frame(choice("exec-1-1", vec![], "", Some("stop"))));
        }
        rest.extend(frame(usage("exec-1-1", 1)));
        rest.extend(b"data: [DONE]\n\n");
        let mut a = Script::sse(vec![]);
        a.steps = vec![
            Step::Bytes(frame(first)),
            Step::Wait(release.clone()),
            Step::Bytes(rest),
        ];
        let server = MockServer::start(BTreeMap::from([
            ("exec-1-1".into(), a),
            ("exec-1-2".into(), Script::sse(success("exec-1-2"))),
        ]))
        .await;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("limits.sqlite");
        let mut c = config();
        if !live_stream_limit {
            c.max_inflight_requests = 1;
        }
        let mut s = Scheduler::open(&path, c).unwrap();
        s.activate(activation("mock-epoch-1")).unwrap();
        s.register(plan(1, GENESIS, 2)).unwrap();
        let mut h = http::config(&server.endpoint);
        if live_stream_limit {
            h.max_live_streams = 1;
        }
        let runner = MockHttpRunner::new(h).unwrap();
        let controller = async {
            tokio::time::timeout(Duration::from_secs(3), async {
                loop {
                    let raw = rusqlite::Connection::open(&path).unwrap();
                    let found:bool = raw.query_row("SELECT EXISTS(SELECT 1 FROM journal WHERE event_json LIKE '%exec-1-1%' AND (event_json LIKE '%OUTPUT_PROGRESS%' OR event_json LIKE '%EXECUTION_TERMINAL%'))",[],|r|r.get(0)).unwrap();
                    if found { assert_eq!(server.count(), 1); release.notify_one(); break; }
                    tokio::time::sleep(Duration::from_millis(2)).await;
                }
            }).await.unwrap();
        };
        let (report, ()) = tokio::join!(runner.run_until_idle(&mut s), controller);
        assert_eq!(report.unwrap().dispatch_order, ["exec-1-1", "exec-1-2"]);
        assert_eq!(server.count(), 2);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn journal_failure_before_intent_or_progress_prevents_later_posts() {
    for progress_failure in [false, true] {
        let mut a = Script::sse(vec![]);
        a.steps = vec![
            Step::Bytes(frame(choice("exec-1-1", vec![99], "", None))),
            Step::Delay(500),
        ];
        let server = MockServer::start(BTreeMap::from([("exec-1-1".into(), a)])).await;
        let (_dir, path, mut s) = core(2);
        let raw = rusqlite::Connection::open(&path).unwrap();
        let condition = if progress_failure {
            "WHEN instr(NEW.snapshot_json, '\"dispatch\":\"STREAMING\"') > 0"
        } else {
            ""
        };
        raw.execute_batch(&format!("CREATE TRIGGER fail_http BEFORE UPDATE ON metadata {condition} BEGIN SELECT RAISE(ABORT, 'injected phase-two failure'); END;")).unwrap();
        let runner = MockHttpRunner::new(http::config(&server.endpoint)).unwrap();
        assert!(runner.run_until_idle(&mut s).await.is_err());
        assert_eq!(server.count(), if progress_failure { 1 } else { 0 });
        assert!(matches!(s.claim_next(), Err(Error::Poisoned)));
        raw.execute_batch("DROP TRIGGER fail_http").unwrap();
        drop(raw);
        drop(s);
        let s = Scheduler::open(&path, config()).unwrap();
        let view = s.plan_state("plan-1").unwrap().unwrap();
        assert_eq!(view.executions[1].dispatch, DispatchState::Unsent);
        assert_eq!(
            view.executions[0].dispatch,
            if progress_failure {
                DispatchState::Unknown
            } else {
                DispatchState::Unsent
            }
        );
        assert_eq!(view.executions[0].gate, GateState::Closed);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stream_reports_are_idempotent_and_do_not_claim_durable_results() {
    let server = MockServer::start(BTreeMap::from([(
        "exec-1-1".into(),
        Script::sse(success("exec-1-1")),
    )]))
    .await;
    let (_dir, _path, mut s) = core(1);
    let result = MockHttpRunner::new(http::config(&server.endpoint))
        .unwrap()
        .run_until_idle(&mut s)
        .await
        .unwrap();
    let report = result.streams[0].clone();
    let before = s.events_after(0, 1000).unwrap().len();
    assert_eq!(
        s.finish_stream(report.clone()).unwrap(),
        ObservationOutcome::AlreadyRecorded
    );
    assert_eq!(s.events_after(0, 1000).unwrap().len(), before);
    assert_eq!(
        s.plan_state("plan-1").unwrap().unwrap().executions[0].result,
        ResultState::Pending
    );
    let mut conflicting = report;
    conflicting.wire_bytes += 1;
    assert!(s.finish_stream(conflicting).is_err());
    assert!(s.snapshot().unwrap().integrity_fault);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn abrupt_disconnect_after_progress_keeps_unknown_but_after_terminal_keeps_terminal() {
    for terminal_seen in [false, true] {
        let mut script = Script::sse(vec![]);
        script.steps = vec![
            Step::Bytes(frame(choice(
                "exec-1-1",
                vec![99],
                "",
                if terminal_seen { Some("stop") } else { None },
            ))),
            Step::Delay(20),
            Step::AbruptClose,
        ];
        let server = MockServer::start(BTreeMap::from([("exec-1-1".into(), script)])).await;
        let (_dir, _path, mut s) = core(1);
        let result = MockHttpRunner::new(http::config(&server.endpoint))
            .unwrap()
            .run_until_idle(&mut s)
            .await
            .unwrap();
        assert_eq!(
            result.streams[0].protocol,
            ProtocolStatus::IncompleteProtocol(StreamFailure::Connection)
        );
        let view = s.plan_state("plan-1").unwrap().unwrap();
        assert_eq!(
            view.executions[0].dispatch,
            if terminal_seen {
                DispatchState::Terminal
            } else {
                DispatchState::Unknown
            }
        );
        assert_eq!(view.executions[0].gate, GateState::SatisfiedByOutput);
        assert_eq!(
            result.final_snapshot.capacity.inflight_requests,
            if terminal_seen { 0 } else { 1 }
        );
        assert_eq!(server.count(), 1);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn phase_one_committed_journal_remains_readable_and_can_accept_phase_two_events() {
    let fixture: serde_json::Value = serde_json::from_slice(
        &std::fs::read(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/fixtures/phase2/phase1-journal-b5bcc26.json"
        ))
        .unwrap(),
    )
    .unwrap();
    assert_eq!(fixture["source_commit"], "b5bcc26");
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("upgrade.sqlite");
    let raw = rusqlite::Connection::open(&path).unwrap();
    raw.execute_batch("CREATE TABLE journal(event_seq INTEGER PRIMARY KEY, previous_hash TEXT, record_hash TEXT UNIQUE, action_json TEXT, event_json TEXT); CREATE TABLE metadata(singleton INTEGER PRIMARY KEY,config_hash TEXT,head_seq INTEGER,head_hash TEXT,snapshot_json TEXT); PRAGMA user_version=1;").unwrap();
    for row in fixture["metadata"].as_array().unwrap() {
        raw.execute(
            "INSERT INTO metadata VALUES (?1,?2,?3,?4,?5)",
            rusqlite::params![
                row[0].as_i64().unwrap(),
                row[1].as_str().unwrap(),
                row[2].as_i64().unwrap(),
                row[3].as_str().unwrap(),
                row[4].as_str().unwrap()
            ],
        )
        .unwrap();
    }
    for row in fixture["journal"].as_array().unwrap() {
        raw.execute(
            "INSERT INTO journal VALUES (?1,?2,?3,?4,?5)",
            rusqlite::params![
                row[0].as_i64().unwrap(),
                row[1].as_str().unwrap(),
                row[2].as_str().unwrap(),
                row[3].as_str().unwrap(),
                row[4].as_str().unwrap()
            ],
        )
        .unwrap();
    }
    drop(raw);
    let mut s = Scheduler::open(&path, config()).unwrap();
    assert_eq!(s.snapshot().unwrap().mode, Mode::RecoveryRequired);
    assert_eq!(s.snapshot().unwrap().next_plan_seq, 3);
    s.activate(activation("upgrade-epoch-3")).unwrap();
    let one = plan(1, GENESIS, 2);
    let two = plan(2, &one.manifest_hash, 1);
    s.register(plan(3, &two.manifest_hash, 1)).unwrap();
    let server = MockServer::start(BTreeMap::from([(
        "exec-3-1".into(),
        Script::sse(success("exec-3-1")),
    )]))
    .await;
    let result = MockHttpRunner::new(http::config(&server.endpoint))
        .unwrap()
        .run_until_idle(&mut s)
        .await
        .unwrap();
    assert_eq!(result.dispatch_order, ["exec-3-1"]);
    assert_eq!(result.streams[0].protocol, ProtocolStatus::CompleteProtocol);
    assert_eq!(s.snapshot().unwrap(), s.replay_snapshot().unwrap());
}
