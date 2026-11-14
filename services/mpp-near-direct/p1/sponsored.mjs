// Historical controlled v2 only. G1 review found that real Delegate Transfer
// deposits are paid by the relayer, and real receipt status differs from this
// fixture. Do not enable for live agent-principal/project-gas attribution.
import { createHash, createPublicKey, verify } from 'node:crypto';
import bs58 from 'bs58';
import { Method, Credential, Receipt, z } from 'mppx';
import { requestSchema, payloadSchema, validateRequest, canonical, challengeIdentity, hash, account, uint, requireThat } from '../contract.mjs';
import { nep413Digest } from '../near.mjs';
export const SPONSORED='bitrouter-near-sponsored';
const fields={...requestSchema.shape,version:z.literal(2),gasSponsor:z.string().check(z.regex(account)),sponsorOperation:z.string().check(z.regex(/^[0-9a-f]{64}$/))};
const schema=z.strictObject(fields);
export const sponsored=Method.from({name:SPONSORED,intent:'charge',schema:{request:schema,credential:{payload:payloadSchema}}});
export function sponsoredRequest(r){
 schema.parse(r);const {gasSponsor,sponsorOperation,version,...rest}=r;validateRequest({...rest,version:1});
 requireThat(gasSponsor!==r.payer&&gasSponsor!==r.recipient,'sponsor_not_separate');return r;
}
export function principalRequest(r){const {gasSponsor,sponsorOperation,version,...rest}=sponsoredRequest(r);return {...rest,version:1};}
export function sponsoredPayload(c,txHash){
 return {message:canonical([SPONSORED,2,c.realm,c.id,hash(sponsoredRequest(c.request)),txHash]),nonce:c.request.nonce,recipient:c.request.signingRecipient};
}
function publicKey(key){const b=Buffer.from(bs58.decode(key.slice(8)));requireThat(key.startsWith('ed25519:')&&b.length===32,'invalid_ed25519_key');
 return createPublicKey({format:'der',type:'spki',key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),b])});}
const nbytes=(n,size)=>{let value=BigInt(n);requireThat(value>=0n&&value<(1n<<BigInt(size*8)),'delegate_integer_overflow');const b=Buffer.alloc(size);for(let i=0;i<size;i++){b[i]=Number(value&255n);value>>=8n;}return b;};
const str=s=>Buffer.concat([nbytes(Buffer.byteLength(s),4),Buffer.from(s)]);
export function delegateDigest(d){
 requireThat(d.actions?.length===1&&d.actions[0].Transfer&&Object.keys(d.actions[0]).length===1,'unsupported_delegate_actions');
 for(const n of [d.nonce,d.max_block_height])requireThat(typeof n==='string'||Number.isSafeInteger(n),'unsafe_delegate_integer');
 const key=Buffer.from(bs58.decode(d.public_key.slice(8)));requireThat(d.public_key.startsWith('ed25519:')&&key.length===32,'invalid_delegate_key');
 return createHash('sha256').update(Buffer.concat([nbytes(2**30+366,4),str(d.sender_id),str(d.receiver_id),nbytes(1,4),
   Buffer.from([3]),nbytes(uint(d.actions[0].Transfer.deposit),16),nbytes(d.nonce,8),nbytes(d.max_block_height,8),Buffer.from([0]),key])).digest();
}
export async function verifySponsored({credential,expectedChallenge,rpc,allowMismatch=false,allowFailure=false}){
 const c=credential.challenge,r=sponsoredRequest(c.request),p=payloadSchema.parse(credential.payload);
 requireThat(c.method===SPONSORED&&c.intent==='charge'&&challengeIdentity(c)===challengeIdentity(expectedChallenge),'sponsored_challenge_mismatch');
 requireThat(r.network===rpc.network&&bs58.decode(p.txHash).length===32,'sponsored_network_mismatch');
 requireThat(verify(null,nep413Digest(sponsoredPayload(c,p.txHash)),publicKey(p.publicKey),Buffer.from(p.signature,'base64')),'invalid_order_signature');
 const tx=await rpc.transaction(p.txHash,r.gasSponsor);
 requireThat(tx.final_execution_status==='FINAL','sponsored_payment_unknown');
 const t=tx.transaction;
 requireThat(t.hash===p.txHash&&t.signer_id===r.gasSponsor&&t.receiver_id===r.payer&&t.actions?.length===1
  &&Object.keys(t.actions[0]).length===1&&t.actions[0].Delegate,'sponsor_transaction_mismatch');
 const signed=t.actions[0].Delegate,d=signed.delegate_action;
 requireThat(d.sender_id===r.payer&&d.receiver_id===r.recipient&&d.public_key===p.publicKey,'delegate_principal_mismatch');
 requireThat(signed.signature?.startsWith('ed25519:')&&verify(null,delegateDigest(d),publicKey(d.public_key),bs58.decode(signed.signature.slice(8))),'invalid_delegate_signature');
 const amount=d.actions[0].Transfer.deposit;uint(amount);
 requireThat(allowMismatch||amount===r.amount,'not_exact_sponsored_principal');
 const root=tx.transaction_outcome;
 const failed=Boolean(tx.status?.Failure);
 requireThat(root.id===p.txHash&&root.outcome.executor_id===r.gasSponsor&&root.outcome.receipt_ids?.length===1
  &&root.outcome.status.SuccessReceiptId===root.outcome.receipt_ids[0]&&(typeof tx.status?.SuccessValue==='string'||(allowFailure&&failed)),'sponsored_chain_failed');
 const rows=tx.receipts_outcome;requireThat(Array.isArray(rows)&&rows.length<=64,'sponsored_receipts_unknown');
 const map=new Map(rows.map(x=>[x.id,x]));requireThat(map.size===rows.length,'duplicate_receipt');
 const queue=[...root.outcome.receipt_ids],seen=new Set();
 while(queue.length){const id=queue.shift();requireThat(!seen.has(id),'invalid_receipt_graph');seen.add(id);const x=map.get(id);
  requireThat(x&&Array.isArray(x.outcome.receipt_ids),'sponsored_receipts_unknown');
  requireThat(typeof x.outcome.status?.SuccessValue==='string'||typeof x.outcome.status?.SuccessReceiptId==='string'||(allowFailure&&failed&&x.outcome.status?.Failure),'sponsored_receipt_failed');queue.push(...x.outcome.receipt_ids);}
 requireThat(seen.size===rows.length,'unrelated_receipt');
 const delegated=map.get(root.outcome.status.SuccessReceiptId);
 requireThat(delegated?.outcome.executor_id===r.payer&&delegated.outcome.receipt_ids.includes(delegated.outcome.status.SuccessReceiptId),'delegate_receipt_mismatch');
 const paid=map.get(delegated.outcome.status.SuccessReceiptId);
 requireThat(paid?.outcome.executor_id===r.recipient&&(typeof paid.outcome.status.SuccessValue==='string'||(allowFailure&&failed&&paid.outcome.status.Failure)),'merchant_receipt_mismatch');
 const [included,execution,settled,key,sponsorKey]=await Promise.all([rpc.block(root.block_hash),rpc.block(delegated.block_hash),rpc.block(paid.block_hash),
  rpc.keyAt(r.payer,p.publicKey,delegated.block_hash),rpc.keyAt(r.gasSponsor,t.public_key,root.block_hash)]);
 requireThat(included.header.hash===root.block_hash&&execution.header.hash===delegated.block_hash&&settled.header.hash===paid.block_hash,'block_hash_mismatch');
 requireThat(key.permission==='FullAccess'&&sponsorKey.permission==='FullAccess','sponsored_key_not_full_access');
 requireThat(Number.isSafeInteger(execution.header.height)&&BigInt(execution.header.height)<=BigInt(d.max_block_height)&&BigInt(d.nonce)>0n,'delegate_protocol_expired');
 const ns=BigInt(settled.header.timestamp_nanosec),start=BigInt(included.header.timestamp_nanosec);
 requireThat(start>=BigInt(r.issuedAtMs)*1000000n&&ns>=start,'payment_predates_order');
 let gas=0n;for(const x of [root,...rows])gas+=uint(x.outcome.tokens_burnt);
 const nonceConsumed=key.nonce!==undefined&&BigInt(key.nonce)>=BigInt(d.nonce);
 if(failed)requireThat(nonceConsumed,'failed_delegate_still_replayable_unknown');
 return {movementKey:`near:${r.network}:${p.txHash}:${paid.id}:0`,network:r.network,payer:r.payer,recipient:r.recipient,
  amount:failed?'0':amount,expectedAmount:r.amount,orderRef:r.orderRef,challengeId:c.id,receiptId:paid.id,txHash:p.txHash,paidAtMs:Number(ns/1000000n),paidAtNs:String(ns),
  late:ns>BigInt(r.expiresAtMs)*1000000n,asset:'native:NEAR',decimals:24,gasSponsor:r.gasSponsor,sponsorOperation:r.sponsorOperation,
  gasActualYocto:String(gas),delegateNonce:String(d.nonce),delegateMaxBlockHeight:String(d.max_block_height),methodVersion:2,failed,nonceConsumed};
}
export function sponsoredClient({recoverPayment}){return Method.toClient(sponsored,{async createCredential({challenge}){
 const original=await recoverPayment(challenge);requireThat(challengeIdentity(original.challenge)===challengeIdentity(challenge),'original_payment_required');return Credential.serialize(original);
}});}
export function sponsoredServer({rpc,authority}){return Method.toServer(sponsored,{async verify({credential}){
 const expectedChallenge=await authority.loadChallenge(credential.challenge.id);requireThat(expectedChallenge,'unknown_challenge');
 await authority.journalPresentation(credential);
 const proof=await verifySponsored({credential,expectedChallenge,rpc,allowMismatch:true});
 const result=await authority.consumeVerifiedPayment(proof);
 requireThat(result.committed&&result.projectionReady&&!proof.late,'payment_not_admissible');
 return Receipt.from({method:SPONSORED,status:'success',reference:proof.movementKey,timestamp:new Date(proof.paidAtMs).toISOString()});
}});}
