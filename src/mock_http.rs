//! Phase-two loopback-only HTTP acceptance adapter. Physical spool is phase three.
use crate::*;
use serde::{Deserialize, Serialize};
use std::{net::IpAddr, time::Duration};
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
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct MockRunReport {
    pub scope: String,
    pub dispatch_order: Vec<String>,
    pub streams: Vec<StreamReport>,
    pub final_snapshot: SchedulerSnapshot,
    pub blocked: Option<BlockReason>,
}

struct Message {
    observation: Observation,
    ack: oneshot::Sender<bool>,
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
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .no_proxy()
            .http1_only()
            .pool_max_idle_per_host(0)
            .no_gzip()
            .no_brotli()
            .no_deflate()
            .no_zstd()
            .connect_timeout(Duration::from_millis(config.connect_timeout_ms))
            .build()
            .map_err(|_| Error::Invalid("HTTP client configuration"))?;
        Ok(Self { config, client })
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
            // Persist pending failures/progress before considering another dispatch.
            while let Ok(message) = rx.try_recv() {
                apply_message(guard.scheduler, message)?;
            }
            while let Some(joined) = tasks.try_join_next() {
                finish_task(guard.scheduler, joined, &mut reports)?;
            }
            if guard.scheduler.snapshot()?.mode == Mode::Active {
                while tasks.len() < self.config.max_live_streams {
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
                    scope: "phase-two-loopback-mock-no-result-spool".into(),
                    dispatch_order,
                    streams: reports,
                    final_snapshot: guard.scheduler.snapshot()?,
                    blocked,
                });
            }
            tokio::select! {
                biased;
                Some(message) = rx.recv() => apply_message(guard.scheduler, message)?,
                Some(joined) = tasks.join_next() => finish_task(guard.scheduler, joined, &mut reports)?,
            }
        }
    }
}

fn apply_message(scheduler: &mut Scheduler, message: Message) -> Result<()> {
    match scheduler.observe(message.observation) {
        Ok(_) => {
            let _ = message.ack.send(true);
            Ok(())
        }
        Err(e) => {
            let _ = message.ack.send(false);
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
    terminal_accepted: bool,
    gate_accepted: bool,
    wire_bytes: u64,
    max_observation_tokens: u64,
}

impl Worker {
    fn new(
        client: reqwest::Client,
        config: MockHttpConfig,
        intent: DispatchIntent,
        tx: mpsc::Sender<Message>,
        vocab_size: u64,
        max_observation_tokens: u64,
    ) -> Self {
        let decoder = CompletionDecoder::new(&intent.request, &config.served_model, vocab_size);
        Self {
            client,
            config,
            intent,
            tx,
            decoder,
            source_seq: 0,
            accepted_tokens: 0,
            terminal_accepted: false,
            gate_accepted: false,
            wire_bytes: 0,
            max_observation_tokens,
        }
    }

    async fn emit(&mut self, observation: ObservationKind) -> bool {
        let (ack, received) = oneshot::channel();
        let observation = Observation {
            execution_id: self.intent.binding.execution_id.clone(),
            engine_epoch: self.intent.binding.engine_epoch.clone().unwrap_or_default(),
            source_seq: self.source_seq + 1,
            evidence_ref: format!("http-observation-{}", self.source_seq + 1),
            observation,
        };
        if self.tx.send(Message { observation, ack }).await.is_err() {
            return false;
        }
        if received.await != Ok(true) {
            return false;
        }
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
            self.emit(ObservationKind::ExecutionUnknown { reason })
                .await;
        }
        self.report(ProtocolStatus::IncompleteProtocol(failure))
    }

    fn report(self, protocol: ProtocolStatus) -> StreamReport {
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
            text_bytes: self.decoder.text_bytes,
        }
    }

    async fn run(mut self) -> StreamReport {
        let start = Instant::now();
        let total = start + Duration::from_millis(self.config.total_timeout_ms);
        let first = start + Duration::from_millis(self.config.first_progress_timeout_ms);
        let request = &self.intent.request;
        let body = serde_json::json!({
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
                    if !self.emit(observation).await {
                        return self.report(ProtocolStatus::IncompleteProtocol(
                            StreamFailure::CoreRejected,
                        ));
                    }
                    self.accepted_tokens += tokens;
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
