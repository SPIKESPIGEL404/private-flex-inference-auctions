/** Market deployment / channel verification for CLI and gateway (no credentials). */
import { randomBytes } from 'node:crypto';
import { connectAci } from '@phala/aci-verifier/runtime';
import { verifyQuote, verifyReportBinding, verifyComposeMeasurement } from '@phala/aci-verifier';
import {
  assertBootPolicy,
  assertMarketPolicy,
  validatePolicy,
} from './connection.mjs';

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function catalogDigestFromKeyset(keyset) {
  const subject = keyset?.subject;
  const match = typeof subject === 'string'
    ? /^market-policy:(sha256:[a-f0-9]{64})$/.exec(subject)
    : null;
  requireValue(match, 'market policy digest missing from keyset');
  return match[1];
}

function quoteTypeFromReport(report, simulated) {
  const encoded = report?.attestation?.evidence?.quote;
  requireValue(typeof encoded === 'string' && /^[a-f0-9]+$/.test(encoded), 'malformed quote');
  const quote = Buffer.from(encoded, 'hex');
  requireValue(
    quote.length >= 632 && quote.readUInt16LE(0) === 4 && quote.readUInt32LE(4) === 0x81,
    'only TDX v4 quotes are supported',
  );
  return simulated ? 'tdx-v4-simulated' : 'tdx-v4';
}

function publicResult(fields) {
  return {
    status: fields.status,
    compose_hash: fields.compose_hash ?? null,
    catalog_policy_digest: fields.catalog_policy_digest ?? null,
    workload_keyset_digest: fields.workload_keyset_digest ?? null,
    tls_pinned: fields.tls_pinned ?? null,
    quote_type: fields.quote_type ?? null,
    checked_at: fields.checked_at,
  };
}

export function failedAttestationResult(checkedAt = new Date().toISOString()) {
  return publicResult({ status: 'failed', checked_at: checkedAt });
}

async function boundedReport(response) {
  requireValue(response.ok, 'attestation endpoint refused');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      requireValue(size <= 2 * 1024 * 1024, 'attestation response too large');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel();
    throw error;
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/**
 * Simulated hardware path used only when the buyer policy explicitly sets
 * `allowSimulatedHardware: true`. That acceptance is recorded as
 * `controlled_local` and can never yield `verified`.
 */
async function verifySimulatedDeployment(policy) {
  const origin = new URL(policy.baseURL).origin;
  const nonce = randomBytes(32).toString('hex');
  const url = new URL(policy.baseURL.replace(/\/?$/, '/') + 'aci/attestation');
  url.searchParams.set('nonce', nonce);
  requireValue(url.origin === origin, 'invalid attestation origin');
  const response = await fetch(url, {
    redirect: 'error',
    cache: 'no-store',
    signal: AbortSignal.timeout(14_000),
  });
  const report = await boundedReport(response);
  const binding = await verifyReportBinding(report, nonce);
  requireValue(binding.ok, 'binding failed');
  const compose = await verifyComposeMeasurement(report);
  requireValue(compose.ok, 'compose failed');
  requireValue(
    policy.acceptedComposeHashes.includes(compose.composeHash),
    'compose not accepted',
  );
  assertBootPolicy(report, policy);
  assertMarketPolicy(report, policy);
  const pins = (binding.keyset?.tls_public_keys ?? [])
    .map((k) => k.spki_sha256)
    .filter((x) => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x));
  requireValue(pins.length > 0, 'tls pins missing');
  return publicResult({
    status: 'controlled_local',
    compose_hash: compose.composeHash,
    catalog_policy_digest: catalogDigestFromKeyset(binding.keyset),
    workload_keyset_digest: binding.workloadKeysetDigest,
    tls_pinned: true,
    quote_type: quoteTypeFromReport(report, true),
    checked_at: new Date().toISOString(),
  });
}

async function verifyHardwareDeployment(policy) {
  const connection = await connectAci({
    baseURL: policy.baseURL,
    policy: { acceptedComposeHashes: policy.acceptedComposeHashes },
    serving: { requireVerified: false, requireReceipt: false },
    bootstrapFetch: async (input) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      const origin = new URL(policy.baseURL).origin;
      requireValue(
        url.origin === origin
          && url.pathname === '/market/v1/aci/attestation'
          && [...url.searchParams.keys()].length === 1
          && url.searchParams.has('nonce'),
        'invalid attestation origin/path',
      );
      const response = await fetch(url, {
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(14_000),
      });
      const report = await boundedReport(response);
      const result = await verifyQuote(report);
      requireValue(result.ok && result.status === 'UpToDate', 'hardware quote failed');
      assertBootPolicy(report, policy);
      assertMarketPolicy(report, policy);
      return Response.json(report);
    },
  });
  try {
    const identity = connection.identity;
    const pins = identity.tlsSpkiPins ?? [];
    return publicResult({
      status: 'verified',
      compose_hash: identity.composeHash,
      catalog_policy_digest: catalogDigestFromKeyset(identity.keyset),
      workload_keyset_digest: identity.workloadKeysetDigest,
      tls_pinned: Array.isArray(pins) && pins.length > 0,
      quote_type: 'tdx-v4',
      checked_at: new Date().toISOString(),
    });
  } finally {
    await connection.close();
  }
}

/**
 * Display-only Market deployment/channel check. No credentials.
 * `allowSimulatedHardware: true` selects the simulated path and forces
 * `controlled_local` (never `verified`). Buy/receipt must use connectMarket,
 * which refuses this flag and never accepts controlled_local as verified.
 */
export async function verifyMarketDeployment(policyInput) {
  const policy = validatePolicy(policyInput);
  if (policy.allowSimulatedHardware === true) {
    return verifySimulatedDeployment(policy);
  }
  return verifyHardwareDeployment(policy);
}

export { publicResult, validatePolicy };
