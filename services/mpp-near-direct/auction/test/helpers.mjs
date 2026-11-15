import { freezeClass, pricingContract, clearRound } from "../contracts.mjs";
export const time = 1800000000000;
export const service = () =>
  freezeClass({
    model: "m/external",
    checkpoint: "fixture-v1",
    quantization: "none",
    tokenizer: "fixture-tokenizer",
    template: "template-v1",
    engine: "fixture-v1",
    capacityPoolId: "gpu-1",
    minInputTokens: 1,
    maxInputTokens: 1000,
    maxOutputTokens: 512,
    rates: { input: "40000", cache_input: "18000", output: "1350000" },
    fee: { version: "flat-plus-bps-v1", flatMicro: "1", bps: "100" },
    delivery: "verified-complete-response-v1",
    features: "text-and-bash-v1",
  });
export const fx = {
  source: "controlled-fx",
  nanoUsdPerNear: "2000000000",
  observedAtMs: time,
  expiresAtMs: time + 100000,
};
export const price = (more = {}) =>
  pricingContract({
    service: service(),
    bidMultiplier: "1400000",
    fx,
    gasCapYocto: "1000000000000000000",
    nowMs: time,
    paymentWindowMs: 1000,
    admissionWindowMs: 2000,
    ...more,
  });
export const bid = (id, multiplier = "1000000", more = {}) => ({
  id,
  revision: "0",
  state: "active",
  acceptedSequence: id === "a" ? "1" : "2",
  acceptedAtMs: time - 1,
  expiryMs: time + 5000,
  deadlineMs: time + 10000,
  authorized: true,
  serviceClassVersion: service().serviceClassVersion,
  bidMultiplier: multiplier,
  maxTotalMicro: "100000",
  gasCapYocto: "1000000000000000000",
  budgetKeys: ["owner", "agent-" + id, "task-" + id],
  walletKey: "wallet-" + id,
  ...more,
});
export const clear = (bids, more = {}) =>
  clearRound({
    bids,
    cutoffMs: time,
    capacity: 1,
    service: service(),
    fx,
    paymentWindowMs: 1000,
    admissionWindowMs: 2000,
    balances: {
      owner: "100000000",
      "agent-a": "100000000",
      "task-a": "100000000",
      "agent-b": "100000000",
      "task-b": "100000000",
      "wallet-a": "1000000000000000000000000",
      "wallet-b": "1000000000000000000000000",
    },
    ...more,
  });
