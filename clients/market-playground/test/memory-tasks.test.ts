import test from "node:test";
import assert from "node:assert/strict";
import { MemoryTaskController, defaultAuction } from "../src/memory-tasks";
import { maximumLiability, buyerBid } from "../src/auction-policy";
import {
  freezeClass,
  pricingContract,
} from "../../../services/mpp-near-direct/auction/contracts.mjs";
import type { MemoryTask } from "../../../services/mpp-near-direct/client/task.mjs";
import type { taskApi } from "../src/task-api";
const wait = () => new Promise((r) => setTimeout(r, 0));
const deferred = () => {
  let resolve!: (v?: unknown) => void;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
function fixture() {
  const now = Date.now(),
    requests: Array<{ path: string; body?: any }> = [],
    grants: any[] = [
      {
        id: "root-a",
        agent_id: "a",
        payer: "a.testnet",
        revision: "0",
        active: true,
        deadline_ms: String(now + 600000),
        agent_deadline_ms: String(now + 600000),
        call_cap_micro: "100000",
        gas_cap_yocto: "1000000000000000000",
        cap_nano: "100000000",
        reserved_nano: "0",
        spent_nano: "0",
        agent_cap_nano: "100000000",
        agent_reserved_nano: "0",
        agent_spent_nano: "0",
      },
    ];
  const service = freezeClass({
    model: "m/external",
    checkpoint: "fixture",
    quantization: "none",
    tokenizer: "fixture",
    template: "fixture",
    engine: "fixture",
    capacityPoolId: "single-seller-1",
    minInputTokens: 1,
    maxInputTokens: 1000,
    maxOutputTokens: 512,
    rates: { input: "40000", cache_input: "18000", output: "1350000" },
    fee: { version: "flat-plus-bps-v1", flatMicro: "1", bps: "100" },
    features: "text-and-bash-v1",
    delivery: "verified-complete-response-v1",
  });
  const pricing = {
    fx: {
      source: "controlled-fx",
      nanoUsdPerNear: "2000000000",
      observedAtMs: now,
      expiresAtMs: now + 600000,
    },
    paymentWindowMs: 10000,
    admissionWindowMs: 20000,
  };
  let revokeAckLoss = false;
  const orders: any[] = [];
  const api = (async (path: string, body?: any) => {
    requests.push({ path, body });
    if (path === "authorizations" && !body)
      return { grants: [...grants], bids: [], service, pricing };
    if (path === "orders") return { orders };
    if (path === "authorizations" && body) {
      let g = grants.find((g) => g.operation === body.operation);
      if (!g) {
        g = {
          ...grants[0],
          operation: body.operation,
          id: "grant-" + grants.length,
          cap_nano: body.budgetNano,
          deadline_ms: String(body.deadlineMs),
        };
        grants.push(g);
      }
      return { id: g.id, revision: g.revision };
    }
    if (path.endsWith("/revoke")) {
      const g = grants.find((g) => g.id === path.split("/")[1]);
      g.active = false;
      g.revision = "1";
      if (revokeAckLoss) {
        revokeAckLoss = false;
        throw new TypeError("ACK lost");
      }
      return { active: false };
    }
    throw Error("Unexpected API " + path);
  }) as typeof taskApi;
  return {
    api,
    requests,
    grants,
    orders,
    service,
    pricing,
    loseRevokeAck() {
      revokeAckLoss = true;
    },
  };
}
function runtime(gate = deferred()) {
  let runs = 0,
    closes = 0;
  const value: MemoryTask = {
    runId: "fixture",
    evidence: {
      version: 1,
      runId: "fixture",
      taskVersion: "fixture",
      state: "running",
      startedAtMs: Date.now(),
      calls: [],
      tools: [],
    },
    async run() {
      runs++;
      await gate.promise;
      return { ...value.evidence, state: "complete" };
    },
    async readWorkspace() {
      return { "/workspace/result.json": '{"sum":42,"count":3}' };
    },
    async close() {
      closes++;
      gate.resolve();
    },
  };
  return {
    value,
    gate,
    get runs() {
      return runs;
    },
    get closes() {
      return closes;
    },
  };
}

test("view refresh never starts a runtime or writes a backend task session; task runs only once", async () => {
  const f = fixture(),
    r = runtime();
  let factories = 0;
  const c = new MemoryTaskController({
    api: f.api,
    factory: async () => {
      factories++;
      return r.value;
    },
  });
  await c.refresh("owner");
  assert.equal(factories, 0);
  assert.ok(f.requests.every((q) => !q.body));
  const id = c.snapshot().sessions[0].id;
  const running = c.run(id);
  while (!factories) await wait();
  assert.equal(r.runs, 1);
  await c.refresh("owner");
  await c.run(id);
  assert.equal(factories, 1);
  assert.equal(c.snapshot().sessions[0].id, id);
  const grant = f.requests.find(
    (q) => q.path === "authorizations" && q.body,
  )!.body;
  assert.deepEqual(Object.keys(grant).sort(), [
    "agentId",
    "budgetNano",
    "callCapMicro",
    "deadlineMs",
    "operation",
  ]);
  assert.ok(
    !f.requests.some((q) => /sessions|journal|workspace|\/tool/.test(q.path)),
  );
  r.gate.resolve();
  await running;
  assert.equal(c.snapshot().sessions[0].state, "complete");
  assert.equal(
    c.snapshot().details[id].workspace["/workspace/result.json"],
    '{"sum":42,"count":3}',
  );
  c.reset();
});
test("owner switch during runtime startup disposes the old runtime before it can run", async () => {
  const f = fixture(),
    r = runtime(),
    startup = deferred();
  let started = false;
  const c = new MemoryTaskController({
    api: f.api,
    factory: async () => {
      started = true;
      await startup.promise;
      return r.value;
    },
  });
  await c.refresh("old-owner");
  const id = c.snapshot().sessions[0].id;
  const run = c.run(id);
  while (!started) await wait();
  c.reset();
  await c.refresh("new-owner");
  startup.resolve();
  await run;
  assert.equal(r.runs, 0);
  assert.equal(r.closes, 1);
  assert.notEqual(c.snapshot().sessions[0].id, id);
  assert.equal(c.snapshot().ownerScope, "new-owner");
  c.reset();
});
test("pause ACK loss leaves revocation unconfirmed; retry reconciles the same financial grant", async () => {
  const f = fixture(),
    r = runtime();
  const c = new MemoryTaskController({
    api: f.api,
    factory: async () => r.value,
  });
  await c.refresh("owner");
  const id = c.snapshot().sessions[0].id;
  const run = c.run(id);
  while (!r.runs) await wait();
  f.loseRevokeAck();
  assert.equal(await c.pause(id), false);
  assert.match(c.snapshot().details[id].error!, /unconfirmed/);
  assert.equal(await c.pause(id), true);
  assert.equal(c.snapshot().sessions[0].state, "paused");
  await run;
  assert.equal(
    f.requests.filter((q) => q.path === "authorizations" && q.body).length,
    1,
  );
  assert.equal(f.requests.filter((q) => q.path.endsWith("/revoke")).length, 1);
  c.reset();
});
test("new page queries historical finance but reconstructs no conversation, files or runtime", async () => {
  const f = fixture();
  f.orders.push({
    allocationId: "order",
    orderId: "order",
    agentId: "a",
    authorizationId: "old-grant",
    executionState: "unknown",
    paymentState: "confirmed",
    settlementState: "usage_pending",
    bidId: "bid",
    bidRevision: "0",
    contract: { bidMultiplier: "1200000" },
    principal: {
      prepaid: "10",
      charged: "0",
      refundPending: "0",
      refunded: "0",
    },
  });
  const c = new MemoryTaskController({
    api: f.api,
    factory: async () => {
      assert.fail("no automatic resume");
    },
  });
  await c.refresh("owner");
  const s = c.snapshot(),
    row = s.sessions[0];
  assert.equal(row.state, "ready");
  assert.equal(s.details[row.id].orders[0].historical, true);
  assert.equal(
    s.details[row.id].workspace["/workspace/result.json"],
    undefined,
  );
  assert.equal(f.requests.filter((q) => q.body).length, 0);
  c.reset();
});
test("increasing the task cap does not raise the economic bid; browser liability matches Market integer contract", () => {
  const f = fixture(),
    settings = { ...defaultAuction, policy: "task-aware" as const };
  const args = {
    settings,
    losses: 0,
    availableNano: 10000000n,
    callCapMicro: "100000",
    futureCalls: 1,
    service: f.service,
    pricing: f.pricing,
    gasCapYocto: "1000000000000000000",
    deadlineMs: Date.now() + 120000,
  };
  assert.equal(buyerBid(args).multiplier, "1000000");
  assert.equal(
    buyerBid({ ...args, availableNano: 100000000n }).multiplier,
    "1000000",
  );
  const mine = maximumLiability(
      f.service,
      f.pricing,
      args.gasCapYocto,
      "1400000",
    ),
    market = pricingContract({
      service: f.service,
      bidMultiplier: "1400000",
      fx: f.pricing.fx,
      gasCapYocto: args.gasCapYocto,
      nowMs: Date.now(),
      paymentWindowMs: 10000,
      admissionWindowMs: 20000,
    });
  assert.equal(String(mine.totalMicro), market.maximum.totalMicro);
  assert.equal(String(mine.reserveNano), market.reserveNano);
});
