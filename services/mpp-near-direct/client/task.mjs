import { createFxEngine } from "libfx";
import { Bash } from "just-bash/browser";
import { TOOL } from "../p2/tool-schema.mjs";

const assert = (v, code) => {
  if (!v) throw Error(code);
};
export const sha256 = async (text) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
    ),
    (x) => x.toString(16).padStart(2, "0"),
  ).join("");
export const TASK_VERSION = "workspace-sum-json-v1";
export function sumTask(numbers) {
  assert(
    Array.isArray(numbers) &&
      numbers.length > 0 &&
      numbers.length <= 1000 &&
      numbers.every(Number.isSafeInteger),
    "invalid_task_input",
  );
  assert(
    Number.isSafeInteger(numbers.reduce((a, b) => a + b, 0)),
    "task_sum_out_of_range",
  );
  return {
    version: TASK_VERSION,
    numbers: [...numbers],
    prompt:
      "Read /workspace/numbers.txt. Use bash to compute its sum and count. Write /workspace/result.json with exactly the numeric fields sum and count. Read it back and verify before finishing.",
    files: { "/workspace/numbers.txt": numbers.join("\n") + "\n" },
  };
}
// The evaluator owns the original input. A model's finish reason does not grade its output.
export function verifyArtifact(task, text) {
  try {
    assert(task.version === TASK_VERSION, "wrong_task_version");
    const value = JSON.parse(text);
    assert(
      value && Object.keys(value).sort().join(",") === "count,sum",
      "artifact_schema",
    );
    assert(
      Number.isSafeInteger(value.sum) &&
        value.sum === task.numbers.reduce((a, b) => a + b, 0),
      "incorrect_sum",
    );
    assert(
      Number.isSafeInteger(value.count) && value.count === task.numbers.length,
      "incorrect_count",
    );
    return { outcome: "correct", evaluator: TASK_VERSION };
  } catch (e) {
    return { outcome: "incorrect", evaluator: TASK_VERSION, reason: e.message };
  }
}

// One page/process owns this object. No storage adapters, checkpoints, backend task
// sessions or auto-resume. Procurement is a restricted injected transport.
export async function createMemoryTask({
  task,
  transport,
  runId = crypto.randomUUID(),
  model = "m/external",
  maxOutputTokens = 512,
  maxCalls = 4,
  deadlineMs,
  backend,
  wasm,
  onEvent = () => {},
  now = Date.now,
  monotonic = () => performance.now(),
}) {
  assert(
    typeof transport?.invoke === "function" &&
      Number.isSafeInteger(deadlineMs) &&
      deadlineMs > now(),
    "invalid_task_options",
  );
  assert(
    Number.isSafeInteger(maxCalls) && maxCalls > 0 && maxCalls <= 16,
    "invalid_call_limit",
  );
  const createdAtMs = now(),
    createdMono = monotonic();
  const bash = new Bash({
    cwd: "/workspace",
    files: { ...task.files, "/workspace/task.txt": task.prompt },
    executionLimits: {
      maxCommandCount: 200,
      maxLoopIterations: 200,
      maxCallDepth: 30,
      maxAwkIterations: 10000,
      maxFileSystemBytes: 256000,
      maxOutputSize: 64000,
      maxExecutionTimeMs: 2000,
      maxSourceBytes: 4096,
      maxLiveBytes: 4 * 1024 * 1024,
      maxWorkUnits: 100000,
      maxStringLength: 256000,
    },
  });
  const calls = new Map(),
    tools = new Map();
  const evidence = {
    version: 1,
    runId,
    taskVersion: task.version,
    state: "ready",
    startedAtMs: createdAtMs,
    inputSha256: await sha256(JSON.stringify(task.numbers)),
    taskInput: [...task.numbers],
    calls: [],
    tools: [],
  };
  let engine,
    turn,
    closed = false,
    started = false;
  const alive = () => {
    assert(!closed, "task_closed");
    assert(now() < deadlineMs, "task_deadline");
  };
  engine = await createFxEngine({
    ...(backend ? { backend } : {}),
    ...(wasm ? { wasm } : {}),
    sessionId: runId,
    provider: {
      name: "market",
      baseUrl: "https://market.invalid/v1",
      models: {
        [model]: {
          contextWindow: 32000,
          maxOutputTokens,
          supportsToolUse: true,
          supportsVision: false,
        },
      },
    },
    model,
    instructions:
      "Complete the supplied task using the virtual bash tool. Files persist only in this running task. Never use network, host shell, payment commands or wallet credentials. Do not claim success without verifying the output file.",
    tools: [
      {
        ...TOOL,
        execute: async (input, context) => {
          alive();
          assert(
            typeof input.command === "string" && input.command.length <= 4096,
            "invalid_tool",
          );
          const old = tools.get(context.executionId);
          if (old) {
            assert(old.command === input.command, "tool_identity_conflict");
            return old.result;
          }
          const result = await bash.exec(input.command, {
            signal: AbortSignal.any([
              context.signal,
              AbortSignal.timeout(
                Math.min(2000, Math.max(1, deadlineMs - now())),
              ),
            ]),
          });
          const receipt = {
            executionId: context.executionId,
            command: input.command,
            result,
          };
          tools.set(context.executionId, receipt);
          evidence.tools.push(receipt);
          onEvent({ type: "local_tool", ...receipt });
          return result;
        },
      },
    ],
    fetch: async (input, init) => {
      alive();
      assert(
        String(input) === "https://market.invalid/v1/chat/completions" &&
          init.method?.toUpperCase() === "POST",
        "unsupported_model_transport",
      );
      const body =
        typeof init.body === "string"
          ? init.body
          : new TextDecoder("utf-8", { fatal: true }).decode(init.body);
      const requestHash = await sha256(body);
      let call = calls.get(requestHash);
      if (!call) {
        assert(calls.size < maxCalls, "model_round_limit");
        call = {
          logicalCallId: crypto.randomUUID(),
          requestHash,
          startedAtMs: now(),
          state: "pending",
        };
        calls.set(requestHash, call);
        evidence.calls.push(call);
      }
      // SDK retries and transport retries retain both the original bytes and ID.
      const response = await transport.invoke({
        body,
        runId,
        logicalCallId: call.logicalCallId,
        requestHash,
        signal: AbortSignal.any([
          ...(init.signal ? [init.signal] : []),
          AbortSignal.timeout(Math.max(1, deadlineMs - now())),
        ]),
      });
      call.orderId = response.headers.get("x-order-id");
      call.httpStatus = response.status;
      call.state = response.ok ? "response_received" : "unresolved";
      return response;
    },
    onEvent,
  });
  return {
    runId,
    bash,
    evidence,
    async run() {
      alive();
      assert(!started, "task_already_started");
      started = true;
      evidence.state = "running";
      evidence.runInvokedAtMs = now();
      try {
        turn = engine.prompt(task.prompt, {
          turnId: "task-" + runId,
          signal: AbortSignal.timeout(Math.max(1, deadlineMs - now())),
        });
        for await (const event of turn) onEvent(event);
        evidence.result = await turn.result;
        evidence.completedAtMs = now();
        evidence.elapsedMs = monotonic() - createdMono;
        let artifact = null;
        try {
          artifact = await bash.fs.readFile("/workspace/result.json");
        } catch {}
        evidence.artifact = artifact;
        evidence.verification = verifyArtifact(task, artifact);
        evidence.state =
          evidence.result.stopReason === "end_turn" &&
          evidence.verification.outcome === "correct"
            ? "complete"
            : "failed";
        return structuredClone(evidence);
      } catch (e) {
        evidence.state = "interrupted";
        evidence.elapsedMs = monotonic() - createdMono;
        evidence.reason = e.message;
        throw e;
      }
    },
    async readWorkspace() {
      const files = {};
      let total = 0;
      for (const path of bash.fs.getAllPaths())
        if (path.startsWith("/workspace/")) {
          const stat = await bash.fs.stat(path);
          if (!stat.isFile) continue;
          const text = await bash.fs.readFile(path);
          total += new TextEncoder().encode(text).length;
          assert(
            Object.keys(files).length < 64 && total <= 256000,
            "workspace_export_limit",
          );
          files[path] = text;
        }
      return files;
    },
    async close() {
      closed = true;
      turn?.cancel();
      await engine.close();
    },
  };
}

export function procurementTransport({
  url,
  authorizationId,
  agentId,
  bidMultiplier = "1000000",
  maxTotalMicro = "100000",
  expiryMs,
  fetcher = fetch,
  retryDelayMs = 200,
  maxRetries = 5,
  onPaymentChallenge,
  onWaiting,
}) {
  return {
    async invoke({ body, runId, logicalCallId, requestHash, signal }) {
      const payload = JSON.stringify({
        authorizationId,
        agentId,
        bidMultiplier,
        maxTotalMicro,
        expiryMs,
        runId,
        logicalCallId,
        requestHash,
        body,
      });
      let originalChallenge;
      for (let attempt = 0; ; attempt++) {
        signal?.throwIfAborted();
        try {
          const response = await fetcher(url, {
            method: "POST",
            credentials: "same-origin",
            redirect: "error",
            cache: "no-store",
            signal,
            headers: {
              "content-type": "application/json",
              "idempotency-key": logicalCallId,
            },
            body: payload,
          });
          if (
            response.status === 402 &&
            onPaymentChallenge &&
            attempt < maxRetries
          ) {
            const status = await response.clone().json();
            if (originalChallenge && originalChallenge !== status.challenge.id)
              throw Error("replacement_payment_forbidden");
            originalChallenge = status.challenge.id;
            await onPaymentChallenge(status, signal);
          } else if (
            ![202, 503].includes(response.status) ||
            attempt >= maxRetries
          )
            return response;
          if (response.status === 202 && onWaiting)
            await onWaiting(await response.clone().json(), signal);
          await response.body?.cancel();
        } catch (e) {
          if (
            !(e instanceof TypeError) ||
            attempt >= maxRetries ||
            signal?.aborted
          )
            throw e;
        }
        await new Promise((resolve, reject) => {
          const timer = setTimeout(finish, retryDelayMs);
          function finish() {
            signal?.removeEventListener("abort", abort);
            resolve();
          }
          function abort() {
            clearTimeout(timer);
            signal?.removeEventListener("abort", abort);
            reject(signal.reason);
          }
          signal?.addEventListener("abort", abort, { once: true });
          if (signal?.aborted) abort();
        });
      }
    },
  };
}
