// Controlled acceptance helper for signed Market financial receipts.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import {
  parseSignedReceiptJson,
  verifySignedReceipt,
} from '../receipt-verify.mjs';

const [configFile, scenario] = process.argv.slice(2);

try {
  const config = JSON.parse(await readFile(configFile, 'utf8'));
  const url = config.marketUrl + '/market/v1/receipts/' + encodeURIComponent(config.requestId) + '/signed';
  const token = config.token;
  const digest = config.keyset;
  const keyset = config.verifiedKeyset;

  async function fetchRaw() {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'error',
      headers: token ? { authorization: 'Bearer ' + token } : {},
      cache: 'no-store',
    });
    const text = await response.text();
    return { status: response.status, text, headers: response.headers };
  }

  let result;
  if (scenario === 'ok') {
    const response = await fetchRaw();
    assert.equal(response.status, 200, response.text);
    const document = parseSignedReceiptJson(response.text);
    verifySignedReceipt({
      document,
      requestId: config.requestId,
      workloadKeysetDigest: digest,
      verifiedKeyset: keyset,
    });
    if (config.outFile) {
      await writeFile(config.outFile, JSON.stringify({
        signed_receipt: document,
        verified_keyset: keyset,
        workload_keyset_digest: digest,
      }) + '\n', { mode: 0o600 });
    }
    result = { scenario, verified: true, request_id: document.request_id };
  } else if (scenario === 'no-auth') {
    const response = await fetch(url, { method: 'GET', redirect: 'error', cache: 'no-store' });
    const text = await response.text();
    assert.equal(response.status, 401, text);
    assert.equal(text, 'unauthorized');
    result = { scenario, refused: true, status: 401 };
  } else if (scenario === 'other-buyer' || scenario === 'unknown-id' || scenario === 'malformed-id'
    || scenario === 'pending') {
    const response = await fetchRaw();
    assert.equal(response.status, 404, response.text);
    assert.equal(response.text, 'not_found');
    if (config.compareBodyFile) {
      const expected = await readFile(config.compareBodyFile, 'utf8');
      assert.equal(response.text, expected);
    }
    if (config.saveBodyFile) {
      await writeFile(config.saveBodyFile, response.text);
    }
    result = { scenario, refused: true, status: 404 };
  } else if (scenario === 'tampered-amount') {
    const response = await fetchRaw();
    assert.equal(response.status, 200, response.text);
    const document = parseSignedReceiptJson(response.text);
    document.receipt.financial.provider_micro_usd =
      (document.receipt.financial.provider_micro_usd || 0) + 1;
    assert.throws(() => verifySignedReceipt({
      document,
      requestId: config.requestId,
      workloadKeysetDigest: digest,
      verifiedKeyset: keyset,
    }), /signature verification failed/);
    result = { scenario, refused: true };
  } else if (scenario === 'wrong-request-id') {
    const response = await fetchRaw();
    assert.equal(response.status, 200, response.text);
    const document = parseSignedReceiptJson(response.text);
    assert.throws(() => verifySignedReceipt({
      document,
      requestId: '00000000-0000-0000-0000-000000000000',
      workloadKeysetDigest: digest,
      verifiedKeyset: keyset,
    }), /request_id mismatch/);
    result = { scenario, refused: true };
  } else if (scenario === 'wrong-keyset') {
    const response = await fetchRaw();
    assert.equal(response.status, 200, response.text);
    const document = parseSignedReceiptJson(response.text);
    const other = structuredClone(keyset);
    const key = other.receipt_signing_keys[0];
    const field = key.public_key !== undefined ? 'public_key' : 'public_key_hex';
    key[field] = (key[field].startsWith('0') ? '1' : '0') + key[field].slice(1);
    assert.throws(() => verifySignedReceipt({
      document,
      requestId: config.requestId,
      workloadKeysetDigest: digest,
      verifiedKeyset: other,
    }), /signature verification failed/);
    result = { scenario, refused: true };
  } else {
    throw new Error('unknown scenario');
  }

  process.stdout.write(JSON.stringify(result) + '\n');
} catch (error) {
  process.stderr.write(String(error && error.stack || error) + '\n');
  process.exitCode = 1;
}
