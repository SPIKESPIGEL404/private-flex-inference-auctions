import { test } from "node:test";
import assert from "node:assert/strict";
import { fixture, OWNER, TOKEN, FUNDER } from "./fixture.mjs";
import { hash } from "../../../mpp-near-direct/contract.mjs";
import {
  pricingContract,
  clearRound,
} from "../../../mpp-near-direct/auction/contracts.mjs";
import {
  createMemoryTask,
  sumTask,
  procurementTransport,
} from "../../../mpp-near-direct/client/task.mjs";
import { NearintentsAuctionRail } from "../rail.mjs";
assert.ok(
  process.env.AUCTION_TEST_DATABASE_URL &&
    process.env.NEARINTENTS_AUCTION_TEST === "1",
  "isolated_owning_market_required",
);
async function setup(t, options = {}) {
  const f = await fixture({
    databaseUrl: process.env.AUCTION_TEST_DATABASE_URL,
    ...options,
  });
  t.after(() => f.close());
  return f;
}
async function grant(f, w, suffix = "run") {
  const deadlineMs = Date.now() + 120000;
  const g = await f.api("authorizations", {
    agentId: w.id,
    operation: "grant-" + suffix,
    budgetNano: "10000000",
    callCapMicro: "10000",
    deadlineMs,
  });
  return { id: g.id, deadlineMs };
}
const body = () =>
  JSON.stringify({
    model: "m/external",
    messages: [{ role: "user", content: "Compute the task." }],
    stream: true,
    stream_options: { include_usage: true },
    max_completion_tokens: 128,
  });
function transport(f, w, g, bid = "1000000", events = {}) {
  return procurementTransport({
    url: f.app.url + "/buyer-api/v1/chat/completions",
    nativeChat: true,
    paymentHeader: "Payment-Authorization",
    agentId: w.id,
    authorizationId: g.id,
    bidMultiplier: bid,
    maxTotalMicro: "10000",
    expiryMs: g.deadlineMs,
    maxRetries: 300,
    retryDelayMs: 20,
    fetcher: (url, init) =>
      fetch(url, {
        ...init,
        headers: { ...init.headers, authorization: "Bearer " + TOKEN },
      }),
    onPaymentChallenge: (s) =>
      f.api("orders/" + s.allocationId + "/mpp-credential", {
        challengeId: s.challenge.id,
        contractHash: s.contract.contractHash,
      }),
    ...events,
  });
}
async function invoke(tr, raw = body(), id = "logical-call") {
  return tr.invoke({
    body: raw,
    runId: "run",
    logicalCallId: id,
    requestHash: hash(raw),
    signal: AbortSignal.timeout(20000),
  });
}
async function allocated(f, w, g, multiplier = "1000000", id = "logical-call") {
  const raw = body();
  const b = await f.market.submit(w.id, {
    operation: id,
    logicalCallId: id,
    grantId: g.id,
    body: raw,
    requestHash: hash(raw),
    bidMultiplier: multiplier,
    maxTotalMicro: "10000",
    expiryMs: g.deadlineMs,
  });
  for (let n = 0; n < 100; n++) {
    const s = await f.market.bidStatus(w.id, b.bidId);
    if (s.allocationId) return s;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw Error("allocation_timeout");
}
test("existing first-price auction determines the official 402 amount; losing agent has no payment", async (t) => {
  const f = await setup(t),
    a = await f.add("agent-a"),
    b = await f.add("agent-b"),
    ga = await grant(f, a, "a"),
    gb = await grant(f, b, "b");
  await f.pool.query("UPDATE mpp_direct_auction_state SET next_cutoff_ms=$1", [
    Date.now() + 400,
  ]);
  const raw = body(),
    submit = (w, g, m) =>
      f.market.submit(w.id, {
        operation: "bid-" + w.id,
        logicalCallId: "bid-" + w.id,
        grantId: g.id,
        body: raw,
        requestHash: hash(raw),
        bidMultiplier: m,
        maxTotalMicro: "10000",
        expiryMs: g.deadlineMs,
      });
  const [ba, bb] = await Promise.all([
    submit(a, ga, "1200000"),
    submit(b, gb, "1500000"),
  ]);
  await new Promise((r) => setTimeout(r, 500));
  await f.market.clear();
  const high = await f.market.bidStatus(b.id, bb.bidId),
    low = await f.market.bidStatus(a.id, ba.bidId);
  assert.ok(high.allocationId);
  assert.equal(low.state, "waiting");
  assert.equal(f.counters.transfers, 0);
  assert.equal(high.contract.bidMultiplier, "1500000");
  const expected = pricingContract({
    service: f.config.service,
    bidMultiplier: "1500000",
    fx: high.contract.fx,
    gasCapYocto: "0",
    nowMs: high.contract.paymentBeforeMs - f.config.paymentWindowMs,
    paymentWindowMs: f.config.paymentWindowMs,
    admissionWindowMs: f.config.admissionWindowMs,
    billing: "auction-fixed-request-v1",
  });
  assert.equal(high.contract.contractHash, expected.contractHash);
  assert.equal(
    high.challenge.request.methodDetails.amountOut,
    expected.principalYocto,
  );
  assert.equal(high.challenge.request.externalId, high.orderId);
  assert.equal(high.challenge.method, "nearintents");
  const round = (
    await f.pool.query(
      "SELECT inputs,result FROM mpp_direct_auction_rounds WHERE id=(SELECT round_id FROM mpp_direct_auction_allocations WHERE id=$1)",
      [high.allocationId],
    )
  ).rows[0];
  assert.deepEqual(clearRound(round.inputs), round.result);
  assert.equal(
    (await f.pool.query("SELECT to_regclass('chat_calls') IS NULL AS absent"))
      .rows[0].absent,
    true,
  );
});
test("an estimated swap beyond the winning payment window cannot sign or broadcast", async (t) => {
  const f = await setup(t, { quoteTimeEstimate: 60 });
  const a = await f.add("too-slow"),
    g = await grant(f, a);
  const order = await allocated(f, a, g);
  await assert.rejects(
    f.wallet.createCredential(order.allocationId),
    /payment_authorization_closed/,
  );
  assert.equal(f.counters.transfers, 0);
  assert.equal(
    (await f.pool.query("SELECT count(*) FROM nearintents_auction_credentials"))
      .rows[0].count,
    "0",
  );
});
test("two autonomous fx tasks purchase through the existing auction and finish independently", async (t) => {
  const f = await setup(t),
    agents = [await f.add("agent-a"), await f.add("agent-b")],
    runtimes = [];
  try {
    for (let i = 0; i < agents.length; i++) {
      const g = await grant(f, agents[i], String(i));
      runtimes.push(
        await createMemoryTask({
          task: sumTask(i ? [5, 5, 9] : [3, 7, 32]),
          model: f.config.service.model,
          backend: "native",
          maxOutputTokens: 128,
          deadlineMs: g.deadlineMs,
          transport: transport(f, agents[i], g, i ? "1500000" : "1200000"),
        }),
      );
    }
    const results = await Promise.all(runtimes.map((r) => r.run()));
    assert.ok(results.every((r) => r.state === "complete"));
    assert.deepEqual(
      results.map((r) => JSON.parse(r.artifact).sum),
      [42, 19],
    );
    assert.equal(f.counters.transfers, 4);
    const rows = (
      await f.pool.query("SELECT * FROM mpp_direct_auction_allocations")
    ).rows;
    assert.equal(rows.length, 4);
    assert.ok(
      rows.every(
        (r) =>
          r.payment === "confirmed" &&
          r.execution === "result_available" &&
          r.refundable === "0" &&
          r.charged === r.principal &&
          r.budget_finalized,
      ),
    );
    assert.ok(rows.every((r) => r.financial.usageRebate === false));
    assert.equal(
      new Set(rows.map((r) => r.challenge.request.recipient)).size,
      4,
    );
    const budgets = (
      await f.pool.query(
        "SELECT reserved_nano,spent_nano FROM mpp_direct_auction_budgets WHERE kind='owner'",
      )
    ).rows[0];
    assert.equal(budgets.reserved_nano, "0");
    assert.ok(BigInt(budgets.spent_nano) > 0n);
    assert.equal(
      (await f.pool.query("SELECT count(*) FROM fixture_auction_provider_ops"))
        .rows[0].count,
      "4",
    );
    const orders = await f.api("orders");
    assert.ok(
      orders.orders.every(
        (o) =>
          o.paymentMethod === "nearintents" &&
          o.sourceFee.actualGasWei === "42000" &&
          o.sourcePayment.receipt.method === "nearintents",
      ),
    );
  } finally {
    await Promise.all(runtimes.map((r) => r.close()));
  }
});
test("same chat bytes and credential replay without a second payment or provider invocation", async (t) => {
  const f = await setup(t),
    w = await f.add(),
    g = await grant(f, w),
    raw = body();
  const first = await invoke(transport(f, w, g), raw);
  assert.equal(first.status, 200);
  const response = await first.text();
  const again = await invoke(transport(f, w, g), raw);
  assert.equal(again.status, 200);
  assert.equal(await again.text(), response);
  assert.equal(f.counters.transfers, 1);
  assert.equal(
    (await f.pool.query("SELECT count(*) FROM fixture_auction_provider_ops"))
      .rows[0].count,
    "1",
  );
});
test("SDK consumption and owning Market movement roll back and recover together", async (t) => {
  const f = await setup(t),
    w = await f.add(),
    g = await grant(f, w);
  let failed = false;
  f.wallet.fault = (point) => {
    if (!failed && point === "before_payment_commit") {
      failed = true;
      throw Error("controlled_commit_failure");
    }
  };
  const result = await invoke(transport(f, w, g));
  assert.equal(result.status, 200);
  assert.equal(f.counters.transfers, 1);
  assert.equal(
    (
      await f.pool.query(
        "SELECT count(*) FROM mpp_direct_auction_movements WHERE kind='payment'",
      )
    ).rows[0].count,
    "1",
  );
});
test("owner freeze is not blocked by settlement polling; paid revoked allocation is refund-only", async (t) => {
  const f = await setup(t),
    w = await f.add(),
    g = await grant(f, w),
    a = await allocated(f, w, g);
  f.settlement = "PENDING_DEPOSIT";
  const credential = await f.wallet.createCredential(a.allocationId);
  const settling = f.wallet.settle(a.allocationId, credential);
  await new Promise((r) => setTimeout(r, 50));
  const at = Date.now();
  await f.setup.freeze(OWNER, w.id);
  assert.ok(Date.now() - at < 500);
  f.settlement = "SUCCESS";
  await settling;
  const row = (
    await f.pool.query(
      "SELECT * FROM mpp_direct_auction_allocations WHERE id=$1",
      [a.allocationId],
    )
  ).rows[0];
  assert.equal(row.payment, "confirmed");
  assert.equal(row.execution, "fenced");
  assert.equal(row.refundable, row.principal);
  assert.equal(f.counters.transfers, 1);
  assert.equal(
    (await f.pool.query("SELECT count(*) FROM fixture_auction_provider_ops"))
      .rows[0].count,
    "0",
  );
});
test("owner and funding intents are isolated, original hashes are immutable, known rejection can cancel", async (t) => {
  const f = await setup(t),
    w = await f.add();
  const intent = await f.api("nearintents-wallets/" + w.id + "/funding", {
    operation: "funding-1",
    kind: "token",
    amount: "1000",
    from: FUNDER,
  });
  const hash = f.fund(w.address, "token", "1000");
  await f.api("nearintents-funding/" + intent.id + "/reconcile", {
    txHash: hash,
  });
  await assert.rejects(
    f.api("nearintents-funding/" + intent.id + "/reconcile", {
      txHash: "0x" + "a".repeat(64),
    }),
    /original_funding_hash_conflict/,
  );
  await assert.rejects(f.setup.owned("other.testnet", w.id), /unknown_agent/);
  const rejected = await f.api("nearintents-wallets/" + w.id + "/funding", {
    operation: "funding-2",
    kind: "gas",
    amount: "1000",
    from: FUNDER,
  });
  await f.api("nearintents-funding/" + rejected.id + "/cancel", {
    walletRejected: true,
  });
  assert.equal(
    (await f.api("nearintents-wallets")).funding.find(
      (x) => x.id === rejected.id,
    ).state,
    "cancelled",
  );
});
test("adapter schema drift is rejected without changing the owning financial schema", async (t) => {
  const f = await setup(t);
  await f.pool.query(
    "ALTER TABLE nearintents_auction_store ADD COLUMN unexpected_drift integer",
  );
  await assert.rejects(
    new NearintentsAuctionRail({
      pool: f.pool,
      config: f.plan,
      secret: f.config.secret,
    }).initialize(),
    /nearintents_adapter_schema_or_plan_changed/,
  );
  await f.pool.query(
    "ALTER TABLE nearintents_auction_store DROP COLUMN unexpected_drift",
  );
});
test("owner can freeze and exit unused source balances; original exit replays without another nonce", async (t) => {
  const f = await setup(t),
    w = await f.add(),
    input = { operation: "exit-token", kind: "token", recipient: FUNDER };
  await assert.rejects(
    f.api("nearintents-wallets/" + w.id + "/exit", input),
    /freeze_agent_before_exit/,
  );
  await f.api("nearintents-wallets/" + w.id + "/freeze", {});
  const first = await f.api("nearintents-wallets/" + w.id + "/exit", input);
  assert.equal(first.state, "confirmed");
  assert.equal(first.amount, "2000000");
  assert.equal(
    (await f.api("nearintents-wallets/" + w.id + "/exit", input)).txHash,
    first.txHash,
  );
  assert.equal(f.counters.exits, 1);
  assert.equal(
    (await f.api("nearintents-wallets")).wallets[0].balance.sourceAtoms,
    "0",
  );
  await assert.rejects(
    f.api("nearintents-wallets/" + w.id + "/exit", {
      ...input,
      recipient: "0x" + "33".repeat(20),
    }),
    /original_owner_exit_conflict/,
  );
  const gas = await f.api("nearintents-wallets/" + w.id + "/exit", {
    operation: "exit-gas",
    kind: "gas",
    recipient: FUNDER,
  });
  assert.equal(gas.state, "confirmed");
  assert.ok(BigInt(gas.amount) > 0n);
  assert.equal(f.counters.exits, 2);
  assert.ok(
    BigInt((await f.api("nearintents-wallets")).wallets[0].balance.gasWei) <
      160000n,
  );
  assert.equal((await f.source.balance(w.address)).sourceAtoms, "0");
  assert.equal(f.counters.transfers, 0);
});
