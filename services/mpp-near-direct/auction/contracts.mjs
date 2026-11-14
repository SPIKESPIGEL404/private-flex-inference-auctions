import { hash, requireThat as check, uint } from "../contract.mjs";
export const SCALE = 1000000n,
  YOCTO = 10n ** 24n,
  MAX_ACCOUNT = (1n << 63n) - 1n,
  MAX_INTERMEDIATE = (1n << 256n) - 1n;
const bounded = (n) => {
  check(n >= 0n && n <= MAX_INTERMEDIATE, "pricing_overflow");
  return n;
};
const mul = (a, b) => bounded(a * b);
export const ceil = (n, d) => {
  check(d > 0n, "invalid_divisor");
  return (bounded(n) + d - 1n) / d;
};
const money = (x) => {
  const n = uint(x);
  check(n <= MAX_ACCOUNT, "account_amount_overflow");
  return n;
};
export function freezeClass(input) {
  check(
    input &&
      [
        "model",
        "checkpoint",
        "quantization",
        "tokenizer",
        "template",
        "engine",
        "capacityPoolId",
      ].every(
        (k) =>
          typeof input[k] === "string" &&
          input[k].length > 0 &&
          input[k].length <= 256,
      ),
    "invalid_service_identity",
  );
  check(
    Number.isSafeInteger(input.minInputTokens) &&
      Number.isSafeInteger(input.maxInputTokens) &&
      input.minInputTokens >= 0 &&
      input.maxInputTokens >= input.minInputTokens &&
      input.maxInputTokens <= 32000 &&
      Number.isSafeInteger(input.maxOutputTokens) &&
      input.maxOutputTokens > 0 &&
      input.maxOutputTokens <= 512,
    "invalid_token_class",
  );
  for (const k of ["input", "cache_input", "output"]) money(input.rates[k]);
  check(
    input.fee?.version === "flat-plus-bps-v1" && uint(input.fee.bps) <= 10000n,
    "unsupported_fee_version",
  );
  money(input.fee.flatMicro);
  check(
    input.delivery === "verified-complete-response-v1" &&
      input.features === "text-and-bash-v1",
    "unsupported_delivery_class",
  );
  const body = {
    version: 1,
    ...Object.fromEntries(
      [
        "model",
        "checkpoint",
        "quantization",
        "tokenizer",
        "template",
        "engine",
        "capacityPoolId",
        "minInputTokens",
        "maxInputTokens",
        "maxOutputTokens",
        "rates",
        "fee",
        "delivery",
        "features",
      ].map((k) => [k, structuredClone(input[k])]),
    ),
    reserveMultiplier: String(SCALE),
  };
  return { ...body, serviceClassVersion: hash(body) };
}
export function validateClass(service) {
  const { serviceClassVersion, ...body } = service;
  check(hash(body) === serviceClassVersion, "service_class_changed");
  check(
    freezeClass(body).serviceClassVersion === serviceClassVersion,
    "unsupported_service_class",
  );
  return service;
}
const total = (rates, usage, fee) => {
  const input = uint(usage.input),
    cached = uint(usage.cached),
    output = uint(usage.output);
  check(cached <= input, "invalid_cached_usage");
  const serviceMicro = ceil(
    bounded(
      mul(input - cached, uint(rates.input)) +
        mul(cached, uint(rates.cache_input)) +
        mul(output, uint(rates.output)),
    ),
    SCALE,
  );
  const platformMicro =
    money(fee.flatMicro) + ceil(mul(serviceMicro, uint(fee.bps)), 10000n);
  const totalMicro = serviceMicro + platformMicro;
  check(
    totalMicro > 0n && totalMicro <= MAX_ACCOUNT / 1000n,
    "service_amount_overflow",
  );
  return {
    serviceMicro: String(serviceMicro),
    platformMicro: String(platformMicro),
    totalMicro: String(totalMicro),
  };
};
export function pricingContract({
  service,
  bidMultiplier,
  fx,
  gasCapYocto,
  nowMs,
  paymentWindowMs,
  admissionWindowMs,
}) {
  validateClass(service);
  const multiplier = uint(bidMultiplier);
  check(
    multiplier >= SCALE && multiplier <= 100n * SCALE,
    "bid_below_reserve_or_above_limit",
  );
  check(
    fx &&
      typeof fx.source === "string" &&
      fx.source.length > 0 &&
      Number.isSafeInteger(fx.observedAtMs) &&
      fx.observedAtMs <= nowMs &&
      Number.isSafeInteger(fx.expiresAtMs) &&
      fx.expiresAtMs > nowMs &&
      uint(fx.nanoUsdPerNear) > 0n,
    "invalid_or_stale_fx",
  );
  check(
    Number.isSafeInteger(nowMs) &&
      Number.isSafeInteger(paymentWindowMs) &&
      paymentWindowMs > 0 &&
      paymentWindowMs <= 120000 &&
      Number.isSafeInteger(admissionWindowMs) &&
      admissionWindowMs >= paymentWindowMs &&
      admissionWindowMs <= 180000,
    "invalid_contract_window",
  );
  const rates = Object.fromEntries(
    ["input", "cache_input", "output"].map((k) => {
      const rate = ceil(mul(uint(service.rates[k]), multiplier), SCALE);
      check(rate <= MAX_ACCOUNT, "rate_overflow");
      return [k, String(rate)];
    }),
  );
  const maxUsage = {
    input: String(service.maxInputTokens),
    cached:
      BigInt(rates.cache_input) > BigInt(rates.input)
        ? String(service.maxInputTokens)
        : "0",
    output: String(service.maxOutputTokens),
  };
  const maximum = total(rates, maxUsage, service.fee),
    principal = ceil(
      mul(mul(BigInt(maximum.totalMicro), 1000n), YOCTO),
      uint(fx.nanoUsdPerNear),
    );
  check(principal <= (1n << 128n) - 1n, "principal_overflow");
  const reserveNano = ceil(
    mul(principal + uint(gasCapYocto), uint(fx.nanoUsdPerNear)),
    YOCTO,
  );
  check(reserveNano <= MAX_ACCOUNT, "liability_overflow");
  const body = {
    version: 1,
    serviceClassVersion: service.serviceClassVersion,
    capacityPoolId: service.capacityPoolId,
    rates,
    fee: service.fee,
    bidMultiplier,
    reserveMultiplier: service.reserveMultiplier,
    rounding: "ceil-rates-sum-fee-fx-v1",
    fx: structuredClone(fx),
    inputBounds: [service.minInputTokens, service.maxInputTokens],
    maxOutputTokens: service.maxOutputTokens,
    maximum,
    principalYocto: String(principal),
    gasCapYocto,
    reserveNano: String(reserveNano),
    paymentBeforeMs: nowMs + paymentWindowMs,
    admissionBeforeMs: nowMs + admissionWindowMs,
  };
  return { ...body, contractHash: hash(body) };
}
export function settleUsage(contract, usage) {
  const { contractHash, ...body } = contract;
  check(hash(body) === contractHash, "pricing_contract_changed");
  const input = uint(usage.input),
    cached = uint(usage.cached),
    output = uint(usage.output);
  check(
    input >= BigInt(contract.inputBounds[0]) &&
      input <= BigInt(contract.inputBounds[1]) &&
      output <= BigInt(contract.maxOutputTokens) &&
      cached <= input,
    "usage_outside_contract",
  );
  const charge = total(contract.rates, usage, contract.fee);
  const actual = ceil(
    mul(mul(BigInt(charge.totalMicro), 1000n), YOCTO),
    uint(contract.fx.nanoUsdPerNear),
  );
  check(actual <= uint(contract.principalYocto), "usage_exceeds_prepayment");
  return {
    ...charge,
    actualPrincipalYocto: String(actual),
    refundYocto: String(uint(contract.principalYocto) - actual),
  };
}

// Independent replay evaluator. The owning Market transaction selects candidates,
// binds authenticated principals and atomically installs these reservations.
export function clearRound({
  bids,
  cutoffMs,
  clearedAtMs = cutoffMs,
  capacity,
  balances,
  service,
  fx,
  paymentWindowMs,
  admissionWindowMs,
  rule = "first-price-v1",
}) {
  validateClass(service);
  check(["first-price-v1", "fifo-v1"].includes(rule), "unsupported_round_rule");
  check(Number.isSafeInteger(capacity) && capacity >= 0, "invalid_capacity");
  const available = Object.fromEntries(
    Object.entries(balances).map(([k, v]) => [k, uint(v)]),
  );
  const candidates = [...bids].sort((a, b) => {
    const x =
      rule === "fifo-v1" ? 0n : uint(b.bidMultiplier) - uint(a.bidMultiplier);
    return x < 0n
      ? -1
      : x > 0n
        ? 1
        : BigInt(a.acceptedSequence) < BigInt(b.acceptedSequence)
          ? -1
          : BigInt(a.acceptedSequence) > BigInt(b.acceptedSequence)
            ? 1
            : a.id.localeCompare(b.id, "en");
  });
  const results = [];
  for (const bid of candidates) {
    let reason = null,
      contract;
    if (bid.state !== "active") reason = "inactive";
    else if (bid.acceptedAtMs >= cutoffMs) reason = "after_cutoff";
    else if (bid.expiryMs <= clearedAtMs) reason = "expired";
    else if (bid.serviceClassVersion !== service.serviceClassVersion)
      reason = "service_mismatch";
    else if (!bid.authorized) reason = "authorization_inactive";
    else
      try {
        contract = pricingContract({
          service,
          bidMultiplier: rule === "fifo-v1" ? String(SCALE) : bid.bidMultiplier,
          fx,
          gasCapYocto: bid.gasCapYocto,
          nowMs: clearedAtMs,
          paymentWindowMs,
          admissionWindowMs,
        });
        if (BigInt(contract.maximum.totalMicro) > money(bid.maxTotalMicro))
          reason = "call_cap_exceeded";
        else if (bid.deadlineMs < contract.admissionBeforeMs)
          reason = "authorization_window";
        else if (
          !Array.isArray(bid.budgetKeys) ||
          !bid.budgetKeys.length ||
          new Set(bid.budgetKeys).size !== bid.budgetKeys.length
        )
          reason = "invalid_budget_bindings";
        else if (
          bid.budgetKeys.some(
            (k) =>
              available[k] === undefined ||
              available[k] < BigInt(contract.reserveNano),
          )
        )
          reason = "shared_budget_insufficient";
        else if (
          available[bid.walletKey] === undefined ||
          available[bid.walletKey] <
            BigInt(contract.principalYocto) + BigInt(contract.gasCapYocto)
        )
          reason = "native_balance_insufficient";
      } catch (e) {
        reason = e.message;
      }
    if (reason) {
      results.push({
        id: bid.id,
        revision: bid.revision,
        outcome: "ineligible",
        reason,
      });
      continue;
    }
    if (capacity === 0) {
      results.push({
        id: bid.id,
        revision: bid.revision,
        outcome: "lost",
        reason: "capacity_unavailable",
      });
      continue;
    }
    capacity--;
    for (const k of bid.budgetKeys)
      available[k] -= BigInt(contract.reserveNano);
    available[bid.walletKey] -=
      BigInt(contract.principalYocto) + BigInt(contract.gasCapYocto);
    results.push({
      id: bid.id,
      revision: bid.revision,
      outcome: "won",
      reason: rule,
      contract,
    });
  }
  return {
    results,
    remainingCapacity: capacity,
    remainingBalances: Object.fromEntries(
      Object.entries(available).map(([k, v]) => [k, String(v)]),
    ),
    noSale: !results.some((r) => r.outcome === "won"),
  };
}
