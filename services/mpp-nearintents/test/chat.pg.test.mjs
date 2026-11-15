import { test } from "node:test";
import assert from "node:assert/strict";
import { Mppx } from "mppx/client";
import { nearintents } from "@defuse-protocol/nearintents-mpp-sdk/client";
import { Credential } from "mppx";
import { fixture, policy, BODY, TOKEN, jsonResult } from "./chat-fixture.mjs";
import { paidChatTransport } from "../chat/client.mjs";
import { startChatServer } from "../chat/server.mjs";
import { digest } from "../chat/config.mjs";

const pgTest = (name, fn) =>
  test(name, { skip: !process.env.CHAT_TEST_DATABASE_URL }, fn);
const transport = (f, extra = {}) =>
  paidChatTransport({
    url: f.app.url,
    token: TOKEN,
    policy: policy(),
    payer: f.payer,
    journal: f.journal,
    controlled: true,
    retryDelayMs: 5,
    ...extra,
  });
const invoke = (client, logicalCallId = "call-1", body = BODY) =>
  client.invoke({ body, logicalCallId, signal: AbortSignal.timeout(10000) });

pgTest(
  "official SDK pays for a chat request directly; replay and restart never pay or infer again",
  async (t) => {
    const f = await fixture(t),
      client = transport(f);
    const response = await invoke(client);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), jsonResult(JSON.parse(BODY)));
    assert.ok(response.headers.get("payment-receipt"));
    assert.equal(f.counters.deposits, 1);
    assert.equal(f.counters.inference, 1);
    const first = (await f.pool.query("SELECT * FROM chat_calls")).rows[0];
    assert.equal(first.state, "complete");
    assert.equal(first.terms.usageRebate, false);
    assert.equal(first.refund_due, "0");
    assert.equal(first.terms.amountOut, "1000");
    assert.equal(first.usage.completion_tokens, 1);
    await f.restart();
    const replay = await invoke(transport(f));
    assert.equal(replay.status, 200);
    assert.equal(await replay.text(), first.response);
    assert.equal(f.counters.deposits, 1);
    assert.equal(f.counters.inference, 1);
    assert.equal(f.counters.quotes, 1);
    assert.equal(
      (
        await f.pool.query(
          "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema=$1 AND table_name LIKE '%credit%'",
          [f.cfg.schema],
        )
      ).rows[0].n,
      0,
    );
  },
);
pgTest(
  "native SSE bytes survive the payment handshake and replay",
  async (t) => {
    const f = await fixture(t),
      body = JSON.stringify({
        ...JSON.parse(BODY),
        stream: true,
        stream_options: { include_usage: true },
      });
    const result = await invoke(transport(f), "stream-call", body);
    assert.equal(result.status, 200);
    assert.match(result.headers.get("content-type"), /text\/event-stream/);
    assert.match(await result.text(), /data: \[DONE\]/);
    assert.equal(f.counters.inference, 1);
  },
);
pgTest(
  "authentication, body binding, independent agents and concurrent presentations",
  async (t) => {
    const secondToken = "second-agent-token-".repeat(4);
    const f = await fixture(t, {
      change: (c) =>
        c.agents.push({
          ...c.agents[0],
          id: "agent-b",
          tokenHash: digest(secondToken),
        }),
    });
    assert.equal((await f.post("bad", BODY, undefined, "wrong")).status, 401);
    assert.equal(f.counters.quotes, 0);
    const offered = await f.post("call-1");
    const status = await offered.clone().json();
    assert.equal(offered.status, 402);
    assert.equal(
      (await f.post("call-1", BODY.replace("2 + 3?", "different"))).status,
      409,
    );
    const other = await (
      await f.post("call-1", BODY, undefined, secondToken)
    ).json();
    assert.notEqual(
      other.challenge.request.recipient,
      status.challenge.request.recipient,
    );
    const sdk = Mppx.create({
      polyfill: false,
      methods: [
        nearintents.charge({
          policy: policy(),
          sendDeposit: ({ request }) =>
            f.payer.payOriginal({ operationId: status.id, request }),
        }),
      ],
    });
    const credential = await sdk.createCredential(offered);
    const results = await Promise.all([
      f.post("call-1", BODY, credential),
      f.post("call-1", BODY, credential),
    ]);
    assert.ok(results.every((r) => [200, 202].includes(r.status)));
    assert.equal(f.counters.deposits, 1);
    assert.equal(f.counters.inference, 1);
    assert.equal(
      (await f.post("call-1", BODY, credential, secondToken)).status,
      409,
    );
  },
);
pgTest(
  "atomic SDK consumption rolls back with paid-order persistence; original credential recovers",
  async (t) => {
    let fail = true;
    const f = await fixture(t, {
      fault: (point) => {
        if (point === "before_payment_commit" && fail) {
          fail = false;
          throw Error("injected_payment_commit_failure");
        }
      },
    });
    const result = await invoke(transport(f));
    assert.equal(result.status, 200);
    assert.equal(f.counters.deposits, 1);
    assert.equal(f.counters.inference, 1);
    assert.equal(
      (
        await f.pool.query(
          "SELECT count(*)::int AS n FROM chat_payment_attempts",
        )
      ).rows[0].n,
      1,
    );
    assert.equal(
      (
        await f.pool.query(
          "SELECT count(*)::int AS n FROM chat_events WHERE kind='paid'",
        )
      ).rows[0].n,
      1,
    );
  },
);
pgTest(
  "original result write retries captured bytes without invoking provider twice",
  async (t) => {
    let fail = true;
    const f = await fixture(t, {
      fault: (point) => {
        if (point === "before_result_commit" && fail) {
          fail = false;
          throw Error("injected_result_commit_failure");
        }
      },
    });
    assert.equal((await invoke(transport(f))).status, 200);
    assert.equal(f.counters.inference, 1);
    assert.equal(f.counters.deposits, 1);
  },
);
pgTest(
  "a dispatch crash remains fenced across restart and cannot regenerate inference",
  async (t) => {
    const f = await fixture(t, {
      fault: (point) => {
        if (point === "after_dispatch_commit")
          throw Error("injected_dispatch_crash");
      },
    });
    const result = await invoke(transport(f, { maximumAttempts: 3 }));
    assert.equal(result.status, 202);
    assert.equal(f.counters.inference, 0);
    assert.equal(f.counters.deposits, 1);
    await f.restart();
    assert.equal(
      (await invoke(transport(f, { maximumAttempts: 2 }))).status,
      202,
    );
    assert.equal(f.counters.inference, 0);
    assert.equal(f.counters.deposits, 1);
  },
);
pgTest(
  "paid provider failure retains full refund liability and cannot trigger another charge",
  async (t) => {
    const f = await fixture(t);
    f.providerStatus = 503;
    const result = await invoke(transport(f));
    assert.equal(result.status, 409);
    const failed = await result.json();
    assert.equal(failed.state, "failed");
    assert.equal(failed.refundDue, "1000");
    assert.equal(failed.refundStatus, "manual_reconciliation_required");
    await f.restart();
    assert.equal((await invoke(transport(f))).status, 409);
    assert.equal(f.counters.inference, 1);
    assert.equal(f.counters.deposits, 1);
    assert.equal((await f.post("another-call")).status, 409);
    assert.equal(f.counters.quotes, 1);
  },
);
pgTest(
  "swap failure and credential tampering never deliver inference or issue a replacement quote",
  async (t) => {
    const f = await fixture(t);
    f.swapStatus = "REFUNDED";
    const result = await invoke(transport(f));
    assert.equal(result.status, 409);
    assert.equal(f.counters.inference, 0);
    assert.equal(f.counters.deposits, 1);
    assert.equal((await f.post("call-1")).status, 409);
    assert.equal(f.counters.quotes, 1);
    const row = (await f.pool.query("SELECT * FROM chat_calls")).rows[0];
    const credential = Credential.deserialize(row.credential);
    credential.challenge.request.methodDetails.amountOut = "1";
    assert.equal(
      (await f.post("call-1", BODY, Credential.serialize(credential))).status,
      409,
    );
  },
);
pgTest(
  "agent price, speed and cumulative budget limits reject before a wallet effect",
  async (t) => {
    const f = await fixture(t);
    await assert.rejects(
      invoke(
        transport(f, { policy: { ...policy(), maximumAmountOut: "999" } }),
      ),
      /autobidder_price_or_speed_rejected/,
    );
    assert.equal(f.counters.deposits, 0);
    // Same original offer can be accepted once, then the durable source budget
    // refuses another call even when the backend would accept a larger budget.
    const limited = transport(f, {
      policy: { ...policy(), maximumTotalAmountIn: "1100" },
    });
    assert.equal((await invoke(limited)).status, 200);
    await assert.rejects(
      invoke(limited, "call-2"),
      /agent_total_budget_exhausted/,
    );
    assert.equal(f.counters.deposits, 1);
    assert.equal(f.counters.inference, 1);
  },
);
pgTest(
  "configuration cannot change merchant, price or HMAC secret on restart",
  async (t) => {
    const f = await fixture(t);
    await assert.rejects(
      startChatServer({
        pool: f.pool,
        config: { ...f.cfg, destinationRecipient: "other.near" },
        secret: f.secret,
        provider: f.provider,
      }),
      /chat_configuration_changed/,
    );
  },
);
pgTest(
  "lost response after paid completion replays the original result through the same API",
  async (t) => {
    const f = await fixture(t);
    let lost = false;
    const fetcher = async (url, init) => {
      const result = await fetch(url, init);
      if (result.status === 200 && !lost) {
        lost = true;
        await result.body.cancel();
        throw new TypeError("controlled_response_ack_lost");
      }
      return result;
    };
    assert.equal((await invoke(transport(f, { fetcher }))).status, 200);
    assert.equal(f.counters.deposits, 1);
    assert.equal(f.counters.inference, 1);
  },
);
pgTest(
  "lost signer ACK recovers the original transfer before presenting a credential",
  async (t) => {
    const f = await fixture(t);
    let lost = false;
    const payer = {
      durableOriginalOperations: true,
      async payOriginal(input) {
        const hash = await f.payer.payOriginal(input);
        if (!lost) {
          lost = true;
          throw Error("controlled_signer_ack_lost");
        }
        return hash;
      },
    };
    await assert.rejects(
      invoke(transport(f, { payer })),
      /controlled_signer_ack_lost/,
    );
    assert.equal(f.counters.deposits, 1);
    assert.equal(f.counters.inference, 0);
    assert.equal((await invoke(transport(f, { payer }))).status, 200);
    assert.equal(f.counters.deposits, 1);
    assert.equal(f.counters.inference, 1);
  },
);
pgTest(
  "agent speed policy refuses a slow source route before signing",
  async (t) => {
    const f = await fixture(t, { quoteTimeEstimate: 61 });
    await assert.rejects(
      invoke(transport(f)),
      /autobidder_price_or_speed_rejected/,
    );
    assert.equal(f.counters.deposits, 0);
    assert.equal(f.counters.inference, 0);
  },
);
pgTest(
  "source USDC and a 24-decimal NEAR destination retain separate exact atomic amounts",
  async (t) => {
    const amountOut = "10000000000000000000001";
    const destinationAsset = "near:mainnet/nep141:wrap.near";
    const f = await fixture(t, {
      quoteAmountIn: "1100",
      change: (c) => {
        c.destinationAsset = destinationAsset;
        c.offers[0].amountOut = amountOut;
      },
    });
    const p = policy();
    p.maximumAmountOut = amountOut;
    p.expectedDestination.destinationAsset = destinationAsset;
    assert.equal((await invoke(transport(f, { policy: p }))).status, 200);
    const row = (await f.pool.query("SELECT * FROM chat_calls")).rows[0];
    assert.equal(row.terms.amountOut, amountOut);
    assert.equal(row.challenge.request.methodDetails.amountOut, amountOut);
    assert.equal(row.challenge.request.amount, "1100");
    assert.equal(f.counters.deposits, 1);
  },
);
