// Controlled signed-purchase scenarios against the loopback Market HTTP port.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  freshNonce, generateBuyerKeypair, readSigningKey, signPurchase,
} from '../purchase-sign.mjs';

const [configFile, scenario] = process.argv.slice(2);
const config = JSON.parse(await readFile(configFile, 'utf8'));
const body = Buffer.from(JSON.stringify(config.body));
const token = config.token;
const keyset = config.keyset;
const idempotencyKey = config.idempotencyKey || `sign-${scenario}`;
const url = config.marketUrl + '/market/v1/chat/completions';
const signing = config.signingKeyFile ? await readSigningKey(config.signingKeyFile) : null;
const other = config.otherSigningKeyFile ? await readSigningKey(config.otherSigningKeyFile) : null;

function base(overrides = {}) {
  const seed = overrides.seed || signing.seed;
  const publicKey = overrides.publicKey || signing.publicKey;
  const nonce = overrides.nonce || freshNonce();
  const ts = overrides.ts ?? Math.floor(Date.now() / 1000);
  const wire = overrides.body || body;
  const signed = signPurchase({
    seed, publicKey, body: wire,
    idempotencyKey: overrides.idempotencyKey || idempotencyKey,
    keyset: overrides.keyset || keyset, nonce, ts,
  });
  return {
    headers: {
      authorization: 'Bearer ' + (overrides.token || token),
      'content-type': 'application/json',
      'idempotency-key': overrides.idempotencyKey || idempotencyKey,
      ...signed.headers,
      ...overrides.headers,
    },
    body: wire,
  };
}

async function post(input) {
  const response = await fetch(url, {
    method: 'POST', redirect: 'error', headers: input.headers, body: input.body,
  });
  return { status: response.status, text: await response.text() };
}

async function expectInvalid(input) {
  const response = await post(input);
  assert.equal(response.status, 401);
  assert.equal(response.text, 'purchase_signature_invalid');
}

let result;
if (scenario === 'ok') {
  const response = await post(base({ idempotencyKey: config.idempotencyKey || 'sign-ok' }));
  assert.equal(response.status, 200, response.text);
  result = { scenario, ok: true };
} else if (scenario === 'unregistered') {
  const forged = generateBuyerKeypair();
  await expectInvalid(base({ seed: forged.seed, publicKey: forged.publicKey }));
  result = { scenario, refused: true };
} else if (scenario === 'other-buyer') {
  assert.ok(other);
  await expectInvalid(base({ seed: other.seed, publicKey: other.publicKey }));
  result = { scenario, refused: true };
} else if (scenario === 'bad-signature') {
  const input = base();
  input.headers['x-buyer-signature'] = '00'.repeat(64);
  await expectInvalid(input);
  result = { scenario, refused: true };
} else if (scenario === 'body-changed') {
  const input = base();
  await expectInvalid({
    ...input,
    body: Buffer.from(JSON.stringify({ ...config.body, max_completion_tokens: 63 })),
  });
  result = { scenario, refused: true };
} else if (scenario === 'stale-ts') {
  await expectInvalid(base({ ts: Math.floor(Date.now() / 1000) - 301 }));
  result = { scenario, refused: true };
} else if (scenario === 'before-start') {
  await expectInvalid(base({ ts: 1 }));
  result = { scenario, refused: true };
} else if (scenario === 'keyset-mismatch') {
  await expectInvalid(base({ keyset: 'sha256:' + 'ff'.repeat(32) }));
  result = { scenario, refused: true };
} else if (scenario === 'replay-captured') {
  assert.ok(config.capture);
  const response = await post({
    headers: config.capture.headers,
    body: Buffer.from(config.capture.body, 'base64'),
  });
  assert.equal(response.status, 401);
  assert.equal(response.text, 'purchase_signature_invalid');
  result = { scenario, refused: true };
} else {
  throw new Error('unknown scenario');
}

console.log(JSON.stringify(result));
