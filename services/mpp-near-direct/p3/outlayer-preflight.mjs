import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {validateConfig} from './proxy.mjs';
import {OutLayer,FileCredentials,verifyPolicy} from './outlayer.mjs';
import {NearRpc} from '../near.mjs';
import {hash,requireThat} from '../contract.mjs';
export async function preflight(config) {
 validateConfig(config);
 const rpc=new NearRpc({url:config.rpcUrl,network:config.network,controlled:config.mode==='controlled'});
 const api=new OutLayer({network:config.network,credentials:new FileCredentials(config.credentialDirectory),controlled:config.mode==='controlled',origin:config.mode==='controlled'?config.controlledWalletOrigin:undefined});
 const network=await rpc.call('status',[]);requireThat(network.chain_id===config.network,'rpc_network_mismatch');
 const checks=[];
 for(const binding of [...config.plan.agents,config.plan.merchantBinding]) {
  await verifyPolicy({binding,rpc,api});
  const account=await rpc.call('query',{request_type:'view_account',finality:'final',account_id:binding.payer});
  const available=BigInt(account.amount)-BigInt(account.locked)-BigInt(account.storage_usage)*BigInt(config.storagePriceYocto);
  const minimum=BigInt(binding.principalCapYocto??'0')+BigInt(config.plan.limits.gasReserveYocto)+BigInt(binding===config.plan.merchantBinding?config.plan.limits.merchantGasFloorYocto:config.plan.limits.gasFloorYocto);
  checks.push({walletId:binding.walletId,payer:binding.payer,policy:'verified-final',nativeSufficient:available>=minimum});
 }
 return {phase:'P3',walletProvider:'outlayer',network:config.network,mode:config.mode,planHash:hash(config.plan),
  walletChecksPassed:checks.every(c=>c.nativeSufficient),runUnexpired:config.plan.limits.deadlineMs>Date.now(),canPurchase:false,checks,
  acceptance:'preflight-only; not real task, refund, upstream qualification or hosted idempotency acceptance'};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{const c=JSON.parse(readFileSync(process.argv[2],'utf8'));const report=await preflight(c.payments??c);console.log(JSON.stringify(report));process.exitCode=report.walletChecksPassed&&report.runUnexpired?0:2;}
 catch(error){console.log(JSON.stringify({canPurchase:false,error:/^[a-z_]+$/.test(error.message)?error.message:'preflight_unknown'}));process.exitCode=2;}
}
