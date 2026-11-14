import test from 'node:test';
import assert from 'node:assert/strict';
import {publicOrigin} from '../server.mjs';
test('preview origin is exact HTTPS or explicit loopback, with no credentials/path/query',()=>{
 assert.equal(publicOrigin(undefined),null);
 assert.equal(publicOrigin('https://preview.example.com'),'https://preview.example.com');
 assert.equal(publicOrigin('http://127.0.0.1:3000'),'http://127.0.0.1:3000');
 for(const value of ['http://preview.example.com','https://preview.example.com/','https://user:secret@preview.example.com','https://preview.example.com?x=y','https://preview.example.com/#x','null','*']){
  assert.throws(()=>publicOrigin(value),/invalid_public_origin/);
 }
});
