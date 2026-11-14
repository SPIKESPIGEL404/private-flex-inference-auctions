import test from 'node:test';
import assert from 'node:assert/strict';
import {PublicWorkspace} from '../public-workspace.mjs';
import {hash} from '../../contract.mjs';
const A='mainnet:a.near',B='mainnet:b.near';
function fixture(){
 const w=new PublicWorkspace({origin:'https://review.example.com',storePath:':memory:',storageKey:'01'.repeat(32)},{});
 for(const [owner,address] of [[A,'a'.repeat(64)],[B,'b'.repeat(64)]])w.store.put('native-wallets',hash(owner),owner,{agents:[{id:'agent-a',address,publicKey:'fixture-only'}]});
 let executed=101,tx;
 w.rpc.call=async(method,p)=>method==='tx'?tx:{header:{height:p.finality?100:executed}};
 return {w,setHeight:n=>executed=n,setTx:v=>tx=v};
}
const input=id=>({id,agentId:'agent-a',kind:'fund',amount:'1000'});
const transaction=(hash='1'.repeat(32))=>({final_execution_status:'FINAL',transaction:{hash,signer_id:'a.near',receiver_id:'a'.repeat(64),actions:[{Transfer:{deposit:'1000'}}]},transaction_outcome:{block_hash:'fixture'},status:{SuccessValue:''}});
test('owner-qualified operation keys retain both pending holds',async()=>{const {w}=fixture();try{await Promise.all([w.begin(A,input('same')),w.begin(B,input('same'))]);assert.equal(w.operations(A).length,1);assert.equal(w.operations(B).length,1);await assert.rejects(w.begin(A,input('next')),/original_native_transfer_pending/);await assert.rejects(w.begin(B,input('next')),/original_native_transfer_pending/);await assert.rejects(w.reconcile('mainnet:foreign.near','same',{hash:'1'.repeat(32)}),/unknown_native_operation/);}finally{w.close();}});
test('unknown, old same-amount and wrong transfers preserve hold; final original hash is single use',async()=>{const {w,setHeight,setTx}=fixture();try{await w.begin(A,input('original'));setTx(transaction());setHeight(100);await assert.rejects(w.reconcile(A,'original',{hash:'1'.repeat(32)}),/predates/);assert.equal(w.operations(A)[0].state,'pending');setHeight(101);const bad=transaction();bad.transaction.receiver_id='wrong.near';setTx(bad);await assert.rejects(w.reconcile(A,'original',{hash:'1'.repeat(32)}),/mismatch/);setTx(transaction());await w.reconcile(A,'original',{hash:'1'.repeat(32)});assert.equal(w.operations(A)[0].state,'final');await w.begin(A,input('next'));await assert.rejects(w.reconcile(A,'next',{hash:'1'.repeat(32)}),/already_used/);assert.equal(w.operations(A).at(-1).state,'pending');}finally{w.close();}});
test('concurrent begins commit one hold and known hash survives unavailable RPC',async()=>{const {w}=fixture();try{const result=await Promise.allSettled([w.begin(A,input('one')),w.begin(A,input('two'))]);assert.equal(result.filter(r=>r.status==='fulfilled').length,1);const op=w.operations(A)[0];w.bindHash(A,op.id,{hash:'1'.repeat(32)});w.rpc.call=async()=>{throw new Error('unavailable')};await assert.rejects(w.reconcile(A,op.id,{}),/unavailable/);assert.equal(w.operations(A)[0].hash,'1'.repeat(32));assert.equal(w.operations(A)[0].state,'pending');}finally{w.close();}});
test('withdrawal requires and retains original signed bytes',async()=>{const {w}=fixture();try{await assert.rejects(w.begin(A,{...input('withdraw'),kind:'withdraw',hash:'1'.repeat(32)}),/signed_bytes_required/);await w.begin(A,{...input('withdraw'),kind:'withdraw',hash:'1'.repeat(32),bytes:'controlled-original-signed-bytes'});assert.equal(w.operations(A)[0].bytes,'controlled-original-signed-bytes');assert.equal(w.operations(A)[0].hash,'1'.repeat(32));}finally{w.close();}});
