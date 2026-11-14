import { createHash, createPublicKey, verify } from 'node:crypto';
import bs58 from 'bs58';
import { hash, uint, challengeIdentity, requireThat, validateRequest, payloadSchema, signedPayload, METHOD } from './contract.mjs';

const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const str = s => { const b = Buffer.from(s); return Buffer.concat([u32(b.length), b]); };
export function nep413Digest({ message, nonce, recipient }) {
  const n = Buffer.from(nonce, 'base64');
  requireThat(n.length === 32 && n.toString('base64') === nonce, 'invalid_nonce');
  return createHash('sha256').update(Buffer.concat([
    u32(2 ** 31 + 413), str(message), n, str(recipient), Buffer.from([0]),
  ])).digest();
}
export function verifyBinding(challenge, payload) {
  payloadSchema.parse(payload);
  const key = Buffer.from(bs58.decode(payload.publicKey.slice(8)));
  const sig = Buffer.from(payload.signature, 'base64');
  requireThat(key.length === 32 && sig.length === 64 && sig.toString('base64') === payload.signature, 'invalid_signature_encoding');
  const publicKey = createPublicKey({ format: 'der', type: 'spki',
    key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), key]) });
  requireThat(verify(null, nep413Digest(signedPayload(challenge, payload.txHash)), publicKey, sig), 'invalid_order_signature');
}

// RPC and its TLS/chain configuration are trusted infrastructure, not supplied
// by a Credential. This is a read-only verifier, not a light-client proof.
export class NearRpc {
  constructor({ url, network, fetcher = fetch, controlled = false }) {
    const u = new URL(url);
    requireThat((u.protocol === 'https:' || (controlled && u.protocol === 'http:' && u.hostname === '127.0.0.1'))
      && !u.username && !u.password && !u.hash && !u.search, 'untrusted_rpc_url');
    requireThat(['mainnet', 'testnet'].includes(network), 'invalid_network');
    Object.assign(this, { url, network, fetcher });
  }
  async call(method, params) {
    const response = await this.fetcher(this.url, { method: 'POST', redirect: 'error',
      signal: AbortSignal.timeout(12_000), headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: METHOD, method, params }) });
    requireThat(response.ok, 'rpc_unavailable_unknown');
    // Bound bytes while reading; Content-Length alone is not authoritative.
    requireThat(response.body, 'rpc_empty_response_unknown');
    const reader = response.body.getReader(), chunks = []; let size = 0;
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.length;
      if (size > 1024 * 1024) { await reader.cancel(); throw new Error('rpc_response_too_large_unknown'); }
      chunks.push(value);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requireThat(!body.error && body.result, 'rpc_error_unknown');
    return body.result;
  }
  async transaction(txHash, payer) {
    const status = await this.call('status', []);
    requireThat(status.chain_id === this.network, 'rpc_network_mismatch');
    return this.call('tx', { tx_hash: txHash, sender_account_id: payer, wait_until: 'FINAL' });
  }
  block(blockId) { return this.call('block', { block_id: blockId }); }
  keyAt(accountId, publicKey, blockId) {
    return this.call('query', { request_type: 'view_access_key', account_id: accountId,
      public_key: publicKey, block_id: blockId });
  }
}
const success = s => s && (typeof s.SuccessValue === 'string' || typeof s.SuccessReceiptId === 'string');
const blockTime = block => {
  const ns = block?.header?.timestamp_nanosec;
  requireThat(typeof ns === 'string' && /^[0-9]{1,20}$/.test(ns), 'invalid_block_time');
  const ms = BigInt(ns) / 1_000_000n;
  requireThat(ms <= BigInt(Number.MAX_SAFE_INTEGER), 'invalid_block_time');
  return BigInt(ns);
};

export async function verifyPayment({ credential, expectedChallenge, rpc }) {
  // Only the original server-persisted challenge may authorize this resource.
  const c = credential.challenge;
  requireThat(c.method === METHOD && c.intent === 'charge'
    && challengeIdentity(c) === challengeIdentity(expectedChallenge), 'challenge_mismatch');
  const r = validateRequest(c.request), p = payloadSchema.parse(credential.payload);
  requireThat(r.network === rpc.network, 'network_mismatch');
  requireThat(bs58.decode(p.txHash).length === 32, 'invalid_transaction_hash');
  verifyBinding(c, p);
  return verifyNativeTransfer({ rpc, p, r, challengeId: c.id });
}

async function verifyNativeTransfer({ rpc, p, r, challengeId }) {
  const tx = await rpc.transaction(p.txHash, r.payer);
  requireThat(tx.final_execution_status === 'FINAL', 'payment_pending_unknown');
  requireThat(tx.transaction?.hash === p.txHash && tx.transaction.signer_id === r.payer
    && tx.transaction.receiver_id === r.recipient && tx.transaction.public_key === p.publicKey, 'transaction_identity_mismatch');
  const actions = tx.transaction.actions;
  requireThat(actions?.length === 1 && Object.keys(actions[0]).length === 1
    && actions[0].Transfer?.deposit === r.amount, 'not_exact_native_transfer');
  requireThat(typeof tx.status?.SuccessValue === 'string', 'chain_payment_failed');
  const root = tx.transaction_outcome;
  requireThat(root?.id === p.txHash && root.outcome?.executor_id === r.payer
    && success(root.outcome.status), 'invalid_transaction_outcome');
  requireThat(typeof root.outcome.status.SuccessReceiptId === 'string', 'missing_transfer_receipt');
  requireThat(root.outcome.receipt_ids?.length === 1
    && root.outcome.receipt_ids[0] === root.outcome.status.SuccessReceiptId, 'invalid_transfer_root');
  const rows = tx.receipts_outcome;
  requireThat(Array.isArray(rows) && rows.length > 0 && rows.length <= 64, 'missing_receipts_unknown');
  const byId = new Map(rows.map(x => [x.id, x]));
  requireThat(byId.size === rows.length, 'duplicate_receipt');
  // Traverse the actual transaction receipt graph. Every produced receipt must
  // be present, final and successful. Unrelated successful outcomes prove zero.
  const queue = [...(root.outcome.receipt_ids ?? [])], seen = new Set();
  while (queue.length) {
    const id = queue.shift(); requireThat(!seen.has(id), 'invalid_receipt_graph'); seen.add(id);
    const row = byId.get(id); requireThat(row, 'missing_receipt_unknown');
    requireThat(success(row.outcome?.status), 'receipt_failed');
    requireThat(Array.isArray(row.outcome.receipt_ids), 'invalid_receipt_graph');
    queue.push(...row.outcome.receipt_ids);
  }
  requireThat(seen.size === rows.length, 'unrelated_receipt');
  const paid = byId.get(root.outcome.status.SuccessReceiptId);
  requireThat(paid && seen.has(paid.id) && paid.outcome.executor_id === r.recipient
    && typeof paid.outcome.status.SuccessValue === 'string', 'merchant_receipt_mismatch');
  const [inclusion, settlement, key] = await Promise.all([
    rpc.block(root.block_hash), rpc.block(paid.block_hash), rpc.keyAt(r.payer, p.publicKey, root.block_hash),
  ]);
  requireThat(inclusion.header.hash === root.block_hash && settlement.header.hash === paid.block_hash, 'block_hash_mismatch');
  requireThat(key.permission === 'FullAccess', 'payer_key_not_full_access');
  const includedAtNs = blockTime(inclusion), paidAtNs = blockTime(settlement);
  const paidAtMs = Number(paidAtNs / 1_000_000n);
  requireThat(includedAtNs >= BigInt(r.issuedAtMs) * 1_000_000n && paidAtNs >= includedAtNs, 'payment_predates_order');
  // Native-only, single Transfer: a successful merchant receipt receives the
  // full deposit. FunctionCall/FT/self-transfer/batched actions are excluded.
  return { movementKey: `near:${r.network}:${p.txHash}:${paid.id}:0`,
    network: r.network, payer: r.payer, recipient: r.recipient, amount: r.amount,
    orderRef: r.orderRef, challengeId, receiptId: paid.id, txHash: p.txHash,
    paidAtMs, paidAtNs: String(paidAtNs), late: paidAtNs > BigInt(r.expiresAtMs) * 1_000_000n,
    asset: 'native:NEAR', decimals: 24 };
}

// Refunds are merchant-owned operations, with a stable original transaction.
// Buyer grant revocation has no role. The plan comes from the original refund
// outbox, not the caller. The merchant owns its signing/execution credential.
export function refundPlan({ orderRef, binding, amount, refundableYocto, operationId, createdAtMs }) {
  requireThat(/^[0-9a-f]{64}$/.test(orderRef) && /^[a-zA-Z0-9_-]{1,128}$/.test(operationId), 'invalid_refund_identity');
  const r = validateRequest(binding);
  requireThat(orderRef === r.orderRef, 'refund_order_binding_mismatch');
  requireThat(/^[1-9][0-9]{0,38}$/.test(amount) && BigInt(amount) <= BigInt(r.amount), 'invalid_refund_amount');
  requireThat(uint(amount) <= uint(refundableYocto), 'refund_exceeds_remaining_liability');
  requireThat(Number.isSafeInteger(createdAtMs) && createdAtMs >= r.issuedAtMs, 'invalid_refund_time');
  return { operationId, orderRef, network: r.network, asset: 'native:NEAR',
    sender: r.recipient, recipient: r.refundTo, amount, bindingVersion: r.bindingVersion,
    createdAtMs, idempotencyKey: `near-refund-v1-${hash([r.network, r.recipient, orderRef, operationId, r.bindingVersion])}` };
}

export async function verifyRefund({ plan, originalSend, txHash, publicKey, rpc }) {
  // Supplied by the merchant's durable original-operation journal, not by a
  // presented hash or caller. Equal-amount unrelated payouts are not refunds.
  requireThat(originalSend?.operationId === plan.operationId
    && originalSend.idempotencyKey === plan.idempotencyKey
    && originalSend.planHash === hash(plan) && typeof originalSend.txHash === 'string', 'original_refund_send_unknown');
  requireThat(txHash === originalSend.txHash, 'not_original_refund_transaction');
  requireThat(plan.network === rpc.network && plan.asset === 'native:NEAR'
    && bs58.decode(txHash).length === 32, 'refund_network_or_asset_mismatch');
  return verifyNativeTransfer({ rpc, p: { txHash, publicKey }, r: {
    network: plan.network, payer: plan.sender, recipient: plan.recipient, amount: plan.amount,
    orderRef: plan.orderRef, issuedAtMs: plan.createdAtMs, expiresAtMs: Number.MAX_SAFE_INTEGER,
  }, challengeId: plan.operationId });
}
