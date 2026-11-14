import {execFileSync} from 'node:child_process';
import {hash,requireThat} from '../contract.mjs';

// The supply operator provides an independently qualified native Market catalog
// and its frozen tokenizer/measurement manifest. Quote calculation uses the
// ORIGINAL Rust meter; this class never estimates tokens from text length.
export class Profiles {
 constructor({plan,hostBinary,controlled=false,fetcher=fetch}) {Object.assign(this,{plan,hostBinary,controlled,fetcher});}
 async qualify(body) {
  const p=this.plan.provider;
  if(this.controlled) {
   const env={...process.env,PRIVATE_MARKET_NEAR_DIRECT_P1:'controlled',PRIVATE_MARKET_AGENT_P2:'controlled'};delete env.PRIVATE_MARKET_AGENT_P3;
   const quote=JSON.parse(execFileSync(this.hostBinary,['quote-native-p2','-'],{input:JSON.stringify(body),encoding:'utf8',env,timeout:15000,maxBuffer:1024*1024}));
   return {...quote,forecast:{source:'controlled-provider-fixture',observedMs:Date.now(),usableMs:500,controlled:true}};
  }
  throw new Error('controlled_profile_only');
 }
}
