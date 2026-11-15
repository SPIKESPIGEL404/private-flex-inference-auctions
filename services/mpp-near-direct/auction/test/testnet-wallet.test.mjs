import test from 'node:test';
import assert from 'node:assert/strict';
import {KeyPair,baseEncode,SignedTransaction} from 'near-api-js';
import {Challenge,Credential} from 'mppx';
import {Store} from '../../../../clients/buyer-gateway/src/store.mjs';
import {TestnetWallet} from '../testnet-wallet.mjs';
import {hash,METHOD} from '../../contract.mjs';
import {verifyBinding} from '../../near.mjs';
const key=KeyPair.fromRandom('ed25519');
function setup(){
 const policy={network:'testnet',realm:'auction.test',recipients:['merchant.testnet','agent.testnet'],refundGasReserveYocto:'1000000000000000000',
  accounts:[{payer:'agent.testnet',publicKey:key.getPublicKey().toString(),maximumExposureYocto:'1000000000000000000000',maxOperations:4}]};
 const store=new Store(':memory:',Buffer.alloc(32,7));let sends=0,loss=true;
 const provider={async status(){return {chain_id:'testnet'};},async viewAccessKey(){return {permission:'FullAccess',nonce:10,block_hash:baseEncode(Buffer.alloc(32,8))};},
  async sendTransactionUntil(tx){sends++;if(loss){loss=false;throw new TypeError('ACK lost');}return {hash:baseEncode(new Uint8Array(await crypto.subtle.digest('SHA-256',tx.transaction.encode())))};}};
 return {policy,store,provider,get sends(){return sends;},wallet:opts=>new TestnetWallet({store,provider,policy,keyFor:async()=>key,reviewedPolicyHash:hash(policy),...opts})};
}
function operation(order='order-1'){
 const now=Date.now(),orderRef=hash(order),request={version:1,network:'testnet',currency:'NEAR',decimals:24,amount:'100000000000000000000',recipient:'merchant.testnet',payer:'agent.testnet',refundTo:'agent.testnet',bindingVersion:'agent-binding-v1',orderRef,
  termsHash:hash('terms'),nativeRequestHash:hash('request'),nonce:Buffer.alloc(32,3).toString('base64'),issuedAtMs:now,expiresAtMs:now+60000,signingRecipient:'auction.test'};
 const challenge=Challenge.from({secretKey:'controlled-only-wallet-method-test',realm:'auction.test',method:METHOD,intent:'charge',request,expires:new Date(request.expiresAtMs).toISOString()});
 return {id:'pay-'+orderRef,binding:{challenge,gasCapYocto:'1000000000000000000'}};
}
test('testnet preflight signs genuine Transfer and NEP-413 credential without broadcasting',async()=>{
 const x=setup();try{const w=x.wallet(),op=operation(),r=await w.preparePayment(op);assert.equal(x.sends,0);
 const tx=SignedTransaction.decode(Buffer.from(r.signedBytes,'base64'));assert.equal(tx.transaction.actions[0].transfer.deposit.toString(),op.binding.challenge.request.amount);
 const credential=Credential.deserialize(r.credential);verifyBinding(credential.challenge,credential.payload);
 await assert.rejects(w.broadcastOriginal(op.id),/not_authorized/);
 }finally{x.store.close();}
});
test('crash between nonce reservation and signing reconstructs identical original operation',async()=>{
 const x=setup();try{const op=operation();let crash=true;
 await assert.rejects(x.wallet({fault:phase=>{if(crash&&phase==='after_prepare'){crash=false;throw Error('crash');}}}).preparePayment(op),/crash/);
 const r=await x.wallet().preparePayment(op);assert.equal(r.nonce,'11');assert.equal((await x.wallet().preparePayment(op)).txHash,r.txHash);assert.equal(x.sends,0);
 }finally{x.store.close();}
});
test('lost broadcast ACK and restart reuse exact signed bytes/hash, never a new nonce',async()=>{
 const x=setup();try{const op=operation(),w=x.wallet({allowBroadcast:true}),r=await w.preparePayment(op);
 await assert.rejects(w.broadcastOriginal(op.id),/ACK lost/);
 const restart=x.wallet({allowBroadcast:true});const same=await restart.preparePayment(op);assert.equal(same.txHash,r.txHash);assert.equal(same.signedBytes,r.signedBytes);
 const sent=await restart.broadcastOriginal(op.id);assert.equal(sent.result.hash,r.txHash);assert.equal(restart.original(op.id).nonce,'11');assert.equal(x.sends,2);
 }finally{x.store.close();}
});
test('concurrent original operations reserve distinct nonces; aggregate cap, policy and network are fenced',async()=>{
 const x=setup();try{const w=x.wallet(),[a,b]=await Promise.all([w.preparePayment(operation('one')),w.preparePayment(operation('two'))]);assert.notEqual(a.nonce,b.nonce);
 const changed={...x.policy,realm:'attacker.test'};assert.throws(()=>new TestnetWallet({store:x.store,provider:x.provider,keyFor:async()=>key,policy:changed,reviewedPolicyHash:hash(changed)}),/policy_changed/);
 x.provider.status=async()=>({chain_id:'mainnet'});await assert.rejects(w.preparePayment(operation('three')),/testnet_chain/);
 }finally{x.store.close();}
});
