import {readFileSync} from 'node:fs';
import {createTaskRuntime} from '../fx-runtime.mjs';
const c=JSON.parse(readFileSync(0,'utf8'));let cookie;
const fetcher=(url,init={})=>fetch(url,{...init,headers:{...init.headers,...(cookie?{cookie}:{})}});
const login=await fetcher(c.url+'/buyer-api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:c.ownerCode})});cookie=login.headers.get('set-cookie').split(';')[0];
const events=[];let done;
try{
 const runtime=await createTaskRuntime({url:c.url,sessionId:c.session,fetcher,backend:'native',force:c.force??true,onEvent:e=>events.push(e),fault:phase=>{if(c.crashAt===phase)process.exit(92);}});
 try{done=await runtime.run();}finally{await runtime.close();}
 console.log(JSON.stringify({result:done,events}));
}catch(e){console.log(JSON.stringify({error:e.message,events}));process.exitCode=1;}
