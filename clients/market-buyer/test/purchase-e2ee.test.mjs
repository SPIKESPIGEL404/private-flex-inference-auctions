import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  decryptPurchaseField,
  encryptPurchaseField,
  generateX25519Keypair,
  jcsBytes,
  selectMarketE2eeKey,
} from '../purchase-e2ee.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const vectorsDir = join(here, 'vectors');
mkdirSync(vectorsDir, { recursive: true });

function rawPublic(publicKey) {
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  return spki.subarray(spki.length - 32);
}

test('selectMarketE2eeKey requires market-e2ee-v1 from verified keyset', () => {
  const pub = generateX25519Keypair().publicKeyHex;
  assert.equal(
    selectMarketE2eeKey({
      e2ee_public_keys: [
        { key_id: 'market-e2ee-v1', algo: 'x25519-aes-256-gcm-hkdf-sha256', public_key: pub },
      ],
    }),
    pub,
  );
  assert.throws(() => selectMarketE2eeKey({ e2ee_public_keys: [] }));
});

test('node round-trip and write node-to-rust vector', () => {
  const seed = Buffer.alloc(32, 0x37);
  const prefix = Buffer.from('302e020100300506032b656e04220420', 'hex');
  const privateKey = createPrivateKey({ key: Buffer.concat([prefix, seed]), format: 'der', type: 'pkcs8' });
  const publicKey = createPublicKey(privateKey);
  const servicePublicKeyHex = rawPublic(publicKey).toString('hex');
  const nonce = 'cd'.repeat(32);
  const ts = 1700000001;
  const purchase = {
    service_type: 'on_demand',
    provider_cap_micro_usd: 4500,
    total_cap_micro_usd: 4510,
  };
  const enc = encryptPurchaseField({
    servicePublicKeyHex,
    model: 'm/external',
    purchaseObject: purchase,
    nonce,
    ts,
  });
  const out = decryptPurchaseField({
    serviceSecretRaw32: seed,
    ciphertextHex: enc.ciphertextHex,
    model: 'm/external',
    nonce,
    ts,
  });
  assert.deepEqual(out, purchase);
  writeFileSync(
    join(vectorsDir, 'e2ee-node-to-rust.json'),
    JSON.stringify({
      secret_hex: seed.toString('hex'),
      model: 'm/external',
      nonce,
      ts,
      purchase,
      ciphertext_hex: enc.ciphertextHex,
      aad_utf8: jcsBytes({
        purpose: 'aci.e2ee.request.v2',
        algo: 'x25519-aes-256-gcm-hkdf-sha256',
        model: 'm/external',
        field: 'bitrouter_purchase',
        nonce,
        ts,
      }).toString('utf8'),
    }, null, 2) + '\n',
  );
});

test('node decrypts rust-produced vector when present', () => {
  const path = join(vectorsDir, 'e2ee-rust-to-node.json');
  let vector;
  try {
    vector = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return;
  }
  const out = decryptPurchaseField({
    serviceSecretRaw32: Buffer.from(vector.secret_hex, 'hex'),
    ciphertextHex: vector.ciphertext_hex,
    model: vector.model,
    nonce: vector.nonce,
    ts: vector.ts,
  });
  assert.deepEqual(out, vector.purchase);
});
