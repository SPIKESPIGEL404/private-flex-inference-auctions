import {hash,requireThat,uint,account} from '../contract.mjs';
import {publicKey,uuid} from './outlayer.mjs';
export function validatePlan(p,{now=Date.now(),allowExpired=false}={}) {
 requireThat(p?.version===4&&p.walletProvider==='outlayer'&&['testnet','mainnet'].includes(p.network),'invalid_outlayer_run_plan');
 const origin=new URL(p.origin);requireThat(origin.origin===p.origin&&(origin.protocol==='https:'||(origin.protocol==='http:'&&origin.hostname==='127.0.0.1')),'invalid_run_origin');
 requireThat(account.test(p.ownerAccount)&&account.test(p.merchant)&&account.test(p.projectAccount),'invalid_run_accounts');
 requireThat(Array.isArray(p.agents)&&p.agents.length===2&&new Set(p.agents.map(a=>a.payer)).size===2&&new Set(p.agents.map(a=>a.userId)).size===2,'two_independent_agents_required');
 for(const b of [...p.agents,p.merchantBinding]) {
  requireThat(b&&uuid(b.walletId)&&/^[a-zA-Z0-9_-]{1,96}$/.test(b.credentialRef)&&b.network===p.network
   &&/^[0-9a-f]{64}$/.test(b.payer)&&publicKey(b.publicKey).hex===b.payer&&b.refundTo===b.payer
   &&typeof b.version==='string'&&b.version.length<=128&&b.signingRecipient===p.realm
   &&Number.isSafeInteger(b.policy?.version)&&b.policy.version>0&&/^[a-f0-9]{64}$/.test(b.policy.encryptedHash),'invalid_outlayer_binding');
 }
 requireThat(p.merchantBinding.payer===p.merchant&&p.merchantBinding.policy.controller===p.projectAccount,'merchant_binding_mismatch');
 for(const a of p.agents) {
  requireThat(a.policy.controller===p.ownerAccount&&a.merchant===p.merchant&&a.payer!==p.merchant
   &&/^agent-[12]$/.test(a.agentId)&&typeof a.userId==='string'&&a.userId.length<=128,'agent_owner_mismatch');
  for(const k of ['principalCapYocto','taskBudgetNano','callCapNano'])requireThat(uint(a[k])>0n,'invalid_agent_cap');
 }
 requireThat(new Set(p.agents.map(a=>a.agentId)).size===2,'duplicate_agent');
 const l=p.limits;requireThat(l&&Number.isSafeInteger(l.deadlineMs)&&(allowExpired||l.deadlineMs>now)&&l.deadlineMs<=now+86400000
  &&Number.isInteger(l.maxOutputTokens)&&l.maxOutputTokens>=64&&l.maxOutputTokens<=512
  &&Number.isInteger(l.maximumProviderCalls)&&l.maximumProviderCalls>0&&l.maximumProviderCalls<=32
  &&Number.isSafeInteger(l.grantDurationMs)&&l.grantDurationMs>0&&l.grantDurationMs<=86400000,'invalid_run_limits');
 for(const k of ['gasReserveYocto','gasFloorYocto','merchantGasFloorYocto','merchantGasBudgetYocto','providerBudgetMicro','rateNanoPerNear'])uint(l[k]);
 requireThat(uint(l.gasReserveYocto)>0n&&uint(l.providerBudgetMicro)>0n&&uint(l.rateNanoPerNear)>0n,'invalid_run_budget');
 const text=JSON.stringify(p);requireThat(!/"(?:apiKey|privateKey|secret|grantToken|token|authorization)"\s*:/i.test(text),'secrets_forbidden_in_run_plan');
 requireThat(p.provider&&typeof p.provider.model==='string'&&p.provider.rates&&typeof p.provider.tokenizerRef==='string','qualified_provider_required');
 for(const k of ['input','cache_input','output'])requireThat(Number.isSafeInteger(p.provider.rates[k])&&p.provider.rates[k]>0,'invalid_provider_rates');
 return {plan:p,id:hash(p)};
}
