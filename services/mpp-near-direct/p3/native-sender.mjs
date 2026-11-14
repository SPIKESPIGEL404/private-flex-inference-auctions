import { randomUUID, createHash } from 'node:crypto';
import { KeyPair, KeyPairSigner, createTransaction, actions, baseDecode, baseEncode, SignedTransaction } from 'near-api-js';
import { hash, uint, requireThat, account } from '../contract.mjs';
import { verifyNativeTransfer } from '../near.mjs';

// Trusted local signer for the merchant refund outbox and bounded acceptance
// wallets. Production agent keys use the browser vault, never this service.
// The caller must supply a plan from its owning authority, not HTTP input.
export class NativeSender {
  constructor({ store, provider, rpc, accountId, secretKey, maxTotalYocto, gasCapYocto, storagePriceYocto }) {
    requireThat(account.test(accountId) && rpc.network, 'invalid_sender');
    requireThat(uint(maxTotalYocto) > 0n && uint(gasCapYocto) > 0n && uint(storagePriceYocto) > 0n, 'invalid_sender_limits');
    this.key = KeyPair.fromString(secretKey);
    Object.assign(this, { store, provider, rpc, accountId, maxTotalYocto, gasCapYocto, storagePriceYocto });
    this.publicKey = this.key.getPublicKey().toString();
    // Budgets and unresolved operations belong to the ACCOUNT. A new key must
    // not reset its history or create an independent nonce/pending fence.
    this.scope = hash([rpc.network, accountId]);
    store.transaction(() => {
      const old = store.get('native-sender-policy', this.scope);
      const policy = { network: rpc.network, accountId, publicKey: this.publicKey, maxTotalYocto, gasCapYocto, storagePriceYocto };
      requireThat(!old || hash(old) === hash(policy), 'sender_policy_changed');
      if (!old) store.put('native-sender-policy', this.scope, this.scope, policy);
    });
  }
  validate(plan) {
    requireThat(plan.network === this.rpc.network && plan.asset === 'native:NEAR'
      && plan.sender === this.accountId && account.test(plan.recipient) && plan.recipient !== plan.sender
      && /^[a-zA-Z0-9_-]{1,128}$/.test(plan.idempotencyKey) && uint(plan.amount) > 0n
      && Number.isSafeInteger(plan.createdAtMs), 'invalid_native_send_plan');
  }
  get(id) { return this.store.get('native-signed-send', hash([this.scope, id]), this.scope); }
  put(record) { this.store.put('native-signed-send', hash([this.scope, record.plan.idempotencyKey]), this.scope, record); }
  async prepare(plan) {
    this.validate(plan);
    const claim = randomUUID();
    const prior = this.store.transaction(() => {
      const old = this.get(plan.idempotencyKey);
      requireThat(!old || hash(old.plan) === hash(plan), 'original_native_plan_conflict');
      if (old?.bytes) return old;
      const all = this.store.list('native-signed-send', this.scope);
      requireThat(!all.some(r => r.plan.idempotencyKey !== plan.idempotencyKey && r.state !== 'final'), 'payer_original_send_pending');
      requireThat(!all.some(r => r.proof?.gasCapExceeded), 'native_sender_gas_cap_exceeded');
      const spent = all.filter(r => r.state === 'final').reduce((s, r) => s + uint(r.plan.amount) + uint(r.proof.gasActualYocto), 0n);
      requireThat(spent + uint(plan.amount) + uint(this.gasCapYocto) <= uint(this.maxTotalYocto), 'native_sender_budget_exhausted');
      // Taking over an interrupted preparation revokes the older signer. It
      // cannot commit or broadcast unless it still owns this exact claim.
      this.put({ plan, state: 'preparing', claim });
      return null;
    });
    if (prior) return prior;
    const status = await this.rpc.call('status', []);
    requireThat(status.chain_id === plan.network, 'network_mismatch');
    const [access, balance] = await Promise.all([
      this.provider.viewAccessKey({ accountId: plan.sender, publicKey: this.publicKey, finalityQuery: { finality: 'final' } }),
      this.provider.viewAccount({ accountId: plan.sender, blockQuery: { finality: 'final' } }),
    ]);
    requireThat(access.permission === 'FullAccess', 'ordinary_native_key_required');
    const available = BigInt(balance.amount) - BigInt(balance.locked) - BigInt(balance.storage_usage) * uint(this.storagePriceYocto);
    requireThat(available >= uint(plan.amount) + uint(this.gasCapYocto), 'native_sender_balance_insufficient');
    const highNonce = this.store.list('native-signed-send', this.scope).reduce((n, r) => {
      if (!r.bytes) return n;
      const saved = BigInt(SignedTransaction.decode(Buffer.from(r.bytes, 'base64')).transaction.nonce);
      return saved > n ? saved : n;
    }, BigInt(access.nonce));
    const tx = createTransaction(plan.sender, this.key.getPublicKey(), plan.recipient, highNonce + 1n,
      [actions.transfer(uint(plan.amount))], baseDecode(access.block_hash));
    const signed = await new KeyPairSigner(this.key).signTransaction(tx);
    return this.store.transaction(() => {
      const current = this.get(plan.idempotencyKey);
      requireThat(current?.claim === claim && current.state === 'preparing', 'native_preparation_fenced');
      const record = { plan, state: 'signed', publicKey: this.publicKey, txHash: baseEncode(signed.txHash),
        bytes: Buffer.from(signed.signedTransaction.encode()).toString('base64') };
      requireThat(!this.store.list('native-signed-send', this.scope).some(r => r.txHash === record.txHash), 'native_transaction_already_assigned');
      this.put(record); // synchronous FULL SQLite commit BEFORE any broadcast
      return record;
    });
  }
  async broadcast(id) {
    const record = this.get(id);
    requireThat(record?.bytes, 'original_signed_send_required');
    if (record.state === 'final') return record;
    const signed = SignedTransaction.decode(Buffer.from(record.bytes, 'base64')), t = signed.transaction;
    requireThat(baseEncode(createHash('sha256').update(t.encode()).digest()) === record.txHash
      && t.signerId === record.plan.sender && t.receiverId === record.plan.recipient
      && t.publicKey.toString() === this.publicKey && t.actions.length === 1
      && t.actions[0].transfer?.deposit.toString() === record.plan.amount, 'original_signed_send_mismatch');
    this.store.transaction(() => { const r = this.get(id); if (r.state !== 'final') this.put({ ...r, state: 'unknown' }); });
    // A timeout leaves unknown. Recovery sends only these original bytes; it
    // never signs another nonce or infers failure from transaction-not-found.
    await this.provider.sendTransactionUntil(signed, 'FINAL');
    return this.reconcile(id);
  }
  async reconcile(id) {
    const record = this.get(id);
    requireThat(record?.bytes, 'original_signed_send_required');
    if (record.state === 'final') return record;
    const plan = record.plan, tx = await this.rpc.transaction(record.txHash, plan.sender);
    const cached = Object.create(this.rpc);
    cached.transaction = async (h, payer) => {
      requireThat(h === record.txHash && payer === plan.sender, 'original_transaction_required'); return tx;
    };
    const proof = await verifyNativeTransfer({ rpc: cached, p: { txHash: record.txHash, publicKey: this.publicKey },
      r: { network: plan.network, payer: plan.sender, recipient: plan.recipient, amount: plan.amount,
        orderRef: plan.orderRef, issuedAtMs: plan.createdAtMs, expiresAtMs: Number.MAX_SAFE_INTEGER }, challengeId: plan.operationId });
    let gas = 0n;
    for (const row of [tx.transaction_outcome, ...tx.receipts_outcome]) gas += uint(row.outcome.tokens_burnt);
    const finalProof = { ...proof, gasPayer: plan.sender, gasActualYocto: String(gas), gasCapExceeded: gas > uint(this.gasCapYocto) };
    return this.store.transaction(() => {
      const current = this.get(id);
      requireThat(current.txHash === record.txHash, 'original_native_send_conflict');
      const final = { ...current, state: 'final', proof: finalProof }; this.put(final); return final;
    });
  }
}
