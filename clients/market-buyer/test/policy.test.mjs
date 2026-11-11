import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertBootPolicy, validatePolicy } from '../connection.mjs';

const profile = Object.fromEntries(['mrtd', 'rtmr0', 'rtmr1', 'rtmr2'].map(k => [k, '00'.repeat(48)]));
const policy = { version: 1, baseURL: 'https://example.invalid/market/v1',
  acceptedComposeHashes: ['a'.repeat(64)], acceptedBootMeasurements: [profile] };
const quote = () => { const b = Buffer.alloc(632); b.writeUInt16LE(4); b.writeUInt32LE(0x81, 4); return b; };
const report = b => ({ attestation: { evidence: { quote: b.toString('hex') } } });

test('a buyer must choose reviewed releases and production boot measurements', () => {
  assert.deepEqual(validatePolicy(policy), policy);
  for (const field of ['acceptedComposeHashes', 'acceptedBootMeasurements']) {
    assert.throws(() => validatePolicy({ ...policy, [field]: [] }));
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
