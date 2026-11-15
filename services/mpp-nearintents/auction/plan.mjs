import { Types } from "@defuse-protocol/nearintents-mpp-sdk";
import { check, digest, uint, endpoint } from "../chat/config.mjs";
import { validateClass } from "../../mpp-near-direct/auction/contracts.mjs";
import { account } from "../../mpp-near-direct/contract.mjs";
export function auctionPlan(raw) {
  const c = structuredClone(raw);
  const fields = [
    "mode",
    "origin",
    "realm",
    "merchant",
    "originAsset",
    "tokenDecimals",
    "tokenSymbol",
    "gasSymbol",
    "sourceRpcUrl",
    "oneClickBaseUrl",
    "maximumAmountIn",
    "maximumTotalAmountIn",
    "maximumGasWei",
    "maximumTotalGasWei",
    "principalCapYocto",
    "ownerBudgetNano",
    "agentBudgetNano",
    "callCapMicro",
    "providerMaximumMicro",
    "maximumProviderCalls",
    "maximumAgents",
    "deadlineMs",
    "paymentWindowMs",
    "admissionWindowMs",
    "settlementTimeout",
    "pollInterval",
    "fxSource",
    "service",
    "gasReserveYocto",
  ];
  check(
    c && Object.keys(c).every((k) => fields.includes(k)),
    "unknown_public_auction_plan_field",
  );
  check(
    ["controlled", "live"].includes(c.mode),
    "explicit_nearintents_mode_required",
  );
  check(
    typeof c.origin === "string" &&
      endpoint(c.origin, c.mode === "controlled").pathname === "/",
    "exact_ui_origin_required",
  );
  check(new URL(c.origin).origin === c.origin, "exact_ui_origin_required");
  check(
    c.origin.startsWith(
      c.mode === "controlled" ? "http://127.0.0.1:" : "https://",
    ),
    "exact_ui_origin_required",
  );
  const asset = Types.parseCaip19(c.originAsset);
  check(
    asset.chain.namespace === "eip155" &&
      asset.assetNamespace === "erc20" &&
      Number(asset.chain.reference) === 42161 &&
      /^0x[a-fA-F0-9]{40}$/.test(
        Types.decodeAssetReference(asset.assetReference),
      ) &&
      c.tokenDecimals === 6,
    "reviewed_arbitrum_token_required",
  );
  if (c.mode === "live")
    check(
      Types.decodeAssetReference(asset.assetReference).toLowerCase() ===
        "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
      "reviewed_usdc_contract_required",
    );
  check(
    c.tokenSymbol === "USDC" && c.gasSymbol === "ETH",
    "explicit_source_units_required",
  );
  endpoint(c.sourceRpcUrl, c.mode === "controlled");
  c.oneClickBaseUrl ??= "https://1click.chaindefuser.com";
  const api = endpoint(c.oneClickBaseUrl, c.mode === "controlled");
  check(
    api.pathname === "/" &&
      (c.mode === "controlled" ||
        api.origin === "https://1click.chaindefuser.com"),
    "official_settlement_required",
  );
  c.oneClickBaseUrl = api.origin;
  check(
    typeof c.realm === "string" &&
      /^[a-zA-Z0-9_.:-]{1,128}$/.test(c.realm) &&
      typeof c.merchant === "string" &&
      account.test(c.merchant) &&
      (c.mode === "controlled" || c.realm === new URL(c.origin).hostname),
    "merchant_and_realm_required",
  );
  for (const name of [
    "maximumAmountIn",
    "maximumTotalAmountIn",
    "maximumGasWei",
    "maximumTotalGasWei",
    "principalCapYocto",
    "ownerBudgetNano",
    "agentBudgetNano",
    "callCapMicro",
    "providerMaximumMicro",
  ])
    check(uint(c[name]) > 0n, "bounded_" + name + "_required");
  for (const k of [
    "ownerBudgetNano",
    "agentBudgetNano",
    "callCapMicro",
    "providerMaximumMicro",
  ])
    check(uint(c[k]) < 1n << 63n, "auction_budget_overflow");
  check(
    uint(c.callCapMicro) <= 100000n &&
      uint(c.agentBudgetNano) <= uint(c.ownerBudgetNano) &&
      uint(c.callCapMicro) * 1000n <= uint(c.agentBudgetNano),
    "inconsistent_service_caps",
  );
  check(
    uint(c.maximumTotalAmountIn) >= uint(c.maximumAmountIn) &&
      uint(c.maximumTotalGasWei) >= uint(c.maximumGasWei),
    "inconsistent_source_caps",
  );
  check(
    Number.isSafeInteger(c.deadlineMs) &&
      c.deadlineMs <= Date.now() + 86400000 &&
      Number.isSafeInteger(c.maximumProviderCalls) &&
      c.maximumProviderCalls > 0 &&
      c.maximumProviderCalls <= 1000 &&
      Number.isSafeInteger(c.maximumAgents) &&
      c.maximumAgents > 0 &&
      c.maximumAgents <= 32,
    "bounded_run_required",
  );
  check(
    Number.isSafeInteger(c.paymentWindowMs) &&
      c.paymentWindowMs >= 5000 &&
      c.paymentWindowMs <= 600000 &&
      c.paymentWindowMs % 1000 === 0 &&
      Number.isSafeInteger(c.admissionWindowMs) &&
      c.admissionWindowMs >= c.paymentWindowMs &&
      c.admissionWindowMs <= 900000,
    "invalid_auction_payment_windows",
  );
  check(
    Number.isSafeInteger(c.settlementTimeout) &&
      c.settlementTimeout > 0 &&
      c.settlementTimeout <= 120 &&
      Number.isSafeInteger(c.pollInterval) &&
      c.pollInterval > 0 &&
      c.pollInterval <= 10000,
    "invalid_settlement_timeouts",
  );
  validateClass(c.service);
  check(
    c.service.capacityPoolId === "single-seller-1",
    "one_exclusive_pool_required",
  );
  c.gasReserveYocto = "0";
  return { plan: c, planHash: digest(c) };
}
