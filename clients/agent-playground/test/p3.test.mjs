import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

const source=ts.transpileModule(await readFile(new URL('../src/p3.ts',import.meta.url),'utf8'),{
 compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext},
}).outputText;

async function page({paused=true,resumeError}={}){
 class Element{
  children=[];textContent='';disabled=false;
  append(...children){this.children.push(...children);}
  replaceChildren(...children){this.children=children;}
  setAttribute(){}
 }
 const root=new Element(),events=[];
 const config={phase:'P3',network:'testnet',mode:'controlled',plan:{agents:[{agentId:'agent-1'}]}};
 const status=()=>({state:paused?'paused':'ready',task:{paused,revision:'7'},transcript:''});
 class Connector{
  handlers=new Map();
  on(name,fn){this.handlers.set(name,fn);}
  off(name){this.handlers.delete(name);}
  async connect(){this.handlers.get('wallet:signInAndSignMessage')({accounts:[{signedMessage:{}}]});}
 }
 const context=vm.createContext({document:{getElementById:()=>root,createElement:()=>new Element()},
  location:{origin:'http://127.0.0.1:9000'},atob,Uint8Array,crypto:{randomUUID:()=> 'resume-operation'},
  fetch:async(url,init)=>{
   const path=url.replace('/buyer-api',''),body=init.body?JSON.parse(init.body):undefined;
   events.push({path,body});let value;
   if(path==='/config')value=config;
   else if(path==='/auth/challenge')value={id:'login',payload:{nonce:btoa('x'.repeat(32))}};
   else if(path==='/auth/verify')value={owner:'owner.testnet'};
   else if(path==='/agents')value={agents:[{id:'session-1',agent_id:'agent-1',payer:'agent.testnet',state:status().state}]};
   else if(path==='/sessions/session-1')value=status();
   else if(path==='/sessions/session-1/control'){
    assert.equal(body.action,'resume');
    if(resumeError)return {ok:false,json:async()=>({error:{code:resumeError}})};
    paused=false;value={revision:'8'};
   }else throw Error('unexpected request '+path);
   return {ok:true,json:async()=>value};
  },
 });
 const module=new vm.SourceTextModule(source,{context});
 await module.link(specifier=>{
  const exports=specifier.includes('near-connect')?{NearConnector:Connector}:
   specifier.includes('fx-runtime')?{createTaskRuntime:async()=>{
    events.push({path:'runtime/claim'});assert.equal(paused,false);
    return {async run(){events.push({path:'runtime/run'});},async close(){}};
   }}:{};
  return new vm.SyntheticModule(Object.keys(exports),function(){for(const [k,v] of Object.entries(exports))this.setExport(k,v);},{context});
 });
 await module.evaluate();
 const elements=()=>{const all=[];const walk=e=>{all.push(e);e.children.forEach(walk);};walk(root);return all;};
 const click=async label=>{const b=elements().find(e=>e.textContent===label);assert.ok(b,'missing button '+label);await b.onclick();};
 await click('Connect NEAR wallet');
 return {events,click,elements};
}

test('paused task resumes at the latest revision before runtime claim',async()=>{
 const p=await page();assert.ok(!p.events.some(e=>e.path==='runtime/claim'));
 await p.click('Resume task');
 const resume=p.events.findIndex(e=>e.path.endsWith('/control'));
 assert.deepEqual(p.events[resume].body,{action:'resume',expectedRevision:'7',operation:'resume-operation'});
 assert.equal(p.events[resume-1].path,'/sessions/session-1');
 assert.ok(resume<p.events.findIndex(e=>e.path==='runtime/claim'));
 assert.ok(p.events.some(e=>e.path==='runtime/run'));
});
test('ready task runs without changing its control revision',async()=>{
 const p=await page({paused:false});await p.click('Run task');
 assert.ok(!p.events.some(e=>e.path.endsWith('/control')));
 assert.ok(p.events.some(e=>e.path==='runtime/run'));
});
for(const resumeError of ['revision_conflict','run_authorization_required'])test(resumeError+' prevents runtime claim',async()=>{
 const p=await page({resumeError});await p.click('Resume task');
 assert.ok(!p.events.some(e=>e.path==='runtime/claim'));
 assert.ok(p.elements().some(e=>e.textContent===resumeError));
});
