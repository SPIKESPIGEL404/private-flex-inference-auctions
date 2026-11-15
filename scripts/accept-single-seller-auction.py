#!/usr/bin/env python3
"""Owning Market schema + real PostgreSQL. All wallets/sellers are controlled.
No external inference, chain broadcast, deployment or credentials are used.
"""
import argparse, json, os, pathlib, subprocess, sys, hashlib
from market_b_support import Market, run
ROOT=pathlib.Path(__file__).resolve().parent.parent
p=argparse.ArgumentParser();p.add_argument('binary');p.add_argument('--evidence');p.add_argument('--serve',action='store_true');args=p.parse_args()
with Market(str(pathlib.Path(args.binary).resolve()),initialize=False) as market:
 market.env.update(PRIVATE_MARKET_NEAR_DIRECT_P1='controlled',PRIVATE_MARKET_AUCTION='controlled')
 run(market.binary,'init',str(market.state),env=market.env)
 assert market.sql("SELECT count(*) FROM pg_tables WHERE tablename='mpp_direct_auction_allocations'")=='1'
 probe_env=dict(market.env);probe_env.pop('PRIVATE_MARKET_AUCTION')
 probe=subprocess.run([market.binary,'serve',str(market.state)],env=probe_env,text=True,capture_output=True,timeout=20)
 assert probe.returncode!=0 and 'native auction mode differs from owning schema' in probe.stderr,(probe.returncode,probe.stdout,probe.stderr)
 env={**os.environ,'AUCTION_TEST_DATABASE_URL':market.direct}
 result=subprocess.run(['node','--test','services/mpp-near-direct/auction/test/market.pg.mjs'],cwd=ROOT,env=env,text=True,capture_output=True)
 print(result.stdout);print(result.stderr,file=sys.stderr)
 if result.returncode:raise SystemExit(result.returncode)
 evidence={'scope':'controlled-owning-market-postgres','schemaModeMismatchRejected':True,'realChainPayments':False,'realInference':False,
  'base':'e2641db6f764af061059abe16a56794d3a021dac','upstream':json.loads((ROOT/'.market-p2-upstream/.p2-source.json').read_text()),
  'binarySha256':hashlib.sha256(pathlib.Path(market.binary).read_bytes()).hexdigest(),'testOutput':result.stdout}
 if args.evidence:
  path=pathlib.Path(args.evidence);path.parent.mkdir(parents=True,exist_ok=True);path.write_text(json.dumps(evidence,indent=2)+'\n')

 if args.serve:
  print('Serving the main workspace with owned local model/wallet fixtures.',flush=True)
  subprocess.run(['node','scripts/auction-controlled-server.mjs'],cwd=ROOT,env=env,check=True)
