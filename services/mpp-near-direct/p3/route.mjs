import {Method,Receipt,Credential,Challenge} from 'mppx';
import {nearDirect,METHOD,requireThat,hash,challengeIdentity} from '../contract.mjs';
import {verifyBinding} from '../near.mjs';
import {verifyAgentPaidTransfer} from './outlayer-native-verification.mjs';
import {OperationStore} from './store.mjs';
import {Wallet} from './wallet.mjs';
import {verifyPolicy} from './outlayer.mjs';
import {Authorizations} from './auth.mjs';

export function createRoute({api,profiles}) {
 return async ({pool,rpc,config})=>{
  const store=new OperationStore(pool),auth=new Authorizations({pool,rpc,plan:config.plan});
  profiles.attach?.({pool,auth});
  const services={store,api,profiles,auth};
  const wallet=new Wallet({store,api,rpc,policy:b=>verifyPolicy({binding:b,rpc,api}),authorize:(f,ctx)=>services.authority.guard(f,ctx)});
  services.wallet=wallet;
  services.pay=async challenge=>{
   const op=await store.get('near-pay-v1-'+challenge.request.orderRef);
   requireThat(op&&challengeIdentity(op.frozen.challenge)===challengeIdentity(challenge),'original_order_required');
   const paid=await wallet.recover(op.id);requireThat(paid.state!=='cancelled','payment_policy_denied');requireThat(paid.credential,'original_payment_pending');return paid.credential;
  };
  services.fetch=async (url,init)=>{
   const path=new URL(url).pathname,body=JSON.parse(init.body??'{}');
   let out;
   if(path==='/wallet/pay')out={credential:Credential.serialize(await services.pay(body.challenge))};
   else if(path==='/wallet/status'){
    const id='near-pay-v1-'+body.orderRef;let row=await store.get(id);
    if(row&&row.state!=='prepared')row=await wallet.recover(id);
    out={orderRef:body.orderRef,operationKey:id,txHash:row?.txHash,credential:row?.credential?Credential.serialize(row.credential):null};
    // A paid original without an assignment still creates a merchant liability.
    if(row?.proof&&!row.credential)await services.authority.reconcile(body.orderRef,row.frozen.userId);
   }else if(path==='/wallet/cancel')out=await wallet.cancel('near-pay-v1-'+body.orderRef);
   else if(path==='/merchant/refund'){
    const p=body.plan,r=(await pool.query('SELECT * FROM mpp_direct_refunds WHERE order_id=$1',[p.orderRef])).rows[0];
    requireThat(r?.plan_hash===hash(p),'original_refund_required');
    const o=await services.authority.getOrder(p.orderRef,(await pool.query('SELECT user_id FROM mpp_direct_orders WHERE id=$1',[p.orderRef])).rows[0].user_id);
    const binding={...config.plan.merchantBinding,merchant:p.recipient,refundTo:p.sender,signingRecipient:config.realm};
    const now=Date.now(),challenge=Challenge.from({realm:config.realm,secretKey:config.secret,method:METHOD,intent:'charge',
     request:{...o.challenge.request,payer:p.sender,recipient:p.recipient,refundTo:p.sender,amount:p.amount,bindingVersion:binding.version,
      termsHash:hash(p),issuedAtMs:now,expiresAtMs:now+120000},expires:new Date(now+120000).toISOString()});
    let op=await store.get('near-refund-v1-'+p.orderRef);
    if(!op)op=await wallet.prepare({challenge,binding,kind:'refund',gasReserveYocto:config.gasEstimateYocto,gasFloorYocto:config.plan.limits.merchantGasFloorYocto,
     nanoUsdPerNear:config.rateNanoPerNear,taskId:o.task_id,userId:o.user_id});
    op=await wallet.recover(op.id);requireThat(op.state==='final','original_refund_pending');
    out={txHash:op.txHash,publicKey:binding.publicKey,planHash:hash(p),operationId:p.operationId,idempotencyKey:p.idempotencyKey};
   }else throw new Error('unsupported_internal_wallet_operation');
   return Response.json(out);
  };
  const route={method:METHOD,version:1,principalRequest:r=>r,operationKey:id=>'near-pay-v1-'+id,services,
   async verify({credential,expectedChallenge}){
    requireThat(challengeIdentity(credential.challenge)===challengeIdentity(expectedChallenge),'challenge_mismatch');verifyBinding(expectedChallenge,credential.payload);
    const op=await store.get('near-pay-v1-'+expectedChallenge.request.orderRef);
    requireThat(op?.txHash===credential.payload.txHash&&op.frozen.binding.publicKey===credential.payload.publicKey,'original_api_payment_required');
    return verifyAgentPaidTransfer({challenge:expectedChallenge,txHash:op.txHash,publicKey:credential.payload.publicKey,rpc});
   },
   server({authority}){return Method.toServer(nearDirect,{async verify({credential}){
    const expected=await authority.loadChallenge(credential.challenge.id);requireThat(expected,'unknown_challenge');
    await authority.journalPresentation(credential);const proof=await route.verify({credential,expectedChallenge:expected}),result=await authority.consumeVerifiedPayment(proof);
    requireThat(result.committed&&result.projectionReady&&!proof.late,'payment_not_admissible');
    return Receipt.from({method:METHOD,status:'success',reference:proof.movementKey,timestamp:new Date(proof.paidAtMs).toISOString()});
   }});},
  };
  return route;
 };
}
