import test from "node:test";
import assert from "node:assert/strict";
import { auctionAccess, providerReadiness } from "../access.mjs";

const planHash = "a".repeat(64),
  user = { ENABLE_NEARINTENTS_USER_PAYMENTS: planHash };
function fixture(original = null) {
  const calls = { preflight: 0, paidProbe: 0 },
    tariff = { expiresAtMs: Date.now() + 30000 };
  return {
    calls,
    tariff,
    provider: {
      async preflight() {
        calls.preflight++;
        return tariff;
      },
    },
    probe: {
      get: () => original,
      async ensure() {
        calls.paidProbe++;
        return { verified: true, responseId: "test-response", actualMicro: "1" };
      },
    },
  };
}

test("only the exact user-purchase gate admits read-only readiness", async () => {
  for (const env of [
    {},
    { ENABLE_NEARINTENTS_USER_PAYMENTS: "b".repeat(64) },
    { ENABLE_NEARINTENTS_PAID_PROBE: planHash },
  ]) {
    const f = fixture();
    await assert.rejects(
      providerReadiness({ ...f, planHash, env }),
      /user_inference_payments_not_enabled/,
    );
    assert.deepEqual(f.calls, { preflight: 0, paidProbe: 0 });
  }
  assert.equal(auctionAccess(undefined, {}).userPaymentsEnabled, false);
});

test("user purchases become ready without spending a provider probe slot", async () => {
  const f = fixture(),
    result = await providerReadiness({ ...f, planHash, env: user });
  assert.equal(result.tariff, f.tariff);
  assert.deepEqual(result.evidence, {
    source: "near-cloud-attestation-and-catalog",
    paidProbe: false,
    providerCredit: "unverified",
  });
  assert.deepEqual(f.calls, { preflight: 1, paidProbe: 0 });
});

test("disabling automatic probes preserves an unresolved original probe", async () => {
  for (const state of ["sending", "unknown", "refused", "captured", "committing", "contract_breach"]) {
    const f = fixture({ state });
    await assert.rejects(
      providerReadiness({ ...f, planHash, env: user }),
      /original_provider_probe_unresolved/,
    );
    assert.deepEqual(f.calls, { preflight: 0, paidProbe: 0 });
  }
});

test("read-only preflight failure cannot fall back to a paid request", async () => {
  const f = fixture();
  f.provider.preflight = async () => { throw Error("provider_unavailable"); };
  await assert.rejects(
    providerReadiness({ ...f, planHash, env: user }),
    /provider_unavailable/,
  );
  assert.equal(f.calls.paidProbe, 0);
});

test("only a separate exact probe gate permits a billable probe", async () => {
  const f = fixture();
  await providerReadiness({
    ...f, planHash,
    env: { ...user, ENABLE_NEARINTENTS_PAID_PROBE: "wrong" },
  });
  assert.equal(f.calls.paidProbe, 0);
  const result = await providerReadiness({
    ...f, planHash,
    env: { ...user, ENABLE_NEARINTENTS_PAID_PROBE: planHash },
  });
  assert.equal(f.calls.paidProbe, 1);
  assert.equal(result.evidence.source, "near-cloud-attested-key-probe");
});
