// No-leak acceptance driver: success, dual replay, failures, buyer-2 isolation.
// Writes every HTTP exchange (status, headers, body) to config.httpLogFile.
import assert from 'node:assert/strict';
import { readFile, appendFile, writeFile } from 'node:fs/promises';
import { freshNonce, readSigningKey, signPurchase } from '../purchase-sign.mjs';
import { sealPurchaseRequest } from '../purchase-e2ee.mjs';
import {
  parseSignedReceiptJson,
  verifySignedReceipt,
} from '../receipt-verify.mjs';

const [configFile, scenario] = process.argv.slice(2);
const config = JSON.parse(await readFile(configFile, 'utf8'));
const token = config.token;
const keysetDigest = config.keyset;
const verifiedKeyset = config.verifiedKeyset;
const idempotencyKey = config.idempotencyKey;
const marketUrl = config.marketUrl;
const chatUrl = marketUrl + '/market/v1/chat/completions';
const signing = config.signingKeyFile ? await readSigningKey(config.signingKeyFile) : null;
const plaintextBody = config.body;
const httpLogFile = config.httpLogFile;

async function logHttp(label, response, text) {
  // Log response only — request material is buyer-held and must not pollute scans.
  if (!httpLogFile) return;
  const headers = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  await appendFile(
    httpLogFile,
    JSON.stringify({
      label,
      status: response.status,
      headers,
      body: text,
    }) + '\n',
  );
}

function signAndHeaders(body, extraHeaders = {}, overrides = {}) {
  const signed = signPurchase({
    seed: overrides.seed || signing.seed,
    publicKey: overrides.publicKey || signing.publicKey,
    body,
    idempotencyKey: overrides.idempotencyKey || idempotencyKey,
    keyset: overrides.keyset || keysetDigest,
    nonce: overrides.nonce || freshNonce(),
    ts: overrides.ts ?? Math.floor(Date.now() / 1000),
  });
  return {
    authorization: 'Bearer ' + (overrides.token || token),
    'content-type': 'application/json',
    'idempotency-key': overrides.idempotencyKey || idempotencyKey,
    ...extraHeaders,
    ...signed.headers,
  };
}

async function postChat(headers, body, label) {
  const response = await fetch(chatUrl, {
    method: 'POST',
    redirect: 'error',
    headers,
    body,
  });
  const text = await response.text();
  await logHttp(label, response, text);
  return { status: response.status, text, headers: response.headers, requestHeaders: headers, body };
}

let result;
if (scenario === 'ok') {
  const sealed = sealPurchaseRequest(plaintextBody, verifiedKeyset);
  const headers = signAndHeaders(sealed.body, sealed.headers);
  const response = await postChat(headers, sealed.body, 'buyer1_success');
  assert.equal(response.status, 200, response.text);
  assert.match(response.text, /\[DONE\]/);
  const capture = {
    headers: response.requestHeaders,
    body_b64: Buffer.from(response.body).toString('base64'),
    e2ee: {
      'x-e2ee-version': response.requestHeaders['x-e2ee-version'],
      'x-client-pub-key': response.requestHeaders['x-client-pub-key'],
      'x-model-pub-key': response.requestHeaders['x-model-pub-key'],
      'x-e2ee-nonce': response.requestHeaders['x-e2ee-nonce'],
      'x-e2ee-timestamp': response.requestHeaders['x-e2ee-timestamp'],
    },
    buyer: {
      'x-buyer-signature': response.requestHeaders['x-buyer-signature'],
      'x-buyer-nonce': response.requestHeaders['x-buyer-nonce'],
    },
  };
  if (config.captureOut) {
    await writeFile(config.captureOut, JSON.stringify(capture) + '\n', { mode: 0o600 });
  }
  result = { scenario, ok: true, capture };
} else if (scenario === 'receipt-ok') {
  const url = marketUrl + '/market/v1/receipts/' + encodeURIComponent(config.requestId) + '/signed';
  const response = await fetch(url, {
    method: 'GET',
    redirect: 'error',
    headers: { authorization: 'Bearer ' + token },
    cache: 'no-store',
  });
  const text = await response.text();
  await logHttp('buyer1_receipt', response, text);
  assert.equal(response.status, 200, text);
  const document = parseSignedReceiptJson(text);
  verifySignedReceipt({
    document,
    requestId: config.requestId,
    workloadKeysetDigest: keysetDigest,
    verifiedKeyset,
  });
  result = { scenario, ok: true, idempotency_key: document.idempotency_key };
} else if (scenario === 'bad-signature') {
  const sealed = sealPurchaseRequest(plaintextBody, verifiedKeyset);
  const headers = signAndHeaders(sealed.body, sealed.headers);
  headers['x-buyer-signature'] = '00'.repeat(64);
  const response = await postChat(headers, sealed.body, 'fail_bad_signature');
  assert.equal(response.status, 401, response.text);
  assert.equal(response.text, 'purchase_signature_invalid');
  result = { scenario, refused: true };
} else if (scenario === 'tampered-ciphertext') {
  const sealed = sealPurchaseRequest(plaintextBody, verifiedKeyset);
  const obj = JSON.parse(sealed.body.toString('utf8'));
  const hex = obj.bitrouter_purchase;
  obj.bitrouter_purchase = hex.slice(0, -2) + (hex.endsWith('00') ? 'ff' : '00');
  const body = Buffer.from(JSON.stringify(obj));
  const response = await postChat(
    signAndHeaders(body, sealed.headers),
    body,
    'fail_tampered_ciphertext',
  );
  assert.equal(response.status, 400, response.text);
  assert.match(response.text, /e2ee_decryption_failed/);
  result = { scenario, refused: true };
} else if (scenario === 'replay-buyer-nonce') {
  assert.ok(config.capture?.headers && config.capture?.body_b64);
  const body = Buffer.from(config.capture.body_b64, 'base64');
  const response = await postChat(config.capture.headers, body, 'fail_replay_buyer_nonce');
  assert.equal(response.status, 401, response.text);
  assert.equal(response.text, 'purchase_signature_invalid');
  result = { scenario, refused: true };
} else if (scenario === 'replay-e2ee-nonce') {
  assert.ok(config.capture?.e2ee);
  const prior = config.capture.e2ee;
  const sealed = sealPurchaseRequest(plaintextBody, verifiedKeyset, {
    nonce: prior['x-e2ee-nonce'],
    ts: Number(prior['x-e2ee-timestamp']),
  });
  const response = await postChat(
    signAndHeaders(sealed.body, prior),
    sealed.body,
    'fail_replay_e2ee_nonce',
  );
  assert.equal(response.status, 400, response.text);
  assert.match(response.text, /e2ee_replay_detected/);
  result = { scenario, refused: true };
} else if (scenario === 'plaintext-caps') {
  const body = Buffer.from(JSON.stringify(plaintextBody));
  const response = await postChat(signAndHeaders(body), body, 'fail_plaintext_caps');
  assert.equal(response.status, 400, response.text);
  assert.match(response.text, /e2ee_header_missing/);
  result = { scenario, refused: true };
} else if (scenario === 'wrong-bearer') {
  const sealed = sealPurchaseRequest(plaintextBody, verifiedKeyset);
  const wrong = config.wrongToken || ('brk_' + '0'.repeat(32) + '.' + '1'.repeat(64));
  const response = await postChat(
    signAndHeaders(sealed.body, sealed.headers, { token: wrong }),
    sealed.body,
    'fail_wrong_bearer',
  );
  assert.equal(response.status, 401, response.text);
  assert.equal(response.text, 'purchase_signature_invalid');
  result = { scenario, refused: true };
} else if (scenario === 'buyer2-status') {
  const url = marketUrl + '/market/v1/requests/' + encodeURIComponent(config.requestId);
  const response = await fetch(url, {
    method: 'GET',
    redirect: 'error',
    headers: { authorization: 'Bearer ' + token },
    cache: 'no-store',
  });
  const text = await response.text();
  await logHttp('buyer2_status', response, text);
  assert.notEqual(response.status, 200);
  result = { scenario, status: response.status, refused: true };
} else if (scenario === 'buyer2-receipt') {
  const url = marketUrl + '/market/v1/receipts/' + encodeURIComponent(config.requestId) + '/signed';
  const response = await fetch(url, {
    method: 'GET',
    redirect: 'error',
    headers: { authorization: 'Bearer ' + token },
    cache: 'no-store',
  });
  const text = await response.text();
  await logHttp('buyer2_receipt', response, text);
  assert.equal(response.status, 404, text);
  assert.equal(text, 'not_found');
  result = { scenario, refused: true };
} else if (scenario === 'public-surfaces') {
  for (const [label, path] of [
    ['public_health', '/healthz'],
    ['public_attestation', '/market/v1/aci/attestation?nonce=' + '11'.repeat(32)],
  ]) {
    const response = await fetch(marketUrl + path, {
      method: 'GET',
      redirect: 'error',
      cache: 'no-store',
    });
    const text = await response.text();
    await logHttp(label, response, text);
    assert.ok(response.status === 200 || response.status === 400, text);
  }
  result = { scenario, ok: true };
} else {
  throw new Error('unknown scenario: ' + scenario);
}

console.log(JSON.stringify(result));
