import {
  createHash, createPrivateKey, createPublicKey, sign as cryptoSign, randomBytes,
} from 'node:crypto';
import { readFile } from 'node:fs/promises';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

export function encodeBase58(buffer) {
  if (buffer.length === 0) return '';
  let zeros = 0;
  while (zeros < buffer.length && buffer[zeros] === 0) zeros += 1;
  const digits = [0];
  for (let i = zeros; i < buffer.length; i += 1) {
    let carry = buffer[i];
    for (let j = 0; j < digits.length; j += 1) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = '1'.repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i -= 1) out += B58[digits[i]];
  return out;
}

export function decodeBase58(text) {
  requireValue(typeof text === 'string' && text.length > 0, 'invalid base58');
  let zeros = 0;
  while (zeros < text.length && text[zeros] === '1') zeros += 1;
  const bytes = [0];
  for (let i = zeros; i < text.length; i += 1) {
    const value = B58.indexOf(text[i]);
    requireValue(value >= 0, 'invalid base58');
    let carry = value;
    for (let j = 0; j < bytes.length; j += 1) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  const out = Buffer.alloc(zeros + bytes.length);
  for (let i = 0; i < bytes.length; i += 1) out[out.length - 1 - i] = bytes[i];
  return out;
}

export function jcsBytes(value) {
  return Buffer.from(JSON.stringify(sortValue(value)), 'utf8');
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      requireValue(/^[\x00-\x7F]*$/.test(key), 'non-ascii JCS field');
      out[key] = sortValue(value[key]);
    }
    return out;
  }
  requireValue(typeof value !== 'number' || Number.isSafeInteger(value), 'non-integer JCS number');
  return value;
}

export function bodySha256(body) {
  return 'sha256:' + createHash('sha256').update(body).digest('hex');
}

export function parseSecretKey(text) {
  const trimmed = text.trim();
  requireValue(trimmed.startsWith('ed25519:'), 'signing key must use the ed25519 NEAR format');
  const raw = decodeBase58(trimmed.slice('ed25519:'.length));
  requireValue(raw.length === 64, 'signing key must decode to 64 bytes');
  return { seed: raw.subarray(0, 32), publicKey: raw.subarray(32) };
}

export function publicKeyString(publicKey) {
  return 'ed25519:' + encodeBase58(publicKey);
}

export function signingKeyFromSeed(seed) {
  requireValue(Buffer.isBuffer(seed) && seed.length === 32, 'ed25519 seed must be 32 bytes');
  return createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' });
}

export function generateBuyerKeypair() {
  const seed = randomBytes(32);
  const key = signingKeyFromSeed(seed);
  // Derive the 32-byte public key from the SPKI encoding.
  const spki = createPublicKey(key).export({ type: 'spki', format: 'der' });
  const publicKey = spki.subarray(spki.length - 32);
  const secret = Buffer.concat([seed, publicKey]);
  return {
    publicKey: publicKeyString(publicKey),
    secretKey: 'ed25519:' + encodeBase58(secret),
    seed,
    publicKeyBytes: publicKey,
  };
}

export function signPurchase({ seed, publicKey, body, idempotencyKey, keyset, nonce, ts }) {
  const statement = {
    purpose: 'market.purchase.v1',
    method: 'POST',
    path: '/market/v1/chat/completions',
    body_sha256: bodySha256(body),
    idempotency_key: idempotencyKey,
    nonce,
    ts,
    keyset,
  };
  const signature = cryptoSign(null, jcsBytes(statement), signingKeyFromSeed(seed));
  return {
    headers: {
      'x-buyer-key': typeof publicKey === 'string' ? publicKey : publicKeyString(publicKey),
      'x-buyer-nonce': nonce,
      'x-buyer-ts': String(ts),
      'x-buyer-signature': signature.toString('hex'),
    },
    statement,
  };
}

export async function readSigningKey(path) {
  const parsed = parseSecretKey(await readFile(path, 'utf8'));
  return {
    seed: parsed.seed,
    publicKey: publicKeyString(parsed.publicKey),
    publicKeyBytes: parsed.publicKey,
  };
}

export function freshNonce() {
  return randomBytes(32).toString('hex');
}
