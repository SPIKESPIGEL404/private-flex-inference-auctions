import {readFileSync} from 'node:fs';
import {createTaskRuntime} from '../../p2/fx-runtime.mjs';
const c=JSON.parse(readFileSync(0,'utf8'));
const fetcher=(url,init={})=>fetch(url,{...init,headers:{...init.headers,cookie:c.cookie,origin:c.url}});
const events=[];
try{
 const runtime=await createTaskRuntime({url:c.url,sessionId:c.session,fetcher,backend:'native',force:true,onEvent:e=>events.push(e),fault:phase=>{if(c.crashAt===phase)process.exit(92);}});
 try{console.log(JSON.stringify({result:await runtime.run(),events}));}finally{await runtime.close();}
}catch(e){console.log(JSON.stringify({error:e.message,events}));process.exitCode=1;}
