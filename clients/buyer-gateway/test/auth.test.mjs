import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Auth } from '../src/auth.mjs';
import { Store } from '../src/store.mjs';
import { GatewayError } from '../src/errors.mjs';
import { ownerKeys } from './support.mjs';
import bs58 from 'bs58';

test('real Ed25519 login verifies full access, rotates a session, and rejects replay', async t => {
  const store = new Store(':memory:', randomBytes(32)); t.after(() => store.close());
  const keys = ownerKeys(); let checks = 0;
  const auth = new Auth(store, { fullAccess: async (account, key) => {
    assert.equal(account, keys.owner.account_id); assert.equal(key, keys.owner.public_key); checks++;
  } }, 'https://market.example');
  const challenge = auth.challenge();
  assert.equal(JSON.parse(challenge.payload.message).origin, 'https://market.example');
  assert.equal(JSON.parse(challenge.payload.message).network, 'mainnet');
  const proof = { accountId: keys.owner.account_id, publicKey: keys.owner.public_key, signature: keys.sign(challenge.payload) };
  const session = await auth.verify(challenge.token, proof);
  assert.deepEqual(auth.owner(session.token), keys.owner);
  await assert.rejects(auth.verify(challenge.token, proof), { code: 'login_challenge_expired' });
  assert.equal(checks, 1);
  auth.logout(session.token);
  assert.throws(() => auth.owner(session.token), { code: 'login_required' });
});

test('NEAR wallet signatures support the documented base64, base58, and hex encodings', async t => {
  const store = new Store(':memory:', randomBytes(32)); t.after(() => store.close());
  const auth = new Auth(store, { fullAccess: async () => {} }, 'https://market.example');
  const keys = ownerKeys();
  for (const encode of [bytes => bytes.toString('base64'), bytes => bs58.encode(bytes), bytes => bytes.toString('hex')]) {
    const challenge = auth.challenge();
    const result = await auth.verify(challenge.token, { accountId: keys.owner.account_id, publicKey: keys.owner.public_key,
      signature: encode(Buffer.from(keys.sign(challenge.payload), 'base64')) });
    assert.deepEqual(auth.owner(result.token), keys.owner);
  }
});

test('a different challenge/domain, expired login, or function-call key cannot create a session', async t => {
  const store = new Store(':memory:', randomBytes(32)); t.after(() => store.close());
  const keys = ownerKeys(); let now = Date.now();
  const auth = new Auth(store, { fullAccess: async () => { throw new GatewayError('owner_key_not_full_access', 403); } }, 'https://market.example', () => now);
  const a = auth.challenge(), b = auth.challenge();
  const signed = payload => ({ accountId: keys.owner.account_id, publicKey: keys.owner.public_key, signature: keys.sign(payload) });
  await assert.rejects(auth.verify(b.token, signed(a.payload)), { code: 'invalid_signature' });
  const c = auth.challenge();
  await assert.rejects(auth.verify(c.token, signed({ ...c.payload, recipient: 'another.example' })), { code: 'invalid_signature' });
  const d = auth.challenge();
  await assert.rejects(auth.verify(d.token, signed(d.payload)), { code: 'owner_key_not_full_access' });
  now += 301_000;
  await assert.rejects(auth.verify(a.token, signed(a.payload)), { code: 'login_challenge_expired' });
});
