import test from "node:test";
import assert from "node:assert/strict";
import { freezeClass } from "../contracts.mjs";
import { hash } from "../../contract.mjs";
import { validateLivePlan, validateFx, LIVE_MODE } from "../live/policy.mjs";
import { qualify } from "../live/admission.mjs";
import { AuctionMarket } from "../market.mjs";
import { startAuctionServer, startMainnetAuctionServer } from "../server.mjs";
export function plan(now = Date.now()) {
  return {
    version: 1,
    mode: LIVE_MODE,
    network: "mainnet",
    walletProvider: "outlayer",
    realBroadcastEnabled: true,
    origin: "https://auction.example",
    realm: "auction.example",
    merchant: "merchant.near",
    deadlineMs: now + 600000,
    fxSource: "https://oracle.example/near-usd",
    rpcUrl: "https://rpc.mainnet.near.org",
    ownerBudgetNano: "20000000",
    agentBudgetNano: "10000000",
    callCapMicro: "5000",
    principalCapYocto: "10000000000000000000000",
    gasReserveYocto: "30000000000000000000",
    gasFloorYocto: "1000000000000000000000",
    merchantGasReserveYocto: "30000000000000000000",
    merchantMaximumYocto: "100000000000000000000000",
    providerMaximumMicro: "10000",
    maximumProviderCalls: 8,
    maximumAgents: 4,
    storagePriceYocto: "10000000000000000000",
    fundingCapYocto: "10000000000000000000000",
    service: freezeClass({
      model: "Qwen/Qwen3.8-27B",
      checkpoint: "near-ai-catalog-identity-unverified",
      quantization: "provider-reported",
      tokenizer: "qwen-conservative-input-v1",
      template: "bounded-text-bash-v1",
      engine: "near-ai-cloud-sdk-0.3.0",
      capacityPoolId: "single-seller-1",
      minInputTokens: 0,
      maxInputTokens: 32000,
      maxOutputTokens: 128,
      rates: { input: "40000", cache_input: "18000", output: "1350000" },
      fee: { version: "flat-plus-bps-v1", flatMicro: "1", bps: "100" },
      delivery: "verified-complete-response-v1",
      features: "text-and-bash-v1",
    }),
  };
}
export const fx = (now = Date.now()) => ({
  kind: "market-usd-near-v1",
  source: "https://oracle.example/near-usd",
  nanoUsdPerNear: "2000000000",
  observedAtMs: now,
  expiresAtMs: now + 120000,
});
test("Mainnet plan has an explicit reviewed hash, bounded duration and separate caps", () => {
  const p = plan();
  assert.equal(validateLivePlan(p).planHash, hash(p));
  for (const change of [
    { network: "testnet" },
    { realBroadcastEnabled: false },
    { origin: "http://auction.example" },
    { maximumAgents: 99 },
    { deadlineMs: Date.now() + 90000000 },
    { providerMaximumMicro: "0" },
    { apiKey: "do-not-serialize" },
  ])
    assert.throws(() => validateLivePlan({ ...p, ...change }));
  assert.throws(
    () =>
      new AuctionMarket({
        pool: {},
        config: {
          mode: LIVE_MODE,
          livePlan: p,
          network: "mainnet",
          realBroadcastEnabled: true,
        },
      }),
    /reviewed_mainnet/,
  );
});
test("FX is sourced, fresh, positive, and never uses a Testnet convention", () => {
  const observation = fx();
  assert.deepEqual(validateFx(observation), observation);
  for (const change of [
    { source: "test-near-is-dollar" },
    { expiresAtMs: 0 },
    { observedAtMs: Date.now() + 1000 },
    { nanoUsdPerNear: "0" },
  ])
    assert.throws(() => validateFx({ ...fx(), ...change }));
});
test("input qualification rejects multimodal, unknown roles, oversized input before any bid/payment", () => {
  const s = plan().service,
    b = {
      model: s.model,
      messages: [{ role: "user", content: "Calculate 3+7." }],
      stream: true,
      stream_options: { include_usage: true },
      max_completion_tokens: 128,
    };
  assert.ok(qualify(b, JSON.stringify(b), s).upper < 32000);
  for (const messages of [
    [{ role: "user", content: [{ type: "image_url", image_url: "evil" }] }],
    [{ role: "unknown", content: "a" }],
    [{ role: "user", content: "x".repeat(32000) }],
  ]) {
    const v = { ...b, messages };
    assert.throws(() => qualify(v, JSON.stringify(v), s));
  }
});
test("controlled server cannot be upgraded by passing a live flag; Mainnet rejects fixture adapters", async () => {
  await assert.rejects(
    () =>
      startAuctionServer({
        mainnet: true,
        market: { config: { mode: LIVE_MODE } },
        wallet: {},
        provider: {},
      }),
    /real_auction_gate_closed/,
  );
  await assert.rejects(
    () =>
      startMainnetAuctionServer({
        market: { config: { mode: "controlled" } },
        wallet: {},
        provider: {},
      }),
    /reviewed_mainnet_server_required/,
  );
});
