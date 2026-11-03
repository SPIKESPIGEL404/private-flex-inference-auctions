//! Loopback-only HTTP acceptance adapter, with optional physical result spool.
use crate::*;
use serde::{Deserialize, Serialize};
use std::{
    net::IpAddr,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    sync::{mpsc, oneshot},
    task::JoinSet,
    time::{Instant, timeout_at},
};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MockHttpConfig {
    pub endpoint: String,
    pub served_model: String,
    pub model_profile_id: String,
    pub connect_timeout_ms: u64,
    pub first_progress_timeout_ms: u64,
    pub idle_timeout_ms: u64,
    pub total_timeout_ms: u64,
    pub max_line_bytes: usize,
    pub max_event_bytes: usize,
    pub max_stream_bytes: u64,
    pub max_live_streams: usize,
    pub event_queue_capacity: usize,
}

pub struct MockHttpRunner {
    config: MockHttpConfig,
    client: reqwest::Client,
    session: Option<VllmSession>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct MockRunReport {
    pub scope: String,
    pub dispatch_order: Vec<String>,
    pub streams: Vec<StreamReport>,
    pub final_snapshot: SchedulerSnapshot,
    pub blocked: Option<BlockReason>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub measurements: Vec<StreamMeasurement>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preflight_us: Option<u64>,
}

/// Monotonic microseconds from runner start. Includes transport and durable I/O;
/// these are NOT GPU-only timings and are not part of the replayed journal.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct StreamMeasurement {
    pub execution_id: String,
    pub dispatch_at_us: u64,
    pub reservation_and_intent_us: u64,
    pub headers_at_us: Option<u64>,
    pub first_token_received_at_us: Option<u64>,
    pub first_progress_committed_at_us: Option<u64>,
    pub terminal_committed_at_us: Option<u64>,
    pub finished_at_us: u64,
}
fn micros(clock: Instant) -> u64 {
    clock.elapsed().as_micros().min(u64::MAX as u128) as u64
}

struct Message {
    observation: Observation,
    text_delta: String,
    ack: oneshot::Sender<Option<u64>>,
}

struct RunGuard<'a> {
    scheduler: &'a mut Scheduler,
    completed: bool,
}

impl Drop for RunGuard<'_> {
    fn drop(&mut self) {
        if !self.completed {
            let _ = self
                .scheduler
                .transport_interrupted("mock-http-run-interrupted".into());
        }
    }
}

impl MockHttpRunner {
    pub fn new(config: MockHttpConfig) -> Result<Self> {
        let url =
            reqwest::Url::parse(&config.endpoint).map_err(|_| Error::Invalid("mock endpoint"))?;
        let ip: IpAddr = url
            .host_str()
            .unwrap_or("")
            .trim_matches(['[', ']'])
            .parse()
            .map_err(|_| Error::Invalid("mock endpoint requires literal loopback IP"))?;
        if url.scheme() != "http"
            || !ip.is_loopback()
            || url.port().is_none()
            || url.path() != "/v1/completions"
            || url.query().is_some()
            || url.fragment().is_some()
            || !url.username().is_empty()
            || url.password().is_some()
        {
            return Err(Error::Invalid(
                "phase-two transport is loopback mock HTTP only",
            ));
        }
        for s in [&config.served_model, &config.model_profile_id] {
            crate::contracts::id(s)?;
        }
        validate_limits(&config)?;
        let client = crate::vllm::http_client(config.connect_timeout_ms, None)?;
        Ok(Self {
            config,
            client,
            session: None,
        })
    }

    pub(crate) fn client(&self) -> &reqwest::Client {
        &self.client
    }

    pub(crate) fn with_session(
        config: MockHttpConfig,
        client: reqwest::Client,
        session: VllmSession,
    ) -> Result<Self> {
        validate_limits(&config)?;
        session.validate()?;
        Ok(Self {
            config,
            client,
            session: Some(session),
        })
    }

    /// Real wire/profile semantics against a loopback fixture, never remote HTTP.
    pub fn new_profiled_mock(config: MockHttpConfig, session: VllmSession) -> Result<Self> {
        session.validate()?;
        let mut runner = Self::new(config)?;
        runner.session = Some(session);
        Ok(runner)
    }

    pub async fn run_until_idle(&self, scheduler: &mut Scheduler) -> Result<MockRunReport> {
        let initial = scheduler.snapshot()?;
        if initial.mode != Mode::Active || initial.capacity.inflight_requests != 0 {
            return Err(Error::NotActive);
        }
        if scheduler.config().model.profile_id != self.config.model_profile_id {
            return Err(Error::ConfigMismatch);
        }
        let vocab_size = scheduler.config().model.vocab_size;
        let max_tokens = scheduler.config().max_observation_tokens;
        let clock = Instant::now();
        let measurements = Arc::new(Mutex::new(Vec::new()));
        let mut guard = RunGuard {
            scheduler,
            completed: false,
        };
        let (tx, mut rx) = mpsc::channel::<Message>(self.config.event_queue_capacity);
        let mut tasks = JoinSet::new();
        let mut dispatch_order = Vec::new();
        let mut reports = Vec::new();
        let mut blocked = None;
        loop {
            // Commit the batch already queued at this decision boundary. A
            // continuously replenished decode queue must not starve new dispatch.
            let pending = rx.len();
            for _ in 0..pending {
                if let Ok(message) = rx.try_recv() {
                    apply_message(guard.scheduler, message, clock)?;
                }
            }
            while let Some(joined) = tasks.try_join_next() {
                finish_task(guard.scheduler, joined, &mut reports)?;
            }
            if guard.scheduler.snapshot()?.mode == Mode::Active {
                while tasks.len() < self.config.max_live_streams {
                    let claim_clock = Instant::now();
                    match guard.scheduler.claim_next()? {
                        ClaimOutcome::Blocked(reason) => {
                            blocked = Some(reason);
                            break;
                        }
                        ClaimOutcome::Intent(intent) => {
                            blocked = None;
                            dispatch_order.push(intent.binding.execution_id.clone());
                            let worker = Worker::new(
                                self.client.clone(),
                                self.config.clone(),
                                *intent,
                                tx.clone(),
                                vocab_size,
                                max_tokens,
                                RunContext {
                                    session: self.session.clone(),
                                    clock,
                                    measurements: measurements.clone(),
                                    reservation_and_intent_us: micros(claim_clock),
                                },
                            );
                            tasks.spawn(worker.run());
                        }
                    }
                }
            } else {
                blocked = None;
            }
            if tasks.is_empty() {
                guard.completed = true;
                return Ok(MockRunReport {
                    scope: if self.session.is_some() {
                        "phase-four-loopback-profiled-mock"
                    } else if guard.scheduler.spool_enabled() {
                        "phase-three-loopback-mock-with-result-spool"
                    } else {
                        "phase-two-loopback-mock-no-result-spool"
                    }
                    .into(),
                    dispatch_order,
                    streams: reports,
                    final_snapshot: guard.scheduler.snapshot()?,
                    blocked,
                    measurements: measurements.lock().unwrap().clone(),
                    preflight_us: None,
                });
            }
            tokio::select! {
                biased;
                Some(message) = rx.recv() => apply_message(guard.scheduler, message, clock)?,
                Some(joined) = tasks.join_next() => finish_task(guard.scheduler, joined, &mut reports)?,
            }
        }
    }
}

fn validate_limits(config: &MockHttpConfig) -> Result<()> {
    let times = [
        config.connect_timeout_ms,
        config.first_progress_timeout_ms,
        config.idle_timeout_ms,
        config.total_timeout_ms,
    ];
    if times.contains(&0)
        || times.iter().any(|&t| t > 3_600_000)
        || config.first_progress_timeout_ms > config.total_timeout_ms
        || config.max_line_bytes == 0
        || config.max_line_bytes > config.max_event_bytes
        || config.max_event_bytes as u64 > config.max_stream_bytes
        || config.max_stream_bytes > 16 * 1024 * 1024
        || !(1..=1024).contains(&config.max_live_streams)
        || !(1..=1024).contains(&config.event_queue_capacity)
    {
        return Err(Error::Invalid("mock transport limits"));
    }
    Ok(())
}

fn apply_message(scheduler: &mut Scheduler, message: Message, clock: Instant) -> Result<()> {
    let result = if scheduler.spool_enabled() {
        scheduler.observe_delta(message.observation, &message.text_delta)
    } else {
        scheduler.observe(message.observation)
    };
    match result {
        Ok(_) => {
            let _ = message.ack.send(Some(micros(clock)));
            Ok(())
        }
        Err(e) => {
            let _ = message.ack.send(None);
            Err(e)
        }
    }
}

fn finish_task(
    scheduler: &mut Scheduler,
    joined: std::result::Result<StreamReport, tokio::task::JoinError>,
    reports: &mut Vec<StreamReport>,
) -> Result<()> {
    let report = joined.map_err(|_| Error::Transition("HTTP worker interrupted"))?;
    scheduler.finish_stream(report.clone())?;
    if scheduler.spool_enabled() && report.protocol == ProtocolStatus::CompleteProtocol {
        let result = scheduler.finalize_result(&report.execution_id);
        // A storage failure has already been journaled and halted new dispatch.
        // Drain the remaining streams; never abandon their execution evidence.
        if result.is_err()
            && !(scheduler.snapshot()?.mode == Mode::RecoveryRequired
                && scheduler.state.executions[&report.execution_id].result
                    == ResultState::Unavailable)
        {
            result?;
        }
    }
    reports.push(report);
    Ok(())
}

struct Worker {
    client: reqwest::Client,
    config: MockHttpConfig,
    intent: DispatchIntent,
    tx: mpsc::Sender<Message>,
    decoder: CompletionDecoder,
    source_seq: u64,
    accepted_tokens: u64,
    accepted_text_bytes: u64,
    terminal_accepted: bool,
    gate_accepted: bool,
    wire_bytes: u64,
    max_observation_tokens: u64,
    session: Option<VllmSession>,
    identity_seen: bool,
    clock: Instant,
    measurements: Arc<Mutex<Vec<StreamMeasurement>>>,
    timing: StreamMeasurement,
    last_commit_at_us: Option<u64>,
}

struct RunContext {
    session: Option<VllmSession>,
    clock: Instant,
    measurements: Arc<Mutex<Vec<StreamMeasurement>>>,
    reservation_and_intent_us: u64,
}
impl Worker {
    fn new(
        client: reqwest::Client,
        config: MockHttpConfig,
        intent: DispatchIntent,
        tx: mpsc::Sender<Message>,
        vocab_size: u64,
        max_observation_tokens: u64,
        context: RunContext,
    ) -> Self {
        let RunContext {
            session,
            clock,
            measurements,
            reservation_and_intent_us,
        } = context;
        let decoder = if session.is_some() {
            CompletionDecoder::new_pinned(&intent.request, &config.served_model, vocab_size)
        } else {
            CompletionDecoder::new(&intent.request, &config.served_model, vocab_size)
        };
        let timing = StreamMeasurement {
            execution_id: intent.binding.execution_id.clone(),
            dispatch_at_us: micros(clock),
            reservation_and_intent_us,
            headers_at_us: None,
            first_token_received_at_us: None,
            first_progress_committed_at_us: None,
            terminal_committed_at_us: None,
            finished_at_us: 0,
        };
        Self {
            client,
            config,
            intent,
            tx,
            decoder,
            source_seq: 0,
            accepted_tokens: 0,
            accepted_text_bytes: 0,
            terminal_accepted: false,
            gate_accepted: false,
            wire_bytes: 0,
            max_observation_tokens,
            session,
            identity_seen: false,
            clock,
            measurements,
            timing,
            last_commit_at_us: None,
        }
    }

    async fn emit(&mut self, observation: ObservationKind, text_delta: String) -> bool {
        let (ack, received) = oneshot::channel();
        let observation = Observation {
            execution_id: self.intent.binding.execution_id.clone(),
            engine_epoch: self.intent.binding.engine_epoch.clone().unwrap_or_default(),
            source_seq: self.source_seq + 1,
            evidence_ref: format!("http-observation-{}", self.source_seq + 1),
            observation,
        };
        if self
            .tx
            .send(Message {
                observation,
                text_delta,
                ack,
            })
            .await
            .is_err()
        {
            return false;
        }
        let Ok(Some(committed_at)) = received.await else {
            return false;
        };
        self.last_commit_at_us = Some(committed_at);
        self.source_seq += 1;
        true
    }

    async fn failure(mut self, failure: StreamFailure) -> StreamReport {
        if !self.terminal_accepted {
            let reason = match failure {
                StreamFailure::Timeout(_) => UnknownReason::Timeout,
                StreamFailure::Connection | StreamFailure::WorkerInterrupted => {
                    UnknownReason::Disconnect
                }
                _ => UnknownReason::ProtocolError,
            };
            self.emit(ObservationKind::ExecutionUnknown { reason }, String::new())
                .await;
        }
        self.report(ProtocolStatus::IncompleteProtocol(failure))
    }

    fn report(mut self, protocol: ProtocolStatus) -> StreamReport {
        self.timing.finished_at_us = micros(self.clock);
        self.measurements.lock().unwrap().push(self.timing);
        StreamReport {
            execution_id: self.intent.binding.execution_id,
            engine_epoch: self.intent.binding.engine_epoch.unwrap_or_default(),
            response_id: self.decoder.response_id,
            usage: self
                .decoder
                .usage
                .filter(|u| u.completion_tokens == self.accepted_tokens),
            protocol,
            generated_tokens: self.accepted_tokens,
            wire_bytes: self.wire_bytes,
            text_bytes: self.accepted_text_bytes,
        }
    }

    async fn run(mut self) -> StreamReport {
        let start = Instant::now();
        let total = start + Duration::from_millis(self.config.total_timeout_ms);
        let first = start + Duration::from_millis(self.config.first_progress_timeout_ms);
        let request = &self.intent.request;
        let mut body = serde_json::json!({
            "model": self.config.served_model, "prompt": request.prompt_token_ids,
            "request_id": request.execution_id, "max_tokens": request.max_output_tokens,
            "n": 1, "stream": true, "stream_options": {"include_usage": true, "continuous_usage_stats": false},
            "return_token_ids": true, "echo": false, "add_special_tokens": false,
            "truncate_prompt_tokens": null, "cache_salt": request.cache_namespace,
            "temperature": f64::from(request.sampling_config.temperature_milli) / 1000.0,
            "top_p": f64::from(request.sampling_config.top_p_millionths) / 1_000_000.0,
            "top_k": if request.sampling_config.top_k == 0 { -1 } else { i64::from(request.sampling_config.top_k) },
            "seed": request.sampling_config.seed, "stop_token_ids": request.sampling_config.stop_token_ids,
            "priority": 0
        });
        if let Some(session) = &self.session {
            body = serde_json::json!({"stream":true,"request_id":request.execution_id,"_flex":{"engine_epoch":session.engine_epoch,"profile_digest":session.profile_digest,"binding":self.intent.binding,"request":self.intent.request}});
        }
        let send = self
            .client
            .post(&self.config.endpoint)
            .header("Accept", "text/event-stream")
            .json(&body)
            .send();
        let mut response = match timeout_at(total.min(first), send).await {
            Ok(Ok(response)) => response,
            Ok(Err(e)) => {
                let f = if e.is_timeout() {
                    StreamFailure::Timeout(TimeoutPhase::Headers)
                } else {
                    StreamFailure::Connection
                };
                return self.failure(f).await;
            }
            Err(_) => {
                return self
                    .failure(StreamFailure::Timeout(TimeoutPhase::Headers))
                    .await;
            }
        };
        self.timing.headers_at_us = Some(micros(self.clock));
        if response.status() != reqwest::StatusCode::OK {
            let status = response.status().as_u16();
            return self.failure(StreamFailure::HttpStatus(status)).await;
        }
        if response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.split(';').next())
            .map(str::trim)
            .is_none_or(|v| !v.eq_ignore_ascii_case("text/event-stream"))
        {
            return self.failure(StreamFailure::ContentType).await;
        }
        if response
            .headers()
            .get("content-encoding")
            .is_some_and(|v| v != "identity")
        {
            return self.failure(StreamFailure::ContentEncoding).await;
        }
        let mut framing = SseDecoder::new(self.config.max_line_bytes, self.config.max_event_bytes);
        let mut idle = Instant::now() + Duration::from_millis(self.config.idle_timeout_ms);
        loop {
            let deadline = if self.gate_accepted {
                total.min(idle)
            } else {
                total.min(idle).min(first)
            };
            let chunk = match timeout_at(deadline, response.chunk()).await {
                Ok(Ok(chunk)) => chunk,
                Ok(Err(_)) => return self.failure(StreamFailure::Connection).await,
                Err(_) => {
                    let now = Instant::now();
                    let phase = if now >= total {
                        TimeoutPhase::Total
                    } else if !self.gate_accepted && now >= first {
                        TimeoutPhase::FirstProgress
                    } else {
                        TimeoutPhase::Idle
                    };
                    return self.failure(StreamFailure::Timeout(phase)).await;
                }
            };
            let Some(chunk) = chunk else {
                if let Err(f) = framing.finish().and_then(|_| self.decoder.finish()) {
                    return self.failure(f).await;
                }
                return self.report(ProtocolStatus::CompleteProtocol);
            };
            if chunk.is_empty() {
                continue;
            }
            idle = Instant::now() + Duration::from_millis(self.config.idle_timeout_ms);
            let remaining = self.config.max_stream_bytes.saturating_sub(self.wire_bytes);
            self.wire_bytes = match self.wire_bytes.checked_add(chunk.len() as u64) {
                Some(n) => n,
                None => return self.failure(StreamFailure::StreamTooLarge).await,
            };
            let exceeded = self.wire_bytes > self.config.max_stream_bytes;
            let feed = framing.feed(&chunk[..chunk.len().min(remaining as usize)]);
            for event in feed.events {
                if let Some(session) = &self.session {
                    if event.event_type == "flex.identity" {
                        let expected = StreamIdentity {
                            engine_epoch: session.engine_epoch.clone(),
                            profile_digest: session.profile_digest.clone(),
                            binding_digest: digest(
                                "flex-scheduler/result-binding/v1",
                                &self.intent.binding,
                            )
                            .unwrap_or_default(),
                        };
                        if self.identity_seen
                            || serde_json::from_slice::<StreamIdentity>(&event.data).ok()
                                != Some(expected)
                        {
                            return self.failure(StreamFailure::EngineIdentity).await;
                        }
                        self.identity_seen = true;
                        continue;
                    }
                    if !self.identity_seen && !event.data.is_empty() {
                        return self.failure(StreamFailure::EngineIdentity).await;
                    }
                }
                let decoded = match self.decoder.accept(event) {
                    Ok(c) => c,
                    Err(f) => return self.failure(f).await,
                };
                if let Some(observation) = decoded.observation {
                    let (tokens, terminal) = match &observation {
                        ObservationKind::OutputProgress {
                            generated_token_ids,
                        } => (generated_token_ids.len() as u64, false),
                        ObservationKind::ExecutionTerminal {
                            generated_token_ids,
                            ..
                        } => (generated_token_ids.len() as u64, true),
                        _ => unreachable!(),
                    };
                    if tokens > self.max_observation_tokens {
                        return self.failure(StreamFailure::TokenEvidence).await;
                    }
                    if tokens > 0 && self.timing.first_token_received_at_us.is_none() {
                        self.timing.first_token_received_at_us = Some(micros(self.clock));
                    }
                    let text_bytes = decoded.text_delta.len() as u64;
                    if !self.emit(observation, decoded.text_delta).await {
                        return self.report(ProtocolStatus::IncompleteProtocol(
                            StreamFailure::CoreRejected,
                        ));
                    }
                    if tokens > 0 && self.timing.first_progress_committed_at_us.is_none() {
                        self.timing.first_progress_committed_at_us = self.last_commit_at_us;
                    }
                    if terminal {
                        self.timing.terminal_committed_at_us = self.last_commit_at_us;
                    }
                    self.accepted_tokens += tokens;
                    self.accepted_text_bytes += text_bytes;
                    self.terminal_accepted |= terminal;
                    self.gate_accepted = true;
                }
            }
            if let Some(f) = feed.failure {
                return self.failure(f).await;
            }
            if exceeded {
                return self.failure(StreamFailure::StreamTooLarge).await;
            }
        }
    }
}
