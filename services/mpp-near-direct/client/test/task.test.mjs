import test from "node:test";
import assert from "node:assert/strict";
import {
  createMemoryTask,
  sumTask,
  verifyArtifact,
  procurementTransport,
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
