import { hash, requireThat as check } from "../../contract.mjs";
import { validateFx, LIVE_MODE } from "./policy.mjs";
import { usageCostMicro } from "../../../inference-comparison/core.mjs";
// Conservative qualification for the bounded text/bash Qwen template. All text
// and JSON bytes are counted (including escaped bytes) plus 1024 template tokens
// per message and 4096 for tool scaffolding. This is NOT exact token metering;
// the verified terminal provider usage is the only settlement meter.
export function qualify(body, raw, service) {
  check(
    service.model === "Qwen/Qwen3.8-27B" &&
      service.minInputTokens === 0 &&
      service.tokenizer === "qwen-conservative-input-v1",
    "reviewed_qwen_bound_required",
  );
  check(
    body.stream === true && body.stream_options?.include_usage === true,
    "terminal_stream_required",
  );
  for (const m of body.messages) {
    check(
      m &&
        ["system", "user", "assistant", "tool"].includes(m.role) &&
        Object.keys(m).every((k) =>
          ["role", "content", "tool_calls", "tool_call_id"].includes(k),
        ) &&
        (typeof m.content === "string" ||
          (m.role === "assistant" &&
            (m.content === null || (m.content === undefined && m.tool_calls)))),
      "text_message_required",
    );
    if (m.tool_calls)
      check(
        m.role === "assistant" &&
          Array.isArray(m.tool_calls) &&
          m.tool_calls.length <= 8 &&
          m.tool_calls.every(
            (t) =>
              typeof t.id === "string" &&
              t.type === "function" &&
              t.function?.name === "bash" &&
              typeof t.function.arguments === "string",
          ),
        "unsupported_tool_history",
      );
  }
  check(
    !(
      body.max_tokens !== undefined &&
      body.max_completion_tokens !== undefined &&
      body.max_tokens !== body.max_completion_tokens
    ),
    "conflicting_output_limits",
  );
  const upper =
    Buffer.byteLength(raw, "utf8") + body.messages.length * 1024 + 4096;
  check(upper <= service.maxInputTokens, "input_above_qualified_class");
  return {
    version: "qwen-conservative-input-v1",
    upper,
    requestHash: hash(raw),
  };
}
export function liveAdmission({ plan, keyFingerprint = "" }) {
  const maximumProviderMicro = BigInt(
    usageCostMicro(plan.service.rates, {
      prompt_tokens: plan.service.maxInputTokens,
      completion_tokens: plan.service.maxOutputTokens,
      prompt_tokens_details: {
        cached_tokens:
          BigInt(plan.service.rates.cache_input) >
          BigInt(plan.service.rates.input)
            ? plan.service.maxInputTokens
            : 0,
      },
    }),
  );
  return {
    scope: LIVE_MODE,
    async ready(db, at) {
      const r = (
        await db.query("SELECT * FROM mpp_direct_live_supply WHERE singleton")
      ).rows[0];
      const budget = (
        await db.query(
          "SELECT * FROM mpp_direct_live_provider_budget WHERE singleton",
        )
      ).rows[0];
      const blocked =
        (
          await db.query(
            "SELECT id FROM mpp_direct_live_provider_ops WHERE verification->>'kind'='http-refusal-v1' AND verification->>'keyFingerprint'=$1 LIMIT 1",
            [keyFingerprint],
          )
        ).rowCount > 0;
      return (
        !blocked &&
        budget &&
        budget.calls < budget.maximum_calls &&
        BigInt(budget.spent_micro) +
          BigInt(budget.reserved_micro) +
          maximumProviderMicro <=
          BigInt(budget.maximum_micro) &&
        !!r?.ready &&
        Number(r.observed_ms) <= at &&
        at < Number(r.expires_ms) &&
        Number(r.expires_ms) - Number(r.observed_ms) <= 30000
      );
    },
    qualify: (body, raw) => qualify(body, raw, plan.service),
    async fx(db, at) {
      const row = (
        await db.query(
          "SELECT observation FROM mpp_direct_live_fx ORDER BY observed_ms DESC,id DESC LIMIT 1",
        )
      ).rows[0];
      // An expired observation produces no sale. Recovery/refunds remain usable.
      if (!row)
        return {
          source: "unavailable",
          observedAtMs: 0,
          expiresAtMs: 0,
          nanoUsdPerNear: "0",
        };
      try {
        check(
          row.observation.source === plan.fxSource,
          "reviewed_fx_source_required",
        );
        return validateFx(row.observation, at);
      } catch {
        return { ...row.observation, expiresAtMs: 0 };
      }
    },
  };
}
export async function recordFx(pool, observation) {
  const fx = validateFx(observation);
  await pool.query(
    "INSERT INTO mpp_direct_live_fx VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
    [hash(fx), fx, fx.observedAtMs, fx.expiresAtMs],
  );
}
