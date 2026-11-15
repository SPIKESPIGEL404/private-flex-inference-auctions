import { check, endpoint } from "./config.mjs";

const usageOf = (usage, terms) => {
  check(
    usage &&
      Number.isSafeInteger(usage.prompt_tokens) &&
      usage.prompt_tokens >= 0 &&
      Number.isSafeInteger(usage.completion_tokens) &&
      usage.completion_tokens >= 0 &&
      usage.total_tokens === usage.prompt_tokens + usage.completion_tokens,
    "invalid_native_usage",
  );
  check(
    usage.prompt_tokens <= terms.maxInputTokens &&
      usage.completion_tokens <= terms.maxOutputTokens,
    "usage_outside_request_contract",
  );
  return usage;
};
export function validateResult(raw, contentType, terms, stream) {
  let id,
    usage,
    finish = 0,
    delivered = false,
    done = false,
    terminalUsage = false;
  const accept = (value, streaming) => {
    check(
      value &&
        typeof value.id === "string" &&
        value.id.length > 0 &&
        value.id.length <= 256 &&
        value.model === terms.model,
      "unexpected_provider_identity",
    );
    check(id === undefined || id === value.id, "provider_response_changed");
    id = value.id;
    check(
      Array.isArray(value.choices) && value.choices.length <= 1,
      "single_completion_required",
    );
    for (const c of value.choices) {
      check(c.index === 0, "single_completion_required");
      const message = streaming ? c.delta : c.message;
      if (typeof message?.content === "string" && message.content.length > 0)
        delivered = true;
      if (Array.isArray(message?.tool_calls) && message.tool_calls.length > 0)
        delivered = true;
      if (c.finish_reason != null) {
        check(
          ["stop", "length", "tool_calls"].includes(c.finish_reason),
          "undelivered_completion",
        );
        finish++;
      }
    }
    if (value.usage) {
      const next = usageOf(value.usage, terms);
      check(
        !usage ||
          (next.prompt_tokens >= usage.prompt_tokens &&
            next.completion_tokens >= usage.completion_tokens),
        "usage_regressed",
      );
      usage = next;
      if (finish === 1) terminalUsage = true;
    }
  };
  if (stream) {
    check(contentType === "text/event-stream", "native_stream_required");
    for (const line of raw.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      check(!done, "data_after_done");
      const data = line.slice(5).trim();
      if (data === "[DONE]") {
        done = true;
        continue;
      }
      accept(JSON.parse(data), true);
    }
    check(done, "incomplete_provider_stream");
  } else {
    check(contentType === "application/json", "native_json_required");
    accept(JSON.parse(raw), false);
  }
  check(
    id && usage && terminalUsage && finish === 1 && delivered,
    "complete_provider_delivery_required",
  );
  return usage;
}

// Transport evidence only: this adapter makes no TEE/model-weight claim. The
// existing NEAR attested provider remains in the native metered auction mode.
export function httpProvider({ config, apiKey, fetcher = fetch }) {
  const url = endpoint(config.provider.url, config.mode === "controlled");
  check(
    config.mode === "controlled" ||
      (typeof apiKey === "string" && apiKey.length > 0),
    "provider_api_key_required",
  );
  return {
    mode: config.mode,
    async invoke({ id, raw: body, terms, signal }) {
      const result = await fetcher(url, {
        method: "POST",
        body,
        signal,
        redirect: "error",
        headers: {
          "content-type": "application/json",
          "idempotency-key": id,
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
      });
      if (!result.ok) {
        await result.body?.cancel();
        const error = Error("provider_http_refusal");
        error.definite = true;
        throw error;
      }
      const chunks = [];
      let length = 0;
      try {
        for await (const chunk of result.body) {
          length += chunk.length;
          check(length <= 1024 * 1024, "provider_response_too_large");
          chunks.push(chunk);
        }
      } catch (e) {
        await result.body?.cancel().catch(() => {});
        throw e;
      }
      const raw = new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.concat(chunks),
      );
      const contentType = result.headers
        .get("content-type")
        ?.split(";")[0]
        .trim();
      const usage = validateResult(
        raw,
        contentType,
        terms,
        JSON.parse(body).stream === true,
      );
      return {
        raw,
        contentType,
        usage,
        verification: "https-transport-only-v1",
      };
    },
  };
}
