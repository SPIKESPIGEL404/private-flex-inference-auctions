import { requireThat as check, uint } from "../contract.mjs";
import { pricingContract, SCALE } from "./contracts.mjs";
export const POLICY_VERSION = "own-funds-bidding-v1";
// Only own grant, clock, remaining liability and per-round outcome are inputs.
// An economic bid ceiling is independent of the spending authorization cap.
export function chooseBid({
  policy,
  baseMultiplier = "1000000",
  step = "100000",
  maxMultiplier = "2000000",
  lostRounds = 0,
  nowMs,
  deadlineMs,
  availableNano,
  futureRequiredCalls = 0,
  service,
  fx,
  gasCapYocto,
  paymentWindowMs,
  admissionWindowMs,
  maxTotalMicro,
}) {
  check(
    ["fixed", "step-up", "task-aware"].includes(policy) &&
      Number.isSafeInteger(lostRounds) &&
      lostRounds >= 0 &&
      Number.isSafeInteger(futureRequiredCalls) &&
      futureRequiredCalls >= 0,
    "invalid_buyer_policy",
  );
  const base = uint(baseMultiplier),
    ceiling = uint(maxMultiplier);
  check(base >= SCALE && ceiling >= base, "invalid_economic_ceiling");
  const snapshot = {
    version: POLICY_VERSION,
    policy,
    baseMultiplier,
    step,
    maxMultiplier,
    lostRounds,
    nowMs,
    deadlineMs,
    availableNano,
    futureRequiredCalls,
  };
  if (nowMs + admissionWindowMs > deadlineMs)
    return {
      ...snapshot,
      action: "stop",
      reason: "insufficient_remaining_time",
    };
  const quote = (multiplier) =>
    pricingContract({
      service,
      bidMultiplier: String(multiplier),
      fx,
      gasCapYocto,
      nowMs,
      paymentWindowMs,
      admissionWindowMs,
    });
  const remaining = uint(availableNano),
    atReserve = quote(SCALE);
  const future =
    policy === "task-aware"
      ? BigInt(futureRequiredCalls) * BigInt(atReserve.reserveNano)
      : 0n;
  const target =
    policy === "fixed" ? base : base + uint(step) * BigInt(lostRounds);
  let multiplier = target < ceiling ? target : ceiling;
  const fits = (m) => {
    const c = quote(m);
    return (
      BigInt(c.maximum.totalMicro) <= uint(maxTotalMicro) &&
      BigInt(c.reserveNano) + future <= remaining
    );
  };
  if (!fits(base))
    return {
      ...snapshot,
      action: "wait",
      reason:
        future > 0n
          ? "future_steps_or_unsettled_liability"
          : "own_funds_or_call_cap",
    };
  if (policy === "task-aware" && !fits(multiplier)) {
    let low = base,
      high = multiplier;
    while (low < high) {
      const middle = (low + high + 1n) / 2n;
      if (fits(middle)) low = middle;
      else high = middle - 1n;
    }
    multiplier = low;
  }
  if (!fits(multiplier))
    return {
      ...snapshot,
      action: "wait",
      reason: "economic_bid_exceeds_own_authorization",
    };
  return {
    ...snapshot,
    action: "bid",
    bidMultiplier: String(multiplier),
    futureReserveNano: String(future),
    maximum: quote(multiplier).maximum,
  };
}
