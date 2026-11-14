/** Verify a Market signed financial receipt against an established keyset. */
import { createPublicKey, verify as cryptoVerify } from 'node:crypto';
import { jcsBytes } from './purchase-sign.mjs';

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER);

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

/** Scan JSON text for number literals that are not IEEE-safe integers. */
export function assertSafeIntegerJsonNumbers(text) {
  requireValue(typeof text === 'string' && text.length > 0, 'receipt body required');
  requireValue(text.length <= 256 * 1024, 'receipt body too large');
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === '"') {
      i += 1;
      while (i < n) {
        if (text[i] === '\\') {
          i += 2;
          continue;
        }
        if (text[i] === '"') {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      const start = i;
      if (ch === '-') i += 1;
      requireValue(i < n && text[i] >= '0' && text[i] <= '9', 'invalid JSON number');
      if (text[i] === '0') i += 1;
      else while (i < n && text[i] >= '0' && text[i] <= '9') i += 1;
      if (i < n && (text[i] === '.' || text[i] === 'e' || text[i] === 'E')) {
        throw new Error('non-integer receipt number');
      }
      const literal = text.slice(start, i);
      const value = BigInt(literal);
      requireValue(value <= MAX_SAFE && value >= MIN_SAFE, 'unsafe receipt integer');
      continue;
    }
    i += 1;
  }
}

function walkSafeNumbers(value) {
  if (Array.isArray(value)) {
    for (const item of value) walkSafeNumbers(item);
    return;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) walkSafeNumbers(item);
    return;
  }
  if (typeof value === 'number') {
    requireValue(Number.isSafeInteger(value), 'unsafe receipt integer');
  }
}

export function parseSignedReceiptJson(text) {
  assertSafeIntegerJsonNumbers(text);
  const document = JSON.parse(text);
  walkSafeNumbers(document);
  return document;
}

function receiptSigningInput(document) {
  const unsigned = structuredClone(document);
  delete unsigned.signature;
  return jcsBytes(unsigned);
}

function ed25519PublicKey(hex) {
  requireValue(typeof hex === 'string' && /^[0-9a-f]{64}$/.test(hex), 'invalid receipt public key');
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(hex, 'hex')]),
    format: 'der',
    type: 'spki',
  });
}

export function selectReceiptKey(keyset, keyId) {
  const keys = keyset?.receipt_signing_keys;
  requireValue(Array.isArray(keys), 'receipt_signing_keys missing');
  const entry = keys.find((k) => k && k.key_id === keyId);
  requireValue(entry && entry.algo === 'ed25519', 'receipt key missing or unsupported');
  // ACI wire name is `public_key` (serde rename from public_key_hex).
  const hex = (entry.public_key || entry.public_key_hex || '').replace(/^0x/, '').toLowerCase();
  requireValue(/^[0-9a-f]{64}$/.test(hex), 'invalid receipt public key');
  return { ...entry, public_key_hex: hex };
}

/**
 * @param {object} args
 * @param {object|string} args.document parsed object or raw JSON text
 * @param {string} args.requestId expected request id
 * @param {string} args.workloadKeysetDigest verified keyset digest
 * @param {object} args.verifiedKeyset workload keyset from attestation
 */
export function verifySignedReceipt({
  document,
  requestId,
  workloadKeysetDigest,
  verifiedKeyset,
}) {
  const parsed = typeof document === 'string' ? parseSignedReceiptJson(document) : document;
  if (typeof document !== 'string') walkSafeNumbers(parsed);
  requireValue(parsed && typeof parsed === 'object', 'invalid receipt document');
  requireValue(parsed.purpose === 'market.receipt.v1', 'unexpected receipt purpose');
  requireValue(parsed.request_id === requestId, 'receipt request_id mismatch');
  requireValue(
    parsed.workload_keyset_digest === workloadKeysetDigest,
    'receipt keyset digest mismatch',
  );
  requireValue(typeof parsed.idempotency_key === 'string' && parsed.idempotency_key.length > 0
    && parsed.idempotency_key.length <= 128, 'invalid idempotency_key');
  requireValue(parsed.receipt && typeof parsed.receipt === 'object', 'missing market receipt');
  requireValue(typeof parsed.signature === 'string' && /^[0-9a-f]+$/.test(parsed.signature)
    && parsed.signature.length === 128, 'invalid receipt signature');
  const key = selectReceiptKey(verifiedKeyset, parsed.key_id);
  const ok = cryptoVerify(
    null,
    receiptSigningInput(parsed),
    ed25519PublicKey(key.public_key_hex),
    Buffer.from(parsed.signature, 'hex'),
  );
  requireValue(ok, 'receipt signature verification failed');
  return parsed;
}
