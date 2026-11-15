#!/usr/bin/env python3
"""Build the current Intents source on CI over an immutable reviewed Rust base."""
import json,os,pathlib,subprocess,sys
ROOT=pathlib.Path(__file__).resolve().parents[1]
def run(*args,**kw):return subprocess.run(args,cwd=ROOT,check=True,**kw)
source=subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip()
registry='ghcr.io/'+os.environ['GITHUB_REPOSITORY'].lower()
base=registry+'@sha256:5021845ffdd208cfbd674662c057bc0180e420e4b6ff336ef136e29c138c968e'
base_source='85d342cc2b86c944011dc69c0d0c22427f6e92f1'
binary='d8b93779b81ad7ed02f14897a30906e19325fec4d2b334c067c1a509feb360ad'
run('git','merge-base','--is-ancestor',base_source,source)
run('git','diff','--quiet',base_source,source,'--','crates','scripts/materialize-market-p2.py')
run('docker','pull','--platform','linux/amd64',base)
base_cfg=json.loads(subprocess.check_output(['docker','image','inspect',base]))[0]['Config']
if base_cfg.get('Labels',{}).get('org.opencontainers.image.revision')!=base_source:raise SystemExit('base_source_mismatch')
local='private-market:mainnet-auction-'+source[:12]
run('docker','build','--platform','linux/amd64','-f','deploy/agent-preview/Dockerfile.mainnet-runtime','--build-arg','RUNTIME_IMAGE='+base,'--build-arg','SOURCE_REVISION='+source,'-t',local,'.')
info=json.loads(subprocess.check_output(['docker','image','inspect',local]))[0]
if info['Architecture']!='amd64' or info['Config']['Labels']['org.opencontainers.image.revision']!=source:raise SystemExit('current_image_identity_mismatch')
for image in [base,local]:
 actual=subprocess.check_output(['docker','run','--rm','--platform','linux/amd64','--network','none','--read-only','--entrypoint','sha256sum',image,'/usr/local/bin/private-market-host-p2'],text=True).split()[0]
 if actual!=binary:raise SystemExit('reused_binary_changed')
for script,name in [('accept-mainnet-bootstrap.py','native-bootstrap.json'),('accept-nearintents-bootstrap.py','intents-bootstrap.json')]:
 run(sys.executable,'scripts/'+script,local,'--evidence',name)
target=registry+':mainnet-current-'+source[:12]+'-'+os.environ['GITHUB_RUN_ID']
run('docker','tag',local,target);run('docker','push',target)
pushed=json.loads(subprocess.check_output(['docker','image','inspect',target]))[0]
refs=[r for r in pushed['RepoDigests'] if r.startswith(registry+'@sha256:')]
if len(refs)!=1:raise SystemExit('published_digest_required')
result={'sourceRevision':source,'workflowRevision':os.environ['GITHUB_SHA'],'image':refs[0],'paymentMethod':'nearintents','build':'current-source-runtime-overlay-on-CI','preLaunchScriptRequired':False,'realChainPaymentsTested':False,'realInferenceTested':False,'reusedRustBinary':{'sourceRevision':base_source,'image':base,'sha256':binary},'bootstrap':json.loads(pathlib.Path('native-bootstrap.json').read_text()),'nearintentsBootstrap':json.loads(pathlib.Path('intents-bootstrap.json').read_text())}
pathlib.Path('published-images.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2))
