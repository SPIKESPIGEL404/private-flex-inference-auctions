import {test,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {indexedDB,IDBKeyRange} from 'fake-indexeddb';
import {NativeWalletController,parseNear,nearAmount} from '../src/native-wallet';
Object.assign(globalThis,{indexedDB,IDBKeyRange,location:{origin:'https://test.example.com'}});
let locks=Promise.resolve(),owner='a.near',registry:any[]=[],operations:any[]=[],calls=0,download:Blob,callbacks=new Map<string,Function>();
Object.defineProperty(globalThis,'navigator',{value:{locks:{request:async(_name:string,fn:()=>Promise<void>)=>{const previous=locks;let release!:()=>void;locks=new Promise(r=>release=r);await previous;try{return await fn();}finally{release();}}}},configurable:true});
Object.assign(globalThis,{document:{createElement:()=>({click(){},href:'',download:''})}});
URL.createObjectURL=(blob:Blob)=>{download=blob;return 'blob:fixture';};URL.revokeObjectURL=()=>{};
let beginGate:Promise<void>|undefined,releaseBegin:()=>void;
const wallet={getAccounts:async()=>[{accountId:owner}],signAndSendTransaction:async()=>{calls++;throw new Error('controlled lost acknowledgement');}};
const connector={wallet:async()=>wallet,on:(name:string,fn:Function)=>callbacks.set(name,fn),off:()=>{},disconnect:async()=>{},connect:async()=>{}};
const provider={viewAccount:async()=>({amount:'100000000000000000000000'}),viewAccessKey:async()=>({nonce:1n,permission:'FullAccess',block_hash:'1'.repeat(32)})};
const controller=()=>new NativeWalletController({connector:async()=>connector as any,provider:()=>provider as any});
const reply=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
globalThis.fetch=async(input:any,init:any)=>{const path=String(input).replace('/buyer-api/',''),body=init?.body?JSON.parse(init.body):null;
 if(path==='session')return reply({owner:owner?{account_id:owner,public_key:'fixture'}:null});
 if(path==='logout')return reply({loggedOut:true});
 if(path==='native-wallets'){if(body){if(registry.length&&JSON.stringify(registry.map(a=>a.address))!==JSON.stringify(body.agents.map((a:any)=>a.address)))return reply({error:{code:'registry_conflict'}},409);registry=body.agents;}return reply({agents:registry});}
 if(path==='native-operations'){if(body){if(operations.some(o=>o.agentId===body.agentId&&o.state==='pending'))return reply({error:{code:'original_native_transfer_pending'}},409);operations.push({...body});if(beginGate)await beginGate;return reply(body);}return reply({operations});}
 if(path.endsWith('/hash')){const t=operations.find(o=>o.id===path.split('/')[1]);t.hash=body.hash;return reply(t);}
 if(path.endsWith('/reconcile'))return reply({error:{code:'rpc_unavailable'}},503);
 throw new Error('Unexpected fixture request: '+path);
};
beforeEach(async()=>{await new Promise<void>((yes,no)=>{const q=indexedDB.deleteDatabase('private-market.native-wallets.v1');q.onsuccess=()=>yes();q.onerror=()=>no(q.error);});owner='a.near';registry=[];operations=[];calls=0;callbacks.clear();beginGate=undefined;});
async function prepared(){const c=controller();await c.load();await c.prepare(['public-000','public-001']);assert.equal(c.snapshot().error,'');await c.backup('fixture-password-long');assert.equal(c.snapshot().error,'');return c;}
test('native precision is exact at one yocto and rejects floating notation',()=>{assert.equal(parseNear('0.000000000000000000000001'),'1');assert.equal(nearAmount('1'),'0.000000000000000000000001');assert.throws(()=>parseNear('1e-3'));assert.throws(()=>parseNear('0.0000000000000000000000001'));});
test('independent keys stay encrypted; stale backup merges server pending journal',async()=>{const c=await prepared();const a=c.snapshot().agents;assert.notEqual(a[0].address,a[1].address);assert.match(a[0].address,/^[0-9a-f]{64}$/);const backup=await download.text();assert.ok(!backup.includes(a[0].address));await c.fund(a[0].id,'0.01');assert.equal(calls,1);assert.equal(operations[0].state,'pending');await new Promise<void>((yes)=>{const q=indexedDB.deleteDatabase('private-market.native-wallets.v1');q.onsuccess=()=>yes();});const restored=controller();await restored.load();await restored.restore(backup,'fixture-password-long',['public-000','public-001']);assert.equal(restored.snapshot().error,'');assert.equal(restored.snapshot().agents[0].address,a[0].address);assert.equal(restored.snapshot().agents[0].attempts[0].state,'pending');await restored.fund(a[0].id,'0.01');assert.equal(calls,1);});
test('two tabs preserve one pending transfer and never send twice',async()=>{const one=await prepared(),two=controller();await two.load();await Promise.all([one.fund('public-000','0.01'),two.fund('public-000','0.01')]);assert.equal(calls,1);assert.equal(operations.length,1);assert.match(two.snapshot().error,/pending/);});
test('owner change while operation persistence awaits fences actual wallet submission',async()=>{const c=await prepared();beginGate=new Promise(r=>releaseBegin=r);const run=c.fund('public-000','0.01');while(!operations.length)await new Promise(r=>setTimeout(r,2));await c.disconnect();owner='b.near';releaseBegin();await run;assert.equal(calls,0);assert.equal(c.snapshot().owner,null);assert.equal(c.snapshot().agents.length,0);});
test('late wallet login after disconnect never verifies the revoked signature',async()=>{
 let signedHandler:Function|undefined,release!:()=>void,verifyCount=0;
 const gate=new Promise<void>(r=>release=r),originalFetch=globalThis.fetch;
 globalThis.fetch=async(input:any,init:any)=>{const path=String(input);if(path.endsWith('auth/challenge'))return reply({nonce:btoa('0'.repeat(32)),message:'fixture',recipient:'test.example.com'});if(path.endsWith('auth/verify')){verifyCount++;return reply({owner:{account_id:owner,public_key:'fixture'}});}return originalFetch(input,init);};
 try{
 const c=new NativeWalletController({connector:async()=>({on:(_n:string,fn:Function)=>signedHandler=fn,off:()=>{},connect:async()=>{await gate;signedHandler?.({accounts:[{signedMessage:{accountId:owner,publicKey:'fixture',signature:'fixture'}}]});},disconnect:async()=>{}}) as any});
 const login=c.connect();while(!signedHandler)await new Promise(r=>setTimeout(r,2));await c.disconnect();release();await login;assert.equal(verifyCount,0);assert.equal(c.snapshot().owner,null);
 }finally{globalThis.fetch=originalFetch;}
});
