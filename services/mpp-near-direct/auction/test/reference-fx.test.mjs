import test from "node:test";
import assert from "node:assert/strict";
import { referenceFx, REFERENCE_FX_SOURCE } from "../live/reference-fx.mjs";

const now = Date.parse("2026-11-15T03:00:00Z");
const row = () => ({
  assetId: "nep141:wrap.near",
  blockchain: "near",
  decimals: 24,
  contractAddress: "wrap.near",
  price: "3.143700001",
  priceUpdatedAt: new Date(now - 30000).toISOString(),
});
const fetcher = (rows) => async () => new Response(JSON.stringify(rows));

test("reference FX binds the exact native backing asset and provider timestamp, without a payment request", async () => {
  const fx = await referenceFx({
    now: () => now,
    fetcher: async (url, options) => {
      assert.equal(url, REFERENCE_FX_SOURCE);
      assert.equal(options.redirect, "error");
      assert.equal(options.method, undefined);
      assert.equal(options.headers, undefined);
      assert.equal(options.body, undefined);
      return new Response(JSON.stringify([row()]));
    },
  });
  assert.equal(fx.nanoUsdPerNear, "3143700001");
  assert.equal(fx.observedAtMs, now - 30000);
  assert.equal(fx.expiresAtMs, now + 60000);
  const reread = await referenceFx({
    now: () => now + 10000,
    fetcher: fetcher([row()]),
  });
  assert.equal(reread.expiresAtMs, fx.expiresAtMs);
});
test("reference FX refuses stale, future, missing, duplicate and misidentified prices", async () => {
  for (const rows of [
    [],
    [row(), row()],
    [{ ...row(), decimals: 18 }],
    [{ ...row(), contractAddress: "other.near" }],
    [{ ...row(), blockchain: "eth" }],
    [{ ...row(), assetId: "native:near" }],
    [{ ...row(), priceUpdatedAt: undefined }],
    [{ ...row(), priceUpdatedAt: new Date(now - 90000).toISOString() }],
    [{ ...row(), priceUpdatedAt: new Date(now + 1).toISOString() }],
    [{ ...row(), price: null }],
    [{ ...row(), price: 0 }],
    [{ ...row(), price: "1e9" }],
    [{ ...row(), price: "0.0000000001" }],
  ])
    await assert.rejects(
      referenceFx({ now: () => now, fetcher: fetcher(rows) }),
    );
});
test("reference FX network or size failure cannot manufacture a fresh quote", async () => {
  await assert.rejects(
    referenceFx({
      now: () => now,
      fetcher: async () => new Response("unavailable", { status: 503 }),
    }),
    /reference_fx_unavailable/,
  );
  await assert.rejects(
    referenceFx({
      now: () => now,
      fetcher: async () => new Response("x".repeat(1024 * 1024 + 1)),
    }),
    /reference_fx_response_limit/,
  );
});
