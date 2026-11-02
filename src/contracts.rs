use crate::{Error, Result};
use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

pub const SCHEMA_VERSION: u32 = 1;
pub const GENESIS: &str = "GENESIS";

/// Version-one canonical encoding: compact JSON, recursively sorted ASCII field
/// names, integer numbers, serde_json string escaping; no floats or extension maps.
pub fn canonical_bytes<T: Serialize>(value: &T) -> Result<Vec<u8>> {
    fn sorted(v: serde_json::Value) -> serde_json::Value {
        match v {
            serde_json::Value::Object(map) => serde_json::Value::Object(
                map.into_iter()
                    .map(|(k, v)| (k, sorted(v)))
                    .collect::<BTreeMap<_, _>>()
                    .into_iter()
                    .collect(),
            ),
            serde_json::Value::Array(a) => a.into_iter().map(sorted).collect(),
            other => other,
        }
    }
    Ok(serde_json::to_vec(&sorted(serde_json::to_value(value)?))?)
}

pub fn digest<T: Serialize>(domain: &str, value: &T) -> Result<String> {
    let mut hash = Sha256::new();
    hash.update(domain.as_bytes());
    hash.update([0]);
    hash.update(canonical_bytes(value)?);
    Ok(encode_hex(&hash.finalize()))
}

pub fn encode_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn decode_hex<const N: usize>(s: &str) -> Result<[u8; N]> {
    if s.len() != N * 2
        || !s
            .bytes()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
    {
        return Err(Error::Invalid("lowercase hex length or encoding"));
    }
    let mut out = [0; N];
    for (i, v) in out.iter_mut().enumerate() {
        *v = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16)
            .map_err(|_| Error::Invalid("hex encoding"))?;
    }
    Ok(out)
}

pub(crate) fn id(s: &str) -> Result<()> {
    if s.is_empty()
        || s.len() > 128
        || !s
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"-_.:/".contains(&c))
    {
        return Err(Error::Invalid("identifier encoding or length"));
    }
    Ok(())
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ModelProfile {
    pub profile_id: String,
    pub tokenizer_digest: String,
    pub chat_template_digest: String,
    pub max_prompt_tokens: u64,
    pub max_output_tokens: u64,
    pub max_model_len: u64,
    pub vocab_size: u64,
    pub result_bytes_per_output_token: u64,
    pub result_overhead_bytes: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SchedulerConfig {
    pub scheduler_id: String,
    pub stream_id: String,
    pub scheduler_policy_version: String,
    pub model: ModelProfile,
    /// Public verification keys only. No signing secret is accepted by the core.
    pub authorized_issuers: BTreeMap<String, String>,
    pub max_inflight_requests: u64,
    pub max_reserved_context_tokens: u64,
    pub max_spool_bytes: u64,
    pub max_owner_spool_bytes: u64,
    pub max_queued_requests: u64,
    pub max_queued_bytes: u64,
    pub max_out_of_order_plans: u64,
    pub max_plan_bytes: u64,
    pub max_requests_per_plan: u64,
    pub max_observation_tokens: u64,
}

impl SchedulerConfig {
    pub fn validate(&self) -> Result<()> {
        for s in [
            &self.scheduler_id,
            &self.stream_id,
            &self.scheduler_policy_version,
            &self.model.profile_id,
        ] {
            id(s)?;
        }
        decode_hex::<32>(&self.model.tokenizer_digest)?;
        decode_hex::<32>(&self.model.chat_template_digest)?;
        let limits = [
            self.max_inflight_requests,
            self.max_reserved_context_tokens,
            self.max_spool_bytes,
            self.max_owner_spool_bytes,
            self.max_queued_requests,
            self.max_queued_bytes,
            self.max_out_of_order_plans,
            self.max_plan_bytes,
            self.max_requests_per_plan,
            self.max_observation_tokens,
            self.model.max_prompt_tokens,
            self.model.max_output_tokens,
            self.model.max_model_len,
            self.model.vocab_size,
            self.model.result_bytes_per_output_token,
            self.model.result_overhead_bytes,
        ];
        if limits.contains(&0)
            || limits.iter().any(|&x| x > i64::MAX as u64)
            || self.max_owner_spool_bytes > self.max_spool_bytes
            || self.authorized_issuers.is_empty()
            || self.max_requests_per_plan > u64::from(u32::MAX)
        {
            return Err(Error::Invalid("configuration limits"));
        }
        for (issuer, key) in &self.authorized_issuers {
            id(issuer)?;
            VerifyingKey::from_bytes(&decode_hex::<32>(key)?)
                .map_err(|_| Error::Invalid("public verification key"))?;
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SamplingConfig {
    pub temperature_milli: u32,
    pub top_p_millionths: u32,
    pub top_k: u32,
    pub seed: u64,
    pub stop_token_ids: Vec<u32>,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExecutionRequest {
    pub grant_id: String,
    pub execution_id: String,
    pub request_ref: String,
    pub owner_ref: String,
    pub rank: u32,
    pub request_digest: String,
    pub prompt_token_ids: Vec<u32>,
    pub sampling_config: SamplingConfig,
    pub max_output_tokens: u64,
    pub cache_namespace: String,
    pub context_reservation: u64,
    pub max_result_bytes: u64,
}

impl ExecutionRequest {
    pub fn computed_digest(&self) -> Result<String> {
        let mut v = serde_json::to_value(self)?;
        v.as_object_mut().unwrap().remove("request_digest");
        digest("flex-scheduler/request/v1", &v)
    }

    fn validate(&self, config: &SchedulerConfig) -> Result<()> {
        for s in [
            &self.grant_id,
            &self.execution_id,
            &self.request_ref,
            &self.owner_ref,
            &self.cache_namespace,
        ] {
            id(s)?;
        }
        let m = &config.model;
        let context = (self.prompt_token_ids.len() as u64)
            .checked_add(self.max_output_tokens)
            .ok_or(Error::Invalid("context overflow"))?;
        let bytes = self
            .max_output_tokens
            .checked_mul(m.result_bytes_per_output_token)
            .and_then(|n| n.checked_add(m.result_overhead_bytes))
            .ok_or(Error::Invalid("result upper bound overflow"))?;
        if self.prompt_token_ids.is_empty()
            || self.prompt_token_ids.len() as u64 > m.max_prompt_tokens
            || self.max_output_tokens == 0
            || self.max_output_tokens > m.max_output_tokens
            || context > m.max_model_len
            || self.context_reservation != context
            || context > config.max_reserved_context_tokens
            || self.max_result_bytes < bytes
            || self.max_result_bytes > config.max_owner_spool_bytes
            || self
                .prompt_token_ids
                .iter()
                .chain(&self.sampling_config.stop_token_ids)
                .any(|&t| u64::from(t) >= m.vocab_size)
            || self.sampling_config.temperature_milli > 2000
            || u64::from(self.sampling_config.top_k) > m.vocab_size
            || self.sampling_config.seed > i64::MAX as u64
            || !(1..=1_000_000).contains(&self.sampling_config.top_p_millionths)
            || self.request_digest != self.computed_digest()?
        {
            return Err(Error::Invalid("request profile, digest or capacity"));
        }
        Ok(())
    }
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AuthorizationBinding {
    pub issuer_id: String,
    pub signature: String,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExecutionPlan {
    pub schema_version: u32,
    pub plan_id: String,
    pub stream_id: String,
    pub plan_seq: u64,
    pub predecessor_plan_hash: String,
    pub upstream_commit_ref: String,
    pub target_scheduler_id: String,
    pub model_profile_id: String,
    pub scheduler_policy_version: String,
    pub manifest_hash: String,
    pub request_count: u64,
    pub authorization_ref: String,
    pub authorization_binding: AuthorizationBinding,
    pub ordered_requests: Vec<ExecutionRequest>,
}

impl ExecutionPlan {
    pub fn from_json(bytes: &[u8], max_bytes: u64) -> Result<Self> {
        if bytes.len() as u64 > max_bytes {
            return Err(Error::Invalid("plan too large"));
        }
        serde_json::from_slice(bytes).map_err(|_| Error::Invalid("plan schema"))
    }

    pub fn computed_manifest_hash(&self) -> Result<String> {
        let mut v = serde_json::to_value(self)?;
        let map = v.as_object_mut().unwrap();
        map.remove("manifest_hash");
        map.get_mut("authorization_binding")
            .unwrap()
            .as_object_mut()
            .unwrap()
            .remove("signature");
        digest("flex-scheduler/manifest/v1", &v)
    }

    pub fn signing_bytes(&self) -> Result<Vec<u8>> {
        Ok(format!(
            "flex-scheduler/authorization/v1\0{}\0{}",
            self.target_scheduler_id, self.manifest_hash
        )
        .into_bytes())
    }

    pub(crate) fn validate(&self, c: &SchedulerConfig) -> Result<()> {
        for s in [
            &self.plan_id,
            &self.stream_id,
            &self.upstream_commit_ref,
            &self.target_scheduler_id,
            &self.model_profile_id,
            &self.scheduler_policy_version,
            &self.authorization_ref,
            &self.authorization_binding.issuer_id,
        ] {
            id(s)?;
        }
        if self.schema_version != SCHEMA_VERSION
            || self.plan_seq == 0
            || self.plan_seq >= i64::MAX as u64
            || self.stream_id != c.stream_id
            || self.target_scheduler_id != c.scheduler_id
            || self.model_profile_id != c.model.profile_id
            || self.scheduler_policy_version != c.scheduler_policy_version
            || self.request_count == 0
            || self.request_count != self.ordered_requests.len() as u64
            || self.request_count > c.max_requests_per_plan
            || canonical_bytes(self)?.len() as u64 > c.max_plan_bytes
        {
            return Err(Error::Invalid("plan profile, version or membership"));
        }
        if self.plan_seq == 1 {
            if self.predecessor_plan_hash != GENESIS {
                return Err(Error::Invalid("genesis"));
            }
        } else {
            decode_hex::<32>(&self.predecessor_plan_hash)?;
        }
        let mut executions = BTreeSet::new();
        let mut grants = BTreeSet::new();
        for (i, r) in self.ordered_requests.iter().enumerate() {
            r.validate(c)?;
            if u64::from(r.rank) != i as u64 + 1
                || !executions.insert(&r.execution_id)
                || !grants.insert(&r.grant_id)
            {
                return Err(Error::Invalid("request rank or duplicate identity"));
            }
        }
        if self.manifest_hash != self.computed_manifest_hash()? {
            return Err(Error::Invalid("manifest digest"));
        }
        let key = c
            .authorized_issuers
            .get(&self.authorization_binding.issuer_id)
            .ok_or(Error::Unauthorized)?;
        let public =
            VerifyingKey::from_bytes(&decode_hex::<32>(key)?).map_err(|_| Error::Unauthorized)?;
        let signature = Signature::from_bytes(
            &decode_hex::<64>(&self.authorization_binding.signature)
                .map_err(|_| Error::Unauthorized)?,
        );
        public
            .verify_strict(&self.signing_bytes()?, &signature)
            .map_err(|_| Error::Unauthorized)
    }
}
