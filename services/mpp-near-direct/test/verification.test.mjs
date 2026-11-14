import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { verifyPayment, verifyRefund, nep413Digest, NearRpc, refundPlan } from '../near.mjs';
import { hash } from '../contract.mjs';
import { fixture, now, keys } from './support.mjs';

const verify = f => verifyPayment({ credential: f.credential, expectedChallenge: f.challenge, rpc: f.rpc });
test('NEP-413 no-callback Borsh bytes match independently specified wire vector', () => {
  // NEP-413 structure: LE tag, length-prefixed "hi", nonce 0..31,
  // length-prefixed "myapp.com", callbackUrl None. No local serializer used.
  const wire = Buffer.from('9d010080020000006869000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f090000006d796170702e636f6d00', 'hex');
  assert.deepEqual(nep413Digest({ message: 'hi', nonce: Buffer.from(Array.from({ length: 32 }, (_, i) => i)).toString('base64'), recipient: 'myapp.com' }), createHash('sha256').update(wire).digest());
});
test('independently verifies final native transfer, full-access key and signed order binding', async () => {
  const f = fixture(), v = await verify(f);
  assert.equal(v.amount, f.request.amount); assert.equal(v.orderRef, f.request.orderRef);
  assert.equal(v.movementKey, `near:testnet:${f.txHash}:${f.receiptId}:0`); assert.equal(v.late, false);
  f.credential.source = 'did:made-up:someone-else';
  assert.deepEqual(await verify(f), v); // source is never authentication
});
for (const [name, mutate, code] of [
  ['pending', f => { f.tx.final_execution_status = 'EXECUTED'; }, 'payment_pending_unknown'],
  ['wrong payer', f => { f.tx.transaction.signer_id = 'other.testnet'; }, 'transaction_identity_mismatch'],
  ['wrong merchant', f => { f.tx.transaction.receiver_id = 'other.testnet'; }, 'transaction_identity_mismatch'],
  ['wrong network', f => { f.rpc.network = 'mainnet'; }, 'network_mismatch'],
  ['underpayment', f => { f.tx.transaction.actions[0].Transfer.deposit = '1'; }, 'not_exact_native_transfer'],
  ['overpayment', f => { f.tx.transaction.actions[0].Transfer.deposit += '0'; }, 'not_exact_native_transfer'],
  ['FT / arbitrary call', f => { f.tx.transaction.actions = [{ FunctionCall: { method_name: 'ft_transfer' } }]; }, 'not_exact_native_transfer'],
  ['batched payment', f => { f.tx.transaction.actions.push({ Transfer: { deposit: '1' } }); }, 'not_exact_native_transfer'],
  ['failed transaction', f => { f.tx.status = { Failure: {} }; }, 'chain_payment_failed'],
  ['failed merchant receipt', f => { f.tx.receipts_outcome[0].outcome.status = { Failure: {} }; }, 'receipt_failed'],
  ['missing receipt', f => { f.tx.receipts_outcome[0].outcome.receipt_ids.push('missing'); }, 'missing_receipt_unknown'],
  ['unrelated successful receipt', f => { f.tx.receipts_outcome.push({ ...f.tx.receipts_outcome[0], id: 'unrelated' }); }, 'unrelated_receipt'],
  ['fake merchant executor', f => { f.tx.receipts_outcome[0].outcome.executor_id = 'other.testnet'; }, 'merchant_receipt_mismatch'],
  ['receipt cycle', f => { f.tx.receipts_outcome[0].outcome.receipt_ids.push(f.receiptId); }, 'invalid_receipt_graph'],
  ['old transfer', f => { f.blocks.inclusion = now - 1; }, 'payment_predates_order'],
  ['function-call signing key', f => { f.rpc.keyAt = async () => ({ permission: { FunctionCall: {} } }); }, 'payer_key_not_full_access'],
  ['public hash stolen by other key', f => { f.credential.payload.publicKey = keys().publicKey; }, 'invalid_order_signature'],
  ['same signed proof moved to another order', f => { f.credential.challenge = structuredClone(f.challenge); f.credential.challenge.request.orderRef = hash('order-2'); f.challenge = f.credential.challenge; }, 'invalid_order_signature'],
  ['tampered original challenge', f => { f.credential.challenge = structuredClone(f.challenge); f.credential.challenge.request.amount = '2'; }, 'challenge_mismatch'],
]) test(`rejects ${name}`, async () => {
  const f = fixture(); mutate(f); await assert.rejects(verify(f), new RegExp(code));
});
test('late money is verified as a liability, never silently erased or admitted', async () => {
  const f = fixture(); f.blocks.settlement = f.request.expiresAtMs + 1;
  const v = await verify(f); assert.equal(v.late, true); assert.equal(v.amount, f.request.amount);
});
test('sub-millisecond deadline overrun is still late; FINAL cannot carry an intermediate status', async () => {
  const f = fixture(), original = f.rpc.block;
  f.rpc.block = async id => id === 'settlement'
    ? { header: { hash: id, timestamp_nanosec: String(BigInt(f.request.expiresAtMs) * 1_000_000n + 1n) } }
    : original(id);
  assert.equal((await verify(f)).late, true);
  f.tx.status = { SuccessReceiptId: f.receiptId };
  await assert.rejects(verify(f), /chain_payment_failed/);
});
test('plain transfer merchant receipt must be the direct root, not an arbitrary descendant', async () => {
  const f = fixture();
  f.tx.transaction_outcome.outcome.receipt_ids = ['other-root'];
  f.tx.receipts_outcome.push({ id: 'other-root', outcome: { executor_id: 'unrelated.testnet',
    receipt_ids: [f.receiptId], status: { SuccessReceiptId: f.receiptId } } });
  await assert.rejects(verify(f), /invalid_transfer_root/);
});
test('full receipt graph includes refund receipts; omitted or failed outcomes cannot pass', async () => {
  const f = fixture(), refundId = 'gas-refund';
  f.tx.receipts_outcome[0].outcome.receipt_ids.push(refundId);
  await assert.rejects(verify(f), /missing_receipt_unknown/);
  f.tx.receipts_outcome.push({ id: refundId, outcome: { executor_id: f.request.payer, receipt_ids: [], status: { SuccessValue: '' } } });
  assert.equal((await verify(f)).late, false);
});
test('RPC pins FINAL, trusted network and historical key; bounds streamed response', async () => {
  const calls = [], f = fixture();
  const rpc = new NearRpc({ url: 'https://rpc.example.com', network: 'testnet', fetcher: async (_, init) => {
    const b = JSON.parse(init.body); calls.push(b);
    const result = b.method === 'status' ? { chain_id: 'testnet' } : f.tx;
    return Response.json({ result });
  } });
  await rpc.transaction(f.txHash, f.request.payer);
  assert.equal(calls[1].params.wait_until, 'FINAL');
  assert.equal(calls[1].params.sender_account_id, f.request.payer);
  rpc.fetcher = async () => new Response('x'.repeat(1024 * 1024 + 1));
  await assert.rejects(rpc.call('status', []), /too_large_unknown/);
  assert.throws(() => new NearRpc({ url: 'http://attacker.example', network: 'mainnet' }), /untrusted_rpc_url/);
});
test('refund plan preserves original verified destination, asset, version and operation key', () => {
  const f = fixture(); const p = refundPlan({ orderRef: f.request.orderRef, binding: f.request, amount: '1', refundableYocto: '1', operationId: 'refund-1', createdAtMs: now });
  assert.equal(p.recipient, f.request.payer); assert.equal(p.sender, f.request.recipient);
  assert.match(p.idempotencyKey, /^near-refund-v1-[0-9a-f]{64}$/);
  assert.throws(() => refundPlan({ orderRef: f.request.orderRef, binding: f.request, amount: f.request.amount + '0', operationId: 'refund-1', createdAtMs: now }), /invalid_refund_amount/);
  assert.throws(() => refundPlan({ orderRef: hash('another-order'), binding: f.request, amount: '1', refundableYocto: '1', operationId: 'refund-1', createdAtMs: now }), /refund_order_binding_mismatch/);
  assert.throws(() => refundPlan({ orderRef: f.request.orderRef, binding: f.request, amount: '2', refundableYocto: '1', operationId: 'refund-1', createdAtMs: now }), /refund_exceeds_remaining_liability/);
  assert.ok(refundPlan({ orderRef: f.request.orderRef, binding: f.request, amount: '1', refundableYocto: '1', operationId: 'x'.repeat(128), createdAtMs: now }).idempotencyKey.length <= 128);
});
test('native refund independently verifies merchant-to-original-agent final receipt without buyer grant', async () => {
  const paid = fixture(), refund = fixture({ request: { payer: 'merchant.testnet', recipient: 'agent.testnet', refundTo: 'merchant.testnet' } });
  const plan = refundPlan({ orderRef: paid.request.orderRef, binding: paid.request, amount: paid.request.amount, refundableYocto: paid.request.amount, operationId: 'refund-1', createdAtMs: now });
  const originalSend = { operationId: plan.operationId, idempotencyKey: plan.idempotencyKey, planHash: hash(plan), txHash: refund.txHash };
  const v = await verifyRefund({ plan, originalSend, txHash: refund.txHash, publicKey: refund.key.publicKey, rpc: refund.rpc });
  assert.equal(v.recipient, paid.request.payer); assert.equal(v.late, false);
  refund.tx.transaction.receiver_id = 'attacker.testnet';
  await assert.rejects(verifyRefund({ plan, originalSend, txHash: refund.txHash, publicKey: refund.key.publicKey, rpc: refund.rpc }), /transaction_identity_mismatch/);
});
test('equal merchant transfer cannot be relabelled as an unrelated refund; original unknown holds W', async () => {
  const f = fixture(), plan = refundPlan({ orderRef: f.request.orderRef, binding: f.request, amount: '1',
    refundableYocto: '1', operationId: 'refund-1', createdAtMs: now });
  const args = { plan, txHash: f.txHash, publicKey: f.key.publicKey, rpc: f.rpc };
  await assert.rejects(verifyRefund(args), /original_refund_send_unknown/);
  await assert.rejects(verifyRefund({ ...args, originalSend: { operationId: plan.operationId,
    idempotencyKey: plan.idempotencyKey, planHash: hash(plan), txHash: 'other-transaction' } }), /not_original_refund_transaction/);
});
