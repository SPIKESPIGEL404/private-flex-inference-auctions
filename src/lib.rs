//! Phase-one scheduler core. No HTTP, GPU execution, financial state or result files.
//! Observation and recovery methods are trusted-adapter/operator interfaces, not public RPCs.
mod contracts;
mod journal;
mod state;

pub use contracts::*;
pub use journal::Scheduler;
pub use state::*;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("invalid input: {0}")]
    Invalid(&'static str),
    #[error("authorization rejected")]
    Unauthorized,
    #[error("a scheduler writer already holds this journal")]
    WriterLocked,
    #[error("journal integrity check failed: {0}")]
    Corrupt(&'static str),
    #[error("configured identity or profile differs from the journal")]
    ConfigMismatch,
    #[error("scheduler is not active")]
    NotActive,
    #[error("scheduler is unavailable after a persistence error; reopen and reconcile")]
    Poisoned,
    #[error("immutable plan identity conflict; dispatch paused")]
    PlanConflict,
    #[error("execution identity already belongs to another plan")]
    DuplicateExecution,
    #[error("backpressure: {0}")]
    Backpressure(&'static str),
    #[error("execution not found")]
    NotFound,
    #[error("invalid state transition: {0}")]
    Transition(&'static str),
    #[error("observation identity conflict; dispatch paused")]
    ObservationConflict,
    #[error("I/O failure: {0}")]
    Io(#[from] std::io::Error),
    #[error("SQLite failure: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("JSON encoding failure")]
    Json(#[from] serde_json::Error),
}

pub type Result<T> = std::result::Result<T, Error>;
