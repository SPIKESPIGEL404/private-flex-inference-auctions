import test from "node:test";
import assert from "node:assert/strict";
import { projectSettlement } from "../settlement.mjs";
import { ComparisonRunner } from "../runner.mjs";
import { plan, time, stream } from "./helpers.mjs";
const receipt = (id, key) => ({
  request_id: id,
  idempotency_key: key,
  workload_keyset_digest: "sha256:" + "1".repeat(64),
  receipt: {
    request_id: id,
    revision: 4,
    settlement: "committed",
    status: { status: "delivered" },
    financial: {
      seller: "project-chutes",
      provider_micro_usd: 5,
      platform_micro_usd: 2,
      promo_micro_usd: 1,
      cash_micro_usd: 6,
      released_micro_usd: 9994,
    },
    fees: { held_micro_usd: 0, provider_micro_usd: 5, platform_micro_usd: 2 },
  },
});
const binding = {
  requestId: "request-B",
  idempotencyKey: "original",
  budgetMicro: "10000",
};
test("actual signed ledger separates provider price, cash debit, promo and released hold", () => {
  const value = projectSettlement(receipt("request-B", "original"), binding);
  assert.equal(value.providerChargeMicro, "5");
  assert.equal(value.cashChargeMicro, "6");
  assert.equal(value.releasedMicro, "9994");
  assert.equal(value.reservedMicro, "10000");
});
test("reject mismatched identity, pending holds, changed amounts and budget overflow", () => {
  for (const mutate of [
    (r) => (r.request_id = "other"),
    (r) => (r.idempotency_key = "other"),
    (r) => (r.receipt.settlement = "pending"),
    (r) => (r.receipt.fees.held_micro_usd = 1),
    (r) => (r.receipt.financial.cash_micro_usd = 4),
    (r) => (r.receipt.financial.released_micro_usd = 10000),
    (r) => (r.receipt.financial.provider_micro_usd = -1),
  ]) {
    const r = receipt("request-B", "original");
    mutate(r);
    assert.throws(() => projectSettlement(r, binding));
  }
});
test("late settlement reconciles after expiry with zero new dispatches", async () => {
  let dispatches = 0,
    settled = false;
  const p = plan();
  const runner = new ComparisonRunner(
    {
      storePath: ":memory:",
      storageKey: "a".repeat(64),
      arms: { A: {}, B: {} },
    },
    {
      now: () => (settled ? time + 100000 : time),
      executor: async (_, { arm }) => ({
        identity: { marketVerified: true },
        async supply() {
          return { state: "ready", expiresAtMs: time + 100000 };
        },
        async dispatch() {
          dispatches++;
          return new Response(stream(arm.model), {
            headers: {
              "content-type": "text/event-stream",
              "x-bitrouter-request-id": "request-" + arm.id,
            },
          });
        },
        async head() {
          return {};
        },
        async receipt(id, key) {
          if (!settled) throw Error("pending");
          return receipt(id, key);
        },
        async close() {},
      }),
    },
  );
  try {
    const first = await runner.run(p, p.planHash);
    assert.equal(first.arms.B.settlementState, "pending");
    assert.equal(first.arms.B.serviceCostMicro, null);
    settled = true;
    const recovered = await runner.reconcile(p);
    assert.equal(recovered.arms.B.serviceCostMicro, "5");
    assert.equal(recovered.arms.B.settlement.cashChargeMicro, "6");
    assert.equal(dispatches, 2);
    await runner.reconcile(p);
    assert.equal(dispatches, 2);
  } finally {
    runner.close();
  }
});
test("warming supply makes zero B dispatches and no durable purchase claim", async () => {
  let calls = 0;
  const p = plan(),
    runner = new ComparisonRunner(
      {
        storePath: ":memory:",
        storageKey: "a".repeat(64),
        arms: { A: {}, B: {} },
      },
      {
        now: () => time,
        executor: async () => ({
          identity: {},
          async supply() {
            return { state: "warming", expiresAtMs: time + 45000 };
          },
          async dispatch() {
            calls++;
            throw Error("not expected");
          },
          async close() {},
        }),
      },
    );
  try {
    const result = await runner.runArm(p, "B");
    assert.equal(result.state, "supply_warming");
    assert.equal(result.paidInvokeAttempted, false);
    assert.equal(calls, 0);
    assert.deepEqual(runner.store.list("comparison-arm", p.ownerAccount), []);
  } finally {
    runner.close();
  }
});
