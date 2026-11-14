import { Mppx } from 'mppx/client';
import { Credential } from 'mppx';
import { sponsoredClient } from './sponsored.mjs';
import { requireThat } from '../contract.mjs';

// The caller provides a durable, narrowly authorized wallet executor. This
// transport preserves one logical body/key and original proof through retries.
// It cannot select a new quote or authorize a replacement payment on 503.
export function createModelTransport({ recoverOriginalPayment, fetcher=fetch, maxPolls=40, pollMs=100 }) {
  return async (url, init) => {
    requireThat(init.method==='POST' && typeof init.body==='string','native_post_required');
    const headers=new Headers(init.headers),body=init.body;
    requireThat(headers.has('idempotency-key'),'stable_logical_call_required');
    let proof;
    const client=Mppx.create({polyfill:false,fetch:fetcher,methods:[sponsoredClient({recoverPayment:async challenge=>{
      requireThat(!proof,'replacement_payment_forbidden');
      const original=await recoverOriginalPayment(challenge);
      proof=typeof original==='string'?original:Credential.serialize(original);
      return Credential.deserialize(proof);
    }})]});
    let response=await client.fetch(url,{...init,headers:new Headers(headers),body});
    for(let n=0;n<maxPolls&&response.status===503;n++){
      await response.body?.cancel();await new Promise(r=>setTimeout(r,pollMs));
      const retryHeaders=new Headers(headers);if(proof)retryHeaders.set('payment-authorization',proof);
      response=await fetcher(url,{...init,headers:retryHeaders,body,redirect:'error'});
    }
    return {response,proof};
  };
}
