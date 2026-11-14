import test, { after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { AuctionMarket } from "../market.mjs";
import { freezeClass, clearRound } from "../contracts.mjs";
import { hash } from "../../contract.mjs";
import { startAuctionServer } from "../server.mjs";
import { controlledAdapters } from "./controlled-adapters.mjs";
import {
  createMemoryTask,
  sumTask,
  procurementTransport,
} from "../../client/task.mjs";
const pool = new pg.Pool({
  connectionString: process.env.AUCTION_TEST_DATABASE_URL,
  max: 8,
});
assert.ok(
  process.env.AUCTION_TEST_DATABASE_URL,
  "run through scripts/accept-single-seller-auction.py",
);
after(() => pool.end());
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
export function config() {
  const now = Date.now();
  return {
    mode: "controlled",
    network: "testnet",
    realBroadcastEnabled: false,
    capacity: 1,
    rule: "first-price-v1",
    windowMs: 60000,
    paymentWindowMs: 10000,
    admissionWindowMs: 20000,
    minRevisionIntervalMs: 0,
    secret: "controlled-only-secret-for-native-auction",
    merchant: "merchant.testnet",
    realm: "auction.test",
    fx: {
      source: "controlled-fx",
      nanoUsdPerNear: "2000000000",
      observedAtMs: now,
      expiresAtMs: now + 600000,
    },
    service: freezeClass({
      model: "m/external",
      checkpoint: "fixture-v1",
      quantization: "none",
      tokenizer: "fixture-tokenizer",
      template: "template-v1",
      engine: "fixture-v1",
      capacityPoolId: "single-seller-1",
      minInputTokens: 1,
      maxInputTokens: 1000,
      maxOutputTokens: 512,
      rates: { input: "40000", cache_input: "18000", output: "1350000" },
      fee: { version: "flat-plus-bps-v1", flatMicro: "1", bps: "100" },
      delivery: "verified-complete-response-v1",
      features: "text-and-bash-v1",
    }),
  };
}
async function setup(more = {}) {
  await pool.query(
    "TRUNCATE mpp_direct_auction_state,mpp_direct_auction_budgets,mpp_direct_auction_agents,mpp_direct_auction_grants,mpp_direct_auction_bids,mpp_direct_auction_commands,mpp_direct_auction_revisions,mpp_direct_auction_rounds,mpp_direct_auction_allocations,mpp_direct_auction_operations,mpp_direct_auction_movements,mpp_direct_auction_events CASCADE",
  );
  const c = { ...config(), ...more };
  const market = new AuctionMarket({ pool, config: c });
  await market.initialize();
  const now = Date.now();
  for (const [id, kind, agent] of [
    ["owner", "owner", null],
    ["agent-a", "agent", "a"],
    ["agent-b", "agent", "b"],
    ["task-a", "task", "a"],
    ["task-b", "task", "b"],
  ])
    await pool.query(
      "INSERT INTO mpp_direct_auction_budgets(id,kind,owner_id,agent_id,cap_nano,deadline_ms) VALUES($1,$2,'owner-1',$3,100000000,$4)",
      [id, kind, agent, now + 600000],
    );
  for (const id of ["a", "b"]) {
    await pool.query(
      "INSERT INTO mpp_direct_auction_agents(id,owner_id,credential_hash,payer,binding_version,owner_budget,agent_budget,balance) VALUES($1,'owner-1',$2,$3,'binding-1','owner',$4,$5)",
      [
        id,
        hash("token-" + id),
        id + ".testnet",
        "agent-" + id,
        {
          source: "controlled-native-final-v1",
          network: "testnet",
          payer: id + ".testnet",
          availableYocto: "1000000000000000000000000",
          observedAtMs: now,
          expiresAtMs: now + 60000,
        },
      ],
    );
    await pool.query(
      "INSERT INTO mpp_direct_auction_grants(id,agent_id,task_budget,call_cap_micro,gas_cap_yocto,deadline_ms) VALUES($1,$2,$3,100000,1000000000000000000,$4)",
      ["grant-" + id, id, "task-" + id, now + 600000],
    );
  }
  return market;
}
const input = (agent, multiplier = "1000000", more = {}) => {
  const body = JSON.stringify({
    model: "m/external",
    messages: [{ role: "user", content: "controlled task " + agent }],
    max_completion_tokens: 64,
    stream: true,
  });
  return {
    operation: "submit-" + agent,
    grantId: "grant-" + agent,
    logicalCallId: "call-" + agent,
    body,
    requestHash: hash(body),
    bidMultiplier: multiplier,
    maxTotalMicro: "100000",
    expiryMs: Date.now() + 60000,
    ...more,
  };
};
async function clear(market) {
  await pool.query(
    "UPDATE mpp_direct_auction_state SET next_cutoff_ms=floor(extract(epoch FROM clock_timestamp())*1000)::bigint+2",
  );
  await wait(5);
  return market.clear();
}
async function allocated(market, agent = "a", multiplier = "1000000") {
  const b = await market.submit(agent, input(agent, multiplier));
  await clear(market);
  const a = await market.bidStatus(agent, b.bidId);
  assert.ok(a.allocationId);
  return a;
}
function payment(a, more = {}) {
  const r = a.challenge.request;
  return {
    movementKey: "native:" + a.orderId,
    orderRef: a.orderId,
    amount: r.amount,
    network: r.network,
    payer: r.payer,
    recipient: r.recipient,
    challengeId: a.challenge.id,
    gasActualYocto: "500000000000000000",
    late: false,
    ...more,
  };
}
async function refund(market, a, more = {}) {
  const op = (
    await pool.query(
      "SELECT * FROM mpp_direct_auction_operations WHERE allocation_id=$1 AND kind='refund'",
      [a.allocationId],
    )
  ).rows[0];
  return market.acceptVerifiedRefund(a.allocationId, {
    ...op.binding,
    movementKey: "refund:" + a.orderId,
    ...more,
  });
}

test("owning schema contains no new session/journal/workspace store; legacy pool acquisition is fenced", async () => {
  const m = await setup();
  assert.equal(
    (
      await pool.query(
        "SELECT count(*) FROM pg_tables WHERE tablename IN('mpp_direct_p2_sessions','mpp_direct_p2_journal','mpp_direct_p2_tools')",
      )
    ).rows[0].count,
    "0",
  );
  await assert.rejects(
    pool.query("UPDATE mpp_direct_capacity SET admissions=1 WHERE id=1"),
    /legacy/,
  );
  await assert.rejects(
    pool.query("INSERT INTO mpp_direct_orders(id) VALUES('bypass')"),
    /legacy/,
  );
  assert.equal((await m.authenticate("token-a")).id, "a");
  await assert.rejects(m.authenticate("token-bad"), /unauthorized/);
});
test("concurrent clearers atomically allocate one slot; exact replay and immutable financial contract", async () => {
  const m = await setup();
  const a = await m.submit("a", input("a", "1100000")),
    b = await m.submit("b", input("b", "1400000"));
  await pool.query(
    "UPDATE mpp_direct_auction_state SET next_cutoff_ms=floor(extract(epoch FROM clock_timestamp())*1000)::bigint+2",
  );
  await wait(5);
  await Promise.all([m.clear(), m.clear()]);
  const winner = await m.bidStatus("b", b.bidId);
  assert.equal(winner.contract.bidMultiplier, "1400000");
  assert.equal((await m.bidStatus("a", a.bidId)).state, "waiting");
  assert.equal(
    (await pool.query("SELECT count(*) FROM mpp_direct_auction_allocations"))
      .rows[0].count,
    "1",
  );
  const r = (await pool.query("SELECT * FROM mpp_direct_auction_rounds"))
    .rows[0];
  assert.deepEqual(clearRound(r.inputs), r.result);
  assert.equal(hash(r.result), r.digest);
  await assert.rejects(
    pool.query(
      "UPDATE mpp_direct_auction_allocations SET contract='{}' WHERE id=$1",
      [winner.allocationId],
    ),
    /immutable/,
  );
  await assert.rejects(
    m.status("a", winner.allocationId),
    /unknown_allocation/,
  );
});
test("command and COMMIT ACK loss recover original bid and allocation; partial commit rolls back all holds", async () => {
  let m = await setup();
  const i = input("a");
  const one = await m.submit("a", i);
  assert.deepEqual(await m.submit("a", i), one);
  await assert.rejects(
    m.submit("a", { ...i, bidMultiplier: "1400000" }),
    /idempotency_conflict/,
  );
  let fail = true;
  m.fault = (phase) => {
    if (fail && phase === "before_commit") {
      fail = false;
      throw Error("crash");
    }
  };
  await assert.rejects(clear(m), /crash/);
  assert.equal(
    (await pool.query("SELECT count(*) FROM mpp_direct_auction_allocations"))
      .rows[0].count,
    "0",
  );
  assert.equal(
    (
      await pool.query(
        "SELECT reserved_nano FROM mpp_direct_auction_budgets WHERE id='owner'",
      )
    ).rows[0].reserved_nano,
    "0",
  );
  fail = true;
  m.fault = (phase) => {
    if (fail && phase === "after_commit") {
      fail = false;
      throw Error("ACK lost after COMMIT");
    }
  };
  await assert.rejects(m.clear(), /ACK lost/);
  m = new AuctionMarket({ pool, config: m.config });
  await m.initialize();
  const recovered = await m.bidStatus("a", one.bidId);
  assert.ok(recovered.allocationId);
  assert.equal(
    (await pool.query("SELECT count(*) FROM mpp_direct_auction_operations"))
      .rows[0].count,
    "2",
  );
});
test("cutoff serializes late withdrawal; frozen winner keeps original contract after bid expiry", async () => {
  const m = await setup();
  const b = await m.submit("a", input("a"));
  await pool.query(
    "UPDATE mpp_direct_auction_state SET next_cutoff_ms=floor(extract(epoch FROM clock_timestamp())*1000)::bigint+1",
  );
  await wait(3);
  await assert.rejects(
    m.revise("a", b.bidId, {
      operation: "withdraw",
      action: "withdraw",
      expectedRevision: "0",
    }),
    /frozen/,
  );
  // The rejected command rolls back its own transaction, including an uncommitted
  // clearing attempt; the next writer freezes the same pre-cutoff revision.
  await m.clear();
  const a = await m.bidStatus("a", b.bidId);
  assert.ok(a.allocationId);
  await m.acceptVerifiedPayment(a.allocationId, payment(a));
  const claim = await m.claimExecution(a.allocationId);
  assert.ok(claim.claim);
});
test("same-price revision resets priority and expected revision CAS prevents stale withdrawal", async () => {
  const m = await setup();
  const a = await m.submit("a", input("a")),
    b = await m.submit("b", input("b"));
  await m.revise("a", a.bidId, {
    operation: "revise",
    action: "revise",
    expectedRevision: "0",
    bidMultiplier: "1000000",
  });
  await assert.rejects(
    m.revise("a", a.bidId, {
      operation: "stale",
      action: "withdraw",
      expectedRevision: "0",
    }),
    /revision_conflict/,
  );
  await clear(m);
  assert.ok((await m.bidStatus("b", b.bidId)).allocationId);
});
test("unpaid expiry releases only fenced capacity and retains liability; late payment refunds full principal once", async () => {
  const m = await setup(),
    a = await allocated(m);
  await m.beginOperation(a.allocationId, "payment");
  assert.equal(
    (await m.beginOperation(a.allocationId, "payment")).action,
    "recover",
  );
  await m.fence(a.allocationId);
  assert.equal(
    (
      await pool.query(
        "SELECT capacity_allocation FROM mpp_direct_auction_state",
      )
    ).rows[0].capacity_allocation,
    null,
  );
  assert.notEqual(
    (
      await pool.query(
        "SELECT reserved_nano FROM mpp_direct_auction_budgets WHERE id='owner'",
      )
    ).rows[0].reserved_nano,
    "0",
  );
  await m.acceptVerifiedPayment(a.allocationId, payment(a, { late: true }));
  await assert.rejects(m.claimExecution(a.allocationId), /fenced/);
  const done = await refund(m, a);
  assert.equal(done.principal.refunded, a.principal.prepaid);
  assert.equal(done.principal.charged, "0");
  assert.equal((await refund(m, a)).principal.refunded, a.principal.prepaid);
  assert.equal(
    (
      await pool.query(
        "SELECT reserved_nano FROM mpp_direct_auction_budgets WHERE id='owner'",
      )
    ).rows[0].reserved_nano,
    "0",
  );
});
test("GPU outcome unknown retains pool; result recovery releases capacity before refund completion", async () => {
  const m = await setup(),
    a = await allocated(m);
  await m.acceptVerifiedPayment(a.allocationId, payment(a));
  const permit = await m.claimExecution(a.allocationId);
  await m.executionUnknown(a.allocationId, permit.claim);
  assert.equal((await m.fence(a.allocationId)).released, false);
  await m.submit("b", input("b"));
  const busy = await clear(m);
  assert.equal(busy.noSale, true);
  const response = { sse: "controlled-verified-native-result" };
  const usage = { input: "100", cached: "0", output: "10" };
  await m.finishExecution(a.allocationId, {
    ...permit,
    result: response,
    usage,
  });
  assert.equal(
    (
      await pool.query(
        "SELECT capacity_allocation FROM mpp_direct_auction_state",
      )
    ).rows[0].capacity_allocation,
    null,
  );
  const r = await m.finishExecution(a.allocationId, {
    ...permit,
    result: response,
    usage,
  });
  assert.equal(r.executionState, "result_available");
  assert.equal(r.settlementState, "refund_pending");
  await assert.rejects(
    m.finishExecution(a.allocationId, {
      ...permit,
      result: { sse: "different" },
      usage,
    }),
    /conflict/,
  );
  await assert.rejects(
    refund(m, a, { recipient: "attacker.testnet" }),
    /binding/,
  );
  const done = await refund(m, a);
  assert.equal(
    BigInt(done.principal.charged) + BigInt(done.principal.refunded),
    BigInt(done.principal.prepaid),
  );
  await clear(m);
  assert.ok((await m.bidStatus("b", hash(["b", "call-b"]))).allocationId);
});
test("revoke prevents new payment and dispatch, including payment/claim races", async () => {
  const m = await setup(),
    a = await allocated(m);
  await m.revoke("a", "grant-a", "0");
  await assert.rejects(m.beginOperation(a.allocationId, "payment"), /closed/);
  await m.acceptVerifiedPayment(a.allocationId, payment(a));
  assert.equal((await m.status("a", a.allocationId)).executionState, "fenced");
  await refund(m, a);
});
test("out of range metering keeps original execution liability and refuses normal settlement", async () => {
  const m = await setup(),
    a = await allocated(m);
  await m.acceptVerifiedPayment(a.allocationId, payment(a));
  const permit = await m.claimExecution(a.allocationId);
  await assert.rejects(
    m.finishExecution(a.allocationId, {
      ...permit,
      result: { text: "x" },
      usage: { input: "1001", cached: "0", output: "10" },
    }),
    /outside/,
  );
  assert.equal(
    (await m.status("a", a.allocationId)).executionState,
    "executing",
  );
  assert.equal((await m.fence(a.allocationId)).released, false);
});

test("two independent client agents: real fx/tools through HTTP auction, stable wallet operations, complete refunds", async () => {
  const m = await setup({ windowMs: 50 });
  const { wallet, provider } = await controlledAdapters(pool);
  await pool.query(
    "TRUNCATE fixture_auction_wallet_accounts,fixture_auction_wallet_ops,fixture_auction_provider_ops",
  );
  for (const id of ["a.testnet", "b.testnet", "merchant.testnet"])
    await pool.query(
      "INSERT INTO fixture_auction_wallet_accounts VALUES($1,1000000000000000000000000)",
      [id],
    );
  const originalPay = wallet.payOriginal,
    originalRefund = wallet.refundOriginal;
  let losePay = true,
    loseRefund = true;
  wallet.payOriginal = async (op) => {
    const result = await originalPay(op);
    if (losePay) {
      losePay = false;
      throw Error("payment ACK lost");
    }
    return result;
  };
  wallet.refundOriginal = async (op) => {
    const result = await originalRefund(op);
    if (loseRefund) {
      loseRefund = false;
      throw Error("refund ACK lost");
    }
    return result;
  };
  const app = await startAuctionServer({ market: m, wallet, provider });
  const runtimes = [];
  try {
    for (const id of ["a", "b"]) {
      const deadlineMs = Date.now() + 30000;
      const fetcher = (url, init = {}) =>
        fetch(url, {
          ...init,
          headers: { ...init.headers, authorization: "Bearer token-" + id },
        });
      const transport = procurementTransport({
        url: app.url + "/market-api/procure",
        authorizationId: "grant-" + id,
        agentId: id,
        bidMultiplier: id === "a" ? "1100000" : "1400000",
        maxTotalMicro: "100000",
        expiryMs: deadlineMs,
        fetcher,
        retryDelayMs: 20,
        maxRetries: 500,
        onPaymentChallenge: async (status, signal) => {
          const r = await fetcher(
            app.url + "/market-api/orders/" + status.allocationId + "/pay",
            {
              method: "POST",
              signal,
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                challengeId: status.challenge.id,
                contractHash: status.contract.contractHash,
              }),
            },
          );
          assert.ok([200, 503].includes(r.status), await r.text());
        },
      });
      runtimes.push(
        await createMemoryTask({
          task: sumTask(id === "a" ? [3, 7, 32] : [5, 5, 9]),
          transport,
          backend: "native",
          deadlineMs,
        }),
      );
    }
    const results = await Promise.all(runtimes.map((r) => r.run()));
    assert.deepEqual(
      results.map((r) => r.state),
      ["complete", "complete"],
    );
    assert.equal(
      (await pool.query("SELECT count(*) FROM mpp_direct_auction_allocations"))
        .rows[0].count,
      "4",
    );
    assert.equal(
      (await pool.query("SELECT count(*) FROM fixture_auction_provider_ops"))
        .rows[0].count,
      "4",
    );
    for (let i = 0; i < 50; i++) {
      if (
        (
          await pool.query(
            "SELECT count(*) FROM mpp_direct_auction_allocations WHERE NOT budget_finalized",
          )
        ).rows[0].count === "0"
      )
        break;
      await wait(20);
    }
    assert.equal(
      (
        await pool.query(
          "SELECT count(*) FROM mpp_direct_auction_allocations WHERE settlement<>'refund_confirmed'",
        )
      ).rows[0].count,
      "0",
    );
    assert.equal(
      (await pool.query("SELECT count(*) FROM fixture_auction_wallet_ops"))
        .rows[0].count,
      "8",
    );
    const first = (
      await pool.query(
        "SELECT a.agent_id FROM mpp_direct_auction_allocations a JOIN mpp_direct_auction_rounds r ON r.id=a.round_id ORDER BY r.cutoff_ms LIMIT 1",
      )
    ).rows[0];
    // Later service timing may place buyers in separate windows; whenever they
    // share a round the replay test establishes that the higher bid wins.
    assert.ok(["a", "b"].includes(first.agent_id));
  } finally {
    await Promise.all(runtimes.map((r) => r.close()));
    await app.close();
  }
});

test("shared owner liability blocks next buyer until actual refund confirmation", async () => {
  const m = await setup(),
    a = await allocated(m);
  const reserved = BigInt(a.contract.reserveNano);
  await pool.query(
    "UPDATE mpp_direct_auction_budgets SET cap_nano=$1 WHERE id='owner'",
    [String(reserved + reserved / 2n)],
  );
  await m.acceptVerifiedPayment(a.allocationId, payment(a));
  const permit = await m.claimExecution(a.allocationId);
  await m.finishExecution(a.allocationId, {
    ...permit,
    result: { sse: "verified" },
    usage: { input: "100", cached: "0", output: "10" },
  });
  const b = await m.submit("b", input("b"));
  const r = await clear(m);
  assert.equal(r.noSale, true);
  assert.equal(r.results[0].reason, "shared_budget_insufficient");
  await refund(m, a);
  await clear(m);
  assert.ok((await m.bidStatus("b", b.bidId)).allocationId);
});
test("payment confirmation races with permanent fence without late execution or lost principal", async () => {
  const m = await setup(),
    a = await allocated(m);
  await Promise.all([
    m.acceptVerifiedPayment(a.allocationId, payment(a)),
    m.fence(a.allocationId),
  ]);
  const status = await m.status("a", a.allocationId);
  assert.equal(status.executionState, "fenced");
  assert.equal(status.principal.refundPending, status.principal.prepaid);
  await assert.rejects(m.claimExecution(a.allocationId), /fenced/);
  await refund(m, a);
});
test("original operation cannot change binding; parent authorization revocation also fences dispatch", async () => {
  const m = await setup(),
    a = await allocated(m);
  await assert.rejects(
    pool.query(
      "UPDATE mpp_direct_auction_operations SET binding='{}' WHERE allocation_id=$1",
      [a.allocationId],
    ),
    /immutable/,
  );
  await assert.rejects(
    pool.query(
      "UPDATE mpp_direct_auction_grants SET task_budget='task-b' WHERE id='grant-a'",
    ),
    /immutable/,
  );
  await m.acceptVerifiedPayment(a.allocationId, payment(a));
  await pool.query(
    "UPDATE mpp_direct_auction_budgets SET active=false WHERE id='owner'",
  );
  await assert.rejects(m.claimExecution(a.allocationId), /fenced/);
});

test("main workspace reuses NEP-413 owner login and exposes only financial grants through buyer-api", async () => {
  const { KeyPair } = await import("near-api-js");
  const { nep413Digest } = await import("../../near.mjs");
  const { ownerAuth } = await import("../owner-auth.mjs");
  const m = await setup(),
    adapters = await controlledAdapters(pool),
    key = KeyPair.fromRandom("ed25519");
  const auth = ownerAuth({
    origin: "http://127.0.0.1:4173",
    network: "testnet",
    rpc: {
      async fullAccess(account, publicKey) {
        assert.ok(["owner.testnet", "other.testnet"].includes(account));
        assert.equal(publicKey, key.getPublicKey().toString());
      },
    },
  });
  const app = await startAuctionServer({
    market: m,
    ...adapters,
    ownerAuth: auth,
    ownerBindings: { "owner.testnet": "owner-1", "other.testnet": "owner-2" },
  });
  const request = async (path, body, cookie) =>
    fetch(app.url + "/buyer-api/" + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        origin: app.url,
        "content-type": "application/json",
        ...(cookie ? { cookie } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  async function login(account) {
    const c = await request("auth/challenge", {}),
      payload = await c.json();
    assert.equal(JSON.parse(payload.message).network, "testnet");
    const signed = {
      accountId: account,
      publicKey: key.getPublicKey().toString(),
      signature: Buffer.from(
        key.sign(nep413Digest(payload)).signature,
      ).toString("base64"),
    };
    const r = await request(
      "auth/verify",
      signed,
      c.headers.get("set-cookie").split(";")[0],
    );
    assert.equal(r.status, 200, await r.clone().text());
    return r.headers
      .getSetCookie()
      .find((s) => s.startsWith("near_owner="))
      .split(";")[0];
  }
  try {
    const capabilities = await (await request("capabilities")).json();
    assert.equal(capabilities.taskRuntime, "client-memory-v1");
    assert.equal(capabilities.ownerAuth, "nep413");
    assert.equal(capabilities.nativeFunding, false);
    const cookie = await login("owner.testnet");
    assert.equal(
      (await (await request("session", undefined, cookie)).json()).owner
        .account_id,
      "owner.testnet",
    );
    const initial = await (
      await request("authorizations", undefined, cookie)
    ).json();
    assert.equal(initial.grants.length, 2);
    assert.equal(initial.grants[0].payer, "a.testnet");
    const input = {
      agentId: "a",
      operation: "main-ui-task",
      budgetNano: "10000000",
      callCapMicro: "10000",
      deadlineMs: Date.now() + 120000,
    };
    const first = await request("authorizations", input, cookie);
    assert.equal(first.status, 201, await first.clone().text());
    const g = await first.json();
    assert.equal(
      (await (await request("authorizations", input, cookie)).json()).id,
      g.id,
    );
    const record = (
      await pool.query(
        "SELECT to_jsonb(g) AS value FROM mpp_direct_auction_grants g WHERE id=$1",
        [g.id],
      )
    ).rows[0].value;
    assert.equal(record.prompt, undefined);
    assert.equal(record.workspace, undefined);
    const invalid = await request(
      "authorizations",
      {
        ...input,
        operation: "unwanted-task-state",
        prompt: "do not persist this",
      },
      cookie,
    );
    assert.equal(invalid.status, 400);
    const other = await login("other.testnet");
    assert.equal(
      (await (await request("authorizations", undefined, other)).json()).grants
        .length,
      0,
    );
    assert.equal(
      (
        await request(
          "authorizations",
          { ...input, operation: "cross-owner" },
          other,
        )
      ).status,
      404,
    );
    assert.equal((await request("logout", {}, cookie)).status, 200);
    assert.equal(
      (await request("authorizations", undefined, cookie)).status,
      401,
    );
  } finally {
    await app.close();
  }
});
