import {hash,requireThat,uint,canonical} from '../contract.mjs';
const publicError=e=>/^[a-z_]+$/.test(e.message)?e.message:'funding_outcome_unknown';
export class Funding {
 constructor({pool,rpc,auth,plan,fetcher=fetch,oneClickOrigin='https://1click.chaindefuser.com',apiKey=''}){Object.assign(this,{pool,rpc,auth,plan,fetcher,oneClickOrigin,apiKey});this.runId=hash(plan);}
 async vendor(path,body){const r=await this.fetcher(this.oneClickOrigin+path,{method:body?'POST':'GET',redirect:'error',signal:AbortSignal.timeout(15000),headers:{'content-type':'application/json',...(this.apiKey?{'X-API-Key':this.apiKey}:{})},...(body?{body:JSON.stringify(body)}:{})});requireThat(r.ok,'oneclick_unavailable_unknown');const text=await r.text();requireThat(Buffer.byteLength(text)<=1024*1024,'oneclick_response_limit');return JSON.parse(text);}
 async row(owner,id){const r=(await this.pool.query('SELECT * FROM mpp_direct_p3_funding WHERE id=$1 AND owner_id=$2 AND run_id=$3',[id,owner,this.runId])).rows[0];requireThat(r,'unknown_funding');return r;}
 async create(owner,agentId){await this.auth.requireGrant(owner);requireThat(owner===this.plan.ownerAccount,'wrong_owner');
  const agent=this.plan.agents.find(x=>x.agentId===agentId);requireThat(agent,'unknown_agent');const account=(await this.pool.query('SELECT * FROM mpp_direct_agents WHERE agent_id=$1 AND owner_id=$2',[agentId,owner])).rows[0];requireThat(account?.payer===agent.payer,'agent_binding_mismatch');
  const id=hash([this.runId,agentId,'funding']),old=(await this.pool.query('SELECT * FROM mpp_direct_p3_funding WHERE id=$1',[id])).rows[0];if(old)return this.public(old);
  const source=this.plan.funding,total=uint(source.totalAmount),each=total/2n,before=await this.rpc.call('block',{finality:'final'});
  const quoteRequest={dry:false,swapType:'EXACT_INPUT',slippageTolerance:source.slippageBps??100,originAsset:source.originAsset,destinationAsset:'nep141:wrap.near',amount:String(each),
   refundTo:source.refundTo,refundType:'ORIGIN_CHAIN',depositType:'ORIGIN_CHAIN',recipient:agent.payer,recipientType:'DESTINATION_CHAIN',deadline:new Date(this.plan.limits.deadlineMs).toISOString()};
  const request={quoteRequest,nativeBeforeBlockHash:before.header.hash,createdAtMs:Date.now(),sourceRemainder:String(total%2n)},digest=hash(request);
  const inserted=await this.pool.query("INSERT INTO mpp_direct_p3_funding(id,run_id,owner_id,user_id,request,request_hash,state) VALUES($1,$2,$3,$4,$5,$6,'prepared') ON CONFLICT DO NOTHING",[id,this.runId,owner,account.user_id,request,digest]);
  if(!inserted.rowCount)return this.public(await this.row(owner,id));
  try{
   // Only this durable first writer calls quote. Lost ACK never creates another
   // deposit destination or asks the source wallet to pay a replacement.
   await this.pool.query("UPDATE mpp_direct_p3_funding SET state='quote_unknown' WHERE id=$1",[id]);
   const response=await this.vendor('/v0/quote',quoteRequest),q=response.quote;
   requireThat(response.quoteRequest&&Object.entries(quoteRequest).every(([k,v])=>canonical(response.quoteRequest[k])===canonical(v)),'funding_quote_terms_changed');
   requireThat(q&&typeof q.depositAddress==='string'&&q.depositAddress.length<=256&&uint(q.amountIn)===each&&uint(q.minAmountOut)>=uint(source.minimumNativePerAgent),'funding_quote_outside_authorization');
   requireThat(typeof response.signature==='string'&&typeof response.correlationId==='string'&&Date.parse(q.deadline)<=this.plan.limits.deadlineMs&&Date.parse(q.deadline)>Date.now(),'invalid_funding_quote');
   await this.pool.query("UPDATE mpp_direct_p3_funding SET quote=$2,state='quoted',last_error=NULL WHERE id=$1 AND state='quote_unknown'",[id,response]);
  }catch(e){await this.pool.query('UPDATE mpp_direct_p3_funding SET last_error=$2 WHERE id=$1',[id,publicError(e)]);throw e;}
  return this.public(await this.row(owner,id));
 }
 public(r){return {id:r.id,state:r.state,request:r.request.quoteRequest,sourceRemainder:r.request.sourceRemainder,quote:r.quote,nativeProof:r.native_proof,lastError:r.last_error};}
 async status(owner,id){const r=await this.row(owner,id);return this.public(r);}
 async prove(owner,id,{depositTxHash,destinationTxHash,destinationSender}){
  const f=await this.row(owner,id);if(f.state==='native_final')return this.public(f);requireThat(f.quote&&typeof depositTxHash==='string'&&depositTxHash.length<=160,'original_source_deposit_required');
  requireThat(!f.deposit_hash||f.deposit_hash===depositTxHash,'source_deposit_conflict');
  await this.pool.query("UPDATE mpp_direct_p3_funding SET deposit_hash=$2,state='output_unknown' WHERE id=$1 AND (deposit_hash IS NULL OR deposit_hash=$2)",[id,depositTxHash]);
  const quote=f.quote.quote,status=await this.vendor('/v0/status?depositAddress='+encodeURIComponent(quote.depositAddress)+(quote.depositMemo?'&depositMemo='+encodeURIComponent(quote.depositMemo):''));
  requireThat(status.status==='SUCCESS','source_funding_not_final');
  const original=status.quoteResponse??status.quote;requireThat(original?.correlationId===f.quote.correlationId&&hash(original.quoteRequest)===hash(f.quote.quoteRequest),'oneclick_original_operation_mismatch');
  const deposits=status.swapDetails?.originChainTxHashes??[];
  requireThat(deposits.some(x=>(typeof x==='string'?x:x.hash)===depositTxHash),'source_deposit_not_in_original_swap');
  const outputs=status.swapDetails?.destinationChainTxHashes??[];requireThat(outputs.some(x=>(typeof x==='string'?x:x.hash)===destinationTxHash)&&typeof destinationSender==='string','original_destination_transaction_required');
  const account=(await this.pool.query('SELECT payer FROM mpp_direct_agents WHERE user_id=$1',[f.user_id])).rows[0].payer;
  const tx=await this.rpc.transaction(destinationTxHash,destinationSender);requireThat(tx.final_execution_status==='FINAL'&&tx.transaction.hash===destinationTxHash&&typeof tx.status?.SuccessValue==='string','destination_funding_not_final');
  requireThat(tx.transaction.signer_id===destinationSender&&tx.transaction_outcome?.id===destinationTxHash&&tx.transaction_outcome.outcome?.executor_id===destinationSender&&Array.isArray(tx.transaction_outcome.outcome.receipt_ids)&&tx.transaction_outcome.outcome.receipt_ids.length>0,'funding_root_binding_mismatch');
  const rows=tx.receipts_outcome;requireThat(Array.isArray(rows)&&rows.length>0&&rows.length<=128,'funding_receipt_bound');
  const map=new Map(rows.map(r=>[r.id,r]));requireThat(map.size===rows.length,'duplicate_receipt');const queue=[...tx.transaction_outcome.outcome.receipt_ids],seen=new Set();
  while(queue.length){const rid=queue.shift();requireThat(!seen.has(rid),'invalid_receipt_graph');seen.add(rid);const r=map.get(rid);requireThat(r,'funding_receipt_missing');requireThat((typeof r.outcome.status?.SuccessValue==='string'||typeof r.outcome.status?.SuccessReceiptId==='string')&&Array.isArray(r.outcome.receipt_ids),'funding_receipt_not_successful');queue.push(...r.outcome.receipt_ids);}
  requireThat(seen.size===rows.length,'unrelated_receipt');let paid;
  for(const r of rows)if(r.outcome.executor_id===account&&typeof r.outcome.status?.SuccessValue==='string'){
   const receipt=await this.rpc.call('EXPERIMENTAL_receipt',{receipt_id:r.id});
   const action=receipt.receipt?.Action;
   if(receipt.receipt_id===r.id&&receipt.receiver_id===account&&action?.actions?.length===1&&action.actions[0].Transfer){
    const amount=action.actions[0].Transfer.deposit;if(uint(amount)>=uint(this.plan.funding.minimumNativePerAgent)){requireThat(!paid,'ambiguous_native_funding_receipts');paid={receiptId:r.id,amount,blockHash:r.block_hash};}
   }
  }
  requireThat(paid,'native_near_output_not_proven_wrapped_balance_is_insufficient');
  // A newly funded implicit account may not exist in the previous block.
  // The exact, rooted FINAL native Transfer receipt is authoritative; a wrapped
  // token balance, vendor success flag or account delta alone is insufficient.
  const [after,block]=await Promise.all([
   this.rpc.call('query',{request_type:'view_account',account_id:account,finality:'final'}),this.rpc.block(paid.blockHash)]);
  requireThat(BigInt(block.header.timestamp_nanosec)>=BigInt(f.request.createdAtMs)*1000000n
   &&uint(after.amount)>0n,'native_funding_balance_mismatch');
  const proof={source:'verified-oneclick-and-final-near-receipt',network:this.plan.network,accountId:account,asset:'native:NEAR',decimals:24,amount:paid.amount,
   correlationId:f.quote.correlationId,depositTxHash,txHash:destinationTxHash,...paid,movementKey:`near:${this.plan.network}:${destinationTxHash}:${paid.receiptId}:0`};
  await this.pool.query("UPDATE mpp_direct_p3_funding SET native_proof=$2,movement=$3,state='native_final' WHERE id=$1 AND state<>'native_final'",[id,proof,proof.movementKey]);return this.public(await this.row(owner,id));
 }
}
