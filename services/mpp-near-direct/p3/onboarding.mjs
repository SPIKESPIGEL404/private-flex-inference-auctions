import { hash, requireThat, uint } from '../contract.mjs';
import { NETWORKS, publicKey, uuid, paymentPolicy, contractView, verifyPolicy } from './outlayer.mjs';

// Setup deliberately precedes a frozen run plan. Only a fully verified policy
// binding is exported into a run. Registration ACK loss leaves an UNFUNDED
// candidate unknown; it never manufactures an existing-wallet recovery.
export class Onboarding {
 constructor({pool,api,rpc,merchant,realm,maximumYocto,credentials}) {Object.assign(this,{pool,api,rpc,merchant,realm,maximumYocto,credentials});}
 async row(owner,id,db=this.pool) {
  const r=(await db.query('SELECT * FROM mpp_direct_p3_wallets WHERE owner_id=$1 AND id=$2',[owner,id])).rows[0];
  requireThat(r,'unknown_wallet_setup');return r;
 }
 async create(owner,id) {
  requireThat(/^[a-zA-Z0-9_-]{1,96}$/.test(id),'invalid_wallet_setup_id');
  const request={owner,id,merchant:this.merchant,realm:this.realm,maximumYocto:this.maximumYocto,network:this.rpc.network};
  const db=await this.pool.connect();let inserted;
  try {
   await db.query('BEGIN');await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,42))",[owner]);
   const existing=(await db.query('SELECT 1 FROM mpp_direct_p3_wallets WHERE id=$1 AND owner_id=$2',[id,owner])).rowCount;
   requireThat(existing||Number((await db.query('SELECT count(*) FROM mpp_direct_p3_wallets WHERE owner_id=$1',[owner])).rows[0].count)<8,'owner_wallet_limit');
   inserted=await db.query("INSERT INTO mpp_direct_p3_wallets(id,owner_id,request_hash,state,created_ms) VALUES($1,$2,$3,'registering',$4) ON CONFLICT DO NOTHING",[id,owner,hash(request),Date.now()]);
   await db.query('COMMIT');
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
  if(!inserted.rowCount) {
   const old=await this.row(owner,id);requireThat(old.request_hash===hash(request),'wallet_setup_conflict');return this.view(old);
  }
  try {
   const registered=await this.api.register();
   requireThat(uuid(registered.wallet_id)&&/^[0-9a-f]{64}$/.test(registered.near_account_id),'invalid_registered_wallet');
   const credentialRef=hash(['outlayer-wallet',owner,id]);
   await this.credentials.put(credentialRef,{walletId:registered.wallet_id,apiKey:registered.api_key});
   const binding={agentId:id,walletId:registered.wallet_id,credentialRef,payer:registered.near_account_id,refundTo:registered.near_account_id,
    publicKey:publicKey('ed25519:'+registered.near_account_id).base58,network:this.rpc.network,version:hash(request),merchant:this.merchant,signingRecipient:this.realm};
   await this.api.identity(binding);
   await this.pool.query("UPDATE mpp_direct_p3_wallets SET binding=$2,state='policy_pending' WHERE id=$1 AND owner_id=$3",[id,binding,owner]);
   return this.view(await this.row(owner,id));
  }catch {
   await this.pool.query("UPDATE mpp_direct_p3_wallets SET state='register_unknown',last_error='registration_identity_unknown' WHERE id=$1 AND owner_id=$2",[id,owner]);
   throw new Error('registration_identity_unknown');
  }
 }
 view(row) {
  return {id:row.id,state:row.state,owner:row.owner_id,network:this.rpc.network,
   fundingAllowed:row.state==='ready',...(row.state==='ready'?{payer:row.binding.payer,binding:row.binding}:{})};
 }
 async preparePolicy(owner,id) {
  const row=await this.row(owner,id);requireThat(row.binding&&row.state!=='register_unknown','wallet_registration_unknown');
  if(row.policy_send){
   const current=await contractView(this.rpc,NETWORKS[this.rpc.network].contract,'get_wallet_policy',{wallet_pubkey:'ed25519:'+publicKey(row.binding.publicKey).hex});
   if(current!==null){await this.confirmPolicy(owner,id);return {alreadyInstalled:true,policy:row.policy};}
   requireThat(row.policy_send.actions[0].params.args.valid_until*1000>Date.now(),'policy_authorization_expired');
   return {transaction:row.policy_send,policy:row.policy};
  }
  const current=await contractView(this.rpc,NETWORKS[this.rpc.network].contract,'get_wallet_policy',{wallet_pubkey:'ed25519:'+publicKey(row.binding.publicKey).hex});
  requireThat(current===null,'unexpected_existing_wallet_controller');
  const policy=paymentPolicy({merchant:this.merchant,realm:this.realm,maximumYocto:this.maximumYocto});
  const encrypted=await this.api.encrypt(row.binding,policy),signed=await this.api.signPolicy(row.binding,encrypted.encrypted_base64,owner);
  requireThat(publicKey('ed25519:'+signed.public_key_hex).base58===row.binding.publicKey&&signed.version===1&&signed.locked===false
   &&Number.isSafeInteger(signed.valid_until)&&signed.valid_until*1000>Date.now()&&signed.policy_hash===encrypted.policy_hash,'policy_signature_binding_mismatch');
  // The wallet key signs a domain-separated hash over caller, ciphertext,
  // version, lock and expiry. The contract performs its own verification.
  const args={wallet_pubkey:'ed25519:'+signed.public_key_hex,encrypted_data:encrypted.encrypted_base64,
   wallet_signature:signed.signature_hex,version:signed.version,locked:signed.locked,valid_until:signed.valid_until,storage_refund_to:null};
  const deposit=await contractView(this.rpc,NETWORKS[this.rpc.network].contract,'estimate_wallet_policy_cost',
   {wallet_pubkey:args.wallet_pubkey,encrypted_data:args.encrypted_data,storage_refund_to:null});uint(deposit);
  const transaction={signerId:owner,receiverId:NETWORKS[this.rpc.network].contract,actions:[{type:'FunctionCall',params:{methodName:'store_wallet_policy',args,gas:'30000000000000',deposit}}]};
  const binding={...row.binding,policy:{controller:owner,version:1,encryptedHash:hash(args.encrypted_data),plainHash:hash(policy),providerPlainHash:signed.policy_hash}};
  const update=await this.pool.query("UPDATE mpp_direct_p3_wallets SET binding=$3,policy=$4,policy_send=$5,state='awaiting_policy' WHERE id=$1 AND owner_id=$2 AND policy_send IS NULL",[id,owner,binding,policy,transaction]);
  if(!update.rowCount) {const original=await this.row(owner,id);return {transaction:original.policy_send,policy:original.policy};}
  return {transaction,policy};
 }
 async confirmPolicy(owner,id) {
  const row=await this.row(owner,id);requireThat(row.policy_send&&row.binding,'policy_transaction_required');
  try {
  await verifyPolicy({binding:row.binding,rpc:this.rpc,api:this.api});
  const apiPolicy=await this.api.request(row.binding.credentialRef,'/wallet/v1/policy');
  // The hosted policy API's `controller` field was observed to contain the
  // wallet key, NOT its owner account; only the independent chain view above
  // establishes controller. Check displayed semantics separately.
  requireThat(hash(apiPolicy.rules)===hash(row.policy.rules)&&hash(apiPolicy.capabilities)===hash(row.policy.capabilities)
   &&apiPolicy.approval==null&&!apiPolicy.frozen,'policy_plaintext_readback_mismatch');
  }catch(error){await this.pool.query("UPDATE mpp_direct_p3_wallets SET state='policy_pending' WHERE id=$1 AND owner_id=$2",[id,owner]);throw error;}
  await this.pool.query("UPDATE mpp_direct_p3_wallets SET state='ready',last_error=NULL WHERE id=$1 AND owner_id=$2",[id,owner]);
  return this.view(await this.row(owner,id));
 }
 async freezeTransaction(owner,id,{unfreeze=false}={}) {
  const row=await this.row(owner,id);requireThat(row.binding?.policy?.controller===owner,'wallet_controller_required');
  // Stop local work before asking the owner to freeze on chain. Never expose a
  // delete-policy action as a way of revoking spending.
  const db=await this.pool.connect();try{await db.query('BEGIN');
   if(row.user_id){
    await db.query('SELECT pg_advisory_xact_lock(public.balance_cache_advisory_key($1))',[row.user_id]);
    await db.query('UPDATE mpp_direct_tasks SET paused=true,revision=revision+1 WHERE user_id=$1',[row.user_id]);
    await db.query("UPDATE mpp_direct_p2_sessions SET state=CASE WHEN state='complete' THEN state ELSE 'paused' END,generation=generation+1,writer_until_ms=0 WHERE user_id=$1",[row.user_id]);
   }
   await db.query("UPDATE mpp_direct_p3_wallets SET state='policy_pending' WHERE id=$1 AND owner_id=$2",[id,owner]);await db.query('COMMIT');
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
  return {signerId:owner,receiverId:NETWORKS[this.rpc.network].contract,actions:[{type:'FunctionCall',params:{
   methodName:unfreeze?'unfreeze_wallet':'freeze_wallet',args:{wallet_pubkey:'ed25519:'+publicKey(row.binding.publicKey).hex},gas:'30000000000000',deposit:'0'}}]};
 }
}
