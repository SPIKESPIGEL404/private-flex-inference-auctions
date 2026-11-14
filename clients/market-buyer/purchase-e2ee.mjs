// Market purchase E2EE: reuses ACI E2EE v2 X25519 construction for
// bitrouter_purchase only. Not a full ACI E2EE v2 client.
import {
  createPrivateKey,
  createPublicKey,
  createHmac,
  createCipheriv,
  createDecipheriv,
  diffieHellman,
  generateKeyPairSync,
  randomBytes,
} from 'node:crypto';

export const E2EE_VERSION = '2';
export const E2EE_ALGO = 'x25519-aes-256-gcm-hkdf-sha256';
export const E2EE_KEY_ID = 'market-e2ee-v1';
export const FIELD_PURCHASE = 'bitrouter_purchase';
export const AAD_PURPOSE = 'aci.e2ee.request.v2';
const HKDF_INFO = Buffer.from('aci.e2ee.v2.x25519');

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
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
  requireValue(typeof value !== 'number' || Number.isInteger(value), 'non-integer JCS number');
  return value;
}

export function jcsBytes(value) {
  return Buffer.from(JSON.stringify(sortValue(value)), 'utf8');
}

function hkdfSha256(ikm, info, length) {
  // salt = none ⇒ HashLen zero bytes (RFC 5869 / ACI E2EE v2 §4).
  const prk = createHmac('sha256', Buffer.alloc(32, 0)).update(ikm).digest();
  requireValue(length <= 32, 'HKDF length');
  const t = createHmac('sha256', prk).update(Buffer.concat([info, Buffer.from([1])])).digest();
  return t.subarray(0, length);
}

function rawPublicFromKeyObject(publicKey) {
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  return spki.subarray(spki.length - 32);
}

function privateKeyFromRaw(raw32) {
  const prefix = Buffer.from('302e020100300506032b656e04220420', 'hex');
  return createPrivateKey({ key: Buffer.concat([prefix, raw32]), format: 'der', type: 'pkcs8' });
}

function publicKeyFromRaw(raw32) {
  const prefix = Buffer.from('302a300506032b656e032100', 'hex');
  return createPublicKey({ key: Buffer.concat([prefix, raw32]), format: 'der', type: 'spki' });
}

export function generateX25519Keypair() {
  const { privateKey, publicKey } = generateKeyPairSync('x25519');
  return {
    privateKey,
    publicKey,
    publicKeyHex: rawPublicFromKeyObject(publicKey).toString('hex'),
  };
}

export function selectMarketE2eeKey(keyset) {
  const keys = keyset?.e2ee_public_keys;
  requireValue(Array.isArray(keys), 'verified keyset missing e2ee_public_keys');
  const entry = keys.find((k) => k.key_id === E2EE_KEY_ID && k.algo === E2EE_ALGO);
  requireValue(entry && typeof entry.public_key === 'string', 'market-e2ee-v1 key missing from verified keyset');
  return entry.public_key.replace(/^0x/, '').toLowerCase();
}

export function encryptPurchaseField({
  servicePublicKeyHex, model, purchaseObject, nonce, ts, clientKeypair,
}) {
  requireValue(typeof model === 'string', 'model must be a string');
  requireValue(
    purchaseObject && typeof purchaseObject === 'object' && !Array.isArray(purchaseObject),
    'purchase object',
  );
  const plaintext = Buffer.from(JSON.stringify(purchaseObject), 'utf8');
  const aad = jcsBytes({
    purpose: AAD_PURPOSE,
    algo: E2EE_ALGO,
    model,
    field: FIELD_PURCHASE,
    nonce,
    ts,
  });
  const client = clientKeypair || generateX25519Keypair();
  const ephemeral = generateX25519Keypair();
  const recipient = publicKeyFromRaw(Buffer.from(servicePublicKeyHex.replace(/^0x/, ''), 'hex'));
  const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipient });
  const key = hkdfSha256(shared, HKDF_INFO, 32);
  const gcmNonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, gcmNonce);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const ephPub = Buffer.from(ephemeral.publicKeyHex, 'hex');
  const wire = Buffer.concat([ephPub, gcmNonce, ciphertext, tag]).toString('hex');
  return {
    ciphertextHex: wire,
    headers: {
      'x-e2ee-version': E2EE_VERSION,
      'x-client-pub-key': client.publicKeyHex,
      'x-model-pub-key': servicePublicKeyHex.replace(/^0x/, '').toLowerCase(),
      'x-e2ee-nonce': nonce,
      'x-e2ee-timestamp': String(ts),
    },
    clientPublicKeyHex: client.publicKeyHex,
    aad,
  };
}

export function decryptPurchaseField({
  serviceSecretRaw32, ciphertextHex, model, nonce, ts,
}) {
  const aad = jcsBytes({
    purpose: AAD_PURPOSE,
    algo: E2EE_ALGO,
    model,
    field: FIELD_PURCHASE,
    nonce,
    ts,
  });
  const blob = Buffer.from(ciphertextHex.replace(/^0x/, ''), 'hex');
  requireValue(blob.length >= 32 + 12 + 16, 'ciphertext too short');
  const ephPub = blob.subarray(0, 32);
  const gcmNonce = blob.subarray(32, 44);
  const body = blob.subarray(44);
  const ciphertext = body.subarray(0, body.length - 16);
  const tag = body.subarray(body.length - 16);
  const secret = privateKeyFromRaw(Buffer.from(serviceSecretRaw32));
  const shared = diffieHellman({
    privateKey: secret,
    publicKey: publicKeyFromRaw(ephPub),
  });
  const key = hkdfSha256(shared, HKDF_INFO, 32);
  const decipher = createDecipheriv('aes-256-gcm', key, gcmNonce);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plain.toString('utf8'));
}

/** Build wire body + E2EE headers from a plaintext request object and verified keyset. */
export function sealPurchaseRequest(requestObject, verifiedKeyset, opts = {}) {
  requireValue(requestObject?.bitrouter_purchase, 'bitrouter_purchase required');
  const servicePublicKeyHex = selectMarketE2eeKey(verifiedKeyset);
  const nonce = opts.nonce || randomBytes(32).toString('hex');
  const ts = opts.ts ?? Math.floor(Date.now() / 1000);
  const sealed = encryptPurchaseField({
    servicePublicKeyHex,
    model: requestObject.model,
    purchaseObject: requestObject.bitrouter_purchase,
    nonce,
    ts,
    clientKeypair: opts.clientKeypair,
  });
  const bodyObject = { ...requestObject, bitrouter_purchase: sealed.ciphertextHex };
  const body = Buffer.from(JSON.stringify(bodyObject), 'utf8');
  return { body, bodyObject, headers: sealed.headers, nonce, ts, servicePublicKeyHex };
}
