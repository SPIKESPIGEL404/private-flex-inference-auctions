import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeRecoveryBody} from '../intent.mjs';
import {completion} from '../../p1/server.mjs';
const base={model:'m/external',messages:[{role:'user',content:'Compute sum'},{role:'assistant',content:null,tool_calls:[{id:'t',type:'function',function:{name:'bash',arguments:'{"command":"cat result.txt"}'}}]},{role:'tool',content:'42',tool_call_id:'t'}],max_tokens:64};
const notes=[{role:'user',content:'Resuming from unexpected session interruption.'},{role:'user',content:'Continue from the confirmed tool result above without repeating the tool.'}];
test('pinned fx recovery-only suffix maps back to frozen native intent',()=>{
 const raw=JSON.stringify(base),resumed=JSON.stringify({...base,messages:[...base.messages,...notes]});
 assert.equal(normalizeRecoveryBody(resumed,true),raw);assert.equal(normalizeRecoveryBody(resumed,false),resumed);
 for(const suffix of [[notes[0]],[notes[1]],[notes[1],notes[0]],[notes[0],{...notes[1],name:'user'}]]){
  const changed=JSON.stringify({...base,messages:[...base.messages,...suffix]});assert.equal(normalizeRecoveryBody(changed,true),changed);
 }
 const interposed=JSON.stringify({...base,messages:[...base.messages,{role:'user',content:'changed task'},...notes]});assert.equal(normalizeRecoveryBody(interposed,true),interposed);
});
test('recovery does not drop changed user instructions or output limits',()=>{
 const changed={...base,max_tokens:63,messages:[...base.messages,...notes,{role:'user',content:'Use another model'}]};
 assert.notEqual(normalizeRecoveryBody(JSON.stringify(changed),true),JSON.stringify(base));
 assert.notEqual(normalizeRecoveryBody(JSON.stringify({...base,max_tokens:63,messages:[...base.messages,...notes]}),true),JSON.stringify(base));
});
test('literal first-turn user text is never treated as recovery control',()=>{
 const raw=JSON.stringify({model:'m/external',messages:notes,max_tokens:64});assert.equal(normalizeRecoveryBody(raw,true),raw);
});
test('recovery notes carrying extra fields remain part of the request',()=>{
 const raw=JSON.stringify({...base,messages:[...base.messages,{...notes[0],name:'user'}]});assert.equal(normalizeRecoveryBody(raw,true),raw);
});
test('native SSE ids and fragmented tool arguments reconstruct exactly',()=>{
 const frames=[{id:'original',created:1,model:'m/external',choices:[{index:0,delta:{role:'assistant',tool_calls:[{index:0,id:'t',type:'function',function:{name:'bash',arguments:'{"command":'}}]},finish_reason:null}]},
 {choices:[{index:0,delta:{tool_calls:[{index:0,function:{arguments:'"cat result.txt"}'}}]},finish_reason:'tool_calls'}]},
 {choices:[],usage:{prompt_tokens:512,completion_tokens:4,total_tokens:516}}];
 const body=frames.map((f,i)=>`id: ${i+1}\ndata: ${JSON.stringify(f)}\n\n`).join('')+'data: [DONE]\n\n';
 const result=completion(body);assert.deepEqual(result.choices[0].message.tool_calls,base.messages[1].tool_calls);
 assert.throws(()=>completion(body.replace('data: [DONE]\n\n','')),/terminal_unavailable/);
});
