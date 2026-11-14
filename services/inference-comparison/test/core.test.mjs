import test from "node:test";
import assert from "node:assert/strict";
import {
  costPerTokenToMarket,
  freezeNearTariff,
  validateTariff,
  usageCostMicro,
  comparisonRequest,
  validateComparison,
  digest,
} from "../core.mjs";
import { catalog, time, request, plan } from "./helpers.mjs";
test("NEAR decimal USD/token becomes exact Market microUSD per million", () => {
  const t = freezeNearTariff(catalog(), { observedAtMs: time });
  assert.deepEqual(t.rates, {
    input: "40000",
    cache_input: "18000",
    output: "1350000",
  });
  assert.equal(
    usageCostMicro(t.rates, {
      prompt_tokens: 1000,
      completion_tokens: 1000,
      prompt_tokens_details: { cached_tokens: 200 },
    }),
    "1386",
  );
  assert.equal(
    usageCostMicro(t.rates, { prompt_tokens: 1, completion_tokens: 1 }),
    "2",
  );
});
test("reject fractional Market units, nonUSD and unsafe integer amounts", () => {
  for (const v of [
    { amount: 1, scale: 13, currency: "USD" },
    { amount: 1, scale: 9, currency: "NEAR" },
    { amount: 1.1, scale: 9, currency: "USD" },
  ])
    assert.throws(() => costPerTokenToMarket(v));
});
test("snapshot rejects wrong ready model, duplicate and tiered prices", () => {
  for (const mutate of [
    (c) => (c.models[0].metadata.isReady = false),
    (c) => c.models.push(c.models[0]),
    (c) => (c.models[0].textPricing = { tiers: {} }),
    (c) => (c.models[0].modelId = "qwen-other"),
  ]) {
    const c = catalog();
    mutate(c);
    assert.throws(() => freezeNearTariff(c, { observedAtMs: time }));
  }
});
test("upcoming transition shortens TTL and unresolved transition rejects", () => {
  const c = catalog();
  c.models[0].upcomingPricing = {
    effectiveAt: new Date(time + 1000).toISOString(),
  };
  const t = freezeNearTariff(c, { observedAtMs: time });
  assert.equal(t.expiresAtMs, time + 1000);
  assert.throws(() => validateTariff(t, time + 1000));
  c.models[0].upcomingPricing.effectiveAt = "invalid";
  assert.throws(() => freezeNearTariff(c, { observedAtMs: time }));
});
test("modified frozen plans and tariff payloads cannot execute", () => {
  const p = plan();
  assert.equal(validateComparison(p, time).planHash, p.planHash);
  p.arms.A.tariff.rates.output = "1";
  assert.throws(() => validateComparison(p, time));
  assert.throws(() => validateTariff(p.arms.A.tariff, time));
});
test("common contract rejects tools, hidden message fields and nonzero temperature", () => {
  for (const r of [
    { ...request, tools: [] },
    { ...request, temperature: 1 },
    {
      ...request,
      messages: [{ role: "user", content: "x", secret: "hidden" }],
    },
    { ...request, max_completion_tokens: 513 },
  ])
    assert.throws(() => comparisonRequest(r));
  assert.equal(digest(comparisonRequest(request)), digest(request));
});
test("unknown cache counts are conservative and invalid cache arithmetic rejects", () => {
  const rates = { input: "1000000", cache_input: "0", output: "0" };
  assert.equal(
    usageCostMicro(rates, { prompt_tokens: 3, completion_tokens: 0 }),
    "3",
  );
  assert.throws(() =>
    usageCostMicro(rates, {
      prompt_tokens: 1,
      completion_tokens: 0,
      prompt_tokens_details: { cached_tokens: 2 },
    }),
  );
});
test("unrelated fractional catalog metadata does not enter integer-only signed prices", () => {
  const c = catalog();
  c.unrelatedStatistics = { latency: 0.25 };
  const tariff = freezeNearTariff(c, { observedAtMs: time });
  assert.equal(tariff.rates.input, "40000");
  assert.equal(tariff.catalogDigestEncoding, "parsed-json-serialization");
  assert.equal(validateTariff(tariff, time).priceVersion, tariff.priceVersion);
});
