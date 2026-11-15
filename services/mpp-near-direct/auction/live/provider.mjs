import { hash, requireThat as check } from "../../contract.mjs";
import { settleUsage } from "../contracts.mjs";
import { inspectStream } from "../../../inference-comparison/near-bridge.mjs";
import {
  freezeNearTariff,
  usageCostMicro,
  MODEL,
} from "../../../inference-comparison/core.mjs";
import { LIVE_MODE } from "./policy.mjs";
import { bounded } from "./timeouts.mjs";

export class NearCloudProvider {
  scope = LIVE_MODE;
  constructor({ market, client, catalog, fault = () => {} }) {
    Object.assign(this, { market, client, catalog, fault });
    this.pool = market.pool;
    this.plan = market.config.livePlan;
  }
  async initialize() {
    await this.pool.query(
      `INSERT INTO mpp_direct_live_provider_budget(singleton,maximum_micro,maximum_calls) VALUES(true,$1,$2) ON CONFLICT DO NOTHING`,
      [this.plan.providerMaximumMicro, this.plan.maximumProviderCalls],
    );
    const b = (
      await this.pool.query("SELECT * FROM mpp_direct_live_provider_budget")
    ).rows[0];
    check(
      String(b.maximum_micro) === this.plan.providerMaximumMicro &&
        b.maximum_calls === this.plan.maximumProviderCalls,
      "provider_budget_changed",
    );
  }
  async preflight() {
    await bounded(this.client.verify(MODEL));
    const tariff = freezeNearTariff(await this.catalog());
    check(tariff.expiresAtMs > Date.now(), "provider_tariff_unavailable");
    for (const k of ["input", "cache_input", "output"])
      check(
        BigInt(tariff.rates[k]) <= BigInt(this.plan.service.rates[k]),
        "provider_price_above_reviewed_tariff",
      );
    return tariff;
  }
  async row(id) {
    return (
      await this.pool.query(
        "SELECT * FROM mpp_direct_live_provider_ops WHERE id=$1",
        [id],
      )
    ).rows[0];
  }
  async executeOriginal(permit) {
    const { executionId: id, body, contract } = permit,
      old = await this.row(id);
    if (old) {
      check(old.body_hash === hash(body), "original_invoke_conflict");
      return this.recoverOriginal(id);
    }
    let maximum, tariff;
    try {
      tariff = await this.preflight();
      check(
        MODEL === this.plan.service.model &&
          contract.serviceClassVersion ===
            this.plan.service.serviceClassVersion &&
          tariff.expiresAtMs > Date.now(),
        "provider_tariff_unavailable",
      );
      for (const k of ["input", "cache_input", "output"])
        check(
          BigInt(tariff.rates[k]) <= BigInt(this.plan.service.rates[k]),
          "provider_price_above_reviewed_tariff",
        );
      maximum = usageCostMicro(this.plan.service.rates, {
        prompt_tokens: this.plan.service.maxInputTokens,
        completion_tokens: this.plan.service.maxOutputTokens,
        prompt_tokens_details: {
          cached_tokens:
            BigInt(this.plan.service.rates.cache_input) >
            BigInt(this.plan.service.rates.input)
              ? this.plan.service.maxInputTokens
              : 0,
        },
      });
    } catch {
      // A competing dispatcher might already own this ID. Only an atomic insert
      // of a permanent never-sent tombstone can prove that no invoke can follow.
      await this.pool.query(
        `INSERT INTO mpp_direct_live_provider_ops(id,body_hash,maximum_micro,state,created_ms)
        VALUES($1,$2,0,'never_sent',$3) ON CONFLICT DO NOTHING`,
        [id, hash(body), Date.now()],
      );
      return this.recoverOriginal(id);
    }
    const db = await this.pool.connect();
    let send = false;
    try {
      await db.query("BEGIN");
      await db.query(
        "SELECT singleton FROM mpp_direct_auction_state WHERE singleton FOR UPDATE",
      );
      const a = (
        await db.query(
          "SELECT * FROM mpp_direct_auction_allocations WHERE execution_id=$1",
          [id],
        )
      ).rows[0];
      const at = Number(
        (
          await db.query(
            "SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS at",
          )
        ).rows[0].at,
      );
      const b = (
        await db.query(
          "SELECT * FROM mpp_direct_live_provider_budget WHERE singleton FOR UPDATE",
        )
      ).rows[0];
      const existing = (
        await db.query(
          "SELECT * FROM mpp_direct_live_provider_ops WHERE id=$1",
          [id],
        )
      ).rows[0];
      if (!existing) {
        const allowed =
          a?.execution === "executing" &&
          a.dispatch_claim === permit.claim &&
          String(a.generation) === permit.generation &&
          at < contract.admissionBeforeMs &&
          at < this.plan.deadlineMs &&
          (await this.market.grantPermits(db, a, at)) &&
          BigInt(b.spent_micro) + BigInt(b.reserved_micro) + BigInt(maximum) <=
            BigInt(b.maximum_micro) &&
          b.calls < b.maximum_calls;
        await db.query(
          `INSERT INTO mpp_direct_live_provider_ops(id,body_hash,maximum_micro,state,created_ms,tariff) VALUES($1,$2,$3,$4,$5,$6)`,
          [
            id,
            hash(body),
            allowed ? maximum : "0",
            allowed ? "sending" : "never_sent",
            at,
            tariff,
          ],
        );
        if (allowed) {
          await db.query(
            "UPDATE mpp_direct_live_provider_budget SET reserved_micro=reserved_micro+$1,calls=calls+1 WHERE singleton",
            [maximum],
          );
          send = true;
        }
      } else
        check(existing.body_hash === hash(body), "original_invoke_conflict");
      await db.query("COMMIT");
    } catch (e) {
      await db.query("ROLLBACK");
      throw e;
    } finally {
      db.release();
    }
    if (!send) return this.recoverOriginal(id);
    await this.fault("before_provider_post");
    // Exactly one paid POST per execution. Any lost response retains the full
    // project cost reserve and original execution liability, across restarts.
    const response = await this.client.fetch(
      "https://cloud-api.near.ai/v1/chat/completions",
      {
        method: "POST",
        body,
        headers: { "content-type": "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(90000),
      },
    );
    check(
      response.ok &&
        response.headers.get("content-type")?.startsWith("text/event-stream"),
      "provider_result_unknown",
    );
    const chunks = [];
    let size = 0;
    for await (const part of response.body) {
      size += part.length;
      check(size <= 1024 * 1024, "provider_result_limit_unknown");
      chunks.push(part);
    }
    const raw = Buffer.concat(chunks).toString("utf8"),
      summary = inspectStream(raw);
    await this.pool.query(
      `UPDATE mpp_direct_live_provider_ops SET state='captured',raw_response=$2,response_id=$3 WHERE id=$1 AND state='sending'`,
      [id, raw, summary.id],
    );
    await this.fault("after_provider_capture");
    return this.recoverOriginal(id);
  }
  async recoverOriginal(id) {
    let row = await this.row(id);
    if (!row) return null;
    if (row.state === "never_sent") return { failure: "provider_never_sent" };
    if (row.state === "verified") return this.result(row);
    if (row.state !== "captured") return null;
    // SDK 0.3 retains the attested request/response binding in memory. Recovery
    // can retry signature fetch in this process. After a crash before verified
    // persistence, it stays Unknown (never replay the paid model request).
    const verification = await bounded(
      this.client.verifyResponse(row.response_id),
    );
    check(
      verification.id === row.response_id &&
        verification.signatureKind === "provider_tee",
      "provider_tee_signature_required",
    );
    const summary = inspectStream(row.raw_response),
      actual = usageCostMicro(row.tariff.rates, summary.usage);
    const usage = {
      input: String(summary.usage.prompt_tokens),
      cached: String(summary.usage.prompt_tokens_details?.cached_tokens ?? 0),
      output: String(summary.usage.completion_tokens),
    };
    const db = await this.pool.connect();
    try {
      await db.query("BEGIN");
      row = (
        await db.query(
          "SELECT * FROM mpp_direct_live_provider_ops WHERE id=$1 FOR UPDATE",
          [id],
        )
      ).rows[0];
      if (row.state !== "verified") {
        await db.query(
          `UPDATE mpp_direct_live_provider_ops SET state='verified',verification=$2,usage=$3,actual_micro=$4 WHERE id=$1`,
          [
            id,
            { id: verification.id, signatureKind: verification.signatureKind },
            usage,
            actual,
          ],
        );
        await db.query(
          "UPDATE mpp_direct_live_provider_budget SET reserved_micro=reserved_micro-$1,spent_micro=spent_micro+$2 WHERE singleton",
          [row.maximum_micro, actual],
        );
      }
      await db.query("COMMIT");
    } catch (e) {
      await db.query("ROLLBACK");
      throw e;
    } finally {
      db.release();
    }
    return this.result(await this.row(id));
  }
  async result(row) {
    const a = (
      await this.pool.query(
        "SELECT contract FROM mpp_direct_auction_allocations WHERE execution_id=$1",
        [row.id],
      )
    ).rows[0];
    try {
      settleUsage(a.contract, row.usage);
    } catch {
      return { failure: "verified_contract_breach" };
    }
    return { result: { sse: row.raw_response }, usage: row.usage };
  }
}
