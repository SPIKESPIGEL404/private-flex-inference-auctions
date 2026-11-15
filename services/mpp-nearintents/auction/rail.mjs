import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { Challenge, Credential } from "mppx";
import { Mppx } from "mppx/server";
import { nearintents } from "@defuse-protocol/nearintents-mpp-sdk/server";
import { atomicStore } from "../bridge.mjs";
import { check, digest, uint } from "../chat/config.mjs";
import { auctionPlan } from "./plan.mjs";
export const NI_MODE = "bounded-nearintents-auction-v1";
export const NI_BILLING = "auction-fixed-request-v1";

async function schemaFingerprint(db) {
  const rows = (
    await db.query(`SELECT c.relname,a.attname,format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull,
 pg_get_expr(d.adbin,d.adrelid) AS default_value FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
 JOIN pg_attribute a ON a.attrelid=c.oid LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
 WHERE n.nspname='public' AND c.relname LIKE 'nearintents_auction_%' AND a.attnum>0 AND NOT a.attisdropped ORDER BY c.relname,a.attnum`)
  ).rows;
  const guards = (
    await db.query(`SELECT c.relname,k.conname,pg_get_constraintdef(k.oid) AS definition FROM pg_class c JOIN pg_constraint k ON k.conrelid=c.oid
 JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname LIKE 'nearintents_auction_%' ORDER BY c.relname,k.conname`)
  ).rows;
  const triggers = (
    await db.query(`SELECT c.relname,t.tgname,pg_get_triggerdef(t.oid) AS definition,p.prosrc FROM pg_class c JOIN pg_trigger t ON t.tgrelid=c.oid JOIN pg_proc p ON p.oid=t.tgfoid
 JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname LIKE 'nearintents_auction_%' AND NOT t.tgisinternal ORDER BY c.relname,t.tgname`)
  ).rows;
  return digest({ rows, guards, triggers });
}
export class NearintentsAuctionRail {
  method = "nearintents";
  constructor({ pool, config, secret, jwt }) {
    Object.assign(this, {
      pool,
      config: auctionPlan(config).plan,
      secret,
      jwt,
    });
  }
  validateConfiguration(c, live) {
    this.marketNetwork = c.network;
    check(
      c.billing === NI_BILLING &&
        c.merchant === this.config.merchant &&
        c.realm === this.config.realm &&
        isDeepStrictEqual(c.service, this.config.service) &&
        c.paymentWindowMs === this.config.paymentWindowMs &&
        c.admissionWindowMs === this.config.admissionWindowMs &&
        c.secret === this.secret,
      "auction_payment_profile_mismatch",
    );
    if (c.mode === NI_MODE)
      check(
        this.config.mode === "live" &&
          c.network === "mainnet" &&
          c.realBroadcastEnabled === true &&
          isDeepStrictEqual(c.livePlan, this.config) &&
          live?.scope === NI_MODE &&
          c.reviewedPlanHash === digest(this.config),
        "reviewed_nearintents_plan_required",
      );
    else
      check(
        this.config.mode === "controlled" &&
          c.mode === "controlled" &&
          c.realBroadcastEnabled === false,
        "controlled_nearintents_profile_required",
      );
  }
  async initialize() {
    const source = await readFile(
        new URL("./schema.sql", import.meta.url),
        "utf8",
      ),
      fingerprint = digest([this.config, digest(this.secret), digest(source)]);
    const db = await this.pool.connect();
    try {
      await db.query("BEGIN");
      await db.query("SELECT pg_advisory_xact_lock(2461115001)");
      if (
        !(
          await db.query(
            "SELECT to_regclass('nearintents_auction_configuration') IS NOT NULL AS yes",
          )
        ).rows[0].yes
      ) {
        check(
          !(
            await db.query("SELECT FROM mpp_direct_auction_allocations LIMIT 1")
          ).rowCount,
          "fresh_nearintents_auction_required",
        );
        await db.query(source);
        await db.query(
          "INSERT INTO nearintents_auction_configuration VALUES(true,$1,$2,$3)",
          [fingerprint, await schemaFingerprint(db), randomUUID()],
        );
      }
      const old = (
        await db.query("SELECT * FROM nearintents_auction_configuration")
      ).rows[0];
      check(
        old.fingerprint === fingerprint &&
          old.schema_fingerprint === (await schemaFingerprint(db)),
        "nearintents_adapter_schema_or_plan_changed",
      );
      await db.query("COMMIT");
    } catch (e) {
      await db.query("ROLLBACK");
      throw e;
    } finally {
      db.release();
    }
  }
  validateBalance(b, a, started = 0) {
    check(
      b?.source === "nearintents-source-observation-v1" &&
        b.payer === a.payer &&
        b.asset === this.config.originAsset &&
        b.observedAtMs >= started &&
        b.expiresAtMs > b.observedAtMs &&
        b.expiresAtMs - b.observedAtMs <= 30000,
      "source_balance_observation_required",
    );
    uint(b.sourceAtoms);
    uint(b.gasWei);
    check(!("availableYocto" in b), "source_balance_is_not_native_near");
  }
  spendCapacity(b, a, at) {
    try {
      this.validateBalance(b, a);
      if (
        b.observedAtMs > at ||
        b.expiresAtMs <= at ||
        uint(b.sourceAtoms) < uint(this.config.maximumAmountIn) ||
        uint(b.gasWei) < uint(this.config.maximumGasWei)
      )
        return "0";
      // This is an authorized merchant-principal ceiling, not a fabricated NEAR
      // balance. Exact source cost/gas is independently capped before broadcast.
      const cap = uint(this.config.principalCapYocto),
        reserved = uint(a.native_reserved);
      return String(cap > reserved ? cap - reserved : 0n);
    } catch {
      return "0";
    }
  }
  handler(db, a) {
    const payer = a.payer ?? a.challenge.request.methodDetails.refundTo;
    return Mppx.create({
      secretKey: this.secret,
      realm: this.config.realm,
      requiresAuth: true,
      methods: [
        nearintents.charge({
          originAsset: this.config.originAsset,
          destinationAsset: "near:mainnet/nep141:wrap.near",
          destinationRecipient: this.config.merchant,
          amountOut: a.contract.principalYocto,
          refundTo: payer,
          externalId: a.id,
          description: `${NI_BILLING}; contract=${a.contract.contractHash}; no usage rebate`,
          expiresWindow: this.config.paymentWindowMs / 1000,
          settlementTimeout: this.config.settlementTimeout,
          pollInterval: this.config.pollInterval,
          oneClick: {
            baseUrl: this.config.oneClickBaseUrl,
            jwt: this.jwt,
            requestTimeoutMs: 5000,
            fetch: (url, init) => fetch(url, { ...init, redirect: "error" }),
          },
          store: atomicStore(
            db,
            `auction:${a.id}`,
            "nearintents_auction_store",
          ),
        }),
      ],
    }).charge({
      expires: new Date(a.contract.paymentBeforeMs).toISOString(),
      scope: `auction:${a.id}:${a.contract.contractHash}:${a.requestHash}`,
    });
  }
  async challenge(db, a) {
    const result = await this.handler(
      db,
      a,
    )(
      new Request("https://auction.invalid/v1/chat/completions", {
        method: "POST",
      }),
    );
    check(result.status === 402, "nearintents_quote_unavailable");
    const c = Challenge.deserialize(
        result.challenge.headers.get("www-authenticate"),
      ),
      q = c.request;
    check(
      c.method === "nearintents" &&
        q.externalId === a.id &&
        q.methodDetails.amountOut === a.contract.principalYocto &&
        uint(q.amount) <= uint(this.config.maximumAmountIn),
      "source_quote_above_authorization",
    );
    return c;
  }
  parse(a, serialized) {
    check(
      typeof serialized === "string" && serialized.length <= 16384,
      "original_payment_credential_required",
    );
    let c;
    try {
      c = Credential.deserialize(serialized);
    } catch {
      throw Error("original_payment_credential_required");
    }
    check(
      isDeepStrictEqual(c.challenge, a.challenge) &&
        c.payload?.type === "hash" &&
        typeof c.payload.hash === "string" &&
        c.payload.hash.length <= 256,
      "original_payment_conflict",
    );
    return c;
  }
  async validateEvidence(db, a, e) {
    const agent = (
      await db.query(
        "SELECT payer FROM mpp_direct_auction_agents WHERE id=$1",
        [a.agent_id],
      )
    ).rows[0];
    const q = a.challenge.request,
      d = q.methodDetails;
    check(
      e.method === "nearintents" &&
        e.orderRef === a.order_id &&
        e.challengeId === a.challenge.id &&
        e.amount === String(a.principal) &&
        e.payer === agent.payer &&
        e.recipient === this.config.merchant &&
        e.network === this.marketNetwork &&
        e.scope ===
          (this.config.mode === "controlled"
            ? "controlled-fixture"
            : NI_MODE) &&
        e.sourceAsset === q.currency &&
        e.sourceAmount === q.amount &&
        d.amountOut === String(a.principal) &&
        d.destinationAsset === "near:mainnet/nep141:wrap.near" &&
        d.destinationRecipient === e.recipient &&
        d.refundTo === e.payer &&
        e.gasActualYocto === "0" &&
        e.receipt?.method === "nearintents" &&
        e.receipt.challengeId === a.challenge.id &&
        e.receipt.externalId === a.id &&
        e.receipt.status === "success",
      "nearintents_payment_binding_mismatch",
    );
  }
}
