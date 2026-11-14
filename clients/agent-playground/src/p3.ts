import {NearConnector} from '@hot-labs/near-connect';
import type {SignedMessage,EventMap} from '@hot-labs/near-connect';
import {createTaskRuntime} from '../../../services/mpp-near-direct/p2/fx-runtime.mjs';
import './p3.css';

const root=document.getElementById('root')!;
const title=document.createElement('h1');title.textContent='Agent wallets';root.append(title);
const note=document.createElement('p');root.append(note);
const log=document.createElement('pre');log.setAttribute('role','status');
const controls=document.createElement('div');root.append(controls);
const agents=document.createElement('section');root.append(agents,log);
const bytes=(s:string)=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
async function api(path:string,body?:unknown){
 const r=await fetch('/buyer-api'+path,{method:body===undefined?'GET':'POST',credentials:'same-origin',redirect:'error',headers:{'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const value=await r.json();if(!r.ok)throw Error(value.error?.code??value.error??'operation_unavailable');return value;
}
let config=await api('/config');
note.textContent=`${config.network} · ${config.mode}. Each agent pays its own NEAR principal and gas. Merchant refunds return to that agent; merchant pays refund gas.`;
const connector=new NearConnector({network:config.network,autoConnect:false,features:{signInAndSignMessage:true,signMessage:true,signAndSendTransactions:true}});
let owner:string|null=null,epoch=0;
const running=new Map<string,Awaited<ReturnType<typeof createTaskRuntime>>>();
async function clear(){epoch++;owner=null;agents.replaceChildren();for(const r of running.values())await r.close();running.clear();}
function button(label:string,fn:()=>Promise<void>,parent:HTMLElement=controls){
 const b=document.createElement('button');b.textContent=label;b.onclick=async()=>{b.disabled=true;try{log.textContent='';await fn();}catch(e){log.textContent=e instanceof Error?e.message:'operation_unknown';}finally{b.disabled=false;}};parent.append(b);return b;
}
connector.on('wallet:signOut',()=>{void clear().then(()=>api('/logout',{})).catch(()=>{});});
connector.on('wallet:signIn',event=>{if(owner&&!event.accounts.some(a=>a.accountId===owner))void clear().then(()=>api('/logout',{})).catch(()=>{});});
button('Connect NEAR wallet',async()=>{
 const c=await api('/auth/challenge',{});let signed:SignedMessage|undefined;
 const handler=(event:EventMap['wallet:signInAndSignMessage'])=>{signed=event.accounts[0]?.signedMessage;};
 connector.on('wallet:signInAndSignMessage',handler);
 try{await connector.connect({signMessageParams:{...c.payload,nonce:bytes(c.payload.nonce)}});}finally{connector.off('wallet:signInAndSignMessage',handler);}
 if(!signed)throw Error('wallet_did_not_sign');const s=await api('/auth/verify',{id:c.id,signed});owner=s.owner;config=await api('/config');await refresh();
});
if(config.phase!=='setup')for(const role of ['owner','project'])button(role==='owner'?'Authorize agent spending':'Authorize project provider costs',async()=>{
 if(!owner)throw Error('connect_wallet_first');
 const c=await api('/authorization/challenge',{role}),{wallet,accounts}=await connector.getConnectedWallet();
 if(!accounts.some(a=>a.accountId===owner))throw Error('owner_session_changed');
 const signed=await wallet.signMessage({...c.payload,nonce:bytes(c.payload.nonce)});await api('/authorization/verify',{id:c.id,signed});log.textContent='Run authorization recorded.';
});
if(config.phase!=='setup')for(const role of ['owner','project'])button(role==='owner'?'Revoke agent spending':'Revoke project costs',async()=>{await api('/authorization/revoke',{role});for(const r of running.values())await r.close();running.clear();await refresh();});
button('Refresh',refresh);
button('Disconnect',async()=>{await api('/logout',{});await clear();await connector.disconnect();});
async function refresh(){
 if(!owner)return;const current=epoch,result=await api('/agents');if(current!==epoch)return;agents.replaceChildren();
 if(result.setup){await setupCards(result.agents);return;}
 for(const a of result.agents){
  const card=document.createElement('article'),heading=document.createElement('h2'),status=document.createElement('p'),transcript=document.createElement('pre');
  heading.textContent=a.agent_id;status.textContent=`${a.payer} · ${a.state}`;card.append(heading,status,transcript);agents.append(card);
  const s=await api('/sessions/'+a.id);if(current!==epoch)return;transcript.textContent=s.transcript;
  const binding=config.plan.agents.find((b:{agentId:string})=>b.agentId===a.agent_id);
  if(binding&&a.fundingReady){const funding=document.createElement('p');funding.textContent=`Native NEAR funding destination: ${binding.payer}. Fund only after the owner-controlled policy is independently confirmed.`;card.append(funding);}
  button('Run task',async()=>{
   if(running.has(a.id))throw Error('task_already_running');
   const r=await createTaskRuntime({url:location.origin,sessionId:a.id,onEvent:()=>{}});running.set(a.id,r);
   try{await r.run();}finally{await r.close();running.delete(a.id);await refresh();}
  },card);
  button('Pause task',async()=>{
   const latest=await api('/sessions/'+a.id);await api('/sessions/'+a.id+'/control',{action:'pause',expectedRevision:latest.task.revision,operation:crypto.randomUUID()});
   await running.get(a.id)?.close();running.delete(a.id);await refresh();
  },card);
 }
}

async function connectedWallet(){const w=await connector.getConnectedWallet();if(!w.accounts.some(a=>a.accountId===owner))throw Error('connect_original_owner');return w.wallet;}
async function setupCards(rows:Array<{agent_id:string;state:string;payer?:string;fundingAllowed?:boolean;funding?:{id:string;state:string}}>){
 for(const a of rows){
  const card=document.createElement('article'),h=document.createElement('h2'),state=document.createElement('p'),preview=document.createElement('pre');
  h.textContent=a.agent_id;state.textContent=a.state;card.append(h,state,preview);agents.append(card);
  if(a.state==='not_created')button('Create agent wallet',async()=>{await api('/wallets/'+a.agent_id+'/create',{});await refresh();},card);
  if(a.state==='policy_pending'||a.state==='awaiting_policy')button('Review and set spend policy',async()=>{
   const prepared=await api('/wallets/'+a.agent_id+'/policy',{});preview.textContent=JSON.stringify(prepared.policy,null,2);
   if(prepared.alreadyInstalled){await refresh();return;}
   button('Sign displayed policy',async()=>{const wallet=await connectedWallet();await wallet.signAndSendTransactions({transactions:[prepared.transaction]});await api('/wallets/'+a.agent_id+'/confirm',{});await refresh();},card);
  },card);
  if(a.fundingAllowed){
   const destination=document.createElement('p');destination.textContent='Verified agent NEAR account: '+a.payer;card.append(destination);
   if(!a.funding)button('Fund this agent',async()=>{
    const prepared=await api('/wallets/'+a.agent_id+'/funding',{});
    if(config.plan.funding.kind==='oneclick'){preview.textContent=JSON.stringify(prepared,null,2);return;}
    const wallet=await connectedWallet(),result:unknown=await wallet.signAndSendTransactions({transactions:[prepared.transaction]});
    const values=Array.isArray(result)?result:[result];
    const txHash=values.map((v:unknown)=>{const r=v as {transaction?:{hash?:string};transaction_outcome?:{id?:string}};return r?.transaction?.hash??r?.transaction_outcome?.id;}).find(Boolean);
    if(!txHash)throw Error('funding_sent_restore_original_transaction_hash_do_not_send_again');
    await api('/wallets/'+a.agent_id+'/funding-confirm',{txHash});await refresh();
   },card);
   if(a.funding){
    const state=document.createElement('p');state.textContent='Funding: '+a.funding.state;card.append(state);
    if(a.funding.state!=='native_final'){const input=document.createElement('textarea');input.placeholder=config.plan.funding.kind==='oneclick'?'Original deposit/destination evidence JSON':'Original funding transaction hash';card.append(input);
     button('Verify original funding',async()=>{await api('/wallets/'+a.agent_id+'/funding-confirm',config.plan.funding.kind==='oneclick'?{...JSON.parse(input.value),id:a.funding!.id}:{txHash:input.value.trim()});await refresh();},card);
    }
   }
   button('Freeze this agent',async()=>{const tx=await api('/wallets/'+a.agent_id+'/freeze',{});await (await connectedWallet()).signAndSendTransactions({transactions:[tx]});await refresh();},card);
  }
 }
 button('Activate funded run',async()=>{await api('/setup/activate',{});log.textContent='Starting the funded run. Reconnect and authorize the frozen run plan.';setTimeout(()=>location.reload(),2000);},agents);
}
