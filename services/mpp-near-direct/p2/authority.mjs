import {randomBytes,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {Challenge} from 'mppx';
import {Authority as PrincipalAuthority} from '../p1/authority.mjs';
import {hash,requireThat,nearForNanoUsd,nanoUsdForNear,paymentExposure,chooseQuote} from '../contract.mjs';
import {SPONSORED,principalRequest} from '../p1/sponsored.mjs';
import {TOOL} from './tool-schema.mjs';
export class Authority extends PrincipalAuthority {
  async ensureCall(agent,taskId,key,raw,context){
    return this.transaction(agent.user_id,async db=>{
      const live=(await db.query('SELECT * FROM mpp_direct_p2_sessions WHERE task_id=$1 AND user_id=$2 FOR SHARE',[taskId,agent.user_id])).rows[0];
      requireThat(live&&live.state==='running'&&live.writer_hash===hash(String(context.headers['x-p2-writer']??''))&&String(live.generation)===context.headers['x-p2-generation']
        &&Number(live.writer_until_ms)>Date.now(),'writer_fenced');
      const old=(await db.query('SELECT * FROM mpp_direct_p2_calls WHERE user_id=$1 AND logical_key=$2 FOR UPDATE',[agent.user_id,key])).rows[0];
      if(old){requireThat(old.task_id===taskId&&old.body_hash===hash(raw),'logical_call_conflict');return old;}
      const task=(await db.query('SELECT * FROM mpp_direct_tasks WHERE id=$1 AND user_id=$2 FOR UPDATE',[taskId,agent.user_id])).rows[0];
      const session=(await db.query('SELECT * FROM mpp_direct_p2_sessions WHERE task_id=$1 AND user_id=$2 FOR SHARE',[taskId,agent.user_id])).rows[0];
      requireThat(task?.active&&!task.paused&&session,'task_not_running');
      const count=Number((await db.query('SELECT count(*) FROM mpp_direct_p2_calls WHERE session_id=$1',[session.id])).rows[0].count);
      requireThat(count<4,'model_round_limit');
      const previous=(await db.query('SELECT progress_version FROM mpp_direct_p2_calls WHERE session_id=$1 ORDER BY started_ms DESC,id DESC LIMIT 1',[session.id])).rows[0];
      requireThat(!previous||BigInt(session.workspace_version)>BigInt(previous.progress_version),'uncommitted_tool_progress');
      const now=Number((await db.query('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS n')).rows[0].n);
      requireThat(now<Number(task.deadline_ms),'task_authorization_expired');
      const bid=BigInt(task.hard_bid_nano)/(task.preference==='save'?4n:task.preference==='balanced'?2n:1n);
      const id=hash([agent.user_id,key]);
      await db.query(`INSERT INTO mpp_direct_p2_calls(id,user_id,session_id,task_id,logical_key,original_body,body_hash,started_ms,deadline_ms,max_wait_ms,preference,bid_nano,progress_version)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,[id,agent.user_id,session.id,taskId,key,raw,hash(raw),now,task.deadline_ms,task.max_wait_ms,task.preference,String(bid||1n),session.workspace_version]);
      await db.query("INSERT INTO mpp_direct_p2_revisions VALUES($1,0,'initial',$2,$3)",[id,{bidNano:String(bid||1n),preference:task.preference,policy:'cost-speed-p2-v1'},now]);
      return (await db.query('SELECT * FROM mpp_direct_p2_calls WHERE id=$1',[id])).rows[0];
    });
  }
  async decide(db,{call,task,quote,available,supply,nowMs,expires}){
    const market=(await db.query('SELECT * FROM mpp_direct_p2_market WHERE singleton FOR SHARE')).rows[0];
    const max=BigInt(quote.total_micro)*1000n;
    let decision;
    if(nowMs>=Number(call.deadline_ms)||nowMs-Number(call.started_ms)>=Number(call.max_wait_ms))decision={action:'stop',reason:'original_deadline_or_wait_limit'};
    else if(BigInt(task.budget_nano)-BigInt(task.spent_nano)<max)decision={action:'stop',reason:'hard_task_budget_exhausted'};
    else{
      const urgent=Number(call.deadline_ms)-nowMs<=4*(this.config.paymentEstimateMs+Number(market.usable_ms)+100)
        ||nowMs-Number(call.started_ms)>=Math.floor(Number(call.max_wait_ms)/2);
      if(!call.manual&&BigInt(call.bid_nano)<max&&(urgent||call.preference==='fast')&&max<=BigInt(task.hard_bid_nano)){
        await db.query('UPDATE mpp_direct_p2_calls SET bid_nano=$2,revision=revision+1 WHERE id=$1',[call.id,String(max)]);
        call=(await db.query('SELECT * FROM mpp_direct_p2_calls WHERE id=$1',[call.id])).rows[0];
        await db.query("INSERT INTO mpp_direct_p2_revisions VALUES($1,$2,'auto',$3,$4)",[call.id,call.revision,{bidNano:String(max),reason:'urgency_accept_existing_service',policy:'cost-speed-p2-v1'},nowMs]);
      }
      decision=chooseQuote({nowMs,startedAtMs:Number(call.started_ms),deadlineMs:Number(call.deadline_ms),maxWaitMs:Number(call.max_wait_ms),preference:call.preference,
        availableNano:String(available),hardBidNano:call.bid_nano,paymentMs:this.config.paymentEstimateMs,admissionMs:50,deliveryMs:50,
        quotes:supply&&market.available?[{id:'controlled-native',observedAtMs:Number(market.observed_ms),expiresAtMs:expires,usableMs:Number(market.usable_ms),scopeMatches:true,
          estimateKind:'p95',serviceMaximumNano:String(max),expectedServiceNano:String(BigInt(quote.input_tokens+550+quote.platform_micro)*1000n),routeMaximumNano:'0',riskNano:'0'}]:[]});
      if(decision.action==='wait')decision.reason=!supply||!market.available?'supply_unavailable':available<max?'unsettled_or_budget_reserve':call.manual?'manual_bid_wait':decision.reason;
    }
    const snapshot={policy:'cost-speed-p2-v1',nowMs,startedAtMs:Number(call.started_ms),deadlineMs:Number(call.deadline_ms),preference:call.preference,
      bidNano:call.bid_nano,availableNano:String(available),futureReserveBps:2500,quote,forecast:market,supplyAvailable:supply&&market.available,result:decision};
    await db.query('INSERT INTO mpp_direct_p2_decisions(call_id,revision,snapshot) VALUES($1,$2,$3)',[call.id,call.revision,snapshot]);
    await db.query("UPDATE mpp_direct_p2_calls SET decision=$2,state=CASE WHEN $3 THEN 'stopped' ELSE state END,next_tick_ms=$4 WHERE id=$1",[call.id,snapshot,decision.action==='stop',nowMs+100]);
    if(decision.action==='stop')return {waiting:true,callId:call.id,closed:true,reason:decision.reason};
    return decision.action==='accept'?{call,decision,snapshot}:{waiting:true,callId:call.id,revision:call.revision,reason:decision.reason};
  }
  async refreshBeforeAdmission(o){
    if(!o.admitted_request){
      const c=(await this.pool.query('SELECT c.*,t.paused,s.state AS session_state FROM mpp_direct_p2_calls c JOIN mpp_direct_tasks t ON t.id=c.task_id JOIN mpp_direct_p2_sessions s ON s.id=c.session_id WHERE c.id=$1',[o.call_id])).rows[0];
      if(c&&(c.state==='cancelled'||c.paused||['paused','error','complete'].includes(c.session_state))){
        const response=await fetch(this.config.walletFixtureUrl+'/wallet/cancel',{method:'POST',headers:{'content-type':'application/json','x-fixture-key':this.config.buyerWalletKey},body:JSON.stringify({orderRef:o.id}),signal:AbortSignal.timeout(2500)});
        requireThat(response.ok,'original_wallet_outcome_unknown');await super.cancel(o,await response.json());
        return this.getOrder(o.id,o.user_id);
      }
    }
    return super.refreshBeforeAdmission(o);
  }
  async prepare(agent, taskId, key, rawBody, context) {
    requireThat(/^[a-zA-Z0-9_-]{1,96}$/.test(key), 'invalid_idempotency_key');
    const body = JSON.parse(rawBody);
    requireThat(body && typeof body === 'object' && !Array.isArray(body)
      && Object.keys(body).every(k => ['model','messages','max_completion_tokens','max_tokens','stream','stream_options','temperature','top_p','tools','tool_choice','parallel_tool_calls'].includes(k)), 'unsupported_p2_native_scope');
    requireThat(body.stream === undefined || typeof body.stream === 'boolean', 'invalid_stream');
    if(body.stream_options!==undefined)requireThat(body.stream_options!==null&&typeof body.stream_options==='object'&&!Array.isArray(body.stream_options)
      &&Object.keys(body.stream_options).every(k=>k==='include_usage')&&(body.stream_options.include_usage===undefined||typeof body.stream_options.include_usage==='boolean'),'unsupported_stream_options');
    requireThat(body.model==='m/external'&&(body.max_completion_tokens??body.max_tokens)===64,'unsupported_output_scope');
    if(body.tools)requireThat(Array.isArray(body.tools)&&body.tools.length<=1&&body.tools.every(t=>t.type==='function'&&t.function?.name==='bash'&&hash(t.function.parameters)===hash(TOOL.inputSchema)),'unsupported_tool_scope');
    const call=await this.ensureCall(agent,taskId,key,rawBody,context);
    if(['cancelled','stopped'].includes(call.state))throw new Error('call_closed');
    const internal = { ...body,max_completion_tokens:64,user:'p2-'+call.id,stream:true,background:true,stream_options:{ include_usage:true },bitrouter_delivery:{ auto_fallback:'off' } };
    delete internal.max_tokens;
    const prior=call.order_id?(await this.getOrder(call.order_id,agent.user_id)):null;
    if(prior){requireThat(prior.body_hash===hash(rawBody)&&prior.task_id===taskId,'logical_call_conflict');
      const op=(await this.pool.query('SELECT state FROM mpp_direct_sponsor_operations WHERE id=$1',[prior.sponsor_operation])).rows[0];
      if(prior.state==='cancelled'&&op?.state==='never_sent'){
        await this.transaction(agent.user_id,async db=>{
          const current=(await db.query('SELECT * FROM mpp_direct_p2_calls WHERE id=$1 FOR UPDATE',[call.id])).rows[0];
          requireThat(current.state!=='cancelled'&&current.order_id===prior.id,'call_closed');
          const reopened=(await db.query("UPDATE mpp_direct_p2_calls SET order_id=NULL,state='bidding',revision=revision+1 WHERE id=$1 RETURNING revision",[call.id])).rows[0];
          await db.query("INSERT INTO mpp_direct_p2_revisions VALUES($1,$2,'recovery',$3,$4)",[call.id,reopened.revision,{reason:'sealed_original_never_sent',originalOrder:prior.id},Date.now()]);
        });
        return this.prepare(agent,taskId,key,rawBody,context);
      }
      return prior;}
    let quote;try{quote=JSON.parse(execFileSync(this.config.hostBinary,['quote-native-p2','-'], { input:JSON.stringify(internal),encoding:'utf8',
      env:{...process.env,PRIVATE_MARKET_NEAR_DIRECT_P1:'controlled',PRIVATE_MARKET_AGENT_P2:'controlled'},timeout:15_000,maxBuffer:1024*1024 }));}catch{throw new Error('native_scope_not_qualified');}
    return this.transaction(agent.user_id, async db => {
      const nowMs = Number((await db.query('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS now')).rows[0].now);
      let current=(await db.query('SELECT * FROM mpp_direct_p2_calls WHERE id=$1 FOR UPDATE',[call.id])).rows[0];
      const existing=current.order_id?(await db.query('SELECT * FROM mpp_direct_orders WHERE id=$1',[current.order_id])).rows[0]:null;
      if (existing) { requireThat(existing.body_hash === hash(rawBody) && existing.task_id === taskId, 'logical_call_conflict'); return existing; }
      requireThat(current.state==='bidding','call_closed');
      const task = (await db.query('SELECT * FROM mpp_direct_tasks WHERE id=$1 AND user_id=$2 FOR UPDATE',[taskId,agent.user_id])).rows[0];
      requireThat(task?.active && !task.paused && Number(task.deadline_ms)>nowMs, 'task_authorization_expired');
      const cap = (await db.query('SELECT * FROM mpp_direct_capacity WHERE id=1 FOR UPDATE')).rows[0];
      if (cap.lease_order && Number(cap.lease_until_ms)<=nowMs) await db.query('UPDATE mpp_direct_capacity SET lease_order=NULL,lease_until_ms=NULL WHERE id=1');
      const supply=cap.admissions<cap.max_admissions&&(!cap.lease_order||Number(cap.lease_until_ms)<=nowMs);
      const serviceNano = BigInt(quote.total_micro)*1000n, p = String(nearForNanoUsd(String(serviceNano),this.config.rateNanoPerNear));
      const expires = Math.min(nowMs+this.config.paymentWindowMs, Number(task.deadline_ms)-this.config.estimatedTerminalMs-2000);
      requireThat(expires>nowMs+this.config.paymentEstimateMs, 'insufficient_payment_window');
      const id = hash(randomUUID()), nativeId = randomUUID(), dispatchKey = 'near-native-'+id;
      let termsHash = hash({quote,internalHash:hash(JSON.stringify(internal)),task:task.id,taskRevision:task.revision,rate:this.config.rateNanoPerNear,expires,
        bidRevision:current.revision,callId:current.id,policyVersion:'cost-speed-p2-v1',forecastMs:this.config.estimatedTerminalMs,forecastSource:'controlled-fixture',gasSponsor:this.config.gasSponsor});
      const sponsorOperation=hash(['project-gas-payment',id]);
      const request = {version:2,network:this.config.network,currency:'NEAR',decimals:24,amount:p,recipient:this.config.merchant,payer:agent.payer,
        refundTo:agent.payer,bindingVersion:agent.binding_version,orderRef:id,termsHash,nativeRequestHash:hash(rawBody),
        nonce:randomBytes(32).toString('base64'),issuedAtMs:nowMs,expiresAtMs:expires,signingRecipient:this.config.realm,
        gasSponsor:this.config.gasSponsor,sponsorOperation};
      const ownAvailable=BigInt(task.budget_nano)-BigInt(task.reserved_nano)-BigInt(task.spent_nano);
      const parent=(await db.query('SELECT * FROM mpp_direct_p2_agent_limits WHERE user_id=$1 FOR UPDATE',[agent.user_id])).rows[0];
      const parentAvailable=BigInt(parent.budget_nano)-BigInt(parent.reserved_nano)-BigInt(parent.spent_nano);
      const available=ownAvailable<parentAvailable?ownAvailable:parentAvailable;
      const chosen=await this.decide(db,{call:current,task,quote,available,supply,nowMs,expires});
      if(chosen.waiting)return chosen;current=chosen.call;
      termsHash=hash([termsHash,String(current.revision),hash(JSON.stringify(chosen.snapshot))]);request.termsHash=termsHash;
      const nativeBalance = await this.nativeBalance(agent,nowMs,db);
      const exposure = paymentExposure({request:principalRequest(request),gasCapYocto:'0',nanoUsdPerNear:this.config.rateNanoPerNear,
        bidNano:current.bid_nano,serviceCapNano:task.hard_bid_nano,callCapNano:task.call_cap_nano,taskRemainingNano:String(available),
        nativeBalance,nowMs,gasFloorYocto:'0'});
      const project=(await db.query('SELECT * FROM mpp_direct_project_budget WHERE id=1 FOR UPDATE')).rows[0];
      requireThat(project?.active&&BigInt(project.reserved_yocto)+BigInt(project.spent_yocto)+BigInt(this.config.gasEstimateYocto)<=BigInt(project.budget_yocto),'project_sponsorship_unavailable');
      const sponsorBalance=await this.rpc.call('query',{request_type:'view_account',finality:'final',account_id:this.config.gasSponsor});
      requireThat(BigInt(sponsorBalance.amount)-BigInt(sponsorBalance.locked)-BigInt(sponsorBalance.storage_usage)*BigInt(this.config.storagePriceYocto)
        >=BigInt(project.reserved_yocto)+BigInt(this.config.gasEstimateYocto),'project_gas_unfunded');
      const decision=chosen.decision;
      const challenge = Challenge.from({secretKey:this.config.secret,realm:this.config.realm,method:SPONSORED,intent:'charge',request,
        expires:new Date(expires).toISOString(),header:'Payment-Authorization'});
      const header = Challenge.serialize(challenge);
      await db.query(`UPDATE mpp_direct_tasks SET reserved_nano=reserved_nano+$2 WHERE id=$1`,[taskId,exposure.reserveNano]);
      await db.query(`INSERT INTO mpp_direct_orders(id,user_id,task_id,logical_key,body_hash,original_body,internal_body,native_id,dispatch_key,terms_hash,challenge,challenge_header,
        task_revision,binding_version,expires_ms,admission_before_ms,provider_cap_micro,service_micro,rate_nano_per_near,reserve_nano,project_estimate_yocto,p,created_ms,sponsor_operation,expected_purchase,decision,call_id,bid_revision)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)`,
      [id,agent.user_id,taskId,'p2-order-'+current.id+'-'+current.revision,hash(rawBody),rawBody,internal,nativeId,dispatchKey,termsHash,challenge,header,task.revision,agent.binding_version,
        expires,quote.provider_micro,quote.total_micro,this.config.rateNanoPerNear,exposure.reserveNano,this.config.gasEstimateYocto,p,nowMs,sponsorOperation,quote.expected_purchase,
        {result:decision,quote,forecast:chosen.snapshot.forecast,buyerRouteFeeNano:'0',projectEstimateYocto:this.config.gasEstimateYocto},current.id,current.revision]);
      await db.query("INSERT INTO mpp_direct_timing(order_id,stage) VALUES($1,'quote_prepared')",[id]);
      await db.query('INSERT INTO mpp_direct_sponsor_operations(id,order_id,kind,fee_payer,estimate_yocto,state) VALUES($1,$2,\'payment\',$3,$4,\'authorized\')',[sponsorOperation,id,this.config.gasSponsor,this.config.gasEstimateYocto]);
      await db.query('UPDATE mpp_direct_project_budget SET reserved_yocto=reserved_yocto+$1 WHERE id=1',[this.config.gasEstimateYocto]);
      await db.query('UPDATE mpp_direct_capacity SET lease_order=$1,lease_until_ms=$2 WHERE id=1',[id,expires+this.config.leaseTailMs]);
      await db.query("UPDATE mpp_direct_p2_calls SET order_id=$2,state='quoted' WHERE id=$1",[current.id,id]);
      return (await db.query('SELECT * FROM mpp_direct_orders WHERE id=$1',[id])).rows[0];
    });
  }
}
