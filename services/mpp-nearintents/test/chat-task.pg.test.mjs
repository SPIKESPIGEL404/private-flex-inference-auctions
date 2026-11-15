import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture, TOKEN, policy } from "./chat-fixture.mjs";
import { paidChatTransport } from "../chat/client.mjs";

test(
  "real fx/just-bash task buys two inferences through the same paid chat API and verifies its artifact",
  {
    skip: !(
      process.env.CHAT_TEST_DATABASE_URL &&
      process.env.CHAT_TEST_TASK_RUNTIME === "1"
    ),
  },
  async (t) => {
    const { createMemoryTask, sumTask } = await import(
      "../../mpp-near-direct/client/task.mjs"
    );
    const f = await fixture(t, {
      providerReply(body, count) {
        if (count > 1)
          assert.ok(
            body.messages.some(
              (m) => m.role === "tool" && m.content.includes("42"),
            ),
          );
        const delta =
          count === 1
            ? {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
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
              }
            : { role: "assistant", content: "Verified the JSON result." };
        const frame = (choices, usage) =>
          "data: " +
          JSON.stringify({
            id: "task-response-" + count,
            model: body.model,
            object: "chat.completion.chunk",
            created: 1,
            choices,
            ...(usage ? { usage } : {}),
          }) +
          "\n\n";
        return {
          contentType: "text/event-stream",
          raw:
            frame([{ index: 0, delta, finish_reason: null }]) +
            frame([
              {
                index: 0,
                delta: {},
                finish_reason: count === 1 ? "tool_calls" : "stop",
              },
            ]) +
            frame([], {
              prompt_tokens: 100,
              completion_tokens: 60,
              total_tokens: 160,
            }) +
            "data: [DONE]\n\n",
        };
      },
    });
    const runtime = await createMemoryTask({
      task: sumTask([3, 7, 32]),
      model: "test/qwen",
      backend: "native",
      maxOutputTokens: 128,
      deadlineMs: Date.now() + 30000,
      transport: paidChatTransport({
        url: f.app.url,
        token: TOKEN,
        payer: f.payer,
        journal: f.journal,
        policy: policy(),
        controlled: true,
      }),
    });
    try {
      const result = await runtime.run();
      assert.equal(result.state, "complete");
      assert.equal(result.calls.length, 2);
      assert.equal(result.tools.length, 1);
      assert.deepEqual(
        JSON.parse(await runtime.bash.fs.readFile("/workspace/result.json")),
        { sum: 42, count: 3 },
      );
      assert.equal(f.counters.deposits, 2);
      assert.equal(f.counters.inference, 2);
      assert.equal(f.counters.quotes, 2);
      assert.equal(
        (
          await f.pool.query(
            "SELECT count(*)::int AS n FROM chat_calls WHERE state='complete' AND receipt IS NOT NULL",
          )
        ).rows[0].n,
        2,
      );
    } finally {
      await runtime.close();
    }
  },
);
