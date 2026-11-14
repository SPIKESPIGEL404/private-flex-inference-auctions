import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareComparison, validateComparison } from "../core.mjs";
import { ComparisonRunner, publicReport } from "../runner.mjs";
import { tariffs, request, time, stream } from "./helpers.mjs";
const plan = (sequenceIndex = 0) =>
  prepareComparison({
    request,
    ...tariffs(),
    ownerAccount: "judge.near",
    budgetPerArmMicro: "10000",
    deadlineMs: time + 100000,
    taskDurationMs: 20000,
    sequenceIndex,
    now: time,
  });

test("AB/BA is frozen and authorization must cover both full budgets", () => {
  assert.deepEqual(plan(0).executionOrder, ["A", "B"]);
  assert.deepEqual(plan(1).executionOrder, ["B", "A"]);
  const changed = plan();
  changed.executionOrder.reverse();
  assert.throws(() => validateComparison(changed, time));
  assert.throws(
    () =>
      prepareComparison({
        request,
        ...tariffs(),
        ownerAccount: "judge.near",
        budgetPerArmMicro: "1",
        deadlineMs: time + 39999,
        taskDurationMs: 20000,
        now: time,
      }),
    /insufficient_authorization_window/,
  );
});

test("setup consumes each equal budget; receipts run after both usable results and survive restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "comparison-s0-"));
  const config = {
    storePath: join(directory, "evidence.sqlite"),
    storageKey: "b".repeat(64),
    arms: { A: {}, B: {} },
  };
  let wall = time,
    mono = 0,
    dispatches = 0,
    financial = false;
  const observations = [];
  const executor = async (_, { arm, deadlineMs, readOnly }) => {
    if (!readOnly) {
      observations.push({ arm: arm.id, remaining: deadlineMs - wall });
      wall += 100;
      mono += 100;
    }
    return {
      identity: { marketVerified: true },
      async dispatch() {
        assert.equal(readOnly, undefined);
        dispatches++;
        wall += 500;
        mono += 500;
        return new Response(stream(arm.model), {
          headers: {
            "content-type": "text/event-stream",
            "x-bitrouter-request-id": "r-" + arm.id,
          },
        });
      },
      async head() {
        assert.equal(dispatches, 2);
        financial = true;
        wall += 5000;
        mono += 5000;
        throw Error("RPC lost");
      },
      async receipt() {
        throw Error("receipt lost");
      },
      async close() {},
    };
  };
  let runner = new ComparisonRunner(config, {
    executor,
    now: () => wall,
    monotonic: () => mono,
  });
  try {
    const p = plan(1),
      report = await runner.run(p, p.planHash);
    assert.deepEqual(observations, [
      { arm: "B", remaining: 20000 },
      { arm: "A", remaining: 20000 },
    ]);
    assert.equal(financial, true);
    assert.equal(report.arms.B.completionMs, 600);
    assert.equal(report.arms.A.completionMs, 600);
    assert.equal(report.arms.A.usableResultAtMs, time + 1200);
    assert.equal(report.arms.A.state, "complete");
    assert.equal(publicReport(report).arms.B.buyerCompletionMs, 600);
    runner.close();
    wall = time + 200000;
    runner = new ComparisonRunner(config, { executor, now: () => wall });
    const recovered = await runner.recover(p, p.planHash);
    assert.equal(dispatches, 2);
    assert.equal(
      recovered.arms.B.usableResultAtMs,
      report.arms.B.usableResultAtMs,
    );
    assert.equal(recovered.arms.B.responseState, "available");
    assert.equal(recovered.arms.B.settlementState, "unknown");
  } finally {
    runner.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("verification timeout never dispatches; assigned task stays in manifest", async () => {
  let wall = time;
  const p = plan();
  const runner = new ComparisonRunner(
    {
      storePath: ":memory:",
      storageKey: "b".repeat(64),
      arms: { A: {}, B: {} },
    },
    {
      now: () => wall,
      executor: async () => {
        wall += 20001;
        return {
          identity: {},
          dispatch() {
            assert.fail("must not buy");
          },
          async close() {},
        };
      },
    },
  );
  try {
    const report = await runner.run(p, p.planHash);
    assert.equal(report.arms.A.state, "not_dispatched_deadline");
    assert.equal(report.arms.B.state, "not_dispatched_deadline");
    assert.ok(runner.store.get("comparison-plan", p.planHash, p.ownerAccount));
  } finally {
    runner.close();
  }
});
