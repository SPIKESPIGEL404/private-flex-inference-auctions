// Test-only identity provider. This cannot be selected by the production CLI.
// It deliberately omits hardware root verification and never claims real TEE.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifyReportBinding, verifyComposeMeasurement } from '@phala/aci-verifier';
import { assertBootPolicy, assertMarketPolicy, validatePolicy } from '../connection.mjs';
import { freshNonce, readSigningKey, signPurchase } from '../purchase-sign.mjs';

const require = createRequire(import.meta.url);
const dist = dirname(require.resolve('@phala/aci-verifier'));
const { connectAciWithTransport } = await import(pathToFileURL(resolve(dist, 'runtime/connection.js')));
const { createPinnedTransport } = await import(pathToFileURL(resolve(dist, 'node/transport.js')));
const [configFile, scenario] = process.argv.slice(2);
const config = JSON.parse(await readFile(configFile, 'utf8'));
const policy = validatePolicy(config.policy);
let connection;
let refused = false;
try {
  connection = await connectAciWithTransport({ baseURL: policy.baseURL,
    ca: await readFile(config.caFile), serving: { requireVerified: false, requireReceipt: false } },
  createPinnedTransport, async (attestationURL, origin, hostname) => {
    const nonce = randomBytes(32).toString('hex');
    const url = new URL(attestationURL); url.searchParams.set('nonce', nonce);
    const report = await (await fetch(url, { redirect: 'error' })).json();
    if (scenario === 'tamper') report.attestation.workload_keyset.tls_public_keys[0].spki_sha256 = 'ff'.repeat(32);
    if (scenario === 'expired') report.attestation.workload_keyset.not_after = 1;
    const binding = await verifyReportBinding(report, scenario === 'nonce' ? '00'.repeat(32) : nonce);
    assert.ok(binding.ok, 'original challenge/keyset/expiry binding must pass');
    const compose = await verifyComposeMeasurement(report);
    assert.ok(compose.ok);
    const accepted = scenario === 'release' ? ['ff'.repeat(32)] : policy.acceptedComposeHashes;
    assert.ok(accepted.includes(compose.composeHash), 'reviewed compose must pass');
    const bootPolicy = structuredClone(policy);
    if (scenario === 'boot') bootPolicy.acceptedBootMeasurements[0].mrtd = 'ff'.repeat(48);
    assertBootPolicy(report, bootPolicy);
    const policyCheck = structuredClone(policy);
    if (scenario === 'policy') policyCheck.acceptedPolicyDigests = ['sha256:' + 'ff'.repeat(32)];
    assertMarketPolicy(report, policyCheck);
    return { origin, hostname, report, keyset: binding.keyset,
      workloadKeysetDigest: binding.workloadKeysetDigest, composeHash: compose.composeHash,
      tlsSpkiPins: binding.keyset.tls_public_keys.map(k => k.spki_sha256),
      verifiedAt: Date.now(), expiresAt: binding.keyset.not_after * 1000,
      transcript: { lines: [{ id: 'id-1', status: 'skip', title: 'controlled test: no hardware root' },
        { id: 'id-6', status: 'skip', title: 'channel not yet observed' }],
        verification: binding, verdict: { verified: false, line: 'CONTROLLED ONLY' } } };
  });
  if (!['success', 'retry'].includes(scenario)) throw new Error('NEGATIVE_SCENARIO_ACCEPTED');
  const token = (await readFile(config.credentialFile, 'utf8')).trim();
  const signing = await readSigningKey(config.signingKeyFile);
  const request = await readFile(config.requestFile);
  const idempotencyKey = 'd-controlled';
  const headers = { authorization: 'Bearer ' + token, 'content-type': 'application/json',
    'idempotency-key': idempotencyKey,
    ...signPurchase({
      seed: signing.seed,
      publicKey: signing.publicKey,
      body: request,
      idempotencyKey,
      keyset: connection.identity.workloadKeysetDigest,
      nonce: freshNonce(),
      ts: Math.floor(Date.now() / 1000),
    }).headers };
  if (config.captureFile && scenario === 'success') {
    await writeFile(config.captureFile, JSON.stringify({
      headers, body: request.toString('base64'),
    }));
  }
  const response = await connection.fetch(policy.baseURL + '/chat/completions', { method: 'POST', redirect: 'error',
    headers, body: request });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /\[DONE\]/);
  console.log(JSON.stringify({ controlled_market_purchase: 'pass', hardware_attestation: false,
    signed: true, scenario }));
} catch (error) {
  if (['success', 'retry'].includes(scenario) || error.message === 'NEGATIVE_SCENARIO_ACCEPTED') throw error;
  refused = true;
  assert.notEqual(scenario, 'success');
  console.log(JSON.stringify({ scenario, refused: true, hardware_attestation: false }));
} finally { await connection?.close(); }
if (!['success', 'retry'].includes(scenario)) assert.ok(refused);
