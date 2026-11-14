#!/usr/bin/env python3
"""Controlled P2: real original Market/PG/Redis, real fx and virtual just-bash.
NEAR/delegated wallet/seller are local fixtures. No paid or real-chain requests.
"""
import argparse,hashlib,json,os,subprocess,sys,threading,time,io,shutil
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from http.server import ThreadingHTTPServer,BaseHTTPRequestHandler
from urllib.parse import urlsplit
from market_b_support import Market,run,wait_for,free_port
from importlib import import_module
p1=import_module('accept-agent-mpp-p1');request,literal=p1.request,p1.literal
ROOT=Path(__file__).resolve().parent.parent;PKG=ROOT/'services/mpp-near-direct';NODE=Path(os.environ.get('P1_NODE',shutil.which('node') or 'node'))
def tokens(body):
 def size(v):return len(v.encode()) if isinstance(v,str) else sum(map(size,v)) if isinstance(v,list) else sum(map(size,v.values())) if isinstance(v,dict) else 0
 return max(1,(size(body.get('messages'))+size(body.get('tools'))+8*len(body['messages'])+3)//4)
class SellerHandler(BaseHTTPRequestHandler):
 def log_message(self,*_):pass
 def reply(self,status,value):
  text=json.dumps(value).encode();self.send_response(status);self.send_header('content-type','application/json');self.send_header('content-length',str(len(text)));self.end_headers();self.wfile.write(text)
 def do_POST(self):
  s=self.server;body=json.loads(self.rfile.read(int(self.headers['content-length'])))
  if self.path=='/tokenize':return self.reply(200 if tokens(body['request'])<=512 else 400,{'tokenizer_ref':'controlled/tokenizer-v1','token_ids':list(range(512))})
  if self.path!='/v1/chat/completions' or self.headers.get('Authorization')!='Bearer '+s.credential:return self.reply(403,{'error':'seller_identity_required'})
  if any(k.startswith('bitrouter_') or k=='background' for k in body) or any(k.lower().startswith(('x-fx-','x-p2-')) for k in self.headers):return self.reply(400,{'error':'private_metadata_leaked'})
  claimed=s.market.sql("WITH eligible AS(SELECT o.id FROM mpp_direct_orders o JOIN mpp_direct_capacity c ON c.lease_order=o.id WHERE c.admissions=1 AND o.admitted_request IS NOT NULL AND ((o.internal_body-'background'-'bitrouter_delivery')||'{\"model\":\"native-a\"}'::jsonb)="+literal(json.dumps(body))+"::jsonb),claim AS(INSERT INTO p2_fixture_seller_claims(order_id,body) SELECT id,"+literal(json.dumps(body))+"::jsonb FROM eligible ON CONFLICT DO NOTHING RETURNING order_id) SELECT count(*) FROM claim")
  if claimed!='1':return self.reply(409,{'error':'original_execution_already_claimed_or_no_lease'})
  s.calls.append(body);self.send_response(200);self.send_header('content-type','text/event-stream');self.end_headers()
  def frame(delta=None,finish=None,usage=None):return ('data: '+json.dumps({'id':'controlled-'+body['user'],'object':'chat.completion.chunk','created':1,'model':'native-a','choices':[] if usage else [{'index':0,'delta':delta or {},'finish_reason':finish}],**({'usage':usage} if usage else {})})+'\n\n').encode()
  try:
   output=6
   if not body.get('tools'):
    self.wfile.write(frame({'role':'assistant','content':'verified'}));reason='stop'
   elif any(m['role']=='tool' for m in body['messages']):
    result=next(m['content'] for m in reversed(body['messages']) if m['role']=='tool');parsed=json.loads(result);value=parsed.get('stdout','').strip()
    self.wfile.write(frame({'role':'assistant','content':'Verified result: '+value}));reason='stop'
   else:
    command="echo applied >> /workspace/applications.log; awk '{s+=$1} END {print s}' /workspace/numbers.txt > /workspace/result.txt; cat /workspace/result.txt"
    args=json.dumps({'command':command},separators=(',',':'));output=(len(args.encode())+3)//4+4
    if s.mode=='malformed':args=args[:-4]
    middle=len(args)//2;tid='tool-'+body['user'][-12:]
    self.wfile.write(frame({'role':'assistant','tool_calls':[{'index':0,'id':tid,'type':'function','function':{'name':'bash','arguments':args[:middle]}}]}));self.wfile.flush()
    self.wfile.write(frame({'tool_calls':[{'index':0,'function':{'arguments':args[middle:]}}]}));reason='tool_calls'
   self.wfile.flush();assert s.release.wait(20)
   if s.mode=='disconnect':return
   self.wfile.write(frame(finish=reason));self.wfile.write(frame(usage={'prompt_tokens':512,'completion_tokens':output,'total_tokens':512+output}));self.wfile.write(b'data: [DONE]\n\n');self.wfile.flush()
  except (BrokenPipeError,ConnectionResetError):pass
class P2:
 def __init__(self,binary,slow_bootstrap=False):self.m=Market(binary,initialize=False);self.processes=[];self.logs=[];self.slow_bootstrap=slow_bootstrap
 def __enter__(self):
  m=self.m.__enter__()
  try:
   m.redis.terminate();m.redis.wait(timeout=5);self.start_redis()
   m.env.update(PRIVATE_MARKET_NEAR_DIRECT_P1='controlled',PRIVATE_MARKET_AGENT_P2='controlled',PRIVATE_MARKET_LISTEN='127.0.0.1:'+str(free_port()))
   delayed=[]
   def delay_bootstrap():
    try:
     wait_for(lambda:m.sql("SELECT to_regclass('public.market_inference_hosts')")!='')
     wait_for(lambda:int(m.sql('SELECT coalesce(max(sequence),0) FROM market_inference_hosts'))>0)
     run('psql',m.direct,'-X','-q','-v','ON_ERROR_STOP=1','-c','BEGIN; LOCK TABLE market_inference_hosts IN ACCESS EXCLUSIVE MODE; SELECT pg_sleep(1.25); COMMIT;')
     delayed.append(True)
    except BaseException as e:delayed.append(e)
   delay=threading.Thread(target=delay_bootstrap,daemon=True) if self.slow_bootstrap else None
   if delay:delay.start()
   assert json.loads(run(m.binary,'init',str(m.state),env=m.env))['test_credit_micro_usd']==0
   if delay:
    delay.join(timeout=20);assert delayed==[True],delayed
   m.data=json.loads((m.state/'state.json').read_text());m.buyers=m.data['buyers'];self.start_seller();self.start_host()
   if self.slow_bootstrap:
    observation=json.loads((m.state/'catalog.json').read_text())['products'][0]['candidates'][0]['candidate']['input']['throughput_observation']
    assert observation['ended_at']-observation['offering']['observed_at']>=1250,'slow bootstrap was not exercised'
    assert observation['ended_at']-observation['started_at']==1,'synthetic throughput must not measure database bootstrap'
    self.bootstrapEvidence={'bootstrapElapsedMs':observation['ended_at']-observation['offering']['observed_at'],'syntheticObservationMs':observation['ended_at']-observation['started_at']}
   self.buyerKey=os.urandom(24).hex();self.merchantKey=os.urandom(24).hex();self.controlKey=os.urandom(24).hex();self.code=os.urandom(32).hex();self.otherCode=os.urandom(32).hex()
   for code,owner in [(self.code,'owner-a'),(self.otherCode,'owner-b')]:m.sql('INSERT INTO mpp_direct_p2_owners VALUES('+literal(hashlib.sha256(code.encode()).hexdigest())+','+literal(owner)+')')
   for i,payer in enumerate(['agent.testnet','agent2.testnet']):
    user=m.buyers[i]['user'];token=m.buyers[i]['token'];task='task-'+str(i+1);session='session-'+str(i+1)
    m.sql("INSERT INTO mpp_direct_agents(user_id,token_hash,agent_id,payer,binding_version,native_balance,owner_id) VALUES("+','.join(map(literal,[user,hashlib.sha256(token.encode()).hexdigest(),'agent-'+str(i+1),payer,'binding-1','{}','owner-a']))+")")
    m.sql('INSERT INTO mpp_direct_p2_agent_limits(user_id,budget_nano) VALUES('+literal(user)+',20000000)')
    m.sql('INSERT INTO mpp_direct_tasks(id,user_id,budget_nano,hard_bid_nano,call_cap_nano,deadline_ms) VALUES('+','.join(map(literal,[task,user,10000000,3000000,3000000,int(time.time()*1000)+180000]))+')')
    numbers='3\n7\n32\n' if i==0 else '5\n5\n9\n';workspace={'/workspace/task.txt':'Compute the sum of numbers.txt, write result.txt, and verify the result.','/workspace/numbers.txt':numbers}
    m.sql('INSERT INTO mpp_direct_p2_sessions(id,user_id,task_id,prompt,workspace,created_ms) VALUES('+','.join(map(literal,[session,user,task,workspace['/workspace/task.txt'],json.dumps(workspace),int(time.time()*1000)]))+')')
   m.sql('INSERT INTO mpp_direct_project_budget(id,budget_yocto) VALUES(1,10000000000000000000000)')
   m.sql('INSERT INTO mpp_direct_p2_market(singleton,observed_ms,usable_ms) VALUES(true,'+str(int(time.time()*1000))+',500)')
   self.walletConfig=m.root/'wallet.json';self.walletConfig.write_text(json.dumps({'databaseUrl':m.direct,'buyerWalletKey':self.buyerKey,'walletFixtureKey':self.merchantKey,'faultControlKey':self.controlKey,'port':free_port()}));self.walletConfig.chmod(0o600)
   self.wallet=self.launch(PKG/'p2/test/wallet-fixture.mjs',self.walletConfig,'wallet')
   self.config={'port':free_port(),'agentCredentials':[{'userId':b['user'],'token':b['token']} for b in m.buyers[:2]],'payments':{'mode':'controlled','phase2':True,'network':'testnet','realBroadcastEnabled':False,'databaseUrl':m.direct,'upstream':m.url,'rpcUrl':self.wallet+'/rpc','walletFixtureUrl':self.wallet,
    'buyerWalletKey':self.buyerKey,'walletFixtureKey':self.merchantKey,'faultControlKey':self.controlKey,'gasSponsor':'sponsor.testnet','hostBinary':m.binary,'realm':'payments.example.com','merchant':'merchant.testnet','secret':os.urandom(32).hex(),
    'rateNanoPerNear':'2000000000','storagePriceYocto':'10000000000000000000','gasEstimateYocto':'100000000000000000000','paymentWindowMs':60000,'leaseTailMs':15000,'paymentEstimateMs':100,'estimatedTerminalMs':500,'refundAuto':True,'port':free_port()}}
   self.configPath=m.root/'p2.json';self.configPath.write_text(json.dumps(self.config));self.configPath.chmod(0o600)
   self.url=self.launch(PKG/'p2/server.mjs',self.configPath,'p2');self.login();return self
  except BaseException:self.__exit__(*sys.exc_info());raise
 def start_seller(self):
  m=self.m;host,port=m.data['fixture_addr'].split(':');s=ThreadingHTTPServer((host,int(port)),SellerHandler);s.daemon_threads=True;s.market=m;s.credential=m.env['PRIVATE_MARKET_SELLER_KEY'];s.release=threading.Event();s.release.set();s.mode='normal';s.calls=[];m.seller=s
  m.sql('CREATE TABLE IF NOT EXISTS p2_fixture_seller_claims(order_id text PRIMARY KEY,body jsonb NOT NULL)');threading.Thread(target=s.serve_forever,daemon=True).start()
 def start_host(self):
  m=self.m;m.log.seek(0);m.log.truncate();m.host=subprocess.Popen([m.binary,'serve',str(m.state)],env=m.env,stdout=m.log,stderr=m.log)
  def ready():
   assert m.host.poll() is None,(m.root/'host.log').read_text()
   return next((json.loads(l)['url'] for l in (m.root/'host.log').read_text().splitlines() if l.startswith('{') and '"url"' in l),None)
  # Original Redis balance-repair custody lasts 30s. A crash can legitimately
  # require waiting for it; never delete ownership or cash/repair keys.
  m.url=wait_for(ready,75)
 def start_redis(self):
  port=urlsplit(self.m.env['REDIS_URL']).port
  self.m.redis=subprocess.Popen(['redis-server','--bind','127.0.0.1','--port',str(port),'--dir',str(self.m.root),'--appenddirname','redis-aof','--save','','--appendonly','yes','--appendfsync','always','--maxmemory-policy','noeviction'],stdout=subprocess.DEVNULL)
  wait_for(lambda:subprocess.run(['redis-cli','-p',str(port),'ping'],capture_output=True).stdout.strip()==b'PONG')
 def launch(self,script,config,name):
  log=(self.m.root/(name+'.log')).open('w+');self.logs.append(log);p=subprocess.Popen([str(NODE),str(script),str(config)],stdout=log,stderr=log);self.processes.append(p)
  def ready():
   assert p.poll() is None,Path(log.name).read_text()
   return next((json.loads(l)['url'] for l in Path(log.name).read_text().splitlines() if l.startswith('{')),None)
  return wait_for(ready,20)
 def login(self,code=None):
  r=request(self.url+'/buyer-api/login',{'code':code or self.code});assert r[0]==200,r
  self.cookie=r[2]['set-cookie'].split(';')[0];return self.cookie
 def api(self,path,body=None,cookie=None,headers=None):return request(self.url+'/buyer-api/'+path,body,{'cookie':cookie or self.cookie,**(headers or {})})
 def status(self,n=1):return self.api('sessions/session-'+str(n))[1]
 def claim(self,n=1,force=False,writer=None):
  s=self.status(n);writer=writer or os.urandom(32).hex();r=self.api('sessions/session-'+str(n)+'/claim',{'writer':writer,'expectedGeneration':s['generation'],'force':force});assert r[0]==200,r
  return {'x-fx-writer':writer,'x-fx-generation':str(r[1]['generation'])}
 def native(self,n=1,headers=None,body=None):
  body=body or {'model':'m/external','messages':[{'role':'user','content':'Controlled bounded request'}],'max_tokens':64,'stream':True}
  return self.api('sessions/session-'+str(n)+'/inference',{'body':json.dumps(body,separators=(',',':'))},headers=headers)
 def control(self,n,action,**extra):
  s=self.status(n);return self.api('sessions/session-'+str(n)+'/control',{'action':action,'expectedRevision':s['task']['revision'],'operation':os.urandom(12).hex(),**extra})
 def async_fx(self,n=1,crash=None):
  data={'url':self.url,'ownerCode':self.code,'session':'session-'+str(n),'force':True,'crashAt':crash}
  return subprocess.Popen([str(NODE),str(PKG/'p2/test/run-fx.mjs')],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE),json.dumps(data).encode()
 def fx(self,n=1,crash=None):
  session='session-'+str(n) if isinstance(n,int) else n
  data={'url':self.url,'ownerCode':self.code,'session':session,'force':True,'crashAt':crash}
  p=subprocess.run([str(NODE),str(PKG/'p2/test/run-fx.mjs')],input=json.dumps(data).encode(),capture_output=True,timeout=90)
  if crash:assert p.returncode==92,(p.stdout.decode(),p.stderr.decode());return None
  assert p.returncode==0,(p.stdout.decode(),p.stderr.decode());return json.loads(p.stdout)
 def set(self,key,value):self.m.sql('INSERT INTO p1_fixture_settings VALUES('+literal(key)+','+literal(json.dumps(value))+'::jsonb) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
 def counts(self):return json.loads(self.m.sql("SELECT jsonb_build_object('payments',(SELECT count(*) FROM p1_fixture_chain WHERE kind='payment'),'refunds',(SELECT count(*) FROM p1_fixture_chain WHERE kind='refund'),'executions',(SELECT count(*) FROM p2_fixture_seller_claims),'tools',(SELECT count(*) FROM mpp_direct_p2_tools))"))
 def restart_all(self):
  for p in reversed(self.processes):
   if p.poll() is None:p.kill();p.wait(timeout=5)
  self.m.stop(crash=True);self.m.seller.shutdown();self.m.seller.server_close();self.m.seller=None
  self.m.redis.kill();self.m.redis.wait(timeout=5)
  run('pg_ctl','-D',str(self.m.pg),'-m','immediate','-w','stop');self.m.pg_started=False
  pgport=urlsplit(self.m.direct).port
  run('pg_ctl','-D',str(self.m.pg),'-l',str(self.m.root/'pg.log'),'-o',f'-h 127.0.0.1 -p {pgport} -k {self.m.root}','-w','start');self.m.pg_started=True
  self.start_redis()
  self.start_seller();self.start_host();self.wallet=self.launch(PKG/'p2/test/wallet-fixture.mjs',self.walletConfig,'wallet-restarted');self.url=self.launch(PKG/'p2/server.mjs',self.configPath,'p2-restarted');self.login()
 def __exit__(self,*args):
  if args and args[0]:
   for l in self.logs:l.flush();print(Path(l.name).read_text(),file=sys.stderr)
  for p in reversed(self.processes):
   if p.poll() is None:p.kill();p.wait(timeout=5)
  for l in self.logs:l.close()
  self.m.__exit__(*args)
def happy(binary):
 with P2(binary,slow_bootstrap=True) as x:
  with ThreadPoolExecutor(max_workers=2) as pool:results=list(pool.map(x.fx,[1,2]))
  assert all(r['result']['stopReason']=='end_turn' for r in results),results
  statuses=[x.status(i) for i in [1,2]]
  for s,result in zip(statuses,['42\n','19\n']):assert s['state']=='complete' and s['workspace']['/workspace/result.txt']==result and s['workspace']['/workspace/applications.log']=='applied\n',s
  wait_for(lambda:x.counts()['refunds']==4)
  assert x.counts()=={'payments':4,'refunds':4,'executions':4,'tools':2},x.counts()
  return {'case':'two-real-fx-tasks-tool-continuations','passed':True,'counts':x.counts(),'tasks':statuses,'slowBootstrapRegression':x.bootstrapEvidence}
def crash_test(binary,phase):
 with P2(binary) as x:
  x.fx(1,phase);before=x.counts();x.restart_all()
  if phase=='after_tool':
   h=x.claim(1,force=True);body=x.m.sql("SELECT original_body FROM mpp_direct_p2_calls WHERE session_id='session-1' ORDER BY progress_version LIMIT 1")
   counts=x.counts();calls=len(x.status(1)['calls'])
   replay=request(x.url+'/v1/chat/completions',body,{'cookie':x.cookie,'x-fx-session':'session-1',**h})
   assert replay[0]==200,replay
   assert len(x.status(1)['calls'])==calls and all(x.counts()[k]==counts[k] for k in ['payments','executions','tools']),'old request renamed after tool commit'
  r=x.fx(1)
  assert r['result']['stopReason']=='end_turn',r
  wait_for(lambda:x.counts()['refunds']==2)
  state=x.status(1)
  assert x.counts()=={'payments':2,'refunds':2,'executions':2,'tools':1},x.counts()
  assert state['workspace']['/workspace/applications.log']=='applied\n' and state['workspace']['/workspace/result.txt']=='42\n'
  return {'case':'all-process-restart-'+phase,'passed':True,'before':before,'after':x.counts()}
def isolation(binary):
 with P2(binary) as x:
  other=x.login(x.otherCode)
  assert x.api('sessions/session-1',cookie=other)[0]==404
  assert x.api('agents',cookie=other)[1]['agents']==[]
  x.login();h=x.claim(1)
  assert x.api('sessions/session-2/journal',{'load':True},headers=h)[0]==409
  assert x.api('sessions/session-1/tool',{'executionId':'forged','command':'echo forged > /workspace/result.txt'},headers=h)[0]==400
  old=h;x.claim(1,force=True)
  assert x.api('sessions/session-1/journal',{'load':True},headers=old)[0]==409
  assert x.counts()['payments']==0 and x.counts()['tools']==0
  assert x.control(1,'pause')[0]==200
  r=x.fx(2);assert r['result']['stopReason']=='end_turn'
  assert x.status(1)['task']['paused'] and x.status(2)['state']=='complete'
  return {'case':'owner-agent-writer-isolation-and-independent-pause','passed':True}
def policy(binary):
 with P2(binary) as x:
  x.m.sql("UPDATE mpp_direct_tasks SET preference='save',max_wait_ms=1800 WHERE id='task-1'")
  r=x.fx(1);assert r['result']['stopReason']=='end_turn',r
  revisions=json.loads(x.m.sql("SELECT jsonb_agg(jsonb_build_object('actor',actor,'decision',decision)) FROM mpp_direct_p2_revisions"))
  assert any(r['actor']=='auto' and r['decision']['reason']=='urgency_accept_existing_service' for r in revisions)
  decisions=json.loads(x.m.sql("SELECT jsonb_agg(snapshot->'result') FROM mpp_direct_p2_decisions"))
  assert any(d['action']=='wait' for d in decisions)
  return {'case':'persistent-cost-speed-wait-and-bid-revisions','passed':True,'revisions':revisions}
def manual_wait(binary):
 with P2(binary) as x:
  x.m.sql('UPDATE mpp_direct_p2_market SET available=false')
  with ThreadPoolExecutor(max_workers=1) as pool:
   job=pool.submit(x.fx,1)
   s=wait_for(lambda:(s if (s:=x.status(1))['calls'] else None));c=s['calls'][0]
   payload={'action':'revise_bid','bidNano':'1','expectedRevision':c['revision'],'operation':'manual-one'}
   assert x.api('calls/'+c['id'],payload,headers=None)[0]==404 # POST is not PATCH
   from urllib.request import Request
   def patch(data):
    q=Request(x.url+'/buyer-api/calls/'+c['id'],data=json.dumps(data).encode(),method='PATCH',headers={'cookie':x.cookie,'content-type':'application/json'})
    try:r=p1.HTTP.open(q,timeout=10)
    except p1.HTTPError as e:r=e
    with r:return r.status,json.loads(r.read())
   first=patch(payload);assert first[0]==200,first
   assert patch(payload)==first
   assert patch({**payload,'operation':'stale','bidNano':'2'})[0]==409
   assert x.control(1,'pause')[0]==200
   wait_for(lambda:job.done())
   try:stopped=job.result();assert stopped['result']['stopReason']!='end_turn'
   except AssertionError as e:assert any(k in str(e) for k in ['fenced','journal append failed']),str(e)
  before=x.status(1)['calls'][0];assert before['manual'] and before['bid_nano']=='1' and x.counts()['payments']==0
  assert x.control(1,'resume')[0]==200
  current=x.status(1)['calls'][0];assert current['started_ms']==c['started_ms']
  # Explicitly resume auto, then make actual supply eligible.
  assert patch({'action':'resume_auto','expectedRevision':current['revision'],'operation':'auto-resume'})[0]==200
  x.m.sql("UPDATE mpp_direct_tasks SET max_wait_ms=60000,preference='fast' WHERE id='task-1'")
  x.m.sql("UPDATE mpp_direct_p2_calls SET preference='fast' WHERE id="+literal(c['id']))
  x.m.sql('UPDATE mpp_direct_p2_market SET available=true')
  r=x.fx(1);assert r['result']['stopReason']=='end_turn',r
  return {'case':'manual-cas-pause-resume-preserves-original-clock','passed':True}
def limits(binary):
 with P2(binary) as x:
  x.m.sql("UPDATE mpp_direct_tasks SET budget_nano=1100000 WHERE id='task-1'")
  r=x.fx(1);assert r['result']['stopReason']!='end_turn'
  assert x.counts()['payments']==0 and x.counts()['executions']==0
  assert x.m.sql("SELECT count(*) FROM mpp_direct_p2_decisions WHERE snapshot->'result'->>'reason'='hard_task_budget_exhausted'")!='0'
  return {'case':'two-layer-hard-budget-stops-before-payment','passed':True}
def malformed(binary):
 with P2(binary) as x:
  x.m.seller.mode='malformed';r=x.fx(1)
  assert r['result']['stopReason']!='end_turn'
  assert x.counts()['payments']==1 and x.counts()['executions']==1 and x.counts()['tools']==0
  return {'case':'malformed-native-tool-stream-never-applies-tool','passed':True}
def refund_wait(binary):
 with P2(binary) as x:
  x.set('refundFinality','EXECUTED');x.m.sql("UPDATE mpp_direct_tasks SET budget_nano=2650000 WHERE id='task-1'")
  with ThreadPoolExecutor(max_workers=1) as pool:
   job=pool.submit(x.fx,1)
   wait_for(lambda:x.counts()['tools']==1 and len(x.status(1)['calls'])==2)
   time.sleep(.3);assert x.counts()['payments']==1,x.counts()
   s=x.status(1);assert int(s['task']['reserved_nano'])>0 and s['calls'][1]['state']=='bidding',s
   started=s['calls'][1]['started_ms'];x.set('refundFinality','FINAL')
   transactions=json.loads(x.m.sql("SELECT jsonb_agg(tx_hash) FROM p1_fixture_chain WHERE kind='refund'"))
   for tx in transactions:assert request(x.wallet+'/fixture/finalize',{'txHash':tx},{'x-fixture-key':x.controlKey})[0]==200
   result=job.result(timeout=35);assert result['result']['stopReason']=='end_turn',result
  assert x.status(1)['calls'][1]['started_ms']==started and x.counts()['payments']==2
  return {'case':'unconfirmed-refund-cannot-fund-paid-continuation','passed':True}
def waiting_restart(binary):
 with P2(binary) as x:
  x.m.sql('UPDATE mpp_direct_p2_market SET available=false')
  p,data=x.async_fx();p.stdin.write(data);p.stdin.close()
  wait_for(lambda:len(x.status(1)['calls'])==1);before=x.status(1)['calls'][0];p.kill();p.wait(timeout=5)
  x.restart_all();after=x.status(1)['calls'][0]
  assert after['started_ms']==before['started_ms'] and after['deadline_ms']==before['deadline_ms'] and x.counts()['payments']==0
  x.m.sql('UPDATE mpp_direct_p2_market SET available=true');r=x.fx(1);assert r['result']['stopReason']=='end_turn',r
  return {'case':'waiting-all-process-restart-preserves-original-deadline','passed':True}
def stale_forecast(binary):
 with P2(binary) as x:
  x.set('freezeForecast',True);x.m.sql('UPDATE mpp_direct_p2_market SET observed_ms=1');x.m.sql("UPDATE mpp_direct_tasks SET max_wait_ms=1000 WHERE id='task-1'")
  r=x.fx(1);assert r['result']['stopReason']!='end_turn'
  assert x.counts()['payments']==0 and x.counts()['executions']==0
  return {'case':'stale-forecast-rejected-without-clock-reset','passed':True}
def shared_wallet(binary):
 with P2(binary) as x:
  created=x.api('agents/agent-1/tasks',{'prompt':'Compute sum of numbers.txt and verify result.txt.','budgetNano':'10000000','preference':'balanced'})
  assert created[0]==201,created
  user=x.m.buyers[0]['user'];x.m.sql('UPDATE mpp_direct_p2_agent_limits SET budget_nano=2000000 WHERE user_id='+literal(user));x.m.sql('UPDATE mpp_direct_tasks SET max_wait_ms=2000 WHERE user_id='+literal(user))
  with ThreadPoolExecutor(max_workers=2) as pool:results=list(pool.map(x.fx,[1,created[1]['id']]))
  assert all(r['result']['stopReason']!='end_turn' for r in results)
  assert x.counts()['payments']==1 and x.counts()['executions']==1,x.counts()
  assert x.m.sql('SELECT reserved_nano+spent_nano<=budget_nano FROM mpp_direct_p2_agent_limits WHERE user_id='+literal(user))=='t'
  assert x.m.sql('SELECT l.reserved_nano=(SELECT sum(reserved_nano) FROM mpp_direct_tasks WHERE user_id=l.user_id) AND l.spent_nano=(SELECT sum(spent_nano) FROM mpp_direct_tasks WHERE user_id=l.user_id) FROM mpp_direct_p2_agent_limits l WHERE user_id='+literal(user))=='t'
  return {'case':'concurrent-tasks-share-one-agent-authorization','passed':True}
def unknown(binary):
 with P2(binary) as x:
  x.m.seller.mode='disconnect';r=x.fx(1);assert r['result']['stopReason']!='end_turn'
  assert x.counts()=={'payments':1,'refunds':0,'executions':1,'tools':0},x.counts()
  assert x.m.sql('SELECT h=p AND w=0 AND c=0 FROM mpp_direct_orders')=='t'
  assert int(x.status(1)['task']['reserved_nano'])>0
  return {'case':'unknown-native-outcome-retains-money-and-dispatch-custody','passed':True}
def lost_ack(binary):
 with P2(binary) as x:
  x.set('dropPaymentAck',True);x.set('dropRefundAck',True);r=x.fx(1)
  assert r['result']['stopReason']=='end_turn',r
  wait_for(lambda:x.counts()['refunds']==2)
  assert x.counts()=={'payments':2,'refunds':2,'executions':2,'tools':1},x.counts()
  assert x.status(1)['workspace']['/workspace/applications.log']=='applied\n'
  return {'case':'fx-native-payment-and-refund-ack-loss-recovers-original','passed':True}
def main():
 p=argparse.ArgumentParser();p.add_argument('binary');p.add_argument('--evidence',type=Path);p.add_argument('--case',default='all');p.add_argument('--serve',type=Path);a=p.parse_args();binary=str(Path(a.binary).resolve())
 if a.serve:
  with P2(binary) as x:
   a.serve.write_text(json.dumps({'url':x.url,'ownerCode':x.code,'otherCode':x.otherCode,'root':str(x.m.root)}));a.serve.chmod(0o600);print(json.dumps({'url':x.url,'context':str(a.serve)}),flush=True)
   while not a.serve.with_suffix('.stop').exists():time.sleep(.2)
  return
 cases={'happy':happy,'crash-model':lambda b:crash_test(b,'after_model_1'),'crash-tool':lambda b:crash_test(b,'after_tool'),'crash-continuation':lambda b:crash_test(b,'after_model_2'),'isolation':isolation,'policy':policy,'manual':manual_wait,'limits':limits,'malformed':malformed,'refund-wait':refund_wait,'waiting-restart':waiting_restart,'stale':stale_forecast,'shared-wallet':shared_wallet,'unknown':unknown,'ack':lost_ack}
 if a.case!='all' and a.case not in cases:p.error('unknown case: '+a.case)
 checks=[]
 for key,fn in cases.items():
  if a.case in ['all',key]:checks.append(fn(binary));print('PASS '+key,file=sys.stderr,flush=True)
 result={'phase':'P2','mode':'controlled','realChainTransactions':0,'realProviderCalls':0,'checks':checks}
 if a.evidence:a.evidence.write_text(json.dumps(result,indent=2)+'\n')
 print(json.dumps(result,indent=2))
if __name__=='__main__':main()
