import test from "node:test";
import assert from "node:assert/strict";
import {
  createMemoryTask,
  sumTask,
  verifyArtifact,
  procurementTransport,
  sha256,
} from "../task.mjs";
const completion = (message, finish_reason = "stop") => {
  const id = crypto.randomUUID();
  const frame = (choices, usage) =>
    "data: " +
    JSON.stringify({
      id,
      object: "chat.completion.chunk",
      created: 1,
      model: "m/external",
      choices,
      ...(usage ? { usage } : {}),
    }) +
    "\n\n";
  const delta = { role: "assistant", ...message };
  if (delta.tool_calls)
    delta.tool_calls = delta.tool_calls.map((t, index) => ({ ...t, index }));
  return new Response(
    frame([{ index: 0, delta, finish_reason: null }]) +
      frame([{ index: 0, delta: {}, finish_reason }]) +
      frame([], {
        prompt_tokens: 100,
        completion_tokens: 60,
        total_tokens: 160,
      }) +
      "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } },
  );
};

test("real fx and just-bash: two purchases, tool-only response, shared files, independently correct artifact", async () => {
  const calls = [];
  const runtime = await createMemoryTask({
    task: sumTask([3, 7, 32]),
    backend: "native",
    deadlineMs: Date.now() + 30000,
    transport: {
      async invoke(call) {
        calls.push(call);
        const request = JSON.parse(call.body);
        if (calls.length === 1)
          return completion(
            {
              tool_calls: [
                {
                  id: "compute",
                  type: "function",
                  function: {
                    name: "bash",
                    arguments: JSON.stringify({
                      command: `awk '{s+=$1;n++} END {printf "{\\"sum\\":%d,\\"count\\":%d}\\n",s,n}' numbers.txt > result.json; cat result.json`,
                    }),
                  },
                },
              ],
            },
            "tool_calls",
          );
        assert.ok(
          request.messages.some(
            (m) => m.role === "tool" && m.content.includes("42"),
          ),
        );
        return completion({ content: "Verified the JSON result." });
      },
    },
  });
  try {
    const result = await runtime.run();
    assert.equal(result.state, "complete");
    assert.equal(result.calls.length, 2);
    assert.equal(result.tools.length, 1);
    assert.notEqual(calls[0].logicalCallId, calls[1].logicalCallId);
    assert.notEqual(calls[0].requestHash, calls[1].requestHash);
    assert.deepEqual(
      JSON.parse(await runtime.bash.fs.readFile("/workspace/result.json")),
      { sum: 42, count: 3 },
    );
    await assert.rejects(runtime.run(), /already_started/);
  } finally {
    await runtime.close();
  }
});

test("success text cannot substitute for correct artifact", () => {
  const task = sumTask([3, 7, 32]);
  assert.equal(
    verifyArtifact(task, '{"sum":41,"count":3}').outcome,
    "incorrect",
  );
  assert.equal(verifyArtifact(task, "done").outcome, "incorrect");
});

test("network ACK loss retries identical procurement identity and bytes without session APIs", async () => {
  const seen = [];
  let count = 0;
  const transport = procurementTransport({
    url: "https://market.example/procure",
    authorizationId: "auth",
    retryDelayMs: 1,
    fetcher: async (url, init) => {
      assert.equal(url, "https://market.example/procure");
      seen.push(init);
      if (++count === 1) throw new TypeError("ACK lost");
      return completion({ content: "same original result" });
    },
  });
  await transport.invoke({
    body: "{}",
    runId: "r",
    logicalCallId: "c",
    requestHash: "h",
    signal: AbortSignal.timeout(1000),
  });
  assert.equal(seen.length, 2);
  assert.equal(seen[0].body, seen[1].body);
  assert.equal(
    seen[0].headers["idempotency-key"],
    seen[1].headers["idempotency-key"],
  );
});

test("new page runtime starts no model calls, tool files or persistent task restoration", async () => {
  let calls = 0;
  const runtime = await createMemoryTask({
    task: sumTask([1]),
    backend: "native",
    deadlineMs: Date.now() + 30000,
    transport: {
      async invoke() {
        calls++;
        throw Error("must not auto-start");
      },
    },
  });
  try {
    assert.equal(calls, 0);
    assert.equal(runtime.evidence.state, "ready");
    await assert.rejects(runtime.bash.fs.readFile("/workspace/result.json"));
    const r = await runtime.bash.exec("cat /etc/passwd");
    assert.equal(r.exitCode, 1);
    const denied = await runtime.bash.exec("curl https://example.com");
    assert.notEqual(denied.exitCode, 0);
  } finally {
    await runtime.close();
  }
});

test("native MPP chat transport preserves exact OpenAI body and isolates bid metadata in headers", async () => {
  const body =
      '{"model":"Qwen/Qwen3.8-27B", "messages":[{"role":"user","content":"hello"}]}',
    calls = [];
  const transport = procurementTransport({
    url: "https://auction.example/v1/chat/completions",
    nativeChat: true,
    agentId: "agent-a",
    authorizationId: "grant-a",
    bidMultiplier: "1200000",
    maxTotalMicro: "5000",
    expiryMs: 1800000000000,
    fetcher: async (url, options) => {
      calls.push({ url, options });
      return new Response("data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  await transport.invoke({
    body,
    runId: "page-only",
    logicalCallId: "logical-1",
    requestHash: await sha256(body),
  });
  assert.equal(calls[0].options.body, body);
  assert.equal(calls[0].options.headers["x-auction-grant"], "grant-a");
  assert.equal(calls[0].options.headers["idempotency-key"], "logical-1");
  assert.equal(calls[0].options.credentials, "same-origin");
  assert.ok(!calls[0].options.body.includes("authorizationId"));
});

test("real fx text/bash requests pass live admission on both initial and tool-continuation calls", async () => {
  const { qualify } = await import("../../auction/live/admission.mjs");
  let n = 0;
  const runtime = await createMemoryTask({
    task: sumTask([3, 7, 32]),
    model: "Qwen/Qwen3.8-27B",
    deadlineMs: Date.now() + 20000,
    backend: "native",
    transport: {
      async invoke(call) {
        qualify(JSON.parse(call.body), call.body, {
          model: "Qwen/Qwen3.8-27B",
          minInputTokens: 0,
          maxInputTokens: 32000,
          tokenizer: "qwen-conservative-input-v1",
        });
        n++;
        const message =
          n === 1
            ? {
                role: "assistant",
                tool_calls: [
                  {
                    id: "bash-1",
                    type: "function",
                    function: {
                      name: "bash",
                      arguments: JSON.stringify({
                        command:
                          'cat /workspace/numbers.txt; printf \'{"sum":42,"count":3}\' > /workspace/result.json; cat /workspace/result.json',
                      }),
                    },
                  },
                ],
              }
            : { role: "assistant", content: "verified" };
        const response = completion(message, n === 1 ? "tool_calls" : "stop");
        return new Response(
          (await response.text()).replaceAll("m/external", "Qwen/Qwen3.8-27B"),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    },
  });
  try {
    const result = await runtime.run();
    assert.equal(n, 2);
    assert.equal(result.verification.outcome, "correct");
  } finally {
    await runtime.close();
  }
});

test("native chat retries the original body with the bound Payment authorization after 402", async () => {
  const headers = [];
  let n = 0;
  const transport = procurementTransport({
    url: "https://auction.example/v1/chat/completions",
    nativeChat: true,
    authorizationId: "grant",
    agentId: "agent",
    expiryMs: 1800000000000,
    retryDelayMs: 1,
    maxRetries: 2,
    onPaymentChallenge: async () => ({
      paymentAuthorization: "Payment original-bound-proof",
    }),
    fetcher: async (_url, init) => {
      headers.push(init.headers);
      return ++n === 1
        ? new Response(
            JSON.stringify({ challenge: { id: "original-challenge" } }),
            { status: 402 },
          )
        : new Response("data: [DONE]\n\n");
    },
  });
  await transport.invoke({
    body: "{}",
    logicalCallId: "logical",
    runId: "run",
    requestHash: await sha256("{}"),
  });
  assert.equal(headers[0].authorization, undefined);
  assert.equal(headers[1].authorization, "Payment original-bound-proof");
  assert.equal(headers[1]["idempotency-key"], "logical");
});
