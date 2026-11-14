import { readFile } from 'node:fs/promises';
import { X509Certificate, createHash } from 'node:crypto';
import https from 'node:https';
import { connectAci } from '@phala/aci-verifier/runtime';
import { verifyQuote } from '@phala/aci-verifier';
import { verifyTdxLiteOs } from '@phala/dstack-verifier-wasm';

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
  requireValue(value.acceptedAppId === undefined || /^[a-f0-9]{40}$/.test(value.acceptedAppId),
    'invalid accepted Market app ID');
  requireValue(value.acceptedImageDigest === undefined || /^sha256:[a-f0-9]{64}$/.test(value.acceptedImageDigest),
    'invalid accepted Market image digest');
  requireValue(value.acceptedOSImageHash === undefined || /^[a-f0-9]{64}$/.test(value.acceptedOSImageHash),
    'invalid accepted OS image hash');
  if (value.tlsCACertificate !== undefined) {
    requireValue(typeof value.tlsCACertificate === 'string' && value.tlsCACertificate.length <= 128 * 1024
      && /^-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----\s*$/.test(value.tlsCACertificate),
    'policy TLS trust root must contain one public certificate');
    requireValue(new X509Certificate(value.tlsCACertificate).ca, 'policy TLS trust root must be a CA certificate');
  }
  return structuredClone(value);
}

// A deployment CA is scoped to this HTTPS origin, never added to global trust
// for Intel collateral or other services. HTTPS verifies the chain and hostname;
// the ACI transport additionally verifies the hardware-bound actual SPKI.
async function bootstrapWithCa(url, ca) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { ca, agent: false, signal: AbortSignal.timeout(15_000) }, response => {
      const chunks = []; let size = 0;
      response.on('error', reject);
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) {
          response.destroy(new Error('attestation response too large'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        try { resolve(new Response(size ? Buffer.concat(chunks) : null, { status: response.statusCode })); }
        catch (error) { reject(error); }
      });
    });
    request.on('error', reject);
  });
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

/** Bind runtime event payloads to their authenticated digests (dstack v1).
 * The pinned ACI library replays provided digests; this additional check prevents
 * an attacker from changing event payloads while retaining that signed chain.
 */
export function assertMeasuredEvents(report, policy) {
  const evidence = report?.attestation?.evidence;
  requireValue(typeof evidence?.event_log === 'string' && typeof evidence.app_compose === 'string',
    'missing measured runtime configuration');
  const events = JSON.parse(evidence.event_log);
  requireValue(Array.isArray(events), 'invalid measured runtime log');
  let mr = Buffer.alloc(48), ready = false;
  const apps = [], composes = [];
  for (const event of events) {
    if (event.imr !== 3) continue;
    requireValue(Number.isInteger(event.event_type) && event.event_type >= 0 && event.event_type <= 0xffffffff
      && typeof event.event === 'string' && typeof event.event_payload === 'string'
      && /^(?:[a-fA-F0-9]{2})*$/.test(event.event_payload)
      && typeof event.digest === 'string' && /^[a-fA-F0-9]{96}$/.test(event.digest),
    'malformed measured runtime event');
    const kind = Buffer.alloc(4); kind.writeUInt32LE(event.event_type);
    const digest = createHash('sha384').update(Buffer.concat([kind, Buffer.from(':'),
      Buffer.from(event.event, 'utf8'), Buffer.from(':'), Buffer.from(event.event_payload, 'hex')])).digest();
    requireValue(digest.toString('hex') === event.digest.toLowerCase(), 'runtime event payload does not match its digest');
    mr = createHash('sha384').update(Buffer.concat([mr,digest])).digest();
    if (!ready && event.event === 'app-id') apps.push(event.event_payload.toLowerCase());
    if (!ready && event.event === 'compose-hash') composes.push(event.event_payload.toLowerCase());
    if (event.event === 'system-ready') ready = true;
  }
  const quote = Buffer.from(evidence.quote, 'hex');
  requireValue(quote.length >= 632 && quote.readUInt16LE(0) === 4 && quote.readUInt32LE(4) === 0x81,
    'only TDX v4 measured runtime logs are supported');
  requireValue(mr.equals(quote.subarray(520,568)), 'runtime log does not match the signed RTMR3');
  requireValue(ready && composes.length === 1 && composes[0]
    === createHash('sha256').update(evidence.app_compose, 'utf8').digest('hex'), 'runtime compose binding failed');
  if (policy.acceptedAppId !== undefined) {
    requireValue(apps.length === 1 && apps[0] === policy.acceptedAppId, 'runtime app ID is outside the reviewed policy');
  }
  if (policy.acceptedImageDigest !== undefined) {
    requireValue(report.attestation.source_provenance?.image_digest === policy.acceptedImageDigest,
      'declared image is outside the reviewed policy');
  }
  if (policy.acceptedOSImageHash !== undefined) {
    requireValue(typeof evidence.vm_config === 'string', 'missing platform VM configuration');
    const os = verifyTdxLiteOs({
      mrtd: quote.subarray(184,232).toString('hex'), rtmr0: quote.subarray(376,424).toString('hex'),
      rtmr1: quote.subarray(424,472).toString('hex'), rtmr2: quote.subarray(472,520).toString('hex'),
      eventLog: evidence.event_log, vmConfig: evidence.vm_config,
    });
    requireValue(os.ok && os.osImageHash === policy.acceptedOSImageHash,
      'platform measurement or approved OS image verification failed');
  }
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
    ...(policy.tlsCACertificate === undefined ? {} : { ca: policy.tlsCACertificate }),
    // This phase verifies our Market, not its upstream inference provider.
    serving: { requireVerified: false, requireReceipt: false },
    bootstrapFetch: async input => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      requireValue(url.origin === origin && url.pathname === '/market/v1/aci/attestation'
        && [...url.searchParams.keys()].length === 1 && url.searchParams.has('nonce'), 'invalid attestation origin/path');
      const response = policy.tlsCACertificate === undefined
        ? await fetch(url, { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15_000) })
        : await bootstrapWithCa(url, policy.tlsCACertificate);
      const report = await boundedReport(response);
      // Apply these checks on EVERY identity acquisition, including renewal.
      // connectAci additionally enforces fresh nonce, keyset expiry, measured
      // compose allowlist and the actual SPKI-pinned inference channel.
      const result = await verifyQuote(report);
      requireValue(result.ok && result.status === 'UpToDate', 'hardware quote or current TCB policy failed');
      assertBootPolicy(report, policy);
      assertMarketPolicy(report, policy);
      assertMeasuredEvents(report, policy);
      return Response.json(report);
    },
  });
  return connection;
}

export async function readPolicy(path) {
  return validatePolicy(JSON.parse(await readFile(path, 'utf8')));
}
