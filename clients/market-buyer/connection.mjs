import { readFile } from 'node:fs/promises';
import { connectAci } from '@phala/aci-verifier/runtime';
import { verifyQuote } from '@phala/aci-verifier';

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

export function validatePolicy(value) {
  requireValue(value && value.version === 1, 'unsupported market verification policy');
  const url = new URL(value.baseURL);
  requireValue(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
    && url.pathname === '/market/v1', 'policy must name an exact HTTPS /market/v1 endpoint');
  requireValue(Array.isArray(value.acceptedComposeHashes) && value.acceptedComposeHashes.length > 0
    && value.acceptedComposeHashes.every(x => /^[a-f0-9]{64}$/.test(x)), 'reviewed compose hashes are required');
  requireValue(Array.isArray(value.acceptedPolicyDigests) && value.acceptedPolicyDigests.length > 0
    && value.acceptedPolicyDigests.every(x => /^sha256:[a-f0-9]{64}$/.test(x)),
    'reviewed catalog policy digests are required');
  requireValue(Array.isArray(value.acceptedBootMeasurements) && value.acceptedBootMeasurements.length > 0,
    'reviewed production boot measurements are required');
  for (const profile of value.acceptedBootMeasurements) {
    for (const name of ['mrtd', 'rtmr0', 'rtmr1', 'rtmr2']) {
      requireValue(/^[a-f0-9]{96}$/.test(profile[name]), `invalid boot measurement ${name}`);
    }
  }
  return structuredClone(value);
}

/** Raw quote fields are used only together with real vendor-root verification. */
export function assertBootPolicy(report, policy) {
  const encoded = report?.attestation?.evidence?.quote;
  requireValue(typeof encoded === 'string' && /^[a-f0-9]+$/.test(encoded) && encoded.length % 2 === 0,
    'malformed TDX quote');
  const quote = Buffer.from(encoded, 'hex');
  requireValue(quote.length >= 632 && quote.readUInt16LE(0) === 4 && quote.readUInt32LE(4) === 0x81,
    'only TDX v4 production profiles are supported');
  requireValue((quote.readBigUInt64LE(168) & 1n) === 0n, 'debug TDX workload rejected');
  const fields = { mrtd: 184, rtmr0: 376, rtmr1: 424, rtmr2: 472 };
  requireValue(policy.acceptedBootMeasurements.some(profile => Object.entries(fields)
    .every(([name, offset]) => profile[name] === quote.subarray(offset, offset + 48).toString('hex'))),
  'boot measurements are outside the reviewed production allowlist');
}

/** The keyset subject is the catalog file digest sealed before Market load. */
export function assertMarketPolicy(report, policy) {
  const subject = report?.attestation?.workload_keyset?.subject;
  const match = typeof subject === 'string' ? /^market-policy:(sha256:[a-f0-9]{64})$/.exec(subject) : null;
  requireValue(match && policy.acceptedPolicyDigests.includes(match[1]), 'market policy digest is not accepted');
}

async function boundedReport(response) {
  requireValue(response.ok, 'attestation endpoint refused the challenge');
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
  } catch (error) { await reader.cancel(); throw error; }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** No injected verifier or development bypass is accepted by this entry point. */
export async function connectMarket(input) {
  const policy = validatePolicy(input);
  const origin = new URL(policy.baseURL).origin;
  const connection = await connectAci({
    baseURL: policy.baseURL,
    policy: { acceptedComposeHashes: policy.acceptedComposeHashes },
    // This phase verifies our Market, not its upstream inference provider.
    serving: { requireVerified: false, requireReceipt: false },
    bootstrapFetch: async input => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      requireValue(url.origin === origin && url.pathname === '/market/v1/aci/attestation'
        && [...url.searchParams.keys()].length === 1 && url.searchParams.has('nonce'), 'invalid attestation origin/path');
      const response = await fetch(url, { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15_000) });
      const report = await boundedReport(response);
      // Apply these checks on EVERY identity acquisition, including renewal.
      // connectAci additionally enforces fresh nonce, keyset expiry, measured
      // compose allowlist and the actual SPKI-pinned inference channel.
      const result = await verifyQuote(report);
      requireValue(result.ok && result.status === 'UpToDate', 'hardware quote or current TCB policy failed');
      assertBootPolicy(report, policy);
      assertMarketPolicy(report, policy);
      return Response.json(report);
    },
  });
  return connection;
}

export async function readPolicy(path) {
  return validatePolicy(JSON.parse(await readFile(path, 'utf8')));
}
