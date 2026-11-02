use crate::{
    ArtifactMetadata, CleanupIntent, Error, ExecutionPlan, ExecutionRequest, HandoffAck,
    ProtocolStatus, Result, SchedulerConfig, SpoolCheckpoint, SpoolPolicy, SpoolReservation,
    StreamReport, canonical_bytes, digest, id,
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
    DurableComplete,
    HandedOff,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artifact: Option<ArtifactMetadata>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub handoff: Option<HandoffAck>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cleanup_complete: Option<bool>,
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
    #[serde(default)]
    pub physical_spool_bytes: u64,
    #[serde(default)]
    pub owner_physical_spool_bytes: BTreeMap<String, u64>,
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
    PhysicalSpoolCapacity,
    OwnerPhysicalSpoolCapacity,
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
    SpoolEnabled,
    SpoolReconciled,
    StorageFailed,
    ResultDurable,
    ResultHandedOff,
    CleanupStarted,
    ResultCleaned,
    ResultUnavailable,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artifact: Option<ArtifactMetadata>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub handoff: Option<HandoffAck>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spool_reservation: Option<SpoolReservation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spool_checkpoint: Option<SpoolCheckpoint>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artifact: Option<ArtifactMetadata>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub handoff: Option<HandoffAck>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cleanup_intent: Option<CleanupIntent>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cleanup_complete: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub storage_failed: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delta_digests: Option<BTreeMap<u64, String>>,
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spool_policy: Option<SpoolPolicy>,
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
        #[serde(default, skip_serializing_if = "Option::is_none")]
        spool_reservation: Option<SpoolReservation>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        spool_checkpoint: Option<SpoolCheckpoint>,
    },
    Observed {
        observation: Observation,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        spool_checkpoint: Option<SpoolCheckpoint>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        delta_digest: Option<String>,
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
    SpoolEnabled {
        policy: SpoolPolicy,
    },
    SpoolReconciled {
        evidence_ref: String,
    },
    StorageFailed {
        execution_id: String,
        evidence_ref: String,
    },
    ResultDurable {
        execution_id: String,
        metadata: ArtifactMetadata,
    },
    ResultHandedOff {
        execution_id: String,
        ack: HandoffAck,
    },
    CleanupStarted {
        execution_id: String,
        intent: CleanupIntent,
    },
    ResultCleaned {
        execution_id: String,
    },
    ResultUnavailable {
        execution_id: String,
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
            spool_policy: None,
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
                if r.cleanup_complete != Some(true) {
                    c.reserved_spool_bytes = add(c.reserved_spool_bytes, q.max_result_bytes)?;
                    let owner = c.owner_spool_bytes.entry(q.owner_ref.clone()).or_default();
                    *owner = add(*owner, q.max_result_bytes)?;
                    if let Some(reservation) = &r.spool_reservation {
                        c.physical_spool_bytes =
                            add(c.physical_spool_bytes, reservation.allocation_bytes)?;
                        let owner = c
                            .owner_physical_spool_bytes
                            .entry(q.owner_ref.clone())
                            .or_default();
                        *owner = add(*owner, reservation.allocation_bytes)?;
                    }
                }
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
                    artifact: r.artifact.clone(),
                    handoff: r.handoff.clone(),
                    cleanup_complete: r.cleanup_complete,
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
        if let Some(policy) = &self.spool_policy {
            let bytes = crate::spool::allocation_bytes(q.max_result_bytes)?;
            if add(used.physical_spool_bytes, bytes)? > policy.max_physical_bytes {
                return Ok(Some(BlockReason::PhysicalSpoolCapacity));
            }
            if add(
                *used
                    .owner_physical_spool_bytes
                    .get(&q.owner_ref)
                    .unwrap_or(&0),
                bytes,
            )? > policy.max_owner_physical_bytes
            {
                return Ok(Some(BlockReason::OwnerPhysicalSpoolCapacity));
            }
        }
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
                if let Some(policy) = &self.spool_policy
                    && plan.ordered_requests.iter().any(|q| {
                        q.max_result_bytes > policy.max_artifact_bytes
                            || crate::spool::allocation_bytes(q.max_result_bytes)
                                .is_ok_and(|n| n > policy.max_owner_physical_bytes)
                    })
                {
                    return Err(Error::Invalid("plan exceeds spool policy"));
                }
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
                            spool_reservation: None,
                            spool_checkpoint: None,
                            artifact: None,
                            handoff: None,
                            cleanup_intent: None,
                            cleanup_complete: None,
                            storage_failed: None,
                            delta_digests: None,
                        },
                    );
                }
            }
            Action::DispatchIntended {
                execution_id,
                engine_epoch,
                spool_reservation,
                spool_checkpoint,
            } => {
                if self.claim_block(c)?.is_some()
                    || self.engine_epoch.as_ref() != Some(engine_epoch)
                    || self.next_request().map(|q| &q.execution_id) != Some(execution_id)
                {
                    return Err(Error::Transition("dispatch eligibility"));
                }
                let count = self.plans[&self.next_plan_seq].request_count;
                if let Some(policy) = &self.spool_policy {
                    let q = self.request(execution_id)?;
                    let reservation = spool_reservation
                        .as_ref()
                        .ok_or(Error::Transition("physical reservation required"))?;
                    let cp = spool_checkpoint
                        .as_ref()
                        .ok_or(Error::Transition("initial checkpoint required"))?;
                    let mut binding = self.binding(execution_id)?;
                    binding.engine_epoch = Some(engine_epoch.clone());
                    if reservation.key != crate::spool::LocalSpool::key(execution_id)?
                        || reservation.capacity != q.max_result_bytes
                        || reservation.capacity > policy.max_artifact_bytes
                        || reservation.allocation_bytes
                            != crate::spool::allocation_bytes(reservation.capacity)?
                        || reservation.binding_digest
                            != digest("flex-scheduler/result-binding/v1", &binding)?
                        || cp.used_bytes != 40
                        || cp.records != 0
                        || cp.generated_tokens != 0
                        || cp.text_bytes != 0
                    {
                        return Err(Error::Invalid("physical reservation binding"));
                    }
                    crate::contracts::decode_hex::<32>(&cp.prefix_digest)?;
                } else if spool_reservation.is_some() || spool_checkpoint.is_some() {
                    return Err(Error::Transition("spool policy absent"));
                }
                let r = self
                    .executions
                    .get_mut(execution_id)
                    .ok_or(Error::NotFound)?;
                if r.dispatch != DispatchState::Unsent {
                    return Err(Error::Transition("already dispatched"));
                }
                r.dispatch = DispatchState::DispatchIntent;
                r.epoch = Some(engine_epoch.clone());
                r.spool_reservation = spool_reservation.clone();
                r.spool_checkpoint = spool_checkpoint.clone();
                self.last_dispatched = Some(execution_id.clone());
                if u64::from(self.next_rank) == count {
                    self.next_plan_seq += 1;
                    self.next_rank = 1;
                } else {
                    self.next_rank += 1;
                }
            }
            Action::Observed {
                observation: o,
                spool_checkpoint,
                delta_digest,
            } => {
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
                if let Some(hash) = delta_digest {
                    crate::contracts::decode_hex::<32>(hash)?;
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
                    if r.spool_reservation.is_some() && r.result == ResultState::Pending {
                        if !tokens.is_empty() && delta_digest.is_none() {
                            return Err(Error::Transition("result delta digest required"));
                        }
                        let previous = r
                            .spool_checkpoint
                            .as_ref()
                            .ok_or(Error::Corrupt("spool checkpoint missing"))?;
                        let cp = spool_checkpoint
                            .as_ref()
                            .ok_or(Error::Transition("durable result checkpoint required"))?;
                        let token_count = tokens.len() as u64;
                        let expected = if token_count == 0 {
                            Some(previous.used_bytes)
                        } else {
                            cp.text_bytes
                                .checked_sub(previous.text_bytes)
                                .and_then(|n| n.checked_add(8 + 4 * token_count))
                                .and_then(|n| previous.used_bytes.checked_add(n))
                        };
                        if cp.generated_tokens != total
                            || cp
                                .used_bytes
                                .checked_add(32)
                                .is_none_or(|n| n > r.spool_reservation.as_ref().unwrap().capacity)
                            || cp.records != previous.records + u64::from(token_count > 0)
                            || expected != Some(cp.used_bytes)
                            || (token_count == 0 && cp != previous)
                        {
                            return Err(Error::Invalid("spool checkpoint transition"));
                        }
                        crate::contracts::decode_hex::<32>(&cp.prefix_digest)?;
                        r.spool_checkpoint = Some(cp.clone());
                    } else if spool_checkpoint.is_some() {
                        return Err(Error::Transition("unexpected spool checkpoint"));
                    }
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
                if let Some(hash) = delta_digest {
                    r.delta_digests
                        .get_or_insert_with(BTreeMap::new)
                        .insert(o.source_seq, hash.clone());
                }
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
                        || (r.result == ResultState::Unavailable && r.storage_failed != Some(true))
                        || report.usage.is_none()
                        || report.response_id.as_ref()
                            != Some(&format!("cmpl-{}", report.execution_id)))
                {
                    return Err(Error::Transition(
                        "complete protocol lacks verified evidence",
                    ));
                }
                if r.result == ResultState::Pending
                    && r.spool_checkpoint
                        .as_ref()
                        .is_some_and(|cp| cp.text_bytes != report.text_bytes)
                {
                    return Err(Error::Invalid("stream result text count"));
                }
                r.stream_report = Some(report.clone());
            }
            Action::SpoolEnabled { policy } => {
                policy.validate()?;
                if self.spool_policy.is_some()
                    || self
                        .executions
                        .values()
                        .any(|r| r.dispatch != DispatchState::Unsent)
                    || c.model.result_bytes_per_output_token < 12
                    || c.model.result_overhead_bytes < 72
                    || self.plans.values().any(|p| {
                        p.ordered_requests.iter().any(|q| {
                            q.max_result_bytes > policy.max_artifact_bytes
                                || crate::spool::allocation_bytes(q.max_result_bytes)
                                    .is_ok_and(|n| n > policy.max_owner_physical_bytes)
                        })
                    })
                {
                    return Err(Error::Transition(
                        "spool enable requires compatible profile and no legacy submitted executions",
                    ));
                }
                self.spool_policy = Some(policy.clone());
            }
            Action::SpoolReconciled { evidence_ref } => {
                id(evidence_ref)?;
                if self.spool_policy.is_none() || self.mode == Mode::Active {
                    return Err(Error::Transition(
                        "spool reconciliation requires paused state",
                    ));
                }
            }
            Action::StorageFailed {
                execution_id,
                evidence_ref,
            } => {
                id(evidence_ref)?;
                let r = self
                    .executions
                    .get_mut(execution_id)
                    .ok_or(Error::NotFound)?;
                if r.dispatch != DispatchState::Unsent && r.result != ResultState::HandedOff {
                    r.result = ResultState::Unavailable;
                    r.storage_failed = Some(true);
                }
                self.mode = Mode::RecoveryRequired;
            }
            Action::ResultDurable {
                execution_id,
                metadata,
            } => {
                let r = self
                    .executions
                    .get_mut(execution_id)
                    .ok_or(Error::NotFound)?;
                let cp = r
                    .spool_checkpoint
                    .as_ref()
                    .ok_or(Error::Transition("no durable result prefix"))?;
                let reservation = r
                    .spool_reservation
                    .as_ref()
                    .ok_or(Error::Transition("no result slot"))?;
                let report = r
                    .stream_report
                    .as_ref()
                    .ok_or(Error::Transition("no complete protocol"))?;
                crate::contracts::decode_hex::<32>(&metadata.digest)?;
                if r.dispatch != DispatchState::Terminal
                    || r.result != ResultState::Pending
                    || r.fenced
                    || r.artifact.is_some()
                    || report.protocol != ProtocolStatus::CompleteProtocol
                    || report.usage.as_ref() != Some(&metadata.usage)
                    || metadata.usage.completion_tokens != r.generated_tokens
                    || cp.generated_tokens != r.generated_tokens
                    || cp.text_bytes != report.text_bytes
                    || metadata.used_bytes != cp.used_bytes + 32
                    || metadata.used_bytes > reservation.capacity
                    || metadata.records != cp.records
                    || metadata.artifact_ref != format!("spool:{}", reservation.key)
                {
                    return Err(Error::Transition("result completeness evidence"));
                }
                r.artifact = Some(metadata.clone());
                r.result = ResultState::DurableComplete;
            }
            Action::ResultHandedOff { execution_id, ack } => {
                id(&ack.sink_receipt_ref)?;
                let policy = self
                    .spool_policy
                    .as_ref()
                    .ok_or(Error::Transition("no spool policy"))?;
                let r = self
                    .executions
                    .get_mut(execution_id)
                    .ok_or(Error::NotFound)?;
                if r.result != ResultState::DurableComplete
                    || r.artifact.as_ref().map(|m| &m.digest) != Some(&ack.digest)
                    || ack.acknowledged_at_ms > i64::MAX as u64
                    || ack.cleanup_after_ms > i64::MAX as u64
                    || ack
                        .acknowledged_at_ms
                        .checked_add(policy.acknowledged_retention_ms)
                        != Some(ack.cleanup_after_ms)
                {
                    return Err(Error::Transition("handoff binding or time"));
                }
                r.handoff = Some(ack.clone());
                r.result = ResultState::HandedOff;
            }
            Action::CleanupStarted {
                execution_id,
                intent,
            } => {
                id(&intent.evidence_ref)?;
                let r = self
                    .executions
                    .get_mut(execution_id)
                    .ok_or(Error::NotFound)?;
                if r.dispatch != DispatchState::Terminal
                    || r.cleanup_complete == Some(true)
                    || r.cleanup_intent.is_some()
                    || (intent.unavailable && r.result != ResultState::Unavailable)
                    || (!intent.unavailable && r.result != ResultState::HandedOff)
                {
                    return Err(Error::Transition("cleanup responsibility"));
                }
                r.cleanup_intent = Some(intent.clone());
            }
            Action::ResultCleaned { execution_id } => {
                let r = self
                    .executions
                    .get_mut(execution_id)
                    .ok_or(Error::NotFound)?;
                if r.dispatch != DispatchState::Terminal
                    || r.cleanup_intent.is_none()
                    || r.cleanup_complete == Some(true)
                {
                    return Err(Error::Transition("cleanup intent missing"));
                }
                r.cleanup_complete = Some(true);
            }
            Action::ResultUnavailable {
                execution_id,
                evidence_ref,
            } => {
                id(evidence_ref)?;
                let r = self
                    .executions
                    .get_mut(execution_id)
                    .ok_or(Error::NotFound)?;
                if r.dispatch != DispatchState::Terminal || r.result != ResultState::Pending {
                    return Err(Error::Transition(
                        "only a terminal pending result can be declared unavailable",
                    ));
                }
                r.result = ResultState::Unavailable;
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
            artifact: None,
            handoff: None,
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
            Action::Observed { observation: o, .. } => {
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
            Action::SpoolEnabled { .. } => {
                e.kind = EventKind::SpoolEnabled;
            }
            Action::SpoolReconciled { evidence_ref } => {
                e.kind = EventKind::SpoolReconciled;
                e.evidence_ref = Some(evidence_ref.clone());
            }
            Action::StorageFailed {
                execution_id,
                evidence_ref,
            } => {
                e.kind = EventKind::StorageFailed;
                e.binding = Some(self.binding(execution_id)?);
                e.evidence_ref = Some(evidence_ref.clone());
            }
            Action::ResultDurable {
                execution_id,
                metadata,
            } => {
                e.kind = EventKind::ResultDurable;
                e.binding = Some(self.binding(execution_id)?);
                e.artifact = Some(metadata.clone());
            }
            Action::ResultHandedOff { execution_id, ack } => {
                e.kind = EventKind::ResultHandedOff;
                e.binding = Some(self.binding(execution_id)?);
                e.handoff = Some(ack.clone());
            }
            Action::CleanupStarted {
                execution_id,
                intent,
            } => {
                e.kind = EventKind::CleanupStarted;
                e.binding = Some(self.binding(execution_id)?);
                e.evidence_ref = Some(intent.evidence_ref.clone());
            }
            Action::ResultCleaned { execution_id } => {
                e.kind = EventKind::ResultCleaned;
                e.binding = Some(self.binding(execution_id)?);
            }
            Action::ResultUnavailable {
                execution_id,
                evidence_ref,
            } => {
                e.kind = EventKind::ResultUnavailable;
                e.binding = Some(self.binding(execution_id)?);
                e.evidence_ref = Some(evidence_ref.clone());
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
