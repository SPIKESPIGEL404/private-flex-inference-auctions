import test, { after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { KeyPair } from "near-api-js";
import { plan, fx } from "./live.test.mjs";
import { hash } from "../../contract.mjs";
import { AuctionMarket } from "../market.mjs";
import { liveAdmission, recordFx } from "../live/admission.mjs";
import { NearCloudProvider } from "../live/provider.mjs";
import { AuctionWallet } from "../live/wallet.mjs";
import { AuctionSetup } from "../live/setup.mjs";
import { LIVE_MODE } from "../live/policy.mjs";
import { startMainnetAuctionServer } from "../server.mjs";
import { ProjectProbe } from "../live/project-probe.mjs";
import { Store } from "../../../../clients/buyer-gateway/src/store.mjs";
const pool = new pg.Pool({
  connectionString: process.env.AUCTION_TEST_DATABASE_URL,
  max: 16,
});
assert.ok(process.env.AUCTION_TEST_DATABASE_URL, "isolated database required");
after(() => pool.end());
let seq = 0;
async function setup() {
  await pool.query(
    "TRUNCATE mpp_direct_auction_state,mpp_direct_auction_budgets,mpp_direct_p3_wallets,mpp_direct_live_provider_budget,mpp_direct_live_fx,mpp_direct_live_supply,mpp_direct_live_payment_budget CASCADE",
  );
  const p = plan();
  const market = new AuctionMarket({
    pool,
    config: {
      mode: LIVE_MODE,
      network: "mainnet",
      realBroadcastEnabled: true,
      livePlan: p,
      reviewedPlanHash: hash(p),
      merchant: p.merchant,
      realm: p.realm,
      service: p.service,
      capacity: 1,
      rule: "first-price-v1",
      windowMs: 60000,
      paymentWindowMs: 10000,
      admissionWindowMs: 20000,
      minRevisionIntervalMs: 0,
      secret: "controlled-mainnet-integration-secret-only",
    },
    live: liveAdmission({ plan: p }),
  });
  await market.initialize();
  await pool.query(
    "INSERT INTO mpp_direct_live_provider_budget(singleton,maximum_micro,maximum_calls) VALUES(true,$1,$2)",
    [p.providerMaximumMicro, p.maximumProviderCalls],
  );
  await recordFx(pool, fx());
  await pool.query(
    "INSERT INTO mpp_direct_live_payment_budget VALUES(true,$1,0)",
    [p.maximumProviderCalls],
  );
  await pool.query(
    "INSERT INTO mpp_direct_live_supply VALUES(true,true,$1,$2,$3)",
    [Date.now(), Date.now() + 30000, { scope: "controlled-live-adapter-test" }],
  );
  for (const [id, kind, agent] of [
    ["owner", "owner", null],
    ["agent-budget", "agent", "a"],
    ["task", "task", "a"],
  ])
    await pool.query(
      `INSERT INTO mpp_direct_auction_budgets(id,kind,owner_id,agent_id,cap_nano,deadline_ms) VALUES($1,$2,'mainnet:owner.near',$3,10000000,$4)`,
      [id, kind, agent, p.deadlineMs],
    );
  const key = KeyPair.fromRandom("ed25519"),
    publicKey = key.getPublicKey().toString();
  const binding = {
    agentId: "a",
    walletId: "11111111-1111-4111-8111-111111111111",
    payer: "payer.near",
    refundTo: "payer.near",
    version: "binding-v1",
    network: "mainnet",
    merchant: p.merchant,
    signingRecipient: p.realm,
    credentialRef: "test-only",
    publicKey,
    policy: {
      controller: "owner.near",
      version: 1,
      encryptedHash: hash("cipher"),
    },
  };
  await pool.query(
    `INSERT INTO mpp_direct_auction_agents(id,owner_id,credential_hash,payer,binding_version,owner_budget,agent_budget,balance) VALUES('a','mainnet:owner.near',$1,'payer.near','binding-v1','owner','agent-budget',$2)`,
    [
      hash("test-only"),
      {
        source: "near-rpc-final-v1",
        network: "mainnet",
        payer: "payer.near",
        availableYocto: "1000000000000000000000000",
        observedAtMs: Date.now(),
        expiresAtMs: Date.now() + 60000,
      },
    ],
  );
  await pool.query(
    `INSERT INTO mpp_direct_auction_grants(id,agent_id,task_budget,call_cap_micro,gas_cap_yocto,deadline_ms) VALUES('grant','a','task',5000,$1,$2)`,
    [p.gasReserveYocto, p.deadlineMs],
  );
  await pool.query(
    `INSERT INTO mpp_direct_p3_wallets(id,owner_id,request_hash,state,binding,created_ms) VALUES('wallet','owner.near','request','ready',$1,$2)`,
    [binding, Date.now()],
  );
  await pool.query(
    "INSERT INTO mpp_direct_live_wallet_agents VALUES('wallet','a')",
  );
  return { p, market, binding, key };
}
async function allocate(f) {
  const body = JSON.stringify({
      model: f.p.service.model,
      messages: [{ role: "user", content: "Compute 3+7." }],
      max_completion_tokens: 128,
      stream: true,
      stream_options: { include_usage: true },
    }),
    id = "call-" + ++seq;
  const bid = await f.market.submit("a", {
    operation: id,
    grantId: "grant",
    logicalCallId: id,
    body,
    requestHash: hash(body),
    bidMultiplier: "1000000",
    maxTotalMicro: "5000",
    expiryMs: Date.now() + 100000,
  });
  await pool.query(
    "UPDATE mpp_direct_auction_bids SET accepted_ms=accepted_ms-1",
  );
  await pool.query(
    "UPDATE mpp_direct_auction_state SET next_cutoff_ms=floor(extract(epoch FROM clock_timestamp())*1000)",
  );
  await f.market.clear();
  const status = await f.market.bidStatus("a", bid.bidId);
  assert.ok(status.allocationId);
  return status;
}
const proof = (a, gas = "100") => ({
  orderRef: a.order_id,
  amount: String(a.principal),
  network: "mainnet",
  payer: "payer.near",
  recipient: "merchant.near",
  challengeId: a.challenge.id,
  movementKey: "fixture-payment:" + a.id,
  gasActualYocto: gas,
  late: false,
});
async function paid(f) {
  const s = await allocate(f);
  const a = (
    await pool.query(
      "SELECT * FROM mpp_direct_auction_allocations WHERE id=$1",
      [s.allocationId],
    )
  ).rows[0];
  await f.market.acceptVerifiedPayment(a.id, proof(a));
  return { a, permit: await f.market.claimExecution(a.id) };
}
const catalog = () => ({
  models: [
    {
      modelId: "Qwen/Qwen3.8-27B",
      metadata: { isReady: true, ownedBy: "nearai" },
      inputCostPerToken: { amount: "4", scale: 8, currency: "USD" },
      cacheReadCostPerToken: { amount: "18", scale: 9, currency: "USD" },
      outputCostPerToken: { amount: "135", scale: 8, currency: "USD" },
    },
  ],
});
function provider(
  f,
  {
    lost = false,
    usage = { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
    verifyDown = false,
  } = {},
) {
  let posts = 0;
  const raw =
    "data: " +
    JSON.stringify({
      id: "response-1",
      model: f.p.service.model,
      choices: [{ index: 0, delta: { content: "10" }, finish_reason: null }],
    }) +
    "\n\ndata: " +
    JSON.stringify({
      id: "response-1",
      model: f.p.service.model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage,
    }) +
    "\n\ndata: [DONE]\n\n";
  const client = {
    async verify() {},
    async fetch() {
      posts++;
      if (lost) throw Error("lost-ack");
      return new Response(raw, {
        headers: { "content-type": "text/event-stream" },
      });
    },
    async verifyResponse(id) {
      if (verifyDown) throw Error("missing-capture");
      return { id, signatureKind: "provider_tee" };
    },
  };
  return {
    value: new NearCloudProvider({ market: f.market, client, catalog }),
    client,
    posts: () => posts,
  };
}
test("live PG: absent provider intent is permanently sealed before refund, including a delayed dispatcher", async () => {
  const f = await setup(),
    { a, permit } = await paid(f),
    p = provider(f);
  await p.value.initialize();
  const outcome = await p.value.recoverOriginal(permit.executionId);
  assert.deepEqual(outcome, { failure: "provider_never_sent" });
  await f.market.failExecution(a.id, { ...permit, reason: outcome.failure });
  assert.deepEqual(await p.value.executeOriginal(permit), outcome);
  assert.equal(p.posts(), 0);
  assert.equal(
    (await f.market.status("a", a.id)).principal.refundPending,
    String(a.principal),
  );
});
test("live PG: explicit billing refusal refunds principal, retains expense exposure and blocks the same key", async () => {
  const f = await setup(),
    { a, permit } = await paid(f);
  let posts = 0;
  const p = new NearCloudProvider({
    market: f.market,
    keyFingerprint: "refused-key",
    catalog,
    client: {
      async verify() {},
      async fetch() {
        posts++;
        return new Response("denied", { status: 401 });
      },
    },
  });
  await p.initialize();
  const result = await p.executeOriginal(permit);
  assert.deepEqual(result, { failure: "provider_refused" });
  await f.market.failExecution(a.id, { ...permit, reason: result.failure });
  assert.equal(
    (await f.market.status("a", a.id)).principal.refundPending,
    String(a.principal),
  );
  assert.equal(await p.blocked(), true);
  assert.equal(
    await liveAdmission({ plan: f.p, keyFingerprint: "refused-key" }).ready(
      pool,
      Date.now(),
    ),
    false,
  );
  await assert.rejects(p.preflight(), /provider_key_or_credit_refused/);
  assert.deepEqual(await p.recoverOriginal(permit.executionId), result);
  assert.equal(posts, 1);
  const b = (await pool.query("SELECT * FROM mpp_direct_live_provider_budget"))
    .rows[0];
  assert.equal(b.calls, 1);
  assert.ok(BigInt(b.reserved_micro) > 0n);
  assert.equal(String(b.spent_micro), "0");
});
test("project probe: concurrent checks POST once and cost verified usage in the owning budget", async () => {
  const f = await setup(),
    p = provider(f),
    store = new Store(":memory:", Buffer.alloc(32, 1));
  try {
    const probe = new ProjectProbe({
      pool,
      store,
      plan: f.p,
      planHash: hash(f.p),
      keyFingerprint: "probe-key",
      client: p.client,
    });
    const tariff = await p.value.preflight();
    await Promise.all([probe.ensure(tariff), probe.ensure(tariff)]);
    assert.equal((await probe.ensure(tariff)).verified, true);
    assert.equal(p.posts(), 1);
    const b = (
      await pool.query("SELECT * FROM mpp_direct_live_provider_budget")
    ).rows[0];
    assert.equal(b.calls, 1);
    assert.equal(String(b.reserved_micro), "0");
    assert.ok(BigInt(b.spent_micro) > 0n);
  } finally {
    store.close();
  }
});
test("project probe: lost provider ACK stays unresolved across coordinator restart, never repeats paid POST", async () => {
  const f = await setup(),
    p = provider(f, { lost: true }),
    store = new Store(":memory:", Buffer.alloc(32, 2));
  try {
    const args = {
      pool,
      store,
      plan: f.p,
      planHash: hash(f.p),
      keyFingerprint: "probe-key",
      client: p.client,
    };
    const tariff = await p.value.preflight();
    assert.equal(await new ProjectProbe(args).ensure(tariff), null);
    assert.equal(await new ProjectProbe(args).ensure(tariff), null);
    assert.equal(p.posts(), 1);
    assert.ok(
      BigInt(
        (
          await pool.query(
            "SELECT reserved_micro FROM mpp_direct_live_provider_budget",
          )
        ).rows[0].reserved_micro,
      ) > 0n,
    );
  } finally {
    store.close();
  }
});
for (const boundary of [
  "after_probe_cost_commit",
  "after_probe_settlement_commit",
])
  test(
    "project probe: original cost survives lost COMMIT ACK at " + boundary,
    async () => {
      const f = await setup(),
        p = provider(f),
        store = new Store(":memory:", Buffer.alloc(32, 3));
      try {
        const args = {
          pool,
          store,
          plan: f.p,
          planHash: hash(f.p),
          keyFingerprint: "probe-key",
          client: p.client,
        };
        const tariff = await p.value.preflight();
        const first = new ProjectProbe({
          ...args,
          fault(at) {
            if (at === boundary) throw Error("commit-ack-lost");
          },
        });
        await assert.rejects(first.ensure(tariff), /commit-ack-lost/);
        assert.equal(
          (await new ProjectProbe(args).ensure(tariff)).verified,
          true,
        );
        assert.equal(p.posts(), 1);
        const b = (
          await pool.query("SELECT * FROM mpp_direct_live_provider_budget")
        ).rows[0];
        assert.equal(b.calls, 1);
        assert.equal(String(b.reserved_micro), "0");
        assert.ok(BigInt(b.spent_micro) > 0n);
      } finally {
        store.close();
      }
    },
  );
test("project probe: an expired original reservation cannot start a late paid request", async () => {
  const f = await setup(),
    p = provider(f),
    store = new Store(":memory:", Buffer.alloc(32, 4));
  try {
    const args = {
      pool,
      store,
      plan: f.p,
      planHash: hash(f.p),
      keyFingerprint: "probe-key",
      client: p.client,
    };
    const tariff = await p.value.preflight();
    await assert.rejects(
      new ProjectProbe({
        ...args,
        fault(at) {
          if (at === "after_probe_cost_commit")
            throw Error("commit-ack-lost");
        },
      }).ensure(tariff),
      /commit-ack-lost/,
    );
    const resumed = new ProjectProbe({
      ...args,
      plan: { ...f.p, deadlineMs: Date.now() - 1 },
    });
    await assert.rejects(
      resumed.ensure(tariff),
      /project_probe_window_closed/,
    );
    assert.equal(p.posts(), 0);
    assert.equal(
      (await pool.query("SELECT calls FROM mpp_direct_live_provider_budget"))
        .rows[0].calls,
      1,
    );
  } finally {
    store.close();
  }
});
test("live PG: stale FX prevents allocations without changing original order FX", async () => {
  const f = await setup(),
    s = await allocate(f);
  const original = s.contract.fx;
  await pool.query("INSERT INTO mpp_direct_live_fx VALUES('new',$1,$2,$3)", [
    fx(Date.now() + 1000),
    Date.now() + 1000,
    Date.now() + 2000,
  ]);
  assert.deepEqual(
    (await f.market.status("a", s.allocationId)).contract.fx,
    original,
  );
});
test("live PG: gas overrun records actual chain effect, fences execution, refunds full principal, freezes roots", async () => {
  const f = await setup(),
    s = await allocate(f),
    a = (
      await pool.query(
        "SELECT * FROM mpp_direct_auction_allocations WHERE id=$1",
        [s.allocationId],
      )
    ).rows[0];
  const gas = String(BigInt(f.p.gasReserveYocto) + 10n ** 24n);
  await f.market.acceptVerifiedPayment(a.id, proof(a, gas));
  let row = (
    await pool.query(
      "SELECT * FROM mpp_direct_auction_allocations WHERE id=$1",
      [a.id],
    )
  ).rows[0];
  assert.equal(row.payment, "confirmed");
  assert.equal(row.execution, "fenced");
  assert.equal(String(row.refundable), String(a.principal));
  assert.equal(
    (
      await pool.query(
        "SELECT active FROM mpp_direct_auction_budgets WHERE id='owner'",
      )
    ).rows[0].active,
    false,
  );
  const op = (
    await pool.query(
      "SELECT * FROM mpp_direct_auction_operations WHERE id=$1",
      [a.refund_operation],
    )
  ).rows[0];
  await f.market.acceptVerifiedRefund(a.id, {
    ...op.binding,
    operationId: op.id,
    movementKey: "fixture-refund:" + op.id,
  });

  row = (
    await pool.query(
      "SELECT * FROM mpp_direct_auction_budgets WHERE id='owner'",
    )
  ).rows[0];
  assert.ok(BigInt(row.overrun_nano) > 0n);
  assert.ok(BigInt(row.spent_nano) > BigInt(row.cap_nano));
});
test("live PG: verified usage settles once, and original provider replay never makes another paid request", async () => {
  const f = await setup(),
    { a, permit } = await paid(f),
    p = provider(f);
  await p.value.initialize();
  const outcomes = await Promise.all([
    p.value.executeOriginal(permit),
    p.value.executeOriginal(permit),
  ]);
  const result =
    outcomes.find(Boolean) ??
    (await p.value.recoverOriginal(permit.executionId));
  assert.ok(result?.usage);
  await f.market.finishExecution(a.id, { ...permit, ...result });
  await p.value.executeOriginal(permit);
  assert.equal(p.posts(), 1);
  assert.equal(
    (await pool.query("SELECT calls FROM mpp_direct_live_provider_budget"))
      .rows[0].calls,
    1,
  );
  const status = await f.market.status("a", a.id);
  assert.equal(status.executionState, "result_available");
  assert.ok(BigInt(status.principal.refundPending) > 0n);
});
test("live PG: lost provider ACK holds cost across restart and never posts again", async () => {
  const f = await setup(),
    { permit } = await paid(f),
    p = provider(f, { lost: true });
  await p.value.initialize();
  await assert.rejects(() => p.value.executeOriginal(permit));
  const restarted = provider(f);
  await restarted.value.initialize();
  assert.equal(await restarted.value.executeOriginal(permit), null);
  assert.equal(restarted.posts(), 0);
  const b = (await pool.query("SELECT * FROM mpp_direct_live_provider_budget"))
    .rows[0];
  assert.ok(BigInt(b.reserved_micro) > 0n);
  assert.equal(b.calls, 1);
});
test("live PG: exhausted provider project budget proves never-sent and refunds the original payment", async () => {
  const f = await setup(),
    { a, permit } = await paid(f),
    p = provider(f);
  await p.value.initialize();
  await pool.query(
    "UPDATE mpp_direct_live_provider_budget SET spent_micro=maximum_micro",
  );
  const result = await p.value.executeOriginal(permit);
  assert.equal(result.failure, "provider_never_sent");
  assert.equal(p.posts(), 0);
  await f.market.failExecution(a.id, { ...permit, reason: result.failure });
  assert.equal(
    (await f.market.status("a", a.id)).settlementState,
    "refund_pending",
  );
});
test("live PG: outside-contract verified usage is a full-refund provider breach, never clamped", async () => {
  const f = await setup(),
    { a, permit } = await paid(f),
    p = provider(f, {
      usage: { prompt_tokens: 10, completion_tokens: 200, total_tokens: 210 },
    });
  await p.value.initialize();
  const result = await p.value.executeOriginal(permit);
  assert.equal(result.failure, "verified_contract_breach");
  await f.market.failExecution(a.id, { ...permit, reason: result.failure });
  const s = await f.market.status("a", a.id);
  assert.equal(s.principal.refundPending, s.principal.prepaid);
});
test("live PG: background wallet recovery never starts prepared sends; sealing fences delayed pay forever", async () => {
  const f = await setup(),
    s = await allocate(f),
    wallet = new AuctionWallet({
      market: f.market,
      api: {},
      rpc: { network: "mainnet" },
      refundSender: {},
    });
  const op = (
    await pool.query(
      "SELECT * FROM mpp_direct_auction_operations WHERE id=$1",
      ["pay-" + s.orderId],
    )
  ).rows[0];
  assert.equal(await wallet.recoverOriginal(op), null);
  await wallet.prepare(op);
  assert.equal(await wallet.recoverOriginal(op), null);
  await f.market.fence(s.allocationId);
  const sealed = await wallet.sealOriginal(op);
  assert.equal(sealed.state, "never_sent");
  await f.market.proveNotSent(s.allocationId, sealed);
  await assert.rejects(() => wallet.payOriginal(op), /sealed/);
});
test("live PG: native wallet dispatch intent races serialize and unknown blocks the same payer", async () => {
  const f = await setup(),
    s = await allocate(f);
  let posts = 0;
  const api = {
      async transfer() {
        posts++;
        throw Error("lost ack");
      },
    },
    wallet = new AuctionWallet({
      market: f.market,
      api,
      rpc: { network: "mainnet" },
      refundSender: {},
    });
  wallet.wallet.policy = async () => {};
  const plan = await f.market.beginOperation(s.allocationId, "payment");
  await Promise.all([
    wallet.payOriginal(plan.operation),
    wallet.payOriginal(plan.operation),
  ]);
  assert.equal(posts, 1);
  const restarted = new AuctionWallet({
    market: f.market,
    api,
    rpc: { network: "mainnet" },
    refundSender: {},
  });
  await restarted.recoverOriginal(plan.operation);
  assert.equal(posts, 1);
  assert.equal(
    (await pool.query("SELECT state FROM mpp_direct_p3_operations")).rows[0]
      .state,
    "review",
  );
});
test("live PG: Mainnet server rejects fixture login, bare mutation and foreign origin; cookies are Secure", async () => {
  const f = await setup(),
    wallet = { scope: LIVE_MODE, durableOriginalOperations: true },
    provider = { scope: LIVE_MODE },
    app = await startMainnetAuctionServer({
      market: f.market,
      wallet,
      provider,
      setup: {},
      uiOrigin: f.p.origin,
    });
  try {
    const c = await (await fetch(app.url + "/buyer-api/capabilities")).json();
    assert.equal(c.realInferencePayments, true);
    assert.equal(c.network, "mainnet");
    assert.equal(
      (
        await fetch(app.url + "/buyer-api/live-wallets", {
          headers: { authorization: "Bearer test-only" },
        })
      ).status,
      401,
    );
    assert.equal(
      (await fetch(app.url + "/buyer-api/auth/challenge", { method: "POST" }))
        .status,
      400,
    );
    const auth = await fetch(app.url + "/buyer-api/auth/challenge", {
      method: "POST",
      headers: { origin: f.p.origin },
    });
    assert.equal(auth.status, 200);
    assert.match(auth.headers.get("set-cookie"), /Secure/);
    assert.equal(
      (
        await fetch(app.url + "/buyer-api/auth/challenge", {
          method: "POST",
          headers: { origin: "https://evil.example" },
        })
      ).status,
      400,
    );
  } finally {
    await app.close();
  }
});
test("live PG: cross-owner setup and funding cannot access another wallet", async () => {
  const f = await setup(),
    s = new AuctionSetup({
      market: f.market,
      api: {},
      rpc: { network: "mainnet" },
      credentials: {},
      wallet: {},
    });
  assert.deepEqual((await s.list("other.near")).wallets, []);
  await assert.rejects(
    () =>
      s.prepareFunding("other.near", "wallet", { operation: "x", amount: "1" }),
    /unknown_wallet/,
  );
  const first = await s.prepareFunding("owner.near", "wallet", {
      operation: "original",
      amount: "10",
    }),
    again = await s.prepareFunding("owner.near", "wallet", {
      operation: "original",
      amount: "10",
    });
  assert.equal(first.id, again.id);
  await assert.rejects(() =>
    s.prepareFunding("owner.near", "wallet", {
      operation: "duplicate",
      amount: "10",
    }),
  );
});

test("live PG: real verifier and signed refund outbox close original principal + agent gas without duplicate effects", async () => {
  const { fixture } = await import("../../test/support.mjs"),
    { nep413Digest } = await import("../../near.mjs");
  const { NativeSender } = await import("../../p3/native-sender.mjs"),
    { Store } = await import("../../../../clients/buyer-gateway/src/store.mjs");
  const { default: bs58 } = await import("bs58");
  const f = await setup(),
    s = await allocate(f),
    a = (
      await pool.query(
        "SELECT * FROM mpp_direct_auction_allocations WHERE id=$1",
        [s.allocationId],
      )
    ).rows[0];
  const txs = new Map(),
    blocks = new Map();
  let effect = 0,
    posts = 0,
    broadcasts = 0;
  function transfer({ payer, recipient, amount, publicKey, txHash }) {
    const v = fixture({
      request: {
        ...a.challenge.request,
        payer,
        recipient,
        refundTo: payer,
        amount,
      },
      challenge: a.challenge,
    });
    txHash ??= bs58.encode(Buffer.alloc(32, ++effect));
    v.tx.transaction.hash = txHash;
    v.tx.transaction.public_key = publicKey;
    v.tx.transaction_outcome.id = txHash;
    v.tx.transaction_outcome.block_hash = "block-" + txHash;
    v.tx.receipts_outcome[0].block_hash = "block-" + txHash;
    v.tx.transaction_outcome.outcome.tokens_burnt = "100";
    v.tx.receipts_outcome[0].outcome.tokens_burnt = "200";
    txs.set(txHash, v.tx);
    blocks.set("block-" + txHash, Date.now());
    return txHash;
  }
  const rpc = {
    network: "mainnet",
    async transaction(h, p) {
      const t = txs.get(h);
      assert.equal(t.transaction.signer_id, p);
      return t;
    },
    async keyAt() {
      return { permission: "FullAccess" };
    },
    async block(id) {
      return {
        header: {
          hash: id,
          timestamp_nanosec: String(BigInt(blocks.get(id)) * 1000000n),
        },
      };
    },
    async call(method, args) {
      if (method === "status") return { chain_id: "mainnet" };
      if (method === "query" && args.method_name === "get_wallet_policy")
        return {
          result: [
            ...Buffer.from(
              JSON.stringify({
                owner: "owner.near",
                version: 1,
                encrypted_data: "cipher",
                locked: false,
                frozen: false,
              }),
            ),
          ],
        };
      throw Error("unexpected-fixture-call");
    },
  };
  const api = {
    async identity() {},
    async transfer(_b, p) {
      posts++;
      return {
        request_id: "22222222-2222-4222-8222-222222222222",
        status: "success",
        tx_hash: transfer({
          payer: f.binding.payer,
          recipient: p.to,
          amount: p.amount,
          publicKey: f.binding.publicKey,
        }),
      };
    },
    async sign(b, p) {
      return {
        account_id: b.payer,
        public_key: b.publicKey,
        nonce: p.nonce,
        signature:
          "ed25519:" + bs58.encode(f.key.sign(nep413Digest(p)).signature),
      };
    },
  };
  const merchant = KeyPair.fromRandom("ed25519"),
    store = new Store(":memory:", Buffer.alloc(32, 1)),
    provider = {
      async viewAccessKey() {
        return {
          permission: "FullAccess",
          nonce: 10,
          block_hash: bs58.encode(Buffer.alloc(32, 9)),
        };
      },
      async viewAccount() {
        return {
          amount: "1000000000000000000000000",
          locked: "0",
          storage_usage: 0,
        };
      },
      async sendTransactionUntil(signed) {
        broadcasts++;
        const { createHash } = await import("node:crypto"),
          t = signed.transaction;
        transfer({
          payer: t.signerId,
          recipient: t.receiverId,
          amount: t.actions[0].transfer.deposit.toString(),
          publicKey: t.publicKey.toString(),
          txHash: bs58.encode(createHash("sha256").update(t.encode()).digest()),
        });
      },
    };
  const sender = new NativeSender({
    store,
    provider,
    rpc,
    accountId: f.p.merchant,
    secretKey: merchant.toString(),
    maxTotalYocto: f.p.merchantMaximumYocto,
    gasCapYocto: f.p.merchantGasReserveYocto,
    storagePriceYocto: f.p.storagePriceYocto,
  });
  const wallet = new AuctionWallet({
    market: f.market,
    api,
    rpc,
    refundSender: sender,
  });
  try {
    const op = await f.market.beginOperation(a.id, "payment"),
      e = await wallet.payOriginal(op.operation);
    assert.equal(e.gasActualYocto, "300");
    assert.equal(e.gasPayer, f.binding.payer);
    assert.equal(e.late, false);
    await f.market.acceptVerifiedPayment(a.id, e);
    const authorization = await wallet.authorizationFor(a.order_id);
    assert.match(authorization, /^Payment /);
    await wallet.verifyPresentation(a.order_id, authorization);
    await wallet.verifyPresentation(a.order_id, authorization);
    await assert.rejects(
      () => wallet.verifyPresentation(a.order_id, "Payment wrong"),
      /original_payment_credential_required/,
    );
    await wallet.payOriginal(op.operation);
    assert.equal(posts, 1);
    const permit = await f.market.claimExecution(a.id),
      p = providerFor(f);
    await p.value.initialize();
    const result = await p.value.executeOriginal(permit);
    await f.market.finishExecution(a.id, { ...permit, ...result });
    const refund = await f.market.beginOperation(a.id, "refund"),
      proof = await wallet.refundOriginal(refund.operation);
    await f.market.acceptVerifiedRefund(a.id, proof);
    await wallet.refundOriginal(refund.operation);
    assert.equal(posts, 1);
    assert.equal(broadcasts, 1);
    const final = await f.market.status("a", a.id);
    assert.equal(final.settlementState, "refund_confirmed");
    assert.equal(
      BigInt(final.principal.prepaid),
      BigInt(final.principal.charged) + BigInt(final.principal.refunded),
    );
    assert.equal(
      (
        await pool.query(
          "SELECT reserved_nano FROM mpp_direct_auction_budgets WHERE id='owner'",
        )
      ).rows[0].reserved_nano,
      "0",
    );
  } finally {
    store.close();
  }
});
const providerFor = provider;

test("live PG: supply becomes unavailable before original payment and no transfer is started", async () => {
  const f = await setup(),
    s = await allocate(f);
  await pool.query("UPDATE mpp_direct_live_supply SET ready=false");
  await assert.rejects(
    () => f.market.beginOperation(s.allocationId, "payment"),
    /payment_authorization_closed/,
  );
  assert.equal(
    (await pool.query("SELECT calls FROM mpp_direct_live_payment_budget"))
      .rows[0].calls,
    0,
  );
});

test("owner exit: pending original liabilities block policy change and withdrawal", async () => {
  const f = await setup();
  await allocate(f);
  let encrypted = 0;
  const s = new AuctionSetup({
    market: f.market,
    rpc: { network: "mainnet" },
    api: {
      async encrypt() {
        encrypted++;
      },
    },
    credentials: {},
    wallet: {},
  });
  await assert.rejects(
    () =>
      s.withdrawals.prepare("other.near", "wallet", {
        confirmExit: true,
        operation: "exit",
      }),
    /unknown_wallet/,
  );
  s.onboarding.freezeTransaction = async () => ({});
  s.wallet.balance = async () => ({
    availableYocto: "10000000000000000000000",
  });
  await assert.rejects(
    () =>
      s.withdrawals.prepare("owner.near", "wallet", {
        confirmExit: true,
        operation: "exit",
      }),
    /original_liabilities_pending/,
  );
  assert.equal(encrypted, 0);
  assert.equal(
    (
      await pool.query(
        "SELECT active FROM mpp_direct_auction_agents WHERE id='a'",
      )
    ).rows[0].active,
    false,
  );
});

test("owner exit: owner-only policy readback, independent FINAL proof, agent gas, single POST, and later-credit exit", async () => {
  const f = await setup(),
    { fixture } = await import("../../test/support.mjs"),
    { publicKey } = await import("../../p3/outlayer.mjs");
  const { default: bs58 } = await import("bs58");
  let version = 1,
    posts = 0,
    policy,
    cipher = "cipher",
    saved;
  const rpc = {
    network: "mainnet",
    async call(_m, args) {
      if (args.method_name === "estimate_wallet_policy_cost")
        return { result: [...Buffer.from('"1"')] };
      if (args.method_name === "get_wallet_policy")
        return {
          result: [
            ...Buffer.from(
              JSON.stringify({
                owner: "owner.near",
                version,
                encrypted_data: cipher,
                locked: false,
                frozen: false,
              }),
            ),
          ],
        };
      throw Error("unexpected");
    },
    async transaction() {
      return saved.tx;
    },
    async block(id) {
      return saved.rpc.block(id);
    },
    async keyAt() {
      return { permission: "FullAccess" };
    },
  };
  const api = {
    async identity() {},
    async request() {
      return { ...policy, approval: null, frozen: false };
    },
    async encrypt(_b, p) {
      policy = p;
      return {
        encrypted_base64: "exit-cipher-" + (version + 1),
        policy_hash: hash(p),
      };
    },
    async signPolicy() {
      return {
        public_key_hex: publicKey(f.binding.publicKey).hex,
        version: version + 1,
        locked: false,
        valid_until: Math.floor(Date.now() / 1000) + 300,
        policy_hash: hash(policy),
        signature_hex: "ab".repeat(64),
      };
    },
    async transfer(_b, transfer) {
      posts++;
      const row = (
        await pool.query(
          "SELECT * FROM mpp_direct_live_withdrawals ORDER BY (plan->>'createdAtMs')::bigint DESC LIMIT 1",
        )
      ).rows[0];
      saved = fixture({
        request: {
          network: "mainnet",
          payer: f.binding.payer,
          recipient: "owner.near",
          refundTo: f.binding.payer,
          amount: transfer.amount,
          issuedAtMs: row.plan.createdAtMs,
          expiresAtMs: row.plan.createdAtMs + 60000,
        },
      });
      saved.tx.transaction.public_key = f.binding.publicKey;
      saved.tx.transaction_outcome.outcome.tokens_burnt = "100";
      saved.tx.receipts_outcome[0].outcome.tokens_burnt = "200";
      saved.blocks.inclusion = Date.now();
      saved.blocks.settlement = Date.now();
      return {
        request_id: "22222222-2222-4222-8222-222222222222",
        status: "success",
        tx_hash: saved.txHash,
      };
    },
  };
  const s = new AuctionSetup({
    market: f.market,
    rpc,
    api,
    credentials: {},
    wallet: {
      async balance() {
        return { availableYocto: "10000000000000000000000" };
      },
    },
  });
  s.onboarding.freezeTransaction = async () => ({});
  const first = await s.withdrawals.prepare("owner.near", "wallet", {
    confirmExit: true,
    operation: "exit-1",
  });
  assert.equal(first.recipient, "owner.near");
  assert.deepEqual(policy.rules.addresses.list, ["owner.near"]);
  assert.equal(policy.capabilities.sign_message.allowed, false);
  await assert.rejects(
    () => s.withdrawals.confirm("owner.near", first.id),
    /policy_changed_or_frozen/,
  );
  version = 2;
  cipher = first.transaction.actions[0].params.args.encrypted_data;
  await s.withdrawals.confirm("owner.near", first.id);
  await s.withdrawals.recover("owner.near", first.id);
  assert.equal(posts, 0);
  const results = await Promise.all([
    s.withdrawals.recover("owner.near", first.id, { send: true }),
    s.withdrawals.recover("owner.near", first.id, { send: true }),
  ]);
  assert.ok(
    results.every((r) => r.state === "final"),
    JSON.stringify(results),
  );
  assert.equal(posts, 1);
  assert.equal(results[0].gasActualYocto, "300");
  // Another owner-authorized exit can recover a later credit; it is not a replay.
  const second = await s.withdrawals.prepare("owner.near", "wallet", {
    confirmExit: true,
    operation: "exit-2",
  });
  assert.notEqual(first.id, second.id);
  assert.equal(second.policyVersion, 3);
  assert.equal(posts, 1);
});

test("owner exit: a lost transfer ACK survives restart and never posts a replacement", async () => {
  const f = await setup();
  await pool.query(
    "UPDATE mpp_direct_auction_agents SET active=false WHERE id='a'",
  );
  const p = {
    network: "mainnet",
    payer: f.binding.payer,
    recipient: "owner.near",
    amount: "100",
    publicKey: f.binding.publicKey,
    createdAtMs: Date.now(),
    gasCapYocto: f.p.gasReserveYocto,
  };
  const binding = { ...f.binding, policy: { ...f.binding.policy, version: 2 } };
  await pool.query(
    "INSERT INTO mpp_direct_live_withdrawals(id,wallet_id,owner_id,plan,policy,binding,state) VALUES('exit-original','wallet','owner.near',$1,$2,$3,'prepared')",
    [p, {}, binding],
  );
  let posts = 0;
  const api = {
    async identity() {},
    async transfer() {
      posts++;
      throw Error("lost-ack");
    },
  };
  const rpc = {
    network: "mainnet",
    async call() {
      return {
        result: [
          ...Buffer.from(
            JSON.stringify({
              owner: "owner.near",
              version: 2,
              encrypted_data: "cipher",
              locked: false,
              frozen: false,
            }),
          ),
        ],
      };
    },
  };
  const s = new AuctionSetup({
    market: f.market,
    rpc,
    api,
    credentials: {},
    wallet: {},
  });
  assert.equal(
    (await s.withdrawals.recover("owner.near", "exit-original", { send: true }))
      .state,
    "review",
  );
  const restarted = new AuctionSetup({
    market: f.market,
    rpc,
    api,
    credentials: {},
    wallet: {},
  });
  assert.equal(
    (
      await restarted.withdrawals.recover("owner.near", "exit-original", {
        send: true,
      })
    ).state,
    "review",
  );
  assert.equal(posts, 1);
});
