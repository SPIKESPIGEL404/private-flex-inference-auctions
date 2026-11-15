import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { freezeClass } from "../../../mpp-near-direct/auction/contracts.mjs";
import { AuctionMarket } from "../../../mpp-near-direct/auction/market.mjs";
import { auctionPlan } from "../plan.mjs";
import { NI_MODE, NearintentsAuctionRail } from "../rail.mjs";
import { launchNearintentsAuction, paidProbeAccess } from "../runtime.mjs";
test("a deployed canary cannot buy a provider probe without its exact operator gate", async () => {
  let effects = 0;
  const probe = {
    ensure: async () => {
      effects++;
      return { verified: true };
    },
  };
  await assert.rejects(
    paidProbeAccess(probe, {}, "reviewed-plan", ""),
    /paid_provider_probe_not_enabled/,
  );
  await assert.rejects(
    paidProbeAccess(probe, {}, "reviewed-plan", "another-plan"),
    /paid_provider_probe_not_enabled/,
  );
  assert.equal(effects, 0);
  assert.deepEqual(
    await paidProbeAccess(probe, {}, "reviewed-plan", "reviewed-plan"),
    { verified: true },
  );
  assert.equal(effects, 1);
});
const { durationMs, ...example } = JSON.parse(
  await readFile(
    new URL(
      "../../../../docs/examples/nearintents-auction-parameters.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const input = () => ({
  ...structuredClone(example),
  deadlineMs: Date.now() + durationMs,
  service: freezeClass(example.service),
});
test("live profile pins asset, origin, service-budget hierarchy and bounded activation", async () => {
  const p = input();
  const { plan, planHash } = auctionPlan(p);
  assert.equal(plan.gasReserveYocto, "0");
  for (const mutation of [
    { sourceRpcUrl: "http://127.0.0.1:1234" },
    { origin: p.origin + "/" },
    { realm: "another.example.invalid" },
    { originAsset: p.originAsset.replace("af88", "bf88") },
    { deadlineMs: Date.now() + 86400001 + 60000 },
    { agentBudgetNano: "1000" },
    { nearAiKey: "must-never-be-public" },
  ])
    assert.throws(() => auctionPlan({ ...p, ...mutation }));
  await assert.rejects(
    launchNearintentsAuction({ plan, reviewedPlanHash: planHash + "wrong" }),
    /explicit_nearintents_auction_gate_required/,
  );
});
test("live adapter cannot substitute the frozen service or operator plan", () => {
  const { plan, planHash } = auctionPlan(input()),
    secret = "test-only-merchant-secret-".repeat(2);
  const rail = new NearintentsAuctionRail({ pool: {}, config: plan, secret });
  const config = {
    mode: NI_MODE,
    paymentMethod: "nearintents",
    billing: "auction-fixed-request-v1",
    network: "mainnet",
    realBroadcastEnabled: true,
    livePlan: plan,
    reviewedPlanHash: planHash,
    merchant: plan.merchant,
    realm: plan.realm,
    service: plan.service,
    capacity: 1,
    rule: "first-price-v1",
    windowMs: 1000,
    paymentWindowMs: plan.paymentWindowMs,
    admissionWindowMs: plan.admissionWindowMs,
    secret,
  };
  const make = (c) =>
    new AuctionMarket({
      pool: {},
      config: c,
      paymentRail: rail,
      live: { scope: NI_MODE },
    });
  assert.ok(make(config));
  assert.throws(
    () =>
      make({
        ...config,
        service: freezeClass({ ...plan.service, maxOutputTokens: 64 }),
      }),
    /auction_payment_profile_mismatch/,
  );
  assert.throws(
    () => make({ ...config, livePlan: { ...plan, maximumProviderCalls: 100 } }),
    /reviewed_nearintents_plan_required/,
  );
});
