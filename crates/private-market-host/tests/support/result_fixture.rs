use bitrouter_market::execution_authorization::ExecutionAuthorization;
use bitrouter_market::order::TokenUsage;
use bitrouter_market::purchase_result::*;
use serde::{Deserialize, Serialize};
use std::cell::Cell;

/// Explicit test-only response protocol. It checks the full frozen binding,
/// usage and known fixture output, not a general model-quality assertion.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FixtureResponse {
    request_digest: String,
    model_ref: String,
    usage: TokenUsage,
    complete: bool,
    text: String,
}
pub fn body(auth: &ExecutionAuthorization, usage: TokenUsage) -> Vec<u8> {
    serde_json::to_vec(&FixtureResponse {
        request_digest: auth.request_digest.clone(),
        model_ref: auth.target.model_ref.clone(),
        usage,
        complete: true,
        text: "fixture-result".into(),
    })
    .unwrap()
}
pub struct FixtureValidator {
    pub protocol: String,
    pub calls: Cell<usize>,
    pub reject: Cell<bool>,
}
impl FixtureValidator {
    pub fn new(auth: &ExecutionAuthorization) -> Self {
        Self {
            protocol: auth.request_protocol_ref.clone(),
            calls: Cell::new(0),
            reject: Cell::new(false),
        }
    }
}
impl CompleteResultValidator for FixtureValidator {
    fn identity(&self) -> ResultValidatorIdentity {
        ResultValidatorIdentity {
            reference: "test-only/exact-fixture-response".into(),
            revision: 1,
            request_protocol_ref: self.protocol.clone(),
        }
    }
    fn validate(
        &self,
        auth: &ExecutionAuthorization,
        usage: TokenUsage,
        bytes: &[u8],
    ) -> Result<(), ResultError> {
        self.calls.set(self.calls.get() + 1);
        if self.reject.get() {
            return Err(ResultError::Rejected);
        }
        let response: FixtureResponse =
            serde_json::from_slice(bytes).map_err(|_| ResultError::Rejected)?;
        if response.request_digest != auth.request_digest
            || response.model_ref != auth.target.model_ref
            || response.usage != usage
            || !response.complete
            || response.text != "fixture-result"
        {
            return Err(ResultError::Rejected);
        }
        Ok(())
    }
}
