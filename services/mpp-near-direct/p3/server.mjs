import http from 'node:http';
import {readFileSync,existsSync} from 'node:fs';
import {resolve,extname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {Mppx} from 'mppx/client';
import {Credential} from 'mppx';
import {completion} from '../p1/server.mjs';
import {start as startProxy} from './proxy.mjs';
import {clientMethod} from '../method.mjs';
import {Onboarding} from './onboarding.mjs';
import {Tasks} from './tasks.mjs';
import {normalizeRecoveryBody} from '../p2/intent.mjs';
import {hash,requireThat} from '../contract.mjs';
const DIST=fileURLToPath(new URL('../../../clients/agent-playground/dist/',import.meta.url));
export function publicOrigin(value){
 if(value===undefined)return null;
 let u;try{u=new URL(value);}catch{throw new Error('invalid_public_origin');}
 requireThat(u.origin===value&&!u.username&&!u.password&&(u.protocol==='https:'||(u.protocol==='http:'&&u.hostname==='127.0.0.1'&&u.port)),'invalid_public_origin');
 return value;
}
const json=(res,status,value)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));};
async function read(req,raw=false){let n=0;const chunks=[];for await(const b of req){n+=b.length;requireThat(n<=(raw?128*1024:6*1024*1024),'body_too_large');chunks.push(b);}const text=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));return raw?text:JSON.parse(text||'{}');}
export async function start(config){
 const origin=publicOrigin(config.publicOrigin),secureCookie=origin?.startsWith('https:')?'; Secure':'';
 const proxy=await startProxy(config.payments);
 const onboarding=new Onboarding({pool:proxy.pool,api:proxy.services.api,rpc:proxy.authority.rpc,merchant:config.payments.merchant,realm:config.payments.realm,maximumYocto:config.payments.plan.agents[0].principalCapYocto,credentials:proxy.services.api.credentials});
 const {authority:a,pool}=proxy,tasks=new Tasks(a);let stopping=false;
 const tokenFor=user=>{const token=config.agentCredentials.find(x=>x.userId===user)?.token;requireThat(token,'agent_credentials_unavailable');return token;};
 async function purchase(owner,id,w,g,body,recovery=false){
  let s=await tasks.context(owner,id,w,g);requireThat(s.state==='running','task_not_running');
  body=normalizeRecoveryBody(body,recovery);
  // An original body always keeps its frozen intent, even after a later tool
  // commit advances the workspace. Only an unseen body may name the next call.
  const originalCall=(await pool.query('SELECT logical_key FROM mpp_direct_p2_calls WHERE session_id=$1 AND body_hash=$2',[id,hash(body)])).rows[0];
  const key=originalCall?.logical_key??hash([id,String(s.workspace_version)]),callId=hash([s.user_id,key]);
  const saved=(await pool.query('SELECT * FROM mpp_direct_p2_responses WHERE call_id=$1',[callId])).rows[0];
  if(saved){const c=(await pool.query('SELECT body_hash FROM mpp_direct_p2_calls WHERE id=$1',[callId])).rows[0];requireThat(c.body_hash===hash(body),'logical_call_conflict');return saved;}
  let proof;
  const client=Mppx.create({polyfill:false,methods:[clientMethod({recoverPayment:async challenge=>{
   await tasks.context(owner,id,w,g);requireThat(challenge.request.payer===(await pool.query('SELECT payer FROM mpp_direct_agents WHERE user_id=$1',[s.user_id])).rows[0].payer,'wrong_agent');
   const paid=await proxy.services.pay(challenge);proof=Credential.serialize(paid);return paid;
  }})]});
  const headers={'authorization':'Bearer '+tokenFor(s.user_id),'content-type':'application/json','x-agent-task':s.task_id,
   'x-p2-writer':w,'x-p2-generation':String(g),'idempotency-key':key};
  for(let n=0;n<1250&&!stopping;n++){
   s=await tasks.context(owner,id,w,g);requireThat(s.state==='running','task_not_running');
   const original=(await pool.query(`SELECT r.receipt FROM mpp_direct_orders o JOIN market_inference_requests q ON q.request_id=o.admitted_request
     JOIN market_inference_receipts r ON r.request_id=q.request_id AND r.revision=q.revision WHERE o.call_id=$1`,[callId])).rows[0]?.receipt;
   if(original?.status?.status==='unknown')throw new Error('original_execution_unknown');
   if(original?.settlement==='pending_metering')throw new Error('original_metering_pending');
   const h=new Headers(headers);if(proof)h.set('payment-authorization',proof);
   let response;
   try{response=await client.fetch(proxy.url+'/v1/chat/completions',{method:'POST',headers:h,body,redirect:'error',signal:AbortSignal.timeout(25000)});}
   catch(e){if(!(e instanceof TypeError)&&!/unknown|pending|timeout/i.test(e.message))throw e;await new Promise(r=>setTimeout(r,100));continue;}
   if(response.status===202||response.status===503){await response.body?.cancel();await new Promise(r=>setTimeout(r,100));continue;}
   if(!response.ok){const error=await response.json().catch(()=>({}));throw new Error(error.error?.code??error.reason??'procurement_closed');}
   const text=await response.text();requireThat(Buffer.byteLength(text)<=1024*1024,'native_response_too_large');
   let native;
   try{native=response.headers.get('content-type')?.startsWith('text/event-stream')?completion(text):JSON.parse(text);}
   catch{const current=(await pool.query('SELECT financial FROM mpp_direct_orders WHERE call_id=$1',[callId])).rows[0];throw new Error(current?.financial?'original_execution_closed':'original_execution_unknown');}
   const choice=native.choices?.[0];requireThat(choice,'invalid_native_terminal');
   if(choice.message.tool_calls){requireThat(choice.finish_reason==='tool_calls','invalid_tool_terminal');for(const t of choice.message.tool_calls){requireThat(t.function.name==='bash'&&t.id,'invalid_tool_terminal');let arg;try{arg=JSON.parse(t.function.arguments);}catch{throw new Error('invalid_tool_terminal');}requireThat(typeof arg.command==='string'&&Object.keys(arg).length===1,'invalid_tool_terminal');}}
   const publicHeaders=Object.fromEntries(['content-type','payment-receipt','x-order-id'].map(k=>[k,response.headers.get(k)]));
   // Persist before delivery to fx. A disconnect replays these exact original
   // bytes, never a new model call or an inferred tool transcript.
   await pool.query('INSERT INTO mpp_direct_p2_responses VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[callId,text,publicHeaders,Date.now()]);
   return (await pool.query('SELECT * FROM mpp_direct_p2_responses WHERE call_id=$1',[callId])).rows[0];
  }
  throw new Error('original_operation_pending');
 }
 const server=http.createServer(async(req,res)=>{
  try{
   const expectedOrigin=config.payments.plan.origin;
   if(['POST','PATCH'].includes(req.method))requireThat(req.headers.origin===expectedOrigin&&req.headers['content-type']?.split(';')[0]==='application/json','origin_denied');
   if(req.headers.origin&&req.headers.origin!==expectedOrigin)throw new Error('origin_denied');
   if(req.method==='GET'&&req.url==='/healthz')return json(res,200,{ready:true,phase:'P3',mode:config.payments.mode,realPayment:config.payments.mode==='bounded',walletProvider:'outlayer',revision:config.buildRevision??null});
   if(req.method==='GET'&&req.url==='/buyer-api/config')return json(res,200,{phase:'P3',mode:config.payments.mode,network:config.payments.network,origin:config.payments.plan.origin,plan:config.payments.plan});
   if(req.method==='POST'&&req.url==='/buyer-api/auth/challenge')return json(res,200,await proxy.services.auth.challenge('login'));
   if(req.method==='POST'&&req.url==='/buyer-api/auth/verify'){
    const input=await read(req),signed=await proxy.services.auth.verify(input.id,input.signed);
    res.setHeader('set-cookie','p3_owner='+encodeURIComponent(signed.token)+'; HttpOnly; SameSite=Strict; Path=/'+(config.payments.plan.origin.startsWith('https:')?'; Secure':''));
    return json(res,200,{owner:signed.owner,expiresAtMs:signed.expiresAtMs});
   }
   if(req.method==='GET'&&!req.url.startsWith('/buyer-api/')){
    const pathname=decodeURIComponent(req.url.split('?')[0]);
    const path=resolve(DIST,'.'+(['/', '/proposal', '/proposal/'].includes(pathname)?'/p3.html':pathname));
    requireThat(path.startsWith(resolve(DIST)+'/')&&existsSync(path),'not_found');
    const type={'.html':'text/html','.js':'text/javascript','.css':'text/css','.wasm':'application/wasm','.woff2':'font/woff2'}[extname(path)]??'application/octet-stream';
    res.writeHead(200,{'content-type':type,'cache-control':'no-store'});res.end(readFileSync(path));return;
   }
   const code=decodeURIComponent(String(req.headers.cookie??'').split(';').map(x=>x.trim()).find(x=>x.startsWith('p3_owner='))?.slice(9)??'');
   const owner=await tasks.owner(code);
   if(req.method==='POST'&&req.url==='/buyer-api/authorization/challenge')return json(res,200,await proxy.services.auth.challenge('grant',owner,(await read(req)).role??'owner'));
   if(req.method==='POST'&&req.url==='/buyer-api/authorization/verify'){const input=await read(req);return json(res,200,await proxy.services.auth.verify(input.id,input.signed,'grant'));}
   if(req.method==='POST'&&req.url==='/buyer-api/authorization/revoke')return json(res,200,await proxy.services.auth.revoke(owner,(await read(req)).role??'owner'));
   const setup=req.url.match(/^\/buyer-api\/wallets\/([a-zA-Z0-9_-]{1,96})\/(create|policy|confirm|freeze)$/);
   if(setup&&req.method==='POST'){
    requireThat(owner===config.payments.plan.ownerAccount,'wrong_owner');await read(req);const [,id,action]=setup;
    return json(res,200,await ({create:()=>onboarding.create(owner,id),policy:()=>onboarding.preparePolicy(owner,id),confirm:()=>onboarding.confirmPolicy(owner,id),freeze:()=>onboarding.freezeTransaction(owner,id)})[action]());
   }

   if(req.method==='POST'&&req.url==='/v1/chat/completions'){
    const body=await read(req,true),value=await purchase(owner,String(req.headers['x-fx-session']??''),String(req.headers['x-fx-writer']??''),String(req.headers['x-fx-generation']??''),body,req.headers['x-fx-recovery']==='libfx-0.0.16');
    res.writeHead(200,{...value.headers,'cache-control':'no-store'});res.end(value.body);return;
   }
   if(req.method==='GET'&&req.url==='/buyer-api/agents')return json(res,200,{mode:config.payments.mode,agents:await tasks.list(owner)});
   const create=req.url.match(/^\/buyer-api\/agents\/(agent-[12])\/tasks$/);
   if(create&&req.method==='POST')return json(res,201,await tasks.create(owner,create[1],await read(req)));
   if(req.method==='POST'&&req.url==='/buyer-api/logout'){
    for(const s of await tasks.list(owner))if(!s.paused&&s.state!=='complete')await tasks.control(owner,'session',s.id,{action:'pause',expectedRevision:s.revision,operation:'logout-'+s.id+'-'+s.revision});
    await proxy.services.auth.logout(code);
    res.setHeader('set-cookie','p3_owner=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'+(config.payments.plan.origin.startsWith('https:')?'; Secure':''));return json(res,200,{loggedOut:true});
   }
   const match=req.url.match(/^\/buyer-api\/sessions\/([a-zA-Z0-9_-]{1,96})(?:\/(claim|heartbeat|journal|tool|inference|control|finish))?$/);
   if(match){
    const [,id,op]=match;
    if(req.method==='GET'&&!op)return json(res,200,await tasks.status(owner,id));
    requireThat(req.method==='POST','method_not_allowed');
    const input=await read(req),w=String(req.headers['x-fx-writer']??''),g=String(req.headers['x-fx-generation']??'');
    if(op==='claim')return json(res,200,await tasks.claim(owner,id,input));
    if(op==='heartbeat')return json(res,200,await tasks.heartbeat(owner,id,w,g));
    if(op==='journal')return json(res,200,input.load?await tasks.load(owner,id,w,g):await tasks.append(owner,id,w,g,input));
    if(op==='tool')return json(res,200,await tasks.tool(owner,id,w,g,input));
    if(op==='control')return json(res,200,await tasks.control(owner,'session',id,input));
    if(op==='finish')return json(res,200,await tasks.finish(owner,id,w,g,input));
    if(op==='inference'){
     requireThat(typeof input.body==='string'&&input.body.length<=128*1024,'native_body_required');
     const value=await purchase(owner,id,w,g,input.body);res.writeHead(200,{...value.headers,'cache-control':'no-store'});res.end(value.body);return;
    }
   }
   const call=req.url.match(/^\/buyer-api\/calls\/([0-9a-f]{64})$/);
   if(call&&req.method==='PATCH')return json(res,200,await tasks.control(owner,'call',call[1],await read(req)));
   throw new Error('not_found');
  }catch(e){const code=/^[a-z][a-z0-9_]+$/.test(e.message)?e.message:'operation_outcome_unknown';const status=code==='unauthorized'?401:/^unknown_|not_found/.test(code)?404:/conflict|fenced|frozen|closed|busy|complete|original_execution_unknown|original_metering_pending/.test(code)?409:/unknown|pending|unavailable/.test(code)?503:400;
   if(!res.headersSent)json(res,status,{error:{code}});else res.destroy();}
 });
 await new Promise(r=>server.listen(config.port??0,'127.0.0.1',r));
 return {url:'http://127.0.0.1:'+server.address().port,proxy,tasks,async close(){stopping=true;server.closeAllConnections();await new Promise(r=>server.close(r));await proxy.close();}};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){const c=JSON.parse(readFileSync(process.argv[2],'utf8'));const app=await start(c);console.log(JSON.stringify({url:app.url,phase:'P3',mode:c.payments.mode,realPayment:c.payments.mode==='bounded'}));for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>void app.close().then(()=>process.exit(0)));}
