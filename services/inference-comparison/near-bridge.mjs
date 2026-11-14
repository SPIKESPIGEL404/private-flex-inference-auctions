// Private loopback bridge. Persist intent before any paid invoke; never reinvoke Unknown.
import http from "node:http";
import { readFileSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { timingSafeEqual } from "node:crypto";
import { Store } from "../../clients/buyer-gateway/src/store.mjs";
import {
  check,
  digest,
  MODEL,
  comparisonRequest,
  validateTariff,
  usageCostMicro,
  integer,
} from "./core.mjs";
export function requireSdkRuntime(version = process.versions.node) {
  const [major, minor, patch] = version.split(".").map(Number);
  check(
    major > 24 ||
      (major === 24 && (minor > 22 || (minor === 22 && patch >= 1))),
    "near_sdk_requires_node_24_22_1",
  );
}
export async function sdkClient(key) {
  requireSdkRuntime();
  check(
    typeof key === "string" && key.length > 0 && key.length < 16384,
    "near_api_key_required",
  );
  const { InferenceClient } = await import("@nearai/inference-sdk/node");
  const strict = { policy: { acceptedTcbStatuses: ["UpToDate"] } };
  return new InferenceClient({
    baseUrl: "https://cloud-api.near.ai/v1",
    apiKey: key,
    e2ee: true,
    gatewayVerification: strict,
    modelVerification: strict,
  });
}
export function inspectStream(raw) {
  let id,
    usage,
    done = false,
    finish = 0,
    text = false,
    terminalUsage = false;
  for (const line of raw.toString("utf8").split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    check(!done, "data_after_done");
    if (data === "[DONE]") {
      done = true;
      continue;
    }
    const f = JSON.parse(data);
    check(
      typeof f.id === "string" && f.id.length <= 256 && f.model === MODEL,
      "unexpected_near_response",
    );
    check(id === undefined || id === f.id, "response_id_changed");
    id = f.id;
    for (const c of f.choices ?? []) {
      if (c.delta?.content) text = true;
      if (c.delta?.tool_calls?.length) text = true;
      if (c.finish_reason) finish++;
    }
    if (f.usage) {
      const next = f.usage;
      check(Number.isSafeInteger(next.prompt_tokens) && next.prompt_tokens >= 0
        && Number.isSafeInteger(next.completion_tokens) && next.completion_tokens >= 0
        && next.total_tokens === next.prompt_tokens + next.completion_tokens, "invalid_native_usage");
      // vLLM can emit cumulative usage on more than the final frame. Charge
      // the terminal snapshot once, never the sum of intermediate snapshots.
      check(!usage || (next.prompt_tokens >= usage.prompt_tokens && next.completion_tokens >= usage.completion_tokens), "usage_regressed");
      usage = next;
      if (finish === 1) terminalUsage = true;
    }
  }
  check(
    done && id && text && finish === 1 && usage && terminalUsage,
    "native_terminal_required",
  );
  check(
    Number.isSafeInteger(usage.prompt_tokens) &&
      usage.prompt_tokens >= 0 &&
      Number.isSafeInteger(usage.completion_tokens) &&
      usage.completion_tokens >= 0 &&
      usage.total_tokens === usage.prompt_tokens + usage.completion_tokens,
    "invalid_native_usage",
  );
  return { id, usage };
}
async function abortable(promise, signal) {
  signal.throwIfAborted();
  let cancel;
  const aborted = new Promise((_, reject) => {
    cancel = () => reject(signal.reason);
    signal.addEventListener("abort", cancel, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}
const json = (res, status, value) => {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(value));
};
const authorized = (got, want) =>
  typeof got === "string" &&
  Buffer.byteLength(got) === Buffer.byteLength(want) &&
  timingSafeEqual(Buffer.from(got), Buffer.from(want));
export async function startNearBridge(
  config,
  { client, store, now = Date.now } = {},
) {
  check(
    typeof config.localSecret === "string" && config.localSecret.length >= 32,
    "local_secret_required",
  );
  check(
    Number.isSafeInteger(config.maxConcurrent ?? 2) &&
      (config.maxConcurrent ?? 2) > 0 &&
      (config.maxConcurrent ?? 2) <= 8,
    "invalid_concurrency",
  );
  check(
    Number.isSafeInteger(config.timeoutMs ?? 120000) &&
      (config.timeoutMs ?? 120000) > 0 &&
      (config.timeoutMs ?? 120000) <= 120000,
    "invalid_timeout",
  );
  check(
    /^[a-f0-9]{64}$/.test(config.authorizedRequestHash),
    "reviewed_request_hash_required",
  );
  check(
    Number.isSafeInteger(config.maxUpstreamCalls) &&
      config.maxUpstreamCalls > 0 &&
      config.maxUpstreamCalls <= 4,
    "bounded_call_count_required",
  );
  check(
    Number.isSafeInteger(config.qualifiedInputTokens) &&
      config.qualifiedInputTokens > 0 &&
      config.qualifiedInputTokens <= 8192,
    "qualified_input_bound_required",
  );
  check(
    integer(config.upstreamBudgetMicro) > 0n &&
      integer(config.upstreamBudgetMicro) <= 1000000n,
    "bounded_upstream_budget_required",
  );
  if (!client) {
    check(
      (statSync(config.apiKeyFile).mode & 0o077) === 0,
      "private_api_key_permissions_required",
    );
    client = await sdkClient(readFileSync(config.apiKeyFile, "utf8").trim());
  }
  store ??= new Store(config.storePath, Buffer.from(config.storageKey, "hex"));
  const inFlight = new Set(),
    jobs = new Set(),
    controllers = new Set();
  let closing = false;
  const server = http.createServer(async (req, res) => {
    const completion = Promise.withResolvers();
    jobs.add(completion.promise);
    try {
      check(!closing, "bridge_closing");
      if (req.url === "/healthz" && req.method === "GET")
        return json(res, 200, {
          ready: true,
          provider: "near-ai-cloud",
          realInvocationEnabled: true,
          verification: "sdk-e2ee-and-response-signature",
        });
      check(
        authorized(req.headers.authorization, "Bearer " + config.localSecret),
        "unauthorized",
      );
      if (req.method !== "POST" || req.url !== "/v1/chat/completions")
        return json(res, 404, { error: "not_found" });
      let size = 0,
        chunks = [];
      for await (const part of req) {
        size += part.length;
        check(size <= 128 * 1024, "request_too_large");
        chunks.push(part);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      check(
        body.model === MODEL &&
          body.stream === true &&
          body.stream_options?.include_usage === true &&
          Number.isSafeInteger(body.max_completion_tokens) &&
          body.max_completion_tokens > 0 &&
          body.max_completion_tokens <= 512,
        "unsupported_near_request",
      );
      check(
        Object.keys(body).every((k) =>
          [
            "messages",
            "max_completion_tokens",
            "temperature",
            "seed",
            "model",
            "stream",
            "stream_options",
            "user",
          ].includes(k),
        ),
        "unsupported_near_field",
      );
      const common = comparisonRequest(
        Object.fromEntries(
          Object.entries(body).filter(([k]) =>
            [
              "messages",
              "max_completion_tokens",
              "temperature",
              "seed",
            ].includes(k),
          ),
        ),
      );
      check(
        digest(common) === config.authorizedRequestHash,
        "request_outside_reviewed_plan",
      );
      check(
        typeof body.user === "string" && /^cmp-[a-f0-9]{64}$/.test(body.user),
        "comparison_operation_required",
      );
      const op = body.user,
        bodyHash = digest(body),
        old = store.get("near-invoke", op, "");
      if (old) {
        check(old.bodyHash === bodyHash, "operation_conflict");
        if (old.state === "verified") {
          res.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-store",
            "x-near-response-verified": "true",
          });
          res.end(Buffer.from(old.response, "base64"));
          return;
        }
        return json(res, 409, {
          error: inFlight.has(op)
            ? "original_inference_pending"
            : "original_inference_unknown",
        });
      }
      check(inFlight.size < (config.maxConcurrent ?? 2), "bridge_busy");
      const tariff = validateTariff(config.tariff, now());
      check(tariff.model === MODEL, "wrong_bridge_tariff");
      const operation = store.transaction(() => {
        check(!store.get("near-invoke", op, ""), "original_inference_pending");
        const existing = store.list("near-invoke", "");
        const reserved = existing.reduce(
          (sum, r) => sum + integer(r.reservedMicro),
          0n,
        );
        const reservedMicro = usageCostMicro(tariff.rates, {
          prompt_tokens: config.qualifiedInputTokens,
          completion_tokens: body.max_completion_tokens,
        });
        check(
          existing.length < config.maxUpstreamCalls &&
            reserved + integer(reservedMicro) <=
              integer(config.upstreamBudgetMicro),
          "upstream_authorization_exhausted",
        );
        const operation = {
          id: op,
          bodyHash,
          state: "pending",
          startedAtMs: now(),
          reservedMicro,
          priceVersion: tariff.priceVersion,
        };
        store.put("near-invoke", op, "", operation);
        return operation;
      });
      inFlight.add(op);
      const controller = new AbortController();
      controllers.add(controller);
      const signal = AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(config.timeoutMs ?? 120000),
      ]);
      try {
        const response = await client.fetch(
          "https://cloud-api.near.ai/v1/chat/completions",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
            redirect: "error",
            signal,
          },
        );
        check(
          response.ok &&
            response.headers
              .get("content-type")
              ?.startsWith("text/event-stream"),
          "near_native_response_unavailable",
        );
        let n = 0,
          firstByteAtMs = null;
        const output = [];
        for await (const part of response.body) {
          firstByteAtMs ??= now();
          n += part.length;
          check(n <= 1024 * 1024, "native_response_too_large");
          output.push(part);
        }
        const raw = Buffer.concat(output),
          summary = inspectStream(raw);
        check(
          summary.usage.completion_tokens <= body.max_completion_tokens,
          "output_exceeds_authorization",
        );
        // SDK checks the exact captured bytes, before any result is released to Market.
        const verification = await abortable(
          client.verifyResponse(summary.id),
          signal,
        );
        check(
          verification.id === summary.id &&
            verification.signatureKind === "provider_tee",
          "model_signature_required",
        );
        store.put("near-invoke", op, "", {
          ...operation,
          state: "verified",
          firstByteAtMs,
          verifiedAtMs: now(),
          responseId: summary.id,
          usage: summary.usage,
          response: raw.toString("base64"),
        });
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-store",
          "x-near-response-verified": "true",
        });
        res.end(raw);
      } catch {
        store.put("near-invoke", op, "", {
          ...operation,
          state: "unknown",
          endedAtMs: now(),
        });
        json(res, 503, { error: "original_inference_unknown" });
      } finally {
        inFlight.delete(op);
        controllers.delete(controller);
      }
    } catch (error) {
      const reason = /^[a-z][a-z0-9_]+$/.test(error.message)
        ? error.message
        : "bridge_request_failed";
      if (!res.headersSent)
        json(res, reason === "unauthorized" ? 401 : 400, { error: reason });
      else res.destroy();
    } finally {
      jobs.delete(completion.promise);
      completion.resolve();
    }
  });
  await new Promise((r) => server.listen(config.port ?? 0, "127.0.0.1", r));
  return {
    url: "http://127.0.0.1:" + server.address().port,
    async close() {
      closing = true;
      for (const c of controllers) c.abort();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      await Promise.allSettled([...jobs]);
      store.close();
    },
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  check(
    (statSync(process.argv[2]).mode & 0o077) === 0,
    "private_config_permissions_required",
  );
  const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
  const bridge = await startNearBridge(config);
  console.log(JSON.stringify({ url: bridge.url, provider: "near-ai-cloud" }));
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => void bridge.close().then(() => process.exit(0)));
}
