import {start as startProxy} from '../p1/server.mjs';
import {Authority} from './authority.mjs';
import {createRoute} from './route.mjs';
import {OutLayer,FileCredentials} from './outlayer.mjs';
import {Profiles} from './profiles.mjs';
import {NativeProfiles} from './native-profiles.mjs';
import {validatePlan} from './plan.mjs';
import {requireThat} from '../contract.mjs';

export function validateConfig(c) {
 validatePlan(c.plan,{allowExpired:true});
 requireThat(['controlled','qualification-test','bounded'].includes(c.mode)&&c.network===c.plan.network&&typeof c.secret==='string'&&c.secret.length>=32,'invalid_p3_config');
 for(const raw of [c.databaseUrl,c.upstream]){
  const u=new URL(raw);requireThat(u.hostname==='127.0.0.1'&&['postgres:','postgresql:','http:'].includes(u.protocol)&&!u.hash&&!u.search,'isolated_p3_authority_required');
 }
 requireThat(c.mode!=='bounded'?c.realBroadcastEnabled===false:c.realBroadcastEnabled===true,'explicit_p3_broadcast_mode_required');
 if(c.mode==='bounded')requireThat(!c.testCertificateFile&&!c.controlledWalletOrigin&&new URL(c.plan.provider.origin).protocol==='https:','test_controls_forbidden_in_bounded_run');
 if(c.mode==='qualification-test')requireThat(c.network==='testnet'&&['localhost','127.0.0.1'].includes(new URL(c.plan.provider.origin).hostname),'local_qualification_test_required');
 requireThat(c.merchant===c.plan.merchant&&c.realm===c.plan.realm&&c.rateNanoPerNear===c.plan.limits.rateNanoPerNear,'p3_contract_mismatch');
 const rpcUrl=new URL(c.rpcUrl);requireThat(rpcUrl.protocol==='https:'||(c.mode!=='bounded'&&rpcUrl.protocol==='http:'&&rpcUrl.hostname==='127.0.0.1'),'untrusted_p3_rpc');
 requireThat(c.gasEstimateYocto===c.plan.limits.gasReserveYocto,'p3_fee_estimate_mismatch');
 requireThat(c.paymentWindowMs>0&&c.paymentWindowMs<=60000&&c.leaseTailMs>=2000&&c.estimatedTerminalMs>0&&c.paymentEstimateMs>0,'invalid_p3_timing');
}
export async function start(config,{api,profiles,rpc}={}) {
 const controlled=config.mode!=='bounded';
 api??=new OutLayer({network:config.network,credentials:new FileCredentials(config.credentialDirectory),controlled,origin:controlled?config.controlledWalletOrigin:undefined});
 profiles??=config.mode==='controlled'?new Profiles({plan:config.plan,hostBinary:config.hostBinary,controlled:true}):new NativeProfiles({config});
 const app=await startProxy({...config,walletFixtureUrl:'https://internal-wallet.invalid',buyerWalletKey:'internal',walletFixtureKey:'internal',faultControlKey:'internal'},
  {AuthorityClass:Authority,validate:validateConfig,createRoute:createRoute({api,profiles}),rpc});
 try{await profiles.restore?.();}catch(error){await profiles.close?.();await app.close();throw error;}
 return {...app,services:app.authority.services,async close(){await profiles.close?.();await app.close();}};
}
