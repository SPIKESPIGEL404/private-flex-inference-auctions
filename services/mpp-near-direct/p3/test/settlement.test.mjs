import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../../../../clients/buyer-gateway/src/store.mjs';
import { fixture } from '../../test/support.mjs';
import { deliveredResponse, claimAbandoned, originalRefundPlan, recordCleanup } from '../testnet-settlement.mjs';
import { BoundedNativeProvider, TestnetAcceptanceRpc } from '../rpc-provider.mjs';
const setup = () => {
  const store = new Store(':memory:', Buffer.alloc(32, 9)), f = fixture(), id = f.request.orderRef;
  store.put('testnet-mpp-order', id, 'testnet', { request: f.request });
  return { store, id, r: f.request, now: f.request.expiresAtMs + 1 };
};
const response = { body: '{}', headers: { 'payment-receipt': 'original' } };
test('delivery wins settlement claim: cleanup cannot use a stale unfulfilled snapshot', () => {
  const { store, id, now } = setup();
  deliveredResponse(store, id, response);
  assert.equal(claimAbandoned(store, id, now), null);
  assert.throws(() => originalRefundPlan(store, id, { kind: 'abandoned', amount: '100', createdAtMs: now }), /settlement_claim_required/);
  store.close();
});
test('cleanup wins settlement claim: normal response and partial refund are fenced', () => {
  const { store, id, now, r } = setup();
  claimAbandoned(store, id, now);
  assert.throws(() => deliveredResponse(store, id, response), /already_abandoned/);
  assert.throws(() => originalRefundPlan(store, id, { kind: 'delivered', amount: '100', createdAtMs: now }), /settlement_claim_required/);
  const full = originalRefundPlan(store, id, { kind: 'abandoned', amount: r.amount, createdAtMs: now });
  assert.equal(full.operationId, 'refund-' + id);
  assert.throws(() => originalRefundPlan(store, id, { kind: 'abandoned', amount: '100', createdAtMs: now + 1 }), /testnet_abandoned_full_refund_required/);
  assert.equal(store.list('testnet-mpp-refund-plan', 'testnet').length, 1);
  store.close();
});
test('cleanup confirmation preserves later proof fields and original refund bytes identity', () => {
  const { store, id, now, r } = setup();
  claimAbandoned(store, id, now);
  const plan = originalRefundPlan(store, id, { kind: 'abandoned', amount: r.amount, createdAtMs: now });
  const again = originalRefundPlan(store, id, { kind: 'abandoned', amount: r.amount, createdAtMs: now + 9000 });
  assert.deepEqual(again, plan);
  const current = store.get('testnet-mpp-order', id); store.put('testnet-mpp-order', id, 'testnet', { ...current, proof: { txHash: 'original' } });
  const final = recordCleanup(store, id, { refundHash: 'original-refund' });
  assert.equal(final.proof.txHash, 'original'); assert.equal(final.cleanup.refundHash, 'original-refund');
  store.close();
});
test('bounded SDK provider uses one trusted RPC call and preserves the requested FINAL milestone', async () => {
  const calls = [], rpc = { url: 'https://rpc.testnet.near.org', async call(method, params) { calls.push({ method, params }); throw new Error('rpc_pending_unknown'); } };
  const provider = new BoundedNativeProvider(rpc);
  await assert.rejects(provider.sendJsonRpc('send_tx', { signed_tx_base64: 'original', wait_until: 'FINAL' }), /rpc_pending_unknown/);
  assert.deepEqual(calls, [{ method: 'send_tx', params: { signed_tx_base64: 'original', wait_until: 'FINAL' } }]);
});
test('testnet RPC retries bounded reads but never hides a second broadcast', async () => {
  const rpc = new TestnetAcceptanceRpc(); let calls = 0;
  rpc.fetcher = async () => ++calls < 3 ? new Response('', { status: 503 }) : Response.json({ chain_id: 'testnet' });
  assert.equal((await rpc.call('status', [])).chain_id, 'testnet'); assert.equal(calls, 3);
  calls = 0; rpc.fetcher = async () => { calls++; return new Response('', { status: 503 }); };
  await assert.rejects(rpc.call('send_tx', { signed_tx_base64: 'original', wait_until: 'FINAL' }), /rpc_unavailable_unknown/);
  assert.equal(calls, 1);
});
test('testnet snapshot cache retains FINAL originals only and never caches current balances', async () => {
  const store = new Store(':memory:', Buffer.alloc(32, 7)), rpc = new TestnetAcceptanceRpc(store);
  let txReads = 0, balanceReads = 0;
  rpc.fetcher = async (url, init) => {
    if (url.endsWith('/status')) return Response.json({ chain_id: 'testnet' });
    const { method } = JSON.parse(init.body);
    if (method === 'tx') return Response.json({ result: { final_execution_status: ++txReads === 1 ? 'EXECUTED' : 'FINAL', transaction: { hash: 'original-hash', signer_id: 'agent.testnet' } } });
    balanceReads++; return Response.json({ result: { amount: String(balanceReads) } });
  };
  assert.equal((await rpc.transaction('original-hash', 'agent.testnet')).final_execution_status, 'EXECUTED');
  assert.equal((await rpc.transaction('original-hash', 'agent.testnet')).final_execution_status, 'FINAL');
  await rpc.transaction('original-hash', 'agent.testnet'); assert.equal(txReads, 2);
  const query = { request_type: 'view_account', account_id: 'agent.testnet', finality: 'final' };
  assert.equal((await rpc.call('query', query)).amount, '1'); assert.equal((await rpc.call('query', query)).amount, '2');
  const reopened = new TestnetAcceptanceRpc(store);
  reopened.fetcher = async (url, init) => {
    assert.ok(url.endsWith('/status')); assert.equal(init.method, 'GET'); return Response.json({ chain_id: 'testnet' });
  };
  assert.equal((await reopened.transaction('original-hash', 'agent.testnet')).final_execution_status, 'FINAL');
  store.close();
});
