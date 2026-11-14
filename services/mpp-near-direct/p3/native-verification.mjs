import { verifyPayment } from '../near.mjs';
import { requireThat, uint } from '../contract.mjs';

// Principal and fee use the SAME independently read FINAL transaction. A
// provider's send acknowledgement, gas estimate or wallet balance delta is
// never the settlement authority.
export async function verifyAgentPaidCredential({ credential, expectedChallenge, rpc }) {
  const r = expectedChallenge.request, p = credential.payload;
  const tx = await rpc.transaction(p.txHash, r.payer);
  requireThat(Number.isSafeInteger(tx.transaction?.nonce) && tx.transaction.nonce > 0
    && tx.transaction.nonce_index == null, 'ordinary_native_key_required');
  const cached = Object.create(rpc);
  cached.transaction = async (txHash, payer) => {
    requireThat(txHash === p.txHash && payer === r.payer, 'original_transaction_required');
    return tx;
  };
  const proof = await verifyPayment({ credential, expectedChallenge, rpc: cached });
  let gas = 0n;
  for (const row of [tx.transaction_outcome, ...tx.receipts_outcome]) gas += uint(row.outcome.tokens_burnt);
  return { ...proof, publicKey: p.publicKey, gasPayer: r.payer,
    gasActualYocto: String(gas), gasSource: 'final-rooted-outcomes-tokens-burnt' };
}
