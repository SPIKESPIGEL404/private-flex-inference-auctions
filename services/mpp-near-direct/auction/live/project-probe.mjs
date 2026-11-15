import { hash, requireThat as check } from "../../contract.mjs";
import { inspectStream } from "../../../inference-comparison/near-bridge.mjs";
import { usageCostMicro, MODEL } from "../../../inference-comparison/core.mjs";
import { qualify } from "./admission.mjs";
import { bounded } from "./timeouts.mjs";

// This encrypted SQLite record is an effect outbox, not a cash ledger. All
// expense reservations/spend remain in the owning PG provider budget. New buyer
// dispatches are fenced until the probe is durably verified and costed there.
export class ProjectProbe {
  constructor({
    pool,
    store,
    plan,
    planHash,
    keyFingerprint,
    client,
    fault = () => {},
  }) {
    Object.assign(this, {
      pool,
      store,
      plan,
      planHash,
      keyFingerprint,
      client,
      fault,
    });
    this.id = hash(["cloud-key-probe-v1", planHash, keyFingerprint]);
    this.kind = "cloud-key-probe-v1";
  }
  get() {
    const r = this.store.get(this.kind, this.id, this.planHash);
    if (r) check(r.fingerprint === hash(r.frozen), "original_probe_corrupted");
    return r;
  }
  put(r) {
    this.store.put(this.kind, this.id, this.planHash, r);
  }
  async reserve(row) {
    const b = row.frozen.budget,
      amount = row.frozen.maximumMicro,
      db = await this.pool.connect();
    try {
      await db.query("BEGIN");
      const current = (
        await db.query(
          "SELECT * FROM mpp_direct_live_provider_budget WHERE singleton FOR UPDATE",
        )
      ).rows[0];
      if (
        current.calls === b.calls &&
        String(current.reserved_micro) === b.reserved &&
        String(current.spent_micro) === b.spent
      ) {
        check(
          current.calls < current.maximum_calls &&
            BigInt(b.reserved) + BigInt(b.spent) + BigInt(amount) <=
              BigInt(current.maximum_micro),
          "project_probe_budget_exhausted",
        );
        await db.query(
          "UPDATE mpp_direct_live_provider_budget SET calls=calls+1,reserved_micro=reserved_micro+$1 WHERE singleton",
          [amount],
        );
      } else
        check(
          current.calls === b.calls + 1 &&
            String(current.reserved_micro) ===
              String(BigInt(b.reserved) + BigInt(amount)) &&
            String(current.spent_micro) === b.spent,
          "original_probe_cost_conflict",
        );
      await db.query("COMMIT");
      await this.fault("after_probe_cost_commit");
    } catch (e) {
      await db.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      db.release();
    }
  }
  async settle(row) {
    const b = row.frozen.budget,
      amount = row.frozen.maximumMicro,
      actual = row.actualMicro,
      db = await this.pool.connect();
    try {
      await db.query("BEGIN");
      const current = (
        await db.query(
          "SELECT * FROM mpp_direct_live_provider_budget WHERE singleton FOR UPDATE",
        )
      ).rows[0];
      if (
        current.calls === b.calls + 1 &&
        String(current.reserved_micro) ===
          String(BigInt(b.reserved) + BigInt(amount)) &&
        String(current.spent_micro) === b.spent
      ) {
        await db.query(
          "UPDATE mpp_direct_live_provider_budget SET reserved_micro=reserved_micro-$1,spent_micro=spent_micro+$2 WHERE singleton",
          [amount, actual],
        );
      } else
        check(
          current.calls === b.calls + 1 &&
            String(current.reserved_micro) === b.reserved &&
            String(current.spent_micro) ===
              String(BigInt(b.spent) + BigInt(actual)),
          "original_probe_settlement_conflict",
        );
      await db.query("COMMIT");
      await this.fault("after_probe_settlement_commit");
    } catch (e) {
      await db.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      db.release();
    }
  }
  async ensure(tariff) {
    let row = this.get();
    if (!row) {
      check(Date.now() < this.plan.deadlineMs, "mainnet_run_closed");
      const body = JSON.stringify({
        model: MODEL,
        messages: [
          { role: "user", content: "Reply with the single character 4." },
        ],
        max_completion_tokens: Math.min(128, this.plan.service.maxOutputTokens),
        stream: true,
        stream_options: { include_usage: true },
        temperature: 0,
      });
      qualify(JSON.parse(body), body, this.plan.service);
      const b = (
        await this.pool.query(
          "SELECT * FROM mpp_direct_live_provider_budget WHERE singleton",
        )
      ).rows[0];
      const maximumMicro = usageCostMicro(this.plan.service.rates, {
        prompt_tokens: this.plan.service.maxInputTokens,
        completion_tokens: Math.min(128, this.plan.service.maxOutputTokens),
        prompt_tokens_details: {
          cached_tokens:
            BigInt(this.plan.service.rates.cache_input) >
            BigInt(this.plan.service.rates.input)
              ? this.plan.service.maxInputTokens
              : 0,
        },
      });
      const frozen = {
        body,
        tariff,
        maximumMicro,
        keyFingerprint: this.keyFingerprint,
        planHash: this.planHash,
        budget: {
          calls: b.calls,
          reserved: String(b.reserved_micro),
          spent: String(b.spent_micro),
        },
      };
      this.store.transaction(() => {
        if (!this.get())
          this.put({ state: "committing", frozen, fingerprint: hash(frozen) });
      });
      row = this.get();
    }
    if (row.state === "verified")
      return {
        verified: true,
        responseId: row.responseId,
        keyFingerprint: this.keyFingerprint,
        actualMicro: row.actualMicro,
      };
    if (
      ["unknown", "refused", "contract_breach", "sending"].includes(row.state)
    )
      return null;
    if (row.state === "committing") {
      check(
        Date.now() < this.plan.deadlineMs &&
          Date.now() < row.frozen.tariff.expiresAtMs,
        "project_probe_window_closed",
      );
      await this.reserve(row);
      const claimed = this.store.transaction(() => {
        const current = this.get();
        if (current.state !== "committing") return false;
        check(
          Date.now() < this.plan.deadlineMs &&
            Date.now() < current.frozen.tariff.expiresAtMs,
          "project_probe_window_closed",
        );
        this.put({ ...current, state: "sending" });
        return true;
      });
      if (!claimed) return null;
      try {
        await this.fault("before_probe_post");
        const response = await this.client.fetch(
          "https://cloud-api.near.ai/v1/chat/completions",
          {
            method: "POST",
            body: row.frozen.body,
            headers: { "content-type": "application/json" },
            redirect: "error",
            signal: AbortSignal.timeout(90000),
          },
        );
        if (!response.ok) {
          this.put({
            ...this.get(),
            state: "refused",
            status: response.status,
          });
          await response.body?.cancel();
          return null;
        }
        check(
          response.headers.get("content-type")?.startsWith("text/event-stream"),
          "project_probe_result_unknown",
        );
        const chunks = [];
        let size = 0;
        for await (const part of response.body) {
          size += part.length;
          check(size <= 1024 * 1024, "project_probe_response_limit");
          chunks.push(part);
        }
        const raw = Buffer.concat(chunks).toString("utf8"),
          summary = inspectStream(raw);
        this.put({
          ...this.get(),
          state: "captured",
          raw,
          responseId: summary.id,
        });
      } catch {
        this.put({ ...this.get(), state: "unknown" });
        return null;
      }
      row = this.get();
    }
    if (row.state === "captured") {
      const verification = await bounded(
        this.client.verifyResponse(row.responseId),
      );
      check(
        verification.id === row.responseId &&
          verification.signatureKind === "provider_tee",
        "project_probe_signature_required",
      );
      const summary = inspectStream(row.raw),
        usage = summary.usage,
        actualMicro = usageCostMicro(row.frozen.tariff.rates, usage);
      row = {
        ...row,
        state: "verified_response",
        actualMicro,
        usage,
        acceptable:
          usage.prompt_tokens <= this.plan.service.maxInputTokens &&
          usage.completion_tokens <=
            JSON.parse(row.frozen.body).max_completion_tokens,
      };
      this.put(row);
    }
    if (row.state === "verified_response") {
      await this.settle(row);
      this.put({
        ...row,
        state: row.acceptable ? "verified" : "contract_breach",
      });
    }
    row = this.get();
    return row.state === "verified"
      ? {
          verified: true,
          responseId: row.responseId,
          keyFingerprint: this.keyFingerprint,
          actualMicro: row.actualMicro,
        }
      : null;
  }
}
