import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { Challenge, Credential, Receipt } from "mppx";
import { Mppx } from "mppx/server";
import { nearintents } from "@defuse-protocol/nearintents-mpp-sdk/server";
import { OneClick, Types } from "@defuse-protocol/nearintents-mpp-sdk";
import { atomicStore } from "../bridge.mjs";
import { admit, check, configuration, digest, uint } from "./config.mjs";

const response = (status, data, headers = {}) => ({ status, data, headers });
const failure = (status, code, id) =>
  response(status, { error: { code }, ...(id ? { id } : {}) });

export class ChatAuthority {
  constructor({ pool, config, secret, jwt, provider, fault = () => {} }) {
    const frozen = configuration(config, secret);
    Object.assign(this, { pool, secret, jwt, provider, fault, ...frozen });
    check(
      provider?.mode === config.mode && typeof provider.invoke === "function",
      "provider_payment_mode_mismatch",
    );
  }
  async transaction(fn) {
    const db = await this.pool.connect();
    try {
      await db.query("BEGIN");
      const result = await fn(db);
      await db.query("COMMIT");
      return result;
    } catch (e) {
      await db.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      db.release();
    }
  }
  async initialize() {
    return this.transaction(async (db) => {
      await db.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,814518))",
        [this.config.schema],
      );
      check(
        (await db.query("SELECT current_schema() AS name")).rows[0].name ===
          this.config.schema,
        "dedicated_schema_required",
      );
      const exists = (
        await db.query(
          "SELECT to_regclass('chat_configuration') IS NOT NULL AS yes",
        )
      ).rows[0].yes;
      if (!exists) {
        // Never attach a second financial authority to an existing auction or
        // credit schema. Existing services keep their own original liabilities.
        check(
          !(
            await db.query(
              "SELECT FROM information_schema.tables WHERE table_schema=$1 LIMIT 1",
              [this.config.schema],
            )
          ).rowCount,
          "empty_chat_schema_required",
        );
        await db.query(
          await readFile(new URL("./schema.sql", import.meta.url), "utf8"),
        );
        await db.query(
          "INSERT INTO chat_configuration(fingerprint,configuration) VALUES($1,$2)",
          [this.fingerprint, this.config],
        );
      }
      const old = (await db.query("SELECT fingerprint FROM chat_configuration"))
        .rows[0];
      check(old.fingerprint === this.fingerprint, "chat_configuration_changed");
    });
  }
  agent(token) {
    return typeof token === "string"
      ? this.config.agents.find((a) => a.tokenHash === digest(token))
      : undefined;
  }
  async row(agent, logicalKey, db = this.pool) {
    return (
      await db.query(
        "SELECT * FROM chat_calls WHERE agent_id=$1 AND logical_key=$2",
        [agent.id, logicalKey],
      )
    ).rows[0];
  }
  async event(db, id, kind, value) {
    await db.query(
      "INSERT INTO chat_events(call_id,kind,value) VALUES($1,$2,$3)",
      [id, kind, value],
    );
  }
  charge(db, row, agent) {
    return Mppx.create({
      secretKey: this.secret,
      realm: this.config.realm,
      requiresAuth: true,
      methods: [
        nearintents.charge({
          originAsset: agent.originAsset,
          destinationAsset: this.config.destinationAsset,
          destinationRecipient: this.config.destinationRecipient,
          refundTo: agent.refundTo,
          amountOut: row.terms.amountOut,
          externalId: row.id,
          description: `fixed-request-v1; terms=${digest(row.terms)}; no usage rebate`,
          expiresWindow: this.config.expiresWindow,
          settlementTimeout: this.config.settlementTimeout,
          pollInterval: this.config.pollInterval,
          oneClick: {
            baseUrl: this.config.oneClickBaseUrl,
            jwt: this.jwt,
            requestTimeoutMs: 5000,
            fetch: (url, init) => fetch(url, { ...init, redirect: "error" }),
          },
          store: atomicStore(db, `chat:${row.id}`),
        }),
      ],
    }).charge({
      expires: new Date(Number(row.expires_ms)).toISOString(),
      scope: `chat:${row.id}:${row.request_hash}:${digest(row.terms)}`,
    });
  }
  url(id) {
    return `https://inference.invalid/v1/chat/completions/${id}`;
  }
  async create(agent, logicalKey, raw) {
    check(
      typeof logicalKey === "string" &&
        /^[a-zA-Z0-9_.:-]{1,128}$/.test(logicalKey),
      "stable_idempotency_key_required",
    );
    const { requestHash, offer, outputLimit } = admit(raw, this.config);
    return this.transaction(async (db) => {
      const state = (
        await db.query("SELECT * FROM chat_configuration FOR UPDATE")
      ).rows[0];
      check(
        state.fingerprint === this.fingerprint,
        "chat_configuration_changed",
      );
      const old = await this.row(agent, logicalKey, db);
      if (old) {
        check(
          old.request_hash === requestHash && old.body === raw,
          "logical_request_conflict",
        );
        return old;
      }
      const at = Date.now();
      check(
        !(await db.query("SELECT FROM chat_calls WHERE refund_due>0 LIMIT 1"))
          .rowCount,
        "delivery_liability_requires_reconciliation",
      );
      check(
        at + this.config.expiresWindow * 1000 < this.config.deadlineMs,
        "run_closed",
      );
      check(
        state.calls < this.config.maximumCalls &&
          uint(state.provider_reserved) + uint(offer.providerReserveMicro) <=
            uint(this.config.maximumProviderMicro),
        "provider_allowance_exhausted",
      );
      const open = (
        await db.query(
          "SELECT count(*)::int AS n FROM chat_calls WHERE state='offered' AND (expires_ms>$1 OR credential IS NOT NULL)",
          [at],
        )
      ).rows[0].n;
      check(open < this.config.maximumOpenQuotes, "quote_capacity_exhausted");
      check(
        !(
          await db.query(
            "SELECT FROM chat_calls WHERE agent_id=$1 AND state IN('offered','paid','executing','unknown') AND (expires_ms>$2 OR credential IS NOT NULL OR receipt IS NOT NULL) LIMIT 1",
            [agent.id, at],
          )
        ).rowCount,
        "original_call_unresolved",
      );
      const id = randomUUID();
      const terms = {
        version: "fixed-request-v1",
        offerVersion: offer.version,
        model: offer.model,
        requestHash,
        maxOutputTokens: outputLimit,
        maxInputTokens: offer.maxInputTokens,
        amountOut: offer.amountOut,
        destinationAsset: this.config.destinationAsset,
        destinationRecipient: this.config.destinationRecipient,
        originAsset: agent.originAsset,
        refundTo: agent.refundTo,
        usageRebate: false,
        failedDelivery: "full-merchant-refund-due-manual-v1",
        providerReserveMicro: offer.providerReserveMicro,
      };
      const row = {
        id,
        terms,
        request_hash: requestHash,
        expires_ms: at + this.config.expiresWindow * 1000,
      };
      const issued = await this.charge(
        db,
        row,
        agent,
      )(new Request(this.url(id), { method: "POST" }));
      check(issued.status === 402, "quote_unavailable");
      const header = issued.challenge.headers.get("www-authenticate");
      check(header, "quote_unavailable");
      const challenge = Challenge.deserialize(header);
      const q = challenge.request;
      check(
        q.externalId === id && q.methodDetails.amountOut === terms.amountOut,
        "sdk_quote_binding_failed",
      );
      check(
        uint(q.amount) <= uint(agent.maximumAmountIn),
        "source_quote_above_call_cap",
      );
      const total = (
        await db.query(
          "SELECT coalesce(sum((challenge->'request'->>'amount')::numeric),0)::text AS n FROM chat_calls WHERE agent_id=$1",
          [agent.id],
        )
      ).rows[0].n;
      check(
        uint(total) + uint(q.amount) <= uint(agent.maximumTotalAmountIn),
        "source_quote_above_agent_cap",
      );
      const network = Types.chainOf(agent.originAsset);
      const depositKey =
        network +
        "|" +
        (network.startsWith("eip155:")
          ? q.recipient.toLowerCase()
          : q.recipient);
      await db.query(
        `INSERT INTO chat_calls(id,agent_id,logical_key,request_hash,body,terms,challenge,challenge_header,deposit_key,expires_ms,created_ms)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          id,
          agent.id,
          logicalKey,
          requestHash,
          raw,
          terms,
          challenge,
          header,
          depositKey,
          row.expires_ms,
          at,
        ],
      );
      // Conservatively retain all quote/provider reservations for this bounded
      // run, including abandoned and unknown calls. Restart never refills caps.
      await db.query(
        "UPDATE chat_configuration SET provider_reserved=provider_reserved+$1,calls=calls+1",
        [offer.providerReserveMicro],
      );
      await this.event(db, id, "quoted", { terms, challengeId: challenge.id });
      return this.row(agent, logicalKey, db);
    });
  }
  credential(row, header, agent) {
    let candidate;
    try {
      candidate = Credential.deserialize(header);
    } catch {
      throw Error("invalid_payment_credential");
    }
    check(
      isDeepStrictEqual(candidate.challenge, row.challenge) &&
        candidate.payload?.type === "hash" &&
        typeof candidate.payload.hash === "string" &&
        candidate.payload.hash.length <= 256,
      "payment_binding_conflict",
    );
    const network = Types.chainOf(agent.originAsset);
    return {
      candidate,
      paymentKey: `${network}|${OneClick.canonicalTxHash(candidate.payload.hash, network)}`,
    };
  }
  async present(agent, row, header) {
    const { paymentKey } = this.credential(row, header, agent);
    check(
      !row.credential || row.credential === header,
      "original_payment_conflict",
    );
    // Survives a verification/SDK transaction rollback and a process crash.
    await this.transaction(async (db) => {
      const locked = (
        await db.query("SELECT * FROM chat_calls WHERE id=$1 FOR UPDATE", [
          row.id,
        ])
      ).rows[0];
      check(
        !locked.credential || locked.credential === header,
        "original_payment_conflict",
      );
      await db.query(
        "INSERT INTO chat_payment_attempts(call_id,credential_hash,credential) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
        [row.id, digest(header), header],
      );
      await db.query("UPDATE chat_calls SET credential=$2 WHERE id=$1", [
        row.id,
        header,
      ]);
    });
    return this.transaction(async (db) => {
      const current = (
        await db.query("SELECT * FROM chat_calls WHERE id=$1 FOR UPDATE", [
          row.id,
        ])
      ).rows[0];
      if (current.receipt) {
        check(current.payment_key === paymentKey, "original_payment_conflict");
        return current;
      }
      if (Date.now() >= Number(current.expires_ms)) {
        await db.query(
          "UPDATE chat_calls SET last_error='expired_payment_requires_reconciliation' WHERE id=$1",
          [row.id],
        );
        return this.row(agent, current.logical_key, db);
      }
      const result = await this.charge(
        db,
        current,
        agent,
      )(
        new Request(this.url(row.id), {
          method: "POST",
          headers: { "Payment-Authorization": header },
        }),
      );
      if (result.status !== 200) {
        const problem = await result.challenge.json().catch(() => ({}));
        await db.query("UPDATE chat_calls SET last_error=$2 WHERE id=$1", [
          row.id,
          String(problem.type ?? "payment_requires_reconciliation"),
        ]);
        return this.row(agent, current.logical_key, db);
      }
      const settled = await result.withReceipt(Response.json({}));
      const receipt = Receipt.deserialize(
        settled.headers.get("payment-receipt"),
      );
      check(
        receipt.method === "nearintents" &&
          receipt.challengeId === current.challenge.id &&
          receipt.externalId === row.id &&
          receipt.reference,
        "sdk_receipt_binding_failed",
      );
      // SDK hash consumption and the paid order become durable together.
      await db.query(
        "UPDATE chat_calls SET state='paid',payment_key=$2,receipt=$3,last_error=NULL WHERE id=$1",
        [row.id, paymentKey, receipt],
      );
      await this.event(db, row.id, "paid", { paymentKey, receipt });
      await this.fault("before_payment_commit", row.id);
      return this.row(agent, current.logical_key, db);
    });
  }
  async execute(row) {
    const claim = randomUUID();
    const permit = await this.transaction(async (db) => {
      const won = (
        await db.query(
          "UPDATE chat_calls SET state='executing',claim=$2 WHERE id=$1 AND state='paid' RETURNING *",
          [row.id, claim],
        )
      ).rows[0];
      if (won)
        await this.event(db, row.id, "provider_dispatch_claimed", {
          claim,
          requestHash: row.request_hash,
        });
      return won;
    });
    if (!permit) return;
    // A lost ACK/crash after this fence is never permission to POST again.
    await this.fault("after_dispatch_commit", row.id);
    let outcome;
    try {
      outcome = await this.provider.invoke({
        id: row.id,
        raw: row.body,
        terms: row.terms,
        signal: AbortSignal.timeout(this.config.providerTimeoutMs),
      });
      check(
        outcome &&
          ["application/json", "text/event-stream"].includes(
            outcome.contentType,
          ) &&
          typeof outcome.raw === "string" &&
          Buffer.byteLength(outcome.raw) <= 1024 * 1024,
        "invalid_provider_result",
      );
    } catch (e) {
      await this.transaction(async (db) => {
        await db.query(
          "UPDATE chat_calls SET state=$3,last_error=$4,refund_due=(terms->>'amountOut')::numeric WHERE id=$1 AND claim=$2 AND state='executing'",
          [
            row.id,
            claim,
            e.definite ? "failed" : "unknown",
            "original_provider_delivery_unresolved",
          ],
        );
        await this.event(db, row.id, "delivery_refund_liability", {
          claim,
          state: e.definite ? "failed" : "unknown",
          amountOut: row.terms.amountOut,
          destinationAsset: row.terms.destinationAsset,
        });
      });
      return;
    }
    // Retry only this durable write using the captured response. Never retry
    // model generation to reconstruct a missing result.
    const persist = () =>
      this.transaction(async (db) => {
        await db.query(
          "UPDATE chat_calls SET state='complete',response=$3,response_type=$4,usage=$5,last_error=NULL WHERE id=$1 AND claim=$2 AND state='executing'",
          [
            row.id,
            claim,
            outcome.raw,
            outcome.contentType,
            outcome.usage ?? null,
          ],
        );
        await this.event(db, row.id, "completed", {
          responseHash: digest(outcome.raw),
          usage: outcome.usage ?? null,
          verification: outcome.verification ?? null,
        });
        await this.fault("before_result_commit", row.id);
      });
    try {
      await persist();
    } catch {
      await persist();
    }
  }
  view(row) {
    return {
      id: row.id,
      state: row.state,
      terms: row.terms,
      challenge: row.challenge,
      expiresAtMs: Number(row.expires_ms),
      refundDue: row.refund_due,
      refundStatus:
        row.refund_due !== "0"
          ? "manual_reconciliation_required"
          : ["paid", "executing"].includes(row.state)
            ? "delivery_pending"
            : "none",
      error: row.last_error,
    };
  }
  async chat({ agent, logicalKey, raw, credential }) {
    let row = await this.create(agent, logicalKey, raw);
    if (!credential) {
      if (row.credential || Date.now() >= Number(row.expires_ms))
        return response(409, this.view(row));
      return response(402, this.view(row), {
        "www-authenticate": row.challenge_header,
      });
    }
    row = await this.present(agent, row, credential);
    if (!row.receipt) return response(409, this.view(row));
    if (Date.now() >= this.config.deadlineMs && row.state === "paid") {
      await this.pool.query(
        "UPDATE chat_calls SET state='failed',last_error='run_closed_before_execution',refund_due=(terms->>'amountOut')::numeric WHERE id=$1 AND state='paid'",
        [row.id],
      );
    } else if (row.state === "paid") await this.execute(row);
    row = await this.row(agent, logicalKey);
    const headers = {
      "payment-receipt": Receipt.serialize(row.receipt),
      "x-order-id": row.id,
      "x-billing-contract": "fixed-request-v1",
    };
    if (row.state === "complete")
      return {
        status: 200,
        raw: row.response,
        headers: { ...headers, "content-type": row.response_type },
      };
    if (["failed", "unknown"].includes(row.state))
      return response(409, this.view(row), headers);
    return response(202, this.view(row), { ...headers, "retry-after": "1" });
  }
}
