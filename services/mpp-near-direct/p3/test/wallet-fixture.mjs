// Loopback-only acceptance double. NEVER use this process/key store for real funds.
import http from 'node:http';
import {generateKeyPairSync,createPrivateKey,sign,randomUUID,randomBytes} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import pg from 'pg';
import bs58 from 'bs58';
import {hash,signedPayload} from '../../contract.mjs';
import {nep413Digest} from '../../near.mjs';
import {paymentPolicy} from '../outlayer.mjs';
const path=process.argv[2],c=JSON.parse(readFileSync(path));
if(c.mode!=='controlled'||new URL(c.databaseUrl).hostname!=='127.0.0.1')throw Error('controlled_fixture_required');
const db=new pg.Pool({connectionString:c.databaseUrl});
await db.query(`CREATE TABLE IF NOT EXISTS p3_fixture_accounts(role text PRIMARY KEY,data jsonb NOT NULL,balance numeric(39,0) NOT NULL,frozen boolean NOT NULL DEFAULT false);
 CREATE TABLE IF NOT EXISTS p3_fixture_requests(id text PRIMARY KEY,key text UNIQUE NOT NULL,wallet_id text NOT NULL,body_hash text NOT NULL,tx jsonb NOT NULL);
 CREATE TABLE IF NOT EXISTS p3_fixture_faults(name text PRIMARY KEY,value boolean NOT NULL);`);
mkdirSync(c.credentialDirectory,{recursive:true,mode:0o700});
for(const role of ['owner','merchant','agent-1','agent-2']){
 if((await db.query('SELECT 1 FROM p3_fixture_accounts WHERE role=$1',[role])).rowCount)continue;
 const pair=generateKeyPairSync('ed25519'),raw=pair.publicKey.export({format:'der',type:'spki'}).subarray(-32),account={role,payer:raw.toString('hex'),publicKey:'ed25519:'+bs58.encode(raw),privateKey:pair.privateKey.export({format:'der',type:'pkcs8'}).toString('base64'),walletId:randomUUID(),apiKey:'wk_'+randomBytes(32).toString('hex')};
 writeFileSync(c.credentialDirectory+'/'+role+'.json',JSON.stringify({walletId:account.walletId,apiKey:account.apiKey}),{mode:0o600});
 await db.query('INSERT INTO p3_fixture_accounts VALUES($1,$2,$3,false)',[role,account,'1000000000000000000000000']);
}
const all=async()=>(await db.query('SELECT * FROM p3_fixture_accounts ORDER BY role')).rows;
const owner=(await all()).find(a=>a.role==='owner').data,merchant=(await all()).find(a=>a.role==='merchant').data;
for(const row of await all()){
 if(row.data.policy||!['owner','merchant','agent-1','agent-2'].includes(row.role))continue;
 const policy=paymentPolicy({merchant:merchant.payer,realm:c.realm,maximumYocto:'10000000000000000000000'});
 if(row.role==='merchant')policy.rules.addresses.list=(await all()).filter(a=>a.role.startsWith('agent-')).map(a=>a.data.payer);
 const data={...row.data,policy,encrypted:'fixture-encrypted-'+row.role,controller:owner.payer};
 await db.query('UPDATE p3_fixture_accounts SET data=$2 WHERE role=$1',[row.role,data]);
}
const blockHash=label=>bs58.encode(Buffer.from(hash(label),'hex'));
const reply=(res,status,body)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body));};
async function input(req){let text='';for await(const b of req){text+=b;if(text.length>128*1024)throw Error('body_limit');}return JSON.parse(text||'{}');}
function rpcResult(res,id,result){reply(res,200,{jsonrpc:'2.0',id,result});}
const server=http.createServer(async(req,res)=>{try{
 const body=await input(req);
 if(req.url==='/register'){
  const pair=generateKeyPairSync('ed25519'),raw=pair.publicKey.export({format:'der',type:'spki'}).subarray(-32);
  const a={role:'registered-'+randomUUID(),payer:raw.toString('hex'),publicKey:'ed25519:'+bs58.encode(raw),privateKey:pair.privateKey.export({format:'der',type:'pkcs8'}).toString('base64'),walletId:randomUUID(),apiKey:'wk_'+randomBytes(32).toString('hex')};
  await db.query('INSERT INTO p3_fixture_accounts VALUES($1,$2,0,false)',[a.role,a]);
  return reply(res,200,{wallet_id:a.walletId,near_account_id:a.payer,api_key:a.apiKey});
 }
 if(req.url==='/fixture/owner-transaction'){
  if(req.headers['x-fixture-key']!==c.controlKey)return reply(res,403,{});
  const tx=body.transaction;if(tx.signerId!==owner.payer||tx.actions.length!==1)throw Error('owner_fixture_identity');
  const action=tx.actions[0],key='owner-browser-'+randomUUID(),txHash=blockHash(key);
  if(action.type==='FunctionCall'){
   const f=action.params,r=(await all()).find(a=>'ed25519:'+a.data.payer===f.args.wallet_pubkey);if(!r)throw Error('unknown_policy_key');
   if(f.methodName==='store_wallet_policy'){
    if(r.data.encrypted||r.data.controller)throw Error('original_policy_already_installed');
    await db.query('UPDATE p3_fixture_accounts SET data=$2 WHERE role=$1',[r.role,{...r.data,encrypted:f.args.encrypted_data,policy:r.data.pendingPolicy,controller:owner.payer}]);
   }else if(['freeze_wallet','unfreeze_wallet'].includes(f.methodName))await db.query('UPDATE p3_fixture_accounts SET frozen=$2 WHERE role=$1',[r.role,f.methodName==='freeze_wallet']);
   else throw Error('unknown_owner_action');
  }else if(action.type==='Transfer'){
   const rid=blockHash(key+'receipt'),block=blockHash(key+'block'),amount=action.params.deposit,at=Date.now();
   const chain={atMs:at,final_execution_status:'FINAL',status:{SuccessValue:''},transaction:{hash:txHash,signer_id:owner.payer,public_key:owner.publicKey,receiver_id:tx.receiverId,nonce:at,actions:[{Transfer:{deposit:amount}}]},transaction_outcome:{id:txHash,block_hash:block,outcome:{executor_id:owner.payer,status:{SuccessReceiptId:rid},receipt_ids:[rid],tokens_burnt:'1000000000000000000'}},receipts_outcome:[{id:rid,block_hash:block,outcome:{executor_id:tx.receiverId,status:{SuccessValue:''},receipt_ids:[],tokens_burnt:'2000000000000000000'}}]};
   await db.query('UPDATE p3_fixture_accounts SET balance=balance+$2 WHERE data->>\'payer\'=$1',[tx.receiverId,amount]);
   await db.query('INSERT INTO p3_fixture_requests VALUES($1,$2,$3,$4,$5)',[randomUUID(),key,owner.walletId,hash(tx),chain]);
  }else throw Error('unsupported_owner_transaction');
  return reply(res,200,{transaction:{hash:txHash}});
 }
 if(req.url==='/fixture/accounts'){
  if(req.headers['x-fixture-key']!==c.controlKey)return reply(res,403,{});
  return reply(res,200,(await all()).map(({data:a,frozen})=>{const {privateKey,apiKey,...publicData}=a;return {...publicData,frozen};}));
 }
 if(req.url==='/fixture/sign'){
  if(req.headers['x-fixture-key']!==c.controlKey)return reply(res,403,{});
  const a=(await all()).find(a=>a.role===body.role)?.data;
  return reply(res,200,{accountId:a.payer,publicKey:a.publicKey,signature:sign(null,nep413Digest(body.payload),createPrivateKey({format:'der',type:'pkcs8',key:Buffer.from(a.privateKey,'base64')})).toString('base64')});
 }
 if(req.url==='/fixture/fault'){
  if(req.headers['x-fixture-key']!==c.controlKey)return reply(res,403,{});
  if(body.freeze)await db.query('UPDATE p3_fixture_accounts SET frozen=true WHERE role=$1',[body.freeze]);
  if(body.name)await db.query('INSERT INTO p3_fixture_faults VALUES($1,$2) ON CONFLICT(name) DO UPDATE SET value=excluded.value',[body.name,body.value]);
  return reply(res,200,{saved:true});
 }
 if(req.url==='/rpc'){
  const {method,params,id}=body;
  if(method==='status')return rpcResult(res,id,{chain_id:'testnet'});
  if(method==='query'){
   if(params.request_type==='call_function'){
    const args=JSON.parse(Buffer.from(params.args_base64,'base64')),r=(await all()).find(a=>'ed25519:'+a.data.payer===args.wallet_pubkey);
    const value=params.method_name==='get_wallet_policy'?(r?.data.encrypted?{owner:r.data.controller,version:1,locked:false,frozen:r.frozen,encrypted_data:r.data.encrypted}:null):'10000000000000000000000';
    return rpcResult(res,id,{result:[...Buffer.from(JSON.stringify(value))],block_hash:blockHash('final'),block_height:1});
   }
   if(params.request_type==='view_access_key')return rpcResult(res,id,{permission:'FullAccess',nonce:1,block_hash:blockHash('final')});
   const a=(await all()).find(a=>a.data.payer===params.account_id);if(!a)throw Error('unknown_mock_account');
   return rpcResult(res,id,{amount:a.balance,locked:'0',storage_usage:0,block_hash:blockHash('final')});
  }
  if(method==='tx'){
   const row=(await db.query("SELECT tx FROM p3_fixture_requests WHERE tx->'transaction'->>'hash'=$1",[params.tx_hash])).rows[0];if(!row)throw Error('unknown_mock_tx');return rpcResult(res,id,row.tx);
  }
  if(method==='block'){
   const row=(await db.query("SELECT tx FROM p3_fixture_requests WHERE tx->'transaction_outcome'->>'block_hash'=$1",[params.block_id])).rows[0];
   return rpcResult(res,id,{header:{hash:params.block_id,timestamp_nanosec:String(BigInt(row?.tx.atMs??Date.now())*1000000n)}});
  }
  throw Error('unsupported_fixture_rpc');
 }
 const row=(await all()).find(a=>'Bearer '+a.data.apiKey===req.headers.authorization);
 if(!row)return reply(res,401,{error:'invalid_api_key'});const a=row.data;
 if(req.url==='/wallet/v1/address?chain=near')return reply(res,200,{wallet_id:a.walletId,chain:'near',address:a.payer,public_key:'ed25519:'+a.payer,asset_account_id:null,executor_account_id:a.payer});
 if(req.url==='/wallet/v1/encrypt-policy'){
  const {wallet_id,...policy}=body;if(wallet_id!==a.walletId)throw Error('wallet_identity');
  await db.query('UPDATE p3_fixture_accounts SET data=$2 WHERE role=$1',[a.role,{...a,pendingPolicy:policy}]);
  return reply(res,200,{encrypted_base64:Buffer.from(JSON.stringify(policy)).toString('base64'),policy_hash:hash(policy)});
 }
 if(req.url==='/wallet/v1/sign-policy')return reply(res,200,{public_key_hex:a.payer,version:1,locked:false,valid_until:Math.floor(Date.now()/1000)+600,policy_hash:hash(a.pendingPolicy),signature_hex:'0'.repeat(128)});
 if(req.url==='/wallet/v1/policy')return reply(res,200,{rules:a.policy.rules,capabilities:a.policy.capabilities,approval:null,frozen:row.frozen,version:1});
 if(req.url.startsWith('/wallet/v1/requests/')){
  const r=(await db.query('SELECT * FROM p3_fixture_requests WHERE id=$1 AND wallet_id=$2',[req.url.split('/').at(-1),a.walletId])).rows[0];
  return r?reply(res,200,{request_id:r.id,type:'transfer',status:'success',result:{tx_hash:r.tx.transaction.hash,signer_id:a.payer}}):reply(res,404,{error:'not_found'});
 }
 if(row.frozen)return reply(res,403,{error:'wallet_frozen'});
 if(req.url==='/wallet/v1/sign-message'){
  const down=(await db.query("SELECT value FROM p3_fixture_faults WHERE name='sign_down'")).rows[0]?.value;
  if(down)return reply(res,503,{error:'signer_unavailable'});
  if(!a.policy.capabilities.sign_message.allowed_recipients.includes(body.recipient))return reply(res,403,{error:'policy_denied'});
  return reply(res,200,{account_id:a.payer,public_key:a.publicKey,nonce:body.nonce,signature:'ed25519:'+bs58.encode(sign(null,nep413Digest(body),createPrivateKey({format:'der',type:'pkcs8',key:Buffer.from(a.privateKey,'base64')})))});
 }
 if(req.url==='/wallet/v1/transfer'){
  if(!a.policy.rules.addresses.list.includes(body.to)||BigInt(body.amount)>BigInt(a.policy.rules.limits.per_transaction.native))return reply(res,403,{error:'policy_denied'});
  const client=await db.connect();let result;
  try{await client.query('BEGIN');await client.query("SELECT pg_advisory_xact_lock(hashtextextended('fixture-transfer:' || $1,0))",[a.payer]);
   const key=req.headers['x-idempotency-key'];if(!key)throw Error('idempotency_required');
   const previous=(await client.query('SELECT * FROM p3_fixture_requests WHERE key=$1',[key])).rows[0];
   if(previous){if(previous.body_hash!==hash(body))throw Error('body_conflict');result=previous;}
   else{
    const rid=randomUUID(),txHash=blockHash(key),receiptId=blockHash(key+'receipt'),block=blockHash(key+'block'),at=Date.now();
    const current=(await client.query('SELECT balance FROM p3_fixture_accounts WHERE role=$1 FOR UPDATE',[a.role])).rows[0];
    if(BigInt(current.balance)<BigInt(body.amount)+3000000000000000000n)throw Error('insufficient_mock_balance');
    const tx={atMs:at,final_execution_status:'FINAL',status:{SuccessValue:''},transaction:{hash:txHash,signer_id:a.payer,public_key:a.publicKey,receiver_id:body.to,nonce:at,actions:[{Transfer:{deposit:body.amount}}]},
     transaction_outcome:{id:txHash,block_hash:block,outcome:{executor_id:a.payer,status:{SuccessReceiptId:receiptId},receipt_ids:[receiptId],tokens_burnt:'1000000000000000000'}},
     receipts_outcome:[{id:receiptId,block_hash:block,outcome:{executor_id:body.to,status:{SuccessValue:''},receipt_ids:[],tokens_burnt:'2000000000000000000'}}]};
    await client.query('UPDATE p3_fixture_accounts SET balance=balance-$2 WHERE role=$1',[a.role,String(BigInt(body.amount)+3000000000000000000n)]);
    await client.query('UPDATE p3_fixture_accounts SET balance=balance+$2 WHERE data->>\'payer\'=$1',[body.to,body.amount]);
    await client.query('INSERT INTO p3_fixture_requests VALUES($1,$2,$3,$4,$5)',[rid,key,a.walletId,hash(body),tx]);result={id:rid,tx};
   }
   await client.query('COMMIT');
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
  const drop=await db.query("UPDATE p3_fixture_faults SET value=false WHERE name='drop_ack' AND value RETURNING name");if(drop.rowCount){res.destroy();return;}
  return reply(res,200,{request_id:result.id,status:'success',tx_hash:result.tx.transaction.hash});
 }
 return reply(res,404,{error:'not_found'});
}catch {if(req.url==='/rpc')reply(res,200,{jsonrpc:'2.0',id:'x',error:{code:-32000,message:'fixture_rpc_unknown'}});else reply(res,500,{error:'fixture_unknown'});}});
await new Promise(r=>server.listen(c.port,'127.0.0.1',r));console.log(JSON.stringify({url:'http://127.0.0.1:'+server.address().port,mode:'controlled'}));
process.on('SIGINT',()=>{server.close();void db.end().then(()=>process.exit(0));});
