import http from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { Mppx } from 'mppx/server';
import { Credential, Receipt } from 'mppx';
import { Authority } from './authority.mjs';
import { sponsoredServer, SPONSORED } from './sponsored.mjs';
import { NearRpc } from '../near.mjs';
import { requireThat } from '../contract.mjs';

function localUrl(raw, schemes) {
  const url=new URL(raw); requireThat(schemes.includes(url.protocol) && url.hostname==='127.0.0.1'
    && !url.search && !url.hash, 'controlled_loopback_required'); return url;
}
export function validateConfig(c) {
  requireThat(c.mode==='controlled' && c.network==='testnet' && c.realBroadcastEnabled===false, 'live_native_fee_gate_closed');
  requireThat(typeof c.secret==='string' && c.secret.length>=32,'payment_secret_required');
  localUrl(c.databaseUrl,['postgres:','postgresql:']); localUrl(c.upstream,['http:']);
  localUrl(c.rpcUrl,['http:']); localUrl(c.walletFixtureUrl,['http:']);
  requireThat(new URL(c.databaseUrl).pathname.startsWith('/private_market_'),'isolated_database_required');
  requireThat(c.paymentWindowMs>0 && c.paymentWindowMs<=60_000 && c.leaseTailMs>=2000
    && c.estimatedTerminalMs>0 && c.paymentEstimateMs>0, 'invalid_timing_config');
}
async function readBody(request) {
  let size=0; const chunks=[];
  for await (const b of request) {size+=b.length; requireThat(size<=128*1024,'body_too_large');chunks.push(b);}
  return Buffer.concat(chunks).toString('utf8');
}
function json(res,status,value) {res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));}
export function completion(sse) {
  const frames=sse.split('\n').filter(l=>l.startsWith('data: {')).map(l=>JSON.parse(l.slice(6)));
  requireThat(sse.endsWith('data: [DONE]\n\n') && frames.length,'original_native_terminal_unavailable');
  const first=frames[0]; let content='',refusal='',finish=null,usage;const calls=new Map();
  for (const f of frames) {for(const c of f.choices??[]){content+=c.delta?.content??'';refusal+=c.delta?.refusal??'';
    for(const t of c.delta?.tool_calls??[]){const old=calls.get(t.index)??{id:'',type:'function',function:{name:'',arguments:''}};
      if(t.id)old.id=t.id;if(t.function?.name)old.function.name+=t.function.name;old.function.arguments+=t.function?.arguments??'';calls.set(t.index,old);}
    if(c.finish_reason)finish=c.finish_reason;}if(f.usage)usage=f.usage;}
  requireThat(finish && usage,'original_native_terminal_unavailable');
  return {id:first.id,object:'chat.completion',created:first.created,model:first.model,
    choices:[{index:0,message:{role:'assistant',content:content||null,...(refusal?{refusal}:{}),...(calls.size?{tool_calls:[...calls.entries()].sort((a,b)=>a[0]-b[0]).map(x=>x[1])}:{})},finish_reason:finish}],usage};
}
export async function start(config, {AuthorityClass=Authority,validate=validateConfig,createRoute,rpc:providedRpc}={}) {
  validate(config);
  const pool=new pg.Pool({connectionString:config.databaseUrl,max:8,connectionTimeoutMillis:5000});
  pool.on('error',()=>{ /* Recover idle connection loss without changing operation identity. */ });
  const rpc=providedRpc??new NearRpc({url:config.rpcUrl,network:config.network,controlled:true});
  const paymentRoute=createRoute?await createRoute({pool,rpc,config}):undefined;
  const authority=new AuthorityClass({pool,rpc,config,paymentRoute}); await authority.pin();
  const mpp=Mppx.create({realm:config.realm,secretKey:config.secret,credentialHeader:'Payment-Authorization',methods:[paymentRoute?.server?paymentRoute.server({rpc,authority}):sponsoredServer({rpc,authority})]});
  const walletFetch=paymentRoute?.services?.fetch??fetch;
  let stopped=false,refundBusy=false;
  async function refunds() {
    if(refundBusy||stopped)return;refundBusy=true;
    try {
      const pending=(await pool.query(`SELECT o.* FROM mpp_direct_orders o JOIN mpp_direct_sponsor_operations s ON s.id=o.sponsor_operation
        LEFT JOIN mpp_direct_recovery_attempts r ON r.order_id=o.id AND r.kind='payment'
        WHERE o.admitted_request IS NULL AND ((NOT o.received AND o.state IN('quoted','payment_unknown','cancelled') AND s.state IN('authorized','unknown')) OR o.state='paid')
        ORDER BY r.attempted_at NULLS FIRST,o.created_ms,o.id LIMIT 16`)).rows;
      for(const o of pending){try{
        await pool.query("INSERT INTO mpp_direct_recovery_attempts(order_id,kind) VALUES($1,'payment') ON CONFLICT(order_id,kind) DO UPDATE SET attempted_at=clock_timestamp()",[o.id]);
        if(!o.received){
          const response=await walletFetch(config.walletFixtureUrl+'/wallet/status',{method:'POST',redirect:'error',signal:AbortSignal.timeout(2500),headers:{'content-type':'application/json','x-fixture-key':config.buyerWalletKey},body:JSON.stringify({orderRef:o.id})});
          if(response.ok){const status=await response.json();if(status.credential){await authority.journalPresentation(Credential.deserialize(status.credential));await authority.reconcile(o.id,o.user_id);}
            else if(Date.now()>=Number(o.expires_ms)){await closeOriginal(o);}}
        }
        await authority.refreshBeforeAdmission(await authority.getOrder(o.id,o.user_id));
      }catch{ /* Keep original principal/project responsibility until evidence is conclusive. */ }}
      const due=(await pool.query(`SELECT o.id FROM mpp_direct_orders o LEFT JOIN mpp_direct_recovery_attempts r ON r.order_id=o.id AND r.kind='refund'
        WHERE o.w>0 OR EXISTS(SELECT FROM mpp_direct_anomalies a WHERE a.order_id=o.id AND NOT a.refunded AND a.amount>0)
        ORDER BY r.attempted_at NULLS FIRST,o.created_ms,o.id LIMIT 4`)).rows;
      for(const {id} of due){
        try {
          await pool.query("INSERT INTO mpp_direct_recovery_attempts(order_id,kind) VALUES($1,'refund') ON CONFLICT(order_id,kind) DO UPDATE SET attempted_at=clock_timestamp()",[id]);
          const r=await authority.prepareRefund(id);
          let original=r.original_send;
          if(!original){
            // The controlled wallet owns durable idempotency, not the HTTP
            // acknowledgement. It returns the original transaction on replay.
            const response=await walletFetch(config.walletFixtureUrl+'/merchant/refund',{method:'POST',redirect:'error',signal:AbortSignal.timeout(2500),
              headers:{'content-type':'application/json','x-fixture-key':config.walletFixtureKey},body:JSON.stringify({plan:r.plan})});
            requireThat(response.ok,'refund_sender_unknown'); original=await response.json();
            await authority.recordRefundSend(r.id,original);
          }
          await authority.confirmRefund(r.id,original.publicKey);
        } catch(e) {
          await pool.query('UPDATE mpp_direct_refunds SET last_error=$2 WHERE order_id=$1',[id,String(e.message).slice(0,512)]).catch(()=>{});
        }
      }
    } finally {refundBusy=false;}
  }
  const timer=setInterval(()=>{if(config.refundAuto)void refunds().catch(()=>{ /* PG/network outages retain durable responsibilities for retry. */ });},100);
  async function closeOriginal(o){
    const response=await walletFetch(config.walletFixtureUrl+'/wallet/cancel',{method:'POST',redirect:'error',signal:AbortSignal.timeout(2500),
      headers:{'content-type':'application/json','x-fixture-key':config.buyerWalletKey},body:JSON.stringify({orderRef:o.id})});
    requireThat(response.ok,'original_wallet_outcome_unknown');return authority.cancel(o,await response.json());
  }
  const server=http.createServer(async(req,res)=>{
    try{
      if(req.method==='GET'&&req.url==='/healthz') return json(res,200,{ready:true,mode:'controlled',realPayment:false,realBroadcastEnabled:false});
      if(req.method==='POST'&&req.url==='/internal/refunds/tick'){
        requireThat(req.headers['x-p1-control']===config.secret,'unauthorized');await refunds();return json(res,200,{reconciled:true});
      }
      const token=String(req.headers.authorization??'').replace(/^Bearer /,'');
      const agent=await authority.authenticate(token);
      const match=req.url.match(/^\/v1\/orders\/([0-9a-f]{64})(?:\/(reconcile|cancel))?$/);
      if(match){
        const order=await authority.getOrder(match[1],agent.user_id);requireThat(order,'unknown_order');
        if(req.method==='GET'&&!match[2])return json(res,200,authority.view(order));
        if(req.method==='POST'&&match[2]==='reconcile'){
          const input=JSON.parse(await readBody(req)||'{}');
          if(input.credential){const c=Credential.deserialize(input.credential);requireThat(c.challenge.request.orderRef===order.id,'wrong_payment_resource');await authority.journalPresentation(c);}
          return json(res,200,await authority.reconcile(order.id,agent.user_id));
        }
        if(req.method==='POST'&&match[2]==='cancel')return json(res,200,await closeOriginal(order));
      }
      requireThat(req.method==='POST'&&req.url==='/v1/chat/completions','not_found');
      const raw=await readBody(req),key=String(req.headers['idempotency-key']??''),task=String(req.headers['x-agent-task']??'');
      let order=await authority.prepare(agent,task,key,raw,{headers:req.headers});
      if(order.waiting)return json(res,order.closed?409:202,{...order,retryAfterMs:100});
      requireThat(!(order.state==='cancelled'&&!order.received)&&!(order.state==='refunded'&&!order.admitted_request),'order_closed');
      const credential=req.headers['payment-authorization'];
      if(credential)requireThat(Credential.deserialize(String(credential)).challenge.request.orderRef===order.id,'wrong_payment_resource');
      if(!order.received){
        if(!credential){
          const prior=(await pool.query('SELECT 1 FROM mpp_direct_presentations WHERE order_id=$1',[order.id])).rows[0];
          if(prior){try{await authority.reconcile(order.id,agent.user_id);}catch{}order=await authority.getOrder(order.id,agent.user_id);
            if(!order.received)return json(res,503,{error:{code:'original_payment_pending'},orderId:order.id});}
          else {
            const response=await walletFetch(config.walletFixtureUrl+'/wallet/status',{method:'POST',redirect:'error',signal:AbortSignal.timeout(2500),
              headers:{'content-type':'application/json','x-fixture-key':config.buyerWalletKey},body:JSON.stringify({orderRef:order.id})});
            requireThat(response.ok,'original_wallet_outcome_unknown');const status=await response.json();
            if(status.credential){await authority.journalPresentation(Credential.deserialize(status.credential));try{await authority.reconcile(order.id,agent.user_id);}catch{}
              order=await authority.getOrder(order.id,agent.user_id);if(!order.received)return json(res,503,{error:{code:'original_payment_pending'},orderId:order.id});}
            else {requireThat(order.state==='quoted','original_payment_pending');res.writeHead(402,{'www-authenticate':order.challenge_header,'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify({error:{code:'payment_required'},orderId:order.id}));return;}
          }
        }
      }
      let receipt;
      if(order.received && order.credit_ledger){
        const recorded=(await pool.query(`SELECT m.proof,EXISTS(SELECT FROM redis_balance_mutations WHERE ledger_entry_id=o.credit_ledger AND state='applied') AS ready
          FROM mpp_direct_orders o JOIN mpp_direct_movements m ON m.order_id=o.id AND m.purpose='payment' WHERE o.id=$1`,[order.id])).rows[0];
        requireThat(recorded?.ready,'payment_projection_pending');
        receipt=order.payment_receipt??Receipt.from({method:authority.paymentRoute.method,status:'success',reference:recorded.proof.movementKey,timestamp:new Date(recorded.proof.paidAtMs).toISOString()});
      } else if(credential){
        try {receipt=await mpp.broadcastCredential(String(credential));}
        catch(e){
          order=await authority.getOrder(order.id,agent.user_id);
          if(order.received)return json(res,503,{error:{code:order.state==='refund_due'?'payment_requires_refund':'payment_projection_pending'},orderId:order.id});
          throw e;
        }
      } else {
        // Recorded payment recovery never creates a replacement 402. The
        // durable original credential is reverified by the same SDK path.
        const original=(await pool.query('SELECT credential FROM mpp_direct_presentations WHERE order_id=$1 ORDER BY created_at DESC LIMIT 1',[order.id])).rows[0];
        requireThat(original,'original_payment_unknown');
        receipt=await mpp.broadcastCredential(original.credential);
      }
      await pool.query('UPDATE mpp_direct_orders SET payment_receipt=coalesce(payment_receipt,$2) WHERE id=$1',[order.id,receipt]);
      order=await authority.refreshBeforeAdmission(await authority.getOrder(order.id,agent.user_id));
      requireThat(['paid','admitted','refund_due','refunded','settled'].includes(order.state) && (!order.state.startsWith('refund')||order.admitted_request),'payment_not_admissible');
      // Stable native id and original idempotency are fenced again inside the
      // Market transaction. Lost ACK retries recover that original command.
      const nativeBody={...order.internal_body,bitrouter_purchase:{service_type:'on_demand',provider_cap_micro_usd:Number(order.provider_cap_micro),total_cap_micro_usd:Number(order.service_micro),max_attempts:1}};
      await authority.timing(order.id,'native_admission_requested');
      const nativeOrigin=authority.nativeOrigin?await authority.nativeOrigin(order):config.upstream;
      const upstream=await fetch(nativeOrigin+'/market/v1/chat/completions',{method:'POST',redirect:'error',signal:AbortSignal.timeout(config.nativeTimeoutMs??20_000),
        headers:{authorization:'Bearer '+token,'content-type':'application/json','idempotency-key':order.dispatch_key},body:JSON.stringify(nativeBody)});
      if(!upstream.ok){await upstream.body?.cancel();const current=await authority.getOrder(order.id,agent.user_id);
        return json(res,current.financial?409:503,{error:{code:current.financial?'original_execution_closed':'original_admission_pending'},orderId:order.id});}
      const body=JSON.parse(raw);
      const paidHeaders={'content-type':body.stream?'text/event-stream':'application/json','cache-control':'no-store',
        'payment-receipt':Buffer.from(JSON.stringify(receipt)).toString('base64url'),'x-order-id':order.id};
      let size=0,interrupted=false;const chunks=[];
      if(body.stream){res.writeHead(200,paidHeaders);res.flushHeaders();}
      for await(const chunk of upstream.body){
        size+=chunk.length;requireThat(size<=1024*1024,'native_response_too_large');
        if(body.stream){
          if(res.destroyed){interrupted=true;break;}
          if(!res.write(chunk))await Promise.race([once(res,'drain'),once(res,'close')]);
        }else chunks.push(chunk);
      }
      await authority.timing(order.id,interrupted?'client_delivery_interrupted':'native_response_read_finished');
      if(body.stream)res.end();
      else {const result=completion(Buffer.concat(chunks).toString('utf8'));res.writeHead(200,paidHeaders);res.end(JSON.stringify(result));}
    }catch(e){
      const code=/^[a-z][a-z0-9_]+$/.test(e.message??'')?e.message:'operation_outcome_unknown';
      const status=code==='unauthorized'?401:code==='not_found'||code==='unknown_order'?404:
        ['supply_unavailable','budget_or_speed_constraints'].includes(code)?202:
        /conflict|already_consumed|already_admitted|order_closed/.test(code)?409:
        /pending|unknown|unavailable|RPC|fetch failed|payment_not_admissible/.test(code)?503:400;
      if(!res.headersSent)json(res,status,{error:{code}});else res.destroy();
    }
  });
  await new Promise(resolve=>server.listen(config.port??0,'127.0.0.1',resolve));
  const url='http://127.0.0.1:'+server.address().port;
  return {url,authority,pool,async close(){stopped=true;clearInterval(timer);await new Promise(r=>server.close(r));while(refundBusy)await new Promise(r=>setTimeout(r,20));await pool.end();}};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const config=JSON.parse(readFileSync(process.argv[2],'utf8'));
  const app=await start(config);console.log(JSON.stringify({url:app.url,mode:'controlled',realBroadcastEnabled:false}));
  process.on('SIGINT',()=>{void app.close().then(()=>process.exit(0));});
}
