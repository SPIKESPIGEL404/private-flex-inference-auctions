import { check, digest, validateComparison, usageCostMicro } from "./core.mjs";
import { Store } from "../../clients/buyer-gateway/src/store.mjs";
import { marketExecutor } from "./market-executor.mjs";
// This journal records experiment observations; Market remains the only money authority.
export class ComparisonRunner {
  constructor(
    config,
    {
      store,
      executor = marketExecutor,
      now = Date.now,
      monotonic = () => performance.now(),
    } = {},
  ) {
    this.config = config;
    this.store =
      store ??
      new Store(config.storePath, Buffer.from(config.storageKey, "hex"));
    this.executor = executor;
    this.now = now;
    this.monotonic = monotonic;
  }
  async run(input, expectedPlanHash) {
    check(input.planHash === expectedPlanHash, "reviewed_plan_hash_required");
    const plan = validateComparison(input, this.now());
    // Save the assigned denominator before any connection or paid action.
    if (!this.store.get("comparison-plan", plan.planHash, plan.ownerAccount))
      this.store.put("comparison-plan", plan.planHash, plan.ownerAccount, plan);
    const assigned = plan.executionOrder.filter(
      (armId) =>
        !this.store.get(
          "comparison-arm",
          digest([plan.ownerAccount, plan.planHash, armId]),
          plan.ownerAccount,
        ),
    );
    check(
      this.now() + assigned.length * plan.taskDurationMs <= plan.deadlineMs,
      "insufficient_authorization_window",
    );
    const results = {};
    for (const armId of plan.executionOrder)
      results[armId] = await this.runArm(plan, armId);
    // Financial lookup cannot consume the other arm's execution budget.
    for (const armId of plan.executionOrder)
      results[armId] = await this.enrich(plan, results[armId]);
    return {
      version: 2,
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
      return old.state === "dispatching"
        ? {
            ...old,
            state: "unknown",
            responseState: "unknown",
            replayBlocked: true,
          }
        : old;
    const startedAtMs = this.now(),
      startedMono = this.monotonic();
    const deadlineMs = startedAtMs + plan.taskDurationMs;
    const record = {
      id,
      armId,
      planHash: plan.planHash,
      priceVersion: arm.tariff.priceVersion,
      requestHash: plan.requestHash,
      idempotencyKey: "cmp-" + id,
      state: "dispatching",
      responseState: "dispatching",
      paymentState: "unknown",
      settlementState: "unknown",
      taskOutcome: "not_evaluated",
      startedAtMs,
      deadlineMs,
      paidInvokeAttempted: false,
    };
    const claimed = this.store.transaction(() => {
      if (this.store.get("comparison-arm", id, plan.ownerAccount)) return false;
      this.store.put("comparison-arm", id, plan.ownerAccount, record);
      return true;
    });
    if (!claimed)
      return {
        ...this.store.get("comparison-arm", id, plan.ownerAccount),
        replayBlocked: true,
      };
    const save = (value) => {
      this.store.put("comparison-arm", id, plan.ownerAccount, value);
      return value;
    };
    const stop = (state, reason) =>
      save({
        ...record,
        state,
        responseState: state,
        reason,
        endedAtMs: this.now(),
        elapsedMs: this.monotonic() - startedMono,
      });
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
    record.plainMarketRequestHash = digest(body);
    if (deadlineMs > plan.deadlineMs)
      return stop(
        "not_dispatched_deadline",
        "insufficient_authorization_window",
      );
    let executor;
    try {
      executor = await this.executor(this.config.arms[armId], {
        arm,
        deadlineMs,
      });
      record.identity = executor.identity;
      record.verifiedAtMs = this.now();
    } catch {
      return stop("verification_failed", "connection_verification_failed");
    }
    try {
      if (this.now() >= deadlineMs)
        return stop(
          "not_dispatched_deadline",
          "verification_exceeded_task_budget",
        );
      record.paidInvokeAttempted = true;
      record.dispatchedAtMs = this.now();
      save(record);
      try {
        const response = await executor.dispatch({
          body,
          idempotencyKey: record.idempotencyKey,
          signal: AbortSignal.timeout(Math.max(1, deadlineMs - this.now())),
        });
        record.marketRequestId = response.headers.get("x-bitrouter-request-id");
        record.httpStatus = response.status;
        this.store.put("comparison-arm", id, plan.ownerAccount, record);
        if (response.status !== 200) {
          await response.body?.cancel();
          const refused = {
            ...record,
            state: response.status === 202 ? "pending" : "unknown",
            responseState: response.status === 202 ? "pending" : "unknown",
            reason: "http_" + response.status,
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
          firstContentMs = null,
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
              if (choice.delta?.content) {
                firstTokenAtMs ??= this.now();
                firstContentMs ??= this.monotonic() - startedMono;
              }
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
        const result = {
          ...record,
          state: "complete",
          responseState: "available",
          usableResultAtMs: this.now(),
          completionMs: this.monotonic() - startedMono,
          firstContentMs,
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
          serviceCostMicro: null,
          marketHead: null,
          signedReceipt: null,
          responseSha256: digest(Buffer.concat(chunks)),
          response: Buffer.concat(chunks).toString("base64"),
        };
        this.store.put("comparison-arm", id, plan.ownerAccount, result);
        return result;
      } catch {
        const unknown = {
          ...record,
          state: "unknown",
          responseState: "unknown",
          reason: "dispatch_or_terminal_validation_unknown",
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
  // This path never dispatches. Expired experiment authorization can still be reconciled.
  async enrich(plan, record) {
    if (!record.marketRequestId) return record;
    let executor;
    let value = { ...record };
    try {
      executor = await this.executor(this.config.arms[record.armId], {
        arm: plan.arms[record.armId],
        deadlineMs: plan.deadlineMs,
        readOnly: true,
      });
      try {
        value.marketHead = await executor.head(record.marketRequestId);
      } catch {
        value.financialLookupError = "head_unavailable";
      }
      if (executor.receipt) {
        try {
          value.signedReceipt = await executor.receipt(
            record.marketRequestId,
            record.idempotencyKey,
          );
        } catch {
          value.financialLookupError = "receipt_unavailable";
        }
      }
      value.financialObservedAtMs = this.now();
      // A verified signature/head is evidence, not proof of final settlement.
      value.settlementState = "unknown";
    } catch {
      value.financialLookupError = "connection_unavailable";
    } finally {
      await executor?.close().catch(() => {});
    }
    this.store.put("comparison-arm", value.id, plan.ownerAccount, value);
    return value;
  }
  async recover(input, expectedPlanHash) {
    const { planHash, ...body } = input;
    check(
      planHash === expectedPlanHash && digest(body) === planHash,
      "reviewed_plan_hash_required",
    );
    const results = {};
    for (const armId of input.executionOrder) {
      const id = digest([input.ownerAccount, planHash, armId]);
      const saved = this.store.get("comparison-arm", id, input.ownerAccount);
      results[armId] = saved
        ? await this.enrich(
            input,
            saved.state === "dispatching"
              ? {
                  ...saved,
                  state: "unknown",
                  responseState: "unknown",
                  replayBlocked: true,
                }
              : saved,
          )
        : { armId, state: "not_started", paidInvokeAttempted: false };
    }
    return {
      version: 2,
      planHash,
      requestHash: input.requestHash,
      mode: input.mode,
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
          responseState: r.responseState ?? r.state,
          paymentState: r.paymentState ?? "unknown",
          settlementState: r.settlementState ?? "unknown",
          taskOutcome: r.taskOutcome ?? "not_evaluated",
          reason: r.reason ?? null,
          financialLookupError: r.financialLookupError ?? null,
          startedAtMs: r.startedAtMs ?? null,
          deadlineMs: r.deadlineMs ?? null,
          usableResultAtMs: r.usableResultAtMs ?? null,
          paidInvokeAttempted: r.paidInvokeAttempted ?? Boolean(r.startedAtMs),
          marketRequestId: r.marketRequestId ?? null,
          httpStatus: r.httpStatus ?? null,
          priceVersion: r.priceVersion ?? null,
          usage: r.usage ?? null,
          cacheObservation: r.cacheObservation ?? null,
          buyerFirstTokenMs: r.firstContentMs ?? null,
          buyerCompletionMs: r.completionMs ?? null,
          latencyScope:
            "buyer-observed-includes-market-and-provider-verification",
          tariffEstimateMicro: r.tariffEstimateMicro ?? null,
          serviceCostMicro: r.serviceCostMicro ?? null,
          providerBillMicro: null,
          settlementEvidenceAvailable: Boolean(r.marketHead),
          signedFinancialReceiptVerified: Boolean(r.signedReceipt),
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
