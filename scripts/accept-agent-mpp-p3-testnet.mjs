// Explicit, bounded testnet canary. No provider calls or mainnet path.
import {readFile,stat,mkdir,open,rename,unlink} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {randomBytes} from 'node:crypto';
import {createRequire} from 'node:module';
const {Challenge,Credential}=await import(createRequire(new URL('../services/mpp-near-direct/package.json',import.meta.url)).resolve('mppx'));
import {OutLayer,publicKey,contractView,verifyPolicy} from '../services/mpp-near-direct/p3/outlayer.mjs';
import {Wallet} from '../services/mpp-near-direct/p3/wallet.mjs';
import {NearRpc,verifyPayment,refundPlan,verifyRefund} from '../services/mpp-near-direct/near.mjs';
import {hash,METHOD,requireThat} from '../services/mpp-near-direct/contract.mjs';

requireThat(process.argv[2]==='--execute-testnet','explicit_testnet_canary_required');
const configPath=resolve(process.argv[3]),config=JSON.parse(await readFile(configPath,'utf8'));
requireThat(((await stat(configPath)).mode&0o077)===0,'private_canary_config_required');
requireThat(config.network==='testnet'&&config.amountYocto==='10000000000000000000','bounded_testnet_canary_only');
const directory=resolve(config.journalDirectory);await mkdir(directory,{recursive:true,mode:0o700});
const lock=await open(directory+'/run.lock','wx',0o600);await lock.close();
async function atomic(name,value){const f=directory+'/'+name,temp=f+'.tmp';const h=await open(temp,'w',0o600);try{await h.writeFile(JSON.stringify(value,null,2));await h.sync();}finally{await h.close();}await rename(temp,f);}
const values={};
for(const role of ['agent','controller']){
 const file=config[role+'Registration'];requireThat(((await stat(file)).mode&0o077)===0,'private_registration_required');
 const r=JSON.parse(await readFile(file,'utf8'));values[role]={walletId:r.wallet_id,apiKey:r.api_key,payer:r.near_account_id};
}
const api=new OutLayer({network:'testnet',credentials:{async get(ref){return values[ref];}}});
const rpc=new NearRpc({url:'https://rpc.testnet.near.org',network:'testnet'});
const realm='payments.example.com',controller=values.controller,agent=values.agent;
const binding={agentId:'testnet-canary',walletId:agent.walletId,credentialRef:'agent',payer:agent.payer,refundTo:agent.payer,
 publicKey:publicKey('ed25519:'+agent.payer).base58,network:'testnet',version:'testnet-canary-v1',merchant:controller.payer,signingRecipient:realm};
const controllerBinding={credentialRef:'controller',walletId:controller.walletId,payer:controller.payer,publicKey:publicKey('ed25519:'+controller.payer).base58};
const readPolicy=()=>contractView(rpc,'outlayer.testnet','get_wallet_policy',{wallet_pubkey:'ed25519:'+agent.payer});
const start=Date.now(),runId=hash([start,randomBytes(16).toString('hex')]);
const finalCall=async(method)=>{
 try{await stat(directory+'/'+method+'-send.json');throw Error('policy_call_already_possibly_sent');}catch(e){if(e.code!=='ENOENT')throw e;}
 const body={receiver_id:'outlayer.testnet',method_name:method,args:{wallet_pubkey:'ed25519:'+agent.payer},deposit:'0'};
 await atomic(method+'-send.json',{body,possiblySent:true,key:runId+'-'+method});
 const out=await api.request('controller','/wallet/v1/call',body,runId+'-'+method);
 await atomic(method+'-response.json',out);
 const tx=await rpc.transaction(out.tx_hash,controller.payer);
 requireThat(tx.final_execution_status==='FINAL'&&typeof tx.status?.SuccessValue==='string','policy_call_not_final');
 return out.tx_hash;
};
const report={scope:'real-testnet-outlayer-native-NEP413-and-refund-component',mainnet:false,providerCalls:0,browserOwner:false,marketIntegration:false,amountYocto:config.amountYocto,runId};
try{
 const before=await readPolicy();requireThat(before?.owner===controller.payer&&before.frozen===true,'expected_frozen_test_controller_required');
 binding.policy={controller:controller.payer,version:before.version,encryptedHash:hash(before.encrypted_data)};
 report.unfreezeTx=await finalCall('unfreeze_wallet');
 const store={
  async create(row){await atomic('payment.json',row);return row;},
  async get(){return JSON.parse(await readFile(directory+'/payment.json','utf8'));},
  async lock(id,fn){const get=()=>this.get(),save=row=>atomic('payment.json',row);
   return fn({get,save,begin:async authorize=>{const row=await get();requireThat(row.state==='prepared'&&row.attempts===0,'canary_already_dispatched');await authorize(row.frozen,{});const sending={...row,state:'sending',attempts:1};await save(sending);return sending;}});},
 };
 const now=Date.now(),request={version:1,network:'testnet',currency:'NEAR',decimals:24,amount:config.amountYocto,
  payer:agent.payer,recipient:controller.payer,refundTo:agent.payer,bindingVersion:binding.version,orderRef:runId,
  termsHash:hash('testnet-wallet-canary-no-inference'),nativeRequestHash:hash('no-provider-request'),nonce:randomBytes(32).toString('base64'),issuedAtMs:now,expiresAtMs:now+120000,signingRecipient:realm};
 const challenge=Challenge.from({realm,secretKey:randomBytes(32).toString('hex'),method:METHOD,intent:'charge',request,expires:new Date(request.expiresAtMs).toISOString()});
 const wallet=new Wallet({store,api,rpc,policy:b=>verifyPolicy({binding:b,rpc,api}),authorize:async()=>{
  const b=await rpc.call('query',{request_type:'view_account',account_id:agent.payer,finality:'final'});
  requireThat(BigInt(b.amount)>BigInt(config.amountYocto)+10000000000000000000000n,'testnet_balance_insufficient');
 }});
 const op=await wallet.prepare({challenge,binding,gasReserveYocto:'10000000000000000000000',gasFloorYocto:'10000000000000000000000',nanoUsdPerNear:'2000000000',taskId:'canary',userId:'canary'});
 const paid=await wallet.recover(op.id);requireThat(paid.state==='final','canary_payment_or_signature_unresolved');
 const credential=Credential.deserialize(Credential.serialize(paid.credential));
 const proof=await verifyPayment({credential,expectedChallenge:challenge,rpc});
 report.payment={txHash:paid.txHash,requestId:paid.requestId,proof,gas:paid.feeProof.gasActualYocto,nep413:'exact caller nonce/message/recipient verified',credentialRoundTrip:true};
 report.freezeTx=await finalCall('freeze_wallet');requireThat((await readPolicy()).frozen===true,'freeze_not_confirmed');
 const plan=refundPlan({orderRef:runId,binding:request,amount:config.amountYocto,refundableYocto:config.amountYocto,operationId:'canary-refund-'+runId,createdAtMs:Date.now()});
 await atomic('refund-send.json',{plan,possiblySent:true});
 const result=await api.transfer(controllerBinding,{to:plan.recipient,amount:plan.amount},plan.idempotencyKey);
 const originalSend={operationId:plan.operationId,idempotencyKey:plan.idempotencyKey,planHash:hash(plan),txHash:result.tx_hash};await atomic('refund-response.json',{result,originalSend});
 report.refund=await verifyRefund({plan,originalSend,txHash:result.tx_hash,publicKey:controllerBinding.publicKey,rpc});
 report.frozenAgentReceivedRefund=true;report.passed=true;
} catch(error){report.passed=false;report.error=/^[a-z_]+$/.test(error.message)?error.message:'canary_unresolved';process.exitCode=2;}
finally{
 try{if(!(await readPolicy()).frozen)report.cleanupFreezeTx=await finalCall('freeze_wallet');report.finalFrozen=(await readPolicy()).frozen===true;}
 catch{report.finalFrozen=false;report.cleanup='freeze_status_unknown';process.exitCode=2;}
 await atomic('evidence.json',report);console.log(JSON.stringify({passed:report.passed??false,error:report.error,finalFrozen:report.finalFrozen,evidence:directory+'/evidence.json'}));
 // Keep run.lock as a durable no-blind-rerun marker even after success.
}
