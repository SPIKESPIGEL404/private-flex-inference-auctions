import test from "node:test";
import assert from "node:assert/strict";
import { freezeExperiment, economicReport } from "../experiment.mjs";
const manifest = () =>
  freezeExperiment({
    seed: 42,
    scope: "controlled",
    serviceClassVersion: "class-v1",
    codeRevision: "fixture-code",
    policyVersion: "fixed-v1",
    tasks: [
      {
        id: "a",
        group: "B",
        budgetGroup: "low",
        releaseAtMs: 1000,
        deadlineMs: 2000,
        initialBudgetNano: "1000",
      },
      {
        id: "b",
        group: "B",
        budgetGroup: "low",
        releaseAtMs: 1000,
        deadlineMs: 2000,
        initialBudgetNano: "1000",
      },
    ],
  });
const task = (id, order) => ({
  id,
  verification: { outcome: "correct" },
  completedAtMs: 1500,
  elapsedMs: 500,
  orderIds: [order],
});
const finance = (orderId) => ({
  orderId,
  scope: "controlled",
  settlementState: "refund_confirmed",
  principal: { prepaid: "100", charged: "30", refunded: "70" },
  gasActualYocto: "2",
  refundGasYocto: "1",
});
test("all assigned tasks remain denominator; missing evidence never becomes zero-cost success", () => {
  const r = economicReport(
    manifest(),
    [task("a", "order-a")],
    [finance("order-a")],
  ).groups["B:low"];
  assert.equal(r.assigned, 2);
  assert.equal(r.onTimeCorrect, 1);
  assert.equal(r.missingTasks, 1);
  assert.equal(r.finalBuyerCostYocto, null);
  assert.equal(r.costPerOnTimeSuccess, null);
  assert.equal(r.knownBuyerCostYocto, "32");
  assert.equal(r.sellerRevenueYocto, "30");
});
test("final fee already excludes refund; buyer gas and merchant refund gas have distinct ledgers", () => {
  const r = economicReport(
    manifest(),
    [task("a", "oa"), task("b", "ob")],
    [finance("oa"), finance("ob")],
  ).groups["B:low"];
  assert.equal(r.finalBuyerCostYocto, "64");
  assert.deepEqual(r.costPerOnTimeSuccess, {
    numeratorYocto: "64",
    denominator: 2,
  });
  assert.equal(r.refundGasYocto, "2");
});
test("unknown liabilities and zero successes remain explicit", () => {
  const records = [
    { ...task("a", "oa"), verification: { outcome: "incorrect" } },
    { ...task("b", "ob"), completedAtMs: 2001 },
  ];
  let r = economicReport(manifest(), records, [finance("oa"), finance("ob")])
    .groups["B:low"];
  assert.equal(r.onTimeCorrect, 0);
  assert.equal(r.costPerOnTimeSuccess, null);
  assert.equal(r.costStatus, "no_on_time_successes");
  r = economicReport(manifest(), records, [
    {
      ...finance("oa"),
      settlementState: "unknown",
      principal: { prepaid: "100", charged: "0", refunded: "0" },
    },
    finance("ob"),
  ]).groups["B:low"];
  assert.equal(r.unresolvedPrincipalYocto, "100");
  assert.equal(r.finalBuyerCostYocto, null);
});
test("changed manifest and reused orders are rejected", () => {
  const m = manifest();
  m.tasks.pop();
  assert.throws(() => economicReport(m, [], []), /changed/);
  assert.throws(
    () =>
      economicReport(
        manifest(),
        [task("a", "same"), task("b", "same")],
        [finance("same")],
      ),
    /twice/,
  );
});
