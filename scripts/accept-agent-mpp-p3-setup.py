#!/usr/bin/env python3
"""Owner setup HTTP integration with real PG/Rust/auth and controlled wallet/RPC."""
import json,sys,time,argparse
from pathlib import Path
from importlib import import_module
p3=import_module('accept-agent-mpp-p3');P3,PKG,request,literal,wait_for=p3.P3,p3.PKG,p3.request,p3.literal,p3.wait_for
class Setup(P3):
 def configure(self):
  self.m.sql('DELETE FROM mpp_direct_p2_sessions;DELETE FROM mpp_direct_tasks;DELETE FROM mpp_direct_p2_agent_limits;DELETE FROM mpp_direct_agents;')
  c=self.config;c['setupOnly']=True;c['activatedConfigPath']=str(self.m.root/'activated.json')
  p=c['payments']['plan'];p['funding']={'kind':'native','perAgentYocto':'100000000000000000000000'}
  p['agents']=[{k:a[k] for k in ['agentId','userId','principalCapYocto','taskBudgetNano','callCapNano']} for a in p['agents']]
 def grants(self):pass
 def launch(self,script,config,name):return super().launch(PKG/'p3/launch.mjs' if str(script).endswith('/p3/server.mjs') else script,config,name)
 def owner_tx(self,tx):
  r=request(self.wallet+'/fixture/owner-transaction',{'transaction':tx},{'x-fixture-key':self.code});assert r[0]==200,r;return r[1]['transaction']['hash']
def acceptance(binary):
 with Setup(binary) as x:
  assert 'plan' not in request(x.url+'/buyer-api/config')[1]
  assert 'plan' in x.api('config')[1]
  assert x.api('agents')[1]['setup']
  assert x.api('wallets/agent-1/funding',{})[0]!=200
  for id in ['agent-1','agent-2']:
   created=x.api('wallets/'+id+'/create',{});assert created[0]==200 and not created[1]['fundingAllowed'],created
   # Repeated create recovers the original wallet, not a replacement.
   assert x.api('wallets/'+id+'/create',{})[1]==created[1]
   policy=x.api('wallets/'+id+'/policy',{});assert policy[0]==200,policy
   x.owner_tx(policy[1]['transaction']);assert x.api('wallets/'+id+'/confirm',{})[1]['fundingAllowed']
   # Lost policy ACK is reconciled; never ask the owner to store version 1 again.
   assert x.api('wallets/'+id+'/policy',{})[1]['alreadyInstalled']
   funding=x.api('wallets/'+id+'/funding',{});assert funding[0]==200,funding
   assert x.api('wallets/'+id+'/funding',{})[0]!=200
   tx=x.owner_tx(funding[1]['transaction']);assert x.api('wallets/'+id+'/funding-confirm',{'txHash':tx})[1]['state']=='native_final'
   assert x.api('wallets/'+id+'/funding-confirm',{'txHash':tx})[1]['state']=='native_final'
  activated=x.api('setup/activate',{});assert activated[0]==200,activated
  wait_for(lambda:request(x.url+'/healthz')[1].get('phase')=='P3',20)
  x.config=json.loads(Path(x.config['activatedConfigPath']).read_text());x.login();P3.grants(x)
  # Tokens/config/wallet credentials remain server-side; CSRF and stale sessions fail.
  assert request(x.url+'/buyer-api/authorization/revoke',{}, {'cookie':x.cookie})[0]!=200
  data={'url':x.url,'cookie':x.cookie,'session':'session-agent-1'}
  import subprocess
  r=subprocess.run([str(p3.NODE),str(PKG/'p3/test/run-fx.mjs')],input=json.dumps(data).encode(),capture_output=True,timeout=90);assert r.returncode==0,(r.stdout,r.stderr)
  result=json.loads(r.stdout);assert result['result']['stopReason']=='end_turn',result
  assert x.api('sessions/session-agent-1')[1]['workspace']['/workspace/result.txt']=='6\n'
  assert x.m.sql("SELECT count(*) FROM mpp_direct_p3_wallets WHERE state='ready'")=='2'
  before=x.cookie;assert x.api('logout',{})[0]==200;assert x.api('agents',cookie=before)[0]==401
  return {'case':'owner-login-create-policy-native-funding-activate-grants-task-logout','passed':True,'wallets':2,'fundingTransfers':2,'policyAckRecovery':True,'duplicateFundingRefused':True,'csrfRefused':True}
if __name__=='__main__':
 a=argparse.ArgumentParser();a.add_argument('binary');a.add_argument('--evidence',default=str(p3.ROOT/'docs/acceptance/2026-11-14-outlayer-p3-setup.json'));args=a.parse_args()
 result=acceptance(args.binary);Path(args.evidence).write_text(json.dumps({'scope':'controlled-wallet-owner-http-integration-not-browser-or-chain-acceptance','realChain':False,'cases':[result]},indent=2)+'\n');print(json.dumps(result))
