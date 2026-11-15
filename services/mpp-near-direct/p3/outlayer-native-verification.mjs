import bs58 from 'bs58';
import { requireThat, uint, validateRequest, challengeIdentity, METHOD } from '../contract.mjs';
import { verifyNativeTransfer, verifyBinding } from '../near.mjs';

const terminal = status => status && (typeof status.SuccessValue === 'string'
  || typeof status.SuccessReceiptId === 'string' || (status.Failure && typeof status.Failure === 'object'));

// A FINAL fee can be known even when service principal is still unresolved.
// This function never declares that a failed Transfer returned its deposit.
export async function verifyAgentPaymentFee({ challenge, txHash, publicKey, rpc }) {
  const r=validateRequest(challenge.request), tx=await rpc.transaction(txHash,r.payer);
  requireThat(challenge.method===METHOD && challenge.intent==='charge' && r.network===rpc.network
    && tx.final_execution_status==='FINAL','payment_pending_unknown');
  const t=tx.transaction, root=tx.transaction_outcome;
  requireThat(t?.hash===txHash && t.signer_id===r.payer && t.public_key===publicKey
    && t.receiver_id===r.recipient && Number.isSafeInteger(t.nonce) && t.nonce>0 && t.nonce_index==null,
  'transaction_identity_mismatch');
  requireThat(t.actions?.length===1 && Object.keys(t.actions[0]).length===1
    && t.actions[0].Transfer?.deposit===r.amount,'not_exact_native_transfer');
  const first=root?.outcome?.status?.SuccessReceiptId;
  requireThat(root?.id===txHash && root.outcome.executor_id===r.payer && typeof first==='string'
    && root.outcome.receipt_ids?.length===1 && root.outcome.receipt_ids[0]===first,'native_fee_nonce_not_proven');
  const rows=tx.receipts_outcome;
  requireThat(Array.isArray(rows) && rows.length>0 && rows.length<=64 && terminal(tx.status),'missing_receipts_unknown');
  const byId=new Map(rows.map(row=>[row.id,row]));
  requireThat(byId.size===rows.length,'duplicate_receipt');
  const seen=new Set(), queue=[first];
  while(queue.length){
    const id=queue.shift(), row=byId.get(id);
    requireThat(row && !seen.has(id) && terminal(row.outcome?.status)
      && Array.isArray(row.outcome.receipt_ids),'incomplete_native_fee_graph');
    seen.add(id); queue.push(...row.outcome.receipt_ids);
  }
  requireThat(seen.size===rows.length && byId.get(first)?.outcome.executor_id===r.recipient,'unrelated_receipt');
  const [key,block]=await Promise.all([rpc.keyAt(r.payer,publicKey,root.block_hash),rpc.block(root.block_hash)]);
  requireThat(key.permission==='FullAccess','ordinary_native_key_required');
  requireThat(block.header.hash===root.block_hash && /^\d{1,20}$/.test(block.header.timestamp_nanosec)
    && BigInt(block.header.timestamp_nanosec)>=BigInt(r.issuedAtMs)*1000000n,'payment_predates_order');
  let gas=uint(root.outcome.tokens_burnt);
  for(const row of rows)gas+=uint(row.outcome.tokens_burnt);
  return {txHash,orderRef:r.orderRef,gasPayer:r.payer,gasActualYocto:String(gas),
    source:'final-rooted-outcomes-tokens-burnt',principalStatus:'not-established-by-fee-proof'};
}

// Read-only native route. RPC configuration and original transaction identity
// belong to the trusted executor, never to a presented Credential.
export async function verifyAgentPaidTransfer({ challenge, txHash, rpc, publicKey }) {
  const r = validateRequest(challenge.request);
  requireThat(challenge.method === METHOD && challenge.intent === 'charge', 'wrong_native_method');
  requireThat(r.network === rpc.network && bs58.decode(txHash).length === 32, 'native_network_or_hash_mismatch');
  const tx = await rpc.transaction(txHash, r.payer);
  requireThat(tx.final_execution_status === 'FINAL', 'payment_pending_unknown');
  const key = publicKey ?? tx.transaction?.public_key;
  requireThat(typeof key === 'string' && key.startsWith('ed25519:'), 'missing_native_signer');
  requireThat(Number.isSafeInteger(tx.transaction?.nonce) && tx.transaction.nonce > 0
    && tx.transaction.nonce_index == null, 'ordinary_native_key_required');
  // Cache this one result so receipt, fee and amount checks use the same FINAL
  // snapshot. FAILED/API SUCCESS labels never substitute for the chain proof.
  const cached = Object.create(rpc);
  cached.transaction = async (hash, payer) => {
    requireThat(hash === txHash && payer === r.payer, 'original_transaction_required');
    return tx;
  };
  const proof = await verifyNativeTransfer({ rpc: cached, p: { txHash, publicKey: key }, r, challengeId: challenge.id });
  let gas = 0n;
  for (const row of [tx.transaction_outcome, ...tx.receipts_outcome]) {
    gas += uint(row.outcome.tokens_burnt);
  }
  return { ...proof, publicKey: key, gasActualYocto: String(gas), gasPayer: r.payer,
    gasSource: 'final-rooted-outcomes-tokens-burnt', method: METHOD, methodVersion: 1 };
}

export async function verifyAgentPaidCredential({ credential, expectedChallenge, original, rpc }) {
  requireThat(challengeIdentity(credential.challenge) === challengeIdentity(expectedChallenge), 'challenge_mismatch');
  requireThat(original?.txHash === credential.payload.txHash && original?.credential
    && challengeIdentity(original.credential.challenge) === challengeIdentity(expectedChallenge)
    && original.credential.payload.txHash === credential.payload.txHash, 'original_api_payment_required');
  verifyBinding(credential.challenge, credential.payload);
  return verifyAgentPaidTransfer({ challenge: expectedChallenge, txHash: credential.payload.txHash,
    publicKey: credential.payload.publicKey, rpc });
}
