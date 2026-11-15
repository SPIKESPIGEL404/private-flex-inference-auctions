#!/usr/bin/env python3
"""Image bootstrap acceptance with Docker networking disabled and zero wallets."""
import argparse,json,pathlib,subprocess,uuid
ROOT=pathlib.Path(__file__).resolve().parents[1]
p=argparse.ArgumentParser();p.add_argument('image');p.add_argument('--evidence',required=True);p.add_argument('--bootstrap-file');a=p.parse_args()
volume='auction-offline-smoke-'+uuid.uuid4().hex[:12]
def run(args,**kw):return subprocess.run(args,text=True,capture_output=True,timeout=180,**kw)
def docker(*args):return run(['docker',*args])
result=docker('volume','create',volume)
if result.returncode:raise SystemExit('smoke_volume_create_failed')
try:
 prepare=r'''
import fs from 'node:fs';import {randomBytes} from 'node:crypto';
import {freezeClass} from '/app/services/mpp-near-direct/auction/contracts.mjs';
import {validateLivePlan} from '/app/services/mpp-near-direct/auction/live/policy.mjs';
import {KeyPair} from '/app/services/mpp-near-direct/node_modules/near-api-js/lib/index.js';
const data='/data/mainnet-v1';fs.mkdirSync(data,{mode:0o700});
const service=freezeClass({model:'Qwen/Qwen3.8-27B',checkpoint:'offline-smoke',quantization:'fp8',tokenizer:'qwen-conservative-input-v1',template:'offline-smoke',engine:'offline-smoke',capacityPoolId:'single-seller-1',minInputTokens:0,maxInputTokens:32000,maxOutputTokens:128,rates:{input:'40000',cache_input:'18000',output:'1350000'},fee:{version:'flat-plus-bps-v1',flatMicro:'1',bps:'100'},delivery:'verified-complete-response-v1',features:'text-and-bash-v1'});
const {plan,planHash}=validateLivePlan({version:1,mode:'bounded-mainnet-v1',network:'mainnet',realBroadcastEnabled:true,walletProvider:'outlayer',origin:'https://offline-smoke.invalid',realm:'offline-smoke.invalid',rpcUrl:'https://rpc.mainnet.near.org',fxSource:'https://offline-smoke.invalid/price',merchant:'merchant.near',deadlineMs:Date.now()+600000,ownerBudgetNano:'20000000',agentBudgetNano:'10000000',callCapMicro:'5000',principalCapYocto:'10000000000000000000000',gasReserveYocto:'200000000000000000000',gasFloorYocto:'1000000000000000000000',merchantGasReserveYocto:'200000000000000000000',merchantMaximumYocto:'100000000000000000000000',providerMaximumMicro:'10000',maximumProviderCalls:8,maximumAgents:2,storagePriceYocto:'10000000000000000000',fundingCapYocto:'10000000000000000000000',service});
const config={plan,reviewedPlanHash:planHash,rpcUrl:plan.rpcUrl,dataDirectory:data,owningStateDirectory:data+'/owning-market',databaseUrlFile:data+'/database-url',merchantKeyFile:data+'/merchant-key',storageKeyFile:data+'/storage-key',marketSecretFile:data+'/market-secret',nearAiKeyFile:data+'/near-ai-key',fxFile:data+'/fx.json'};
for(const [name,value] of [['merchant-key',KeyPair.fromRandom('ed25519').toString()],['storage-key',randomBytes(32).toString('hex')],['market-secret',randomBytes(32).toString('hex')],['near-ai-key','offline-smoke-not-a-real-key'],['runtime.json',JSON.stringify(config)]])fs.writeFileSync(data+'/'+name,value,{mode:0o600});
process.stdout.write(JSON.stringify({planHash}));
'''
 result=docker('run','--rm','--platform','linux/amd64','--network','none','--read-only','-v',volume+':/data','--entrypoint','node',a.image,'--input-type=module','-e',prepare)
 if result.returncode:raise SystemExit('smoke_private_setup_failed: '+result.stderr[-1000:])
 plan_hash=json.loads(result.stdout)['planHash']
 args=['run','--rm','--platform','linux/amd64','--network','none','--read-only','--tmpfs','/tmp','-v',volume+':/data','-e','ENABLE_BOUNDED_MAINNET='+plan_hash]
 if a.bootstrap_file:args+=['-v',str(pathlib.Path(a.bootstrap_file).resolve())+':/app/scripts/bootstrap-mainnet-auction.py:ro']
 args += [a.image,'/data/mainnet-v1/runtime.json']
 boot=docker(*args)
 # Only the expected blocked network reader is allowed to stop startup. Any
 # missing environment, schema drift, file permission or migration failure fails.
 if boot.returncode==0 or 'fetch failed' not in boot.stderr:raise SystemExit('offline_bootstrap_failed_before_expected_rpc: '+boot.stderr[-1800:])
 inspect=r'''
import {spawnSync} from 'node:child_process';
function run(command,args){const r=spawnSync(command,args,{encoding:'utf8'});if(r.status!==0)throw Error(command+'_failed');return r.stdout.trim();}
const d='/data/mainnet-v1/pg';run('pg_ctl',['-D',d,'-l','/tmp/postgres-check.log','-o','-h 127.0.0.1 -p 25432 -k /tmp','-w','start']);
try{const row=run('psql',['postgres://preview@127.0.0.1:25432/private_market_auction_mainnet_v1','-X','-At','-v','ON_ERROR_STOP=1','-c',"SELECT json_build_object('fingerprint',(SELECT count(*) FROM mpp_direct_schema),'wallets',(SELECT count(*) FROM mpp_direct_p3_wallets),'orders',(SELECT count(*) FROM mpp_direct_auction_allocations),'payments',(SELECT count(*) FROM mpp_direct_p3_operations),'providerInvocations',(SELECT count(*) FROM mpp_direct_live_provider_ops))"]);process.stdout.write(row);}finally{run('pg_ctl',['-D',d,'-m','fast','-w','stop']);}
'''
 check=docker('run','--rm','--platform','linux/amd64','--network','none','--read-only','--tmpfs','/tmp','-v',volume+':/data','--entrypoint','node',a.image,'--input-type=module','-e',inspect)
 if check.returncode:raise SystemExit('smoke_schema_inspection_failed: '+check.stderr[-1000:])
 counts=json.loads(check.stdout)
 if counts!={'fingerprint':1,'wallets':0,'orders':0,'payments':0,'providerInvocations':0}:raise SystemExit('unexpected_smoke_effects')
 image=json.loads(docker('image','inspect',a.image).stdout)[0]
 evidence={'scope':'offline-image-bootstrap','image':image['Id'],'sourceRevision':image['Config'].get('Labels',{}).get('org.opencontainers.image.revision'),'network':'none','realChainPayments':False,'realInference':False,'bootstrapSourceOverride':bool(a.bootstrap_file),'owningSchemaInitializedAndVerified':True,'expectedNetworkGateStoppedRuntime':True,'counts':counts}
 pathlib.Path(a.evidence).write_text(json.dumps(evidence,indent=2)+'\n');print(json.dumps(evidence))
finally:
 docker('volume','rm',volume)
