import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGateway } from '../src/server.mjs';
import { setup } from './support.mjs';

const KEYS = [
  'status', 'compose_hash', 'catalog_policy_digest', 'workload_keyset_digest',
  'tls_pinned', 'quote_type', 'checked_at',
];

test('GET /buyer-api/attestation is not_checked without a policy', async t => {
  const env = setup({ fundingEnabled: false });
  t.after(() => env.store.close());
  const { server } = createGateway({ ...env, verifyDeployment: async () => {
    throw new Error('should not run without policy');
  } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/buyer-api`;
  const response = await fetch(base + '/attestation?evil=1', {
    method: 'GET',
    headers: { 'x-evil': '1' },
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(Object.keys(body).sort(), [...KEYS].sort());
  assert.equal(body.status, 'not_checked');
  assert.equal(body.compose_hash, null);
  assert.equal(body.catalog_policy_digest, null);
  assert.equal(body.workload_keyset_digest, null);
  assert.equal(body.tls_pinned, null);
  assert.equal(body.quote_type, null);
  assert.match(body.checked_at, /^\d{4}-/);
  const text = JSON.stringify(body);
  assert.ok(!text.includes('should not run'));
  assert.ok(!text.includes('evil'));
});

test('GET /buyer-api/attestation returns failed with no detail on verifier error', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'attestation-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const policyPath = join(dir, 'policy.json');
  await writeFile(policyPath, JSON.stringify({ version: 1 }));
  const env = setup({
    fundingEnabled: false,
    marketVerifyPolicy: policyPath,
  });
  t.after(() => env.store.close());
  let calls = 0;
  const { server } = createGateway({
    ...env,
    verifyDeployment: async () => {
      calls += 1;
      throw new Error('secret stack trace /path/to/policy.json');
    },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/buyer-api`;
  const response = await fetch(base + '/attestation');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, 'failed');
  assert.equal(calls, 1);
  assert.deepEqual(Object.keys(body).sort(), [...KEYS].sort());
  const text = JSON.stringify(body);
  assert.ok(!text.includes('secret'));
  assert.ok(!text.includes('stack'));
  assert.ok(!text.includes('/path/to'));
  assert.ok(!text.includes('policy.json'));
  assert.equal(body.compose_hash, null);
});
