import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertBootPolicy, assertMarketPolicy, validatePolicy } from '../connection.mjs';

const profile = Object.fromEntries(['mrtd', 'rtmr0', 'rtmr1', 'rtmr2'].map(k => [k, '00'.repeat(48)]));
const digest = 'sha256:' + 'ab'.repeat(32);
const policy = { version: 1, baseURL: 'https://example.invalid/market/v1',
  acceptedComposeHashes: ['a'.repeat(64)], acceptedBootMeasurements: [profile],
  acceptedPolicyDigests: [digest] };
const quote = () => { const b = Buffer.alloc(632); b.writeUInt16LE(4); b.writeUInt32LE(0x81, 4); return b; };
const report = b => ({ attestation: { evidence: { quote: b.toString('hex') } } });

test('a buyer must choose reviewed releases and production boot measurements', () => {
  assert.deepEqual(validatePolicy(policy), policy);
  for (const field of ['acceptedComposeHashes', 'acceptedBootMeasurements', 'acceptedPolicyDigests']) {
    assert.throws(() => validatePolicy({ ...policy, [field]: [] }));
  }
  const missing = { ...policy };
  delete missing.acceptedPolicyDigests;
  assert.throws(() => validatePolicy(missing));
  for (const bad of ['ab'.repeat(32), 'sha256:' + 'AB'.repeat(32), 'sha256:' + 'a'.repeat(63), 'sha256:' + 'g'.repeat(64)]) {
    assert.throws(() => validatePolicy({ ...policy, acceptedPolicyDigests: [bad] }));
  }
  for (const baseURL of ['http://example.invalid/market/v1', 'https://example.invalid/v1', 'https://a:b@example.invalid/market/v1']) {
    assert.throws(() => validatePolicy({ ...policy, baseURL }));
  }
});

test('debug and unreviewed boot quotes are rejected independently of compose', () => {
  assertBootPolicy(report(quote()), policy);
  for (const offset of [184, 376, 424, 472]) {
    const b = quote(); b[offset] = 1;
    assert.throws(() => assertBootPolicy(report(b), policy));
  }
  const debug = quote(); debug[168] = 1;
  assert.throws(() => assertBootPolicy(report(debug), policy), /debug/);
  assert.throws(() => assertBootPolicy(report(Buffer.alloc(20)), policy));
});

test('the attested subject must carry an accepted catalog digest', () => {
  const accepted = { attestation: { workload_keyset: { subject: 'market-policy:' + digest } } };
  assertMarketPolicy(accepted, policy);
  assert.throws(() => assertMarketPolicy({ attestation: { workload_keyset: { subject: null } } }, policy));
  assert.throws(() => assertMarketPolicy({ attestation: { workload_keyset: { subject: digest } } }, policy));
  assert.throws(() => assertMarketPolicy({
    attestation: { workload_keyset: { subject: 'market-policy:sha256:' + 'ff'.repeat(32) } },
  }, policy));
});
