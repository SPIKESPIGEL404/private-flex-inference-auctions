import test from 'node:test';
import assert from 'node:assert/strict';
import bs58 from 'bs58';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../../../clients/buyer-gateway/src/store.mjs';
import { OutLayerOperations } from '../outlayer-client.mjs';
import { Wallet } from '../../p3/wallet.mjs';
import { WalletError } from '../../p3/outlayer.mjs';
import { fixture, now } from '../../test/support.mjs';

function setup(path = ':memory:') {
  const f = fixture(); f.tx.transaction_outcome.outcome.tokens_burnt = '100'; f.tx.receipts_outcome[0].outcome.tokens_burnt = '200';
  const binding = { agentId: 'agent-a', walletId: '11111111-1111-4111-8111-111111111111', credentialRef: 'agent-a',
    payer: f.request.payer, refundTo: f.request.payer, version: f.request.bindingVersion, network: 'testnet', merchant: f.request.recipient,
    signingRecipient: f.challenge.realm, publicKey: f.key.publicKey, policy: { controller: 'owner.testnet', version: 1, encryptedHash: 'hash' } };
  let sends = 0, lost = false;
  const store = new Store(path, Buffer.alloc(32, 3));
  const operations = new OutLayerOperations({ store, binding, limits: { totalYocto: '1000000000000000001000' } });
  const api = { async transfer() { sends++; if (lost) throw new WalletError('wallet_transport_unknown');
    return { status: 'success', request_id: '22222222-2222-4222-8222-222222222222', tx_hash: f.txHash }; },
    async sign(b, p) { return { account_id: b.payer, public_key: b.publicKey, nonce: p.nonce,
      signature: 'ed25519:' + bs58.encode(Buffer.from(f.key.sign(p), 'base64')) }; } };
  const wallet = new Wallet({ store: operations, rpc: f.rpc, api, policy: async () => {}, authorize: async () => {}, now: () => now + 100 });
  return { ...f, binding, store, wallet, operations, api, sends: () => sends, loseAck() { lost = true; },
    prepare: challenge => wallet.prepare({ challenge: challenge ?? f.challenge, binding, gasReserveYocto: '400', gasFloorYocto: '100',
      nanoUsdPerNear: '1000000000', taskId: 'one', userId: 'a' }) };
}
test('encrypted journal serializes concurrent recovery and retains one original payment', async () => {
  const f = setup();
  try {
    const op = await f.prepare();
    const results = await Promise.all(Array.from({ length: 8 }, () => f.wallet.recover(op.id)));
    assert.ok(results.every(r => r.state === 'final')); assert.equal(f.sends(), 1);
    assert.equal(results[0].proof.gasActualYocto, '300');
  } finally { f.store.close(); }
});
test('missing hosted ACK survives SQLite reopen without a second transfer POST', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'outlayer-ack-')), path = join(dir, 'journal.sqlite'); let f = setup(path);
  try {
    const op = await f.prepare(); f.loseAck(); await f.wallet.recover(op.id); assert.equal(f.sends(), 1); f.store.close();
    // Reload original binding/operations. The fixture key must stay the same.
    const reopened = new Store(path, Buffer.alloc(32, 3));
    const operations = new OutLayerOperations({ store: reopened, binding: f.binding, limits: { totalYocto: '1000000000000000001000' } });
    const wallet = new Wallet({ store: operations, rpc: f.rpc, api: f.api, policy: async () => {}, authorize: async () => {}, now: () => now + 100 });
    const recovered = await wallet.recover(op.id);
    assert.equal(recovered.state, 'review'); assert.equal(f.sends(), 1);
    assert.equal(recovered.lastError, 'original_ack_missing_no_automatic_resend'); reopened.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('a new order cannot reset cumulative account budget after the original payment', async () => {
  const f = setup();
  try {
    const op = await f.prepare(); await f.wallet.recover(op.id);
    const challenge = structuredClone(f.challenge); challenge.request.orderRef = 'a'.repeat(64);
    const next = await f.prepare(challenge), result = await f.wallet.recover(next.id);
    assert.equal(result.attempts, 0); assert.equal(result.lastError, 'outlayer_agent_budget_exhausted'); assert.equal(f.sends(), 1);
  } finally { f.store.close(); }
});
