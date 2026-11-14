#!/usr/bin/env python3
"""Actual request-scoped Rust qualification and loopback seller double; no chain/provider spend."""
import json,os,sys,time,threading,subprocess,hashlib,argparse,socket
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from http.server import ThreadingHTTPServer,BaseHTTPRequestHandler
from importlib import import_module
p3=import_module('accept-agent-mpp-p3');p2=p3.p2
P3,run,free_port,wait_for,literal=p3.P3,p3.run,p3.free_port,p3.wait_for,p3.literal
ROOT=p3.ROOT
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*_):pass
 def do_POST(self):
  s=self.server;body=json.loads(self.rfile.read(int(self.headers['content-length'])))
  def reply(code,value):
   raw=json.dumps(value).encode();self.send_response(code);self.send_header('content-length',str(len(raw)));self.end_headers();self.wfile.write(raw)
  if self.path=='/tokenize':
   n=p2.tokens(body['request']);return reply(200,{'tokenizer_ref':'qualification/tokenizer-v1','token_ids':list(range(n))})
  if self.path!='/v1/chat/completions' or self.headers.get('authorization')!='Bearer '+s.credential:return reply(403,{})
  if any(k.startswith('bitrouter_') or k=='background' for k in body):return reply(400,{'error':'private_metadata_leaked'})
  native=json.dumps(body,sort_keys=True,separators=(',',':'),ensure_ascii=False);digest=hashlib.sha256(native.encode()).hexdigest()
  calibrated=s.market.sql("WITH claim AS(INSERT INTO p3_qualification_claims(id,kind) SELECT id,'calibration' FROM mpp_direct_p3_provider_ops WHERE body_hash="+literal(digest)+" AND state='sending' ON CONFLICT DO NOTHING RETURNING id) SELECT count(*) FROM claim")=='1'
  if not calibrated:
   claimed=s.market.sql("WITH eligible AS(SELECT o.id FROM mpp_direct_orders o JOIN mpp_direct_capacity c ON c.lease_order=o.id WHERE c.admissions=1 AND o.admitted_request IS NOT NULL AND ((o.internal_body-'background'-'bitrouter_delivery')||'{\"model\":\"native-a\"}'::jsonb)="+literal(native)+"::jsonb),claim AS(INSERT INTO p2_fixture_seller_claims(order_id,body) SELECT id,"+literal(native)+"::jsonb FROM eligible ON CONFLICT DO NOTHING RETURNING order_id) SELECT count(*) FROM claim")
   if claimed!='1':return reply(409,{'error':'original_execution_missing_or_duplicate'})
  s.calls.append({'calibration':bool(calibrated),'inputTokens':p2.tokens(body),'hasToolResult':any(m['role']=='tool' for m in body['messages'])})
  if calibrated and s.mode=='drop-calibration':self.connection.shutdown(socket.SHUT_RDWR);self.connection.close();return
  self.send_response(200);self.send_header('content-type','text/event-stream');self.end_headers()
  def frame(delta=None,finish=None,usage=None):return ('data: '+json.dumps({'id':'native-qualified','object':'chat.completion.chunk','created':1,'model':'native-a','choices':[] if usage else [{'index':0,'delta':delta or {},'finish_reason':finish}],**({'usage':usage} if usage else {})})+'\n\n').encode()
  output=6
  if not body.get('tools'):
   self.wfile.write(frame({'role':'assistant','content':'verified'}));reason='stop'
  elif any(m['role']=='tool' for m in body['messages']):
   result=next(m['content'] for m in reversed(body['messages']) if m['role']=='tool');value=json.loads(result).get('stdout','').strip()
   self.wfile.write(frame({'role':'assistant','content':'Verified result: '+value}));reason='stop'
  else:
   command="echo applied >> /workspace/applications.log; awk '{s+=$1} END {print s}' /workspace/numbers.txt > /workspace/result.txt; cat /workspace/result.txt"
   args=json.dumps({'command':command},separators=(',',':'));output=(len(args.encode())+3)//4+4
   self.wfile.write(frame({'role':'assistant','tool_calls':[{'index':0,'id':'bash-'+body['user'][-12:],'type':'function','function':{'name':'bash','arguments':args}}]}));reason='tool_calls'
  n=p2.tokens(body);self.wfile.write(frame(finish=reason));self.wfile.write(frame(usage={'prompt_tokens':n,'completion_tokens':output,'total_tokens':n+output}));self.wfile.write(b'data: [DONE]\n\n');self.wfile.flush()
class Native(P3):
 def initialize(self):
  m=self.m;m.env.update(PRIVATE_MARKET_P3_DIAGNOSTICS='controlled',PRIVATE_MARKET_AGENT_P3='bounded',PRIVATE_MARKET_LISTEN='127.0.0.1:'+str(free_port()))
  self.tokenizer=ThreadingHTTPServer(('127.0.0.1',free_port()),Handler);self.tokenizer.daemon_threads=True
  threading.Thread(target=self.tokenizer.serve_forever,daemon=True).start()
  s=ThreadingHTTPServer(('127.0.0.1',free_port()),Handler);s.daemon_threads=True;s.release=threading.Event();s.market=m;s.credential=m.env['PRIVATE_MARKET_SELLER_KEY'];s.calls=[];s.mode='normal'
  m.seller=s
  threading.Thread(target=s.serve_forever,daemon=True).start()
  self.origin='http://127.0.0.1:'+str(s.server_address[1]);self.tokenizerUrl='http://127.0.0.1:'+str(self.tokenizer.server_address[1])+'/tokenize'
  self.registration={'version':1,'market_id':'p3-qualified-native','seller_principal':'project/native','project_authorizes_on_demand_terms':True,'project_pays_upstream_costs':True,
   'origin':self.origin,'model':'native-a','model_revision_ref':'qualification/native-a/v1','tokenizer_ref':'qualification/tokenizer-v1','tokenizer_url':self.tokenizerUrl,
   'tokenizer_files_sha256':{'tokenizer.json':'a'*64,'tokenizer_config.json':'b'*64},'token_ids':[1,2],'max_output_tokens':64,'context_window_tokens':32000,
   'rates':{'input':1000000,'cache_input':1000000,'output':11000000},'request_sha256':'c'*64,'offer_valid_until_ms':int(time.time()*1000)+600000,'upstream_budget_micro_usd':100000,'maximum_upstream_calls':4}
  reg=m.root/'registration.json';reg.write_text(json.dumps(self.registration));reg.chmod(0o600)
  result=json.loads(run(m.binary,'init-live',str(m.state),str(reg),env=m.env));assert result['test_credit_micro_usd']==0,result
  m.data=json.loads((m.state/'state.json').read_text());m.buyers=m.data['buyers'];m.url='http://127.0.0.1:'+str(free_port())
  m.sql('CREATE TABLE p2_fixture_seller_claims(order_id text PRIMARY KEY,body jsonb NOT NULL);CREATE TABLE p3_qualification_claims(id text PRIMARY KEY,kind text NOT NULL)')
 def configure(self):
  c=self.config['payments'];c.update(mode='qualification-test',nativeStateDirectory=str(self.m.state),nativeProfilesDirectory=str(self.m.root/'profiles'),nativeTimeoutMs=60000)
  p=c['plan'];p['provider'].update(origin=self.origin,tokenizerRef=self.registration['tokenizer_ref'],tokenizerUrl=self.tokenizerUrl,tokenizerFilesSha256=self.registration['tokenizer_files_sha256'],credentialEnvironment='P3_NATIVE_TEST_CREDENTIAL')
 def launch(self,script,config,name):
  log=(self.m.root/(name+'.log')).open('w+');self.logs.append(log)
  env={**os.environ,'P3_NATIVE_TEST_CREDENTIAL':self.m.env['PRIVATE_MARKET_SELLER_KEY']}
  p=subprocess.Popen([str(p3.NODE),str(script),str(config)],stdout=log,stderr=log,env=env);self.processes.append(p)
  def ready():
   assert p.poll() is None,Path(log.name).read_text()
   return next((json.loads(l)['url'] for l in Path(log.name).read_text().splitlines() if l.startswith('{')),None)
  return wait_for(ready,85)
 def __exit__(self,*args):
  # SIGTERM invokes a graceful Node shutdown so its native child releases the original writer.
  for p in reversed(self.processes):
   if p.poll() is None:
    p.terminate()
    try:p.wait(timeout=20)
    except subprocess.TimeoutExpired:p.kill();p.wait(timeout=5)
  if hasattr(self,'tokenizer'):self.tokenizer.shutdown();self.tokenizer.server_close()
  if args and args[0]:
   for file in self.m.root.glob('profiles/*/host.log'):print('NATIVE HOST '+str(file)+'\n'+file.read_text(),file=sys.stderr)
  super().__exit__(*args)
def acceptance(binary):
 with Native(binary) as x:
  # Sequential agents still share one physical scope and one owning PG writer.
  for n in [1,2]:
   result=x.fx(n)
   if result['result']['stopReason']!='end_turn':
    print(x.m.sql("SELECT jsonb_build_object('state',state,'financial',financial,'decision',decision) FROM mpp_direct_orders"),file=sys.stderr)
    print(x.m.sql("SELECT receipt FROM market_inference_receipts"),file=sys.stderr)
   assert result['result']['stopReason']=='end_turn',result
  wait_for(lambda:x.counts()['refunds']==4,30)
  assert x.counts()=={'payments':4,'refunds':4,'executions':4,'tools':2,'chainTransfers':8},x.counts()
  for n,expected in [(1,'42\n'),(2,'19\n')]:assert x.status(n)['workspace']['/workspace/result.txt']==expected
  calls=x.m.seller.calls;assert len(calls)==8 and sum(c['calibration'] for c in calls)==4,calls
  assert len({c['inputTokens'] for c in calls})>=2,calls
  assert x.m.sql("SELECT count(*) FROM mpp_direct_p3_profiles WHERE state='qualified'")=='4'
  assert x.m.sql('SELECT count(*) FROM mpp_direct_p3_provider_ops')=='8'
  assert x.m.sql('SELECT count(*) FROM market_inference_hosts')=='1'
  assert x.m.sql('SELECT count(*) FROM mpp_direct_orders WHERE received AND p<>c+h+w+r')=='0'
  x.restart_proxy();assert x.status()['state']=='complete' and len(calls)==8
  return {'case':'request-specific-real-token-count-native-qualification-two-fx-tasks','passed':True,'counts':x.counts(),'providerDoubleCalls':calls,'oneOriginalHost':True}
def unknown_calibration(binary):
 with Native(binary) as x:
  x.m.seller.mode='drop-calibration';h=x.claim()
  with ThreadPoolExecutor(max_workers=1) as pool:
   pending=pool.submit(lambda:x.native(headers=h))
   wait_for(lambda:x.m.sql("SELECT count(*) FROM mpp_direct_p3_provider_ops WHERE state='unknown'")=='1',20)
   assert x.control(1,'pause')[0]==200
   assert pending.result(timeout=20)[0]!=200
  assert x.counts()['payments']==0 and len(x.m.seller.calls)==1
  assert int(x.m.sql('SELECT reserved_micro FROM mpp_direct_p3_provider_budget'))>0
  x.restart_proxy();assert len(x.m.seller.calls)==1
  return {'case':'calibration-ack-loss-keeps-project-reservation-no-agent-payment-or-repost','passed':True}
if __name__=='__main__':
 a=argparse.ArgumentParser();a.add_argument('binary');a.add_argument('--evidence',default=str(ROOT/'docs/acceptance/2026-11-14-outlayer-p3-native.json'));args=a.parse_args()
 checks=[acceptance(args.binary),unknown_calibration(args.binary)];Path(args.evidence).write_text(json.dumps({'realChain':False,'realProvider':False,'scope':'original-native-source-qualification-with-loopback-provider-double','cases':checks},indent=2)+'\n');print(json.dumps({'passed':len(checks),'evidence':args.evidence}))
