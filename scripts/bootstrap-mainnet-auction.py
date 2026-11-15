#!/usr/bin/env python3
"""Initialize/verify a dedicated volume in-image; no Phala pre-launch script."""
import json, os, pathlib, signal, socket, subprocess, sys
os.umask(0o077)
if len(sys.argv)>1:
 config_path=pathlib.Path(sys.argv[1]);config=json.loads(config_path.read_text())
else:
 config=json.loads(os.environ.pop('MAINNET_AUCTION_CONFIG_JSON'))
 config_path=pathlib.Path(config['dataDirectory'])/'runtime.json'
 config_path.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
 if config_path.exists() and json.loads(config_path.read_text())['reviewedPlanHash']!=config['reviewedPlanHash']:raise SystemExit('existing_mainnet_plan_changed')
 fd=os.open(config_path,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
 with os.fdopen(fd,'w') as out:json.dump(config,out);out.flush();os.fsync(out.fileno())
 private=json.loads(os.environ.pop('MAINNET_AUCTION_PRIVATE_JSON'))
 for field,name in [('merchantKeyFile','merchantKey'),('nearAiKeyFile','nearAiKey'),('storageKeyFile','storageKey'),('marketSecretFile','marketSecret')]:
  path=pathlib.Path(config[field])
  if path.parent!=config_path.parent:raise SystemExit('dedicated_mainnet_secret_paths_required')
  value=private[name].strip()+'\n'
  if path.exists():
   if path.read_text()!=value:raise SystemExit('existing_mainnet_secret_changed')
  else:
   fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
   with os.fdopen(fd,'w') as out:out.write(value);out.flush();os.fsync(out.fileno())
 if 'fxObservation' in config:
  path=pathlib.Path(config['fxFile'])
  if path.parent!=config_path.parent:raise SystemExit('dedicated_fx_path_required')
  fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
  with os.fdopen(fd,'w') as out:json.dump(config['fxObservation'],out);out.flush();os.fsync(out.fileno())
plan=config['plan'];data=pathlib.Path(config['dataDirectory']).resolve()
if plan.get('mode')!='bounded-mainnet-v1' or plan.get('network')!='mainnet' or os.environ.get('ENABLE_BOUNDED_MAINNET')!=config['reviewedPlanHash']:
 raise SystemExit('explicit_mainnet_plan_gate_required')
data.mkdir(parents=True,exist_ok=True,mode=0o700)
if data.stat().st_mode&0o077:raise SystemExit('private_mainnet_volume_required')
state=pathlib.Path(config['owningStateDirectory']).resolve();pgdir=data/'pg';database='private_market_auction_mainnet_v1'
if state!=data/'owning-market' or pathlib.Path(config['databaseUrlFile']).resolve()!=data/'database-url':raise SystemExit('dedicated_mainnet_paths_required')
for port in [25432,26379,config.get('port',3000),config.get('backendPort',4180)]:
 with socket.socket() as probe:probe.bind(('127.0.0.1',port))
def run(*args,env=None):
 result=subprocess.run(args,env=env,capture_output=True,text=True)
 if result.returncode:raise RuntimeError('mainnet bootstrap failed: '+pathlib.Path(args[0]).name)
 return result.stdout.strip()
url='postgres://preview@127.0.0.1:25432/'+database
env={**os.environ,'DATABASE_URL':url,'REDIS_URL':'redis://127.0.0.1:26379','PRIVATE_MARKET_FIXTURE_BIND':'127.0.0.1:28081',
 'PRIVATE_MARKET_FIXTURE_PUBLIC_URL':'http://127.0.0.1:28081','PRIVATE_MARKET_NEAR_DIRECT_P1':'controlled','PRIVATE_MARKET_AUCTION':plan['mode'],
 'DATABASE_MIN_CONNECTIONS':'1','DATABASE_MAX_CONNECTIONS':'12'}
pg_started=False;children=[]
def stop(*_):
 for child in children:
  if child.poll() is None:child.terminate()
for name in ['SIGTERM','SIGINT']:signal.signal(getattr(signal,name),stop)
try:
 if not (pgdir/'PG_VERSION').exists():
  if state.exists() or (data/'merchant-effects.sqlite').exists() or (data/'wallet-credentials').exists():raise RuntimeError('financial_state_present_without_database')
  run('initdb','-D',str(pgdir),'--username=preview','--auth=trust','--no-locale','--encoding=UTF8')
 run('pg_ctl','-D',str(pgdir),'-l',str(data/'postgres.log'),'-o','-h 127.0.0.1 -p 25432 -k /tmp -c shared_buffers=32MB -c max_connections=64','-w','start');pg_started=True
 found=run('psql','-h','127.0.0.1','-p','25432','-U','preview','-d','postgres','-At','-c',"SELECT 1 FROM pg_database WHERE datname='"+database+"'")
 if not found:run('createdb','-h','127.0.0.1','-p','25432','-U','preview',database)
 (data/'redis').mkdir(exist_ok=True,mode=0o700)
 redis=subprocess.Popen(['redis-server','--bind','127.0.0.1','--port','26379','--dir',str(data/'redis'),'--appendonly','yes','--logfile',str(data/'redis.log')]);children.append(redis)
 if not state.exists():run(config.get('hostBinary','/usr/local/bin/private-market-host-p2'),'init',str(state),env=env)
 if pathlib.Path(config['databaseUrlFile']).exists():
  if pathlib.Path(config['databaseUrlFile']).read_text().strip()!=url:raise RuntimeError('owning_database_url_changed')
 else:
  fd=os.open(config['databaseUrlFile'],os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
  with os.fdopen(fd,'w') as out:out.write(url+'\n');out.flush();os.fsync(out.fileno())
 run(config.get('hostBinary','/usr/local/bin/private-market-host-p2'),'verify-auction-schema',str(state),env=env)
 child=subprocess.Popen([os.environ.get('P1_NODE','node'),'/app/scripts/serve-mainnet-auction.mjs',str(config_path)],env=env);children.append(child)
 raise SystemExit(child.wait())
finally:
 stop()
 for child in children:
  try:child.wait(timeout=15)
  except subprocess.TimeoutExpired:child.kill();child.wait()
 if pg_started:run('pg_ctl','-D',str(pgdir),'-m','fast','-w','stop')
