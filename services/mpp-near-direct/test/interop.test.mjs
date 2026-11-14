import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { Challenge } from 'mppx';
import { Mppx as Server } from 'mppx/server';
import { Mppx as Client } from 'mppx/client';
import { AgentApi } from '@near-intents-agent-api/sdk';
import { clientMethod, serverMethod } from '../method.mjs';
import { nativePlan, signedPayload, hash } from '../contract.mjs';
import { fixture, now } from './support.mjs';
import { Harness } from './authority.mjs';
import { verifyPayment } from '../near.mjs';

function harness(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mpp-p0-')), path = join(dir, 'authority.sqlite'), h = new Harness(path);
  t.after(() => { h.close(); rmSync(dir, { recursive: true }); }); return { h, path };
}
test('official mppx client/server 402 -> persisted original proof -> receipt, no second transfer', async t => {
  const { h } = harness(t); const current = Date.now();
  const f = fixture({ request: { issuedAtMs: current, expiresAtMs: current + 60_000 } });
  f.blocks.inclusion = current + 10; f.blocks.settlement = current + 20;
  const server = Server.create({ realm: f.challenge.realm, secretKey: 'controlled-sdk-secret-not-for-deployment-32-bytes',
    methods: [serverMethod({ rpc: f.rpc, authority: h })] });
  let presents = 0, paid = 0;
  const client = Client.create({ polyfill: false, methods: [clientMethod({ recoverPayment: async c => {
    presents++; return f.resign({ challenge: c, payload: { ...f.credential.payload } });
  } })], fetch: async (url, init) => {
    const request = new Request(url, init);
    const result = await server['bitrouter-near-direct'].charge({ ...f.request,
      expires: new Date(f.request.expiresAtMs).toISOString() })(request);
    if (result.status === 402) {
      const c = Challenge.fromResponse(result.challenge);
      // Original challenge creation persists before exposing a payable 402.
      h.putChallenge(c);
      return result.challenge;
    }
    paid++; return result.withReceipt(Response.json({ result: 'controlled-payment-only', inference: false }));
  } });
  const response = await client.fetch('https://payments.example.com/v1/chat/completions', { method: 'POST', body: '{"model":"controlled"}' });
  assert.equal(response.status, 200); assert.ok(response.headers.get('payment-receipt'));
  assert.equal(presents, 1); assert.equal(paid, 1);
  assert.equal(h.db.prepare('SELECT count(*) AS n FROM consumption').get().n, 1);
});
test('official Agent API SDK encodes native transfer/signing routes with original operation key and grant', async () => {
  const f = fixture(), calls = [];
  const api = new AgentApi({ apiKey: 'controlled-partner', grantToken: 'ngt_' + 'a'.repeat(43),
    baseUrl: 'https://agent-api.example.com', fetch: async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(init.body), headers: init.headers });
      if (String(url).endsWith('/sign-message')) return Response.json({ correlation_id: 'controlled-sign',
        near_account_id: f.request.payer, public_key: f.key.publicKey,
        signature: f.key.sign(JSON.parse(init.body)), nonce: f.request.nonce, recipient: f.request.signingRecipient });
      return Response.json({ correlation_id: 'controlled-transfer', status: 'PENDING' });
    } });
  const plan = nativePlan(f.challenge, { payer: f.request.payer, refundTo: f.request.refundTo, version: f.request.bindingVersion, network: 'testnet', agentId: 'agent-1', merchant: f.request.recipient, signingRecipient: f.request.signingRecipient });
  await api.nativeNearTransfer(plan.agentId, plan.transfer, { idempotencyKey: plan.idempotencyKey });
  const signature = await api.nativeNearSignMessage(plan.agentId, signedPayload(f.challenge, f.txHash));
  assert.match(calls[0].url, /\/native\/near\/transfer$/); assert.match(calls[1].url, /\/native\/near\/sign-message$/);
  assert.deepEqual(calls[0].body, { to: f.request.recipient, amount: f.request.amount });
  assert.equal(calls[0].headers['idempotency-key'], plan.idempotencyKey); assert.ok(calls[0].headers['x-grant-token']);
  assert.equal(signature.public_key, f.key.publicKey);
});
test('durable global consumption survives rollback and lost COMMIT ACK; cannot reassign signed transfer', async t => {
  const { h, path } = harness(t), f = fixture(); h.putChallenge(f.challenge);
  await h.journalPresentation(f.credential);
  const v = await verifyPayment({ credential: f.credential, expectedChallenge: f.challenge, rpc: f.rpc });
  h.failBeforePurpose = true;
  await assert.rejects(h.consumeVerifiedPayment(v), /controlled_rollback/);
  assert.equal(h.db.prepare('SELECT count(*) AS n FROM consumption').get().n, 0);
  assert.equal(h.db.prepare('SELECT count(*) AS n FROM presentation').get().n, 1);
  h.failBeforePurpose = false; h.loseCommitAck = true;
  await assert.rejects(h.consumeVerifiedPayment(v), /lost_commit_ack/);
  const recovered = new Harness(path); t.after(() => recovered.close());
  assert.equal((await recovered.consumeVerifiedPayment(v)).committed, true);
  await assert.rejects(recovered.consumeVerifiedPayment({ ...v, orderRef: 'f'.repeat(64) }), /movement_already_consumed/);
  assert.equal(recovered.db.prepare('SELECT count(*) AS n FROM purpose').get().n, 1);
});
test('concurrent task reservations from independent workers cannot overspend one authorization', async t => {
  const { h, path } = harness(t); h.db.prepare('INSERT INTO budget(id,cap) VALUES(?,?)').run('task', 100);
  const start = call => new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./reserve-worker.mjs', import.meta.url), { workerData: { path,
      reservation: { task: 'task', call, fingerprint: 'frozen-native-body', amount: 60 } } });
    worker.on('message', resolve); worker.on('error', reject);
  });
  const results = await Promise.all([start('call-1'), start('call-2')]);
  assert.deepEqual(results.sort(), ['budget_exceeded', 'reserved']);
  assert.equal(h.db.prepare('SELECT held FROM budget').get().held, 60);
  const call = h.db.prepare('SELECT id FROM reservation').get().id;
  assert.throws(() => h.reserve({ task: 'task', call, fingerprint: 'modified-native-body', amount: 60 }), /reservation_conflict/);
});
test('late payment is consumed for liability reconciliation but method never returns an admissible receipt', async t => {
  const { h } = harness(t), f = fixture(); h.putChallenge(f.challenge); f.blocks.settlement = now + 60_001;
  const method = serverMethod({ rpc: f.rpc, authority: h });
  await assert.rejects(method.verify({ credential: f.credential }), /payment_not_admissible/);
  assert.equal(h.db.prepare('SELECT count(*) AS n FROM consumption').get().n, 1);
});
test('two independently valid signed assignments cannot buy two orders with the same movement', async t => {
  const { h } = harness(t), f = fixture();
  const second = Challenge.from({ secretKey: 'controlled-second-order-secret-32-bytes',
    realm: f.challenge.realm, method: f.challenge.method, intent: 'charge',
    request: { ...f.request, orderRef: hash('second-order'), nonce: Buffer.alloc(32, 5).toString('base64') },
    expires: f.challenge.expires });
  const c2 = f.resign({ challenge: second, payload: { ...f.credential.payload } });
  const v1 = await verifyPayment({ credential: f.credential, expectedChallenge: f.challenge, rpc: f.rpc });
  const v2 = await verifyPayment({ credential: c2, expectedChallenge: second, rpc: f.rpc });
  assert.equal(v1.movementKey, v2.movementKey); assert.notEqual(v1.orderRef, v2.orderRef);
  await h.consumeVerifiedPayment(v1);
  await assert.rejects(h.consumeVerifiedPayment(v2), /movement_already_consumed/);
});
