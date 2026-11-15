import {KeyPair} from 'near-api-js';
import {randomBytes} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {hash} from '../contract.mjs';

// Preparation only: creates local keys and a public review document. No faucet,
// transfer, RPC broadcast, inference request or deployment occurs here.
export async function prepareTestnetRun(privateDirectory,publicPlanFile){
 const runId='auction-'+randomBytes(6).toString('hex');
 const actors=['owner','agent-a','agent-b','merchant'].map(role=>{
  const key=KeyPair.fromRandom('ed25519'),publicKey=key.getPublicKey().toString();
  const accountId=role==='owner'?runId+'.testnet':Buffer.from(key.getPublicKey().data).toString('hex');
  return {role,accountId,publicKey,secretKey:key.toString()};
 });
 const directory=resolve(privateDirectory);await mkdir(directory,{recursive:true,mode:0o700});
 await writeFile(join(directory,'keys.json'),JSON.stringify({version:1,network:'testnet',runId,actors})+'\n',{mode:0o600,flag:'wx'});
 const publicActors=actors.map(({secretKey,...a})=>a);
 const recipients=publicActors.filter(a=>a.role!=='owner').map(a=>a.accountId);
 const accounts=publicActors.map(a=>({payer:a.accountId,publicKey:a.publicKey,
  maximumExposureYocto:a.role==='owner'?'62000000000000000000000':a.role==='merchant'?'10000000000000000000000':'5000000000000000000000',
  maxOperations:a.role==='owner'?3:a.role==='merchant'?4:2}));
 const walletPolicy={network:'testnet',realm:'auction-testnet.local',recipients,accounts,refundGasReserveYocto:'500000000000000000000'};
 const body={version:1,runId,status:'prepared-for-review',network:'testnet',rpcUrl:'https://rpc.testnet.near.org',actors:publicActors,
  walletPolicy,walletPolicyHash:hash(walletPolicy),limits:{maxFaucetRequests:1,agentCount:2,modelCallsPerAgent:2,maxUpstreamCalls:4,
   maxInputTokensPerCall:4000,maxOutputTokensPerCall:512,providerBudgetMicroUsd:'10000',
   initialFundingPerAgentYocto:'20000000000000000000000',merchantGasFundingYocto:'20000000000000000000000',
   totalFundingPrincipalYocto:'60000000000000000000000',ownerFundingGasReserveYocto:'2000000000000000000000',
   paymentPrincipalPerAgentYocto:'4000000000000000000000',paymentGasReservePerCallYocto:'500000000000000000000'},
  approvals:{accountCreation:false,funding:false,payments:false,paidInference:false,deployment:false},
  evidenceRequired:['original funding transfers','four original native payment transactions and actual gas','four native inference request/response bindings',
   'independent JSON artifacts','original settlements and refunds','all assigned tasks including interruptions'],
  limitations:['Testnet tokens do not establish mainnet monetary economics.','Gas reserves are software authorization inputs; a native Transfer has no caller-specified gas field.',
   'The real-chain service and provider qualification must pass preflight before broadcast can be enabled.']};
 const plan={...body,planHash:hash(body)};
 await writeFile(resolve(publicPlanFile),JSON.stringify(plan,null,2)+'\n',{mode:0o600,flag:'wx'});
 return {planHash:plan.planHash,publicPlanFile:resolve(publicPlanFile),privateDirectory:directory,network:'testnet',externalActions:0};
}
