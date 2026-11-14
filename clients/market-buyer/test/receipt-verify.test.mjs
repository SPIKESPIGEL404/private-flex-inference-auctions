import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import test from 'node:test';
import { jcsBytes } from '../purchase-sign.mjs';
import {
  assertSafeIntegerJsonNumbers,
  parseSignedReceiptJson,
  verifySignedReceipt,
} from '../receipt-verify.mjs';

function keypair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const publicHex = spki.subarray(spki.length - 32).toString('hex');
  return { privateKey, publicHex };
}

function signDocument(privateKey, document) {
  const unsigned = structuredClone(document);
  delete unsigned.signature;
  const signature = cryptoSign(null, jcsBytes(unsigned), privateKey).toString('hex');
  return { ...document, signature };
}

test('unsafe micro-USD integer fails closed before Number coercion', () => {
  const huge = '9007199254740993'; // 2^53 + 1
  const text = `{"purpose":"market.receipt.v1","request_id":"a","receipt":{"financial":{"provider_micro_usd":${huge}}},"signature":"${'ab'.repeat(64)}"}`;
  assert.throws(() => assertSafeIntegerJsonNumbers(text), /unsafe receipt integer/);
  assert.throws(() => parseSignedReceiptJson(text), /unsafe receipt integer/);
});

test('valid signed receipt verifies; wrong request_id fails', () => {
  const { privateKey, publicHex } = keypair();
  const requestId = '11111111-1111-1111-1111-111111111111';
  const digest = 'sha256:' + 'ab'.repeat(32);
  const keyset = {
    receipt_signing_keys: [{ key_id: 'market-ephemeral-v1', algo: 'ed25519', public_key_hex: publicHex }],
  };
  const document = signDocument(privateKey, {
    receipt: {
      request_id: requestId,
      settlement: 'committed',
      status: { status: 'delivered' },
      financial: { provider_micro_usd: 35, platform_micro_usd: 2, cash_micro_usd: 37 },
    },
    idempotency_key: 'demo-1',
    request_id: requestId,
    purpose: 'market.receipt.v1',
    workload_keyset_digest: digest,
    key_id: 'market-ephemeral-v1',
  });
  const verified = verifySignedReceipt({
    document,
    requestId,
    workloadKeysetDigest: digest,
    verifiedKeyset: keyset,
  });
  assert.equal(verified.request_id, requestId);

  assert.throws(() => verifySignedReceipt({
    document,
    requestId: '22222222-2222-2222-2222-222222222222',
    workloadKeysetDigest: digest,
    verifiedKeyset: keyset,
  }), /request_id mismatch/);
});

test('signature under a different keyset fails', () => {
  const a = keypair();
  const b = keypair();
  const requestId = '33333333-3333-3333-3333-333333333333';
  const digest = 'sha256:' + 'cd'.repeat(32);
  const document = signDocument(a.privateKey, {
    receipt: { request_id: requestId, settlement: 'committed', status: { status: 'delivered' },
      financial: { provider_micro_usd: 1, platform_micro_usd: 0, cash_micro_usd: 1 } },
    idempotency_key: 'demo-2',
    request_id: requestId,
    purpose: 'market.receipt.v1',
    workload_keyset_digest: digest,
    key_id: 'market-ephemeral-v1',
  });
  const otherKeyset = {
    receipt_signing_keys: [{ key_id: 'market-ephemeral-v1', algo: 'ed25519', public_key_hex: b.publicHex }],
  };
  assert.throws(() => verifySignedReceipt({
    document,
    requestId,
    workloadKeysetDigest: digest,
    verifiedKeyset: otherKeyset,
  }), /signature verification failed/);
});

test('altered amount fails signature verification', () => {
  const { privateKey, publicHex } = keypair();
  const requestId = '44444444-4444-4444-4444-444444444444';
  const digest = 'sha256:' + 'ef'.repeat(32);
  const keyset = {
    receipt_signing_keys: [{ key_id: 'market-ephemeral-v1', algo: 'ed25519', public_key_hex: publicHex }],
  };
  const document = signDocument(privateKey, {
    receipt: {
      request_id: requestId,
      settlement: 'committed',
      status: { status: 'delivered' },
      financial: { provider_micro_usd: 35, platform_micro_usd: 2, cash_micro_usd: 37 },
    },
    idempotency_key: 'demo-3',
    request_id: requestId,
    purpose: 'market.receipt.v1',
    workload_keyset_digest: digest,
    key_id: 'market-ephemeral-v1',
  });
  document.receipt.financial.provider_micro_usd = 36;
  assert.throws(() => verifySignedReceipt({
    document,
    requestId,
    workloadKeysetDigest: digest,
    verifiedKeyset: keyset,
  }), /signature verification failed/);
});
