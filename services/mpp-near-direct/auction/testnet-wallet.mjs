import {KeyPairSigner,createTransaction,actions,baseDecode,baseEncode,SignedTransaction} from 'near-api-js';
import {Credential} from 'mppx';
import {hash,requireThat as check,validateRequest,signedPayload,uint,METHOD} from '../contract.mjs';
import {nep413Digest} from '../near.mjs';

// Wallet financial operations only. This journal contains signed transactions,
// never fx sessions, conversation, tools or a task workspace.
export class TestnetWallet {
 constructor({store,provider,keyFor,policy,reviewedPolicyHash,allowBroadcast=false,fault=()=>{}}){
  check(policy.network==='testnet'&&hash(policy)===reviewedPolicyHash,'reviewed_testnet_wallet_policy_required');
  check(Array.isArray(policy.accounts)&&policy.accounts.length>0&&Array.isArray(policy.recipients),'invalid_wallet_policy');
  for(const a of policy.accounts){check(typeof a.payer==='string'&&typeof a.publicKey==='string','invalid_payer_policy');uint(a.maximumExposureYocto);}
  this.owner=hash(policy);Object.assign(this,{store,provider,keyFor,policy,allowBroadcast,fault});
  const old=store.get('testnet-wallet-policy','singleton','');
  check(!old||hash(old)===this.owner,'wallet_policy_changed');
  if(!old)store.put('testnet-wallet-policy','singleton','',policy);
 }
 async chain(){const state=await this.provider.status();check(state.chain_id==='testnet','testnet_chain_required');}
 async preparePayment(operation){
  const {challenge,gasCapYocto}=operation.binding,r=validateRequest(challenge.request);
  check(challenge.method===METHOD&&challenge.intent==='charge'&&challenge.realm===this.policy.realm&&r.signingRecipient===this.policy.realm&&r.network==='testnet'&&operation.id==='pay-'+r.orderRef,'payment_operation_binding_mismatch');
  check(this.policy.recipients.includes(r.recipient),'unapproved_merchant');
  const binding={kind:'payment',operationId:operation.id,challenge,gasCapYocto};
  return this.prepare({operationId:operation.id,payer:r.payer,recipient:r.recipient,amount:r.amount,gasCapYocto,binding});
 }
 async prepareRefund(operation){
  const r=operation.binding;check(r.network==='testnet'&&r.operationId===operation.id&&r.amount,'refund_operation_binding_mismatch');
  check(this.policy.recipients.includes(r.recipient),'unapproved_refund_recipient');
  const paid=this.original('pay-'+r.orderId);
  check(paid&&paid.binding.challenge.request.payer===r.recipient&&paid.recipient===r.sender&&BigInt(r.amount)<=BigInt(paid.amount),'refund_original_payment_required');
  return this.prepare({operationId:operation.id,payer:r.sender,recipient:r.recipient,amount:r.amount,gasCapYocto:this.policy.refundGasReserveYocto,
   binding:{kind:'refund',...r}});
 }
 async prepare(input){
  const {operationId,payer,recipient,amount,gasCapYocto,binding}=input;
  check(this.policy.recipients.includes(recipient),'unapproved_recipient');
  const fingerprint=hash(input),existing=this.store.get('testnet-wallet-operation',operationId,this.owner);
  if(existing){check(existing.fingerprint===fingerprint,'wallet_original_operation_conflict');return this.signOriginal(existing);}
  if(binding.kind==='payment')check(Date.now()<binding.challenge.request.expiresAtMs,'new_payment_window_closed');
  const account=this.policy.accounts.find(a=>a.payer===payer);check(account,'unapproved_payer');
  check(uint(amount)>0n&&uint(gasCapYocto)>0n,'invalid_native_exposure');
  await this.chain();
  const access=await this.provider.viewAccessKey({accountId:payer,publicKey:account.publicKey,finalityQuery:{finality:'final'}});
  check(access.permission==='FullAccess','full_access_key_required');
  check(typeof access.nonce!=='number'||Number.isSafeInteger(access.nonce),'unsafe_nonce');
  const record=this.store.transaction(()=>{
   const old=this.store.get('testnet-wallet-operation',operationId,this.owner);if(old){check(old.fingerprint===fingerprint,'wallet_original_operation_conflict');return old;}
   const operations=this.store.list('testnet-wallet-operation',this.owner).filter(o=>o.payer===payer);
   check(operations.length<account.maxOperations,'wallet_operation_limit');
   const held=this.store.list('testnet-wallet-operation',this.owner).filter(o=>o.payer===payer).reduce((n,o)=>n+uint(o.amount)+uint(o.gasCapYocto),0n);
   check(held+uint(amount)+uint(gasCapYocto)<=uint(account.maximumExposureYocto),'wallet_aggregate_exposure_exhausted');
   const nonceKey=hash([payer,account.publicKey]),previous=this.store.get('testnet-wallet-nonce',nonceKey,this.owner);
   const next=(previous&&BigInt(previous.nonce)>BigInt(access.nonce)?BigInt(previous.nonce):BigInt(access.nonce))+1n;
   const row={...input,fingerprint,publicKey:account.publicKey,nonce:String(next),blockHash:access.block_hash,state:'prepared'};
   this.store.put('testnet-wallet-nonce',nonceKey,this.owner,{nonce:String(next)});
   this.store.put('testnet-wallet-operation',operationId,this.owner,row);return row;
  });
  await this.fault('after_prepare');return this.signOriginal(record);
 }
 async signOriginal(record){
  if(record.signedBytes)return record;
  const key=await this.keyFor(record.payer);check(key.getPublicKey().toString()===record.publicKey,'wallet_key_binding_mismatch');
  const transaction=createTransaction(record.payer,key.getPublicKey(),record.recipient,BigInt(record.nonce),[actions.transfer(uint(record.amount))],baseDecode(record.blockHash));
  const signed=await new KeyPairSigner(key).signTransaction(transaction),txHash=baseEncode(signed.txHash);
  const bytes=Buffer.from(signed.signedTransaction.encode()).toString('base64');
  let credential;
  if(record.binding.kind==='payment'){
   const challenge=record.binding.challenge;
   const signature=Buffer.from(key.sign(nep413Digest(signedPayload(challenge,txHash))).signature).toString('base64');
   credential=Credential.serialize({challenge,payload:{txHash,publicKey:record.publicKey,signature}});
  }
  const final=this.store.transaction(()=>{
   const old=this.store.get('testnet-wallet-operation',record.operationId,this.owner);
   check(old?.fingerprint===record.fingerprint,'wallet_original_operation_conflict');
   if(old.signedBytes){check(old.signedBytes===bytes,'wallet_original_signed_bytes_conflict');return old;}
   const value={...record,txHash,signedBytes:bytes,...(credential?{credential}:{}),state:'signed'};
   this.store.put('testnet-wallet-operation',record.operationId,this.owner,value);return value;
  });
  await this.fault('after_sign');return final;
 }
 async broadcastOriginal(operationId){
  check(this.allowBroadcast,'testnet_broadcast_not_authorized');
  let original=this.store.get('testnet-wallet-operation',operationId,this.owner);check(original,'original_wallet_operation_missing');
  original=await this.signOriginal(original);
  if(original.state==='signed'&&original.binding.kind==='payment')check(Date.now()<original.binding.challenge.request.expiresAtMs,'new_payment_window_closed');
  await this.chain();
  const signed=SignedTransaction.decode(Buffer.from(original.signedBytes,'base64'));
  check(signed.transaction.signerId===original.payer&&signed.transaction.receiverId===original.recipient&&signed.transaction.publicKey.toString()===original.publicKey
   &&signed.transaction.nonce===BigInt(original.nonce)&&signed.transaction.actions.length===1&&signed.transaction.actions[0].transfer?.deposit===BigInt(original.amount),'original_transaction_binding_mismatch');
  check(baseEncode(new Uint8Array(await crypto.subtle.digest('SHA-256',signed.transaction.encode())))===original.txHash,'original_transaction_hash_mismatch');
  // Re-broadcasting these same bytes retains the original nonce/hash. An expired
  // block hash or unknown result never authorizes signing a replacement.
  try{
   const result=await this.provider.sendTransactionUntil(signed,'FINAL');
   this.store.put('testnet-wallet-operation',operationId,this.owner,{...original,state:'broadcast_returned',result});
   return {...original,result};
  }catch(e){this.store.put('testnet-wallet-operation',operationId,this.owner,{...original,state:'unknown'});throw e;}
 }
 original(operationId){return this.store.get('testnet-wallet-operation',operationId,this.owner);}
}
