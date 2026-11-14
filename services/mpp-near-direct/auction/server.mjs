import http from "node:http";
import { Challenge } from "mppx";
import { ownerAuth as createOwnerAuth } from "./owner-auth.mjs";
import { hash, requireThat as check } from "../contract.mjs";

const json = (res, status, value, headers = {}) => {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    ...headers,
  });
  res.end(JSON.stringify(value));
};
async function read(req) {
  let size = 0;
  const chunks = [];
  for await (const b of req) {
    size += b.length;
    check(size <= 128 * 1024, "body_too_large");
    chunks.push(b);
  }
  return JSON.parse(Buffer.concat(chunks).toString() || "{}");
}
export async function startAuctionServer({
  market,
  wallet,
  provider,
  ownerTokens = [],
  ownerAuth,
  ownerBindings = {},
  port = 0,
  uiOrigin = "http://127.0.0.1:4173",
}) {
  check(
    market.config.mode === "controlled" &&
      market.config.realBroadcastEnabled === false &&
      wallet.scope === "controlled-fixture" &&
      wallet.durableOriginalOperations === true &&
      provider.scope === "controlled-fixture",
    "real_auction_gate_closed",
  );
  const ui = new URL(uiOrigin);
  check(
    ui.protocol === "http:" && ui.hostname === "127.0.0.1",
    "controlled_ui_loopback_required",
  );
  const auth =
    ownerAuth ??
    createOwnerAuth({ origin: uiOrigin, network: market.config.network });
  const cookies = (req) =>
    Object.fromEntries(
      String(req.headers.cookie ?? " ")
        .split(";")
        .map((v) => v.trim().split(/=(.*)/s).slice(0, 2))
        .filter((v) => v.length === 2)
        .map(([k, v]) => [k, decodeURIComponent(v)]),
    );
  const cookie = (key, value) =>
    key +
    "=" +
    encodeURIComponent(value) +
    "; HttpOnly; SameSite=Strict; Path=/";
  const ownerId = (owner) =>
    ownerBindings[owner.account_id] ??
    market.config.network + ":" + owner.account_id;
  let stopping = false,
    busy = false;
  async function worker() {
    if (busy || stopping) return;
    busy = true;
    try {
      await market.expire();
      await market.clear();
      const pending = (
        await market.pool.query(
          "SELECT * FROM mpp_direct_auction_allocations WHERE payment IN('not_started','pending','unknown') ORDER BY id",
        )
      ).rows;
      for (const a of pending)
        try {
          const op = (
            await market.pool.query(
              "SELECT * FROM mpp_direct_auction_operations WHERE id=$1",
              [a.payment_operation],
            )
          ).rows[0];
          const proof =
            a.execution === "fenced"
              ? await wallet.sealOriginal(op)
              : await wallet.recoverOriginal(op);
          if (proof?.state === "never_sent")
            await market.proveNotSent(a.id, proof);
          else if (proof) await market.acceptVerifiedPayment(a.id, proof);
        } catch {
          /* Query/cancel only, never start a payment in a background worker. */
        }
      const live = (
        await market.pool.query(
          "SELECT * FROM mpp_direct_auction_allocations WHERE execution IN('ready','executing','unknown') ORDER BY id",
        )
      ).rows;
      for (const a of live)
        try {
          if (a.execution === "ready") {
            const permit = await market.claimExecution(a.id);
            try {
              const result = await provider.executeOriginal(permit);
              await market.finishExecution(a.id, { ...permit, ...result });
            } catch {
              await market.executionUnknown(a.id, permit.claim);
            }
          } else {
            const original = await provider.recoverOriginal(a.execution_id);
            if (original)
              await market.finishExecution(a.id, {
                claim: a.dispatch_claim,
                generation: String(a.generation),
                ...original,
              });
          }
        } catch {
          /* Original execution liability stays reserved. */
        }
      const refunds = (
        await market.pool.query(
          "SELECT * FROM mpp_direct_auction_allocations WHERE refundable>0 AND settlement IN('refund_pending','unknown') ORDER BY id",
        )
      ).rows;
      for (const a of refunds)
        try {
          const plan = await market.beginOperation(a.id, "refund"),
            proof = await wallet.refundOriginal(plan.operation);
          if (proof) await market.acceptVerifiedRefund(a.id, proof);
        } catch {
          await market.operationUnknown(a.id, "refund").catch(() => {});
        }
      for (const a of (
        await market.pool.query(
          "SELECT id FROM mpp_direct_auction_agents WHERE active",
        )
      ).rows)
        try {
          await market.observeFinalBalance(a.id, (payer) =>
            wallet.balance(payer),
          );
        } catch {}
    } finally {
      busy = false;
    }
  }
  async function agents(req) {
    let signedOwner;
    try {
      signedOwner = auth.owner(cookies(req).near_owner);
    } catch {}
    if (signedOwner)
      return (
        await market.pool.query(
          "SELECT id FROM mpp_direct_auction_agents WHERE owner_id=$1 AND active ORDER BY id",
          [ownerId(signedOwner)],
        )
      ).rows.map((r) => r.id);
    const bearer = String(req.headers.authorization ?? "").replace(
      /^Bearer /,
      "",
    );
    const cookie = String(req.headers.cookie ?? "")
      .split(";")
      .map((v) => v.trim())
      .find((v) => v.startsWith("auction_owner="))
      ?.slice(14);
    const owner = ownerTokens.find(
      (o) => o.tokenHash === hash(cookie ? decodeURIComponent(cookie) : bearer),
    );
    if (owner)
      return (
        await market.pool.query(
          "SELECT id FROM mpp_direct_auction_agents WHERE owner_id=$1 AND active ORDER BY id",
          [owner.ownerId],
        )
      ).rows.map((r) => r.id);
    return [(await market.authenticate(bearer)).id];
  }
  const server = http.createServer(async (req, res) => {
    try {
      req.url = req.url.replace(/^\/buyer-api(?=\/)/, "/market-api");
      // Loopback-only controlled server. Reject cross-origin mutations and never
      // send credentials or native task bytes to a caller-selected URL.
      if (req.headers.origin)
        check(
          req.headers.origin === `http://127.0.0.1:${server.address().port}` ||
            req.headers.origin === uiOrigin,
          "origin_denied",
        );
      if (req.url === "/market-api/capabilities" && req.method === "GET")
        return json(res, 200, {
          version: 1,
          mode: "controlled",
          taskRuntime: "client-memory-v1",
          network: market.config.network,
          tasks: true,
          walletSetup: false,
          ownerAuth: "nep413",
          nativeWallets: true,
          nativeFunding: false,
          realInferencePayments: false,
          maxTasksPerAgent: 8,
          taskWindowMs: 180000,
          realChainPayments: false,
          realInference: false,
        });
      if (req.url === "/market-api/attestation" && req.method === "GET")
        // This server is gated to local fixtures above, never a verified deployment.
        return json(res, 200, {
          status: "controlled_local",
          compose_hash: null,
          catalog_policy_digest: null,
          workload_keyset_digest: null,
          tls_pinned: false,
          quote_type: null,
          checked_at: new Date().toISOString(),
        });
      if (req.url === "/market-api/session" && req.method === "GET") {
        let owner = null;
        try {
          owner = auth.owner(cookies(req).near_owner);
        } catch {}
        // The fixture bearer remains headless test support; there is no code-login UI.
        if (!owner) {
          const fixture = ownerTokens.find(
            (o) => o.tokenHash === hash(cookies(req).auction_owner ?? ""),
          );
          if (fixture)
            owner = {
              account_id: fixture.ownerId,
              public_key: "controlled-fixture",
            };
        }
        return json(res, 200, { owner });
      }
      if (req.url === "/market-api/auth/challenge" && req.method === "POST") {
        const challenge = auth.challenge(req.headers.origin ?? uiOrigin);
        return json(res, 200, challenge.payload, {
          "set-cookie": cookie("near_challenge", challenge.token),
        });
      }
      if (req.url === "/market-api/auth/verify" && req.method === "POST") {
        const result = await auth.verify(
          cookies(req).near_challenge,
          await read(req),
        );
        return json(
          res,
          200,
          { owner: result.owner },
          {
            "set-cookie": [
              cookie("near_owner", result.token),
              cookie("near_challenge", "") + "; Max-Age=0",
            ],
          },
        );
      }
      if (req.url === "/market-api/logout" && req.method === "POST") {
        const current = cookies(req);
        let ids = [];
        try {
          ids = await agents(req);
        } catch {}
        auth.cancel(current.near_challenge);
        auth.logout(current.near_owner);
        const failures = [];
        for (const id of ids)
          for (const g of (
            await market.pool.query(
              "SELECT id,revision::text FROM mpp_direct_auction_grants WHERE agent_id=$1 AND active",
              [id],
            )
          ).rows)
            try {
              await market.revoke(id, g.id, g.revision);
            } catch {
              failures.push(g.id);
            }
        return json(
          res,
          failures.length ? 503 : 200,
          { loggedOut: true, pauseFailures: failures },
          {
            "set-cookie": ["near_owner", "near_challenge", "auction_owner"].map(
              (k) => cookie(k, "") + "; Max-Age=0",
            ),
          },
        );
      }
      const ids = await agents(req);
      if (req.url === "/market-api/authorizations" && req.method === "GET") {
        const grants = (
          await market.pool.query(
            `SELECT g.id,g.agent_id,g.deadline_ms::text,g.revision::text,g.call_cap_micro::text,g.gas_cap_yocto::text,bp.deadline_ms::text AS agent_deadline_ms,'100000'::text AS agent_call_cap_micro,b.cap_nano::text,b.reserved_nano::text,b.spent_nano::text,g.active,a.payer,bp.cap_nano::text AS agent_cap_nano,bp.reserved_nano::text AS agent_reserved_nano,bp.spent_nano::text AS agent_spent_nano
     FROM mpp_direct_auction_grants g JOIN mpp_direct_auction_agents a ON a.id=g.agent_id JOIN mpp_direct_auction_budgets bp ON bp.id=a.agent_budget JOIN mpp_direct_auction_budgets b ON b.id=g.task_budget WHERE g.agent_id=ANY($1) ORDER BY g.agent_id,g.id`,
            [ids],
          )
        ).rows;
        const bids = (
          await market.pool.query(
            "SELECT id,agent_id,grant_id,logical_call,revision::text,bid_multiplier::text,state,expiry_ms::text FROM mpp_direct_auction_bids WHERE agent_id=ANY($1) ORDER BY accepted_sequence",
            [ids],
          )
        ).rows;
        return json(res, 200, {
          bids,
          grants,
          service: market.config.service,
          pricing: {
            fx: market.config.fx,
            paymentWindowMs: market.config.paymentWindowMs,
            admissionWindowMs: market.config.admissionWindowMs,
          },
        });
      }
      if (req.url === "/market-api/authorizations" && req.method === "POST") {
        const input = await read(req);
        check(ids.includes(input.agentId), "unknown_agent");
        return json(res, 201, await market.createGrant(input.agentId, input));
      }
      if (req.url === "/market-api/orders" && req.method === "GET") {
        const rows = (
          await market.pool.query(
            "SELECT * FROM mpp_direct_auction_allocations WHERE agent_id=ANY($1) ORDER BY id",
            [ids],
          )
        ).rows;
        return json(res, 200, {
          orders: rows.map((a) => {
            const {
              result: _result,
              challenge: _challenge,
              ...financial
            } = market.view(a);
            return financial;
          }),
        });
      }
      const pay = req.url.match(/^\/market-api\/orders\/([a-f0-9]{64})\/pay$/),
        order = req.url.match(/^\/market-api\/orders\/([a-f0-9]{64})$/);
      if (order && req.method === "GET") {
        const row = (
          await market.pool.query(
            "SELECT agent_id FROM mpp_direct_auction_allocations WHERE id=$1 AND agent_id=ANY($2)",
            [order[1], ids],
          )
        ).rows[0];
        check(row, "unknown_allocation");
        return json(res, 200, await market.status(row.agent_id, order[1]));
      }
      if (pay && req.method === "POST") {
        const row = (
          await market.pool.query(
            "SELECT * FROM mpp_direct_auction_allocations WHERE id=$1 AND agent_id=ANY($2)",
            [pay[1], ids],
          )
        ).rows[0];
        check(row, "unknown_allocation");
        const input = await read(req);
        check(
          input.challengeId === row.challenge.id &&
            input.contractHash === row.contract.contractHash,
          "challenge_mismatch",
        );
        const plan = await market.beginOperation(row.id, "payment");
        let proof;
        try {
          proof = await wallet.payOriginal(plan.operation);
        } catch (e) {
          await market.operationUnknown(row.id, "payment");
          throw e;
        }
        check(proof, "original_payment_unknown");
        await market.acceptVerifiedPayment(row.id, proof);
        void worker();
        return json(res, 200, { originalOperation: plan.operation.id });
      }
      const revoke = req.url.match(
        /^\/market-api\/authorizations\/([a-zA-Z0-9_-]{1,128})\/revoke$/,
      );
      if (revoke && req.method === "POST") {
        const g = (
          await market.pool.query(
            "SELECT agent_id FROM mpp_direct_auction_grants WHERE id=$1 AND agent_id=ANY($2)",
            [revoke[1], ids],
          )
        ).rows[0];
        check(g, "unknown_authorization");
        return json(
          res,
          200,
          await market.revoke(
            g.agent_id,
            revoke[1],
            (await read(req)).expectedRevision,
          ),
        );
      }
      const revise = req.url.match(
        /^\/market-api\/bids\/([a-f0-9]{64})\/revise$/,
      );
      if (revise && req.method === "POST") {
        const b = (
          await market.pool.query(
            "SELECT agent_id FROM mpp_direct_auction_bids WHERE id=$1 AND agent_id=ANY($2)",
            [revise[1], ids],
          )
        ).rows[0];
        check(b, "unknown_bid");
        return json(
          res,
          200,
          await market.revise(b.agent_id, revise[1], await read(req)),
        );
      }
      if (req.url === "/market-api/procure" && req.method === "POST") {
        const input = await read(req);
        check(ids.includes(input.agentId), "unknown_agent");
        check(
          req.headers["idempotency-key"] === input.logicalCallId,
          "stable_logical_call_required",
        );
        const bid = await market.submit(input.agentId, {
          operation: input.logicalCallId,
          grantId: input.authorizationId,
          logicalCallId: input.logicalCallId,
          body: input.body,
          requestHash: input.requestHash,
          bidMultiplier: input.bidMultiplier,
          maxTotalMicro: input.maxTotalMicro,
          expiryMs: input.expiryMs,
        });
        const status = await market.bidStatus(input.agentId, bid.bidId);
        if (!status.allocationId) return json(res, 202, status);
        if (status.result)
          return void (
            res.writeHead(200, {
              "content-type": "text/event-stream",
              "cache-control": "no-store",
              "x-order-id": status.orderId,
            }),
            res.end(status.result.sse)
          );
        if (status.executionState === "fenced")
          return json(res, 409, {
            error: { code: "original_execution_fenced" },
            orderId: status.orderId,
          });
        if (status.paymentState !== "confirmed")
          return json(res, 402, status, {
            "www-authenticate": Challenge.serialize(status.challenge),
          });
        return json(res, 202, { ...status, result: null });
      }
      throw Error("not_found");
    } catch (e) {
      const code = /^[a-z][a-z0-9_]+$/.test(e.message)
        ? e.message
        : "original_operation_unknown";
      json(
        res,
        code === "unauthorized"
          ? 401
          : /^unknown_|not_found/.test(code)
            ? 404
            : /conflict|frozen|fenced/.test(code)
              ? 409
              : /unknown|pending/.test(code)
                ? 503
                : 400,
        { error: { code } },
      );
    }
  });
  await new Promise((r) => server.listen(port, "127.0.0.1", r));
  const timer = setInterval(() => void worker().catch(() => {}), 25);
  return {
    url: "http://127.0.0.1:" + server.address().port,
    worker,
    async close() {
      stopping = true;
      clearInterval(timer);
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
      while (busy) await new Promise((r) => setTimeout(r, 10));
    },
  };
}
