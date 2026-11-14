import test from 'node:test';
import assert from 'node:assert/strict';
import { KeyPair, baseEncode } from 'near-api-js';
import { Store } from '../../../../clients/buyer-gateway/src/store.mjs';
import { NativeSender } from '../native-sender.mjs';
import { verifyAgentPaidCredential } from '../native-verification.mjs';
import { fixture } from '../../test/support.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

function setup({ store = new Store(':memory:', Buffer.alloc(32, 6)), key = KeyPair.fromRandom('ed25519') } = {}) {
  const records = [], broadcasts = [], block = baseEncode(Buffer.alloc(32, 5));
  const plan = { network: 'testnet', asset: 'native:NEAR', sender: 'merchant.testnet', recipient: 'agent.testnet',
    amount: '1000', createdAtMs: Date.now(), idempotencyKey: 'refund-original', operationId: 'refund-order', orderRef: 'a'.repeat(64) };
  let finalTx;
  const provider = {
    async viewAccessKey() { return { permission: 'FullAccess', nonce: 10, block_hash: block }; },
    async viewAccount() { return { amount: '100000000', locked: '0', storage_usage: 0 }; },
    async sendTransactionUntil(signed, wait) { broadcasts.push({ bytes: Buffer.from(signed.encode()).toString('base64'), wait }); throw new Error('lost_send_ack'); },
  };
  const rpc = { network: 'testnet', async call() { return { chain_id: 'testnet' }; },
    async transaction() { if (!finalTx) throw new Error('rpc_pending_unknown'); return finalTx; },
    async keyAt() { return { permission: 'FullAccess' }; },
    async block(id) { return { header: { hash: id, timestamp_nanosec: String(BigInt(plan.createdAtMs + 2000) * 1000000n) } }; },
  };
  const config = { store, key, provider, rpc, accountId: plan.sender, secretKey: key.toString(), maxTotalYocto: '10000', gasCapYocto: '100', storagePriceYocto: '1' };
  const sender = new NativeSender(config);
  function finalize(record) {
    const receipt = baseEncode(Buffer.alloc(32, 8));
    finalTx = { final_execution_status: 'FINAL', status: { SuccessValue: '' },
      transaction: { hash: record.txHash, signer_id: plan.sender, receiver_id: plan.recipient,
        public_key: key.getPublicKey().toString(), nonce: 11, actions: [{ Transfer: { deposit: plan.amount } }] },
      transaction_outcome: { id: record.txHash, block_hash: block, outcome: { executor_id: plan.sender, tokens_burnt: '10', receipt_ids: [receipt], status: { SuccessReceiptId: receipt } } },
      receipts_outcome: [{ id: receipt, block_hash: block, outcome: { executor_id: plan.recipient, tokens_burnt: '12', receipt_ids: [], status: { SuccessValue: '' } } }] };
  }
  return { sender, store, config, plan, provider, rpc, records, broadcasts, finalize };
}
test('persists original signed bytes before broadcast; lost ACK replays identical bytes after restart', async () => {
  const f = setup(), record = await f.sender.prepare(f.plan);
  assert.equal(f.broadcasts.length, 0);
  assert.equal(record.state, 'signed');
  await assert.rejects(f.sender.broadcast(f.plan.idempotencyKey), /lost_send_ack/);
  assert.equal(f.sender.get(f.plan.idempotencyKey).state, 'unknown');
  const restarted = new NativeSender(f.config), recovered = await restarted.prepare(f.plan);
  assert.equal(recovered.bytes, record.bytes); assert.equal(recovered.txHash, record.txHash);
  await assert.rejects(restarted.broadcast(f.plan.idempotencyKey), /lost_send_ack/);
  assert.deepEqual(f.broadcasts.map(x => x.bytes), [record.bytes, record.bytes]);
  f.finalize(record);
  const final = await restarted.reconcile(f.plan.idempotencyKey);
  assert.equal(final.proof.gasActualYocto, '22'); assert.equal(final.proof.gasPayer, f.plan.sender);
  assert.equal((await restarted.broadcast(f.plan.idempotencyKey)).state, 'final');
  assert.equal(f.broadcasts.length, 2);
});
test('unknown original blocks another payout, nonce allocation and changed plan', async () => {
  const f = setup(); await f.sender.prepare(f.plan);
  await assert.rejects(f.sender.prepare({ ...f.plan, idempotencyKey: 'different-refund' }), /payer_original_send_pending/);
  await assert.rejects(f.sender.prepare({ ...f.plan, amount: '999' }), /original_native_plan_conflict/);
  await assert.rejects(f.sender.reconcile(f.plan.idempotencyKey), /rpc_pending_unknown/);
  await assert.rejects(f.sender.prepare({ ...f.plan, idempotencyKey: 'different-refund' }), /payer_original_send_pending/);
});
test('concurrent preparation fences the stale signer before any broadcast', async () => {
  const f = setup();
  const results = await Promise.allSettled([f.sender.prepare(f.plan), f.sender.prepare(f.plan)]);
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
  assert.match(results.find(x => x.status === 'rejected').reason.message, /native_preparation_fenced/);
  assert.equal(f.broadcasts.length, 0);
});
test('invalid target, wrong network, function-call key and balance shortfall cannot broadcast', async () => {
  for (const [change, pattern] of [
    [{ recipient: 'merchant.testnet' }, /invalid_native_send_plan/],
    [{ network: 'mainnet' }, /invalid_native_send_plan/],
  ]) { const f = setup(); await assert.rejects(f.sender.prepare({ ...f.plan, ...change }), pattern); assert.equal(f.broadcasts.length, 0); }
  const f = setup(); f.provider.viewAccessKey = async () => ({ permission: { FunctionCall: {} } });
  await assert.rejects(f.sender.prepare(f.plan), /ordinary_native_key_required/);
  const g = setup(); g.provider.viewAccount = async () => ({ amount: '1099', locked: '0', storage_usage: 0 });
  await assert.rejects(g.sender.prepare(g.plan), /native_sender_balance_insufficient/);
});
test('cumulative sender budget includes actual gas and cannot be reset by restart', async () => {
  const f = setup(), record = await f.sender.prepare(f.plan); f.finalize(record);
  await f.sender.reconcile(f.plan.idempotencyKey);
  const restarted = new NativeSender(f.config);
  await assert.rejects(restarted.prepare({ ...f.plan, amount: '9000', idempotencyKey: 'later' }), /native_sender_budget_exhausted/);
  assert.throws(() => new NativeSender({ ...f.config, maxTotalYocto: '100000' }), /sender_policy_changed/);
  assert.throws(() => new NativeSender({ ...f.config, secretKey: KeyPair.fromRandom('ed25519').toString() }), /sender_policy_changed/);
});
test('stale RPC access nonce cannot reuse a finalized transaction for a different refund', async () => {
  const f = setup(), first = await f.sender.prepare(f.plan); f.finalize(first);
  await f.sender.reconcile(f.plan.idempotencyKey);
  const second = await f.sender.prepare({ ...f.plan, idempotencyKey: 'second-refund', operationId: 'second-refund', orderRef: 'b'.repeat(64) });
  assert.notEqual(second.txHash, first.txHash); assert.notEqual(second.bytes, first.bytes);
  // RPC still returns the first transaction; it cannot close the second plan.
  await assert.rejects(f.sender.reconcile('second-refund'), /transaction_identity_mismatch/);
  assert.equal(f.sender.get('second-refund').state, 'signed');
});
test('agent fee proof uses all rooted FINAL outcomes and rejects missing fee/altered ordinary nonce', async () => {
  const f = fixture(); f.tx.transaction_outcome.outcome.tokens_burnt = '20'; f.tx.receipts_outcome[0].outcome.tokens_burnt = '30';
  const args = { credential: f.credential, expectedChallenge: f.challenge, rpc: f.rpc };
  const proof = await verifyAgentPaidCredential(args);
  assert.equal(proof.gasActualYocto, '50'); assert.equal(proof.gasPayer, f.request.payer);
  delete f.tx.receipts_outcome[0].outcome.tokens_burnt;
  await assert.rejects(verifyAgentPaidCredential(args), /invalid_integer/);
  f.tx.transaction.nonce_index = 0;
  await assert.rejects(verifyAgentPaidCredential(args), /ordinary_native_key_required/);
});
test('original signed send and payer fence survive SQLite close and a separate Node process', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'native-send-recovery-')), path = join(directory, 'journal.sqlite');
  const encryptionKey = Buffer.alloc(32, 6), store = new Store(path, encryptionKey);
  try {
    const f = setup({ store }), original = await f.sender.prepare(f.plan);
    store.close();
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import {readFileSync} from 'node:fs';
      import {Store} from ${JSON.stringify(new URL('../../../../clients/buyer-gateway/src/store.mjs', import.meta.url).href)};
      import {NativeSender} from ${JSON.stringify(new URL('../native-sender.mjs', import.meta.url).href)};
      const input=JSON.parse(readFileSync(0,'utf8'));
      const store=new Store(input.path,Buffer.alloc(32,6));
      const sender=new NativeSender({...input.config,store,rpc:{network:'testnet'},provider:{}});
      const original=await sender.prepare(input.plan);
      let fenced=false;try{await sender.prepare({...input.plan,idempotencyKey:'different-operation'});}catch(e){fenced=e.message==='payer_original_send_pending';}
      console.log(JSON.stringify({hash:original.txHash,bytes:original.bytes,state:original.state,fenced}));
      store.close();
    `], { input: JSON.stringify({ path, plan: f.plan, config: { accountId: f.config.accountId,
      secretKey: f.config.secretKey, maxTotalYocto: f.config.maxTotalYocto, gasCapYocto: f.config.gasCapYocto, storagePriceYocto: f.config.storagePriceYocto } }), encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    const recovered = JSON.parse(child.stdout);
    assert.equal(recovered.hash, original.txHash); assert.equal(recovered.bytes, original.bytes);
    assert.equal(recovered.state, 'signed'); assert.equal(recovered.fenced, true);
  } finally { if (store.db.isOpen) store.close(); rmSync(directory, { recursive: true, force: true }); }
});
