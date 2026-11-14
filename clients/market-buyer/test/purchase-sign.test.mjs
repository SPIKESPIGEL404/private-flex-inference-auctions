import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  bodySha256, decodeBase58, encodeBase58, freshNonce, generateBuyerKeypair,
  jcsBytes, parseSecretKey, publicKeyString, signPurchase,
} from '../purchase-sign.mjs';

test('NEAR ed25519 key round-trip and purchase signature headers', () => {
  const pair = generateBuyerKeypair();
  assert.match(pair.publicKey, /^ed25519:[1-9A-HJ-NP-Za-km-z]+$/);
  assert.match(pair.secretKey, /^ed25519:[1-9A-HJ-NP-Za-km-z]+$/);
  const parsed = parseSecretKey(pair.secretKey);
  assert.equal(publicKeyString(parsed.publicKey), pair.publicKey);
  assert.deepEqual(parsed.seed, pair.seed);
  const body = Buffer.from('{"stream":true,"bitrouter_purchase":{}}');
  const nonce = freshNonce();
  assert.match(nonce, /^[a-f0-9]{64}$/);
  const signed = signPurchase({
    seed: pair.seed,
    publicKey: pair.publicKey,
    body,
    idempotencyKey: 'order-1',
    keyset: 'sha256:' + 'ab'.repeat(32),
    nonce,
    ts: 1_700_000_000,
  });
  assert.equal(signed.headers['x-buyer-key'], pair.publicKey);
  assert.equal(signed.headers['x-buyer-nonce'], nonce);
  assert.equal(signed.headers['x-buyer-ts'], '1700000000');
  assert.match(signed.headers['x-buyer-signature'], /^[a-f0-9]{128}$/);
  assert.equal(signed.statement.body_sha256, bodySha256(body));
  assert.deepEqual(JSON.parse(jcsBytes({ b: 1, a: 2 }).toString()), { a: 2, b: 1 });
  assert.equal(encodeBase58(decodeBase58('TJ')), 'TJ');
});
