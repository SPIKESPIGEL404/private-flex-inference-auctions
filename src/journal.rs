use crate::state::{Action, State};
use crate::*;
use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde::Serialize;
use std::fs::{File, OpenOptions, TryLockError};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Local-filesystem, single-writer core. No transport operation occurs here.
/// The advisory OS lock is held for this object's entire lifetime. Do not unlink
/// its sidecar or open the same SQLite database through hard links/network mounts.
pub struct Scheduler {
    connection: Connection,
    _writer_lock: File,
    config: SchedulerConfig,
    state: State,
    head_seq: u64,
    head_hash: String,
    poisoned: bool,
}

#[derive(Serialize)]
struct RecordHash<'a> {
    event_seq: u64,
    previous_hash: &'a str,
    action: &'a Action,
}

impl Scheduler {
    pub(crate) fn config(&self) -> &SchedulerConfig {
        &self.config
    }

    pub(crate) fn transport_interrupted(&mut self, evidence_ref: String) -> Result<()> {
        self.available()?;
        self.commit(Action::TransportInterrupted { evidence_ref })
    }

    pub fn finish_stream(&mut self, report: StreamReport) -> Result<ObservationOutcome> {
        self.available()?;
        let runtime = self
            .state
            .executions
            .get(&report.execution_id)
            .ok_or(Error::NotFound)?;
        if let Some(previous) = &runtime.stream_report {
            if previous == &report {
                return Ok(ObservationOutcome::AlreadyRecorded);
            }
            self.commit(Action::IntegrityFault {
                reason: "STREAM_REPORT_CONFLICT".into(),
            })?;
            return Err(Error::ObservationConflict);
        }
        self.commit(Action::StreamFinished { report })?;
        Ok(ObservationOutcome::Recorded)
    }
    pub fn open(path: impl AsRef<Path>, config: SchedulerConfig) -> Result<Self> {
        config.validate()?;
        let path = private_path(path.as_ref())?;
        let mut lock_name = path.as_os_str().to_os_string();
        lock_name.push(".writer.lock");
        let lock = private_file(Path::new(&lock_name))?;
        match lock.try_lock() {
            Ok(()) => {}
            Err(TryLockError::WouldBlock) => return Err(Error::WriterLocked),
            Err(TryLockError::Error(e)) => return Err(Error::Io(e)),
        }
        // Set private permissions before SQLite creates its WAL/SHM sidecars.
        drop(private_file(&path)?);
        let connection = Connection::open(&path)?;
        connection.busy_timeout(Duration::from_secs(2))?;
        connection.execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
            PRAGMA fullfsync=ON; PRAGMA checkpoint_fullfsync=ON; PRAGMA foreign_keys=ON;",
        )?;
        let version: u32 = connection.pragma_query_value(None, "user_version", |r| r.get(0))?;
        let config_hash = digest("flex-scheduler/config/v1", &config)?;
        if version == 0 {
            let existing: i64 = connection.query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'", [], |r| r.get(0))?;
            if existing != 0 {
                return Err(Error::Corrupt("unrecognized database"));
            }
            let initial = String::from_utf8(canonical_bytes(&State::initial())?)
                .map_err(|_| Error::Corrupt("snapshot encoding"))?;
            let tx = connection.unchecked_transaction()?;
            tx.execute_batch(
                "CREATE TABLE journal (
                event_seq INTEGER PRIMARY KEY CHECK(event_seq > 0),
                previous_hash TEXT NOT NULL, record_hash TEXT NOT NULL UNIQUE,
                action_json TEXT NOT NULL, event_json TEXT NOT NULL);
                CREATE TABLE metadata (
                singleton INTEGER PRIMARY KEY CHECK(singleton=1), config_hash TEXT NOT NULL,
                head_seq INTEGER NOT NULL, head_hash TEXT NOT NULL, snapshot_json TEXT NOT NULL);
                PRAGMA user_version=1;",
            )?;
            tx.execute(
                "INSERT INTO metadata VALUES (1, ?1, 0, ?2, ?3)",
                params![config_hash, GENESIS, initial],
            )?;
            tx.commit()?;
        } else if version != 1 {
            return Err(Error::Corrupt("unsupported journal version"));
        }
        let (state, head_seq, head_hash) = load(&connection, &config)?;
        let mut scheduler = Self {
            connection,
            _writer_lock: lock,
            config,
            state,
            head_seq,
            head_hash,
            poisoned: false,
        };
        scheduler.commit(Action::SessionOpened)?;
        Ok(scheduler)
    }

    fn available(&self) -> Result<()> {
        if self.poisoned {
            Err(Error::Poisoned)
        } else {
            Ok(())
        }
    }

    /// Trusted operator assertion; these references must come from the deployment
    /// runbook. This method does not kill/fence any real engine or verify a TEE.
    pub fn activate(&mut self, evidence: ActivationEvidence) -> Result<()> {
        self.available()?;
        self.commit(Action::Activated { evidence })
    }

    pub fn pause(&mut self, evidence_ref: String) -> Result<()> {
        self.available()?;
        self.commit(Action::Paused { evidence_ref })
    }

    pub fn register_json(&mut self, bytes: &[u8]) -> Result<RegisterOutcome> {
        self.available()?;
        let plan = ExecutionPlan::from_json(bytes, self.config.max_plan_bytes)?;
        self.register(plan)
    }

    pub fn register(&mut self, plan: ExecutionPlan) -> Result<RegisterOutcome> {
        self.available()?;
        plan.validate(&self.config)?;
        let existing = self
            .state
            .plans
            .values()
            .find(|p| p.plan_id == plan.plan_id || p.plan_seq == plan.plan_seq);
        if let Some(p) = existing {
            if p == &plan {
                return Ok(RegisterOutcome::AlreadyRegistered);
            }
            self.commit(Action::IntegrityFault {
                reason: "PLAN_ID_OR_SEQUENCE_CONFLICT".into(),
            })?;
            return Err(Error::PlanConflict);
        }
        let predecessor_conflict = self
            .state
            .plans
            .get(&(plan.plan_seq - 1))
            .is_some_and(|p| p.manifest_hash != plan.predecessor_plan_hash);
        let successor_conflict = self
            .state
            .plans
            .get(&(plan.plan_seq + 1))
            .is_some_and(|p| p.predecessor_plan_hash != plan.manifest_hash);
        if predecessor_conflict || successor_conflict {
            self.commit(Action::IntegrityFault {
                reason: "PLAN_HASH_CHAIN_CONFLICT".into(),
            })?;
            return Err(Error::PlanConflict);
        }
        let seq = plan.plan_seq;
        self.commit(Action::PlanRegistered { plan })?;
        Ok(RegisterOutcome::Registered {
            awaiting_predecessor: seq > self.state.contiguous_through(),
        })
    }

    /// Persist the one-shot dispatch intent before returning it to a future
    /// adapter. Phase one only records logical output-space reservation.
    pub fn claim_next(&mut self) -> Result<ClaimOutcome> {
        self.available()?;
        if let Some(reason) = self.state.claim_block(&self.config)? {
            return Ok(ClaimOutcome::Blocked(reason));
        }
        let request = self
            .state
            .next_request()
            .ok_or(Error::Corrupt("dispatch cursor"))?
            .clone();
        let epoch = self
            .state
            .engine_epoch
            .clone()
            .ok_or(Error::Corrupt("active epoch"))?;
        self.commit(Action::DispatchIntended {
            execution_id: request.execution_id.clone(),
            engine_epoch: epoch,
        })?;
        Ok(ClaimOutcome::Intent(Box::new(DispatchIntent {
            binding: self.state.binding(&request.execution_id)?,
            request,
        })))
    }

    pub fn observe(&mut self, observation: Observation) -> Result<ObservationOutcome> {
        self.available()?;
        let r = self
            .state
            .executions
            .get(&observation.execution_id)
            .ok_or(Error::NotFound)?;
        let hash = digest("flex-scheduler/observation/v1", &observation)?;
        if let Some(old) = r.observations.get(&observation.source_seq) {
            if old == &hash {
                return Ok(ObservationOutcome::AlreadyRecorded);
            }
            self.commit(Action::IntegrityFault {
                reason: "OBSERVATION_SEQUENCE_CONFLICT".into(),
            })?;
            return Err(Error::ObservationConflict);
        }
        let late = r.fenced;
        self.commit(Action::Observed { observation })?;
        Ok(if late {
            ObservationOutcome::LateEvidence
        } else {
            ObservationOutcome::Recorded
        })
    }

    /// Record trusted isolation evidence. The caller must actually isolate the
    /// old process/entrypoint first. An HTTP timeout/healthcheck is not evidence.
    pub fn record_epoch_isolation(
        &mut self,
        engine_epoch: String,
        evidence_ref: String,
    ) -> Result<()> {
        self.available()?;
        self.commit(Action::EpochFenced {
            engine_epoch,
            evidence_ref,
        })
    }

    pub fn snapshot(&self) -> Result<SchedulerSnapshot> {
        self.available()?;
        self.state.snapshot()
    }

    pub fn plan_state(&self, plan_id: &str) -> Result<Option<PlanView>> {
        self.available()?;
        self.state.plan_view(plan_id)
    }

    /// Independent rebuild from the private action log, checking chain and snapshot.
    pub fn replay_snapshot(&self) -> Result<SchedulerSnapshot> {
        self.available()?;
        load(&self.connection, &self.config)?.0.snapshot()
    }

    /// Bounded redacted event replay; polling transport is a later-stage adapter.
    pub fn events_after(&self, after_event_seq: u64, limit: u32) -> Result<Vec<ExecutionEvent>> {
        self.available()?;
        if !(1..=1000).contains(&limit) || after_event_seq > i64::MAX as u64 {
            return Err(Error::Invalid("event cursor or page size"));
        }
        let mut stmt = self.connection.prepare(
            "SELECT event_json FROM journal WHERE event_seq > ?1 ORDER BY event_seq LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![after_event_seq as i64, limit], |r| {
            r.get::<_, String>(0)
        })?;
        rows.map(|s| Ok(serde_json::from_str(&s?)?)).collect()
    }

    fn commit(&mut self, action: Action) -> Result<()> {
        let mut next = self.state.clone();
        next.apply(&action, &self.config)?;
        let seq = self
            .head_seq
            .checked_add(1)
            .filter(|&n| n <= i64::MAX as u64)
            .ok_or(Error::Corrupt("event sequence exhausted"))?;
        let hash = digest(
            "flex-scheduler/record/v1",
            &RecordHash {
                event_seq: seq,
                previous_hash: &self.head_hash,
                action: &action,
            },
        )?;
        let action_json = String::from_utf8(canonical_bytes(&action)?)
            .map_err(|_| Error::Corrupt("action encoding"))?;
        let event_json = String::from_utf8(canonical_bytes(&next.event(
            &action,
            &self.config,
            seq,
            hash.clone(),
        )?)?)
        .map_err(|_| Error::Corrupt("event encoding"))?;
        let snapshot = String::from_utf8(canonical_bytes(&next)?)
            .map_err(|_| Error::Corrupt("snapshot encoding"))?;
        let persisted = (|| -> Result<()> {
            let tx = self
                .connection
                .transaction_with_behavior(TransactionBehavior::Immediate)?;
            tx.execute(
                "INSERT INTO journal VALUES (?1, ?2, ?3, ?4, ?5)",
                params![seq as i64, self.head_hash, hash, action_json, event_json],
            )?;
            let changed = tx.execute("UPDATE metadata SET head_seq=?1, head_hash=?2, snapshot_json=?3 WHERE singleton=1 AND head_seq=?4 AND head_hash=?5",
                params![seq as i64, hash, snapshot, self.head_seq as i64, self.head_hash])?;
            if changed != 1 {
                return Err(Error::Corrupt("journal head changed"));
            }
            tx.commit()?;
            Ok(())
        })();
        if let Err(error) = persisted {
            self.poisoned = true;
            return Err(error);
        }
        self.state = next;
        self.head_seq = seq;
        self.head_hash = hash;
        Ok(())
    }
}

fn load(connection: &Connection, config: &SchedulerConfig) -> Result<(State, u64, String)> {
    let row: Option<(String, i64, String, String)> = connection.query_row(
        "SELECT config_hash, head_seq, head_hash, snapshot_json FROM metadata WHERE singleton=1", [],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))).optional()?;
    let (config_hash, expected_seq, expected_hash, snapshot) =
        row.ok_or(Error::Corrupt("missing metadata"))?;
    let expected_seq =
        u64::try_from(expected_seq).map_err(|_| Error::Corrupt("negative head sequence"))?;
    if config_hash != digest("flex-scheduler/config/v1", config)? {
        return Err(Error::ConfigMismatch);
    }
    let mut state = State::initial();
    let mut seq = 0;
    let mut previous = GENESIS.to_string();
    let mut stmt = connection.prepare("SELECT event_seq, previous_hash, record_hash, action_json, event_json FROM journal ORDER BY event_seq")?;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        let row_seq = u64::try_from(row.get::<_, i64>(0)?)
            .map_err(|_| Error::Corrupt("negative record sequence"))?;
        let prev: String = row.get(1)?;
        let hash: String = row.get(2)?;
        let action_json: String = row.get(3)?;
        let event_json: String = row.get(4)?;
        if row_seq != seq + 1 || prev != previous {
            return Err(Error::Corrupt("record sequence or predecessor"));
        }
        let action: Action =
            serde_json::from_str(&action_json).map_err(|_| Error::Corrupt("action decoding"))?;
        let computed = digest(
            "flex-scheduler/record/v1",
            &RecordHash {
                event_seq: row_seq,
                previous_hash: &prev,
                action: &action,
            },
        )?;
        if hash != computed || canonical_bytes(&action)? != action_json.as_bytes() {
            return Err(Error::Corrupt("record hash"));
        }
        state
            .apply(&action, config)
            .map_err(|_| Error::Corrupt("invalid replay transition"))?;
        if canonical_bytes(&state.event(&action, config, row_seq, hash.clone())?)?
            != event_json.as_bytes()
        {
            return Err(Error::Corrupt("event projection"));
        }
        previous = hash;
        seq = row_seq;
    }
    if seq != expected_seq
        || previous != expected_hash
        || canonical_bytes(&state)? != snapshot.as_bytes()
    {
        return Err(Error::Corrupt("head or materialized snapshot"));
    }
    Ok((state, seq, previous))
}

fn private_path(path: &Path) -> Result<PathBuf> {
    if path.exists() {
        return Ok(path.canonicalize()?);
    }
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    std::fs::create_dir_all(parent)?;
    let name = path.file_name().ok_or(Error::Invalid("database path"))?;
    Ok(parent.canonicalize()?.join(name))
}

fn private_file(path: &Path) -> Result<File> {
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(file)
}
