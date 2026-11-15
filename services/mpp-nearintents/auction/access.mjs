import { requireThat as check } from "../../mpp-near-direct/contract.mjs";

// Publishing the UI, accepting user purchases, and buying an operator probe
// are separate actions. None of these flags authorizes a canary runner.
export function auctionAccess(planHash, env = process.env) {
  const matches = (value) =>
    typeof planHash === "string" && planHash.length === 64 && value === planHash;
  return {
    userPaymentsEnabled: matches(env.ENABLE_NEARINTENTS_USER_PAYMENTS),
    paidProbeEnabled: matches(env.ENABLE_NEARINTENTS_PAID_PROBE),
  };
}

export async function paidProbeAccess(probe, tariff, planHash, enabledHash) {
  check(
    enabledHash === planHash && !!planHash,
    "paid_provider_probe_not_enabled",
  );
  return probe.ensure(tariff);
}

export async function providerReadiness({
  provider,
  probe,
  planHash,
  env = process.env,
}) {
  const access = auctionAccess(planHash, env);
  check(access.userPaymentsEnabled, "user_inference_payments_not_enabled");
  // A previous probe's financial uncertainty cannot be bypassed by disabling
  // its switch. Reading its durable outbox never sends a provider request.
  const original = probe.get();
  if (!access.paidProbeEnabled)
    check(
      !original || original.state === "verified",
      "original_provider_probe_unresolved",
    );
  // preflight verifies attestation and the authenticated catalog only. It
  // does not call Chat Completions or establish available provider credit.
  const tariff = await provider.preflight();
  if (access.paidProbeEnabled) {
    const result = await paidProbeAccess(
      probe,
      tariff,
      planHash,
      env.ENABLE_NEARINTENTS_PAID_PROBE,
    );
    check(result?.verified, "provider_key_probe_required");
    return {
      tariff,
      evidence: {
        source: "near-cloud-attested-key-probe",
        responseId: result.responseId,
        actualMicro: result.actualMicro,
        providerCredit: "previously-verified",
      },
    };
  }
  return {
    tariff,
    evidence: {
      source: "near-cloud-attestation-and-catalog",
      paidProbe: false,
      providerCredit: "unverified",
    },
  };
}
