// Cleanup for interrupted TESTNET protocol cases. It never issues an agent
// payment or invokes inference. Expired, unfulfilled cases owe the full deposit.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Store } from '../../../clients/buyer-gateway/src/store.mjs';
import { NativeSender } from './native-sender.mjs';
import { BoundedNativeProvider, TestnetAcceptanceRpc } from './rpc-provider.mjs';
import { verifyNativeTransfer, verifyRefund } from '../near.mjs';
import { claimAbandoned, originalRefundPlan, recordCleanup } from './testnet-settlement.mjs';
import { requireThat, hash, uint, checkConservation } from '../contract.mjs';

export async function reconcileAbandonedTestnet(directory) {
  const merchant = JSON.parse(readFileSync(join(directory, 'merchant.json'), 'utf8'));
  requireThat(merchant.network === 'testnet' && merchant.role === 'merchant', 'testnet_merchant_required');
  const store = new Store(join(directory, 'mpp-testnet.sqlite'), Buffer.from(readFileSync(join(directory, 'storage.key'), 'utf8').trim(), 'hex'));
  const rpc = new TestnetAcceptanceRpc(store);
  const sender = new NativeSender({ store, provider: new BoundedNativeProvider(rpc), rpc, accountId: merchant.account_id,
    secretKey: merchant.private_key, maxTotalYocto: '50000000000000000000000', gasCapYocto: '10000000000000000000000', storagePriceYocto: '10000000000000000000' });
  requireThat((await rpc.call('status', [])).chain_id === 'testnet', 'testnet_required');
  const evidence = { scope: 'testnet-interrupted-payment-refund-only', actualInference: false, orders: [] };
  try {
    for (const snapshot of store.list('testnet-mpp-order', 'testnet')) {
      const order = claimAbandoned(store, snapshot.request.orderRef, Date.now());
      if (!order) continue;
      const r = order.request;
      requireThat(r.network === 'testnet' && r.recipient === merchant.account_id && r.refundTo === r.payer, 'original_testnet_binding_required');
      const scope = hash(['testnet', r.payer]);
      const originals = store.list('native-signed-send', scope).filter(x => x.plan.orderRef === r.orderRef);
      requireThat(originals.length <= 1, 'original_payment_ambiguous');
      if (!originals[0]?.bytes) continue; // no new agent payment is ever created
      const original = originals[0];
      requireThat(original.plan.network === 'testnet' && original.plan.amount === r.amount
        && original.plan.sender === r.payer && original.plan.recipient === r.recipient, 'original_payment_plan_mismatch');
      const tx = await rpc.transaction(original.txHash, r.payer), cached = Object.create(rpc);
      cached.transaction = async (h, payer) => { requireThat(h === original.txHash && payer === r.payer, 'original_transaction_required'); return tx; };
      const payment = await verifyNativeTransfer({ rpc: cached, p: { txHash: original.txHash, publicKey: original.publicKey }, r, challengeId: 'interrupted-testnet-cleanup' });
      let gas = 0n; for (const row of [tx.transaction_outcome, ...tx.receipts_outcome]) gas += uint(row.outcome.tokens_burnt);
      const policy = store.get('native-sender-policy', scope);
      store.put('native-signed-send', hash([scope, original.plan.idempotencyKey]), scope, { ...original, state: 'final',
        proof: { ...payment, gasPayer: r.payer, gasActualYocto: String(gas), gasCapExceeded: gas > uint(policy.gasCapYocto) } });
      const id = 'refund-' + r.orderRef;
      const plan = originalRefundPlan(store, r.orderRef, { kind: 'abandoned', amount: r.amount, createdAtMs: Date.now() });
      const prepared = await sender.prepare(plan);
      if (prepared.state !== 'final') { try { await sender.reconcile(plan.idempotencyKey); } catch { await sender.broadcast(plan.idempotencyKey); } }
      const final = sender.get(plan.idempotencyKey), originalSend = { operationId: id, idempotencyKey: plan.idempotencyKey, planHash: hash(plan), txHash: final.txHash };
      const refund = await verifyRefund({ plan, originalSend, txHash: final.txHash, publicKey: merchant.public_key, rpc });
      const principal = { P: r.amount, C: '0', H: '0', W: '0', R: r.amount }; checkConservation(principal);
      const result = { orderRef: r.orderRef, reason: 'expired-unfulfilled-protocol-case', payment: { ...payment, gasActualYocto: String(gas), gasPayer: r.payer },
        refund: { ...refund, gasActualYocto: final.proof.gasActualYocto, gasPayer: merchant.account_id }, principal };
      recordCleanup(store, r.orderRef, result);
      evidence.orders.push(result);
      console.log(JSON.stringify({ orderRef: r.orderRef, paymentTxHash: original.txHash, refundTxHash: refund.txHash, principal }));
    }
    writeFileSync(join(directory, 'mpp-testnet-cleanup-evidence.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
    return evidence;
  } finally { store.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await reconcileAbandonedTestnet(process.argv[2]);
