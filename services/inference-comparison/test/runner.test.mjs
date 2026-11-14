import test from "node:test";
import assert from "node:assert/strict";
import { ComparisonRunner, publicReport } from "../runner.mjs";
import { plan, time, stream } from "./helpers.mjs";
function setup(mode) {
  let calls = [];
  const runner = new ComparisonRunner(
    {
      storePath: ":memory:",
      storageKey: "a".repeat(64),
      arms: { A: {}, B: {} },
    },
    {
      now: () => time,
      executor: async (_, { arm }) => ({
        identity: { marketVerified: true },
        async dispatch({ body, idempotencyKey }) {
          calls.push({ arm: arm.id, body, idempotencyKey });
          if (mode === "loss" && arm.id === "A") throw Error("ack lost");
          return new Response(
            mode === "pending" && arm.id === "A"
              ? "pending"
              : stream(arm.model),
            {
              status: mode === "pending" && arm.id === "A" ? 202 : 200,
              headers: {
                "content-type": "text/event-stream",
                "x-bitrouter-request-id": "request-" + arm.id,
              },
            },
          );
        },
        async head() {
          return { status: "completed", settlement: "pending" };
        },
        async close() {},
      }),
    },
  );
  return { runner, calls };
}
test("same task and frozen prices use two fixed routes without exposing native output", async () => {
  const { runner, calls } = setup();
  try {
    const p = plan(),
      r = await runner.run(p, p.planHash);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].body.messages, calls[1].body.messages);
    assert.equal(calls[0].body.bitrouter_purchase.max_attempts, 1);
    assert.equal(calls[0].body.bitrouter_delivery.auto_fallback, "off");
    assert.notEqual(calls[0].idempotencyKey, calls[1].idempotencyKey);
    assert.equal(r.arms.A.state, "complete");
    assert.equal(r.arms.B.state, "complete");
    const report = publicReport(r);
    assert.equal(report.arms.A.serviceCostMicro, null);
    assert.equal(report.taskSuccess, null);
    assert.equal(report.arms.A.marketHardwareVerified, true);
    assert.equal(report.arms.A.providerBillMicro, null);
    assert.ok(!JSON.stringify(report).includes('response":"'));
    await runner.run(p, p.planHash);
    assert.equal(calls.length, 2);
  } finally {
    runner.close();
  }
});
test("ACK loss retains A Unknown, still records B, blocks replay purchase", async () => {
  const { runner, calls } = setup("loss");
  try {
    const p = plan(),
      r = await runner.run(p, p.planHash);
    assert.equal(r.arms.A.state, "unknown");
    assert.equal(r.arms.B.state, "complete");
    assert.equal(calls.length, 2);
    await runner.run(p, p.planHash);
    assert.equal(calls.length, 2);
  } finally {
    runner.close();
  }
});
test("202 remains pending and never becomes successful stream", async () => {
  const { runner } = setup("pending");
  try {
    const p = plan(),
      r = await runner.run(p, p.planHash);
    assert.equal(r.arms.A.state, "pending");
    assert.equal(r.arms.A.serviceCostMicro, null);
  } finally {
    runner.close();
  }
});
test("tampered review hash and expired plan make zero purchases", async () => {
  const { runner, calls } = setup();
  try {
    const p = plan();
    await assert.rejects(runner.run(p, "wrong"));
    p.deadlineMs = time - 1;
    await assert.rejects(runner.run(p, p.planHash));
    assert.equal(calls.length, 0);
  } finally {
    runner.close();
  }
});
