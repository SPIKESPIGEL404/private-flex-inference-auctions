import {useCallback,useEffect,useRef,useState} from 'react';
import {Terminal} from '@wterm/react';
import {GhosttyCore} from '@wterm/ghostty';
import type {WTerm} from '@wterm/dom';
import ghosttyWasm from '@wterm/ghostty/ghostty-vt.wasm?url';
import fxWasm from '../node_modules/libfx/fx-core.wasm?url';
import {createTaskRuntime} from '../../../services/mpp-near-direct/p2/fx-runtime.mjs';
type Agent={id:string;agent_id:string;payer:string;state:string;paused:boolean;revision:string;generation:string;preference:string;budget_nano:string;reserved_nano:string;spent_nano:string;prompt:string};
type Status={state:string;transcript:string;workspace:Record<string,string>;calls:Array<{id:string;state:string;revision:string;bid_nano:string;manual:boolean;decision?:{result:{reason?:string}}}>;orders:Array<{state:string;principal:{P:string;C:string;H:string;W:string;R:string}}>};
const usd=(value:string)=>{const v=BigInt(value);return '$'+v/1000000000n+'.'+String(v%1000000000n).padStart(9,'0').replace(/0{1,6}$/,'');};
async function api(path:string,body?:unknown,method?:string){const res=await fetch('/buyer-api/'+path,{credentials:'same-origin',redirect:'error',method:method??(body?'POST':'GET'),headers:{'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const value=await res.json();if(!res.ok)throw new Error(value.error?.code??'请求失败');return value;}
function Pane({agent,refresh,park}:{agent:Agent;refresh:()=>void;park:()=>void}){
 const [core,setCore]=useState<GhosttyCore>();const [detail,setDetail]=useState<Status>();const [error,setError]=useState('');const [busy,setBusy]=useState(false);const [terminalReady,setTerminalReady]=useState(false);
 const terminal=useRef<WTerm|null>(null),runtime=useRef<Awaited<ReturnType<typeof createTaskRuntime>>|null>(null),running=useRef(false),disposed=useRef(false);
 const load=useCallback(async()=>{try{setDetail(await api('sessions/'+agent.id));}catch(e){if(!disposed.current)setError((e as Error).message);}},[agent.id]);
 useEffect(()=>{if(terminalReady&&!busy&&detail?.transcript)terminal.current?.write('\x1b[2J\x1b[H'+detail.transcript.replace(/\n/g,'\r\n'));},[terminalReady,busy,detail?.transcript]);
 useEffect(()=>{disposed.current=false;let loaded:GhosttyCore|undefined;void GhosttyCore.load({wasmPath:ghosttyWasm,backgroundColor:'#090b0d',foregroundColor:'#e4eadf',scrollbackLines:1000,imageStorageLimit:0}).then(c=>{if(disposed.current)c.dispose();else{loaded=c;setCore(c);}}).catch(e=>setError(e.message));
  const timer=setInterval(()=>void load(),700);void load();return()=>{disposed.current=true;clearInterval(timer);void runtime.current?.close().catch(()=>{});runtime.current=null;loaded?.dispose();};},[agent.id,load]);
 const control=async(action:string,extra:Record<string,unknown>={})=>{setError('');const result=await api('sessions/'+agent.id+'/control',{action,expectedRevision:agent.revision,operation:crypto.randomUUID(),...extra});refresh();void load();return result;};
 const start=async()=>{if(running.current)return;running.current=true;setBusy(true);setError('');
  try{if(agent.paused)await control('resume');
   const r=await createTaskRuntime({url:location.origin,sessionId:agent.id,wasm:fxWasm,force:false,onEvent:(e:Record<string,unknown>)=>{
    if(disposed.current)return;if(e.type==='text_delta')terminal.current?.write(String(e.text??e.delta??''));
    if(e.type==='tool_call')terminal.current?.write('\r\n[工具执行]\r\n');}});
   if(disposed.current){await r.close();return;}runtime.current=r;terminal.current?.write('\x1b[2J\x1b[H> '+agent.prompt+'\r\n');const result=await r.run();terminal.current?.write('\r\n['+result.stopReason+']\r\n');await r.close();runtime.current=null;
  }catch(e){if(!disposed.current)setError((e as Error).message);}finally{await runtime.current?.close().catch(()=>{});runtime.current=null;running.current=false;if(!disposed.current){setBusy(false);refresh();void load();}}};
 const pause=async()=>{setBusy(true);try{await control('pause');await runtime.current?.close();runtime.current=null;return true;}catch(e){setError((e as Error).message);return false;}finally{setBusy(false);}};
 const remove=async()=>{if(agent.state==='complete'||await pause())park();};
 return <section className="pane" aria-label={agent.agent_id+'任务'}>
  <div className="pane-title"><strong>{agent.agent_id}</strong><span>{detail?.state??agent.state}</span><button onClick={()=>void remove()} aria-label={'停放'+agent.agent_id}>−</button></div>
  <div className="identity">{agent.payer} · 虚拟 NEAR 本金与 gas</div>
  <div className="meter"><span>已扣 {usd(agent.spent_nano)}</span><span>占用 {usd(agent.reserved_nano)}</span><span>预算 {usd(agent.budget_nano)}</span></div>
  <div className="terminal">{core?<Terminal core={core} autoResize onReady={wt=>{terminal.current=wt;setTerminalReady(true);}} onData={()=>{}} scrollbackLines={1000}/>:<p>加载终端…</p>}</div>
  <div className="actions"><button disabled={busy||agent.state==='complete'} onClick={()=>void start()}>{agent.paused?'恢复任务':'开始 / 恢复'}</button><button disabled={agent.paused||agent.state==='complete'} onClick={()=>void pause()}>暂停</button>
   <label>偏好 <select value={agent.preference} disabled={busy} onChange={e=>void control('preference',{preference:e.target.value}).catch(e=>setError(e.message))}><option value="save">节省</option><option value="balanced">平衡</option><option value="fast">尽快</option></select></label></div>
  {error?<p className="error" role="alert">{error}</p>:null}
  <div className="procurement">{detail?.calls.map(c=><div key={c.id}>{c.state} · bid {usd(c.bid_nano)} · {c.manual?'手动':'自动'}<span>{c.decision?.result.reason??''}</span>
   {c.state==='bidding'?<><button onClick={()=>void api('calls/'+c.id,{action:'revise_bid',bidNano:'1',expectedRevision:c.revision,operation:crypto.randomUUID()},'PATCH').then(load).catch(e=>setError(e.message))}>降低出价并暂停自动加价</button><button onClick={()=>void api('calls/'+c.id,{action:'resume_auto',expectedRevision:c.revision,operation:crypto.randomUUID()},'PATCH').then(load).catch(e=>setError(e.message))}>恢复自动竞价</button></>:null}</div>)}</div>
  {detail?.workspace['/workspace/result.txt']?<pre className="artifact" aria-label={agent.agent_id+'产物'}>result.txt: {detail.workspace['/workspace/result.txt']}</pre>:null}
  <details><summary>本金与退款</summary>{detail?.orders.map((o,i)=><p key={i}>{o.state} · 已收 {o.principal.P} · 已扣 {o.principal.C} · 待退 {o.principal.W} · 已退 {o.principal.R} yoctoNEAR</p>)}</details>
 </section>;
}
export default function App(){
 const [agents,setAgents]=useState<Agent[]|null>(null),[code,setCode]=useState(''),[error,setError]=useState(''),[parked,setParked]=useState<string[]>([]),[ownerEpoch,setOwnerEpoch]=useState(0),[newTask,setNewTask]=useState(false),[prompt,setPrompt]=useState(''),[chosenAgent,setChosenAgent]=useState('agent-1');
 const authEpoch=useRef(0),authenticated=agents!==null;
 const refresh=useCallback(()=>{const epoch=authEpoch.current;void api('agents').then(v=>{if(epoch===authEpoch.current)setAgents(v.agents);}).catch(e=>{if(epoch!==authEpoch.current)return;if(e.message==='unauthorized')setAgents(null);else setError(e.message);});},[]);
 useEffect(refresh,[refresh]);
 useEffect(()=>{if(!authenticated)return;const t=setInterval(refresh,1000);return()=>clearInterval(t);},[authenticated,refresh]);
 const logout=async()=>{authEpoch.current++;try{await api('logout',{});authEpoch.current++;setOwnerEpoch(n=>n+1);setAgents(null);setParked([]);setNewTask(false);setPrompt('');setChosenAgent('agent-1');setError('');}catch(e){setError((e as Error).message);}};
 return <main><header><h1>Private Market <span>agents · 受控演示</span></h1>{agents?<button onClick={()=>void logout()}>退出 / 切换 owner</button>:null}</header>
  <div className="notice">受控 P2 · 真实 fx、工具工作区与 Market 账本；模型响应和 NEAR 回执为本地 fixtures，未发生真实付款。</div>
  {error?<p className="error" role="alert">{error}</p>:null}
  {!agents?<form className="login" onSubmit={e=>{e.preventDefault();authEpoch.current++;setError('');void api('login',{code}).then(()=>{authEpoch.current++;setCode('');setParked([]);setNewTask(false);setPrompt('');setChosenAgent('agent-1');setOwnerEpoch(n=>n+1);refresh();}).catch(e=>setError(e.message));}}><h2>打开受控工作区</h2><label>访问码<input type="password" autoComplete="off" value={code} onChange={e=>setCode(e.target.value)} required/></label><button type="submit">进入</button><p>此环境使用脚本模型和虚拟资金，不会发生真实付款。</p></form>
   :<><nav><button onClick={()=>setNewTask(v=>!v)}>新任务</button>{agents.filter(a=>parked.includes(a.id)).map(a=><button key={a.id} onClick={()=>setParked(v=>v.filter(id=>id!==a.id))}>恢复 {a.agent_id} pane</button>)}</nav>
    {newTask?<form className="new-task" onSubmit={e=>{e.preventDefault();void api('agents/'+chosenAgent+'/tasks',{prompt,budgetNano:'10000000',preference:'balanced'}).then(()=>{setPrompt('');setNewTask(false);refresh();}).catch(e=>setError(e.message));}}><label>agent <select value={chosenAgent} onChange={e=>setChosenAgent(e.target.value)}><option>agent-1</option><option>agent-2</option></select></label><label>任务 <input value={prompt} maxLength={1000} required onChange={e=>setPrompt(e.target.value)}/></label><button>创建 · $0.01 上限</button></form>:null}
    <div className="grid" key={ownerEpoch}>{agents.filter(a=>!parked.includes(a.id)).map(a=><Pane key={a.id} agent={a} refresh={refresh} park={()=>setParked(v=>[...v,a.id])}/>)}</div></>}
 </main>;
}
