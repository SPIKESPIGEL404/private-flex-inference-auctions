#!/usr/bin/env python3
"""P1: actual original Market/PG/Redis + MPP Proxy, controlled NEAR and seller.

No external network, real chain transaction, provider fee, deployment or wallet.
"""
import argparse, contextlib, hashlib, json, os, subprocess, threading, time, io, shutil, sys
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from market_b_support import Market, Seller, SellerHandler, CommitProxy, run, wait_for, free_port
from http.server import ThreadingHTTPServer
from urllib.request import Request, build_opener, ProxyHandler
from urllib.error import HTTPError

ROOT=Path(__file__).resolve().parent.parent
NODE=Path(os.environ.get('P1_NODE',shutil.which('node') or 'node'))
PKG=ROOT/'services/mpp-near-direct'
HTTP=build_opener(ProxyHandler({}))
class Checks(list):
 def append(self,value):
  super().append(value);print('PASS '+value.get('case','native-sse' if value.get('nativeStream') else 'native-json'),file=sys.stderr,flush=True)
def request(url,body=None,headers=None):
 h=dict(headers or {})
 if body is not None:h['content-type']='application/json'
 q=Request(url,data=None if body is None else (body.encode() if isinstance(body,str) else json.dumps(body).encode()),headers=h)
 try:r=HTTP.open(q,timeout=30)
 except HTTPError as e:r=e
 with r:
  text=r.read().decode()
  try:value=json.loads(text)
  except ValueError:value=text
  return r.status,value,dict(r.headers)
def literal(v):return "'"+str(v).replace("'","''")+"'"

class CapacityHandler(SellerHandler):
 def do_POST(self):
  if self.path=='/v1/chat/completions':
   s=self.server
   if self.headers.get('Authorization')!='Bearer '+s.credential:self.send(400,b'{"error":"invalid_seller_credential"}');return
   # This is the controlled seller's actual admission gate, sharing the same
   # durable slot reserved BEFORE 402. Every accepted execution consumes it.
   raw=self.rfile.read(int(self.headers['Content-Length']));body=json.loads(raw)
   claimed=s.market.sql("WITH eligible AS(SELECT o.id FROM mpp_direct_capacity c JOIN mpp_direct_orders o ON o.id=c.lease_order WHERE c.admissions=1 AND o.admitted_request IS NOT NULL AND ((o.internal_body-'background'-'bitrouter_delivery')||'{\"model\":\"native-a\"}'::jsonb)="+literal(json.dumps(body))+"::jsonb), claim AS(INSERT INTO p1_fixture_seller_claims(order_id) SELECT id FROM eligible ON CONFLICT DO NOTHING RETURNING order_id) SELECT count(*) FROM claim")
   if claimed!='1':self.send(409,b'{"error":"no_owned_capacity_lease"}');return
   self.rfile=io.BytesIO(raw)
  super().do_POST()

class P1:
 def __init__(self,binary,proxy=False,refund_auto=False,window=60000,host_proxy=False):
  self.market=Market(binary,initialize=False);self.proxy=proxy;self.refund_auto=refund_auto;self.window=window;self.host_proxy=host_proxy
  self.processes=[];self.logs=[]
 def __enter__(self):
  m=self.market.__enter__();self.m=m
  try:
   m.env['PRIVATE_MARKET_NEAR_DIRECT_P1']='controlled'
   initialized=json.loads(run(m.binary,'init',str(m.state),env=m.env));assert initialized['test_credit_micro_usd']==0
   m.data=json.loads((m.state/'state.json').read_text());m.buyers=m.data['buyers']
   host,port=m.data['fixture_addr'].split(':')
   # Same native seller implementation, with a real capacity admission gate.
   seller=ThreadingHTTPServer((host,int(port)),CapacityHandler);seller.daemon_threads=True
   seller.market=m;seller.credential=m.env['PRIVATE_MARKET_SELLER_KEY'];seller.mode='success';seller.schema_text='{}';seller.calls=[]
   seller.release=threading.Event();seller.release.set();seller.active=seller.maximum=0;seller.lock=threading.Lock();seller.errors=[]
   threading.Thread(target=seller.serve_forever,daemon=True).start();m.seller=seller
   m.sql('CREATE TABLE p1_fixture_seller_claims(order_id text PRIMARY KEY)')
   m.env['PRIVATE_MARKET_LISTEN']='127.0.0.1:'+str(free_port())
   if self.host_proxy:
    from urllib.parse import urlsplit
    parsed=urlsplit(m.direct);m.proxy=CommitProxy(('127.0.0.1',parsed.port),financial_marker=b'INSERT INTO public.market_inference_requests(')
    m.env['DATABASE_URL']=parsed._replace(netloc=parsed.netloc.rsplit(':',1)[0]+':'+str(m.proxy.server_address[1])).geturl()
    m.data['database']=m.env['DATABASE_URL'];(m.state/'state.json').write_text(json.dumps(m.data))
   m.start();self.fixture_key=os.urandom(24).hex();self.buyer_key=os.urandom(24).hex();self.control_key=os.urandom(24).hex()
   fixture_config=m.root/'fixture.json';fixture_config.write_text(json.dumps({'databaseUrl':m.direct,'walletFixtureKey':self.fixture_key,'buyerWalletKey':self.buyer_key,'faultControlKey':self.control_key,'port':free_port()}));fixture_config.chmod(0o600)
   self.wallet=self.launch(PKG/'p1/test/fixture.mjs',fixture_config,'fixture')
   self.token=m.buyers[0]['token'];self.user=m.buyers[0]['user'];self.task='task-1'
   m.sql("INSERT INTO mpp_direct_agents(user_id,token_hash,agent_id,payer,binding_version,native_balance) VALUES("+
    ','.join(map(literal,[self.user,hashlib.sha256(self.token.encode()).hexdigest(),'agent-1','agent.testnet','binding-1','{}']))+")")
   m.sql(f"INSERT INTO mpp_direct_tasks(id,user_id,budget_nano,hard_bid_nano,call_cap_nano,deadline_ms) VALUES('task-1',{literal(self.user)},10000000,2000000,3000000,{int(time.time()*1000)+180000})")
   m.sql('INSERT INTO mpp_direct_project_budget(id,budget_yocto) VALUES(1,10000000000000000000000)')
   db=m.direct
   if self.proxy:
    from urllib.parse import urlsplit
    parsed=urlsplit(m.direct);m.proxy=CommitProxy(('127.0.0.1',parsed.port),financial_marker=b'UPDATE mpp_direct_orders SET received=true,h=p')
    db=parsed._replace(netloc=parsed.netloc.rsplit(':',1)[0]+':'+str(m.proxy.server_address[1])).geturl()
   self.config={'mode':'controlled','network':'testnet','realBroadcastEnabled':False,'databaseUrl':db,
    'upstream':m.url,'rpcUrl':self.wallet+'/rpc','walletFixtureUrl':self.wallet,'walletFixtureKey':self.fixture_key,'buyerWalletKey':self.buyer_key,'faultControlKey':self.control_key,'gasSponsor':'sponsor.testnet',
    'hostBinary':m.binary,'realm':'payments.example.com','merchant':'merchant.testnet','secret':os.urandom(32).hex(),
    'rateNanoPerNear':'2000000000','storagePriceYocto':'10000000000000000000','gasEstimateYocto':'100000000000000000000',
    'paymentWindowMs':self.window,'leaseTailMs':15000,
    'paymentEstimateMs':100,'estimatedTerminalMs':500,'refundAuto':self.refund_auto,'port':free_port()}
   self.config_path=m.root/'proxy.json';self.config_path.write_text(json.dumps(self.config));self.config_path.chmod(0o600)
   self.url=self.launch(PKG/'p1/server.mjs',self.config_path,'proxy')
   return self
  except BaseException:
   self.__exit__(*__import__('sys').exc_info());raise
 def launch(self,script,config,name):
  path=self.m.root/(name+'.log');log=path.open('w+');self.logs.append(log)
  p=subprocess.Popen([str(NODE),str(script),str(config)],stdout=log,stderr=log);self.processes.append(p)
  def ready():
   assert p.poll() is None,path.read_text()
   return next((json.loads(line)['url'] for line in path.read_text().splitlines() if line.startswith('{') and '"url"' in line),None)
  return wait_for(ready,20)
 def body(self,stream=True):
  b=self.m.body();b.pop('bitrouter_purchase');b.pop('bitrouter_delivery');b.pop('background');b['stream']=stream;return b
 def chat(self,key='call-1',body=None,proof=None):
  h={'authorization':'Bearer '+self.token,'idempotency-key':key,'x-agent-task':self.task}
  if proof:h['payment-authorization']=proof
  return request(self.url+'/v1/chat/completions',json.dumps(body or self.body(),separators=(',',':')),h)
 def client(self,key='call-1',stream=True):
  data={'url':self.url,'wallet':self.wallet,'fixtureKey':self.buyer_key,'token':self.token,'key':key,'task':self.task,'body':self.body(stream)}
  return json.loads(subprocess.check_output([str(NODE),str(PKG/'p1/test/client.mjs')],input=json.dumps(data).encode()))
 def get(self,id,op=None):
  return request(self.url+'/v1/orders/'+id+('/'+op if op else ''),{} if op else None,{'authorization':'Bearer '+self.token})
 def present(self,id,proof):return request(self.url+'/v1/orders/'+id+'/reconcile',{'credential':proof},{'authorization':'Bearer '+self.token})
 def set(self,key,value):self.m.sql(f"INSERT INTO p1_fixture_settings VALUES({literal(key)},{literal(json.dumps(value))}::jsonb) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
 def tick(self):return request(self.url+'/internal/refunds/tick',{}, {'x-p1-control':self.config['secret']})
 def count(self,kind):return int(self.m.sql(f"SELECT count(*) FROM p1_fixture_chain WHERE kind={literal(kind)}"))
 def restart_proxy(self):
  p=self.processes[-1];p.kill();p.wait(timeout=5)
  self.url=self.launch(PKG/'p1/server.mjs',self.config_path,'proxy-restarted')
 def replay_refund_ack(self):
  code="import pg from 'pg';import {Authority} from './p1/authority.mjs';const c=JSON.parse(await new Promise(r=>{let s='';process.stdin.on('data',b=>s+=b);process.stdin.on('end',()=>r(s));}));const pool=new pg.Pool({connectionString:c.databaseUrl});const a=new Authority({pool,config:c});const rows=(await pool.query('SELECT id,original_send FROM mpp_direct_refunds')).rows;for(const r of rows)await a.recordRefundSend(r.id,r.original_send);await pool.end();"
  subprocess.run([str(NODE),'--input-type=module','-e',code],cwd=PKG,input=json.dumps(self.config).encode(),check=True,capture_output=True)
 def __exit__(self,*args):
  if args and args[0]:
   for log in self.logs:log.flush();print(Path(log.name).read_text())
  for p in reversed(self.processes):
   if p.poll() is None:p.kill();p.wait(timeout=5)
  for log in self.logs:log.close()
  self.market.__exit__(*args)

def happy(binary,stream=True):
 with P1(binary) as x:
  assert x.m.balance()==0 and x.m.effects()==0
  r=x.client(stream=stream);assert r.get('status')==200,r
  assert 'verified' in r['body'];order=r['headers']['x-order-id']
  assert x.count('payment')==1 and len(x.m.seller.calls)==1
  final=wait_for(lambda:(r if (r:=x.get(order)[1])['principal']['W']!='0' else None))
  assert final['financial']['cash_micro_usd']==37,final
  p=final['principal'];assert int(p['P'])==sum(int(p[k]) for k in ['C','H','W','R'])
  # Another native identity / body cannot spend this order's refund balance.
  assert x.m.post('bypass-general-cash')[0]!=200
  assert x.m.balance()==671
  x.set('dropRefundAck',True);x.tick();assert x.count('refund')==1
  x.tick();done=x.get(order)[1];assert done['principal']['R']==p['W'] and done['principal']['W']=='0',(done,x.m.sql('SELECT last_error FROM mpp_direct_refunds'))
  assert x.m.balance()==0
  x.replay_refund_ack();assert x.m.sql('SELECT state FROM mpp_direct_refunds')=='confirmed'
  assert x.m.sql('SELECT reserved_nano||\':\'||spent_nano FROM mpp_direct_tasks')=='0:37000'
  assert x.m.sql('SELECT reserved_yocto::text||\':\'||spent_yocto::text FROM mpp_direct_project_budget')=='0:2000000000000000000'
  again=x.chat(body=x.body(stream),proof=r['proof']);assert again[0]==200,again
  assert len(x.m.seller.calls)==1 and x.count('payment')==1 and x.count('refund')==1
  assert done['decision']['buyerRouteFeeNano']=='0'
  assert {'quote_prepared','proof_presented','funds_recorded','native_admission_requested','admission_committed','financial_committed','native_response_read_finished'}<=set(t['stage'] for t in done['timings'])
  return {'case':'native-sse' if stream else 'native-json','passed':True,'nativeStream':stream,'providerCalls':1,'payments':1,'refunds':1,'cashAfterRefund':0,'order':done}

def quoted(x,key='call-1'):
 status,body,_=x.chat(key)
 if status!=402:
  diagnostic=json.loads(x.m.sql("SELECT jsonb_build_object('pgNowMs',floor(extract(epoch FROM clock_timestamp())*1000)::bigint,'pythonNowMs',"+str(int(time.time()*1000))+",'tasks',(SELECT jsonb_agg(to_jsonb(t)) FROM mpp_direct_tasks t),'user',"+literal(x.user)+")"))
  raise AssertionError((status,body,diagnostic))
 id=body['orderId'];challenge=json.loads(x.m.sql(f'SELECT challenge FROM mpp_direct_orders WHERE id={literal(id)}'))
 return id,challenge
def pay(x,challenge):
 r=request(x.wallet+'/wallet/pay',{'challenge':challenge},{'x-fixture-key':x.buyer_key});assert r[0]==200,r;return r[1]
def original_model(x,key='call-1',stream=True):
 return wait_for(lambda:(r if (r:=x.chat(key,body=x.body(stream)))[0]==200 else None),15)
def fault_tests(binary):
 checks=Checks()
 with P1(binary) as x:
  id,c=quoted(x);assert x.get(id,'cancel')[0]==200
  assert x.m.sql('SELECT reserved_nano FROM mpp_direct_tasks')=='0'
  assert x.m.sql('SELECT reserved_yocto FROM mpp_direct_project_budget')=='0'
  assert request(x.wallet+'/wallet/pay',{'challenge':c},{'x-fixture-key':x.buyer_key})[0]==400
  assert x.count('payment')==0
  assert request(x.wallet+'/merchant/refund',{'plan':{'operationId':'attack','amount':'9000000000000000000000000'}},{'x-fixture-key':x.buyer_key})[0]==403
  assert x.count('refund')==0
  checks.append({'case':'known-unsent-cancel-and-role-isolation','passed':True})
 with P1(binary) as x:
  x.set('nativeBalance','0');x.set('intentsBalance','999999999999999999999999999')
  assert x.chat()[0]!=402 and x.m.sql('SELECT count(*) FROM mpp_direct_orders')=='0'
  x.set('nativeBalance','354000000000000000000') # Exactly principal, zero buyer gas.
  x.m.sql('UPDATE mpp_direct_project_budget SET active=false')
  assert x.chat()[0]!=402 and x.m.sql('SELECT count(*) FROM mpp_direct_orders')=='0'
  x.m.sql('UPDATE mpp_direct_project_budget SET active=true')
  id,c=quoted(x);x.set('projectNativeBalance','0')
  assert request(x.wallet+'/wallet/pay',{'challenge':c},{'x-fixture-key':x.buyer_key})[0]==400 and x.count('payment')==0
  x.set('projectNativeBalance','100000000000000000000000000');p=pay(x,c);x.chat(proof=p['credential']);original_model(x)
  assert x.count('payment')==1 and len(x.m.seller.calls)==1
  checks.append({'case':'native-only-principal-and-project-sponsor-gate','passed':True})
 with P1(binary) as x:
  x.m.seller.mode='cap';r=x.client(stream=False);assert r['status']==200,r
  assert x.m.sql('SELECT reserved_nano||\':\'||spent_nano FROM mpp_direct_tasks')=='0:708000'
  assert x.m.sql('SELECT w FROM mpp_direct_orders')=='0'
  assert x.count('refund')==0 and len(x.m.seller.calls)==1
  checks.append({'case':'output-cap-no-refund-settles-task','passed':True})
 with P1(binary,window=3200) as x:
  x.set('paymentFinality','EXECUTED');id,c=quoted(x);p=pay(x,c)
  assert x.chat(proof=p['credential'])[0]!=200
  assert x.chat()[0]==503 # Journal recovery, not a second payable challenge.
  assert x.count('payment')==1 and x.m.effects()==0
  x.restart_proxy();assert x.chat()[0]==503
  while time.time()*1000<=c['request']['expiresAtMs']+10:time.sleep(.05)
  # Even past the new-operation deadline the original wallet operation recovers.
  again=pay(x,c);assert again['txHash']==p['txHash'] and x.count('payment')==1
  x.m.sql('UPDATE mpp_direct_agents SET active=false')
  request(x.wallet+'/fixture/finalize',{'txHash':p['txHash'],'includedAtMs':int(time.time()*1000),'lateAtMs':int(time.time()*1000)+1},{'x-fixture-key':x.control_key})
  x.tick();x.tick()
  assert x.m.sql('SELECT w::text||\':\'||r::text FROM mpp_direct_orders')=='0:354000000000000000000'
  assert x.m.effects()==0 and len(x.m.seller.calls)==0 and x.count('refund')==1
  assert x.m.sql('SELECT reserved_nano||\':\'||spent_nano FROM mpp_direct_tasks')=='0:0'
  checks.append({'case':'expired-pending-original-recovery-revoked-agent-full-refund','passed':True})
 for delta in ['-1','1']:
  with P1(binary) as x:
   x.set('injectedAmountDelta',delta);id,c=quoted(x);p=pay(x,c);x.chat(proof=p['credential'])
   assert x.m.balance()==0 and x.m.effects()==0
   assert x.m.sql('SELECT amount FROM mpp_direct_anomalies')==str(int(c['request']['amount'])+int(delta))
   assert x.get(id,'cancel')[0]==200 and x.m.sql('SELECT state FROM mpp_direct_orders')=='exception'
   x.tick();x.tick()
   assert x.m.sql('SELECT refunded FROM mpp_direct_anomalies')=='t'
   assert x.count('refund')==1 and x.m.balance()==0
   assert x.get(id,'cancel')[0]==200 and x.m.sql('SELECT state FROM mpp_direct_orders')=='refunded'
   x.tick();assert x.count('refund')==1
   checks.append({'case':'abnormal-native-amount-'+delta,'passed':True})
 with P1(binary,proxy=True) as x:
  id,c=quoted(x);p=pay(x,c)
  x.m.sql("CREATE FUNCTION p1_reject_credit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'controlled rollback'; END $$; CREATE TRIGGER p1_reject_credit BEFORE INSERT ON credit_ledger_entries FOR EACH ROW EXECUTE FUNCTION p1_reject_credit()")
  assert x.chat(proof=p['credential'])[0]!=200
  assert x.m.sql('SELECT count(*) FROM mpp_direct_movements')=='0' and x.m.balance()==0
  assert x.m.sql('SELECT count(*) FROM mpp_direct_presentations')=='1'
  x.m.sql('DROP TRIGGER p1_reject_credit ON credit_ledger_entries; DROP FUNCTION p1_reject_credit()')
  x.m.proxy.armed.set();assert x.get(id,'reconcile')[0]!=200
  assert x.m.proxy.fired.wait(3) and x.m.balance()==708
  assert x.m.sql('SELECT count(*) FROM mpp_direct_movements')=='1'
  original_model(x);assert len(x.m.seller.calls)==1 and x.count('payment')==1
  checks.append({'case':'ledger-rollback-journal-and-lost-payment-commit-ack','passed':True})
 with P1(binary) as x:
  id,c=quoted(x);p=pay(x,c);x.present(id,p['credential'])
  wait_for(lambda:x.m.sql("SELECT count(*) FROM redis_balance_mutations WHERE state<>'applied'")=='0')
  try:x.m.sql(f'UPDATE credit_accounts SET balance_micro_usd=balance_micro_usd-1 WHERE user_id={literal(x.user)}');raise AssertionError('purpose debit accepted')
  except subprocess.CalledProcessError:pass
  internal=json.loads(x.m.sql('SELECT internal_body FROM mpp_direct_orders'))
  internal['bitrouter_purchase']={'service_type':'on_demand','provider_cap_micro_usd':706,'total_cap_micro_usd':708,'wait_budget_ms':1}
  dispatch=x.m.sql('SELECT dispatch_key FROM mpp_direct_orders')
  assert request(x.m.url+'/market/v1/chat/completions',internal,{'authorization':'Bearer '+x.token,'idempotency-key':dispatch})[0]!=200
  assert x.m.sql('SELECT admissions FROM mpp_direct_capacity')=='0' and x.m.effects()==0
  original_model(x);assert len(x.m.seller.calls)==1
  # Seller accepts precisely one execution, even with its private service token.
  copied=dict(x.m.seller.calls[0]);copied['messages']=[{'role':'user','content':'unauthorized scope'}]
  assert request('http://'+str(x.m.seller.server_address[0])+':'+str(x.m.seller.server_address[1])+'/v1/chat/completions',copied,{'authorization':'Bearer '+x.token})[0]==400
  assert request('http://'+str(x.m.seller.server_address[0])+':'+str(x.m.seller.server_address[1])+'/v1/chat/completions',copied,{'authorization':'Bearer '+x.m.env['PRIVATE_MARKET_SELLER_KEY']})[0]==409
  assert len(x.m.seller.calls)==1
  checks.append({'case':'cash-purpose-complete-controls-and-seller-scope-fence','passed':True})
 with P1(binary) as x:
  import signal
  id,c=quoted(x);p=pay(x,c)
  x.m.redis.send_signal(signal.SIGSTOP)
  try:
   assert x.chat(proof=p['credential'])[0]!=200
   assert x.m.effects()==0 and len(x.m.seller.calls)==0
   assert x.m.sql("SELECT count(*) FROM redis_balance_mutations WHERE state='pending'")=='1'
  finally:x.m.redis.send_signal(signal.SIGCONT)
  original_model(x);assert len(x.m.seller.calls)==1
  checks.append({'case':'real-redis-projection-gates-provider-dispatch','passed':True})
 with P1(binary,host_proxy=True) as x:
  id,c=quoted(x);p=pay(x,c);x.present(id,p['credential'])
  wait_for(lambda:x.m.sql("SELECT count(*) FROM redis_balance_mutations WHERE state<>'applied'")=='0')
  x.m.proxy.armed.set();x.chat()
  assert x.m.proxy.fired.wait(3)
  assert x.m.sql('SELECT admissions FROM mpp_direct_capacity')=='1'
  x.m.stop(crash=True);x.m.start();x.restart_proxy()
  original_model(x);assert len(x.m.seller.calls)==1 and x.count('payment')==1
  checks.append({'case':'lost-native-admission-ack-host-and-proxy-restart','passed':True})
 with P1(binary) as x:
  x.m.seller.mode='refusal';r=x.client(stream=False);assert r['status']==200,r
  assert json.loads(r['body'])['choices'][0]['message']['refusal']=='controlled safety refusal'
  checks.append({'case':'native-json-refusal-preserved','passed':True})
 with P1(binary) as x:
  x.set('failPayment',True)
  for key in ['failed-1','failed-2']:
   id,c=quoted(x,key);p=pay(x,c);assert x.present(id,p['credential'])[0]==200
  assert x.m.balance()==0 and x.m.effects()==0 and x.count('refund')==0
  assert x.m.sql('SELECT reserved_nano||\':\'||spent_nano FROM mpp_direct_tasks')=='0:0'
  assert x.m.sql('SELECT spent_yocto FROM mpp_direct_project_budget')=='2000000000000000000'
  assert x.m.sql("SELECT count(*) FROM mpp_direct_orders WHERE state='cancelled'")=='2'
  checks.append({'case':'failed-delegate-fee-project-only-no-double-refund','passed':True})
 with P1(binary,window=3200) as x:
  id,c=quoted(x);x.set('dropPaymentAck',True)
  try:pay(x,c);raise AssertionError('wallet ACK unexpectedly returned')
  except __import__('http.client',fromlist=['RemoteDisconnected']).RemoteDisconnected:pass
  assert x.count('payment')==1 and x.m.sql('SELECT count(*) FROM mpp_direct_presentations')=='0'
  while time.time()*1000<=c['request']['expiresAtMs']+10:time.sleep(.05)
  x.restart_proxy();x.tick();x.tick()
  assert x.m.sql('SELECT w::text||\':\'||r::text FROM mpp_direct_orders')=='0:354000000000000000000'
  assert x.count('payment')==1 and x.count('refund')==1 and x.m.effects()==0
  checks.append({'case':'wallet-ack-lost-unpresented-expired-autonomous-recovery','passed':True})
 with P1(binary) as x:
  decimal=x.body();decimal['temperature']=0.7;decimal['top_p']=0.9
  result=x.chat('decimal',body=decimal);assert result[0]==402,result
  assert x.get(result[1]['orderId'],'cancel')[0]==200
  invalid_options=x.body();invalid_options['stream_options']={'unexpected_property':'discard me'}
  assert x.chat(body=invalid_options)[0]==400
  invalid=x.body();invalid['temperature']='invalid'
  assert x.chat(body=invalid)[0]==400
  assert x.m.sql("SELECT count(*) FROM mpp_direct_orders WHERE state<>'cancelled'")=='0' and x.count('payment')==0
  with ThreadPoolExecutor(max_workers=2) as pool:
   outcomes=list(pool.map(lambda k:x.chat(k)[0],['concurrent-a','concurrent-b']))
  assert sorted(outcomes)==[202,402],outcomes
  assert x.m.sql("SELECT count(*) FROM mpp_direct_orders WHERE state<>'cancelled'")=='1'
  assert x.m.sql('SELECT reserved_nano FROM mpp_direct_tasks')=='708000'
  assert x.count('payment')==0 and x.m.effects()==0
  checks.append({'case':'native-dto-preflight-and-concurrent-reservation','passed':True})
 with P1(binary) as x:
  id,c=quoted(x);p=pay(x,c);x.present(id,p['credential'])
  wait_for(lambda:x.m.sql("SELECT count(*) FROM redis_balance_mutations WHERE state<>'applied'")=='0')
  with ThreadPoolExecutor(max_workers=2) as pool:
   admit=pool.submit(x.chat);cancel=pool.submit(x.get,id,'cancel')
   admission,cancellation=admit.result(),cancel.result()
  if cancellation[0]==200:
   assert x.m.sql('SELECT admissions FROM mpp_direct_capacity')=='0' and x.m.effects()==0
   x.tick();assert x.count('refund')==1
  else:
   assert cancellation[0]==409 and x.m.sql('SELECT admissions FROM mpp_direct_capacity')=='1'
   original_model(x);assert len(x.m.seller.calls)==1
  assert x.count('payment')==1
  checks.append({'case':'cancel-versus-original-admission-one-commit-winner','passed':True})
 with P1(binary) as x:
  x.set('paymentFinality','EXECUTED');id,c=quoted(x);p=pay(x,c)
  assert x.get(id,'cancel')[0]==200
  x.set('paymentFinality','FINAL');id2,c2=quoted(x,'call-2');p2=pay(x,c2)
  request(x.wallet+'/fixture/finalize',{'txHash':p['txHash'],'includedAtMs':int(time.time()*1000),'lateAtMs':int(time.time()*1000)+1},{'x-fixture-key':x.control_key})
  forged=request(x.wallet+'/fixture/reassign',{'txHash':p['txHash'],'challenge':c2},{'x-fixture-key':x.control_key})[1]
  response=x.chat('call-2',proof=forged['credential']);assert response[0]==409,response
  assert response[1]['error']['code']=='original_sponsor_operation_conflict',response
  assert x.m.sql('SELECT count(*) FROM mpp_direct_movements')=='0' and x.m.balance()==0
  # Invalid public proof cannot block recovery of the real original operation.
  assert x.get(id2,'reconcile')[0]==200
  original_model(x,'call-2');x.tick();x.tick()
  assert x.count('payment')==2 and len(x.m.seller.calls)==1 and x.count('refund')==2
  assert x.m.sql("SELECT count(*) FROM mpp_direct_movements WHERE purpose='payment'")=='2'
  checks.append({'case':'cryptographically-valid-reassignment-rejected-original-proof-recovers','passed':True})
 with P1(binary) as x:
  for n in range(17):
   id,c=quoted(x,'cancel-'+str(n));assert x.get(id,'cancel')[0]==200
  id,c=quoted(x,'pending-after-cancellations');p=pay(x,c)
  x.m.sql('UPDATE mpp_direct_agents SET active=false');x.tick();x.tick()
  assert x.count('refund')==1 and x.m.effects()==0
  assert x.m.sql('SELECT reserved_nano FROM mpp_direct_tasks')=='0'
  checks.append({'case':'terminal-cancellations-cannot-starve-autonomous-recovery','passed':True})
 with P1(binary) as x:
  orders=[]
  for n in range(5):
   id,c=quoted(x,'refund-'+str(n));p=pay(x,c);x.present(id,p['credential']);assert x.get(id,'cancel')[0]==200;orders.append(id)
  x.set('blockedRefundOrders',orders[:4]);x.tick();assert x.count('refund')==0
  x.tick();assert x.count('refund')==1 and x.get(orders[-1])[1]['state']=='refunded'
  x.set('blockedRefundOrders',[])
  for _ in range(3):x.tick()
  assert x.count('refund')==5 and x.m.sql('SELECT reserved_nano FROM mpp_direct_tasks')=='0'
  checks.append({'case':'blocked-refund-batch-cannot-starve-later-liability','passed':True})
 with P1(binary) as x:
  id,c=quoted(x)
  with ThreadPoolExecutor(max_workers=1) as pool:
   revoked=pool.submit(x.m.sql,"BEGIN;UPDATE mpp_direct_agents SET active=false;SELECT pg_sleep(1) /*p1_revocation_barrier*/;COMMIT")
   wait_for(lambda:x.m.sql("SELECT count(*) FROM pg_stat_activity WHERE wait_event='PgSleep' AND query LIKE '%p1_revocation_barrier%'")=='1')
   assert request(x.wallet+'/wallet/pay',{'challenge':c},{'x-fixture-key':x.buyer_key})[0]==400
   revoked.result()
  assert x.count('payment')==0 and x.m.effects()==0
  checks.append({'case':'wallet-send-locks-authorization-against-concurrent-revocation','passed':True})
 with P1(binary,refund_auto=True) as x:
  run('pg_ctl','-D',str(x.m.pg),'-m','immediate','-w','stop')
  x.m.pg_started=False
  try:
   time.sleep(.4);assert x.processes[-1].poll() is None
  finally:
   from urllib.parse import urlsplit
   port=urlsplit(x.m.direct).port
   run('pg_ctl','-D',str(x.m.pg),'-l',str(x.m.root/'pg.log'),'-o',f'-h 127.0.0.1 -p {port} -k {x.m.root}','-w','start')
   x.m.pg_started=True
  assert request(x.url+'/healthz')[0]==200
  wait_for(lambda:x.chat()[0]==402)
  checks.append({'case':'autonomous-worker-survives-temporary-pg-outage','passed':True})
 return checks

def main():
 p=argparse.ArgumentParser();p.add_argument('binary');p.add_argument('--evidence',type=Path);a=p.parse_args()
 assert int(subprocess.check_output([str(NODE),'-p','process.versions.node.split(".")[0]']).decode())>=24,'Node >=24 required; set P1_NODE'
 checks=Checks()
 for stream in [True,False]:checks.append(happy(str(Path(a.binary).resolve()),stream))
 checks.extend(fault_tests(str(Path(a.binary).resolve())))
 result={'phase':'P1','mode':'controlled','realChainTransactions':0,'realProviderCalls':0,'checks':checks}
 if a.evidence:a.evidence.write_text(json.dumps(result,indent=2)+'\n')
 print(json.dumps(result,indent=2))
if __name__=='__main__':main()
