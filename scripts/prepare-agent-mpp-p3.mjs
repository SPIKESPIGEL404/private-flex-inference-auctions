#!/usr/bin/env node
// Build a private SETUP config from an initialized original Market and public run settings.
// This command creates no wallet, grant, provider request or transfer.
import {readFile,writeFile,mkdir,stat} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {randomBytes} from 'node:crypto';
import {requireThat,uint,account} from '../services/mpp-near-direct/contract.mjs';
const [statePath,settingsPath,outputPath]=process.argv.slice(2);
try {
 requireThat(statePath&&settingsPath&&outputPath,'usage_prepare_p3_state_settings_output');
 const base=resolve(statePath),state=JSON.parse(await readFile(base+'/state.json','utf8')),registration=JSON.parse(await readFile(base+'/registration.json','utf8'));
 const settings=JSON.parse(await readFile(settingsPath,'utf8'));
 requireThat(['testnet','mainnet'].includes(settings.network)&&account.test(settings.ownerAccount)&&account.test(settings.projectAccount),'run_owner_required');
 requireThat(registration.profile_slot==null&&registration.offer_valid_until_ms>Date.now()&&registration.offer_valid_until_ms<=Date.now()+3600000,'bounded_root_registration_required');
 requireThat(settings.merchantBinding?.policy?.controller===settings.projectAccount,'verified_project_merchant_binding_required');
 requireThat(settings.providerCredentialEnvironment&&/^[A-Z][A-Z0-9_]{0,95}$/.test(settings.providerCredentialEnvironment),'provider_credential_reference_required');
 requireThat(settings.funding&&['native','oneclick'].includes(settings.funding.kind),'funding_plan_required');
 if(settings.funding.kind==='native')requireThat(uint(settings.funding.perAgentYocto)>0n,'native_funding_amount_required');
 for(const k of ['principalCapYocto','taskBudgetNano','callCapNano'])requireThat(uint(settings.agent?.[k])>0n,'explicit_agent_caps_required');
 const dir=dirname(resolve(outputPath));await mkdir(dir,{recursive:true,mode:0o700});requireThat(((await stat(dir)).mode&0o077)===0,'private_output_directory_required');
 const credentials=resolve(dir,'wallet-credentials');await mkdir(credentials,{recursive:true,mode:0o700});
 const limits={...settings.limits,deadlineMs:registration.offer_valid_until_ms,maxOutputTokens:registration.max_output_tokens};
 for(const k of ['gasReserveYocto','gasFloorYocto','merchantGasFloorYocto','merchantGasBudgetYocto','providerBudgetMicro','rateNanoPerNear'])uint(limits[k]);
 requireThat(Number.isInteger(limits.maximumProviderCalls)&&limits.maximumProviderCalls>=8&&limits.maximumProviderCalls<=32&&limits.grantDurationMs>0,'bounded_provider_call_allowance_required');
 requireThat(BigInt(limits.providerBudgetMicro)<=BigInt(registration.upstream_budget_micro_usd),'provider_approval_exceeded');
 const plan={version:4,walletProvider:'outlayer',network:settings.network,origin:settings.origin,realm:settings.realm,ownerAccount:settings.ownerAccount,projectAccount:settings.projectAccount,
  merchant:settings.merchantBinding.payer,merchantBinding:settings.merchantBinding,funding:settings.funding,limits,
  agents:state.buyers.slice(0,2).map((b,i)=>({...settings.agent,agentId:'agent-'+(i+1),userId:b.user,numbers:i===0?'3\n7\n32\n':'5\n5\n9\n'})),
  provider:{origin:registration.origin,model:registration.model,modelRevisionRef:registration.model_revision_ref,contextWindowTokens:registration.context_window_tokens,
   tokenizerRef:registration.tokenizer_ref,tokenizerUrl:registration.tokenizer_url,tokenizerFilesSha256:registration.tokenizer_files_sha256,rates:registration.rates,credentialEnvironment:settings.providerCredentialEnvironment}};
 const origin=new URL(plan.origin);requireThat(origin.origin===plan.origin&&origin.port,'explicit_loopback_or_reverse_proxy_port_required');
 const config={setupOnly:true,port:settings.listenPort??Number(origin.port),publicOrigin:plan.origin,activatedConfigPath:resolve(dir,'activated.json'),agentCredentials:state.buyers.slice(0,2).map(b=>({userId:b.user,token:b.token})),
  payments:{mode:'bounded',realBroadcastEnabled:true,network:settings.network,plan,databaseUrl:state.database,upstream:'http://127.0.0.1:1',nativeStateDirectory:base,nativeProfilesDirectory:resolve(dir,'profiles'),
   rpcUrl:settings.rpcUrl,credentialDirectory:credentials,hostBinary:resolve(settings.hostBinary),realm:plan.realm,merchant:plan.merchant,secret:randomBytes(32).toString('hex'),rateNanoPerNear:limits.rateNanoPerNear,
   storagePriceYocto:'10000000000000000000',gasEstimateYocto:limits.gasReserveYocto,paymentWindowMs:60000,leaseTailMs:15000,paymentEstimateMs:settings.paymentEstimateMs??3000,estimatedTerminalMs:settings.estimatedTerminalMs??5000,
   nativeTimeoutMs:100000,refundAuto:true,maxOutputTokens:limits.maxOutputTokens,port:0}};
 requireThat(new URL(plan.provider.origin).protocol==='https:'&&new URL(config.payments.rpcUrl).protocol==='https:','https_provider_and_rpc_required');
 await writeFile(resolve(outputPath),JSON.stringify(config,null,2)+'\n',{flag:'wx',mode:0o600});
 console.log(JSON.stringify({prepared:true,setupOnly:true,path:resolve(outputPath),credentialsDirectory:credentials,walletsCreated:0}));
} catch(error){console.error(/^[a-z_]+$/.test(error.message)?error.message:'private_setup_config_failed');process.exitCode=2;}
