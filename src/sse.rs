use crate::{ExecutionRequest, ObservationKind, StreamFailure, TerminalOutcome, Usage};
use serde::Deserialize;

#[derive(Clone)]
pub struct SseEvent {
    pub event_type: String,
    pub data: Vec<u8>,
}

#[derive(Default)]
pub struct SseFeed {
    pub events: Vec<SseEvent>,
    pub failure: Option<StreamFailure>,
}

/// Incremental, byte-oriented framing. A later framing error never discards an
/// already delimited prefix event from the same network read.
pub struct SseDecoder {
    line: Vec<u8>,
    data: Vec<u8>,
    event_type: String,
    after_cr: bool,
    first_line: bool,
    event_bytes: usize,
    max_line: usize,
    max_event: usize,
    failed: bool,
}

impl SseDecoder {
    pub fn new(max_line: usize, max_event: usize) -> Self {
        Self {
            line: vec![],
            data: vec![],
            event_type: String::new(),
            after_cr: false,
            first_line: true,
            event_bytes: 0,
            max_line,
            max_event,
            failed: false,
        }
    }

    pub fn feed(&mut self, bytes: &[u8]) -> SseFeed {
        let mut output = SseFeed::default();
        if self.failed {
            output.failure = Some(StreamFailure::Schema);
            return output;
        }
        for &byte in bytes {
            if self.after_cr {
                self.after_cr = false;
                if byte == b'\n' {
                    continue;
                }
            }
            self.event_bytes += 1;
            let result = if self.event_bytes > self.max_event {
                Err(StreamFailure::EventTooLarge)
            } else if byte == b'\r' || byte == b'\n' {
                self.after_cr = byte == b'\r';
                self.finish_line(&mut output.events)
            } else if self.line.len() >= self.max_line {
                Err(StreamFailure::LineTooLarge)
            } else {
                self.line.push(byte);
                Ok(())
            };
            if let Err(failure) = result {
                self.failed = true;
                output.failure = Some(failure);
                break;
            }
        }
        output
    }

    fn finish_line(&mut self, output: &mut Vec<SseEvent>) -> Result<(), StreamFailure> {
        let mut line = std::mem::take(&mut self.line);
        if self.first_line {
            self.first_line = false;
            if line.starts_with(&[0xef, 0xbb, 0xbf]) {
                line.drain(..3);
            }
        }
        let line = std::str::from_utf8(&line).map_err(|_| StreamFailure::InvalidUtf8)?;
        if line.is_empty() {
            if !self.data.is_empty() {
                self.data.pop(); // final LF inserted by data-field processing
                output.push(SseEvent {
                    data: std::mem::take(&mut self.data),
                    event_type: std::mem::take(&mut self.event_type),
                });
            }
            self.event_type.clear();
            self.event_bytes = 0;
        } else if !line.starts_with(':') {
            let (field, value) = line.split_once(':').unwrap_or((line, ""));
            let value = value.strip_prefix(' ').unwrap_or(value);
            match field {
                "data" => {
                    self.data.extend_from_slice(value.as_bytes());
                    self.data.push(b'\n');
                }
                "event" => self.event_type = value.to_string(),
                // EventSource reconnection is deliberately never implemented.
                _ => {}
            }
        }
        Ok(())
    }

    pub fn finish(&self) -> Result<(), StreamFailure> {
        if self.failed
            || !self.line.is_empty()
            || !self.data.is_empty()
            || !self.event_type.is_empty()
        {
            Err(StreamFailure::TruncatedEvent)
        } else {
            Ok(())
        }
    }
}

#[derive(Deserialize)]
struct Chunk {
    id: String,
    object: String,
    model: String,
    choices: Vec<Choice>,
    usage: Option<WireUsage>,
    error: Option<serde_json::Value>,
}

#[derive(Deserialize)]
struct WireUsage {
    prompt_tokens: u64,
    completion_tokens: u64,
    total_tokens: u64,
}
impl From<WireUsage> for Usage {
    fn from(u: WireUsage) -> Self {
        Self {
            prompt_tokens: u.prompt_tokens,
            completion_tokens: u.completion_tokens,
            total_tokens: u.total_tokens,
        }
    }
}

#[derive(Deserialize)]
struct Choice {
    index: u32,
    #[serde(default)]
    text: String,
    token_ids: Option<Vec<u32>>,
    prompt_token_ids: Option<Vec<u32>>,
    finish_reason: Option<String>,
    error: Option<serde_json::Value>,
}

pub struct DecodedChunk {
    pub observation: Option<ObservationKind>,
    pub text_delta: String,
}

pub struct CompletionDecoder {
    expected_id: String,
    expected_model: String,
    prompt: Vec<u32>,
    max_output: u64,
    vocab_size: u64,
    pub generated_tokens: u64,
    pub text_bytes: u64,
    pub terminal: bool,
    pub done: bool,
    pub usage: Option<Usage>,
    pub response_id: Option<String>,
}

impl CompletionDecoder {
    pub fn new(request: &ExecutionRequest, model: &str, vocab_size: u64) -> Self {
        Self {
            expected_id: format!("cmpl-{}", request.execution_id),
            expected_model: model.into(),
            prompt: request.prompt_token_ids.clone(),
            max_output: request.max_output_tokens,
            vocab_size,
            generated_tokens: 0,
            text_bytes: 0,
            terminal: false,
            done: false,
            usage: None,
            response_id: None,
        }
    }

    pub fn accept(&mut self, event: SseEvent) -> Result<DecodedChunk, StreamFailure> {
        if !event.event_type.is_empty() && event.event_type != "message" {
            return Err(StreamFailure::ErrorEvent);
        }
        if event.data.is_empty() {
            return Ok(DecodedChunk {
                observation: None,
                text_delta: String::new(),
            });
        }
        if self.done {
            return Err(StreamFailure::UnexpectedAfterDone);
        }
        if event.data == b"[DONE]" {
            if !self.terminal {
                return Err(StreamFailure::MissingTerminal);
            }
            self.done = true;
            return Ok(DecodedChunk {
                observation: None,
                text_delta: String::new(),
            });
        }
        // Direct typed deserialization rejects duplicate known fields; passing
        // through Value first would silently overwrite conflicting token/ID keys.
        let chunk: Chunk =
            serde_json::from_slice(&event.data).map_err(|_| StreamFailure::InvalidJson)?;
        if chunk.error.is_some() {
            return Err(StreamFailure::ErrorEvent);
        }
        if chunk.id != self.expected_id
            || chunk.model != self.expected_model
            || chunk.object != "text_completion"
        {
            return Err(StreamFailure::IdentityMismatch);
        }
        if chunk.choices.len() > 1 {
            return Err(StreamFailure::Choice);
        }
        let mut observation = None;
        let mut text_delta = String::new();
        let mut generated = self.generated_tokens;
        let mut text_bytes = self.text_bytes;
        let mut terminal = self.terminal;
        if let Some(choice) = chunk.choices.into_iter().next() {
            if choice.error.is_some() {
                return Err(StreamFailure::ErrorEvent);
            }
            if terminal {
                return Err(StreamFailure::UnexpectedAfterTerminal);
            }
            if choice.index != 0 {
                return Err(StreamFailure::Choice);
            }
            if choice
                .prompt_token_ids
                .as_ref()
                .is_some_and(|p| p != &self.prompt)
            {
                return Err(StreamFailure::PromptMismatch);
            }
            let ids = choice.token_ids.unwrap_or_default();
            if ids.iter().any(|&t| u64::from(t) >= self.vocab_size)
                || (!choice.text.is_empty() && ids.is_empty())
            {
                return Err(StreamFailure::TokenEvidence);
            }
            generated = generated
                .checked_add(ids.len() as u64)
                .ok_or(StreamFailure::OutputLimit)?;
            if generated > self.max_output {
                return Err(StreamFailure::OutputLimit);
            }
            text_bytes = text_bytes
                .checked_add(choice.text.len() as u64)
                .ok_or(StreamFailure::StreamTooLarge)?;
            text_delta = choice.text;
            if let Some(reason) = choice.finish_reason {
                let outcome = match reason.as_str() {
                    "stop" => TerminalOutcome::Stop,
                    "length" => TerminalOutcome::Length,
                    _ => return Err(StreamFailure::ErrorEvent),
                };
                terminal = true;
                observation = Some(ObservationKind::ExecutionTerminal {
                    outcome,
                    generated_token_ids: ids,
                });
            } else if !ids.is_empty() {
                observation = Some(ObservationKind::OutputProgress {
                    generated_token_ids: ids,
                });
            }
        } else if chunk.usage.is_none() {
            return Err(StreamFailure::Choice);
        }
        if let Some(usage) = &chunk.usage
            && (!terminal
                || self.usage.is_some()
                || usage.prompt_tokens != self.prompt.len() as u64
                || usage.completion_tokens != generated
                || usage.prompt_tokens.checked_add(usage.completion_tokens)
                    != Some(usage.total_tokens))
        {
            return Err(StreamFailure::Usage);
        }
        // No core observation is emitted until the WHOLE event is validated.
        self.generated_tokens = generated;
        self.text_bytes = text_bytes;
        self.terminal = terminal;
        self.response_id = Some(chunk.id);
        if chunk.usage.is_some() {
            self.usage = chunk.usage.map(Into::into);
        }
        Ok(DecodedChunk {
            observation,
            text_delta,
        })
    }

    pub fn finish(&self) -> Result<(), StreamFailure> {
        if !self.terminal {
            Err(StreamFailure::MissingTerminal)
        } else if self.usage.is_none() {
            Err(StreamFailure::MissingUsage)
        } else if !self.done {
            Err(StreamFailure::MissingDone)
        } else {
            Ok(())
        }
    }
}
