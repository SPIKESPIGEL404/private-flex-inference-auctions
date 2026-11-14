import {Tasks as DurableTasks} from '../p2/tasks.mjs';
import {requireThat} from '../contract.mjs';
import {verifyPolicy} from './outlayer.mjs';
export class Tasks extends DurableTasks {
 async list(owner){
  const rows=await super.list(owner);
  for(const row of rows){try{await verifyPolicy({binding:this.a.binding(row.user_id??(await this.pool.query('SELECT user_id FROM mpp_direct_agents WHERE agent_id=$1',[row.agent_id])).rows[0].user_id),rpc:this.a.rpc,api:this.a.services.api});row.fundingReady=true;}catch{row.fundingReady=false;}}
  return rows;
 }
 async owner(token){return (await this.a.services.auth.session(token)).owner_id;}
 async claim(owner,id,input){await this.a.services.auth.requireGrant(owner);return super.claim(owner,id,input);}
 async context(owner,...args){await this.a.services.auth.requireGrant(owner);return super.context(owner,...args);}
 async create(){throw new Error('bounded_run_has_two_frozen_tasks');}
 async control(owner,kind,id,input){
  if(input.action==='resume')await this.a.services.auth.requireGrant(owner);
  if(input.action==='budget'){
   const s=await this.session(owner,id),binding=this.a.config.plan.agents.find(a=>a.agentId===s.agent_id);requireThat(binding&&BigInt(input.budgetNano)<=BigInt(binding.taskBudgetNano),'new_owner_authorization_required');
  }
  return super.control(owner,kind,id,input);
 }
 async status(owner,id){return {...await super.status(owner,id),runtime:{providerName:'native-mpp',contextWindow:this.a.config.plan.provider.contextWindowTokens,maxOutputTokens:this.a.config.plan.limits.maxOutputTokens}};}
}
