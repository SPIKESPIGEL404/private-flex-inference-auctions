#!/usr/bin/env python3
"""CI publisher for the reviewed current-source image; never accesses a CVM."""
import hashlib,json,os,pathlib,re,subprocess,sys,tempfile
ROOT=pathlib.Path(__file__).resolve().parents[1]
def run(*args,**kw):return subprocess.run(args,check=True,**kw)
tag=os.environ['MAINNET_ARTIFACT_RELEASE']
if not re.fullmatch(r'mainnet-auction-[a-f0-9]{7,40}',tag):raise SystemExit('invalid_mainnet_artifact_release')
repo=os.environ['GITHUB_REPOSITORY'];registry='ghcr.io/'+repo.lower()
with tempfile.TemporaryDirectory() as temporary:
 path=pathlib.Path(temporary)
 run('gh','release','download',tag,'--repo',repo,'--pattern','mainnet-image.json','--dir',str(path))
 metadata=json.loads((path/'mainnet-image.json').read_bytes());source=metadata['sourceRevision'];archive=metadata['archive']
 if not re.fullmatch('[a-f0-9]{40}',source) or tag!='mainnet-auction-'+source[:12] or archive['name']!='mainnet-image.tar.gz':raise SystemExit('artifact_identity_mismatch')
 run('git','merge-base','--is-ancestor',source,'HEAD',cwd=ROOT)
 # A later evidence-only commit is allowed. Runtime/build code must match the
 # labelled source; an old P2 archive cannot silently stand in for Mainnet.
 run('git','diff','--quiet',source,'HEAD','--','services','clients','crates','scripts','deploy/agent-preview','.github/workflows/publish-packaged-phala.yml',cwd=ROOT)
 if not re.fullmatch('[a-f0-9]{64}',archive['sha256']) or not isinstance(archive['bytes'],int) or not 0<archive['bytes']<2*1024**3:raise SystemExit('invalid_archive_bounds')
 run('gh','release','download',tag,'--repo',repo,'--pattern',archive['name'],'--dir',str(path))
 file=path/archive['name'];digest=hashlib.file_digest(file.open('rb'),'sha256').hexdigest()
 if file.stat().st_size!=archive['bytes'] or digest!=archive['sha256']:raise SystemExit('archive_digest_mismatch')
 run('docker','load','-i',str(file))
 local=metadata['localTag']
 if not re.fullmatch(r'private-market:mainnet-auction-[a-f0-9]{7,40}',local):raise SystemExit('invalid_local_image_tag')
 info=json.loads(subprocess.check_output(['docker','image','inspect',local]))[0];cfg=info['Config']
 if cfg.get('Labels',{}).get('org.opencontainers.image.revision')!=source or info['Architecture']!='amd64' or info['Os']!='linux' or cfg['Entrypoint']!=['python3','/app/scripts/bootstrap-mainnet-auction.py']:raise SystemExit('wrong_mainnet_image')
 reuse=metadata.get('reusedRustBinary')
 if reuse:
  old_source=reuse['sourceRevision'];base=reuse['image']
  if not re.fullmatch('[a-f0-9]{40}',old_source) or not re.fullmatch(re.escape(registry)+r'@sha256:[a-f0-9]{64}',base) or not re.fullmatch('[a-f0-9]{64}',reuse['sha256']):raise SystemExit('invalid_reused_binary_identity')
  run('git','merge-base','--is-ancestor',old_source,source,cwd=ROOT)
  run('git','diff','--quiet',old_source,source,'--','crates','scripts/materialize-market-p2.py',cwd=ROOT)
  run('docker','pull','--platform','linux/amd64',base)
  base_cfg=json.loads(subprocess.check_output(['docker','image','inspect',base]))[0]['Config']
  if base_cfg.get('Labels',{}).get('org.opencontainers.image.revision')!=old_source:raise SystemExit('reused_binary_base_source_mismatch')
  for candidate in [base,local]:
   actual=subprocess.check_output(['docker','run','--rm','--platform','linux/amd64','--network','none','--read-only','--entrypoint','sha256sum',candidate,'/usr/local/bin/private-market-host-p2'],text=True).split()[0]
   if actual!=reuse['sha256']:raise SystemExit('reused_binary_bytes_changed')
 run(sys.executable,str(ROOT/'scripts/accept-mainnet-bootstrap.py'),local,'--evidence',str(path/'bootstrap.json'))
 target=registry+':mainnet-auction-'+source[:12]+'-'+os.environ['GITHUB_RUN_ID']
 run('docker','tag',local,target);run('docker','push',target)
 pushed=json.loads(subprocess.check_output(['docker','image','inspect',target]))[0]
 refs=[r for r in pushed['RepoDigests'] if r.startswith(registry+'@sha256:')]
 if len(refs)!=1:raise SystemExit('published_digest_required')
 result={'sourceRevision':source,'workflowRevision':os.environ['GITHUB_SHA'],'image':refs[0],'preLaunchScriptRequired':False,
   'artifactRelease':tag,'archiveSha256':digest,'scope':'bounded-mainnet-candidate','bootstrap':json.loads((path/'bootstrap.json').read_bytes()),
   'realChainPaymentsTested':False,'realInferenceTested':False}
 if reuse:result['reusedRustBinary']=reuse
 (ROOT/'published-images.json').write_text(json.dumps(result,indent=2)+'\n')
 print(json.dumps(result,indent=2))
