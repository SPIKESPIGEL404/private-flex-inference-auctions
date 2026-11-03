use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Usage {
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub total_tokens: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum TimeoutPhase {
    Headers,
    FirstProgress,
    Idle,
    Total,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "detail", rename_all = "SCREAMING_SNAKE_CASE")]
pub enum StreamFailure {
    Timeout(TimeoutPhase),
    Connection,
    HttpStatus(u16),
    ContentType,
    ContentEncoding,
    InvalidUtf8,
    LineTooLarge,
    EventTooLarge,
    StreamTooLarge,
    TruncatedEvent,
    InvalidJson,
    Schema,
    IdentityMismatch,
    PromptMismatch,
    ErrorEvent,
    Choice,
    TokenEvidence,
    OutputLimit,
    Usage,
    UnexpectedAfterTerminal,
    UnexpectedAfterDone,
    MissingTerminal,
    MissingUsage,
    MissingDone,
    CoreRejected,
    WorkerInterrupted,
    EngineIdentity,
}

/// Protocol facts only: COMPLETE_PROTOCOL is not RESULT_DURABLE or delivery.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "status",
    content = "failure",
    rename_all = "SCREAMING_SNAKE_CASE"
)]
pub enum ProtocolStatus {
    CompleteProtocol,
    IncompleteProtocol(StreamFailure),
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StreamReport {
    pub execution_id: String,
    pub engine_epoch: String,
    pub response_id: Option<String>,
    pub protocol: ProtocolStatus,
    pub usage: Option<Usage>,
    pub generated_tokens: u64,
    pub wire_bytes: u64,
    pub text_bytes: u64,
}
