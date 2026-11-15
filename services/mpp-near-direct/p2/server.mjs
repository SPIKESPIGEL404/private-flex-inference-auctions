import http from 'node:http';
import {readFileSync,existsSync} from 'node:fs';
import {resolve,extname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {Mppx} from 'mppx/client';
import {Credential} from 'mppx';
import {start as startProxy,completion} from '../p1/server.mjs';
import {sponsoredClient} from '../p1/sponsored.mjs';
import {Authority} from './authority.mjs';
import {PublicWorkspace} from './public-workspace.mjs';
import {Tasks} from './tasks.mjs';
import {normalizeRecoveryBody} from './intent.mjs';
import {hash,requireThat} from '../contract.mjs';
const DIST=fileURLToPath(new URL('../../../clients/market-playground/dist/',import.meta.url));
export function publicOrigin(value){
 if(value===undefined)return null;
 let u;try{u=new URL(value);}catch{throw new Error('invalid_public_origin');}
 requireThat(u.origin===value&&!u.username&&!u.password&&(u.protocol==='https:'||(u.protocol==='http:'&&u.hostname==='127.0.0.1'&&u.port)),'invalid_public_origin');
 return value;
}
export function approvedOrigins(origin,additional=[]){
 requireThat(Array.isArray(additional)&&additional.length<=1,'invalid_additional_origins');
 const values=[origin,...additional].filter(x=>x!==null);
 for(const value of values){publicOrigin(value);requireThat(!new URL(value).hostname.includes('*'),'wildcard_origin_forbidden');requireThat(!origin||new URL(value).protocol===new URL(origin).protocol,'mixed_origin_security');}
 requireThat(!additional.length||origin,'canonical_origin_required');return new Set(values);
}
const json=(res,status,value)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));};
async function read(req,raw=false){let n=0;const chunks=[];for await(const b of req){n+=b.length;requireThat(n<=(raw?128*1024:6*1024*1024),'body_too_large');chunks.push(b);}const text=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));return raw?text:JSON.parse(text||'{}');}
export async function start(config){
 const origin=publicOrigin(config.publicOrigin),origins=approvedOrigins(origin,config.additionalPublicOrigins),secureCookie=origin?.startsWith('https:')?'; Secure':'';
 requireThat(config.payments.phase2===true&&config.payments.mode==='controlled','controlled_p2_required');
 const proxy=await startProxy(config.payments,{AuthorityClass:Authority});
 const {authority:a,pool}=proxy,tasks=new Tasks(a);let stopping=false;
 const workspace=config.publicWorkspace?new PublicWorkspace({...config.publicWorkspace,origin,origins:[...origins]},pool):null;
 const cookies=req=>Object.fromEntries(String(req.headers.cookie??'').split(';').map(x=>x.trim().split(/=(.*)/s).slice(0,2)));
 const cookie=(name,value)=>name+'='+encodeURIComponent(value)+'; HttpOnly; SameSite=Strict; Path=/'+secureCookie;
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
  const client=Mppx.create({polyfill:false,methods:[sponsoredClient({recoverPayment:async challenge=>{
   await tasks.context(owner,id,w,g);requireThat(challenge.request.payer===(await pool.query('SELECT payer FROM mpp_direct_agents WHERE user_id=$1',[s.user_id])).rows[0].payer,'wrong_agent');
   const result=await fetch(config.payments.walletFixtureUrl+'/wallet/pay',{method:'POST',redirect:'error',signal:AbortSignal.timeout(2500),
    headers:{'content-type':'application/json','x-fixture-key':config.payments.buyerWalletKey},body:JSON.stringify({challenge})});
   requireThat(result.ok,'original_wallet_outcome_unknown');const paid=await result.json();proof=paid.credential;return Credential.deserialize(proof);
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
   const requestOrigin=req.headers.origin??origin??`http://127.0.0.1:${server.address().port}`;
   if(req.headers.origin&&!origins.has(req.headers.origin)&&req.headers.origin!==(origin??`http://127.0.0.1:${server.address().port}`))throw new Error('origin_denied');
   if(req.method==='GET'&&req.url==='/healthz')return json(res,200,{ready:true,phase:'P2',mode:'controlled',realPayment:false,revision:config.buildRevision??null});
   if(req.method==='GET'&&req.url==='/buyer-api/capabilities')return json(res,200,{version:1,mode:'controlled',tasks:true,walletSetup:false,realInferencePayments:false,maxTasksPerAgent:2,taskWindowMs:180000,ownerAuth:workspace?'nep413':'code',nativeWallets:!!workspace});
   if(workspace&&req.url==='/buyer-api/session'&&req.method==='GET'){
    let owner=null;try{owner=workspace.auth.owner(decodeURIComponent(cookies(req).near_owner??''));}catch{}return json(res,200,{owner});
   }
   if(workspace&&req.method==='POST'&&req.url==='/buyer-api/auth/challenge'){
    const challenge=workspace.auth.challenge(requestOrigin);res.setHeader('set-cookie',cookie('near_challenge',challenge.token));return json(res,200,challenge.payload);
   }
   if(workspace&&req.method==='POST'&&req.url==='/buyer-api/auth/verify'){
    const signed=await read(req),challenge=decodeURIComponent(cookies(req).near_challenge??''),result=await workspace.auth.verify(challenge,signed);
    try{await workspace.provision(result.owner.account_id);requireThat(!workspace.auth.cancelled(challenge),'login_cancelled');requireThat(Date.now()<result.challengeExpiresAt,'login_challenge_expired');}catch(e){workspace.auth.logout(result.token);throw e;}
    res.setHeader('set-cookie',[cookie('near_challenge','')+'; Max-Age=0',cookie('near_owner',result.token)]);return json(res,200,{owner:result.owner});
   }
   if(workspace&&req.method==='POST'&&req.url==='/buyer-api/logout'){
    const token=decodeURIComponent(cookies(req).near_owner??'');let owner;
    try{owner=workspace.owner(token);}catch{}
    workspace.auth.cancel(decodeURIComponent(cookies(req).near_challenge??''));workspace.auth.logout(token);
    res.setHeader('set-cookie',[cookie('near_owner','')+'; Max-Age=0',cookie('near_challenge','')+'; Max-Age=0']);
    const pauseFailures=[];
    if(owner)for(const s of await tasks.list(owner))if(!s.paused&&s.state!=='complete')try{await tasks.control(owner,'session',s.id,{action:'pause',expectedRevision:s.revision,operation:'logout-'+s.id+'-'+s.revision});}catch{pauseFailures.push(s.id);}
    return json(res,200,{loggedOut:true,pauseFailures});
   }
   if(!workspace&&req.method==='POST'&&req.url==='/buyer-api/login'){
    const {code}=await read(req);requireThat(typeof code==='string','unauthorized');await tasks.owner(code);
    res.setHeader('set-cookie','p2_owner='+encodeURIComponent(code)+'; HttpOnly; SameSite=Strict; Path=/'+secureCookie);return json(res,200,{mode:'controlled'});
   }
   if(req.method==='GET'&&!req.url.startsWith('/buyer-api/')){
    const pathname=decodeURIComponent(req.url.split('?')[0]);
    const path=resolve(DIST,'.'+(['/', '/proposal', '/proposal/'].includes(pathname)?'/index.html':pathname));
    requireThat(path.startsWith(resolve(DIST)+'/')&&existsSync(path),'not_found');
    const type={'.html':'text/html','.js':'text/javascript','.css':'text/css','.wasm':'application/wasm','.woff2':'font/woff2'}[extname(path)]??'application/octet-stream';
    res.writeHead(200,{'content-type':type,'cache-control':'no-store'});res.end(readFileSync(path));return;
   }
   const code=decodeURIComponent(String(req.headers.cookie??'').split(';').map(x=>x.trim()).find(x=>x.startsWith('p2_owner='))?.slice(9)??'');
   const owner=workspace?workspace.owner(decodeURIComponent(cookies(req).near_owner??'')):await tasks.owner(code);
   if(workspace&&req.url==='/buyer-api/native-operations'){if(req.method==='GET')return json(res,200,{operations:workspace.operations(owner)});if(req.method==='POST')return json(res,200,await workspace.begin(owner,await read(req)));}
   const nativeHash=req.url.match(/^\/buyer-api\/native-operations\/([a-zA-Z0-9_-]{1,96})\/hash$/);
   if(workspace&&nativeHash&&req.method==='POST')return json(res,200,workspace.bindHash(owner,nativeHash[1],await read(req)));
   const nativeOp=req.url.match(/^\/buyer-api\/native-operations\/([a-zA-Z0-9_-]{1,96})\/reconcile$/);
   if(workspace&&nativeOp&&req.method==='POST')return json(res,200,await workspace.reconcile(owner,nativeOp[1],await read(req)));
   if(workspace&&req.url==='/buyer-api/native-wallets'){if(req.method==='GET')return json(res,200,{agents:workspace.wallets(owner)});if(req.method==='POST')return json(res,200,{agents:await workspace.register(owner,(await read(req)).agents,requestOrigin)});}
   if(req.method==='POST'&&req.url==='/v1/chat/completions'){
    const body=await read(req,true),value=await purchase(owner,String(req.headers['x-fx-session']??''),String(req.headers['x-fx-writer']??''),String(req.headers['x-fx-generation']??''),body,req.headers['x-fx-recovery']==='libfx-0.0.16');
    res.writeHead(200,{...value.headers,'cache-control':'no-store'});res.end(value.body);return;
   }
   if(req.method==='GET'&&req.url==='/buyer-api/agents')return json(res,200,{mode:'controlled',ownerScope:hash(owner),agents:await tasks.list(owner),limits:(await pool.query('SELECT a.agent_id,l.budget_nano,l.reserved_nano,l.spent_nano FROM mpp_direct_agents a JOIN mpp_direct_p2_agent_limits l ON l.user_id=a.user_id WHERE a.owner_id=$1 ORDER BY a.agent_id',[owner])).rows});
   const create=req.url.match(/^\/buyer-api\/agents\/([a-zA-Z0-9_-]{1,96})\/tasks$/);
   if(create&&req.method==='POST')return json(res,201,await tasks.create(owner,create[1],await read(req)));
   if(req.method==='POST'&&req.url==='/buyer-api/logout'){
    for(const s of await tasks.list(owner))if(!s.paused&&s.state!=='complete')await tasks.control(owner,'session',s.id,{action:'pause',expectedRevision:s.revision,operation:'logout-'+s.id+'-'+s.revision});
    if(workspace){workspace.auth.logout(decodeURIComponent(cookies(req).near_owner??''));res.setHeader('set-cookie',cookie('near_owner','')+'; Max-Age=0');return json(res,200,{loggedOut:true});}
    res.setHeader('set-cookie','p2_owner=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'+secureCookie);return json(res,200,{loggedOut:true});
   }
   const match=req.url.match(/^\/buyer-api\/sessions\/([a-zA-Z0-9_-]{1,96})(?:\/(claim|heartbeat|journal|tool|inference|control|finish|release))?$/);
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
    if(op==='release')return json(res,200,await tasks.release(owner,id,w,g));
    if(op==='inference'){
     requireThat(typeof input.body==='string'&&input.body.length<=128*1024,'native_body_required');
     const value=await purchase(owner,id,w,g,input.body);res.writeHead(200,{...value.headers,'cache-control':'no-store'});res.end(value.body);return;
    }
   }
   const call=req.url.match(/^\/buyer-api\/calls\/([0-9a-f]{64})$/);
   if(call&&req.method==='PATCH')return json(res,200,await tasks.control(owner,'call',call[1],await read(req)));
   throw new Error('not_found');
  }catch(e){const code=/^[a-z][a-z0-9_]+$/.test(e.message)?e.message:'operation_outcome_unknown';const status=['unauthorized','login_required','login_challenge_expired','invalid_signature','login_cancelled'].includes(code)?401:/^unknown_|not_found/.test(code)?404:/conflict|fenced|frozen|closed|busy|complete|original_execution_unknown|original_metering_pending/.test(code)?409:/unknown|pending|unavailable/.test(code)?503:400;
   if(!res.headersSent)json(res,status,{error:{code}});else res.destroy();}
 });
 await new Promise(r=>server.listen(config.port??0,'127.0.0.1',r));
 return {url:'http://127.0.0.1:'+server.address().port,proxy,tasks,async close(){stopping=true;server.closeAllConnections();await new Promise(r=>server.close(r));await proxy.close();workspace?.close();}};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){const c=JSON.parse(readFileSync(process.argv[2],'utf8'));const app=await start(c);console.log(JSON.stringify({url:app.url,phase:'P2',mode:'controlled',realPayment:false}));process.on('SIGINT',()=>void app.close().then(()=>process.exit(0)));}
