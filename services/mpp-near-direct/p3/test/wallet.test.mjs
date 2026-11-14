import test from 'node:test';
import assert from 'node:assert/strict';
import bs58 from 'bs58';
import {fixture,now} from '../../test/support.mjs';
import {Wallet} from '../wallet.mjs';
import {publicKey,signatureBase64,OutLayer,WalletError} from '../outlayer.mjs';

class Store {
 rows=new Map();tails=new Map();
 async create(row){const old=this.rows.get(row.id);if(old){assert.equal(old.fingerprint,row.fingerprint);return structuredClone(old);}this.rows.set(row.id,structuredClone(row));return row;}
 async get(id){return structuredClone(this.rows.get(id));}
 async lock(id,fn){const prior=this.tails.get(id)??Promise.resolve();let done;this.tails.set(id,new Promise(r=>done=r));await prior;
  const get=()=>this.get(id),save=async row=>this.rows.set(id,structuredClone(row));
  try{return await fn({get,save,begin:async authorize=>{const row=await get();assert.equal(row.state,'prepared');await authorize(row.frozen,{});const next={...row,state:'sending',attempts:1};await save(next);return next;}});}finally{done();}}
}
function setup(){
 const f=fixture(),store=new Store();f.tx.transaction_outcome.outcome.tokens_burnt='100';f.tx.receipts_outcome[0].outcome.tokens_burnt='200';
 const binding={agentId:'agent-1',walletId:'11111111-1111-4111-8111-111111111111',payer:f.request.payer,refundTo:f.request.payer,
  version:f.request.bindingVersion,network:'testnet',merchant:f.request.recipient,signingRecipient:f.challenge.realm,credentialRef:'agent-1',publicKey:f.key.publicKey,policy:{controller:'owner.testnet',version:1,encryptedHash:'hash'}};
 let sends=0,polls=0,signs=0,clock=now+100,lost=false,signDown=false,wrongNonce=false,status='success',policy=true,auth=true;
 const result=()=>({request_id:'22222222-2222-4222-8222-222222222222',status,tx_hash:f.txHash});
 const api={async transfer(){sends++;assert.equal((await store.get('near-pay-v1-'+f.request.orderRef)).state,'sending');if(lost)throw new WalletError('wallet_transport_unknown');return result();},
 async status(){polls++;return {type:'transfer',...result()};},async sign(b,p){signs++;if(signDown)throw new WalletError('wallet_frozen',{definiteRefusal:true});return {account_id:b.payer,public_key:b.publicKey,
  nonce:wrongNonce?Buffer.alloc(32,9).toString('base64'):p.nonce,signature:'ed25519:'+bs58.encode(Buffer.from(f.key.sign(p),'base64'))};}};
 const wallet=new Wallet({store,api,rpc:f.rpc,policy:async()=>{if(!policy)throw new Error('wallet_policy_changed_or_frozen');},authorize:async()=>{if(!auth)throw new Error('run_authorization_required');},now:()=>clock});
 return {...f,wallet,store,api,binding,prepare:()=>wallet.prepare({challenge:f.challenge,binding,gasReserveYocto:'400',gasFloorYocto:'100',nanoUsdPerNear:'2000000000',taskId:'task',userId:'user'}),
  counts:()=>({sends,polls,signs}),set(v){if('lost'in v)lost=v.lost;if('signDown'in v)signDown=v.signDown;if('wrongNonce'in v)wrongNonce=v.wrongNonce;if('clock'in v)clock=v.clock;if('status'in v)status=v.status;if('policy'in v)policy=v.policy;if('auth'in v)auth=v.auth;}};
}
test('ordinary transfer: agent principal, gas and exact original NEP413',async()=>{const f=setup(),op=await f.prepare(),p=await f.wallet.recover(op.id);assert.equal(p.state,'final');assert.equal(p.proof.gasPayer,f.request.payer);assert.equal(p.feeProof.gasActualYocto,'300');assert.equal(p.credential.payload.signature,f.credential.payload.signature);await f.wallet.recover(op.id);assert.equal(f.counts().sends,1);});
test('lost native ACK is never automatically reposted, including after restart',async()=>{const f=setup(),op=await f.prepare();f.set({lost:true});await f.wallet.recover(op.id);const r=await f.wallet.recover(op.id);assert.equal(r.state,'review');assert.equal(r.lastError,'original_ack_missing_no_automatic_resend');assert.equal(f.counts().sends,1);assert.equal((await f.wallet.cancel(op.id)).knownUnsent,false);});
test('parallel recovery issues a single original transfer',async()=>{const f=setup(),op=await f.prepare();const values=await Promise.all(Array.from({length:8},()=>f.wallet.recover(op.id)));assert(values.every(x=>x.state==='final'));assert.equal(f.counts().sends,1);});
test('payment final, signature unavailable: preserve proof and recover without another payment',async()=>{const f=setup(),op=await f.prepare();f.set({signDown:true});let p=await f.wallet.recover(op.id);assert.equal(p.state,'paid');assert.equal(p.feeProof.gasActualYocto,'300');f.set({signDown:false,clock:f.request.expiresAtMs+100});p=await f.wallet.recover(op.id);assert.equal(p.state,'final');assert.equal(f.counts().sends,1);});
test('API success cannot overcome missing receipt evidence',async()=>{const f=setup(),op=await f.prepare();f.tx.receipts_outcome=[];const p=await f.wallet.recover(op.id);assert.equal(p.proof,null);assert.equal(p.feeProof,null);assert.notEqual(p.state,'final');});
test('chain failure records gas but does not assert zero principal',async()=>{const f=setup(),op=await f.prepare();f.tx.status={Failure:{ActionError:{index:0}}};f.tx.receipts_outcome[0].outcome.status=f.tx.status;const p=await f.wallet.recover(op.id);assert.equal(p.feeProof.gasActualYocto,'300');assert.equal(p.proof,null);assert.equal(f.counts().signs,0);assert.equal((await f.wallet.cancel(op.id)).knownUnsent,false);});
test('gas overrun is recorded without clamping',async()=>{const f=setup(),op=await f.prepare();f.tx.receipts_outcome[0].outcome.tokens_burnt='500';const p=await f.wallet.recover(op.id);assert.equal(p.feeProof.gasActualYocto,'600');assert.equal(p.gasOverrun,true);});
test('explicit refusal on first POST closes known-unsent operation',async()=>{const f=setup(),op=await f.prepare();f.api.transfer=async()=>{throw new WalletError('policy_denied',{status:403,definiteRefusal:true});};const p=await f.wallet.recover(op.id);assert.equal(p.state,'cancelled');assert.equal((await f.wallet.cancel(op.id)).knownUnsent,true);});
test('policy freeze before dispatch makes no transfer and remains cancellable',async()=>{const f=setup(),op=await f.prepare();f.set({policy:false});const p=await f.wallet.recover(op.id);assert.equal(p.state,'prepared');assert.equal(f.counts().sends,0);assert.equal((await f.wallet.cancel(op.id)).knownUnsent,true);});
test('revoked task authorization never dispatches',async()=>{const f=setup(),op=await f.prepare();f.set({auth:false});const p=await f.wallet.recover(op.id);assert.equal(p.state,'prepared');assert.equal(f.counts().sends,0);});
test('expired order never starts a fresh payment',async()=>{const f=setup(),op=await f.prepare();f.set({clock:f.request.expiresAtMs+1});await f.wallet.recover(op.id);assert.equal(f.counts().sends,0);});
test('NEP413 wrong nonce cannot make a credential after money moved',async()=>{const f=setup(),op=await f.prepare();f.set({wrongNonce:true});const p=await f.wallet.recover(op.id);assert.equal(p.state,'paid');assert.equal(p.credential,null);assert.equal(p.lastError,'wallet_signature_binding_mismatch');});
test('needs_review stops further polling, signing and sending',async()=>{const f=setup(),op=await f.prepare();f.set({status:'needs_review'});const p=await f.wallet.recover(op.id);assert.equal(p.state,'review');await f.wallet.recover(op.id);assert.deepEqual(f.counts(),{sends:1,polls:0,signs:0});});
test('hex and base58 key encodings name identical bytes',()=>{const f=setup(),key=publicKey(f.key.publicKey);assert.equal(publicKey('ed25519:'+key.hex).base58,f.key.publicKey);assert.equal(signatureBase64('ed25519:'+bs58.encode(Buffer.from(f.credential.payload.signature,'base64'))),f.credential.payload.signature);});
test('production adapter refuses arbitrary outbound origins and network confusion',()=>{assert.throws(()=>new OutLayer({network:'mainnet',origin:'https://evil.example'}),/untrusted_outlayer_origin/);assert.throws(()=>new OutLayer({network:'testnet',origin:'https://api.outlayer.ai'}),/untrusted_outlayer_origin/);});
