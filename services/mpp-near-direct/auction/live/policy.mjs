import { hash, requireThat as check, uint, account } from "../../contract.mjs";
import { validateClass } from "../contracts.mjs";
export const LIVE_MODE = "bounded-mainnet-v1";
export function validateFx(fx, now = Date.now()) {
  check(
    fx &&
      fx.kind === "market-usd-near-v1" &&
      typeof fx.source === "string" &&
      fx.source.startsWith("https://") &&
      !new URL(fx.source).username &&
      !new URL(fx.source).password,
    "market_fx_source_required",
  );
  check(
    Number.isSafeInteger(fx.observedAtMs) &&
      Number.isSafeInteger(fx.expiresAtMs) &&
      fx.observedAtMs <= now &&
      now < fx.expiresAtMs &&
      fx.expiresAtMs - fx.observedAtMs <= 300000 &&
      uint(fx.nanoUsdPerNear) > 0n,
    "fresh_mainnet_fx_required",
  );
  return structuredClone(fx);
}
export function validateLivePlan(
  plan,
  { now = Date.now(), allowExpired = false } = {},
) {
  check(
    plan?.version === 1 &&
      plan.mode === LIVE_MODE &&
      plan.network === "mainnet" &&
      plan.walletProvider === "outlayer" &&
      plan.realBroadcastEnabled === true,
    "bounded_mainnet_plan_required",
  );
  const rpc = new URL(plan.rpcUrl);
  check(
    rpc.protocol === "https:" &&
      !rpc.username &&
      !rpc.password &&
      !rpc.hash &&
      !rpc.search,
    "reviewed_rpc_required",
  );
  const origin = new URL(plan.origin);
  check(
    origin.origin === plan.origin &&
      origin.protocol === "https:" &&
      !origin.username &&
      !origin.password,
    "mainnet_https_origin_required",
  );
  check(
    account.test(plan.merchant) && plan.realm === origin.hostname,
    "merchant_realm_binding_required",
  );
  check(
    Number.isSafeInteger(plan.deadlineMs) &&
      (allowExpired || plan.deadlineMs > now) &&
      plan.deadlineMs <= now + 86400000,
    "bounded_mainnet_deadline_required",
  );
  for (const k of [
    "ownerBudgetNano",
    "agentBudgetNano",
    "callCapMicro",
    "principalCapYocto",
    "gasReserveYocto",
    "gasFloorYocto",
    "merchantGasReserveYocto",
    "merchantMaximumYocto",
    "providerMaximumMicro",
    "storagePriceYocto",
    "fundingCapYocto",
  ])
    check(uint(plan[k]) > 0n, "positive_mainnet_limits_required");
  check(
    uint(plan.agentBudgetNano) <= uint(plan.ownerBudgetNano) &&
      uint(plan.callCapMicro) * 1000n <= uint(plan.agentBudgetNano),
    "mainnet_budget_hierarchy_invalid",
  );
  check(
    Number.isSafeInteger(plan.maximumProviderCalls) &&
      plan.maximumProviderCalls > 0 &&
      plan.maximumProviderCalls <= 32,
    "bounded_provider_calls_required",
  );
  check(
    Number.isSafeInteger(plan.maximumAgents) &&
      plan.maximumAgents > 0 &&
      plan.maximumAgents <= 8,
    "bounded_agent_count_required",
  );
  check(
    uint(plan.fundingCapYocto) <= 10n ** 23n &&
      uint(plan.merchantMaximumYocto) >=
        BigInt(plan.maximumProviderCalls) *
          (uint(plan.principalCapYocto) + uint(plan.merchantGasReserveYocto)),
    "mainnet_native_limits_inconsistent",
  );
  check(
    typeof plan.fxSource === "string" &&
      new URL(plan.fxSource).protocol === "https:" &&
      !new URL(plan.fxSource).username &&
      !new URL(plan.fxSource).password,
    "reviewed_fx_source_required",
  );
  for (const k of [
    "ownerBudgetNano",
    "agentBudgetNano",
    "callCapMicro",
    "providerMaximumMicro",
  ])
    check(uint(plan[k]) <= (1n << 63n) - 1n, "mainnet_limit_overflow");
  validateClass(plan.service);
  check(
    plan.service.capacityPoolId === "single-seller-1" &&
      plan.service.model !== "m/external" &&
      !/fixture/i.test(JSON.stringify(plan.service)),
    "live_service_identity_required",
  );
  check(
    !/"(?:apiKey|secret|privateKey|token|authorization)"\s*:/i.test(
      JSON.stringify(plan),
    ),
    "private_plan_field",
  );
  return { plan: structuredClone(plan), planHash: hash(plan) };
}
