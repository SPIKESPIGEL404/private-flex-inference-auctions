import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import bs58 from 'bs58';
import { Challenge } from 'mppx';
import { fixture } from '../../test/support.mjs';
import { hash } from '../../contract.mjs';
import { nep413Digest } from '../../near.mjs';
import { SPONSORED, delegateDigest, sponsoredPayload, verifySponsored } from '../sponsored.mjs';
const digest=b=>createHash('sha256').update(b).digest();
test('NEP-366 Borsh signed-action vector uses on-chain tag and Transfer discriminant',()=>{
 const raw='d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a';
 const d={sender_id:'a.near',receiver_id:'m.near',actions:[{Transfer:{deposit:'1'}}],nonce:2,max_block_height:99,public_key:'ed25519:'+bs58.encode(Buffer.from(raw,'hex'))};
 const wire=Buffer.from('6e010040'+'06000000612e6e656172'+'060000006d2e6e656172'+'01000000'+'03'+'01000000000000000000000000000000'+'0200000000000000'+'6300000000000000'+'00'+raw,'hex');
 assert.deepEqual(delegateDigest(d),digest(wire));
});
function scenario(){
 const f=fixture(),agent=generateKeyPairSync('ed25519'),sponsor=generateKeyPairSync('ed25519');
 const pub=p=>'ed25519:'+bs58.encode(p.publicKey.export({format:'der',type:'spki'}).subarray(-32));
 const request={...f.request,version:2,gasSponsor:'sponsor.testnet',sponsorOperation:hash('sponsor-op')};
 const challenge=Challenge.from({secretKey:'controlled-sponsored-test-secret-32-bytes',realm:f.challenge.realm,method:SPONSORED,intent:'charge',request,expires:f.challenge.expires});
 const d={sender_id:request.payer,receiver_id:request.recipient,actions:[{Transfer:{deposit:request.amount}}],nonce:1,max_block_height:200,public_key:pub(agent)};
 const signed={delegate_action:d,signature:'ed25519:'+bs58.encode(sign(null,delegateDigest(d),agent.privateKey))};
 const tx=f.tx;tx.transaction={...tx.transaction,signer_id:request.gasSponsor,receiver_id:request.payer,public_key:pub(sponsor),actions:[{Delegate:signed}]};
 f.rpc.transaction=async(h,p)=>{assert.equal(h,f.txHash);assert.equal(p,request.gasSponsor);return tx;};
 const id='delegate-receipt';tx.transaction_outcome.outcome={executor_id:request.gasSponsor,receipt_ids:[id],status:{SuccessReceiptId:id},tokens_burnt:'10'};
 tx.receipts_outcome[0].outcome.tokens_burnt='20';
 tx.receipts_outcome.unshift({id,block_hash:'inclusion',outcome:{executor_id:request.payer,receipt_ids:[f.receiptId],status:{SuccessReceiptId:f.receiptId},tokens_burnt:'30'}});
 const originalBlock=f.rpc.block;f.rpc.block=async id=>{const b=await originalBlock(id);b.header.height=100;return b;};
 f.rpc.keyAt=async()=>({permission:'FullAccess',nonce:1});
 const credential={challenge,payload:{txHash:f.txHash,publicKey:pub(agent),signature:sign(null,nep413Digest(sponsoredPayload(challenge,f.txHash)),agent.privateKey).toString('base64')}};
 const run=(extra={})=>verifySponsored({credential,expectedChallenge:challenge,rpc:f.rpc,...extra});
 return {...f,credential,challenge,d,signed,run,resign(){signed.signature='ed25519:'+bs58.encode(sign(null,delegateDigest(d),agent.privateKey));}};
}
test('v2 separates principal payer, sponsor, delegated signature and actual fee',async()=>{
 const f=scenario(),v=await f.run();assert.equal(v.payer,'agent.testnet');assert.equal(v.gasSponsor,'sponsor.testnet');assert.equal(v.gasActualYocto,'60');
 assert.equal(v.methodVersion,2);assert.equal(v.movementKey,`near:testnet:${f.txHash}:${f.receiptId}:0`);
});
for(const [name,change,error]of[
 ['agent-paid outer transaction',f=>{f.tx.transaction.signer_id='agent.testnet';},'sponsor_transaction_mismatch'],
 ['wrong inner principal',f=>{f.d.sender_id='other.testnet';f.resign();},'delegate_principal_mismatch'],
 ['NEP-413 cannot authorize a delegated transfer',f=>{f.signed.signature='ed25519:'+bs58.encode(Buffer.from(f.credential.payload.signature,'base64'));},'invalid_delegate_signature'],
 ['protocol block expiry',f=>{f.d.max_block_height=99;f.resign();},'delegate_protocol_expired'],
 ['unsafe nonce integer',f=>{f.d.nonce=Number.MAX_SAFE_INTEGER+1;},'unsafe_delegate_integer'],
 ['missing delegate receipt',f=>{f.tx.receipts_outcome.shift();},'sponsored_receipts_unknown'],
 ['intermediate final status',f=>{f.tx.status={SuccessReceiptId:f.receiptId};},'sponsored_chain_failed'],
 ['merchant receipt failed',f=>{f.tx.receipts_outcome.at(-1).outcome.status={Failure:{}};},'sponsored_receipt_failed'],
])test(`v2 rejects ${name}`,async()=>{const f=scenario();change(f);await assert.rejects(f.run(),new RegExp(error));});
test('order wall-clock expiry does not invalidate an otherwise valid original delegate',async()=>{
 const f=scenario();f.blocks.settlement=f.request.expiresAtMs+1;const v=await f.run();assert.equal(v.late,true);assert.equal(v.delegateMaxBlockHeight,'200');
});
test('under/overpayment may be verified only as an actual-amount liability',async()=>{
 const f=scenario();f.d.actions[0].Transfer.deposit='1';f.resign();await assert.rejects(f.run(),/not_exact_sponsored_principal/);
 const v=await f.run({allowMismatch:true});assert.equal(v.amount,'1');assert.notEqual(v.amount,v.expectedAmount);
});
test('final failed transfer records sponsor gas only when delegate nonce is consumed',async()=>{
 const f=scenario();f.tx.status={Failure:{ActionError:'controlled failure'}};f.tx.receipts_outcome.at(-1).outcome.status=f.tx.status;
 await assert.rejects(f.run(),/sponsored_chain_failed/);
 const v=await f.run({allowFailure:true});assert.equal(v.failed,true);assert.equal(v.amount,'0');assert.equal(v.gasActualYocto,'60');
 f.rpc.keyAt=async()=>({permission:'FullAccess',nonce:0});
 await assert.rejects(f.run({allowFailure:true}),/still_replayable_unknown/);
});
