use crate::spool::{LocalSpool, NoSpoolFaults};
use crate::state::Action;
use crate::*;
use std::{collections::BTreeSet, path::Path, sync::Arc};

impl Scheduler {
    pub fn open_with_spool(
        path: impl AsRef<Path>,
        config: SchedulerConfig,
        policy: SpoolPolicy,
    ) -> Result<Self> {
        Self::open_with_spool_and_faults(path, config, policy, Arc::new(NoSpoolFaults))
    }

    /// Fault injection is a local test extension, never a network-configured option.
    pub fn open_with_spool_and_faults(
        path: impl AsRef<Path>,
        config: SchedulerConfig,
        policy: SpoolPolicy,
        faults: Arc<dyn SpoolFaults>,
    ) -> Result<Self> {
        let mut scheduler = Self::open(path, config)?;
        if let Some(existing) = &scheduler.state.spool_policy {
            if existing != &policy {
                return Err(Error::ConfigMismatch);
            }
        } else {
            let mut checked = scheduler.state.clone();
            checked.apply(
                &Action::SpoolEnabled {
                    policy: policy.clone(),
                },
                scheduler.config(),
            )?;
        }
        let mut root = scheduler.database_path.as_os_str().to_os_string();
        root.push(".spool");
        let store = LocalSpool::open(
            root.into(),
            policy.clone(),
            &digest("flex-scheduler/config/v1", scheduler.config())?,
            scheduler.state.spool_policy.is_some(),
            faults,
        )?;
        scheduler.spool = Some(store);
        if scheduler.state.spool_policy.is_none() {
            scheduler.commit(Action::SpoolEnabled { policy })?;
        }
        Ok(scheduler)
    }

    pub fn spool_enabled(&self) -> bool {
        self.state.spool_policy.is_some()
    }

    /// Requires trusted freshness/isolation evidence. Does not itself attest it.
    pub fn reconcile_spool(&mut self, evidence_ref: String) -> Result<()> {
        crate::contracts::id(&evidence_ref)?;
        if self.snapshot()?.mode == Mode::Active {
            return Err(Error::Transition("pause before spool reconciliation"));
        }
        self.spool_ready = false;
        let cleanup: Vec<_> = self
            .state
            .executions
            .iter()
            .filter(|(_, r)| r.cleanup_intent.is_some() && r.cleanup_complete != Some(true))
            .map(|(id, _)| id.clone())
            .collect();
        for execution in cleanup {
            self.complete_cleanup(&execution)?;
        }
        let referenced: BTreeSet<_> = self
            .state
            .executions
            .values()
            .filter(|r| r.cleanup_complete != Some(true))
            .filter_map(|r| r.spool_reservation.as_ref().map(|s| s.key.clone()))
            .collect();
        let slots = self
            .spool
            .as_ref()
            .ok_or(Error::Transition("open_with_spool required"))?
            .slots()?;
        for key in slots {
            if !referenced.contains(&key) {
                self.spool.as_ref().unwrap().remove(&key)?;
            }
        }
        let ids: Vec<_> = self
            .state
            .executions
            .iter()
            .filter(|(_, r)| r.spool_reservation.is_some() && r.cleanup_complete != Some(true))
            .map(|(id, _)| id.clone())
            .collect();
        for execution in ids {
            let r = &self.state.executions[&execution];
            // A previously recorded failure requires explicit discard/reconciliation,
            // not repeated reads of a known-missing or corrupt partial file.
            if r.result == ResultState::Unavailable {
                continue;
            }
            let checked = if let Some(metadata) = &r.artifact {
                self.spool
                    .as_ref()
                    .unwrap()
                    .artifact(
                        self.state.binding(&execution)?,
                        r.spool_reservation.as_ref().unwrap(),
                        metadata,
                    )
                    .map(|_| ())
            } else {
                self.spool
                    .as_ref()
                    .unwrap()
                    .prefix(
                        r.spool_reservation.as_ref().unwrap(),
                        r.spool_checkpoint
                            .as_ref()
                            .ok_or(Error::Corrupt("missing checkpoint"))?,
                    )
                    .map(|_| ())
            };
            if let Err(e) = checked {
                self.record_storage_failure(&execution, "spool-reconcile-failed")?;
                return Err(e);
            }
        }
        // A finalized file may predate the failed journal commit of RESULT_DURABLE.
        let resumable: Vec<_> = self
            .state
            .executions
            .iter()
            .filter(|(_, r)| {
                r.result == ResultState::Pending
                    && r.dispatch == DispatchState::Terminal
                    && r.stream_report
                        .as_ref()
                        .is_some_and(|s| s.protocol == ProtocolStatus::CompleteProtocol)
            })
            .map(|(id, _)| id.clone())
            .collect();
        for execution in resumable {
            self.finalize_result(&execution)?;
        }
        self.commit(Action::SpoolReconciled { evidence_ref })?;
        self.spool_ready = true;
        Ok(())
    }

    pub fn observe_delta(
        &mut self,
        observation: Observation,
        text: &str,
    ) -> Result<ObservationOutcome> {
        self.available()?;
        if self.spool.is_none() {
            return Err(Error::Transition("open_with_spool required"));
        }
        let delta_digest = digest("flex-scheduler/result-delta/v1", &text)?;
        let r = self
            .state
            .executions
            .get(&observation.execution_id)
            .ok_or(Error::NotFound)?;
        if let Some(old) = r.observations.get(&observation.source_seq) {
            if old == &digest("flex-scheduler/observation/v1", &observation)?
                && r.delta_digests
                    .as_ref()
                    .and_then(|d| d.get(&observation.source_seq))
                    .map_or(text.is_empty(), |hash| hash == &delta_digest)
            {
                return Ok(ObservationOutcome::AlreadyRecorded);
            }
            self.commit(Action::IntegrityFault {
                reason: "OBSERVATION_SEQUENCE_CONFLICT".into(),
            })?;
            return Err(Error::ObservationConflict);
        }
        let ids = match &observation.observation {
            ObservationKind::OutputProgress {
                generated_token_ids,
            }
            | ObservationKind::ExecutionTerminal {
                generated_token_ids,
                ..
            } => generated_token_ids.as_slice(),
            _ => &[],
        };
        if ids.is_empty() && !text.is_empty() {
            return Err(Error::Invalid("text without generated IDs"));
        }
        if ids.is_empty() {
            return self.observe(observation);
        }
        let late = r.fenced;
        if r.result == ResultState::Unavailable {
            self.commit(Action::Observed {
                observation,
                spool_checkpoint: None,
                delta_digest: Some(delta_digest),
            })?;
            return Ok(if late {
                ObservationOutcome::LateEvidence
            } else {
                ObservationOutcome::Recorded
            });
        }
        let reservation = r
            .spool_reservation
            .as_ref()
            .ok_or(Error::Transition("no physical reservation"))?;
        let cp = r
            .spool_checkpoint
            .as_ref()
            .ok_or(Error::Corrupt("no spool checkpoint"))?;
        // Validate the core transition BEFORE touching a slot. Invalid or late
        // data must never overwrite an already finalized artifact's footer.
        let mut preview = cp.clone();
        preview.used_bytes = preview
            .used_bytes
            .checked_add(8 + 4 * ids.len() as u64)
            .and_then(|n| n.checked_add(text.len() as u64))
            .ok_or(Error::Invalid("result size overflow"))?;
        preview.records += 1;
        preview.generated_tokens += ids.len() as u64;
        preview.text_bytes += text.len() as u64;
        let mut checked = self.state.clone();
        if preview
            .used_bytes
            .checked_add(RESULT_FOOTER_BYTES)
            .is_none_or(|n| n > reservation.capacity)
        {
            let failure = Action::StorageFailed {
                execution_id: observation.execution_id.clone(),
                evidence_ref: "result-reservation-exceeded".into(),
            };
            let progress = Action::Observed {
                observation,
                spool_checkpoint: None,
                delta_digest: Some(delta_digest),
            };
            checked.apply(&failure, self.config())?;
            checked.apply(&progress, self.config())?;
            self.spool_ready = false;
            self.commit(failure)?;
            self.commit(progress)?;
            return Ok(ObservationOutcome::Recorded);
        }
        checked.apply(
            &Action::Observed {
                observation: observation.clone(),
                spool_checkpoint: Some(preview),
                delta_digest: Some(delta_digest.clone()),
            },
            self.config(),
        )?;
        match self
            .spool
            .as_ref()
            .unwrap()
            .append(reservation, cp, text, ids)
        {
            Ok(checkpoint) => {
                self.commit(Action::Observed {
                    observation,
                    spool_checkpoint: Some(checkpoint),
                    delta_digest: Some(delta_digest),
                })?;
                Ok(ObservationOutcome::Recorded)
            }
            Err(_) => {
                self.record_storage_failure(&observation.execution_id, "result-write-failed")?;
                // Keep collecting actual execution evidence while result is unavailable.
                self.commit(Action::Observed {
                    observation,
                    spool_checkpoint: None,
                    delta_digest: Some(delta_digest),
                })?;
                Ok(ObservationOutcome::Recorded)
            }
        }
    }

    pub(crate) fn record_storage_failure(
        &mut self,
        execution_id: &str,
        evidence_ref: &str,
    ) -> Result<()> {
        self.spool_ready = false;
        self.commit(Action::StorageFailed {
            execution_id: execution_id.into(),
            evidence_ref: evidence_ref.into(),
        })
    }

    pub fn finalize_result(&mut self, execution_id: &str) -> Result<ObservationOutcome> {
        self.available()?;
        let r = self
            .state
            .executions
            .get(execution_id)
            .ok_or(Error::NotFound)?;
        if matches!(
            r.result,
            ResultState::DurableComplete | ResultState::HandedOff
        ) {
            if r.cleanup_complete != Some(true) {
                let owner = self.state.request(execution_id)?.owner_ref.clone();
                self.get_result_artifact(execution_id, &owner)?;
            }
            return Ok(ObservationOutcome::AlreadyRecorded);
        }
        if r.result != ResultState::Pending || r.dispatch != DispatchState::Terminal {
            return Err(Error::Transition("result not complete"));
        }
        let report = r
            .stream_report
            .as_ref()
            .filter(|s| s.protocol == ProtocolStatus::CompleteProtocol)
            .ok_or(Error::Transition("protocol not complete"))?;
        let store = self
            .spool
            .as_ref()
            .ok_or(Error::Transition("open_with_spool required"))?;
        let reservation = r
            .spool_reservation
            .as_ref()
            .ok_or(Error::Transition("legacy execution has no spool"))?;
        let result = store.finalize(
            reservation,
            r.spool_checkpoint
                .as_ref()
                .ok_or(Error::Corrupt("missing checkpoint"))?,
            report
                .usage
                .as_ref()
                .ok_or(Error::Transition("missing usage"))?,
        );
        match result {
            Ok(metadata) => {
                self.commit(Action::ResultDurable {
                    execution_id: execution_id.into(),
                    metadata,
                })?;
                Ok(ObservationOutcome::Recorded)
            }
            Err(e) => {
                self.record_storage_failure(execution_id, "result-finalize-failed")?;
                Err(e)
            }
        }
    }

    pub fn get_result_artifact(
        &mut self,
        execution_id: &str,
        owner_ref: &str,
    ) -> Result<ResultArtifact> {
        self.available()?;
        if self.state.request(execution_id)?.owner_ref != owner_ref {
            return Err(Error::Unauthorized);
        }
        let r = self
            .state
            .executions
            .get(execution_id)
            .ok_or(Error::NotFound)?;
        if !matches!(
            r.result,
            ResultState::DurableComplete | ResultState::HandedOff
        ) || r.cleanup_complete == Some(true)
        {
            return Err(Error::Transition("result unavailable or cleaned"));
        }
        let result = self
            .spool
            .as_ref()
            .ok_or(Error::Transition("open_with_spool required"))?
            .artifact(
                self.state.binding(execution_id)?,
                r.spool_reservation.as_ref().unwrap(),
                r.artifact.as_ref().unwrap(),
            );
        if result.is_err() {
            self.record_storage_failure(execution_id, "artifact-verification-failed")?;
        }
        result
    }

    /// The caller is the trusted BitRouter adapter; receipt durability is asserted
    /// by that adapter. Matching an owner string alone is not authentication.
    pub fn ack_result(
        &mut self,
        execution_id: &str,
        owner_ref: &str,
        artifact_digest: &str,
        sink_receipt_ref: &str,
        now_ms: u64,
    ) -> Result<ObservationOutcome> {
        self.available()?;
        if self.state.request(execution_id)?.owner_ref != owner_ref {
            return Err(Error::Unauthorized);
        }
        let r = self
            .state
            .executions
            .get(execution_id)
            .ok_or(Error::NotFound)?;
        if let Some(ack) = &r.handoff {
            if ack.digest == artifact_digest && ack.sink_receipt_ref == sink_receipt_ref {
                return Ok(ObservationOutcome::AlreadyRecorded);
            }
            return Err(Error::Transition("conflicting handoff ACK"));
        }
        let artifact = self.get_result_artifact(execution_id, owner_ref)?;
        if artifact.metadata.digest != artifact_digest {
            return Err(Error::Invalid("handoff digest"));
        }
        let policy = self
            .state
            .spool_policy
            .as_ref()
            .ok_or(Error::Transition("no spool policy"))?;
        let cleanup_after_ms = now_ms
            .checked_add(policy.acknowledged_retention_ms)
            .ok_or(Error::Invalid("retention overflow"))?;
        self.commit(Action::ResultHandedOff {
            execution_id: execution_id.into(),
            ack: HandoffAck {
                digest: artifact_digest.into(),
                sink_receipt_ref: sink_receipt_ref.into(),
                acknowledged_at_ms: now_ms,
                cleanup_after_ms,
            },
        })?;
        Ok(ObservationOutcome::Recorded)
    }

    pub fn collect_results(&mut self, now_ms: u64) -> Result<usize> {
        self.available()?;
        if now_ms > i64::MAX as u64 {
            return Err(Error::Invalid("cleanup clock"));
        }
        let eligible: Vec<_> = self
            .state
            .executions
            .iter()
            .filter(|(_, r)| {
                r.handoff
                    .as_ref()
                    .is_some_and(|a| a.cleanup_after_ms <= now_ms)
                    && r.cleanup_complete != Some(true)
            })
            .map(|(id, _)| id.clone())
            .collect();
        for execution in &eligible {
            if self.state.executions[execution].cleanup_intent.is_none() {
                self.commit(Action::CleanupStarted {
                    execution_id: execution.clone(),
                    intent: CleanupIntent {
                        evidence_ref: "ack-retention-elapsed".into(),
                        unavailable: false,
                    },
                })?;
            }
            self.complete_cleanup(execution)?;
        }
        Ok(eligible.len())
    }

    pub fn discard_unavailable_result(
        &mut self,
        execution_id: &str,
        evidence_ref: String,
    ) -> Result<()> {
        self.available()?;
        let r = self
            .state
            .executions
            .get(execution_id)
            .ok_or(Error::NotFound)?;
        if r.cleanup_complete == Some(true) {
            return Ok(());
        }
        if r.cleanup_intent.is_none() {
            self.commit(Action::CleanupStarted {
                execution_id: execution_id.into(),
                intent: CleanupIntent {
                    evidence_ref,
                    unavailable: true,
                },
            })?;
        }
        self.complete_cleanup(execution_id)
    }

    /// Trusted operator closure for a known-terminal execution whose protocol
    /// never supplied a complete result (e.g. missing usage or [DONE]).
    pub fn declare_result_unavailable(
        &mut self,
        execution_id: &str,
        evidence_ref: String,
    ) -> Result<()> {
        self.commit(Action::ResultUnavailable {
            execution_id: execution_id.into(),
            evidence_ref,
        })
    }

    fn complete_cleanup(&mut self, execution_id: &str) -> Result<()> {
        let r = self
            .state
            .executions
            .get(execution_id)
            .ok_or(Error::NotFound)?;
        if r.cleanup_intent.is_none() || r.dispatch != DispatchState::Terminal {
            return Err(Error::Transition("cleanup intent required"));
        }
        if let Some(reservation) = &r.spool_reservation
            && let Err(e) = self
                .spool
                .as_ref()
                .ok_or(Error::Transition("open_with_spool required"))?
                .remove(&reservation.key)
        {
            self.spool_ready = false;
            self.transport_interrupted("result-cleanup-failed".into())?;
            return Err(e);
        }
        self.commit(Action::ResultCleaned {
            execution_id: execution_id.into(),
        })
    }
}
