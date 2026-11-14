import { generateKeyPairSync, sign } from 'node:crypto';
import bs58 from 'bs58';
import { Challenge } from 'mppx';
import { signedPayload, hash, METHOD } from '../contract.mjs';
import { nep413Digest } from '../near.mjs';

export const now = 1_800_000_000_000;
export function keys() {
  const pair = generateKeyPairSync('ed25519');
  return { publicKey: `ed25519:${bs58.encode(pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32))}`,
    sign: payload => sign(null, nep413Digest(payload), pair.privateKey).toString('base64') };
}
export function fixture({ request = {}, txChange, challenge: supplied } = {}) {
  const key = keys(), txHash = bs58.encode(Buffer.alloc(32, 7)), receiptId = bs58.encode(Buffer.alloc(32, 8));
  const r = { version: 1, network: 'testnet', currency: 'NEAR', decimals: 24,
    amount: '1000000000000000000000', recipient: 'merchant.testnet', payer: 'agent.testnet',
    refundTo: 'agent.testnet', bindingVersion: 'agent-binding-v1', orderRef: hash('order-1'),
    termsHash: hash('terms-1'), nativeRequestHash: hash('exact native bytes'),
    nonce: Buffer.alloc(32, 3).toString('base64'), issuedAtMs: now, expiresAtMs: now + 60_000,
    signingRecipient: 'payments.example.com', ...request };
  const challenge = supplied ?? Challenge.from({ secretKey: 'controlled-p0-secret-not-a-deployment-key',
    realm: 'payments.example.com', method: METHOD, intent: 'charge', request: r,
    expires: new Date(r.expiresAtMs).toISOString() });
  const credential = { challenge, payload: { txHash, publicKey: key.publicKey,
    signature: key.sign(signedPayload(challenge, txHash)) } };
  const tx = { final_execution_status: 'FINAL', status: { SuccessValue: '' },
    transaction: { hash: txHash, signer_id: r.payer, public_key: key.publicKey,
      receiver_id: r.recipient, nonce: 11, actions: [{ Transfer: { deposit: r.amount } }] },
    transaction_outcome: { id: txHash, block_hash: 'inclusion', outcome: { executor_id: r.payer,
      receipt_ids: [receiptId], status: { SuccessReceiptId: receiptId } } },
    receipts_outcome: [{ id: receiptId, block_hash: 'settlement', outcome: {
      executor_id: r.recipient, receipt_ids: [], status: { SuccessValue: '' }, logs: [] } }] };
  txChange?.(tx);
  const blocks = { inclusion: now + 1000, settlement: now + 2000 };
  const rpc = { network: r.network, transaction: async (h, p) => {
    if (h !== txHash || p !== r.payer) throw new Error('unexpected_rpc_identity'); return tx;
  }, block: async id => ({ header: { hash: id, timestamp_nanosec: String(BigInt(blocks[id]) * 1_000_000n) } }),
  keyAt: async () => ({ permission: 'FullAccess' }) };
  return { key, txHash, receiptId, tx, rpc, blocks, challenge, credential, request: r,
    resign(c = credential) { c.payload.signature = key.sign(signedPayload(c.challenge, c.payload.txHash)); return c; } };
}
