import { Mppx } from 'mppx/client';
import { Credential } from 'mppx';
import { Locks } from '../../../clients/buyer-gateway/src/store.mjs';
import { clientMethod } from '../method.mjs';
import { Wallet } from '../p3/wallet.mjs';
import { verifyPolicy } from '../p3/outlayer.mjs';
import { hash, nativePlan, requireThat, uint } from '../contract.mjs';

// One process owns the encrypted SQLite journal. The acceptance launcher also
// holds an exclusive process lock. Account scope prevents a new logical key
// from resetting the spending budget or bypassing an unresolved original send.
export class OutLayerOperations {
  constructor({ store, binding, limits, authorize }) {
    Object.assign(this, { store, binding, limits, authorize });
    this.scope = hash(['outlayer-cloud-v1', binding.network, binding.payer]);
    this.locks = new Locks();
    store.transaction(() => {
      const policy = { binding, limits }, old = store.get('outlayer-cloud-policy', this.scope);
      requireThat(!old || hash(old) === hash(policy), 'outlayer_account_policy_changed');
      if (!old) store.put('outlayer-cloud-policy', this.scope, this.scope, policy);
    });
  }
  rows() { return this.store.list('outlayer-cloud-operation', this.scope); }
  async get(id) { return this.store.get('outlayer-cloud-operation', id, this.scope); }
  put(row) { this.store.put('outlayer-cloud-operation', row.id, this.scope, row); }
  async create(row) {
    return this.store.transaction(() => {
      const old = this.store.get('outlayer-cloud-operation', row.id, this.scope);
      requireThat(!old || old.fingerprint === row.fingerprint, 'outlayer_original_operation_conflict');
      if (!old) this.put(row);
      return old ?? row;
    });
  }
  async lock(id, fn) {
    return this.locks.run(this.scope, () => fn({
      get: () => this.get(id),
      save: async row => this.store.transaction(() => this.put(row)),
      begin: async authorize => {
        const original = await this.get(id);
        await authorize(original.frozen, {});
        return this.store.transaction(() => {
          const row = this.store.get('outlayer-cloud-operation', id, this.scope);
          requireThat(row?.state === 'prepared' && row.attempts === 0, 'outlayer_already_dispatched');
          const others = this.rows().filter(r => r.id !== id && r.attempts > 0);
          requireThat(!others.some(r => r.state !== 'final' && r.state !== 'cancelled'), 'outlayer_original_send_pending');
          requireThat(!others.some(r => r.gasOverrun), 'outlayer_gas_overrun_stop');
          const committed = others.reduce((n, r) => n + uint(r.frozen.transfer.amount)
            + uint(r.feeProof?.gasActualYocto ?? r.frozen.gasReserveYocto), 0n);
          requireThat(committed + uint(row.frozen.transfer.amount) + uint(row.frozen.gasReserveYocto)
            <= uint(this.limits.totalYocto), 'outlayer_agent_budget_exhausted');
          const sending = { ...row, state: 'sending', attempts: 1 };
          this.put(sending); // FULL commit precedes OutLayer's only Transfer POST.
          return sending;
        });
      },
    }));
  }
}

export function outlayerCloudBuyer({ url, token, binding, api, store, rpc, limits, body, afterPaid }) {
  const authorize = async frozen => {
    requireThat(frozen.challenge.request.nativeRequestHash === hash(body)
      && uint(frozen.transfer.amount) <= uint(limits.principalCapYocto), 'unreviewed_cloud_payment');
    await verifyPolicy({ binding, rpc, api });
    const balance = await rpc.call('query', { request_type: 'view_account', finality: 'final', account_id: binding.payer });
    const available = BigInt(balance.amount) - BigInt(balance.locked) - BigInt(balance.storage_usage) * uint(limits.storagePriceYocto);
    requireThat(available >= uint(frozen.transfer.amount) + uint(limits.gasReserveYocto) + uint(limits.gasFloorYocto), 'outlayer_agent_balance_insufficient');
  };
  const operations = new OutLayerOperations({ store, binding, limits, authorize });
  const wallet = new Wallet({ store: operations, api, rpc, authorize, policy: b => verifyPolicy({ binding: b, rpc, api }) });
  const headers = { authorization: 'Bearer ' + token, 'content-type': 'application/json' };
  async function register(orderRef, document) {
    const result = await fetch(url + '/v1/orders/' + orderRef + '/payment', { method: 'POST', redirect: 'error',
      signal: AbortSignal.timeout(15000), headers, body: JSON.stringify(document) });
    requireThat(result.ok, 'original_payment_registration_unknown'); await result.text();
  }
  const client = Mppx.create({ polyfill: false, methods: [clientMethod({ recoverPayment: async challenge => {
    nativePlan(challenge, binding);
    requireThat(challenge.request.nativeRequestHash === hash(body)
      && uint(challenge.request.amount) <= uint(limits.principalCapYocto), 'unreviewed_cloud_payment');
    const original = await wallet.prepare({ challenge, binding, gasReserveYocto: limits.gasReserveYocto,
      gasFloorYocto: limits.gasFloorYocto, nanoUsdPerNear: limits.nanoUsdPerNear, taskId: 'one-cloud-task', userId: binding.agentId });
    const paid = await wallet.recover(original.id);
    if (!paid.credential) {
      // A confirmed transfer still creates a merchant liability if a later
      // freeze prevents NEP-413 signing. This path can ONLY refund, never infer.
      if (paid.proof) await register(original.orderRef, { refundOnly: true, txHash: paid.txHash, challengeId: challenge.id });
      throw new Error(paid.lastError ?? 'original_outlayer_payment_pending');
    }
    await register(original.orderRef, { credential: Credential.serialize(paid.credential) });
    await afterPaid?.(paid);
    return paid.credential;
  } })] });
  return { wallet, operations,
    invoke(key) { return client.fetch(url + '/v1/chat/completions', { method: 'POST', redirect: 'error',
      signal: AbortSignal.timeout(240000), headers: { ...headers, 'idempotency-key': key }, body }); },
    async status(id) {
      const r = await fetch(url + '/v1/orders/' + id, { headers, redirect: 'error', signal: AbortSignal.timeout(15000) });
      requireThat(r.ok, 'original_cloud_order_unavailable'); return r.json();
    },
  };
}
