#!/usr/bin/env python3
"""Fresh-volume and restart acceptance. Docker has no network, real keys or funds."""
import argparse,json,pathlib,subprocess,tempfile,uuid
ROOT=pathlib.Path(__file__).resolve().parents[1]
p=argparse.ArgumentParser();p.add_argument('image');p.add_argument('--evidence',required=True);a=p.parse_args()
volume='intents-offline-smoke-'+uuid.uuid4().hex[:12]
def docker(*args):return subprocess.run(['docker',*args],text=True,capture_output=True,timeout=180)
if docker('volume','create',volume).returncode:raise SystemExit('smoke_volume_create_failed')
try:
 params=json.loads((ROOT/'docs/examples/nearintents-auction-parameters.json').read_text());params.pop('durationMs')
 prepare=r'''
import fs from 'node:fs';
import {freezeClass} from '/app/services/mpp-near-direct/auction/contracts.mjs';
import {auctionPlan} from '/app/services/mpp-nearintents/auction/plan.mjs';
const p=JSON.parse(process.argv[1]);p.deadlineMs=Date.now()+600000;p.service=freezeClass(p.service);
const {plan,planHash}=auctionPlan(p),d='/data/nearintents-v1';fs.mkdirSync(d,{mode:0o700});
const config={paymentMethod:'nearintents',plan,reviewedPlanHash:planHash,dataDirectory:d,owningStateDirectory:d+'/owning-market',databaseUrlFile:d+'/database-url',storageKeyFile:d+'/storage-key',marketSecretFile:d+'/market-secret',nearAiKeyFile:d+'/near-ai-key'};
process.stdout.write(JSON.stringify({config,planHash}));
'''
 setup=docker('run','--rm','--platform','linux/amd64','--network','none','--read-only','-v',volume+':/data','--entrypoint','node',a.image,'--input-type=module','-e',prepare,json.dumps(params))
 if setup.returncode:raise SystemExit('smoke_setup_failed: '+setup.stderr[-1200:])
 plan=json.loads(setup.stdout)
 with tempfile.TemporaryDirectory() as temp:
  env=pathlib.Path(temp)/'offline.env';env.write_text('AUCTION_PAYMENT_PROFILE=nearintents\nENABLE_NEARINTENTS_AUCTION='+plan['planHash']+'\nNEARINTENTS_AUCTION_CONFIG_JSON='+json.dumps(plan['config'])+'\nNEARINTENTS_AUCTION_PRIVATE_JSON='+json.dumps({'nearAiKey':'offline-not-a-real-key','storageKey':'11'*32,'marketSecret':'offline-only-market-secret-'*3})+'\n');env.chmod(0o600)
  for _ in range(2):
   boot=docker('run','--rm','--platform','linux/amd64','--network','none','--read-only','--tmpfs','/tmp','-v',volume+':/data','--env-file',str(env),a.image)
   if boot.returncode==0 or 'arbitrum-rpc.example.invalid' not in boot.stderr or not any(s in boot.stderr for s in ['HTTP request failed','fetch failed']):raise SystemExit('offline_intents_boot_failed_before_expected_rpc: '+boot.stderr[-1800:])
 inspect=r'''
import {spawnSync} from 'node:child_process';
function run(c,a){const r=spawnSync(c,a,{encoding:'utf8'});if(r.status!==0)throw Error(c+'_failed');return r.stdout.trim();}
const d='/data/nearintents-v1/pg';run('pg_ctl',['-D',d,'-l','/tmp/check.log','-o','-h 127.0.0.1 -p 25432 -k /tmp','-w','start']);
try{process.stdout.write(run('psql',['postgres://preview@127.0.0.1:25432/private_market_auction_nearintents_v1','-X','-At','-v','ON_ERROR_STOP=1','-c',"SELECT json_build_object('owning',(SELECT count(*) FROM mpp_direct_schema),'adapter',(SELECT count(*) FROM nearintents_auction_configuration),'agents',(SELECT count(*) FROM mpp_direct_auction_agents),'orders',(SELECT count(*) FROM mpp_direct_auction_allocations),'credentials',(SELECT count(*) FROM nearintents_auction_credentials),'providerInvocations',(SELECT count(*) FROM mpp_direct_live_provider_ops))"]));}finally{run('pg_ctl',['-D',d,'-m','fast','-w','stop']);}
'''
 check=docker('run','--rm','--platform','linux/amd64','--network','none','--read-only','--tmpfs','/tmp','-v',volume+':/data','--entrypoint','node',a.image,'--input-type=module','-e',inspect)
 if check.returncode:raise SystemExit('smoke_inspect_failed: '+check.stderr[-1200:])
 counts=json.loads(check.stdout)
 if counts!={'owning':1,'adapter':1,'agents':0,'orders':0,'credentials':0,'providerInvocations':0}:raise SystemExit('unexpected_smoke_effects')
 image=json.loads(docker('image','inspect',a.image).stdout)[0]
 evidence={'scope':'offline-nearintents-image-bootstrap','image':image['Id'],'sourceRevision':image['Config'].get('Labels',{}).get('org.opencontainers.image.revision'),'network':'none','realTransfers':0,'paidInference':0,'freshVolumeAndRestartPassed':True,'counts':counts}
 pathlib.Path(a.evidence).write_text(json.dumps(evidence,indent=2)+'\n');print(json.dumps(evidence))
finally:
 docker('volume','rm',volume)
