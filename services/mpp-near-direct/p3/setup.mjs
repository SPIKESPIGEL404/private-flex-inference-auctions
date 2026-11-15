import http from 'node:http';
import {readFile,writeFile,mkdir,rename,stat} from 'node:fs/promises';
import {resolve,extname,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import pg from 'pg';
import {hash,requireThat} from '../contract.mjs';
import {verifyNativeTransfer,NearRpc} from '../near.mjs';
import {OutLayer,FileCredentials,verifyPolicy} from './outlayer.mjs';
import {Onboarding} from './onboarding.mjs';
import {Authorizations} from './auth.mjs';
import {validatePlan} from './plan.mjs';
import {Funding} from './funding.mjs';

const DIST=fileURLToPath(new URL('../../../clients/agent-playground/dist-p3/',import.meta.url));
const json=(res,status,value)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));};
async function read(req){let s='';for await(const b of req){s+=b;requireThat(Buffer.byteLength(s)<=128*1024,'body_too_large');}return JSON.parse(s||'{}');}
// No inference endpoint or agent transfer/signing relay is open during setup.
// Policy txs and source-funding txs must be signed by the connected owner.
export async function startSetup(config,{onActivate}={}) {
 requireThat(typeof onActivate==='function','activation_handler_required');
 const c=config.payments,p=c.plan;requireThat(config.setupOnly===true&&p.walletProvider==='outlayer','setup_mode_required');
 const origin=new URL(p.origin);requireThat(origin.origin===p.origin&&['https:','http:'].includes(origin.protocol)
  &&(origin.protocol==='https:'||origin.hostname==='127.0.0.1'),'invalid_setup_origin');
 requireThat(p.ownerAccount&&Array.isArray(p.agents)&&p.agents.length===2,'bounded_setup_owner_required');
 const database=new URL(c.databaseUrl);requireThat(['postgres:','postgresql:'].includes(database.protocol)&&database.hostname==='127.0.0.1'&&!database.hash&&!database.search,'isolated_p3_authority_required');
 requireThat(c.network===p.network&&['controlled','bounded'].includes(c.mode)&&(c.mode==='bounded'?c.realBroadcastEnabled===true:c.realBroadcastEnabled===false),'explicit_p3_broadcast_mode_required');
 requireThat(typeof config.activatedConfigPath==='string'&&config.activatedConfigPath.length>0,'activation_output_required');
 const pool=new pg.Pool({connectionString:c.databaseUrl}),credentials=new FileCredentials(c.credentialDirectory),rpc=new NearRpc({url:c.rpcUrl,network:c.network,controlled:c.mode==='controlled'});
 const api=new OutLayer({network:c.network,credentials,controlled:c.mode==='controlled',origin:c.mode==='controlled'?c.controlledWalletOrigin:undefined});
 const auth=new Authorizations({pool,rpc,plan:p});
 await pool.query('INSERT INTO mpp_direct_p3_runs VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[hash(p),p,Date.now()]);
 const onboarding=id=>{const a=p.agents.find(a=>a.agentId===id);requireThat(a,'unknown_agent_slot');return new Onboarding({pool,api,rpc,merchant:p.merchant,realm:p.realm,maximumYocto:a.principalCapYocto,credentials});};
 const rows=()=>pool.query('SELECT * FROM mpp_direct_p3_wallets WHERE owner_id=$1 ORDER BY id',[p.ownerAccount]);
 async function attach(id) {
  const row=await onboarding(id).row(p.ownerAccount,id),slot=p.agents.find(a=>a.agentId===id);
  requireThat(row.state==='ready','policy_not_ready');
  const token=config.agentCredentials.find(a=>a.userId===slot.userId)?.token;requireThat(token,'original_market_credential_required');
  const db=await pool.connect();try{await db.query('BEGIN');await db.query('SELECT pg_advisory_xact_lock(public.balance_cache_advisory_key($1))',[slot.userId]);
   await db.query(`INSERT INTO mpp_direct_agents(user_id,token_hash,agent_id,payer,binding_version,native_balance,owner_id)
    VALUES($1,$2,$3,$4,$5,'{}',$6) ON CONFLICT(user_id) DO NOTHING`,[slot.userId,hash(token),slot.agentId,row.binding.payer,row.binding.version,p.ownerAccount]);
   const old=(await db.query('SELECT * FROM mpp_direct_agents WHERE user_id=$1',[slot.userId])).rows[0];
   requireThat(old.payer===row.binding.payer&&old.owner_id===p.ownerAccount&&old.token_hash===hash(token),'existing_agent_binding_conflict');
   await db.query('UPDATE mpp_direct_p3_wallets SET user_id=$2 WHERE id=$1',[id,slot.userId]);await db.query('COMMIT');
  }catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
 }
 async function fundingService() {
  const list=(await rows()).rows;requireThat(p.agents.every(a=>list.some(r=>r.id===a.agentId&&r.state==='ready')),'all_policies_required');
  const plan={...p,agents:p.agents.map(a=>({...a,...list.find(r=>r.id===a.agentId).binding}))};
  await pool.query('INSERT INTO mpp_direct_p3_runs VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[hash(plan),plan,Date.now()]);
  return new Funding({pool,rpc,auth:{async requireGrant(owner){requireThat(owner===p.ownerAccount,'wrong_owner');}},plan});
 }
 let activating=false;
 const server=http.createServer(async(req,res)=>{try{
  res.setHeader('referrer-policy','no-referrer');res.setHeader('x-content-type-options','nosniff');
  if(req.method==='POST')requireThat(req.headers.origin===p.origin&&req.headers['content-type']?.split(';')[0]==='application/json','origin_denied');
  if(req.method==='GET'&&req.url==='/healthz')return json(res,200,{phase:'P3-setup',canPurchase:false,walletProvider:'outlayer'});
  if(req.method==='GET'&&req.url==='/buyer-api/config'){
   let authorized=false;try{const token=decodeURIComponent(String(req.headers.cookie??'').split(';').map(x=>x.trim()).find(x=>x.startsWith('p3_owner='))?.slice(9)??'');authorized=(await auth.session(token)).owner_id===p.ownerAccount;}catch{}
   return json(res,200,{phase:'setup',network:p.network,mode:c.mode,...(authorized?{plan:p}:{})});
  }
  if(req.method==='POST'&&req.url==='/buyer-api/auth/challenge')return json(res,200,await auth.challenge('login'));
  if(req.method==='POST'&&req.url==='/buyer-api/auth/verify') {
   const b=await read(req),result=await auth.verify(b.id,b.signed);requireThat(result.owner===p.ownerAccount,'wrong_owner');
   res.setHeader('set-cookie','p3_owner='+result.token+'; HttpOnly; SameSite=Strict; Path=/'+(p.origin.startsWith('https:')?'; Secure':''));return json(res,200,{owner:result.owner});
  }
  if(req.method==='GET'&&!req.url.startsWith('/buyer-api/')){
   const f=resolve(DIST,'.'+(req.url==='/'?'/p3.html':decodeURIComponent(req.url.split('?')[0])));requireThat(f.startsWith(resolve(DIST)+'/'),'not_found');
   const content=await readFile(f);res.writeHead(200,{'content-type':{'.html':'text/html','.js':'text/javascript','.css':'text/css','.wasm':'application/wasm'}[extname(f)]??'application/octet-stream'});res.end(content);return;
  }
  const token=decodeURIComponent(String(req.headers.cookie??'').split(';').map(x=>x.trim()).find(x=>x.startsWith('p3_owner='))?.slice(9)??'');
  const session=await auth.session(token);requireThat(session.owner_id===p.ownerAccount,'wrong_owner');
  if(req.method==='POST'&&req.url==='/buyer-api/logout'){await auth.logout(token);res.setHeader('set-cookie','p3_owner=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');return json(res,200,{loggedOut:true});}
  if(req.method==='GET'&&req.url==='/buyer-api/agents'){
   const list=(await rows()).rows;
   for(const row of list)if(row.state==='ready'){try{await onboarding(row.id).confirmPolicy(p.ownerAccount,row.id);}catch{row.state='policy_pending';}}
   const funding=(await pool.query('SELECT user_id,id,state,deposit_hash FROM mpp_direct_p3_funding WHERE owner_id=$1',[p.ownerAccount])).rows;
   return json(res,200,{setup:true,agents:p.agents.map(a=>{const r=list.find(r=>r.id===a.agentId);return {agent_id:a.agentId,...(r?onboarding(a.agentId).view(r):{state:'not_created'}),funding:funding.find(f=>f.user_id===a.userId)??null};})});
  }
  const match=req.url.match(/^\/buyer-api\/wallets\/(agent-[12])\/(create|policy|confirm|funding|funding-confirm|freeze)$/);
  if(match&&req.method==='POST'){
   requireThat(!activating,'run_activation_pending');const [,id,action]=match,b=await read(req),o=onboarding(id);
   if(['create','policy','funding'].includes(action))requireThat(Date.now()<p.limits.deadlineMs,'run_expired');
   if(action==='create')return json(res,200,await o.create(p.ownerAccount,id));
   if(action==='policy')return json(res,200,await o.preparePolicy(p.ownerAccount,id));
   if(action==='confirm'){const r=await o.confirmPolicy(p.ownerAccount,id);await attach(id);return json(res,200,r);}
   if(action==='freeze')return json(res,200,await o.freezeTransaction(p.ownerAccount,id));
   const row=await o.row(p.ownerAccount,id);await verifyPolicy({binding:row.binding,rpc,api});
   if(p.funding?.kind==='oneclick'){
    const f=await fundingService();if(action==='funding')return json(res,200,await f.create(p.ownerAccount,id));
    return json(res,200,await f.prove(p.ownerAccount,b.id,b));
   }
   requireThat(p.funding?.kind==='native','funding_scope_required');
   const amount=p.funding.perAgentYocto;requireThat(typeof amount==='string'&&/^[1-9][0-9]{0,38}$/.test(amount),'native_funding_amount_required');
   const fundingId=hash(['native-funding',hash(p),id]);const prior=(await pool.query('SELECT request FROM mpp_direct_p3_funding WHERE id=$1',[fundingId])).rows[0];
   const request=prior?.request??{network:p.network,recipient:row.binding.payer,amount,owner:p.ownerAccount,createdAtMs:Date.now()};
   if(action==='funding'){
    await pool.query("INSERT INTO mpp_direct_p3_funding(id,run_id,owner_id,user_id,request,request_hash,state) VALUES($1,$2,$3,$4,$5,$6,'awaiting_owner') ON CONFLICT DO NOTHING",[fundingId,hash(p),p.ownerAccount,row.user_id,request,hash(request)]);
    const original=(await pool.query("UPDATE mpp_direct_p3_funding SET state='source_signing_unknown' WHERE id=$1 AND state='awaiting_owner' RETURNING *",[fundingId])).rows[0];
    requireThat(original,'original_funding_already_submitted');
    // This is an owner transaction, never an OutLayer transfer from a source wallet.
    return json(res,200,{id:fundingId,transaction:{signerId:p.ownerAccount,receiverId:request.recipient,actions:[{type:'Transfer',params:{deposit:amount}}]}});
   }
   const original=(await pool.query('SELECT * FROM mpp_direct_p3_funding WHERE id=$1',[fundingId])).rows[0];requireThat(original,'original_funding_required');
   requireThat(typeof b.txHash==='string'&&/^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(b.txHash),'invalid_funding_hash');
   requireThat(!original.deposit_hash||original.deposit_hash===b.txHash,'funding_transaction_conflict');
   if(original.state==='native_final')return json(res,200,{id:fundingId,state:'native_final'});
   await pool.query("UPDATE mpp_direct_p3_funding SET deposit_hash=$2,state='output_unknown' WHERE id=$1 AND (deposit_hash IS NULL OR deposit_hash=$2)",[fundingId,b.txHash]);
   const tx=await rpc.transaction(b.txHash,p.ownerAccount);
   const proof=await verifyNativeTransfer({rpc,p:{txHash:b.txHash,publicKey:session.public_key},r:{network:p.network,payer:p.ownerAccount,recipient:request.recipient,
    amount,orderRef:fundingId,issuedAtMs:request.createdAtMs,expiresAtMs:Number.MAX_SAFE_INTEGER},challengeId:fundingId});
   requireThat(tx.transaction.signer_id===p.ownerAccount,'source_funding_owner_mismatch');
   await pool.query("UPDATE mpp_direct_p3_funding SET state='native_final',native_proof=$2,movement=$3 WHERE id=$1",[fundingId,proof,proof.movementKey]);return json(res,200,{id:fundingId,state:'native_final'});
  }
  if(req.method==='POST'&&req.url==='/buyer-api/setup/activate'){
   requireThat(!activating,'run_activation_pending');activating=true;
   try{
    const list=(await rows()).rows;
    const agents=[];
    for(const a of p.agents){const row=list.find(r=>r.id===a.agentId);requireThat(row?.state==='ready','agent_policy_not_ready');await verifyPolicy({binding:row.binding,rpc,api});
     requireThat((await pool.query("SELECT 1 FROM mpp_direct_p3_funding WHERE user_id=$1 AND state='native_final'",[a.userId])).rowCount===1,'verified_native_funding_required');agents.push({...a,...row.binding});}
    await verifyPolicy({binding:p.merchantBinding,rpc,api});
    const merchant=await rpc.call('query',{request_type:'view_account',account_id:p.merchant,finality:'final'});
    requireThat(BigInt(merchant.amount)-BigInt(merchant.locked)-BigInt(merchant.storage_usage)*BigInt(c.storagePriceYocto)>=BigInt(p.limits.merchantGasFloorYocto)+BigInt(p.limits.gasReserveYocto),'merchant_refund_gas_required');
    const plan={...p,agents};validatePlan(plan);const next={...config,setupOnly:false,payments:{...c,plan}};
    const db=await pool.connect();try{await db.query('BEGIN');
     for(const a of agents){await db.query('SELECT pg_advisory_xact_lock(public.balance_cache_advisory_key($1))',[a.userId]);
      await db.query('INSERT INTO mpp_direct_p2_agent_limits(user_id,budget_nano) VALUES($1,$2) ON CONFLICT DO NOTHING',[a.userId,a.taskBudgetNano]);
      const task='task-'+a.agentId,id='session-'+a.agentId,prompt=a.prompt??'Read /workspace/numbers.txt, compute its sum, write result.txt, and verify the result.';
      const workspace={'/workspace/task.txt':prompt,'/workspace/numbers.txt':a.numbers??'1\n2\n3\n'};
      await db.query('INSERT INTO mpp_direct_tasks(id,user_id,budget_nano,hard_bid_nano,call_cap_nano,deadline_ms,preference) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING',[task,a.userId,a.taskBudgetNano,a.serviceCapNano??a.callCapNano,a.callCapNano,plan.limits.deadlineMs,a.preference??'balanced']);
      await db.query('INSERT INTO mpp_direct_p2_sessions(id,user_id,task_id,prompt,workspace,created_ms) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',[id,a.userId,task,prompt,workspace,Date.now()]);
     }
     await db.query('INSERT INTO mpp_direct_project_budget(id,budget_yocto) VALUES(1,$1) ON CONFLICT DO NOTHING',[plan.limits.merchantGasBudgetYocto]);
     await db.query('INSERT INTO mpp_direct_p3_provider_budget(singleton,maximum_micro,maximum_calls) VALUES(true,$1,$2) ON CONFLICT DO NOTHING',[plan.limits.providerBudgetMicro,plan.limits.maximumProviderCalls]);
     await db.query('COMMIT');
    }catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
    const output=resolve(config.activatedConfigPath);await mkdir(dirname(output),{recursive:true,mode:0o700});requireThat(((await stat(dirname(output))).mode&0o077)===0,'private_activation_directory_required');await writeFile(output+'.tmp',JSON.stringify(next,null,2),{mode:0o600,flag:'wx'});await rename(output+'.tmp',output);
    json(res,200,{activated:true,plan});setImmediate(()=>void onActivate(next));
   }catch(error){activating=false;throw error;}
   return;
  }
  throw new Error('not_found');
 }catch(error){const code=/^[a-z_]+$/.test(error.message)?error.message:'setup_outcome_unknown';if(!res.headersSent)json(res,code==='unauthorized'?401:400,{error:{code}});else res.destroy();}});
 await new Promise(r=>server.listen(config.port,'127.0.0.1',r));
 return {url:p.origin,async close(){server.closeAllConnections();await new Promise(r=>server.close(r));await pool.end();}};
}
