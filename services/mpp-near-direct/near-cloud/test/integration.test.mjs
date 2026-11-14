import test from 'node:test';
import assert from 'node:assert/strict';
import { KeyPair } from 'near-api-js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Mppx } from 'mppx/client';
import { Challenge } from 'mppx';
import { Store } from '../../../../clients/buyer-gateway/src/store.mjs';
import { clientMethod } from '../../method.mjs';
import { fixture } from '../../test/support.mjs';
import { startCloudMpp } from '../server.mjs';
import { verifyReceipt } from '../authority.mjs';
import { freezeNearTariff, MODEL } from '../../../inference-comparison/core.mjs';
import { checkConservation } from '../../contract.mjs';
const token = 'a'.repeat(64);
const request = { messages: [{ role: 'user', content: 'Reply 4.' }], temperature: 0, max_completion_tokens: 128 };
const body = JSON.stringify({ ...request, model: MODEL, stream: true, stream_options: { include_usage: true } });
function setup({ storePath = ':memory:' } = {}) {
  const f = fixture(), key = KeyPair.fromRandom('ed25519'), now = Date.now();
  let currentNow = now;
  const tariff = freezeNearTariff({ models: [{ modelId: MODEL, metadata: { isReady: true, ownedBy: 'nearai' },
    inputCostPerToken: { currency: 'USD', amount: '4', scale: 8 }, outputCostPerToken: { currency: 'USD', amount: '135', scale: 8 } }] }, { observedAtMs: now });
  const config = { namespace: 'controlled-unit-cloud', network: 'testnet', realm: 'cloud-unit.test', agentToken: token, secret: 'b'.repeat(64),
    agent: { accountId: 'agent.testnet', publicKey: f.key.publicKey, bindingVersion: 'unit-v1' },
    merchant: 'merchant.testnet', merchantPublicKey: key.getPublicKey().toString(), merchantSecretKey: key.toString(),
    request, tariff, qualifiedInputTokens: 8192, upstreamBudgetMicro: '10000',
    fx: { kind: 'testnet-accounting-convention', nanoUsdPerNear: '1000000000' },
    agentGasReserveYocto: '10000000000000000000000' };
  const store = new Store(storePath, Buffer.alloc(32, 5));
  let paid = 0, refunds = 0, refundTx, refundAt;
  const refundHash = '9'.repeat(43), receiptId = 'A'.repeat(43);
  const rpc = { network: 'testnet',
    async transaction(h, payer) {
      if (h === f.txHash && payer === 'agent.testnet') return f.tx;
      if (h === refundHash && payer === 'merchant.testnet') return refundTx;
      throw new Error('rpc_unknown');
    },
    async keyAt() { return { permission: 'FullAccess' }; },
    async block(id) {
      if (id.startsWith('refund')) return { header: { hash: id, timestamp_nanosec: String(BigInt(refundAt + 10) * 1000000n) } };
      return f.rpc.block(id);
    },
  };
  const sender = { async prepare(plan) {
    refunds++; refundAt = plan.createdAtMs;
    refundTx = structuredClone(f.tx);
    Object.assign(refundTx.transaction, { hash: refundHash, signer_id: 'merchant.testnet', receiver_id: 'agent.testnet', public_key: config.merchantPublicKey,
      actions: [{ Transfer: { deposit: plan.amount } }] });
    refundTx.transaction_outcome = { id: refundHash, block_hash: 'refund-inclusion', outcome: { executor_id: 'merchant.testnet',
      receipt_ids: [receiptId], status: { SuccessReceiptId: receiptId }, tokens_burnt: '10' } };
    refundTx.receipts_outcome = [{ id: receiptId, block_hash: 'refund-settlement', outcome: { executor_id: 'agent.testnet', receipt_ids: [], status: { SuccessValue: '' }, tokens_burnt: '15' } }];
    return { state: 'final', txHash: refundHash, proof: { gasActualYocto: '25' } };
  } };
  const stream = () => Buffer.from('data: ' + JSON.stringify({ id: 'real-shape-unit', model: MODEL,
    choices: [{ index: 0, delta: { content: '4' }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 1, total_tokens: 21 } }) + '\n\ndata: [DONE]\n\n');
  const provider = { calls: 0, verifications: 0, async verify() { return {}; },
    async fetch() { this.calls++; return new Response(stream(), { headers: { 'content-type': 'text/event-stream' } }); },
    async verifyResponse(id) { this.verifications++; return { id, signatureKind: 'provider_tee', signature: { fixture: true } }; } };
  const originalProof = challenge => {
    paid++;
    f.tx.transaction.actions[0].Transfer.deposit = challenge.request.amount;
    f.tx.transaction_outcome.outcome.tokens_burnt = '10'; f.tx.receipts_outcome[0].outcome.tokens_burnt = '20';
    f.blocks.inclusion = challenge.request.issuedAtMs + 10; f.blocks.settlement = challenge.request.issuedAtMs + 20;
    return f.resign({ challenge, payload: { txHash: f.txHash, publicKey: f.key.publicKey, signature: '' } });
  };
  const headers = { authorization: 'Bearer ' + token, 'content-type': 'application/json', 'idempotency-key': 'original' };
  const client = Mppx.create({ polyfill: false, methods: [clientMethod({ recoverPayment: async challenge => originalProof(challenge) })] });
  return { config, store, rpc, sender, provider, f, headers, client, originalProof, counts: () => ({ paid, refunds }),
    advance(ms) { currentNow += ms; },
    async start() { return startCloudMpp(config, { client: provider, store, rpc, merchantSender: sender, now: () => currentNow }); } };
}
async function refunded(app) {
  for (let n = 0; n < 100; n++) {
    await app.refundTick(); const order = app.authority.orders()[0];
    if (order?.refund) return order;
    await new Promise(r => setTimeout(r, 5));
  }
  throw new Error('refund_not_committed');
}
test('402 cannot invoke Cloud; original paid result is metered, signed, refunded and replayed once', async () => {
  const f = setup(), app = await f.start();
  try {
    const missing = await fetch(app.url + '/v1/chat/completions', { method: 'POST', headers: f.headers, body });
    assert.equal(missing.status, 402); assert.equal(Challenge.fromResponse(missing).header, 'Payment-Authorization');
    await missing.text(); assert.equal(f.provider.calls, 0);
    const response = await f.client.fetch(app.url + '/v1/chat/completions', { method: 'POST', headers: f.headers, body });
    assert.equal(response.status, 200, await response.clone().text());
    assert.ok(response.headers.get('payment-receipt')); const raw = await response.text();
    const final = await refunded(app); checkConservation(final.principal);
    assert.equal(final.financialReceipt.document.actualServiceMicroUsd, '3');
    assert.equal(final.principal.C, '3000000000000000000');
    assert.equal(final.payment.gasActualYocto, '30'); assert.equal(final.refund.gasActualYocto, '25');
    verifyReceipt(final.financialReceipt, f.config.merchantPublicKey); verifyReceipt(final.refundReceipt, f.config.merchantPublicKey);
    const again = await f.client.fetch(app.url + '/v1/chat/completions', { method: 'POST', headers: f.headers, body });
    assert.equal(await again.text(), raw); assert.equal(f.provider.calls, 1); assert.equal(f.provider.verifications, 1);
    assert.equal(f.counts().paid, 1); assert.equal(f.counts().refunds, 1);
  } finally { await app.close(); }
});
test('unverified provider output stays held across retries and expiry; no guessed refund or second invoke', async () => {
  const f = setup(); f.provider.verifyResponse = async () => { throw new Error('signature_rejected'); };
  const app = await f.start();
  try {
    const r = await f.client.fetch(app.url + '/v1/chat/completions', { method: 'POST', headers: f.headers, body });
    assert.equal(r.status, 503); await r.text();
    const order = app.authority.orders()[0]; assert.equal(order.principal.H, order.principal.P); assert.equal(order.principal.W, '0');
    f.advance(180000);
    const again = await f.client.fetch(app.url + '/v1/chat/completions', { method: 'POST', headers: f.headers, body });
    assert.equal(again.status, 503); await again.text();
    await app.refundTick(); assert.equal(f.provider.calls, 1); assert.equal(f.counts().refunds, 0);
  } finally { await app.close(); }
});
test('late real-shape payment creates full refund liability and never invokes a model', async () => {
  const f = setup(), app = await f.start();
  try {
    const first = await fetch(app.url + '/v1/chat/completions', { method: 'POST', headers: f.headers, body });
    const challenge = Challenge.fromResponse(first); await first.text(); const credential = f.originalProof(challenge);
    f.f.blocks.settlement = challenge.request.expiresAtMs + 1;
    const { Credential } = await import('mppx');
    const response = await fetch(app.url + '/v1/chat/completions', { method: 'POST', headers: { ...f.headers, 'payment-authorization': Credential.serialize(credential) }, body });
    assert.equal(response.status, 503); await response.text();
    const final = await refunded(app); assert.equal(final.principal.C, '0'); assert.equal(final.principal.R, final.principal.P);
    assert.equal(f.provider.calls, 0);
  } finally { await app.close(); }
});
test('body changes and new logical keys cannot spend the frozen one-order authorization', async () => {
  const f = setup(), app = await f.start();
  try {
    const first = await fetch(app.url + '/v1/chat/completions', { method: 'POST', headers: f.headers, body }); await first.text();
    const changed = await fetch(app.url + '/v1/chat/completions', { method: 'POST', headers: f.headers,
      body: JSON.stringify({ ...JSON.parse(body), messages: [{ role: 'user', content: 'changed' }] }) });
    assert.equal(changed.status, 503); await changed.text();
    const other = await fetch(app.url + '/v1/chat/completions', { method: 'POST', headers: { ...f.headers, 'idempotency-key': 'replacement' }, body });
    assert.equal(other.status, 503); await other.text(); assert.equal(f.provider.calls, 0);
  } finally { await app.close(); }
});
test('captured verified response survives restart and settles without another provider request', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cloud-mpp-recovery-')), path = join(directory, 'orders.sqlite');
  const f = setup({ storePath: path }); let app = await f.start();
  try {
    app.authority.recordVerified = () => { throw new Error('test_interrupted_after_provider_verification'); };
    const failed = await f.client.fetch(app.url + '/v1/chat/completions', { method: 'POST', headers: f.headers, body });
    assert.equal(failed.status, 503); await failed.text();
    assert.ok(app.authority.orders()[0].provider.capturedResponse); assert.ok(app.authority.orders()[0].provider.verification);
    await app.close(); app = null;
    f.provider.verify = async () => { throw new Error('provider_offline_during_recovery'); };
    const reopened = new Store(path, Buffer.alloc(32, 5));
    app = await startCloudMpp(f.config, { client: f.provider, store: reopened, rpc: f.rpc, merchantSender: f.sender });
    const recovered = await f.client.fetch(app.url + '/v1/chat/completions', { method: 'POST', headers: f.headers, body });
    assert.equal(recovered.status, 200); assert.match(await recovered.text(), /4/);
    const final = await refunded(app); assert.equal(final.state, 'refunded'); assert.equal(f.provider.calls, 1);
  } finally { await app?.close(); rmSync(directory, { recursive: true, force: true }); }
});
test('explicit merchant waiver retains the original reserve and allows at most one bounded replacement case', async () => {
  const f = setup(); f.provider.fetch = async () => { f.provider.calls++; throw new Error('multiple_final_usage'); };
  const app = await f.start();
  try {
    const failed = await f.client.fetch(app.url + '/v1/chat/completions', { method: 'POST', headers: f.headers, body });
    assert.equal(failed.status, 503); await failed.text();
    const original = app.authority.orders()[0];
    assert.throws(() => app.authority.waiveIntegrationFailure(original.id, 'ordinary_timeout'), /explicit_integration_waiver_required/);
    app.authority.waiveIntegrationFailure(original.id, 'integration_parser_rejected_unretained_response');
    const closed = await refunded(app);
    assert.equal(closed.principal.R, closed.principal.P); assert.equal(closed.waiver.upstreamMayBeCharged, true);
    assert.equal(closed.waiver.retainedUpstreamReserveMicro, '501');
    const fresh = app.authority.prepare('explicit-new-test-case', body); assert.notEqual(fresh.id, original.id);
    assert.throws(() => app.authority.prepare('unauthorized-third-case', body), /cloud_order_authorization_exhausted/);
    assert.equal(app.authority.orders().length, 2); assert.equal(f.provider.calls, 1);
  } finally { await app.close(); }
});
