import { createHash } from "node:crypto";
import { Types } from "@defuse-protocol/nearintents-mpp-sdk";
import { jcsBytes } from "../../../clients/market-buyer/purchase-sign.mjs";

export const check = (value, code) => {
  if (!value) throw Error(code);
};
export const digest = (value) =>
  createHash("sha256")
    .update(typeof value === "string" ? value : jcsBytes(value))
    .digest("hex");
export const uint = (s) => {
  check(
    typeof s === "string" && /^(0|[1-9][0-9]{0,37})$/.test(s),
    "invalid_atomic_amount",
  );
  return BigInt(s);
};
const positive = (s) => uint(s) > 0n;
const integer = (n, lo, hi) => Number.isSafeInteger(n) && n >= lo && n <= hi;
export const endpoint = (value, controlled = false) => {
  const url = new URL(value);
  check(
    !url.username && !url.password && !url.search && !url.hash,
    "invalid_endpoint",
  );
  check(
    controlled
      ? url.protocol === "http:" && url.hostname === "127.0.0.1"
      : url.protocol === "https:",
    "invalid_endpoint",
  );
  return url;
};

// This is a separate, fixed-per-request contract. It never credits a platform
// balance, installs sessions, or changes the native metered auction contract.
export function configuration(raw, secret) {
  check(
    raw && ["controlled", "live"].includes(raw.mode),
    "explicit_payment_mode_required",
  );
  const fields = [
    "mode",
    "schema",
    "realm",
    "billing",
    "destinationAsset",
    "destinationRecipient",
    "expiresWindow",
    "settlementTimeout",
    "pollInterval",
    "providerTimeoutMs",
    "maximumCalls",
    "maximumOpenQuotes",
    "maximumProviderMicro",
    "deadlineMs",
    "agents",
    "offers",
    "oneClickBaseUrl",
    "provider",
  ];
  check(
    Object.keys(raw).every((k) => fields.includes(k)),
    "unknown_public_configuration_field",
  );
  check(
    typeof secret === "string" && secret.length >= 32,
    "mpp_secret_required",
  );
  check(/^[a-z][a-z0-9_]{0,47}$/.test(raw.schema), "dedicated_schema_required");
  check(
    typeof raw.realm === "string" && /^[a-zA-Z0-9_.:-]{1,128}$/.test(raw.realm),
    "invalid_realm",
  );
  Types.parseCaip19(raw.destinationAsset);
  check(
    typeof raw.destinationRecipient === "string" &&
      raw.destinationRecipient.length > 0 &&
      raw.destinationRecipient.length <= 256,
    "merchant_required",
  );
  check(raw.billing === "fixed-request-v1", "fixed_request_contract_required");
  check(
    integer(raw.expiresWindow, 5, 3600) &&
      integer(raw.settlementTimeout, 1, 120),
    "invalid_payment_windows",
  );
  check(
    integer(raw.pollInterval, 1, 10000) &&
      integer(raw.providerTimeoutMs, 100, 120000),
    "invalid_timeouts",
  );
  check(
    integer(raw.maximumCalls, 1, 1000) && integer(raw.maximumOpenQuotes, 1, 32),
    "bounded_call_count_required",
  );
  check(
    integer(raw.deadlineMs, 1, Number.MAX_SAFE_INTEGER) &&
      positive(raw.maximumProviderMicro),
    "bounded_run_required",
  );
  check(
    Array.isArray(raw.agents) &&
      raw.agents.length > 0 &&
      raw.agents.length <= 16,
    "agents_required",
  );
  const ids = new Set(),
    tokens = new Set();
  for (const a of raw.agents) {
    check(
      Object.keys(a).every((k) =>
        [
          "id",
          "tokenHash",
          "originAsset",
          "refundTo",
          "maximumAmountIn",
          "maximumTotalAmountIn",
        ].includes(k),
      ),
      "unknown_public_agent_field",
    );
    Types.parseCaip19(a.originAsset);
    check(
      /^[a-zA-Z0-9_-]{1,64}$/.test(a.id) && !ids.has(a.id),
      "invalid_agent",
    );
    check(
      /^[a-f0-9]{64}$/.test(a.tokenHash) && !tokens.has(a.tokenHash),
      "unique_agent_token_required",
    );
    check(
      typeof a.refundTo === "string" &&
        a.refundTo.length > 0 &&
        a.refundTo.length <= 256,
      "agent_refund_address_required",
    );
    check(
      positive(a.maximumAmountIn) && positive(a.maximumTotalAmountIn),
      "agent_payment_cap_required",
    );
    ids.add(a.id);
    tokens.add(a.tokenHash);
  }
  check(
    Array.isArray(raw.offers) &&
      raw.offers.length > 0 &&
      raw.offers.length <= 8,
    "offers_required",
  );
  const models = new Set();
  for (const o of raw.offers) {
    check(
      Object.keys(o).every((k) =>
        [
          "model",
          "amountOut",
          "providerReserveMicro",
          "maxInputTokens",
          "maxOutputTokens",
          "version",
        ].includes(k),
      ),
      "unknown_public_offer_field",
    );
    check(
      typeof o.model === "string" &&
        o.model.length > 0 &&
        o.model.length <= 256 &&
        !models.has(o.model),
      "invalid_offer_model",
    );
    check(
      positive(o.amountOut) && positive(o.providerReserveMicro),
      "fixed_quote_required",
    );
    check(
      integer(o.maxInputTokens, 1024, 32000) &&
        integer(o.maxOutputTokens, 1, 512),
      "bounded_token_class_required",
    );
    check(
      typeof o.version === "string" &&
        /^[a-zA-Z0-9_.:-]{1,128}$/.test(o.version),
      "offer_version_required",
    );
    models.add(o.model);
  }
  const config = structuredClone(raw);
  config.oneClickBaseUrl ??= "https://1click.chaindefuser.com";
  const api = endpoint(config.oneClickBaseUrl, raw.mode === "controlled");
  check(api.pathname === "/", "invalid_settlement_endpoint");
  check(
    raw.mode === "controlled" ||
      api.origin === "https://1click.chaindefuser.com",
    "official_settlement_required",
  );
  config.oneClickBaseUrl = api.origin;
  check(
    raw.provider && raw.provider.kind === "openai-http-v1",
    "explicit_provider_required",
  );
  check(
    Object.keys(raw.provider).every((k) => ["kind", "url"].includes(k)),
    "unknown_public_provider_field",
  );
  const upstream = endpoint(raw.provider.url, raw.mode === "controlled");
  check(
    upstream.pathname.endsWith("/chat/completions"),
    "chat_upstream_required",
  );
  return { config, fingerprint: digest([config, digest(secret)]) };
}

export function admit(raw, config) {
  check(
    typeof raw === "string" && Buffer.byteLength(raw) <= 128 * 1024,
    "request_too_large",
  );
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    throw Error("invalid_json");
  }
  const offer = config.offers.find((o) => o.model === body?.model);
  check(offer, "model_unavailable");
  check(
    Array.isArray(body.messages) &&
      body.messages.length > 0 &&
      body.messages.length <= 64,
    "invalid_messages",
  );
  check(
    Object.keys(body).every((k) =>
      [
        "model",
        "messages",
        "stream",
        "stream_options",
        "max_tokens",
        "max_completion_tokens",
        "temperature",
        "top_p",
        "seed",
        "tools",
        "tool_choice",
        "parallel_tool_calls",
        "stop",
        "presence_penalty",
        "frequency_penalty",
        "response_format",
      ].includes(k),
    ),
    "unsupported_chat_field",
  );
  for (const m of body.messages) {
    check(
      m && ["system", "user", "assistant", "tool"].includes(m.role),
      "invalid_message",
    );
    check(
      typeof m.content === "string" ||
        (m.role === "assistant" &&
          m.content == null &&
          Array.isArray(m.tool_calls)),
      "text_only_request_required",
    );
    check(
      Object.keys(m).every((k) =>
        ["role", "content", "tool_calls", "tool_call_id", "name"].includes(k),
      ),
      "unsupported_message_field",
    );
  }
  check(
    body.stream === undefined || typeof body.stream === "boolean",
    "invalid_stream",
  );
  check(
    body.stream !== true || body.stream_options?.include_usage === true,
    "terminal_usage_required",
  );
  check(
    !body.stream_options ||
      (body.stream === true &&
        Object.keys(body.stream_options).every((k) => k === "include_usage") &&
        body.stream_options.include_usage === true),
    "invalid_stream_options",
  );
  const limit = body.max_completion_tokens ?? body.max_tokens;
  check(
    integer(limit, 1, offer.maxOutputTokens),
    "explicit_output_limit_required",
  );
  check(
    body.max_tokens === undefined ||
      body.max_completion_tokens === undefined ||
      body.max_tokens === body.max_completion_tokens,
    "conflicting_output_limits",
  );
  // Conservative byte/template bound, not a claim of exact tokenizer metering.
  check(
    Buffer.byteLength(raw) + body.messages.length * 1024 + 4096 <=
      offer.maxInputTokens,
    "input_above_qualified_class",
  );
  return { body, offer, requestHash: digest(raw), outputLimit: limit };
}
