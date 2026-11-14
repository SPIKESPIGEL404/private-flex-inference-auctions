// The same fx engine + transport adapter runs in browsers and Node acceptance.
// Browser hosts use libfx's WASM export; Node uses its native addon. All model
// calls and durable virtual tools go through the authenticated hosted buyer.
import {createFxEngine,FxFencedError} from 'libfx';
import {TOOL} from './tool-schema.mjs';
const encode=bytes=>{let text='';for(let n=0;n<bytes.length;n+=32768)text+=String.fromCharCode(...bytes.subarray(n,n+32768));return btoa(text);};
const decode=text=>Uint8Array.from(atob(text),c=>c.charCodeAt(0));
export async function createTaskRuntime({url,sessionId,fetcher=fetch,backend,wasm,force=false,onEvent=()=>{},fault=()=>{}}){
 const root=url+'/buyer-api/sessions/'+sessionId;
 async function plain(path,input,headers={}){
  const response=await fetcher(path,{method:input===undefined?'GET':'POST',credentials:'same-origin',redirect:'error',headers:{'content-type':'application/json',...headers},...(input===undefined?{}:{body:JSON.stringify(input)})});
  if(!response.ok){const value=await response.json().catch(()=>({}));const code=value.error?.code??'buyer_unavailable';if(/fenced/.test(code))throw new FxFencedError(code);const error=new Error(code);error.status=response.status;throw error;}
  return response.json();
 }
 const status=await plain(root);if(status.state==='complete')return {alreadyComplete:true,result:status.result,async close(){},async run(){return status.result;}};
 const writer=Array.from(crypto.getRandomValues(new Uint8Array(32)),x=>x.toString(16).padStart(2,'0')).join('');
 const claimed=await plain(root+'/claim',{writer,expectedGeneration:status.generation,force});
 const headers={'x-fx-writer':writer,'x-fx-generation':String(claimed.generation)};
 const api=(op,input)=>plain(root+'/'+op,input,headers);
 let engine,turn,closed=false,modelCount=0;
 const timer=setInterval(()=>{if(!closed)void api('heartbeat',{}).catch(()=>{turn?.cancel({reason:'handoff'});});},1500);
 try{
  engine=await createFxEngine({...(backend?{backend}:{}),...(wasm?{wasm}:{}),sessionId,
   provider:{name:'controlled',baseUrl:url+'/v1',models:{'m/external':{contextWindow:32000,maxOutputTokens:64,supportsToolUse:true,supportsVision:false}}},model:'m/external',
   instructions:'Use the virtual bash tool to complete the task from /workspace/task.txt. Verify /workspace/result.txt before reporting completion. Payment and procurement are managed by the host; never call payment or network tools.',
   persistence:{marks:true,load:async()=>{const value=await api('journal',{load:true});return {journal:value.journal.map(r=>({cursor:r.cursor,data:decode(r.data)}))};},
    append:async record=>api('journal',{expected:record.expected,idempotencyKey:record.idempotencyKey,data:encode(record.data),marks:record.marks??[],barrier:record.barrier})},
   tools:[{...TOOL,idempotent:true,writes:true,execute:async(input,context)=>{
    let result;
    for(let attempt=0;;attempt++){
     if(context.signal.aborted)throw new DOMException('Aborted','AbortError');
     try{result=await api('tool',{executionId:context.executionId,command:input.command});break;}
     catch(e){if(attempt>=40||!(e.status===503||e instanceof TypeError))throw e;await new Promise(r=>setTimeout(r,100));}
    }
    await fault('after_tool',result);return result;
   }}],
   fetch:async(input,init)=>{
    if(String(input)!==url+'/v1/chat/completions'||init.method?.toUpperCase()!=='POST')throw new Error('unsupported_fx_transport');
    const raw=typeof init.body==='string'?init.body:new TextDecoder('utf-8',{fatal:true}).decode(init.body);
    const response=await fetcher(String(input),{method:'POST',credentials:'same-origin',redirect:'error',headers:{'content-type':'application/json','x-fx-session':sessionId,...(status.fxStarted?{'x-fx-recovery':'libfx-0.0.16'}:{}),...headers},body:raw});
    if(response.ok){modelCount++;await fault('after_model_'+modelCount,response.clone());}
    return response;
   },onEvent,
  });
 }catch(e){closed=true;clearInterval(timer);throw e;}
 return {generation:claimed.generation,engine,async run(){
  // The task prompt/call are durable before payment; fx journal replay and the
  // hosted original-response cache recover even before its first journal mark.
  turn=engine.resume({onAmbiguous:call=>call.name==='bash'?'rerun':undefined});
  if(!turn){if(status.fxStarted){const latest=await plain(root);if(latest.result)return latest.result;throw new Error('original_turn_state_unknown');}
   turn=engine.prompt(status.task?status.workspace['/workspace/task.txt']:'Complete the configured task.',{turnId:'task-'+sessionId});}
  for await(const event of turn)onEvent(event);
  const result=await turn.result;await fault('before_finish',result);await api('finish',result);return result;
 },async close(){closed=true;clearInterval(timer);turn?.cancel({reason:'handoff'});await engine.close();}};
}
