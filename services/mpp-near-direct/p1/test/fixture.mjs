// Controlled NEAR chain/wallet. Never imported by serving code. All keys and
// receipts are local test fixtures; PostgreSQL provides restartable identities.
import http from 'node:http';
import { createPrivateKey, createPublicKey, createHash, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import bs58 from 'bs58';
import { Credential } from 'mppx';
import { canonical, challengeIdentity, hash } from '../../contract.mjs';
import { sponsoredRequest, sponsoredPayload, delegateDigest } from '../sponsored.mjs';
import { nep413Digest } from '../../near.mjs';

const config=JSON.parse(readFileSync(process.argv[2],'utf8'));
const pool=new pg.Pool({connectionString:config.databaseUrl});
pool.on('error',()=>{ /* Controlled PG outage: reconnect to the original journal. */ });
await pool.query(`CREATE TABLE IF NOT EXISTS p1_fixture_chain(key text PRIMARY KEY,kind text NOT NULL,input jsonb NOT NULL,tx_hash text UNIQUE NOT NULL,tx jsonb NOT NULL,blocks jsonb NOT NULL,credential text,original_send jsonb);
 CREATE TABLE IF NOT EXISTS p1_fixture_settings(key text PRIMARY KEY,value jsonb NOT NULL);
 CREATE TABLE IF NOT EXISTS p1_fixture_cancelled(key text PRIMARY KEY)`);
const b58=s=>bs58.encode(createHash('sha256').update(s).digest());
function key(seed){const privateKey=createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),Buffer.alloc(32,seed)]),format:'der',type:'pkcs8'});
 return {privateKey,publicKey:'ed25519:'+bs58.encode(createPublicKey(privateKey).export({format:'der',type:'spki'}).subarray(-32))};}
const keys={'agent.testnet':key(1),'merchant.testnet':key(2),'other.testnet':key(3),'sponsor.testnet':key(4)};
const setting=async(k,fallback)=>(await pool.query('SELECT value FROM p1_fixture_settings WHERE key=$1',[k])).rows[0]?.value??fallback;
async function accountBalance(account,db=pool,includePending=false){
 const read=async(k,fallback)=>(await db.query('SELECT value FROM p1_fixture_settings WHERE key=$1',[k])).rows[0]?.value??fallback;
 let balance=BigInt(await read(account==='agent.testnet'?'nativeBalance':'projectNativeBalance','100000000000000000000000000'));
 for(const {tx} of (await db.query('SELECT tx FROM p1_fixture_chain')).rows){
  if(tx.final_execution_status!=='FINAL'&&!includePending)continue;
  const d=tx.transaction.actions[0].Delegate?.delegate_action;
  const amount=BigInt(d?d.actions[0].Transfer.deposit:tx.transaction.actions[0].Transfer.deposit);
  if(!tx.status.Failure||tx.final_execution_status!=='FINAL'){
   if((d?.sender_id??tx.transaction.signer_id)===account)balance-=amount;
   if(tx.final_execution_status==='FINAL'&&(d?.receiver_id??tx.transaction.receiver_id)===account)balance+=amount;
  }
  if(tx.transaction.signer_id===account)balance-=1000000000000000000n;
 }
 return balance;
}
async function send(kind,operation,input,payer,recipient,amount,challenge){
 const db=await pool.connect();
 try{
  await db.query('BEGIN');await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',[operation]);
  const old=(await db.query('SELECT * FROM p1_fixture_chain WHERE key=$1',[operation])).rows[0];
  if(old){if(canonical(old.input)!==canonical(input))throw new Error('fixture_operation_conflict');await db.query('COMMIT');return old;}
  if((await db.query('SELECT 1 FROM p1_fixture_cancelled WHERE key=$1',[operation])).rowCount)throw new Error('original_operation_cancelled');
  if(kind==='payment'){
   const who=(await db.query('SELECT user_id FROM mpp_direct_orders WHERE id=$1',[challenge.request.orderRef])).rows[0];
   if(!who)throw new Error('new_operation_not_authorized');
   await db.query('SELECT pg_advisory_xact_lock(public.balance_cache_advisory_key($1))',[who.user_id]);
   const o=(await db.query('SELECT o.*,t.active AS task_active,t.revision AS live_revision,a.active AS agent_active,a.binding_version AS live_binding FROM mpp_direct_orders o JOIN mpp_direct_tasks t ON t.id=o.task_id JOIN mpp_direct_agents a ON a.user_id=o.user_id WHERE o.id=$1 FOR SHARE OF o,t,a',[challenge.request.orderRef])).rows[0];
   const s=(await db.query('SELECT * FROM mpp_direct_sponsor_operations WHERE id=$1 FOR UPDATE',[challenge.request.sponsorOperation])).rows[0];
   if(!o||challengeIdentity(o.challenge)!==challengeIdentity(challenge)||!o.task_active||!o.agent_active||o.live_revision!==o.task_revision||o.binding_version!==o.live_binding
    ||Date.now()>=challenge.request.expiresAtMs||s?.state!=='authorized')throw new Error('new_operation_not_authorized');
  }else{
   const approved=(await db.query('SELECT * FROM mpp_direct_refunds WHERE id=$1 FOR SHARE',[input.operationId])).rows[0];
   if(!approved||approved.plan_hash!==hash(input)||canonical(approved.plan)!==canonical(input))throw new Error('merchant_prepared_plan_required');
  }
  if(!(await db.query('SELECT active FROM mpp_direct_project_budget WHERE id=1 FOR UPDATE')).rows[0]?.active)throw new Error('project_sponsor_paused');
  const storage=BigInt(await setting('storageUsage',0))*10000000000000000000n;
  const actual=kind==='payment'?String(BigInt(amount)+BigInt(await setting('injectedAmountDelta','0'))):amount;
  if(BigInt(actual)<0n||BigInt(actual)>=(1n<<128n))throw new Error('fixture_amount_out_of_range');
  if(await accountBalance(payer,db,true)-storage<BigInt(actual)+(kind==='refund'?1000000000000000000n:0n))throw new Error('sender_native_balance_insufficient');
  if(kind==='payment'&&await accountBalance('sponsor.testnet',db,true)-storage<1000000000000000000n)throw new Error('project_gas_unfunded');
  if(kind==='refund'&&(await setting('blockedRefundOrders',[])).includes(input.orderRef))throw new Error('controlled_refund_sender_unavailable');
  const at=Date.now(),txHash=b58(operation),receiptId=b58(operation+'receipt'),rootBlock=b58(operation+'root'),paidBlock=b58(operation+'paid');
  const tx={final_execution_status:await setting(kind+'Finality','FINAL'),status:{SuccessValue:''},
   transaction:{hash:txHash,signer_id:payer,receiver_id:recipient,public_key:keys[payer].publicKey,nonce:1,actions:[{Transfer:{deposit:amount}}]},
   transaction_outcome:{id:txHash,block_hash:rootBlock,outcome:{executor_id:payer,receipt_ids:[receiptId],status:{SuccessReceiptId:receiptId},tokens_burnt:'1000000000000000000'}},
   receipts_outcome:[{id:receiptId,block_hash:paidBlock,outcome:{executor_id:recipient,receipt_ids:[],status:{SuccessValue:''},tokens_burnt:'0'}}]};
  if(kind==='payment'){
   const delegateId=b58(operation+'delegate');
   const nonce=Number((await db.query("SELECT count(*)+1 AS n FROM p1_fixture_chain WHERE kind='payment'")).rows[0].n);
   const d={sender_id:payer,receiver_id:recipient,actions:[{Transfer:{deposit:actual}}],nonce,max_block_height:1000,public_key:keys[payer].publicKey};
   tx.transaction.signer_id='sponsor.testnet';tx.transaction.public_key=keys['sponsor.testnet'].publicKey;tx.transaction.receiver_id=payer;
   tx.transaction.actions=[{Delegate:{delegate_action:d,signature:'ed25519:'+bs58.encode(sign(null,delegateDigest(d),keys[payer].privateKey))}}];
   tx.transaction_outcome.outcome={executor_id:'sponsor.testnet',receipt_ids:[delegateId],status:{SuccessReceiptId:delegateId},tokens_burnt:'1000000000000000000'};
   tx.receipts_outcome.unshift({id:delegateId,block_hash:rootBlock,outcome:{executor_id:payer,receipt_ids:[receiptId],status:{SuccessReceiptId:receiptId},tokens_burnt:'0'}});
   if(await setting('failPayment',false)){tx.status={Failure:{ActionError:'controlled merchant failure'}};tx.receipts_outcome.at(-1).outcome.status=tx.status;}
  }
  const blocks={[rootBlock]:String(BigInt(at)*1000000n),[paidBlock]:String(BigInt(at+1)*1000000n)};
  const credential=challenge?Credential.serialize({challenge,payload:{txHash,publicKey:keys[payer].publicKey,
   signature:sign(null,nep413Digest(sponsoredPayload(challenge,txHash)),keys[payer].privateKey).toString('base64')}}):null;
  const original=kind==='refund'?{operationId:input.operationId,idempotencyKey:input.idempotencyKey,planHash:hash(input),txHash,publicKey:keys[payer].publicKey}:null;
  await db.query('INSERT INTO p1_fixture_chain VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[operation,kind,input,txHash,tx,blocks,credential,original]);
  if(kind==='payment')await db.query("UPDATE mpp_direct_sponsor_operations SET state='unknown' WHERE id=$1 AND state='authorized'",[challenge.request.sponsorOperation]);
  await db.query('COMMIT');return {tx_hash:txHash,credential,original_send:original};
 }catch(e){await db.query('ROLLBACK').catch(()=>{});throw e;}finally{db.release();}
}
const server=http.createServer(async(req,res)=>{
 const reply=(status,value)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));};
 try{
  let raw='';for await(const b of req)raw+=b;const body=raw?JSON.parse(raw):{};
  if(req.url==='/rpc'){
   const p=body.params;let result;
   if(body.method==='status')result={chain_id:await setting('network','testnet')};
   else if(body.method==='tx'){
    const row=(await pool.query('SELECT tx FROM p1_fixture_chain WHERE tx_hash=$1',[p.tx_hash])).rows[0];
    if(!row)return reply(200,{jsonrpc:'2.0',id:body.id,error:{code:-32000,message:'unknown transaction'}});result=row.tx;
   }else if(body.method==='block'){
    const rows=(await pool.query('SELECT blocks FROM p1_fixture_chain')).rows;const ns=rows.map(r=>r.blocks[p.block_id]).find(Boolean);
    if(!ns)throw new Error('unknown block');result={header:{hash:p.block_id,height:100,timestamp_nanosec:ns}};
   }else if(body.method==='query'&&p.request_type==='view_access_key'){
    if(keys[p.account_id]?.publicKey!==p.public_key)throw new Error('wrong key');
    const row=(await pool.query('SELECT tx FROM p1_fixture_chain WHERE blocks ? $1',[p.block_id])).rows[0];
    if(!row)throw new Error('unknown access-key block');
    const d=row.tx.transaction.actions[0].Delegate?.delegate_action;
    result={permission:'FullAccess',nonce:d?.sender_id===p.account_id?d.nonce:row.tx.transaction.nonce};
   }else if(body.method==='query'&&p.request_type==='view_account'){
    const balance=await accountBalance(p.account_id);
    result={amount:String(balance),locked:'0',storage_usage:await setting('storageUsage',0),block_hash:b58('account-final'),block_height:100};
   }else throw new Error('unsupported fixture RPC');
   return reply(200,{jsonrpc:'2.0',id:body.id,result});
  }
  const provided=req.headers['x-fixture-key'],buyer=provided===config.buyerWalletKey,merchant=provided===config.walletFixtureKey,control=provided===config.faultControlKey;
  if(req.url==='/wallet/pay'&&buyer){
   const c=body.challenge,r=sponsoredRequest(c.request);
   if(r.payer!=='agent.testnet'||r.gasSponsor!=='sponsor.testnet'||r.recipient!=='merchant.testnet'||c.realm!=='payments.example.com')throw new Error('fixture_principal_scope');
   const row=await send('payment','near-pay-v2-'+r.orderRef,c,r.payer,r.recipient,r.amount,c);
   if(await setting('dropPaymentAck',false)){await pool.query("DELETE FROM p1_fixture_settings WHERE key='dropPaymentAck'");req.socket.destroy();return;}
   return reply(200,{credential:row.credential,txHash:row.tx_hash});
  }
  if((req.url==='/wallet/status'||req.url==='/wallet/cancel')&&buyer){
   const operationKey='near-pay-v2-'+body.orderRef,db=await pool.connect();try{
    await db.query('BEGIN');await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',[operationKey]);
    const row=(await db.query('SELECT credential,tx_hash FROM p1_fixture_chain WHERE key=$1',[operationKey])).rows[0];
    if(!row&&req.url==='/wallet/cancel')await db.query('INSERT INTO p1_fixture_cancelled VALUES($1) ON CONFLICT DO NOTHING',[operationKey]);
    await db.query('COMMIT');return reply(200,{orderRef:body.orderRef,operationKey,knownUnsent:!row&&req.url==='/wallet/cancel',credential:row?.credential,txHash:row?.tx_hash});
   }finally{db.release();}
  }
  if(req.url==='/merchant/refund'&&merchant){
   const p=body.plan;
   if(p.sender!=='merchant.testnet'||p.recipient!=='agent.testnet')throw new Error('fixture_refund_destination');
   const row=await send('refund',p.idempotencyKey,p,p.sender,p.recipient,p.amount);
   if(await setting('dropRefundAck',false)){await pool.query("DELETE FROM p1_fixture_settings WHERE key='dropRefundAck'");req.socket.destroy();return;}
   return reply(200,row.original_send);
  }
  if(req.url==='/fixture/finalize'&&control){
   const row=(await pool.query('SELECT * FROM p1_fixture_chain WHERE tx_hash=$1',[body.txHash])).rows[0];
   row.tx.final_execution_status='FINAL';
   if(body.includedAtMs)row.blocks[row.tx.transaction_outcome.block_hash]=String(BigInt(body.includedAtMs)*1000000n);
   if(body.lateAtMs)row.blocks[row.tx.receipts_outcome.at(-1).block_hash]=String(BigInt(body.lateAtMs)*1000000n);
   await pool.query('UPDATE p1_fixture_chain SET tx=$2,blocks=$3 WHERE tx_hash=$1',[body.txHash,row.tx,row.blocks]);return reply(200,{finalized:true});
  }
  if(req.url==='/fixture/reassign'&&control){
   // Adversarial agent double-signing: deliberately does NOT rewrite the
   // wallet's immutable operation-to-transaction association.
   const c=body.challenge,txHash=body.txHash;
   const credential=Credential.serialize({challenge:c,payload:{txHash,publicKey:keys['agent.testnet'].publicKey,
    signature:sign(null,nep413Digest(sponsoredPayload(c,txHash)),keys['agent.testnet'].privateKey).toString('base64')}});
   return reply(200,{credential});
  }
  reply(403,{error:'fixture_role_denied'});
 }catch(e){reply(400,{error:e.message});}
});
await new Promise(r=>server.listen(config.port??0,'127.0.0.1',r));
console.log(JSON.stringify({url:'http://127.0.0.1:'+server.address().port}));
process.on('SIGINT',()=>server.close(()=>{void pool.end().then(()=>process.exit(0));}));
