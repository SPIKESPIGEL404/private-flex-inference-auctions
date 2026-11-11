import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { connectMarket, readPolicy } from './connection.mjs';

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  policy: { type: 'string' }, 'credential-file': { type: 'string' },
  'request-file': { type: 'string' }, 'idempotency-key': { type: 'string' },
} });
let connection;
try {
  if (!['verify', 'buy'].includes(positionals[0]) || positionals.length !== 1 || !values.policy) {
    throw new Error('usage: node cli.mjs <verify|buy> --policy FILE [--credential-file FILE --request-file FILE --idempotency-key KEY]');
  }
  connection = await connectMarket(await readPolicy(values.policy));
  process.stderr.write(JSON.stringify({ market_identity_verified: true, upstream_verified: false,
    compose_hash: connection.identity.composeHash, keyset_digest: connection.identity.workloadKeysetDigest }) + '\n');
  if (positionals[0] === 'buy') {
    const key = values['idempotency-key'];
    if (!values['credential-file'] || !values['request-file'] || !key || key.length > 128 || !key.trim()) {
      throw new Error('buy requires private credential/request files and an idempotency key');
    }
    // Credentials and procurement body are read only after full verification.
    const credential = (await readFile(values['credential-file'], 'utf8')).trim();
    const body = await readFile(values['request-file']);
    if (!credential || body.length > 128 * 1024) throw new Error('invalid bounded purchase input');
    const request = JSON.parse(body);
    if (!request.bitrouter_purchase || request.stream !== true) throw new Error('a streaming Market purchase is required');
    const response = await connection.fetch(connection.baseURL + '/chat/completions', {
      method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json',
        authorization: 'Bearer ' + credential, 'idempotency-key': key }, body,
    });
    for await (const chunk of response.body) {
      if (!process.stdout.write(Buffer.from(chunk))) await new Promise(resolve => process.stdout.once('drain', resolve));
    }
    if (!response.ok) process.exitCode = 1;
  }
} catch {
  // Never serialize an HTTP error carrying request data or credentials.
  process.stderr.write('Market verification or purchase failed; no automatic retry. Preserve the original request identity.\n');
  process.exitCode = 1;
} finally { await connection?.close(); }
