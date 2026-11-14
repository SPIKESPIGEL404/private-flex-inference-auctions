import test from 'node:test';
import assert from 'node:assert/strict';
import {approvedOrigins} from '../server.mjs';
import {PublicWorkspace} from '../public-workspace.mjs';
import {generateKeyPairSync,sign} from 'node:crypto';
import bs58 from 'bs58';
const primary='https://demo.example.com',fallback='https://owned-preview.example.com';
test('fallback origins are explicit exact HTTPS peers without a downgrade or wildcard',()=>{
 assert.deepEqual([...approvedOrigins(primary,[fallback])],[primary,fallback]);
 for(const aliases of [['https://evil.example/path'],['https://a.example','https://b.example'],['http://127.0.0.1:1234'],['https://*.example.com']])assert.throws(()=>approvedOrigins(primary,aliases));
 assert.throws(()=>approvedOrigins(null,[fallback]));
});
test('wallet registration binds the current approved site; alias cannot replace addresses',async()=>{
 const ids=['public-000','public-001'],owner='mainnet:owner.near';
 const w=new PublicWorkspace({origin:primary,origins:[primary,fallback],storePath:':memory:',storageKey:'01'.repeat(32)},{query:async()=>({rows:ids.map(agent_id=>({agent_id}))})});
 function agents(origin){return ids.map(id=>{const pair=generateKeyPairSync('ed25519'),raw=pair.publicKey.export({type:'spki',format:'der'}).subarray(-32),address=raw.toString('hex'),message=JSON.stringify({action:'register-agent-wallet',origin,network:'mainnet',owner,id,address});return{id,address,publicKey:'ed25519:'+bs58.encode(raw),signature:sign(null,Buffer.from(message),pair.privateKey).toString('base64')};});}
 try{const first=agents(fallback);await w.register(owner,first,fallback);assert.equal(w.wallets(owner)[0].address,first[0].address);await assert.rejects(w.register(owner,first,'https://evil.example'),/origin_denied/);await assert.rejects(w.register(owner,first,primary),/invalid_native_key_proof/);await assert.rejects(w.register(owner,agents(primary),primary),/already_registered/);}finally{w.close();}
});
