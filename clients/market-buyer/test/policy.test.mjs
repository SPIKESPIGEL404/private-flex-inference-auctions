import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { verifyComposeMeasurement } from '@phala/aci-verifier';
import { assertBootPolicy, assertMarketPolicy, assertMeasuredEvents, validatePolicy } from '../connection.mjs';

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

test('runtime payload substitution cannot retain a valid digest chain', async () => {
  // A unit fixture for event integrity, never accepted as signed hardware.
  const compose = 'services: {}\n';
  const sha = (v, alg) => createHash(alg).update(v).digest();
  const events = [['app-id','12'.repeat(20)],['compose-hash',sha(compose,'sha256').toString('hex')],['system-ready','']]
    .map(([event,event_payload]) => {
      const kind=Buffer.alloc(4);kind.writeUInt32LE(0x08000001);
      return {imr:3,event_type:0x08000001,event,event_payload,
        digest:sha(Buffer.concat([kind,Buffer.from(':'+event+':'),Buffer.from(event_payload,'hex')]),'sha384').toString('hex')};
    });
  let mr=Buffer.alloc(48);
  for(const event of events) mr=sha(Buffer.concat([mr,Buffer.from(event.digest,'hex')]),'sha384');
  const q=quote();mr.copy(q,520);
  const good=report(q);Object.assign(good.attestation.evidence,{app_compose:compose,event_log:JSON.stringify(events)});
  const expected={...policy,acceptedAppId:'12'.repeat(20)};
  assertMeasuredEvents(good,expected);
  assert.throws(()=>assertMeasuredEvents(good,{...expected,acceptedAppId:'34'.repeat(20)}),/app ID/);
  const forged=structuredClone(good), altered=structuredClone(events);
  forged.attestation.evidence.app_compose='services: {attacker: {}}\n';
  altered[1].event_payload=sha(forged.attestation.evidence.app_compose,'sha256').toString('hex');
  forged.attestation.evidence.event_log=JSON.stringify(altered);
  // The upstream digest replay alone cannot detect this payload substitution.
  assert.equal((await verifyComposeMeasurement(forged)).ok,true);
  assert.throws(()=>assertMeasuredEvents(forged,expected),/payload does not match/);
});
