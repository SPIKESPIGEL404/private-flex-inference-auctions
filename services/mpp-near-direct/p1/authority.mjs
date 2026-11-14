import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Challenge, Credential } from 'mppx';
import { hash, challengeIdentity, nearForNanoUsd, nanoUsdForNear, paymentExposure, chooseQuote, requireThat } from '../contract.mjs';
import { refundPlan, verifyRefund } from '../near.mjs';
import { SPONSORED, principalRequest, verifySponsored } from './sponsored.mjs';

import { createHash } from 'node:crypto';
const mutationId = ledger => 'rbm_v2_' + createHash('sha256').update(Buffer.concat([Buffer.from('bitrouter:redis-balance-mutation:v2\0'), Buffer.from(ledger)])).digest('hex');
export class Authority {
  constructor({ pool, rpc, config }) { Object.assign(this, { pool, rpc, config }); }
  async pin() {
    const { secret,databaseUrl,walletFixtureKey,buyerWalletKey,faultControlKey,...publicConfig } = this.config;
    const fingerprint = hash({ ...publicConfig, secretHash: hash(secret),databaseHash:hash(databaseUrl),merchantKeyHash:hash(walletFixtureKey),buyerKeyHash:hash(buyerWalletKey),controlKeyHash:hash(faultControlKey) });
    const db = await this.pool.connect();
    try {
      await db.query(`INSERT INTO mpp_direct_configuration(fingerprint,configuration,mode) VALUES($1,$2,'controlled') ON CONFLICT DO NOTHING`, [fingerprint, publicConfig]);
      const row = (await db.query('SELECT fingerprint FROM mpp_direct_configuration')).rows[0];
      requireThat(row?.fingerprint === fingerprint, 'payment_configuration_changed');
    } finally { db.release(); }
  }
  async transaction(user, fn) {
    const db = await this.pool.connect();
    let failed=false;const connectionError=()=>{};db.on('error',connectionError);
    try {
      await db.query('BEGIN');
      await db.query('SELECT pg_advisory_xact_lock(public.balance_cache_advisory_key($1))', [user]);
      const result = await fn(db); await db.query('COMMIT'); return result;
    } catch (e) { failed=true;await db.query('ROLLBACK').catch(() => {}); throw e; }
    finally { db.removeListener('error',connectionError);db.release(failed); }
  }
  async authenticate(token) {
    const row = (await this.pool.query('SELECT * FROM mpp_direct_agents WHERE token_hash=$1 AND active', [hash(token)])).rows[0];
    requireThat(row, 'unauthorized'); return row;
  }
  async getOrder(id, user) { return (await this.pool.query(`SELECT o.*,coalesce((SELECT jsonb_agg(jsonb_build_object('amount',amount::text,'reason',reason,'refunded',refunded)) FROM mpp_direct_anomalies a WHERE a.order_id=o.id),'[]'::jsonb) AS anomalies,
    coalesce((SELECT jsonb_agg(jsonb_build_object('stage',stage,'atMs',at_ms,'clock',clock_source) ORDER BY at_ms,stage) FROM mpp_direct_timing t WHERE t.order_id=o.id),'[]'::jsonb) AS timings FROM mpp_direct_orders o WHERE id=$1 AND user_id=$2`, [id,user])).rows[0]; }
  async timing(id,stage){await this.pool.query('INSERT INTO mpp_direct_timing(order_id,stage) VALUES($1,$2) ON CONFLICT DO NOTHING',[id,stage]);}
  async refreshBeforeAdmission(o) {
    return this.transaction(o.user_id,async db=>{
      const row=(await db.query('SELECT * FROM mpp_direct_orders WHERE id=$1 FOR UPDATE',[o.id])).rows[0];
      const context=(await db.query(`SELECT t.active AND a.active AND t.revision=o.task_revision AND a.binding_version=o.binding_version
        AND floor(extract(epoch FROM clock_timestamp())*1000)<least(t.deadline_ms,o.admission_before_ms,c.lease_until_ms)
        AND c.lease_order=o.id AS eligible FROM mpp_direct_orders o JOIN mpp_direct_tasks t ON t.id=o.task_id
        JOIN mpp_direct_agents a ON a.user_id=o.user_id CROSS JOIN mpp_direct_capacity c WHERE o.id=$1`,[o.id])).rows[0];
      if(row.received&&!row.admitted_request&&context.eligible!==true){
        await db.query("UPDATE mpp_direct_orders SET state='refund_due',h=0,w=p WHERE id=$1",[o.id]);
        await db.query('UPDATE mpp_direct_capacity SET lease_order=NULL,lease_until_ms=NULL WHERE lease_order=$1',[o.id]);
      }
      return (await db.query('SELECT * FROM mpp_direct_orders WHERE id=$1',[o.id])).rows[0];
    });
  }
  async nativeBalance(agent, nowMs, db) {
    const status = await this.rpc.call('status', []); requireThat(status.chain_id === this.config.network, 'network_mismatch');
    const b = await this.rpc.call('query', { request_type:'view_account', finality:'final', account_id:agent.payer });
    // Controlled P1 only: conservative subtraction, including storage and stake.
    const available = BigInt(b.amount) - BigInt(b.locked) - BigInt(b.storage_usage) * BigInt(this.config.storagePriceYocto);
    requireThat(available >= 0n, 'native_storage_or_balance_insufficient');
    const held = (await db.query(`SELECT coalesce(sum(p),0)::text AS amount FROM mpp_direct_orders o WHERE user_id=$1 AND NOT received AND state NOT IN('refunded','settled')
      AND NOT EXISTS(SELECT FROM mpp_direct_sponsor_operations s WHERE s.id=o.sponsor_operation AND s.state='never_sent')
      AND NOT EXISTS(SELECT FROM mpp_direct_anomalies a WHERE a.order_id=o.id AND a.refunded)`, [agent.user_id])).rows[0].amount;
    return { source:'near-rpc-view-account',ledger:'NEAR_CHAIN',asset:'native:NEAR',decimals:24,finality:'final',network:this.config.network,
      accountId:agent.payer,blockHash:b.block_hash,observedAtMs:nowMs,availableAfterStorageYocto:String(available),reservedYocto:held };
  }
  async prepare(agent, taskId, key, rawBody) {
    requireThat(/^[a-zA-Z0-9_-]{1,96}$/.test(key), 'invalid_idempotency_key');
    const body = JSON.parse(rawBody);
    requireThat(body && typeof body === 'object' && !Array.isArray(body)
      && Object.keys(body).every(k => ['model','messages','max_completion_tokens','stream','stream_options','temperature','top_p'].includes(k)), 'unsupported_p1_native_scope');
    requireThat(body.stream === undefined || typeof body.stream === 'boolean', 'invalid_stream');
    if(body.stream_options!==undefined)requireThat(body.stream_options!==null&&typeof body.stream_options==='object'&&!Array.isArray(body.stream_options)
      &&Object.keys(body.stream_options).every(k=>k==='include_usage')&&(body.stream_options.include_usage===undefined||typeof body.stream_options.include_usage==='boolean'),'unsupported_stream_options');
    const internal = { ...body,stream:true,background:true,stream_options:{ include_usage:true },bitrouter_delivery:{ auto_fallback:'off' } };
    const prior=(await this.pool.query('SELECT * FROM mpp_direct_orders WHERE user_id=$1 AND logical_key=$2',[agent.user_id,key])).rows[0];
    if(prior){requireThat(prior.body_hash===hash(rawBody)&&prior.task_id===taskId,'logical_call_conflict');return prior;}
    let quote;try{quote=JSON.parse(execFileSync(this.config.hostBinary,['quote-native-p1','-'], { input:JSON.stringify(internal),encoding:'utf8',
      env:{...process.env,PRIVATE_MARKET_NEAR_DIRECT_P1:'controlled'},timeout:15_000,maxBuffer:1024*1024 }));}catch{throw new Error('native_scope_not_qualified');}
    return this.transaction(agent.user_id, async db => {
      const nowMs = Number((await db.query('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS now')).rows[0].now);
      const existing = (await db.query('SELECT * FROM mpp_direct_orders WHERE user_id=$1 AND logical_key=$2 FOR UPDATE',[agent.user_id,key])).rows[0];
      if (existing) { requireThat(existing.body_hash === hash(rawBody) && existing.task_id === taskId, 'logical_call_conflict'); return existing; }
      const task = (await db.query('SELECT * FROM mpp_direct_tasks WHERE id=$1 AND user_id=$2 FOR UPDATE',[taskId,agent.user_id])).rows[0];
      requireThat(task?.active && Number(task.deadline_ms)>nowMs, 'task_authorization_expired');
      const cap = (await db.query('SELECT * FROM mpp_direct_capacity WHERE id=1 FOR UPDATE')).rows[0];
      if (cap.lease_order && Number(cap.lease_until_ms)<=nowMs) await db.query('UPDATE mpp_direct_capacity SET lease_order=NULL,lease_until_ms=NULL WHERE id=1');
      requireThat(cap.admissions < cap.max_admissions && (!cap.lease_order || Number(cap.lease_until_ms)<=nowMs), 'supply_unavailable');
      const serviceNano = BigInt(quote.total_micro)*1000n, p = String(nearForNanoUsd(String(serviceNano),this.config.rateNanoPerNear));
      const expires = Math.min(nowMs+this.config.paymentWindowMs, Number(task.deadline_ms)-this.config.estimatedTerminalMs-2000);
      requireThat(expires>nowMs+this.config.paymentEstimateMs, 'insufficient_payment_window');
      const id = hash(randomUUID()), nativeId = randomUUID(), dispatchKey = 'near-native-'+id;
      const termsHash = hash({quote,internalHash:hash(JSON.stringify(internal)),task:task.id,taskRevision:task.revision,rate:this.config.rateNanoPerNear,expires,
        policyVersion:'cost-speed-v1',forecastMs:this.config.estimatedTerminalMs,forecastSource:'controlled-fixture',gasSponsor:this.config.gasSponsor});
      const sponsorOperation=hash(['project-gas-payment',id]);
      const request = {version:2,network:this.config.network,currency:'NEAR',decimals:24,amount:p,recipient:this.config.merchant,payer:agent.payer,
        refundTo:agent.payer,bindingVersion:agent.binding_version,orderRef:id,termsHash,nativeRequestHash:hash(rawBody),
        nonce:randomBytes(32).toString('base64'),issuedAtMs:nowMs,expiresAtMs:expires,signingRecipient:this.config.realm,
        gasSponsor:this.config.gasSponsor,sponsorOperation};
      const available = BigInt(task.budget_nano)-BigInt(task.reserved_nano)-BigInt(task.spent_nano);
      const nativeBalance = await this.nativeBalance(agent,nowMs,db);
      const exposure = paymentExposure({request:principalRequest(request),gasCapYocto:'0',nanoUsdPerNear:this.config.rateNanoPerNear,
        bidNano:task.hard_bid_nano,serviceCapNano:task.hard_bid_nano,callCapNano:task.call_cap_nano,taskRemainingNano:String(available),
        nativeBalance,nowMs,gasFloorYocto:'0'});
      const project=(await db.query('SELECT * FROM mpp_direct_project_budget WHERE id=1 FOR UPDATE')).rows[0];
      requireThat(project?.active&&BigInt(project.reserved_yocto)+BigInt(project.spent_yocto)+BigInt(this.config.gasEstimateYocto)<=BigInt(project.budget_yocto),'project_sponsorship_unavailable');
      const sponsorBalance=await this.rpc.call('query',{request_type:'view_account',finality:'final',account_id:this.config.gasSponsor});
      requireThat(BigInt(sponsorBalance.amount)-BigInt(sponsorBalance.locked)-BigInt(sponsorBalance.storage_usage)*BigInt(this.config.storagePriceYocto)
        >=BigInt(project.reserved_yocto)+BigInt(this.config.gasEstimateYocto),'project_gas_unfunded');
      const decision = chooseQuote({nowMs,startedAtMs:nowMs,deadlineMs:Number(task.deadline_ms),maxWaitMs:60_000,preference:'balanced',availableNano:String(available),
        hardBidNano:task.hard_bid_nano,paymentMs:this.config.paymentEstimateMs,admissionMs:50,deliveryMs:50,
        quotes:[{id:'controlled-native',observedAtMs:nowMs,expiresAtMs:expires,usableMs:this.config.estimatedTerminalMs,scopeMatches:true,estimateKind:'p95',
          serviceMaximumNano:String(nanoUsdForNear(p,this.config.rateNanoPerNear)),expectedServiceNano:String(serviceNano),routeMaximumNano:'0',riskNano:'0'}]});
      requireThat(decision.action==='accept','budget_or_speed_constraints');
      const challenge = Challenge.from({secretKey:this.config.secret,realm:this.config.realm,method:SPONSORED,intent:'charge',request,
        expires:new Date(expires).toISOString(),header:'Payment-Authorization'});
      const header = Challenge.serialize(challenge);
      await db.query(`UPDATE mpp_direct_tasks SET reserved_nano=reserved_nano+$2 WHERE id=$1`,[taskId,exposure.reserveNano]);
      await db.query(`INSERT INTO mpp_direct_orders(id,user_id,task_id,logical_key,body_hash,original_body,internal_body,native_id,dispatch_key,terms_hash,challenge,challenge_header,
        task_revision,binding_version,expires_ms,admission_before_ms,provider_cap_micro,service_micro,rate_nano_per_near,reserve_nano,project_estimate_yocto,p,created_ms,sponsor_operation,expected_purchase,decision)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)`,
      [id,agent.user_id,taskId,key,hash(rawBody),rawBody,internal,nativeId,dispatchKey,termsHash,challenge,header,task.revision,agent.binding_version,
        expires,quote.provider_micro,quote.total_micro,this.config.rateNanoPerNear,exposure.reserveNano,this.config.gasEstimateYocto,p,nowMs,sponsorOperation,quote.expected_purchase,
        {result:decision,quote,forecast:{usableMs:this.config.estimatedTerminalMs,source:'controlled-fixture',observedAtMs:nowMs},buyerRouteFeeNano:'0',projectEstimateYocto:this.config.gasEstimateYocto}]);
      await db.query("INSERT INTO mpp_direct_timing(order_id,stage) VALUES($1,'quote_prepared')",[id]);
      await db.query('INSERT INTO mpp_direct_sponsor_operations(id,order_id,kind,fee_payer,estimate_yocto,state) VALUES($1,$2,\'payment\',$3,$4,\'authorized\')',[sponsorOperation,id,this.config.gasSponsor,this.config.gasEstimateYocto]);
      await db.query('UPDATE mpp_direct_project_budget SET reserved_yocto=reserved_yocto+$1 WHERE id=1',[this.config.gasEstimateYocto]);
      await db.query('UPDATE mpp_direct_capacity SET lease_order=$1,lease_until_ms=$2 WHERE id=1',[id,expires+this.config.leaseTailMs]);
      return (await db.query('SELECT * FROM mpp_direct_orders WHERE id=$1',[id])).rows[0];
    });
  }
  async loadChallenge(id) { return (await this.pool.query("SELECT challenge FROM mpp_direct_orders WHERE challenge->>'id'=$1",[id])).rows[0]?.challenge; }
  async originalOperation(order) {
    const response=await fetch(this.config.walletFixtureUrl+'/wallet/status',{method:'POST',redirect:'error',signal:AbortSignal.timeout(2500),
      headers:{'content-type':'application/json','x-fixture-key':this.config.buyerWalletKey},body:JSON.stringify({orderRef:order.id})});
    requireThat(response.ok,'original_sponsor_operation_unknown');const original=await response.json();
    requireThat(original.orderRef===order.id&&original.operationKey==='near-pay-v2-'+order.id&&original.credential,'original_sponsor_operation_unknown');
    const credential=Credential.deserialize(original.credential);
    requireThat(challengeIdentity(credential.challenge)===challengeIdentity(order.challenge)&&credential.payload.txHash===original.txHash,'original_sponsor_operation_conflict');
    return {...original,credential};
  }
  async journalPresentation(credential) {
    const id = credential.challenge.request.orderRef;
    const row = (await this.pool.query('SELECT challenge FROM mpp_direct_orders WHERE id=$1',[id])).rows[0];
    requireThat(row, 'unknown_order');
    requireThat(challengeIdentity(credential.challenge)===challengeIdentity(row.challenge),'sponsored_challenge_mismatch');
    await this.pool.query('INSERT INTO mpp_direct_presentations(order_id,credential_hash,credential) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[id,hash(credential),Credential.serialize(credential)]);
    await this.timing(id,'proof_presented');
    await this.pool.query("UPDATE mpp_direct_orders SET state='payment_unknown' WHERE id=$1 AND state='quoted'",[id]);
  }
  async consumeVerifiedPayment(v) {
    const original = (await this.pool.query('SELECT * FROM mpp_direct_orders WHERE id=$1',[v.orderRef])).rows[0]; requireThat(original,'unknown_order');
    // The wallet associates the original sponsor operation with its transaction;
    // independent RPC verification remains the authority for money and finality.
    const wallet=await this.originalOperation(original);
    requireThat(wallet.txHash===v.txHash,'original_sponsor_operation_conflict');
    return this.transaction(original.user_id,async db => {
      const o = (await db.query('SELECT * FROM mpp_direct_orders WHERE id=$1 FOR UPDATE',[v.orderRef])).rows[0];
      requireThat(v.payer===o.challenge.request.payer && v.recipient===o.challenge.request.recipient
        &&v.gasSponsor===this.config.gasSponsor&&v.sponsorOperation===o.sponsor_operation,'verified_payment_binding_mismatch');
      if(v.failed){
        requireThat(v.nonceConsumed,'failed_principal_not_closed');
        const identity='failed-native:'+v.network+':'+v.txHash;
        const old=(await db.query('SELECT order_id FROM mpp_direct_anomalies WHERE identity=$1',[identity])).rows[0];
        if(old){requireThat(old.order_id===o.id,'failed_transaction_already_assigned');return {committed:true,projectionReady:false,orderRef:o.id};}
        await this.finalizeProjectGas(db,o.sponsor_operation,v.gasActualYocto,v);
        await db.query("INSERT INTO mpp_direct_anomalies(identity,order_id,reason,evidence,amount,refunded) VALUES($1,$2,'failed_delegate_zero_principal',$3,0,true)",[identity,o.id,v]);
        await db.query('UPDATE mpp_direct_tasks SET reserved_nano=reserved_nano-$2 WHERE id=$1',[o.task_id,o.reserve_nano]);
        await db.query("UPDATE mpp_direct_orders SET state='cancelled' WHERE id=$1",[o.id]);
        await db.query('UPDATE mpp_direct_capacity SET lease_order=NULL,lease_until_ms=NULL WHERE lease_order=$1',[o.id]);
        return {committed:true,projectionReady:false,orderRef:o.id};
      }
      const used = (await db.query('SELECT * FROM mpp_direct_movements WHERE identity=$1',[v.movementKey])).rows[0];
      if (used) requireThat(used.order_id===o.id && used.purpose==='payment','movement_already_consumed');
      if (!used) {
        const task = (await db.query('SELECT * FROM mpp_direct_tasks WHERE id=$1 FOR UPDATE',[o.task_id])).rows[0];
        const cap = (await db.query('SELECT * FROM mpp_direct_capacity WHERE id=1 FOR UPDATE')).rows[0];
        const now = Number((await db.query('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS n')).rows[0].n);
        const admissible = v.amount===o.p&&!v.late && now<Number(o.admission_before_ms) && task.active && task.revision===o.task_revision
          && o.state!=='cancelled' && cap.lease_order===o.id && now<Number(cap.lease_until_ms);
        await db.query('INSERT INTO mpp_direct_movements(identity,order_id,purpose,operation_id,proof) VALUES($1,$2,\'payment\',$3,$4)',[v.movementKey,o.id,'pay-'+o.id,v]);
        await this.finalizeProjectGas(db,o.sponsor_operation,v.gasActualYocto,v);
        if(v.amount!==o.p){
          await db.query('INSERT INTO mpp_direct_anomalies(identity,order_id,reason,evidence,amount) VALUES($1,$2,\'native_amount_mismatch\',$3,$4)',[v.movementKey,o.id,v,v.amount]);
          await db.query("UPDATE mpp_direct_orders SET state='exception' WHERE id=$1",[o.id]);
          if(v.amount==='0'){
            await db.query('UPDATE mpp_direct_anomalies SET refunded=true WHERE identity=$1',[v.movementKey]);
            await db.query('UPDATE mpp_direct_tasks SET reserved_nano=reserved_nano-$2 WHERE id=$1',[o.task_id,o.reserve_nano]);
          }
          await db.query('UPDATE mpp_direct_capacity SET lease_order=NULL,lease_until_ms=NULL WHERE lease_order=$1',[o.id]);
          return {committed:true,projectionReady:false,orderRef:o.id};
        }
        if (admissible) {
          const account = (await db.query("SELECT id FROM credit_accounts WHERE user_id=$1 AND currency='USD' FOR UPDATE",[o.user_id])).rows[0];
          const ledger = 'near_pay_'+o.id;
          await db.query(`INSERT INTO credit_ledger_entries(id,credit_account_id,entry_type,amount_micro_usd,currency,idempotency_key,metadata)
            VALUES($1,$2,'purchase',$3,'USD',$1,$4)`,[ledger,account.id,o.service_micro,{source:SPONSORED,method_version:2,order_id:o.id,fx:o.rate_nano_per_near,principal:o.p}]);
          await db.query('UPDATE credit_accounts SET balance_micro_usd=balance_micro_usd+$2 WHERE id=$1',[account.id,o.service_micro]);
          await db.query('INSERT INTO redis_balance_mutations(mutation_id,user_id,ledger_entry_id,signed_delta_micro_usd) VALUES($1,$2,$3,$4)',[mutationId(ledger),o.user_id,ledger,o.service_micro]);
          await db.query("UPDATE mpp_direct_orders SET received=true,h=p,escrow_micro=service_micro,credit_ledger=$2,state='paid' WHERE id=$1",[o.id,ledger]);
        } else {
          await db.query("UPDATE mpp_direct_orders SET received=true,w=p,state='refund_due' WHERE id=$1",[o.id]);
          await db.query('UPDATE mpp_direct_capacity SET lease_order=NULL,lease_until_ms=NULL WHERE lease_order=$1',[o.id]);
        }
      }
      await db.query("INSERT INTO mpp_direct_timing(order_id,stage) VALUES($1,'funds_recorded') ON CONFLICT DO NOTHING",[o.id]);
      const ready = (await db.query(`SELECT o.state,EXISTS(SELECT FROM redis_balance_mutations WHERE ledger_entry_id=o.credit_ledger AND state='applied') AS ready FROM mpp_direct_orders o WHERE o.id=$1`,[o.id])).rows[0];
      return {committed:true,projectionReady:ready.ready && ['paid','admitted','refund_due','refunded','settled'].includes(ready.state),orderRef:o.id};
    });
  }
  async reconcile(order, user) {
    const o = await this.getOrder(order,user); requireThat(o,'unknown_order');
    const journal = (await this.pool.query('SELECT credential FROM mpp_direct_presentations WHERE order_id=$1 ORDER BY created_at DESC LIMIT 1',[order])).rows[0];
    requireThat(journal,'original_payment_unknown');
    // A later invalid public presentation cannot hide the durable original.
    const {credential} = await this.originalOperation(o);
    const v = await verifySponsored({credential,expectedChallenge:o.challenge,rpc:this.rpc,allowMismatch:true,allowFailure:true});
    await this.consumeVerifiedPayment(v); return this.view(await this.getOrder(order,user));
  }
  view(o) { return {id:o.id,state:o.state,nativeId:o.admitted_request,principal:{P:o.received?o.p:'0',C:o.c,H:o.h,W:o.w,R:o.r},
    expectedP:o.p,mode:'controlled',realPayment:false,financial:o.financial,anomalies:o.anomalies??[],timings:o.timings??[],decision:o.decision}; }
  async cancel(o, walletProof) {
    return this.transaction(o.user_id,async db => {
      const row = (await db.query('SELECT * FROM mpp_direct_orders WHERE id=$1 FOR UPDATE',[o.id])).rows[0];
      requireThat(!row.admitted_request,'already_admitted');
      if(['exception','refund_due','refunded','settled'].includes(row.state))return this.view(row);
      if(walletProof?.knownUnsent===true&&!row.received){
        requireThat(walletProof.orderRef===o.id&&walletProof.operationKey==='near-pay-v2-'+o.id,'invalid_unsent_wallet_binding');
        const op=(await db.query('SELECT * FROM mpp_direct_sponsor_operations WHERE id=$1 FOR UPDATE',[row.sponsor_operation])).rows[0];
        if(op.state==='authorized'||op.state==='unknown'){
          await db.query('UPDATE mpp_direct_tasks SET reserved_nano=reserved_nano-$2 WHERE id=$1',[o.task_id,o.reserve_nano]);
          await db.query('UPDATE mpp_direct_project_budget SET reserved_yocto=reserved_yocto-$1 WHERE id=1',[op.estimate_yocto]);
          await db.query("UPDATE mpp_direct_sponsor_operations SET state='never_sent',evidence=$2 WHERE id=$1",[op.id,walletProof]);
        }
      }
      await db.query("UPDATE mpp_direct_orders SET state=CASE WHEN received THEN 'refund_due' ELSE 'cancelled' END,h=0,w=CASE WHEN received THEN p ELSE 0 END WHERE id=$1",[o.id]);
      await db.query('UPDATE mpp_direct_capacity SET lease_order=NULL,lease_until_ms=NULL WHERE lease_order=$1',[o.id]);
      return this.view((await db.query('SELECT * FROM mpp_direct_orders WHERE id=$1',[o.id])).rows[0]);
    });
  }
  async prepareRefund(orderId) {
    const o = (await this.pool.query('SELECT * FROM mpp_direct_orders WHERE id=$1',[orderId])).rows[0];
    const anomaly=(await this.pool.query('SELECT * FROM mpp_direct_anomalies WHERE order_id=$1 AND NOT refunded',[orderId])).rows[0];
    requireThat(o && (BigInt(o.w)>0n||anomaly),'no_refund_due');
    return this.transaction(o.user_id,async db => {
      const row = (await db.query('SELECT * FROM mpp_direct_orders WHERE id=$1 FOR UPDATE',[o.id])).rows[0];
      const old = (await db.query('SELECT * FROM mpp_direct_refunds WHERE order_id=$1',[o.id])).rows[0]; if (old) return old;
      const id = 'refund-'+o.id;
      const amount=anomaly?.amount??row.w;
      const binding={...principalRequest(row.challenge.request),...(anomaly?{amount}: {})};
      const plan = refundPlan({orderRef:o.id,binding,amount,refundableYocto:amount,operationId:id,createdAtMs:Date.now()});
      await this.reserveRefundGas(db,o.id);
      await db.query('INSERT INTO mpp_direct_refunds(id,order_id,plan,plan_hash) VALUES($1,$2,$3,$4)',[id,o.id,plan,hash(plan)]);
      return (await db.query('SELECT * FROM mpp_direct_refunds WHERE id=$1',[id])).rows[0];
    });
  }
  async recordRefundSend(id, originalSend) {
    const r = (await this.pool.query('SELECT * FROM mpp_direct_refunds WHERE id=$1',[id])).rows[0];
    requireThat(r && originalSend.planHash===r.plan_hash && originalSend.operationId===r.plan.operationId
      && originalSend.idempotencyKey===r.plan.idempotencyKey,'refund_operation_conflict');
    const updated = await this.pool.query(`UPDATE mpp_direct_refunds SET original_send=$2,state=CASE WHEN state='confirmed' THEN state ELSE 'unknown' END WHERE id=$1 AND (original_send IS NULL OR original_send=$2::jsonb)`,[id,originalSend]);
    requireThat(updated.rowCount===1,'refund_original_send_conflict');
  }
  async confirmRefund(id, publicKey) {
    const refund = (await this.pool.query('SELECT * FROM mpp_direct_refunds WHERE id=$1',[id])).rows[0]; requireThat(refund,'unknown_refund');
    const proof = await verifyRefund({plan:refund.plan,originalSend:refund.original_send,txHash:refund.original_send?.txHash,publicKey,rpc:this.rpc});
    const order = (await this.pool.query('SELECT * FROM mpp_direct_orders WHERE id=$1',[refund.order_id])).rows[0];
    return this.transaction(order.user_id,async db => {
      const o = (await db.query('SELECT * FROM mpp_direct_orders WHERE id=$1 FOR UPDATE',[order.id])).rows[0];
      const r = (await db.query('SELECT * FROM mpp_direct_refunds WHERE id=$1 FOR UPDATE',[id])).rows[0];
      if (r.state==='confirmed') {requireThat(r.movement===proof.movementKey,'refund_movement_conflict');return this.view(o);}
      const anomaly=(await db.query('SELECT * FROM mpp_direct_anomalies WHERE order_id=$1 AND NOT refunded FOR UPDATE',[o.id])).rows[0];
      requireThat(proof.amount===(anomaly?.amount??o.w),'refund_liability_changed');
      await db.query('INSERT INTO mpp_direct_movements(identity,order_id,purpose,operation_id,proof) VALUES($1,$2,\'refund\',$3,$4)',[proof.movementKey,o.id,r.id,proof]);
      let ledger = null;
      if (BigInt(o.escrow_micro)>0n) {
        ledger = 'near_refund_'+o.id;
        const account = (await db.query("SELECT id FROM credit_accounts WHERE user_id=$1 AND currency='USD' FOR UPDATE",[o.user_id])).rows[0];
        await db.query(`INSERT INTO credit_ledger_entries(id,credit_account_id,entry_type,amount_micro_usd,currency,idempotency_key,metadata) VALUES($1,$2,'refund',$3,'USD',$1,$4)`,[ledger,account.id,String(-BigInt(o.escrow_micro)),{source:SPONSORED,method_version:2,order_id:o.id,refund_id:r.id}]);
        await db.query('UPDATE credit_accounts SET balance_micro_usd=balance_micro_usd-$2 WHERE id=$1',[account.id,o.escrow_micro]);
        await db.query('INSERT INTO redis_balance_mutations(mutation_id,user_id,ledger_entry_id,signed_delta_micro_usd) VALUES($1,$2,$3,$4)',[mutationId(ledger),o.user_id,ledger,String(-BigInt(o.escrow_micro))]);
      }
      await db.query('UPDATE mpp_direct_tasks SET reserved_nano=reserved_nano-$2 WHERE id=$1',[o.task_id,String(BigInt(o.reserve_nano)-BigInt(o.budget_charged_nano))]);
      const native=await this.rpc.transaction(refund.original_send.txHash,refund.plan.sender);
      let gas=0n;for(const r of [native.transaction_outcome,...native.receipts_outcome])gas+=BigInt(r.outcome.tokens_burnt);
      await this.finalizeProjectGas(db,hash(['project-gas-refund',o.id]),String(gas),proof);
      await db.query("UPDATE mpp_direct_orders SET w=0,r=CASE WHEN received THEN p-c ELSE 0 END,escrow_micro=0,state='refunded' WHERE id=$1",[o.id]);
      if(anomaly){
        await db.query('UPDATE mpp_direct_anomalies SET refunded=true WHERE identity=$1',[anomaly.identity]);
        await db.query("UPDATE mpp_direct_orders SET r=0,state='refunded' WHERE id=$1",[o.id]);
      }
      await db.query("UPDATE mpp_direct_refunds SET state='confirmed',movement=$2,cash_ledger=$3 WHERE id=$1",[id,proof.movementKey,ledger]);
      return this.view((await db.query('SELECT * FROM mpp_direct_orders WHERE id=$1',[o.id])).rows[0]);
    });
  }
  async finalizeProjectGas(db,id,actual,evidence){
    const op=(await db.query('SELECT * FROM mpp_direct_sponsor_operations WHERE id=$1 FOR UPDATE',[id])).rows[0];requireThat(op,'unknown_sponsor_operation');
    if(op.state==='final'){requireThat(op.actual_yocto===actual,'project_fee_conflict');return;}
    requireThat(op.state!=='never_sent','sealed_unsent_operation_conflict');
    await db.query("UPDATE mpp_direct_sponsor_operations SET actual_yocto=$2,state='final',evidence=$3 WHERE id=$1",[id,actual,evidence]);
    await db.query('UPDATE mpp_direct_project_budget SET reserved_yocto=reserved_yocto-$1,spent_yocto=spent_yocto+$2,active=active AND spent_yocto+$2+reserved_yocto-$1<=budget_yocto WHERE id=1',[op.estimate_yocto,actual]);
  }
  async reserveRefundGas(db,order){
    const project=(await db.query('SELECT * FROM mpp_direct_project_budget WHERE id=1 FOR UPDATE')).rows[0];
    requireThat(project.active&&BigInt(project.reserved_yocto)+BigInt(project.spent_yocto)+BigInt(this.config.gasEstimateYocto)<=BigInt(project.budget_yocto),'project_refund_allowance_pending');
    await db.query("INSERT INTO mpp_direct_sponsor_operations(id,order_id,kind,fee_payer,estimate_yocto,state) VALUES($1,$2,'refund',$3,$4,'authorized')",[hash(['project-gas-refund',order]),order,this.config.merchant,this.config.gasEstimateYocto]);
    await db.query('UPDATE mpp_direct_project_budget SET reserved_yocto=reserved_yocto+$1 WHERE id=1',[this.config.gasEstimateYocto]);
  }
}
