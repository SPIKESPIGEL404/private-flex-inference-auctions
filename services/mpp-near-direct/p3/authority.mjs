import { Authority as TaskAuthority } from '../p2/authority.mjs';
import { hash, requireThat, METHOD, nanoUsdForNear } from '../contract.mjs';
import { verifyAgentPaidTransfer } from './native-verification.mjs';
import { verifyPolicy } from './outlayer.mjs';

export class Authority extends TaskAuthority {
  constructor(args) {
    super(args); this.services=args.paymentRoute.services; this.services.authority=this;
  }
  async pin() {
    const {plan}=this.config;
    const fp=hash({plan,database:hash(this.config.databaseUrl),secret:hash(this.config.secret)});
    await this.pool.query('INSERT INTO mpp_direct_configuration(fingerprint,configuration,mode) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[fp,plan,this.config.mode]);
    requireThat((await this.pool.query('SELECT fingerprint FROM mpp_direct_configuration')).rows[0]?.fingerprint===fp,'payment_configuration_changed');
    await this.pool.query('INSERT INTO mpp_direct_p3_runs VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[hash(plan),plan,Date.now()]);
  }
  binding(user) {
    const b=this.config.plan.agents.find(x=>x.userId===user);requireThat(b,'unknown_agent_binding');return b;
  }
  mapNative(body) { return {...body,model:this.config.mode==='controlled'?'m/external':this.config.plan.provider.model}; }
  routeCostNano() { return String(nanoUsdForNear(this.paymentGasReserve(),this.config.rateNanoPerNear)); }
  async nativeOrigin(order) { return this.services.profiles.origin?this.services.profiles.origin(order.decision.quote.profileId):this.config.upstream; }
  async qualifyNative(body) { return this.services.profiles.qualify(body); }
  async paymentRequest(base) { const {gasSponsor,sponsorOperation,...request}=base;return {...request,version:1}; }
  paymentGasReserve() { return this.config.plan.limits.gasReserveYocto; }
  gasFloor() { return this.config.plan.limits.gasFloorYocto; }
  async forecast(db,quote) {
    requireThat(quote.forecast?.source===(this.config.mode==='controlled'?'controlled-provider-fixture':'measured-native-provider'),'qualified_native_forecast_required');
    return {available:true,source:quote.forecast.source,observed_ms:quote.forecast.observedMs,usable_ms:quote.forecast.usableMs};
  }
  async spendingAvailable(agent,task,available,db) {
    const t=await this.services.store.gas({userId:agent.user_id,taskId:task.id},db);
    const a=await this.services.store.gas({userId:agent.user_id},db);
    const parent=(await db.query('SELECT * FROM mpp_direct_p2_agent_limits WHERE user_id=$1',[agent.user_id])).rows[0];
    const own=BigInt(task.budget_nano)-BigInt(task.reserved_nano)-BigInt(task.spent_nano)-t.actualNano-t.reservedNano;
    const all=BigInt(parent.budget_nano)-BigInt(parent.reserved_nano)-BigInt(parent.spent_nano)-a.actualNano-a.reservedNano;
    const n=own<all?own:all;return n>0n?n:0n;
  }
  async nativeBalance(agent,nowMs,db) {
    const balance=await super.nativeBalance(agent,nowMs,db);
    const gas=await this.services.store.gas({userId:agent.user_id},db);
    return {...balance,reservedYocto:String(BigInt(balance.reservedYocto)+gas.reservedYocto)};
  }
  async hasPaymentSlot(agent,db) {
    const unknown=(await db.query("SELECT 1 FROM mpp_direct_p3_operations WHERE payer=$1 AND state IN('sending','unknown','review') LIMIT 1",[agent.payer])).rowCount;
    return unknown===0;
  }
  async checkGas(db,agent) {
    await this.services.auth.requireGrant(this.config.plan.ownerAccount,'owner',db);
    await this.services.auth.requireGrant(this.config.plan.projectAccount,'project',db);
    await verifyPolicy({binding:this.binding(agent.user_id),rpc:this.rpc,api:this.services.api});
    const overrun=(await db.query("SELECT 1 FROM mpp_direct_p3_operations WHERE user_id=$1 AND kind='payment' AND (document->>'gasOverrun')::boolean LIMIT 1",[agent.user_id])).rowCount;
    requireThat(!overrun,'agent_gas_overrun_stop');
  }
  async reservePaymentGas(db,{id,sponsorOperation,agent,taskId,challenge}) {
    await db.query("INSERT INTO mpp_direct_sponsor_operations(id,order_id,kind,fee_payer,estimate_yocto,state) VALUES($1,$2,'payment',$3,$4,'authorized')",[sponsorOperation,id,agent.payer,this.paymentGasReserve()]);
    await this.services.wallet.prepare({challenge,binding:this.binding(agent.user_id),gasReserveYocto:this.paymentGasReserve(),gasFloorYocto:this.gasFloor(),nanoUsdPerNear:this.config.rateNanoPerNear,taskId,userId:agent.user_id},db);
  }
  async originalOperation(order) {
    const op=await this.services.store.get('near-pay-v1-'+order.id);
    requireThat(op?.proof,'original_native_payment_unknown');
    return {orderRef:order.id,operationKey:op.id,txHash:op.txHash,credential:op.credential};
  }
  async reconcile(id,user) {
    const order=await this.getOrder(id,user),original=await this.originalOperation(order);
    const proof=original.credential?await this.paymentRoute.verify({credential:original.credential,expectedChallenge:order.challenge}):
      {...await verifyAgentPaidTransfer({challenge:order.challenge,txHash:original.txHash,publicKey:this.binding(user).publicKey,rpc:this.rpc}),assignmentMissing:true};
    await this.consumeVerifiedPayment(proof);return this.view(await this.getOrder(id,user));
  }
  checkPaymentGasBinding(order,v) {
    requireThat(v.gasPayer===order.challenge.request.payer&&v.method===METHOD&&v.methodVersion===1,'verified_payment_gas_binding_mismatch');
  }
  async finalizePaymentGas(db,o,v) {
    const op=(await db.query('SELECT document FROM mpp_direct_p3_operations WHERE id=$1',['near-pay-v1-'+o.id])).rows[0]?.document;
    requireThat(op?.feeProof?.gasActualYocto===v.gasActualYocto,'original_gas_proof_required');
    await db.query("UPDATE mpp_direct_sponsor_operations SET state='final',actual_yocto=$2,evidence=$3 WHERE id=$1 AND state<>'never_sent'",[o.sponsor_operation,v.gasActualYocto,v]);
    await db.query('UPDATE mpp_direct_orders SET payment_gas=$2 WHERE id=$1',[o.id,v.gasActualYocto]);
  }
  async releasePaymentGas() { /* Native gas liability lives in the sealed operation, not the merchant budget. */ }
  async guard(f,{db}) {
    const o=(await db.query('SELECT * FROM mpp_direct_orders WHERE id=$1 FOR UPDATE',[f.challenge.request.orderRef])).rows[0];
    requireThat(o&&o.user_id===f.userId,'native_order_binding_mismatch');
    if(f.kind==='refund') {
      const r=(await db.query('SELECT * FROM mpp_direct_refunds WHERE order_id=$1 FOR UPDATE',[o.id])).rows[0];
      requireThat(r&&r.plan.amount===f.transfer.amount&&r.plan.recipient===f.transfer.to,'refund_liability_changed');return;
    }
    requireThat(hash(o.challenge)===hash(f.challenge)&&o.binding_version===f.binding.version,'native_order_binding_mismatch');
    const task=(await db.query('SELECT * FROM mpp_direct_tasks WHERE id=$1 FOR UPDATE',[o.task_id])).rows[0];
    const agent=(await db.query('SELECT * FROM mpp_direct_agents WHERE user_id=$1 FOR SHARE',[o.user_id])).rows[0];
    const call=(await db.query('SELECT * FROM mpp_direct_p2_calls WHERE id=$1 FOR SHARE',[o.call_id])).rows[0];
    requireThat(agent.active&&task.active&&!task.paused&&task.revision===o.task_revision&&call.state==='quoted'&&call.revision===o.bid_revision
      &&Date.now()<Number(o.expires_ms),'new_payment_authorization_closed');
    await this.checkGas(db,agent);
    const balance=await this.nativeBalance(agent,Date.now(),db);
    // This operation's principal/gas is already in the original reservations.
    requireThat(BigInt(balance.availableAfterStorageYocto)>=BigInt(balance.reservedYocto)+BigInt(this.gasFloor()),'native_balance_or_gas_insufficient');
    const tgas=await this.services.store.gas({userId:agent.user_id,taskId:task.id},db);
    requireThat(BigInt(task.reserved_nano)+BigInt(task.spent_nano)+tgas.actualNano+tgas.reservedNano<=BigInt(task.budget_nano),'native_task_budget_insufficient');
    const parent=(await db.query('SELECT * FROM mpp_direct_p2_agent_limits WHERE user_id=$1 FOR SHARE',[agent.user_id])).rows[0],agas=await this.services.store.gas({userId:agent.user_id},db);
    requireThat(BigInt(parent.reserved_nano)+BigInt(parent.spent_nano)+agas.actualNano+agas.reservedNano<=BigInt(parent.budget_nano),'native_agent_budget_insufficient');
  }
  view(order) { return {...super.view(order),mode:this.config.mode,realPayment:this.config.mode==='bounded',walletProvider:'outlayer',method:METHOD,methodVersion:1}; }
}
