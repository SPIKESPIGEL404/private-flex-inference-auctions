import type { AuctionSettings } from "./task-api";
export interface Pricing {
  fx: {
    nanoUsdPerNear: string;
    observedAtMs: number;
    expiresAtMs: number;
    source: string;
  };
  paymentWindowMs: number;
  admissionWindowMs: number;
}
export interface Service {
  model: string;
  minInputTokens: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  rates: { input: string; cache_input: string; output: string };
  fee: { flatMicro: string; bps: string };
}
const ceil = (n: bigint, d: bigint) => (n + d - 1n) / d;
// Buyer-side conservative estimate. Market independently freezes and enforces
// the actual contract. No hash/crypto/Node dependency is needed in the browser.
export function maximumLiability(
  service: Service,
  pricing: Pricing,
  gasYocto: string,
  bid: string,
) {
  const scale = 1000000n,
    m = BigInt(bid),
    rates = Object.fromEntries(
      Object.entries(service.rates).map(([k, v]) => [
        k,
        ceil(BigInt(v) * m, scale),
      ]),
    );
  const input =
    rates.input > rates.cache_input ? rates.input : rates.cache_input;
  const serviceMicro = ceil(
    BigInt(service.maxInputTokens) * input +
      BigInt(service.maxOutputTokens) * rates.output,
    scale,
  );
  const totalMicro =
    serviceMicro +
    BigInt(service.fee.flatMicro) +
    ceil(serviceMicro * BigInt(service.fee.bps), 10000n);
  const principal = ceil(
    totalMicro * 1000n * 10n ** 24n,
    BigInt(pricing.fx.nanoUsdPerNear),
  );
  return {
    totalMicro,
    reserveNano: ceil(
      (principal + BigInt(gasYocto)) * BigInt(pricing.fx.nanoUsdPerNear),
      10n ** 24n,
    ),
  };
}
export function buyerBid({
  settings,
  losses,
  availableNano,
  callCapMicro,
  futureCalls,
  service,
  pricing,
  gasCapYocto,
  deadlineMs,
  nowMs = Date.now(),
}: {
  settings: AuctionSettings;
  losses: number;
  availableNano: bigint;
  callCapMicro: string;
  futureCalls: number;
  service: Service;
  pricing: Pricing;
  gasCapYocto: string;
  deadlineMs: number;
  nowMs?: number;
}) {
  if (nowMs + pricing.admissionWindowMs >= deadlineMs)
    return {
      action: "stop" as const,
      reason: "Insufficient time for another model call.",
    };
  if (nowMs >= pricing.fx.expiresAtMs)
    return {
      action: "stop" as const,
      reason: "The pricing observation expired.",
    };
  const base = BigInt(settings.baseMultiplier),
    max = BigInt(settings.maxMultiplier);
  const target =
    settings.policy === "fixed" ? base : base + BigInt(losses) * 100000n;
  const future =
    settings.policy === "task-aware"
      ? maximumLiability(service, pricing, gasCapYocto, "1000000").reserveNano *
        BigInt(futureCalls)
      : 0n;
  const fits = (n: bigint) => {
    const q = maximumLiability(service, pricing, gasCapYocto, String(n));
    return (
      q.reserveNano + future <= availableNano &&
      q.totalMicro <= BigInt(callCapMicro)
    );
  };
  if (!fits(base))
    return {
      action: "wait" as const,
      reason:
        "Waiting for available funds; retaining the budget for later steps.",
    };
  let value = target < max ? target : max;
  if (settings.policy === "task-aware" && !fits(value)) {
    let low = base,
      high = value;
    while (low < high) {
      const middle = (low + high + 1n) / 2n;
      if (fits(middle)) low = middle;
      else high = middle - 1n;
    }
    value = low;
  }
  if (!fits(value))
    return {
      action: "wait" as const,
      reason: "The next bid would exceed the available authorization.",
    };
  return { action: "bid" as const, multiplier: String(value) };
}
