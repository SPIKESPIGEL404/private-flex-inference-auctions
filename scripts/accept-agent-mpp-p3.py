#!/usr/bin/env python3
"""Original PG/Redis/Market and two real fx engines; loopback OutLayer/NEAR/model doubles.
No external provider calls or real chain payments. Fault identities persist in PG.
"""
import sys,json,os,time,hashlib,subprocess,threading,argparse
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from market_b_support import Market,run,wait_for,free_port
from importlib.util import spec_from_file_location,module_from_spec
ROOT=Path(__file__).resolve().parent.parent
spec=spec_from_file_location('p1',ROOT/'scripts/accept-agent-mpp-p1.py');p1=module_from_spec(spec);spec.loader.exec_module(p1)
spec=spec_from_file_location('p2',ROOT/'scripts/accept-agent-mpp-p2.py');p2=module_from_spec(spec);spec.loader.exec_module(p2)
request,literal,NODE,PKG=p1.request,p1.literal,p1.NODE,p1.PKG
sha=lambda x:hashlib.sha256(x.encode()).hexdigest()
class P3(p2.P2):
 def __enter__(self):
  m=self.m.__enter__()
  try:
   self.initialize()
   self.code=os.urandom(32).hex();self.cred=m.root/'credentials';self.walletConfig=m.root/'wallet-p3.json'
   self.walletConfig.write_text(json.dumps({'mode':'controlled','databaseUrl':m.direct,'credentialDirectory':str(self.cred),'realm':'payments.example.com','controlKey':self.code,'port':free_port()}));self.walletConfig.chmod(0o600)
   self.wallet=self.launch(PKG/'p3/test/wallet-fixture.mjs',self.walletConfig,'wallet-p3')
   result=request(self.wallet+'/fixture/accounts',{}, {'x-fixture-key':self.code});assert result[0]==200,result
   self.accounts={a['role']:a for a in result[1]};self.owner=self.accounts['owner']['payer'];merchant=self.accounts['merchant']['payer'];self.port=free_port();self.url='http://127.0.0.1:'+str(self.port)
   def binding(role):
    a=self.accounts[role];return {'agentId':role,'walletId':a['walletId'],'payer':a['payer'],'publicKey':a['publicKey'],'credentialRef':role,'version':'outlayer-binding-1','network':'testnet','merchant':merchant,'refundTo':a['payer'],'signingRecipient':'payments.example.com',
     'policy':{'controller':self.owner,'version':1,'encryptedHash':sha(a['encrypted'])}}
   agents=[]
   for i,role in enumerate(['agent-1','agent-2']):
    b=binding(role);b.update(userId=m.buyers[i]['user'],principalCapYocto='10000000000000000000000',taskBudgetNano='20000000',callCapNano='3000000');agents.append(b)
    user=b['userId'];token=m.buyers[i]['token'];task='task-'+str(i+1);session='session-'+str(i+1)
    m.sql('INSERT INTO mpp_direct_agents(user_id,token_hash,agent_id,payer,binding_version,native_balance,owner_id) VALUES('+','.join(map(literal,[user,sha(token),role,b['payer'],b['version'],'{}',self.owner]))+')')
    m.sql('INSERT INTO mpp_direct_p2_agent_limits(user_id,budget_nano) VALUES('+literal(user)+',20000000)')
    m.sql('INSERT INTO mpp_direct_tasks(id,user_id,budget_nano,hard_bid_nano,call_cap_nano,deadline_ms,preference) VALUES('+','.join(map(literal,[task,user,10000000,3000000,3000000,int(time.time()*1000)+180000,'fast']))+')')
    workspace={'/workspace/task.txt':'Compute the sum of numbers.txt, write result.txt, and verify the result.','/workspace/numbers.txt':'3\n7\n32\n' if i==0 else '5\n5\n9\n'}
    m.sql('INSERT INTO mpp_direct_p2_sessions(id,user_id,task_id,prompt,workspace,created_ms) VALUES('+','.join(map(literal,[session,user,task,workspace['/workspace/task.txt'],json.dumps(workspace),int(time.time()*1000)]))+')')
   m.sql('INSERT INTO mpp_direct_project_budget(id,budget_yocto) VALUES(1,10000000000000000000000)')
   plan={'version':4,'walletProvider':'outlayer','network':'testnet','origin':self.url,'realm':'payments.example.com','ownerAccount':self.owner,'projectAccount':self.owner,'merchant':merchant,'merchantBinding':binding('merchant'),'agents':agents,
    'limits':{'deadlineMs':int(time.time()*1000)+180000,'maxOutputTokens':64,'maximumProviderCalls':16,'grantDurationMs':180000,'gasReserveYocto':'100000000000000000000','gasFloorYocto':'100000000000000000000','merchantGasFloorYocto':'100000000000000000000','merchantGasBudgetYocto':'10000000000000000000000','providerBudgetMicro':'100000','rateNanoPerNear':'2000000000'},
    'provider':{'model':'native-a','tokenizerRef':'controlled/tokenizer-v1','contextWindowTokens':32000,'rates':{'input':1000000,'cache_input':1000000,'output':11000000}}}
   self.config={'port':self.port,'agentCredentials':[{'userId':b['user'],'token':b['token']} for b in m.buyers[:2]],'payments':{'mode':'controlled','network':'testnet','realBroadcastEnabled':False,'plan':plan,'databaseUrl':m.direct,'upstream':m.url,'rpcUrl':self.wallet+'/rpc','controlledWalletOrigin':self.wallet,'credentialDirectory':str(self.cred),
    'hostBinary':m.binary,'realm':plan['realm'],'merchant':merchant,'secret':os.urandom(32).hex(),'rateNanoPerNear':'2000000000','storagePriceYocto':'10000000000000000000','gasEstimateYocto':'100000000000000000000','paymentWindowMs':60000,'leaseTailMs':15000,'paymentEstimateMs':100,'estimatedTerminalMs':500,'refundAuto':True,'maxOutputTokens':64,'port':free_port()}}
   self.configure()
   self.configPath=m.root/'p3.json';self.configPath.write_text(json.dumps(self.config));self.configPath.chmod(0o600)
   self.url=self.launch(PKG/'p3/server.mjs',self.configPath,'p3');self.login()
   m.sql('INSERT INTO mpp_direct_p3_provider_budget(singleton,maximum_micro,maximum_calls) VALUES(true,100000,16)')
   self.grants()
   return self
  except BaseException:self.__exit__(*sys.exc_info());raise
 def initialize(self):
  m=self.m;m.env.update(PRIVATE_MARKET_AGENT_P3='controlled',PRIVATE_MARKET_LISTEN='127.0.0.1:'+str(free_port()))
  assert json.loads(run(m.binary,'init',str(m.state),env=m.env))['test_credit_micro_usd']==0
  m.data=json.loads((m.state/'state.json').read_text());m.buyers=m.data['buyers'];self.start_seller();self.start_host()
 def configure(self):pass
 def grants(self):
  for role in ['owner','project']:
   challenge=self.api('authorization/challenge',{'role':role});assert challenge[0]==200,challenge
   signed=self.sign(challenge[1]['payload']);verified=self.api('authorization/verify',{'id':challenge[1]['id'],'signed':signed});assert verified[0]==200,verified
 def sign(self,payload):
  result=request(self.wallet+'/fixture/sign',{'role':'owner','payload':payload},{'x-fixture-key':self.code});assert result[0]==200,result;return result[1]
 def login(self,code=None):
  origin={'origin':self.url};c=request(self.url+'/buyer-api/auth/challenge',{},origin);assert c[0]==200,c
  r=request(self.url+'/buyer-api/auth/verify',{'id':c[1]['id'],'signed':self.sign(c[1]['payload'])},origin);assert r[0]==200,r
  self.cookie=r[2]['set-cookie'].split(';')[0];return self.cookie
 def api(self,path,body=None,cookie=None,headers=None):return request(self.url+'/buyer-api/'+path,body,{'cookie':cookie or self.cookie,'origin':self.url,**(headers or {})})
 def fx(self,n=1,crash=None):
  c={'url':self.url,'cookie':self.cookie,'session':'session-'+str(n),'crashAt':crash}
  p=subprocess.run([str(NODE),str(PKG/'p3/test/run-fx.mjs')],input=json.dumps(c).encode(),capture_output=True,timeout=100)
  if crash:assert p.returncode==92,(p.stdout.decode(),p.stderr.decode());return
  assert p.returncode==0,(p.stdout.decode(),p.stderr.decode());return json.loads(p.stdout)
 def counts(self):return json.loads(self.m.sql("SELECT jsonb_build_object('payments',(SELECT count(*) FROM mpp_direct_p3_operations WHERE kind='payment' AND tx_hash IS NOT NULL),'refunds',(SELECT count(*) FROM mpp_direct_p3_operations WHERE kind='refund' AND state='final'),'executions',(SELECT count(*) FROM p2_fixture_seller_claims),'tools',(SELECT count(*) FROM mpp_direct_p2_tools),'chainTransfers',(SELECT count(*) FROM p3_fixture_requests))"))
 def restart_proxy(self):
  self.processes[-1].kill();self.processes[-1].wait(timeout=5);self.url=self.launch(PKG/'p3/server.mjs',self.configPath,'p3-restarted');self.login()
 def fault(self,**kwargs):return request(self.wallet+'/fixture/fault',kwargs,{'x-fixture-key':self.code})

def signature_failure(binary):
 with P3(binary) as x:
  x.fault(name='sign_down',value=True);h=x.claim();result=x.native(headers=h)
  assert result[0]!=200,result
  wait_for(lambda:x.counts()['refunds']==1,20)
  assert x.counts()=={'payments':1,'refunds':1,'executions':0,'tools':0,'chainTransfers':2},x.counts()
  assert x.m.sql("SELECT sum(actual_gas_yocto)::text FROM mpp_direct_p3_operations WHERE kind='payment'")=='3000000000000000000'
  assert x.m.sql("SELECT sum(reserved_nano) FROM mpp_direct_tasks")=='0'
  return {'case':'paid-signature-failure-refunds-without-admission-or-repay','passed':True,'counts':x.counts()}

def lost_ack(binary):
 with P3(binary) as x:
  x.fault(name='drop_ack',value=True);h=x.claim()
  with ThreadPoolExecutor(max_workers=1) as pool:
   pending=pool.submit(lambda:x.native(headers=h))
   wait_for(lambda:x.m.sql("SELECT count(*) FROM mpp_direct_p3_operations WHERE state='review'")=='1',20)
   assert x.m.sql('SELECT count(*) FROM p3_fixture_requests')=='1'
   assert x.control(1,'pause')[0]==200
   r=pending.result(timeout=20);assert r[0]!=200
  x.restart_proxy()
  assert x.m.sql('SELECT count(*) FROM p3_fixture_requests')=='1'
  assert int(x.m.sql('SELECT sum(reserved_nano) FROM mpp_direct_tasks'))>0
  assert x.m.sql('SELECT count(*) FROM market_inference_requests')=='0'
  return {'case':'lost-native-ack-survives-restart-without-second-post-or-release','passed':True}

def owner_revocation(binary):
 with P3(binary) as x:
  c=x.api('authorization/revoke',{});assert c[0]==200,c
  assert x.api('sessions/session-1/claim',{'writer':os.urandom(32).hex(),'expectedGeneration':'0','force':True})[0]!=200
  assert x.m.sql('SELECT count(*) FROM p3_fixture_requests')=='0'
  assert x.api('sessions/session-1')[0]==200
  return {'case':'owner-revocation-stops-new-effects-keeps-read-recovery','passed':True}

def project_revocation(binary):
 with P3(binary) as x:
  assert 'plan' not in request(x.url+'/buyer-api/config')[1]
  assert x.api('authorization/revoke',{'role':'project'})[0]==200
  assert x.m.sql("SELECT active FROM mpp_direct_p3_grants WHERE role='owner'")=='t'
  assert x.m.sql("SELECT active FROM mpp_direct_p3_grants WHERE role='project'")=='f'
  assert x.m.sql("SELECT count(*) FROM mpp_direct_tasks WHERE paused")=='2'
  assert x.counts()['payments']==0
  return {'case':'project-cost-revocation-fences-both-agents-private-plan-owner-only','passed':True}

def happy(binary):
 with P3(binary) as x:
  with ThreadPoolExecutor(max_workers=2) as pool:r=list(pool.map(x.fx,[1,2]))
  assert all(v['result']['stopReason']=='end_turn' for v in r),r
  wait_for(lambda:x.counts()['refunds']==4,20)
  assert x.counts()=={'payments':4,'refunds':4,'executions':4,'tools':2,'chainTransfers':8},x.counts()
  for i,expected in [(1,'42\n'),(2,'19\n')]:
   s=x.status(i);assert s['workspace']['/workspace/result.txt']==expected and s['workspace']['/workspace/applications.log']=='applied\n',s
  assert x.m.sql("SELECT count(*) FROM mpp_direct_orders WHERE received AND p<>c+h+w+r")=='0'
  assert x.m.sql("SELECT count(*) FROM mpp_direct_p3_operations WHERE kind='payment' AND actual_gas_yocto=3000000000000000000")=='4'
  x.restart_proxy();assert x.status()['state']=='complete';assert x.counts()['chainTransfers']==8
  return {'case':'two-fx-native-outlayer-principal-gas-refunds-restart','passed':True,'counts':x.counts()}

def pause_resume(binary):
 with P3(binary) as x:
  # Pause after the virtual tool committed but before fx acknowledged it.
  # Resume must recover that effect and its paid response, not apply it twice.
  x.fx(1,crash='after_tool')
  assert x.control(1,'pause')[0]==200
  s=x.status()
  assert x.api('sessions/session-1/claim',{'writer':os.urandom(32).hex(),'expectedGeneration':s['generation'],'force':True})[1]['error']['code']=='task_not_running'
  assert x.api('authorization/revoke',{'role':'owner'})[0]==200
  assert x.control(1,'resume')[1]['error']['code']=='run_authorization_required'
  x.grants()
  assert x.control(1,'resume')[0]==200
  assert x.fx()['result']['stopReason']=='end_turn'
  wait_for(lambda:x.counts()['refunds']==2,20)
  assert x.status()['workspace']['/workspace/result.txt']=='42\n'
  assert x.status()['workspace']['/workspace/applications.log']=='applied\n'
  assert x.counts()=={'payments':2,'refunds':2,'executions':2,'tools':1,'chainTransfers':4},x.counts()
  return {'case':'pause-revoke-reauthorize-resume-original-fx-tool-turn','passed':True,'counts':x.counts()}

if __name__=='__main__':
 a=argparse.ArgumentParser();a.add_argument('binary');a.add_argument('--evidence',default=str(ROOT/'docs/acceptance/2026-11-14-outlayer-p3-matrix.json'));args=a.parse_args()
 checks=[happy(args.binary),signature_failure(args.binary),lost_ack(args.binary),owner_revocation(args.binary),project_revocation(args.binary),pause_resume(args.binary)];Path(args.evidence).write_text(json.dumps({'scope':'local-original-market-and-outlayer-shaped-doubles','realChain':False,'realProvider':False,'cases':checks},indent=2)+'\n');print(json.dumps({'passed':len(checks),'evidence':args.evidence}))
