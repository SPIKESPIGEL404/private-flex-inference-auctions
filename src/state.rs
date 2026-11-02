use crate::{
    Error, ExecutionPlan, ExecutionRequest, ProtocolStatus, Result, SchedulerConfig, StreamReport,
    canonical_bytes, digest, id,
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Mode {
    RecoveryRequired,
    Active,
    Paused,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum DispatchState {
    Unsent,
    DispatchIntent,
    Streaming,
    Unknown,
    Terminal,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum GateState {
    Closed,
    SatisfiedByOutput,
    SatisfiedByTerminal,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ResultState {
    Pending,
    Unavailable,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ActivationEvidence {
    pub engine_epoch: String,
    pub writer_isolation_ref: String,
    pub source_continuity_ref: String,
    pub state_freshness_ref: String,
    pub profile_verified_ref: String,
}

impl ActivationEvidence {
    pub(crate) fn validate(&self) -> Result<()> {
        for s in [
            &self.engine_epoch,
            &self.writer_isolation_ref,
            &self.source_continuity_ref,
            &self.state_freshness_ref,
            &self.profile_verified_ref,
        ] {
            id(s)?;
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum TerminalOutcome {
    Stop,
    Length,
    RejectedBeforeExecution,
    EngineFailure,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum UnknownReason {
    Timeout,
    Disconnect,
    ProtocolError,
}

/// Trusted adapter observations, not raw client claims or SSE parsing results.
/// source_seq counts core observations on the original stream, starting at one.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "SCREAMING_SNAKE_CASE", deny_unknown_fields)]
pub enum ObservationKind {
    OutputProgress {
        generated_token_ids: Vec<u32>,
    },
    /// Delta IDs may accompany the terminal signal in the same backend batch.
    /// They and the terminal fact are committed as one journal action.
    ExecutionTerminal {
        outcome: TerminalOutcome,
        generated_token_ids: Vec<u32>,
    },
    ExecutionUnknown {
        reason: UnknownReason,
    },
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Observation {
    pub execution_id: String,
    pub engine_epoch: String,
    pub source_seq: u64,
    pub evidence_ref: String,
    pub observation: ObservationKind,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExecutionBinding {
    pub plan_id: String,
    pub plan_seq: u64,
    pub manifest_hash: String,
    pub grant_id: String,
    pub execution_id: String,
    pub request_digest: String,
    pub engine_epoch: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExecutionView {
    pub binding: ExecutionBinding,
    pub rank: u32,
    pub dispatch: DispatchState,
    pub gate: GateState,
    pub result: ResultState,
    pub fenced: bool,
    pub generated_tokens: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stream_report: Option<StreamReport>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlanView {
    pub plan_id: String,
    pub plan_seq: u64,
    pub manifest_hash: String,
    pub contiguous: bool,
    pub executions: Vec<ExecutionView>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Capacity {
    pub inflight_requests: u64,
    pub reserved_context_tokens: u64,
    pub reserved_spool_bytes: u64,
    pub owner_spool_bytes: BTreeMap<String, u64>,
    pub queued_requests: u64,
    pub queued_bytes: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SchedulerSnapshot {
    pub mode: Mode,
    pub integrity_fault: bool,
    pub engine_epoch: Option<String>,
    pub next_plan_seq: u64,
    pub next_rank: u32,
    pub contiguous_through: u64,
    pub capacity: Capacity,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RegisterOutcome {
    Registered { awaiting_predecessor: bool },
    AlreadyRegistered,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ObservationOutcome {
    Recorded,
    AlreadyRecorded,
    LateEvidence,
}

/// Returned once only after durable intent commit. The core never sends it.
/// Do not reconstruct/resend a transport operation from replayed events.
#[derive(Clone)]
pub struct DispatchIntent {
    pub binding: ExecutionBinding,
    pub request: ExecutionRequest,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum BlockReason {
    NoPlan,
    MissingPredecessor,
    PreviousGateClosed,
    RequestCapacity,
    ContextCapacity,
    SpoolCapacity,
    OwnerSpoolCapacity,
}

#[derive(Clone)]
pub enum ClaimOutcome {
    Intent(Box<DispatchIntent>),
    Blocked(BlockReason),
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum EventKind {
    DispatchPaused,
    RecoveryCompleted,
    PlanRegistered,
    DispatchIntent,
    OutputProgress,
    ExecutionTerminal,
    ExecutionUnknown,
    IntegrityFault,
    EpochFenced,
    LateEvidence,
    StreamFinished,
}

/// Redacted external feed. Prompt/output token IDs and signatures stay private.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExecutionEvent {
    pub event_seq: u64,
    pub event_id: String,
    pub stream_id: String,
    pub kind: EventKind,
    pub plan_id: Option<String>,
    pub plan_seq: Option<u64>,
    pub manifest_hash: Option<String>,
    pub engine_epoch: Option<String>,
    pub binding: Option<ExecutionBinding>,
    pub affected_executions: Vec<ExecutionBinding>,
    pub evidence_ref: Option<String>,
    pub source_seq: Option<u64>,
    pub generated_token_count: Option<u64>,
    pub terminal_outcome: Option<TerminalOutcome>,
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stream_report: Option<StreamReport>,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct RuntimeExecution {
    pub plan_seq: u64,
    pub rank: u32,
    pub dispatch: DispatchState,
    pub gate: GateState,
    pub epoch: Option<String>,
    pub result: ResultState,
    pub fenced: bool,
    pub generated_tokens: u64,
    pub observations: BTreeMap<u64, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stream_report: Option<StreamReport>,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct State {
    pub mode: Mode,
    pub integrity_fault: bool,
    pub engine_epoch: Option<String>,
    pub used_epochs: BTreeSet<String>,
    pub fenced_epochs: BTreeSet<String>,
    pub next_plan_seq: u64,
    pub next_rank: u32,
    pub last_dispatched: Option<String>,
    pub plans: BTreeMap<u64, ExecutionPlan>,
    pub executions: BTreeMap<String, RuntimeExecution>,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "action",
    rename_all = "SCREAMING_SNAKE_CASE",
    deny_unknown_fields
)]
pub(crate) enum Action {
    SessionOpened,
    Activated {
        evidence: ActivationEvidence,
    },
    PlanRegistered {
        plan: ExecutionPlan,
    },
    DispatchIntended {
        execution_id: String,
        engine_epoch: String,
    },
    Observed {
        observation: Observation,
    },
    Paused {
        evidence_ref: String,
    },
    IntegrityFault {
        reason: String,
    },
    EpochFenced {
        engine_epoch: String,
        evidence_ref: String,
    },
    StreamFinished {
        report: StreamReport,
    },
    TransportInterrupted {
        evidence_ref: String,
    },
}

impl State {
    pub fn initial() -> Self {
        Self {
            mode: Mode::RecoveryRequired,
            integrity_fault: false,
            engine_epoch: None,
            used_epochs: BTreeSet::new(),
            fenced_epochs: BTreeSet::new(),
            next_plan_seq: 1,
            next_rank: 1,
            last_dispatched: None,
            plans: BTreeMap::new(),
            executions: BTreeMap::new(),
        }
    }

    pub fn contiguous_through(&self) -> u64 {
        let mut n = 0;
        while self.plans.contains_key(&(n + 1)) {
            n += 1;
        }
        n
    }

    pub fn request(&self, execution_id: &str) -> Result<&ExecutionRequest> {
        let r = self.executions.get(execution_id).ok_or(Error::NotFound)?;
        Ok(&self.plans[&r.plan_seq].ordered_requests[(r.rank - 1) as usize])
    }

    pub fn binding(&self, execution_id: &str) -> Result<ExecutionBinding> {
        let r = self.executions.get(execution_id).ok_or(Error::NotFound)?;
        let p = &self.plans[&r.plan_seq];
        let q = self.request(execution_id)?;
        Ok(ExecutionBinding {
            plan_id: p.plan_id.clone(),
            plan_seq: p.plan_seq,
            manifest_hash: p.manifest_hash.clone(),
            grant_id: q.grant_id.clone(),
            execution_id: q.execution_id.clone(),
            request_digest: q.request_digest.clone(),
            engine_epoch: r.epoch.clone(),
        })
    }

    pub fn capacity(&self) -> Result<Capacity> {
        let mut c = Capacity::default();
        for (execution_id, r) in &self.executions {
            let q = self.request(execution_id)?;
            if r.dispatch == DispatchState::Unsent {
                c.queued_requests = add(c.queued_requests, 1)?;
                c.queued_bytes = add(c.queued_bytes, canonical_bytes(q)?.len() as u64)?;
            } else {
                c.reserved_spool_bytes = add(c.reserved_spool_bytes, q.max_result_bytes)?;
                let owner = c.owner_spool_bytes.entry(q.owner_ref.clone()).or_default();
                *owner = add(*owner, q.max_result_bytes)?;
                if r.dispatch != DispatchState::Terminal {
                    c.inflight_requests = add(c.inflight_requests, 1)?;
                    c.reserved_context_tokens =
                        add(c.reserved_context_tokens, q.context_reservation)?;
                }
            }
        }
        Ok(c)
    }

    pub fn snapshot(&self) -> Result<SchedulerSnapshot> {
        Ok(SchedulerSnapshot {
            mode: self.mode,
            integrity_fault: self.integrity_fault,
            engine_epoch: self.engine_epoch.clone(),
            next_plan_seq: self.next_plan_seq,
            next_rank: self.next_rank,
            contiguous_through: self.contiguous_through(),
            capacity: self.capacity()?,
        })
    }

    pub fn plan_view(&self, plan_id: &str) -> Result<Option<PlanView>> {
        let Some(p) = self.plans.values().find(|p| p.plan_id == plan_id) else {
            return Ok(None);
        };
        let executions = p
            .ordered_requests
            .iter()
            .map(|q| {
                let r = &self.executions[&q.execution_id];
                Ok(ExecutionView {
                    binding: self.binding(&q.execution_id)?,
                    rank: q.rank,
                    dispatch: r.dispatch,
                    gate: r.gate,
                    result: r.result,
                    fenced: r.fenced,
                    generated_tokens: r.generated_tokens,
                    stream_report: r.stream_report.clone(),
                })
            })
            .collect::<Result<Vec<_>>>()?;
        Ok(Some(PlanView {
            plan_id: p.plan_id.clone(),
            plan_seq: p.plan_seq,
            manifest_hash: p.manifest_hash.clone(),
            contiguous: p.plan_seq <= self.contiguous_through(),
            executions,
        }))
    }

    pub fn next_request(&self) -> Option<&ExecutionRequest> {
        self.plans
            .get(&self.next_plan_seq)?
            .ordered_requests
            .get((self.next_rank - 1) as usize)
    }

    pub fn claim_block(&self, c: &SchedulerConfig) -> Result<Option<BlockReason>> {
        if self.mode != Mode::Active || self.integrity_fault {
            return Err(Error::NotActive);
        }
        if let Some(last) = &self.last_dispatched
            && self.executions[last].gate == GateState::Closed
        {
            return Ok(Some(BlockReason::PreviousGateClosed));
        }
        let Some(q) = self.next_request() else {
            return Ok(Some(
                if self.plans.keys().any(|&s| s > self.next_plan_seq) {
                    BlockReason::MissingPredecessor
                } else {
                    BlockReason::NoPlan
                },
            ));
        };
        if self.next_plan_seq > self.contiguous_through() {
            return Ok(Some(BlockReason::MissingPredecessor));
        }
        let used = self.capacity()?;
        let reason = if used.inflight_requests >= c.max_inflight_requests {
            Some(BlockReason::RequestCapacity)
        } else if add(used.reserved_context_tokens, q.context_reservation)?
            > c.max_reserved_context_tokens
        {
            Some(BlockReason::ContextCapacity)
        } else if add(used.reserved_spool_bytes, q.max_result_bytes)? > c.max_spool_bytes {
            Some(BlockReason::SpoolCapacity)
        } else if add(
            *used.owner_spool_bytes.get(&q.owner_ref).unwrap_or(&0),
            q.max_result_bytes,
        )? > c.max_owner_spool_bytes
        {
            Some(BlockReason::OwnerSpoolCapacity)
        } else {
            None
        };
        Ok(reason)
    }

    pub fn apply(&mut self, action: &Action, c: &SchedulerConfig) -> Result<()> {
        match action {
            Action::SessionOpened => {
                self.mode = Mode::RecoveryRequired;
                for r in self.executions.values_mut() {
                    if matches!(
                        r.dispatch,
                        DispatchState::DispatchIntent | DispatchState::Streaming
                    ) {
                        r.dispatch = DispatchState::Unknown;
                    }
                }
            }
            Action::Activated { evidence } => {
                evidence.validate()?;
                if self.mode == Mode::Active
                    || self.integrity_fault
                    || self.capacity()?.inflight_requests != 0
                    || self.used_epochs.contains(&evidence.engine_epoch)
                {
                    return Err(Error::Transition(
                        "activation requires reconciliation and a fresh epoch",
                    ));
                }
                self.used_epochs.insert(evidence.engine_epoch.clone());
                self.engine_epoch = Some(evidence.engine_epoch.clone());
                self.mode = Mode::Active;
            }
            Action::PlanRegistered { plan } => {
                if self.mode != Mode::Active {
                    return Err(Error::NotActive);
                }
                plan.validate(c)?;
                if self.plans.contains_key(&plan.plan_seq)
                    || self.plans.values().any(|p| p.plan_id == plan.plan_id)
                {
                    return Err(Error::PlanConflict);
                }
                if let Some(prev) = self.plans.get(&(plan.plan_seq - 1))
                    && prev.manifest_hash != plan.predecessor_plan_hash
                {
                    return Err(Error::PlanConflict);
                }
                if let Some(next) = self.plans.get(&(plan.plan_seq + 1))
                    && next.predecessor_plan_hash != plan.manifest_hash
                {
                    return Err(Error::PlanConflict);
                }
                let capacity = self.capacity()?;
                if add(capacity.queued_requests, plan.request_count)? > c.max_queued_requests {
                    return Err(Error::Backpressure("queued requests"));
                }
                let mut bytes = capacity.queued_bytes;
                for q in &plan.ordered_requests {
                    if self.executions.contains_key(&q.execution_id)
                        || self
                            .plans
                            .values()
                            .any(|p| p.ordered_requests.iter().any(|r| r.grant_id == q.grant_id))
                    {
                        return Err(Error::DuplicateExecution);
                    }
                    bytes = add(bytes, canonical_bytes(q)?.len() as u64)?;
                }
                if bytes > c.max_queued_bytes {
                    return Err(Error::Backpressure("queued bytes"));
                }
                self.plans.insert(plan.plan_seq, plan.clone());
                if self
                    .plans
                    .keys()
                    .filter(|&&s| s > self.contiguous_through())
                    .count() as u64
                    > c.max_out_of_order_plans
                {
                    return Err(Error::Backpressure("out-of-order plans"));
                }
                for q in &plan.ordered_requests {
                    self.executions.insert(
                        q.execution_id.clone(),
                        RuntimeExecution {
                            plan_seq: plan.plan_seq,
                            rank: q.rank,
                            dispatch: DispatchState::Unsent,
                            gate: GateState::Closed,
                            epoch: None,
                            result: ResultState::Pending,
                            fenced: false,
                            generated_tokens: 0,
                            observations: BTreeMap::new(),
                            stream_report: None,
                        },
                    );
                }
            }
            Action::DispatchIntended {
                execution_id,
                engine_epoch,
            } => {
                if self.claim_block(c)?.is_some()
                    || self.engine_epoch.as_ref() != Some(engine_epoch)
                    || self.next_request().map(|q| &q.execution_id) != Some(execution_id)
                {
                    return Err(Error::Transition("dispatch eligibility"));
                }
                let count = self.plans[&self.next_plan_seq].request_count;
                let r = self
                    .executions
                    .get_mut(execution_id)
                    .ok_or(Error::NotFound)?;
                if r.dispatch != DispatchState::Unsent {
                    return Err(Error::Transition("already dispatched"));
                }
                r.dispatch = DispatchState::DispatchIntent;
                r.epoch = Some(engine_epoch.clone());
                self.last_dispatched = Some(execution_id.clone());
                if u64::from(self.next_rank) == count {
                    self.next_plan_seq += 1;
                    self.next_rank = 1;
                } else {
                    self.next_rank += 1;
                }
            }
            Action::Observed { observation: o } => {
                id(&o.evidence_ref)?;
                let output_limit = self.request(&o.execution_id)?.max_output_tokens;
                let r = self
                    .executions
                    .get_mut(&o.execution_id)
                    .ok_or(Error::NotFound)?;
                if r.epoch.as_ref() != Some(&o.engine_epoch) || r.dispatch == DispatchState::Unsent
                {
                    return Err(Error::Transition(
                        "observation epoch or undispatched execution",
                    ));
                }
                if o.source_seq != r.observations.len() as u64 + 1 {
                    return Err(Error::Transition("observation sequence"));
                }
                let tokens = match &o.observation {
                    ObservationKind::OutputProgress {
                        generated_token_ids,
                    } => {
                        if generated_token_ids.is_empty() {
                            return Err(Error::Invalid("empty generation progress"));
                        }
                        generated_token_ids.as_slice()
                    }
                    ObservationKind::ExecutionTerminal {
                        generated_token_ids,
                        ..
                    } => generated_token_ids.as_slice(),
                    ObservationKind::ExecutionUnknown { .. } => &[],
                };
                if tokens.len() as u64 > c.max_observation_tokens
                    || tokens.iter().any(|&t| u64::from(t) >= c.model.vocab_size)
                {
                    return Err(Error::Invalid("generated token evidence"));
                }
                if !r.fenced {
                    if r.dispatch == DispatchState::Terminal {
                        return Err(Error::Transition("execution already terminal"));
                    }
                    let total = add(r.generated_tokens, tokens.len() as u64)?;
                    if total > output_limit {
                        return Err(Error::Invalid("output limit exceeded"));
                    }
                    if matches!(
                        &o.observation,
                        ObservationKind::ExecutionTerminal {
                            outcome: TerminalOutcome::RejectedBeforeExecution,
                            ..
                        }
                    ) && total != 0
                    {
                        return Err(Error::Transition(
                            "rejection contradicts observed generation",
                        ));
                    }
                    r.generated_tokens = total;
                    match &o.observation {
                        ObservationKind::OutputProgress { .. } => {
                            if r.gate == GateState::Closed {
                                r.gate = GateState::SatisfiedByOutput;
                            }
                            if r.dispatch != DispatchState::Unknown {
                                r.dispatch = DispatchState::Streaming;
                            }
                        }
                        ObservationKind::ExecutionTerminal {
                            outcome,
                            generated_token_ids,
                        } => {
                            r.dispatch = DispatchState::Terminal;
                            if r.gate == GateState::Closed {
                                r.gate = if generated_token_ids.is_empty() {
                                    GateState::SatisfiedByTerminal
                                } else {
                                    GateState::SatisfiedByOutput
                                };
                            }
                            if matches!(
                                outcome,
                                TerminalOutcome::EngineFailure
                                    | TerminalOutcome::RejectedBeforeExecution
                            ) {
                                r.result = ResultState::Unavailable;
                            }
                        }
                        ObservationKind::ExecutionUnknown { .. } => {
                            r.dispatch = DispatchState::Unknown;
                            self.mode = Mode::RecoveryRequired;
                        }
                    }
                }
                r.observations
                    .insert(o.source_seq, digest("flex-scheduler/observation/v1", o)?);
            }
            Action::Paused { evidence_ref } => {
                id(evidence_ref)?;
                self.mode = Mode::Paused;
            }
            Action::IntegrityFault { .. } => {
                self.mode = Mode::RecoveryRequired;
                self.integrity_fault = true;
            }
            Action::EpochFenced {
                engine_epoch,
                evidence_ref,
            } => {
                id(evidence_ref)?;
                if self.mode != Mode::RecoveryRequired
                    || !self.used_epochs.contains(engine_epoch)
                    || self.fenced_epochs.contains(engine_epoch)
                {
                    return Err(Error::Transition("epoch isolation"));
                }
                for r in self.executions.values_mut() {
                    if r.epoch.as_ref() == Some(engine_epoch)
                        && r.dispatch != DispatchState::Terminal
                    {
                        r.dispatch = DispatchState::Terminal;
                        r.fenced = true;
                        r.result = ResultState::Unavailable;
                        if r.gate == GateState::Closed {
                            r.gate = GateState::SatisfiedByTerminal;
                        }
                    }
                }
                self.fenced_epochs.insert(engine_epoch.clone());
            }
            Action::TransportInterrupted { evidence_ref } => {
                id(evidence_ref)?;
                self.mode = Mode::RecoveryRequired;
                for r in self.executions.values_mut() {
                    if matches!(
                        r.dispatch,
                        DispatchState::DispatchIntent | DispatchState::Streaming
                    ) {
                        r.dispatch = DispatchState::Unknown;
                    }
                }
            }
            Action::StreamFinished { report } => {
                let q = self.request(&report.execution_id)?;
                let expected_prompt = q.prompt_token_ids.len() as u64;
                let r = self
                    .executions
                    .get_mut(&report.execution_id)
                    .ok_or(Error::NotFound)?;
                if r.epoch.as_ref() != Some(&report.engine_epoch)
                    || r.stream_report.is_some()
                    || !matches!(r.dispatch, DispatchState::Terminal | DispatchState::Unknown)
                    || report.generated_tokens != r.generated_tokens
                    || report.text_bytes > report.wire_bytes
                {
                    return Err(Error::Transition(
                        "stream summary identity, count or terminal state",
                    ));
                }
                if let Some(usage) = &report.usage
                    && (usage.prompt_tokens != expected_prompt
                        || usage.completion_tokens != r.generated_tokens
                        || usage.prompt_tokens.checked_add(usage.completion_tokens)
                            != Some(usage.total_tokens))
                {
                    return Err(Error::Invalid("stream usage"));
                }
                if report.protocol == ProtocolStatus::CompleteProtocol
                    && (r.dispatch != DispatchState::Terminal
                        || r.fenced
                        || r.result == ResultState::Unavailable
                        || report.usage.is_none()
                        || report.response_id.as_ref()
                            != Some(&format!("cmpl-{}", report.execution_id)))
                {
                    return Err(Error::Transition(
                        "complete protocol lacks verified evidence",
                    ));
                }
                r.stream_report = Some(report.clone());
            }
        }
        Ok(())
    }

    pub fn event(
        &self,
        action: &Action,
        c: &SchedulerConfig,
        seq: u64,
        hash: String,
    ) -> Result<ExecutionEvent> {
        let mut e = ExecutionEvent {
            event_seq: seq,
            event_id: hash,
            stream_id: c.stream_id.clone(),
            kind: EventKind::DispatchPaused,
            plan_id: None,
            plan_seq: None,
            manifest_hash: None,
            engine_epoch: None,
            binding: None,
            affected_executions: vec![],
            evidence_ref: None,
            source_seq: None,
            generated_token_count: None,
            terminal_outcome: None,
            reason: None,
            stream_report: None,
        };
        match action {
            Action::SessionOpened => {
                e.engine_epoch = self.engine_epoch.clone();
                e.reason = Some("PROCESS_OPENED_RECONCILE_BEFORE_DISPATCH".into());
            }
            Action::Activated { evidence } => {
                e.kind = EventKind::RecoveryCompleted;
                e.engine_epoch = Some(evidence.engine_epoch.clone());
                e.evidence_ref = Some(evidence.state_freshness_ref.clone());
            }
            Action::PlanRegistered { plan } => {
                e.kind = EventKind::PlanRegistered;
                e.plan_id = Some(plan.plan_id.clone());
                e.plan_seq = Some(plan.plan_seq);
                e.manifest_hash = Some(plan.manifest_hash.clone());
            }
            Action::DispatchIntended { execution_id, .. } => {
                e.kind = EventKind::DispatchIntent;
                e.binding = Some(self.binding(execution_id)?);
            }
            Action::Observed { observation: o } => {
                e.binding = Some(self.binding(&o.execution_id)?);
                e.source_seq = Some(o.source_seq);
                e.evidence_ref = Some(o.evidence_ref.clone());
                e.kind = if self.executions[&o.execution_id].fenced {
                    EventKind::LateEvidence
                } else {
                    match &o.observation {
                        ObservationKind::OutputProgress {
                            generated_token_ids,
                        } => {
                            e.generated_token_count = Some(generated_token_ids.len() as u64);
                            EventKind::OutputProgress
                        }
                        ObservationKind::ExecutionTerminal {
                            outcome,
                            generated_token_ids,
                        } => {
                            e.terminal_outcome = Some(outcome.clone());
                            e.generated_token_count = Some(generated_token_ids.len() as u64);
                            EventKind::ExecutionTerminal
                        }
                        ObservationKind::ExecutionUnknown { reason } => {
                            e.reason = Some(format!("{reason:?}"));
                            EventKind::ExecutionUnknown
                        }
                    }
                };
            }
            Action::Paused { evidence_ref } => {
                e.evidence_ref = Some(evidence_ref.clone());
            }
            Action::IntegrityFault { reason } => {
                e.kind = EventKind::IntegrityFault;
                e.reason = Some(reason.clone());
            }
            Action::EpochFenced {
                engine_epoch,
                evidence_ref,
            } => {
                e.kind = EventKind::EpochFenced;
                e.engine_epoch = Some(engine_epoch.clone());
                e.evidence_ref = Some(evidence_ref.clone());
                for (execution_id, r) in &self.executions {
                    if r.fenced && r.epoch.as_ref() == Some(engine_epoch) {
                        e.affected_executions.push(self.binding(execution_id)?);
                    }
                }
            }
            Action::TransportInterrupted { evidence_ref } => {
                e.evidence_ref = Some(evidence_ref.clone());
                e.reason = Some("TRANSPORT_INTERRUPTED".into());
                for (execution_id, r) in &self.executions {
                    if r.dispatch == DispatchState::Unknown {
                        e.affected_executions.push(self.binding(execution_id)?);
                    }
                }
            }
            Action::StreamFinished { report } => {
                e.kind = EventKind::StreamFinished;
                e.binding = Some(self.binding(&report.execution_id)?);
                e.stream_report = Some(report.clone());
            }
        }
        if let Some(b) = &e.binding {
            e.plan_id = Some(b.plan_id.clone());
            e.plan_seq = Some(b.plan_seq);
            e.manifest_hash = Some(b.manifest_hash.clone());
            e.engine_epoch = b.engine_epoch.clone();
        }
        Ok(e)
    }
}

fn add(a: u64, b: u64) -> Result<u64> {
    a.checked_add(b).ok_or(Error::Invalid("capacity overflow"))
}
