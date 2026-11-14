import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { connectMarket, readPolicy } from './connection.mjs';
import { freshNonce, readSigningKey, signPurchase } from './purchase-sign.mjs';
import { sealPurchaseRequest } from './purchase-e2ee.mjs';
import { parseSignedReceiptJson, verifySignedReceipt } from './receipt-verify.mjs';

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  policy: { type: 'string' }, 'credential-file': { type: 'string' },
  'request-file': { type: 'string' }, 'idempotency-key': { type: 'string' },
  'signing-key-file': { type: 'string' }, 'request-id': { type: 'string' },
  out: { type: 'string' },
} });
let connection;
try {
  const command = positionals[0];
  if (!['verify', 'buy', 'receipt'].includes(command) || positionals.length !== 1 || !values.policy) {
    throw new Error('usage: node cli.mjs <verify|buy|receipt> --policy FILE [...]');
  }
  connection = await connectMarket(await readPolicy(values.policy));
  process.stderr.write(JSON.stringify({ market_identity_verified: true, upstream_verified: false,
    compose_hash: connection.identity.composeHash, keyset_digest: connection.identity.workloadKeysetDigest }) + '\n');
  if (command === 'buy') {
    const key = values['idempotency-key'];
    if (!values['credential-file'] || !values['request-file'] || !values['signing-key-file']
      || !key || key.length > 128 || !key.trim()) {
      throw new Error('buy requires private credential/request/signing-key files and an idempotency key');
    }
    // Credentials, signing key and procurement body are read only after full verification.
    const credential = (await readFile(values['credential-file'], 'utf8')).trim();
    const signing = await readSigningKey(values['signing-key-file']);
    const raw = await readFile(values['request-file']);
    if (!credential || raw.length > 128 * 1024) throw new Error('invalid bounded purchase input');
    const request = JSON.parse(raw);
    if (!request.bitrouter_purchase || request.stream !== true) throw new Error('a streaming Market purchase is required');
    // E2EE key comes only from the verified ACI keyset after connectMarket.
    const sealed = sealPurchaseRequest(request, connection.identity.keyset);
    if (sealed.body.length > 128 * 1024) throw new Error('invalid bounded purchase input');
    const signed = signPurchase({
      seed: signing.seed,
      publicKey: signing.publicKey,
      body: sealed.body,
      idempotencyKey: key,
      keyset: connection.identity.workloadKeysetDigest,
      nonce: freshNonce(),
      ts: Math.floor(Date.now() / 1000),
    });
    const response = await connection.fetch(connection.baseURL + '/chat/completions', {
      method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json',
        authorization: 'Bearer ' + credential, 'idempotency-key': key,
        ...sealed.headers, ...signed.headers }, body: sealed.body,
    });
    for await (const chunk of response.body) {
      if (!process.stdout.write(Buffer.from(chunk))) await new Promise(resolve => process.stdout.once('drain', resolve));
    }
    if (!response.ok) process.exitCode = 1;
  } else if (command === 'receipt') {
    const requestId = values['request-id'];
    if (!values['credential-file'] || !requestId || requestId.length > 64) {
      throw new Error('receipt requires --credential-file and --request-id');
    }
    // Bearer is read only after Market verification succeeded (connection above).
    const credential = (await readFile(values['credential-file'], 'utf8')).trim();
    if (!credential) throw new Error('invalid credential');
    const response = await connection.fetch(
      connection.baseURL + '/receipts/' + encodeURIComponent(requestId) + '/signed',
      { method: 'GET', redirect: 'error', headers: { authorization: 'Bearer ' + credential },
        cache: 'no-store' },
    );
    const text = await response.text();
    if (!response.ok) throw new Error('signed receipt unavailable');
    const document = parseSignedReceiptJson(text);
    verifySignedReceipt({
      document,
      requestId,
      workloadKeysetDigest: connection.identity.workloadKeysetDigest,
      verifiedKeyset: connection.identity.keyset,
    });
    if (values.out) {
      await writeFile(values.out, JSON.stringify({
        signed_receipt: document,
        verified_keyset: connection.identity.keyset,
        workload_keyset_digest: connection.identity.workloadKeysetDigest,
      }, null, 2) + '\n', { mode: 0o600 });
    }
    process.stdout.write(JSON.stringify({
      receipt_verified: true,
      request_id: document.request_id,
      idempotency_key: document.idempotency_key,
      workload_keyset_digest: document.workload_keyset_digest,
    }) + '\n');
  }
} catch {
  // Never serialize an HTTP error carrying request data or credentials.
  process.stderr.write('Market verification or purchase failed; no automatic retry. Preserve the original request identity.\n');
  process.exitCode = 1;
} finally { await connection?.close(); }
