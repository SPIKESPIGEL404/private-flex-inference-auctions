import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateMarketCatalog } from "../market-executor.mjs";
import { digest } from "../core.mjs";
import { plan } from "./helpers.mjs";
function fixture() {
  const p = plan(),
    arm = p.arms.B,
    catalog = JSON.parse(
      readFileSync(
        new URL("../../../deploy/market/catalog.json", import.meta.url),
      ),
    );
  catalog.products[0].option.model.model_ref = arm.model;
  for (const item of catalog.products[0].candidates) {
    item.candidate.input.offering.rates = structuredClone(arm.tariff.rates);
    item.candidate.service.rates = structuredClone(arm.tariff.rates);
  }
  for (const route of catalog.products[0].routes) {
    route.base_url = "http://127.0.0.1:8091/";
    route.native_model = "Qwen/Qwen3.8-27B-FP8";
    route.incarnation = arm.tariff.modelRevisionRef;
  }
  return { p, arm, catalog };
}
function checkCatalog({ p, arm, catalog }) {
  const raw = Buffer.from(JSON.stringify(catalog));
  return validateMarketCatalog(
    raw,
    { acceptedPolicyDigests: ["sha256:" + digest(raw)] },
    arm,
    p.deadlineMs,
  );
}
test("frozen tariff binds to exact attested catalog, every offer and native route", () => {
  const f = fixture();
  assert.match(checkCatalog(f), /^sha256:/);
  for (const mutate of [
    (f) =>
      (f.catalog.products[0].candidates[1].candidate.service.rates.output =
        "1"),
    (f) =>
      (f.catalog.products[0].candidates[0].candidate.input.offering.valid_until = 0),
    (f) => (f.catalog.products[0].routes[1].native_model = "wrong"),
    (f) =>
      (f.catalog.products[0].routes[0].base_url =
        "https://unverified.example/"),
    (f) =>
      (f.catalog.products[0].routes[0].incarnation = "different-checkpoint"),
  ]) {
    const bad = fixture();
    mutate(bad);
    assert.throws(() => checkCatalog(bad));
  }
});
test("catalog bytes not reviewed by attestation policy are rejected", () => {
  const f = fixture();
  assert.throws(() =>
    validateMarketCatalog(
      Buffer.from(JSON.stringify(f.catalog)),
      { acceptedPolicyDigests: ["sha256:" + "0".repeat(64)] },
      f.arm,
      f.p.deadlineMs,
    ),
  );
});
