import { check, digest, validateComparison, usageCostMicro } from "./core.mjs";
import { projectSettlement } from "./settlement.mjs";
import { Store } from "../../clients/buyer-gateway/src/store.mjs";
import { marketExecutor } from "./market-executor.mjs";
// This journal records experiment observations; Market remains the only money authority.
export class ComparisonRunner {
  constructor(
    config,
    { store, executor = marketExecutor, now = Date.now } = {},
  ) {
    this.config = config;
    this.store =
      store ??
      new Store(config.storePath, Buffer.from(config.storageKey, "hex"));
    this.executor = executor;
    this.now = now;
  }
  async run(input, expectedPlanHash) {
    check(input.planHash === expectedPlanHash, "reviewed_plan_hash_required");
    const plan = validateComparison(input, this.now());
    const results = {};
    for (const armId of plan.executionOrder)
      results[armId] = await this.runArm(plan, armId);
    return {
      version: 1,
      planHash: plan.planHash,
      requestHash: plan.requestHash,
      mode: plan.mode,
      realAgentPayments: false,
      arms: results,
    };
  }
  async runArm(plan, armId) {
    const arm = plan.arms[armId],
      id = digest([plan.ownerAccount, plan.planHash, armId]),
      old = this.store.get("comparison-arm", id, plan.ownerAccount);
    if (old)
      return old.state === "complete" ? old : { ...old, replayBlocked: true };
    const body = {
      ...plan.request,
      model: arm.model,
      user: "cmp-" + id,
      stream: true,
      stream_options: { include_usage: true },
      bitrouter_purchase: {
        service_type: "on_demand",
        provider_cap_micro_usd: Number(plan.budgetPerArmMicro),
        total_cap_micro_usd: Number(plan.budgetPerArmMicro),
        max_attempts: 1,
      },
      bitrouter_delivery: { auto_fallback: "off" },
    };
    if (this.now() >= plan.deadlineMs)
      return {
        armId,
        state: "not_dispatched_deadline",
        paidInvokeAttempted: false,
      };
    let executor;
    try {
      executor = await this.executor(this.config.arms[armId], {
        arm,
        deadlineMs: plan.deadlineMs,
      });
    } catch {
      return {
        armId,
        state: "verification_failed",
        paidInvokeAttempted: false,
      };
    }
    try {
      if (this.now() >= plan.deadlineMs)
        return {
          armId,
          state: "not_dispatched_deadline",
          paidInvokeAttempted: false,
        };
      if (armId === "B") {
        let readiness;
        try {
          readiness = await executor.supply();
        } catch {
          return { armId, state: "supply_unknown", paidInvokeAttempted: false };
        }
        if (readiness.state !== "ready" || readiness.expiresAtMs <= this.now())
          return {
            armId,
            state: "supply_" + readiness.state,
            readiness,
            paidInvokeAttempted: false,
          };
      }
      // Atomic claim survives both process restart and a concurrent second runner.
      const record = {
        id,
        armId,
        planHash: plan.planHash,
        priceVersion: arm.tariff.priceVersion,
        requestHash: plan.requestHash,
        plainMarketRequestHash: digest(body),
        idempotencyKey: "cmp-" + id,
        state: "dispatching",
        startedAtMs: this.now(),
        identity: executor.identity,
      };
      const claimed = this.store.transaction(() => {
        if (this.store.get("comparison-arm", id, plan.ownerAccount))
          return false;
        this.store.put("comparison-arm", id, plan.ownerAccount, record);
        return true;
      });
      if (!claimed)
        return {
          ...this.store.get("comparison-arm", id, plan.ownerAccount),
          state: "unknown",
          replayBlocked: true,
        };
      try {
        const response = await executor.dispatch({
          body,
          idempotencyKey: record.idempotencyKey,
          signal: AbortSignal.timeout(
            Math.max(1, plan.deadlineMs - this.now()),
          ),
        });
        record.marketRequestId = response.headers.get("x-bitrouter-request-id");
        record.httpStatus = response.status;
        this.store.put("comparison-arm", id, plan.ownerAccount, record);
        if (response.status !== 200) {
          await response.body?.cancel();
          const refused = {
            ...record,
            state: response.status === 202 ? "pending" : "unknown",
            endedAtMs: this.now(),
            serviceCostMicro: null,
          };
          this.store.put("comparison-arm", id, plan.ownerAccount, refused);
          return refused;
        }
        check(
          response.headers.get("content-type")?.startsWith("text/event-stream"),
          "native_stream_required",
        );
        let n = 0,
          firstByteAtMs = null,
          firstTokenAtMs = null,
          pending = "",
          done = false,
          responseId,
          usage,
          finishCount = 0;
        const chunks = [],
          decoder = new TextDecoder("utf-8", { fatal: true });
        for await (const chunk of response.body) {
          firstByteAtMs ??= this.now();
          n += chunk.length;
          check(n <= 1024 * 1024, "native_response_too_large");
          chunks.push(chunk);
          pending += decoder.decode(chunk, { stream: true });
          const lines = pending.split("\n");
          pending = lines.pop();
          for (const line of lines) {
            if (!line.startsWith("data:")) continue;
            check(!done, "data_after_done");
            const raw = line.slice(5).trim();
            if (raw === "[DONE]") {
              done = true;
              continue;
            }
            const frame = JSON.parse(raw);
            check(
              frame.model === arm.model &&
                typeof frame.id === "string" &&
                (!responseId || frame.id === responseId),
              "unexpected_response_identity",
            );
            responseId = frame.id;
            if (frame.usage) {
              check(!usage, "multiple_final_usage");
              usage = frame.usage;
            }
            for (const choice of frame.choices ?? []) {
              if (choice.delta?.content) firstTokenAtMs ??= this.now();
              if (choice.finish_reason) finishCount++;
            }
          }
        }
        check(
          !decoder.decode() &&
            !pending.trim() &&
            done &&
            usage &&
            firstTokenAtMs !== null &&
            finishCount === 1 &&
            Number.isSafeInteger(usage.prompt_tokens) &&
            Number.isSafeInteger(usage.completion_tokens) &&
            usage.prompt_tokens >= 0 &&
            usage.completion_tokens >= 0 &&
            usage.completion_tokens <= plan.request.max_completion_tokens &&
            usage.total_tokens ===
              usage.prompt_tokens + usage.completion_tokens,
          "invalid_native_terminal",
        );
        let marketHead = null;
        if (record.marketRequestId)
          try {
            marketHead = await executor.head(record.marketRequestId);
          } catch {}
        let signedReceipt = null;
        if (record.marketRequestId && executor.receipt)
          try {
            signedReceipt = await executor.receipt(
              record.marketRequestId,
              record.idempotencyKey,
            );
          } catch {}
        let settlement = null,
          settlementState = "pending";
        if (signedReceipt)
          try {
            settlement = projectSettlement(signedReceipt, {
              requestId: record.marketRequestId,
              idempotencyKey: record.idempotencyKey,
              budgetMicro: plan.budgetPerArmMicro,
            });
            settlementState = "committed";
          } catch {
            settlementState = "invalid";
          }
        const result = {
          ...record,
          state: "complete",
          endedAtMs: this.now(),
          firstByteAtMs,
          firstTokenAtMs,
          responseId,
          usage,
          cacheObservation:
            usage.prompt_tokens_details?.cached_tokens === undefined
              ? "not_reported"
              : "provider_reported",
          tariffEstimateMicro: usageCostMicro(arm.tariff.rates, usage),
          serviceCostMicro: settlement?.providerChargeMicro ?? null,
          settlement,
          settlementState,
          marketHead,
          signedReceipt,
          settlementIdentity: signedReceipt ? executor.identity : null,
          responseSha256: digest(Buffer.concat(chunks)),
          response: Buffer.concat(chunks).toString("base64"),
        };
        this.store.put("comparison-arm", id, plan.ownerAccount, result);
        return result;
      } catch {
        const unknown = {
          ...record,
          state: "unknown",
          endedAtMs: this.now(),
          serviceCostMicro: null,
          replayBlocked: true,
        };
        this.store.put("comparison-arm", id, plan.ownerAccount, unknown);
        return unknown;
      }
    } finally {
      await executor.close().catch(() => {});
    }
  }
  async reconcile(plan) {
    const { planHash, ...body } = plan;
    check(digest(body) === planHash, "comparison_plan_changed");
    const results = {};
    for (const armId of plan.executionOrder) {
      const id = digest([plan.ownerAccount, planHash, armId]),
        record = this.store.get("comparison-arm", id, plan.ownerAccount);
      if (!record) {
        results[armId] = {
          armId,
          state: "not_dispatched",
          paidInvokeAttempted: false,
        };
        continue;
      }
      if (!record.marketRequestId || record.settlement) {
        results[armId] = record;
        continue;
      }
      let executor;
      try {
        executor = await this.executor(this.config.arms[armId], {
          arm: plan.arms[armId],
          deadlineMs: plan.deadlineMs,
        });
        const signedReceipt = await executor.receipt(
          record.marketRequestId,
          record.idempotencyKey,
        );
        const settlement = projectSettlement(signedReceipt, {
          requestId: record.marketRequestId,
          idempotencyKey: record.idempotencyKey,
          budgetMicro: plan.budgetPerArmMicro,
        });
        const next = {
          ...record,
          signedReceipt,
          settlementIdentity: executor.identity,
          settlement,
          settlementState: "committed",
          serviceCostMicro: settlement.providerChargeMicro,
          settlementCheckedAtMs: this.now(),
        };
        this.store.put("comparison-arm", id, plan.ownerAccount, next);
        results[armId] = next;
      } catch {
        results[armId] = { ...record, settlementState: "pending" };
      } finally {
        if (executor) await executor.close().catch(() => {});
      }
    }
    return {
      version: 1,
      planHash,
      requestHash: plan.requestHash,
      mode: plan.mode,
      realAgentPayments: false,
      arms: results,
    };
  }
  close() {
    this.store.close();
  }
}

// Public reports contain measurements and explicit missing evidence, never native content/keys.
export function publicReport(report) {
  return {
    version: report.version,
    planHash: report.planHash,
    requestHash: report.requestHash,
    mode: report.mode,
    realAgentPayments: false,
    dynamicPricingEnabled: false,
    taskSuccess: null,
    arms: Object.fromEntries(
      Object.entries(report.arms).map(([key, r]) => [
        key,
        {
          armId: r.armId,
          marketHardwareVerified: r.identity?.marketVerified === true,
          upstreamEvidenceVerified: r.identity?.upstreamVerified ?? null,
          state: r.state,
          paidInvokeAttempted: r.paidInvokeAttempted ?? Boolean(r.startedAtMs),
          marketRequestId: r.marketRequestId ?? null,
          httpStatus: r.httpStatus ?? null,
          priceVersion: r.priceVersion ?? null,
          usage: r.usage ?? null,
          cacheObservation: r.cacheObservation ?? null,
          buyerFirstTokenMs:
            r.firstTokenAtMs == null ? null : r.firstTokenAtMs - r.startedAtMs,
          buyerCompletionMs:
            r.state === "complete" ? r.endedAtMs - r.startedAtMs : null,
          latencyScope:
            "buyer-observed-includes-market-and-provider-verification",
          tariffEstimateMicro: r.tariffEstimateMicro ?? null,
          serviceCostMicro: r.serviceCostMicro ?? null,
          settlement: r.settlement ?? null,
          settlementState: r.settlementState ?? "pending",
          accountingScope: "market-USD-credit-ledger",
          nativeChainPaymentVerified: false,
          readiness: r.readiness ?? null,
          providerBillMicro: null,
          settlementEvidenceAvailable: Boolean(r.marketHead),
          signedFinancialReceiptVerified: Boolean(r.signedReceipt),
          settlementHardwareVerified:
            r.settlementIdentity?.marketVerified === true,
          replayBlocked:
            r.replayBlocked ??
            ["pending", "dispatching", "unknown"].includes(r.state),
          responseSha256: r.responseSha256 ?? null,
          taskSuccess: null,
        },
      ]),
    ),
  };
}
