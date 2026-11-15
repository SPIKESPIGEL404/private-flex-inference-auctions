#!/usr/bin/env python3
"""Original owning Market schema, real PG, official MPP and owned chain/model fixtures."""
import argparse,hashlib,json,os,pathlib,subprocess
from market_b_support import Market,run
ROOT=pathlib.Path(__file__).resolve().parent.parent
p=argparse.ArgumentParser();p.add_argument('binary');p.add_argument('--serve',action='store_true');p.add_argument('--evidence');args=p.parse_args()
with Market(str(pathlib.Path(args.binary).resolve()),initialize=False) as m:
 m.env.update(PRIVATE_MARKET_NEAR_DIRECT_P1='controlled',PRIVATE_MARKET_AUCTION='controlled')
 run(m.binary,'init',str(m.state),env=m.env)
 try: run(m.binary,'verify-auction-schema',str(m.state),env=m.env)
 except subprocess.CalledProcessError as e:
  print(e.stderr)
  raise
 env={**os.environ,'AUCTION_TEST_DATABASE_URL':m.direct,'NEARINTENTS_AUCTION_TEST':'1'}
 if args.serve:
  subprocess.run(['node','scripts/nearintents-controlled-server.mjs'],cwd=ROOT,env=env,check=True)
 else:
  r=subprocess.run(['node','--test','--test-concurrency=1','services/mpp-nearintents/auction/test/plan.test.mjs','services/mpp-nearintents/auction/test/source.test.mjs','services/mpp-nearintents/auction/test/auction.pg.mjs'],cwd=ROOT,env=env,text=True,capture_output=True)
  print(r.stdout);print(r.stderr)
  if r.returncode:raise SystemExit(r.returncode)
  run(m.binary,'verify-auction-schema',str(m.state),env=m.env)
  if args.evidence:
   out=pathlib.Path(args.evidence);out.parent.mkdir(parents=True,exist_ok=True)
   out.write_text(json.dumps({'scope':'owning Market auction + official MPP + controlled source chain/model','binarySha256':hashlib.sha256(pathlib.Path(m.binary).read_bytes()).hexdigest(),'owningSchemaVerifiedBeforeAndAfter':True,'realBroadcasts':0,'realInference':False,'testOutput':r.stdout},indent=2)+'\n')
