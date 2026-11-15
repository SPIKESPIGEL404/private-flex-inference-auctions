import { createHash } from "node:crypto";
import { jcsBytes } from "../../clients/market-buyer/purchase-sign.mjs";
export const MODEL = "Qwen/Qwen3.8-27B";
export const NATIVE_CHUTES = "Qwen/Qwen3.8-27B-FP8";
export const check = (v, code) => {
  if (!v) throw new Error(code);
};
export const digest = (v) =>
  createHash("sha256")
    .update(Buffer.isBuffer(v) ? v : jcsBytes(v))
    .digest("hex");
export function integer(value) {
  check(
    typeof value === "string" && /^(0|[1-9][0-9]{0,37})$/.test(value),
    "invalid_integer",
  );
  return BigInt(value);
}
// Market TokenRates are microUSD per one million tokens, not USD/token floats.
export function costPerTokenToMarket(value) {
  check(
    value?.currency === "USD" &&
      Number.isSafeInteger(value.scale) &&
      value.scale >= 0 &&
      value.scale <= 30,
    "unsupported_price_unit",
  );
  const amount = integer(
    typeof value.amount === "number" && Number.isSafeInteger(value.amount)
      ? String(value.amount)
      : value.amount,
  );
  const numerator = amount * 10n ** 12n,
    denominator = 10n ** BigInt(value.scale);
  check(numerator % denominator === 0n, "price_not_exactly_representable");
  const rate = numerator / denominator;
  check(rate <= 18446744073709551615n, "price_overflow");
  return String(rate);
}
export function freezeNearTariff(
  catalog,
  { observedAtMs = Date.now(), validForMs = 3600000 } = {},
) {
  check(
    Number.isSafeInteger(observedAtMs) &&
      observedAtMs > 0 &&
      Number.isSafeInteger(validForMs) &&
      validForMs > 0 &&
      validForMs <= 86400000,
    "invalid_tariff_time",
  );
  check(Array.isArray(catalog?.models), "invalid_catalog");
  const models = catalog.models.filter((x) => x.modelId === MODEL);
  check(models.length === 1, "exact_near_model_required");
  const m = models[0];
  check(
    m.metadata?.isReady === true && m.metadata?.ownedBy === "nearai",
    "near_model_not_ready",
  );
  check(m.textPricing == null, "tiered_pricing_not_supported");
  const rates = {
    input: costPerTokenToMarket(m.inputCostPerToken),
    cache_input:
      m.cacheReadCostPerToken == null
        ? costPerTokenToMarket(m.inputCostPerToken)
        : costPerTokenToMarket(m.cacheReadCostPerToken),
    output: costPerTokenToMarket(m.outputCostPerToken),
  };
  let expiresAtMs = observedAtMs + validForMs;
  if (m.upcomingPricing) {
    const next = Date.parse(m.upcomingPricing.effectiveAt);
    check(
      Number.isSafeInteger(next) && next > observedAtMs,
      "pricing_transition_unresolved",
    );
    expiresAtMs = Math.min(expiresAtMs, next);
  }
  const snapshot = {
    version: 1,
    source: "https://cloud-api.near.ai/v1/model/list",
    model: MODEL,
    observedAtMs,
    expiresAtMs,
    unit: "microUSD_per_1M_tokens",
    rates,
    catalogSha256: digest(Buffer.from(JSON.stringify(catalog))),
    catalogDigestEncoding: "parsed-json-serialization",
    modelMetadata: {
      contextLength: m.metadata.contextLength ?? null,
      quantization: m.metadata.quantization ?? null,
      huggingFaceId: m.metadata.huggingFaceId ?? null,
    },
    providerRevisionVerified: false,
  };
  return { ...snapshot, priceVersion: digest(snapshot) };
}
export function validateTariff(value, now = Date.now()) {
  const { priceVersion, ...body } = value;
  check(priceVersion === digest(body), "tariff_digest_mismatch");
  check(
    value.version === 1 &&
      value.unit === "microUSD_per_1M_tokens" &&
      Number.isSafeInteger(value.observedAtMs) &&
      value.observedAtMs <= now &&
      now < value.expiresAtMs,
    "tariff_expired_or_future",
  );
  check(
    Number.isSafeInteger(value.expiresAtMs) &&
      value.expiresAtMs > value.observedAtMs,
    "invalid_tariff_expiry",
  );
  for (const key of ["input", "cache_input", "output"])
    check(
      integer(value.rates[key]) <= BigInt(Number.MAX_SAFE_INTEGER),
      "unsupported_rate_range",
    );
  return structuredClone(value);
}
export function usageCostMicro(rates, usage) {
  const input = integer(String(usage.prompt_tokens)),
    output = integer(String(usage.completion_tokens)),
    cached = integer(String(usage.prompt_tokens_details?.cached_tokens ?? 0));
  check(cached <= input, "cached_input_exceeds_total");
  const numerator =
    (input - cached) * integer(rates.input) +
    cached * integer(rates.cache_input) +
    output * integer(rates.output);
  return String((numerator + 999999n) / 1000000n);
}
export function comparisonRequest(input) {
  check(
    input &&
      Object.keys(input).every((k) =>
        ["messages", "max_completion_tokens", "temperature", "seed"].includes(
          k,
        ),
      ),
    "unsupported_comparison_request",
  );
  check(
    Array.isArray(input.messages) &&
      input.messages.length > 0 &&
      input.messages.length <= 64,
    "invalid_messages",
  );
  check(
    input.messages.every(
      (m) =>
        m &&
        Object.keys(m).length === 2 &&
        ["system", "user", "assistant"].includes(m.role) &&
        typeof m.content === "string" &&
        m.content.length <= 100000,
    ),
    "text_only_messages_required",
  );
  check(
    Number.isSafeInteger(input.max_completion_tokens) &&
      input.max_completion_tokens > 0 &&
      input.max_completion_tokens <= 512,
    "unsupported_output_limit",
  );
  check(input.temperature === 0, "deterministic_temperature_required");
  check(
    input.seed === undefined || Number.isSafeInteger(input.seed),
    "invalid_seed",
  );
  check(
    Buffer.byteLength(JSON.stringify(input)) <= 120 * 1024,
    "request_too_large",
  );
  return JSON.parse(jcsBytes(input));
}

export function freezeSelfHostedTariff({
  rates,
  modelRevisionRef,
  observedAtMs = Date.now(),
  expiresAtMs,
}) {
  check(
    typeof modelRevisionRef === "string" && modelRevisionRef.length > 0,
    "model_revision_required",
  );
  const body = {
    version: 1,
    source: "operator-fixed-self-hosted",
    model: "qwen3.8-27b",
    observedAtMs,
    expiresAtMs,
    unit: "microUSD_per_1M_tokens",
    rates,
    modelRevisionRef,
  };
  return validateTariff({ ...body, priceVersion: digest(body) }, observedAtMs);
}
export function prepareComparison({
  request,
  nearTariff,
  selfHostedTariff,
  budgetPerArmMicro,
  deadlineMs,
  ownerAccount,
  taskDurationMs = 30000,
  sequenceIndex = 0,
  now = Date.now(),
}) {
  const common = comparisonRequest(request),
    A = validateTariff(nearTariff, now),
    B = validateTariff(selfHostedTariff, now);
  check(
    A.model === MODEL &&
      A.source === "https://cloud-api.near.ai/v1/model/list" &&
      B.model === "qwen3.8-27b" &&
      B.source === "operator-fixed-self-hosted",
    "wrong_fixed_arms",
  );
  check(
    integer(budgetPerArmMicro) > 0n && integer(budgetPerArmMicro) <= 1000000n,
    "bounded_arm_budget_required",
  );
  check(
    Number.isSafeInteger(deadlineMs) &&
      deadlineMs > now &&
      deadlineMs <= Math.min(A.expiresAtMs, B.expiresAtMs),
    "experiment_deadline_outside_prices",
  );
  check(
    typeof ownerAccount === "string" &&
      /^[a-z0-9._-]{2,64}$/.test(ownerAccount),
    "owner_account_required",
  );
  check(
    Number.isSafeInteger(taskDurationMs) &&
      taskDurationMs > 0 &&
      taskDurationMs <= 3600000 &&
      Number.isSafeInteger(sequenceIndex) &&
      sequenceIndex >= 0,
    "invalid_comparison_schedule",
  );
  check(
    now + 2 * taskDurationMs <= deadlineMs,
    "insufficient_authorization_window",
  );
  const body = {
    version: 2,
    phase: "fixed-supply-comparison",
    mode: "operator-market",
    ownerAccount,
    createdAtMs: now,
    deadlineMs,
    logicalModel: MODEL,
    request: common,
    requestHash: digest(common),
    budgetPerArmMicro,
    taskDurationMs,
    sequenceIndex,
    executionOrder: sequenceIndex % 2 === 0 ? ["A", "B"] : ["B", "A"],
    cachePolicy: "provider-managed-observe-reported-hits",
    arms: {
      A: {
        id: "A",
        provider: "near-ai-cloud",
        pricing: "fixed",
        model: MODEL,
        tariff: A,
      },
      B: {
        id: "B",
        provider: "self-hosted-chutes",
        pricing: "fixed",
        model: "qwen3.8-27b",
        tariff: B,
      },
    },
    realAgentPayments: false,
    dynamicPricingEnabled: false,
  };
  return { ...body, planHash: digest(body) };
}
export function validateComparison(plan, now = Date.now()) {
  const { planHash, ...body } = plan;
  check(planHash === digest(body), "comparison_plan_changed");
  const recreated = prepareComparison({
    request: plan.request,
    nearTariff: plan.arms.A.tariff,
    selfHostedTariff: plan.arms.B.tariff,
    budgetPerArmMicro: plan.budgetPerArmMicro,
    deadlineMs: plan.deadlineMs,
    ownerAccount: plan.ownerAccount,
    taskDurationMs: plan.taskDurationMs,
    sequenceIndex: plan.sequenceIndex,
    now: plan.createdAtMs,
  });
  check(
    recreated.planHash === planHash &&
      now >= plan.createdAtMs &&
      now < plan.deadlineMs,
    "comparison_expired_or_changed",
  );
  return structuredClone(plan);
}
