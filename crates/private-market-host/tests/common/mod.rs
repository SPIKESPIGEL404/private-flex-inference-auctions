#[derive(Clone)]
pub struct RequestFixture {
    pub id: u64,
    pub buyer_id: u64,
    pub idempotency_key: String,
    pub market_spec_ref: bitrouter_market::order::MarketSpecRef,
    pub request_protocol_ref: String,
    pub request_ref: String,
    pub request_digest: String,
    pub request_size: bitrouter_market::order::RequestSize,
    pub output_estimate: bitrouter_market::order::OutputEstimate,
    pub arrival_seq: u64,
    pub expires_at: bitrouter_market::order::UnixMillis,
    pub completion_deadline: Option<bitrouter_market::order::UnixMillis>,
}
impl RequestFixture {
    pub fn request(&self) -> bitrouter_market::terms::RequestSpec {
        bitrouter_market::terms::RequestSpec {
            request_ref: self.request_ref.clone(),
            request_digest: self.request_digest.clone(),
            size: self.request_size,
        }
    }
}
use bitrouter_market::cost::NUMERICAL_RULES_REF;
use bitrouter_market::market_spec::{MarketSpec, MeteringSpec};
use bitrouter_market::order::*;
use bitrouter_market::throughput::{ThroughputClaim, ThroughputProfile, ThroughputRate};

pub const NOW: UnixMillis = UnixMillis(1_000);

pub fn spec() -> MarketSpec {
    MarketSpec {
        reference: MarketSpecRef {
            market_id: "test-market".into(),
            revision: 2,
        },
        model_ref: "fixture/model-tokenizer-template-v1".into(),
        request_protocol_ref: "fixture/streaming-text-v1".into(),
        throughput_profile_ref: "fixture/workload-v1".into(),
        request_limits: RequestLimits {
            context_window_tokens: 4_096,
            max_output_tokens: 1_024,
        },
        metering: MeteringSpec {
            output_metering_ref: "fixture/all-output-v1".into(),
            numerical_rules_ref: NUMERICAL_RULES_REF.into(),
        },
    }
}

pub fn buy() -> RequestFixture {
    let spec = spec();
    RequestFixture {
        id: 1,
        buyer_id: 1,
        idempotency_key: "request-1".into(),
        market_spec_ref: spec.reference,
        request_protocol_ref: spec.request_protocol_ref,
        request_ref: "fixture/request-1".into(),
        request_digest: "fixture/digest-1".into(),
        request_size: RequestSize {
            input_tokens: 1_200,
            max_output_tokens: 256,
        },
        output_estimate: OutputEstimate {
            billable_output_tokens: 200,
            visible_output_tokens: 128,
        },
        arrival_seq: 1,
        expires_at: UnixMillis(2_000),
        completion_deadline: None,
    }
}

pub fn profile() -> ThroughputProfile {
    let buy = buy();
    ThroughputProfile {
        reference: spec().throughput_profile_ref,
        market_spec_ref: buy.market_spec_ref,
        request_size: buy.request_size,
        output_estimate: buy.output_estimate,
        cache_condition_ref: "fixture/cold-cache-v1".into(),
        min_window_ms: 1_000,
        min_sample_requests: 2,
        max_p95_e2e_ms: 500,
        max_failure_bps: 100,
    }
}

pub fn offering() -> ProviderOffering {
    let buy = buy();
    ProviderOffering {
        id: 1,
        provider_id: 1,
        market_spec_ref: buy.market_spec_ref,
        request_protocol_ref: buy.request_protocol_ref,
        agent_config_ref: "fixture/agent-1/config-1".into(),
        rates: TokenRates {
            input: 1_000_000,
            cache_input: 0,
            output: 2_000_000,
        },
        throughput: ThroughputClaim {
            profile_ref: spec().throughput_profile_ref,
            rate: ThroughputRate {
                output_tokens: 400,
                completed_requests: 2,
                interval_ms: 1_000,
            },
        },
        generation: 1,
        update_seq: 1,
        observed_at: NOW,
        valid_until: UnixMillis(1_800),
        readiness: Readiness::Ready,
    }
}
