import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { connectMarket } from '../connection.mjs';
import {
  failedAttestationResult,
  publicResult,
  validatePolicy,
} from '../verify-deployment.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const cli = join(root, '../cli.mjs');

const boot = {
  mrtd: '00'.repeat(48), rtmr0: '00'.repeat(48), rtmr1: '00'.repeat(48), rtmr2: '00'.repeat(48),
};

const KEYS = [
  'status', 'compose_hash', 'catalog_policy_digest', 'workload_keyset_digest',
  'tls_pinned', 'quote_type', 'checked_at',
];

test('--json output shape is fixed and failed has no detail fields leaked', async () => {
  const failed = failedAttestationResult('2026-01-01T00:00:00.000Z');
  assert.deepEqual(Object.keys(failed).sort(), [...KEYS].sort());
  assert.equal(failed.status, 'failed');
  assert.equal(failed.compose_hash, null);
  assert.equal(failed.checked_at, '2026-01-01T00:00:00.000Z');

  const verified = publicResult({
    status: 'verified',
    compose_hash: 'ab'.repeat(32),
    catalog_policy_digest: 'sha256:' + 'cd'.repeat(32),
    workload_keyset_digest: 'sha256:' + 'ef'.repeat(32),
    tls_pinned: true,
    quote_type: 'tdx-v4',
    checked_at: '2026-01-01T00:00:00.000Z',
  });
  assert.deepEqual(Object.keys(verified).sort(), [...KEYS].sort());
  assert.equal(verified.status, 'verified');

  const controlled = publicResult({
    status: 'controlled_local',
    compose_hash: '11'.repeat(32),
    catalog_policy_digest: 'sha256:' + '22'.repeat(32),
    workload_keyset_digest: 'sha256:' + '33'.repeat(32),
    tls_pinned: true,
    quote_type: 'tdx-v4-simulated',
    checked_at: '2026-01-01T00:00:00.000Z',
  });
  assert.equal(controlled.status, 'controlled_local');
  assert.notEqual(controlled.status, 'verified');

  // CLI --json against a missing policy: failed shape only.
  const child = spawn(process.execPath, [cli, 'verify', '--json', '--policy', join(root, 'missing-policy.json')], {
    cwd: join(root, '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const chunks = [];
  for await (const chunk of child.stdout) chunks.push(chunk);
  await new Promise(resolve => child.on('close', resolve));
  const line = Buffer.concat(chunks).toString('utf8').trim();
  const parsed = JSON.parse(line);
  assert.deepEqual(Object.keys(parsed).sort(), [...KEYS].sort());
  assert.equal(parsed.status, 'failed');
  assert.ok(!line.includes('ENOENT'));
  assert.ok(!line.includes('missing-policy'));
});

test('allowSimulatedHardware is opt-in on the policy and cannot imply verified alone', () => {
  const base = {
    version: 1,
    baseURL: 'https://example.invalid/market/v1',
    acceptedComposeHashes: ['ab'.repeat(32)],
    acceptedPolicyDigests: ['sha256:' + 'cd'.repeat(32)],
    acceptedBootMeasurements: [boot],
  };
  assert.equal(validatePolicy(base).allowSimulatedHardware, undefined);
  const simulated = validatePolicy({ ...base, allowSimulatedHardware: true });
  assert.equal(simulated.allowSimulatedHardware, true);
  assert.throws(() => validatePolicy({ ...base, allowSimulatedHardware: false }));
});

test('connectMarket refuses allowSimulatedHardware before any network', async () => {
  let fetches = 0;
  const previous = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    fetches += 1;
    return previous(...args);
  };
  try {
    await assert.rejects(() => connectMarket({
      version: 1,
      baseURL: 'https://example.invalid/market/v1',
      acceptedComposeHashes: ['ab'.repeat(32)],
      acceptedPolicyDigests: ['sha256:' + 'cd'.repeat(32)],
      acceptedBootMeasurements: [boot],
      allowSimulatedHardware: true,
    }));
    assert.equal(fetches, 0);
  } finally {
    globalThis.fetch = previous;
  }
});

test('buy with allowSimulatedHardware sends nothing and exits non-zero', async () => {
  let hits = 0;
  const server = createServer(socket => {
    hits += 1;
    socket.destroy();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const dir = await mkdtemp(join(tmpdir(), 'buy-sim-'));
  try {
    const policyPath = join(dir, 'policy.json');
    const credentialPath = join(dir, 'credential');
    const requestPath = join(dir, 'request.json');
    const signingPath = join(dir, 'signing.key');
    await writeFile(policyPath, JSON.stringify({
      version: 1,
      baseURL: `https://127.0.0.1:${port}/market/v1`,
      acceptedComposeHashes: ['ab'.repeat(32)],
      acceptedPolicyDigests: ['sha256:' + 'cd'.repeat(32)],
      acceptedBootMeasurements: [boot],
      allowSimulatedHardware: true,
    }));
    await writeFile(credentialPath, 'bearer-secret-must-not-leave\n', { mode: 0o600 });
    await writeFile(requestPath, JSON.stringify({
      model: 'm/external', stream: true,
      bitrouter_purchase: { buyer_cap_micro_usd: 100, provider_cap_micro_usd: 90, total_cap_micro_usd: 100 },
    }));
    await writeFile(signingPath, 'ed25519:' + '11'.repeat(32) + '\n', { mode: 0o600 });

    const child = spawn(process.execPath, [
      cli, 'buy', '--policy', policyPath,
      '--credential-file', credentialPath,
      '--request-file', requestPath,
      '--signing-key-file', signingPath,
      '--idempotency-key', 'must-not-send',
    ], { cwd: join(root, '..'), stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [], err = [];
    for await (const chunk of child.stdout) out.push(chunk);
    for await (const chunk of child.stderr) err.push(chunk);
    const code = await new Promise(resolve => child.on('close', resolve));
    const stdout = Buffer.concat(out).toString('utf8');
    const stderr = Buffer.concat(err).toString('utf8');
    assert.notEqual(code, 0);
    assert.equal(hits, 0);
    assert.equal(stdout, '');
    assert.match(stderr, /Market verification or purchase failed/);
    assert.ok(!stderr.includes('market_identity_verified'));
    assert.ok(!stderr.includes('bearer-secret'));
    assert.ok(!stderr.includes('allowSimulatedHardware'));
    assert.ok(!stderr.includes('controlled_local'));
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
