// One controlled agent's model transport: direct native Proxy chat, official
// mppx 402 handling, durable fixture wallet operation keyed by the original order.
import { readFileSync } from 'node:fs';
import { createModelTransport } from '../client.mjs';
const c=JSON.parse(readFileSync(0,'utf8'));
let proof;
const transport=createModelTransport({recoverOriginalPayment:async challenge=>{
 const response=await fetch(c.wallet+'/wallet/pay',{method:'POST',headers:{'content-type':'application/json','x-fixture-key':c.fixtureKey},body:JSON.stringify({challenge})});
 if(!response.ok)throw new Error('wallet_refused');
 const paid=await response.json();proof=paid.credential;return proof;
}});
try{
 const init={method:'POST',headers:{authorization:'Bearer '+c.token,
  'content-type':'application/json','idempotency-key':c.key,'x-agent-task':c.task},body:JSON.stringify(c.body)};
 const {response}=await transport(c.url+'/v1/chat/completions',init);
 console.log(JSON.stringify({status:response.status,body:await response.text(),headers:Object.fromEntries(response.headers),proof}));
}catch(e){console.log(JSON.stringify({error:e.message,proof}));}
