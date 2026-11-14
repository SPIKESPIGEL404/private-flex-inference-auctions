#!/usr/bin/env python3
"""Publish reviewed images through CI; never accesses a CVM or payment key."""
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import urllib.request

ROOT=Path(__file__).resolve().parents[1]
CONTEXT=ROOT/'deploy/phala/packaged'
SOURCE='https://github.com/SPIKESPIGEL404/private-flex-inference-auctions'
REGISTRY='ghcr.io/'+os.environ['GITHUB_REPOSITORY'].lower()
SUFFIX=os.environ['GITHUB_SHA'][:12]+'-'+os.environ['GITHUB_RUN_ID']


def run(*args):
    subprocess.run(args,check=True)


def download(url,path,expected,size=None):
    assert url.startswith(('https://github.com/SPIKESPIGEL404/private-flex-inference-auctions/releases/download/',
        'https://huggingface.co/Qwen/Qwen3.8-27B-FP8/resolve/017b9c7af6b5689d5dd426a76e0bc077eb5ca20a/'))
    for attempt in range(3):
        try:
            with urllib.request.urlopen(url,timeout=120) as response:
                raw=response.read((size or 32*1024*1024)+1)
            assert (size is None or len(raw)==size) and hashlib.sha256(raw).hexdigest()==expected,'artifact digest/size mismatch'
            path.write_bytes(raw);return
        except Exception:
            if attempt==2:raise
            time.sleep(2)


def restore(meta,tag,cache):
    parts=meta['archiveParts']
    def fetch(part):download(part['url'],cache/part['name'],part['sha256'],part['bytes'])
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:list(pool.map(fetch,parts))
    archive=cache/(tag+'.tar.gz');digest=hashlib.sha256()
    with archive.open('wb') as out:
        for part in parts:
            data=(cache/part['name']).read_bytes();digest.update(data);out.write(data)
    assert digest.hexdigest()==meta['archiveSha256'] and archive.stat().st_size==meta['archiveBytes']
    run('docker','load','-i',str(archive))
    run('docker','image','inspect',meta['classicImageId'])
    run('docker','tag',meta['classicImageId'],'private-market:'+tag)


def publish(component,context,args=()):
    tag=REGISTRY+':'+component+'-'+SUFFIX
    run('docker','build','--platform','linux/amd64','--pull=false',
        '--label','org.opencontainers.image.source='+SOURCE,
        '--label','org.opencontainers.image.revision='+os.environ['GITHUB_SHA'],
        '-t',tag,*args,str(context))
    if component=='market':run('docker','run','--rm','--network','none','--read-only',tag,'--check-package')
    run('docker','push',tag)
    info=json.loads(subprocess.check_output(['docker','image','inspect',tag]))[0]
    refs=[x for x in info['RepoDigests'] if x.startswith(REGISTRY+'@sha256:')]
    assert len(refs)==1
    return refs[0]


def main():
    distribution=json.loads((CONTEXT/'base-distribution.json').read_bytes())
    with tempfile.TemporaryDirectory() as temporary:
        cache=Path(temporary)
        restore(distribution['market'],'baseline-b-a08e3ec',cache)
        restore(distribution['ui'],'mono-b-unified-0955be1',cache)
        base=cache/'base';base.mkdir()
        (base/'Dockerfile').write_text('FROM private-market:baseline-b-a08e3ec\n')
        runtime=publish('runtime-base',base)
        (base/'Dockerfile').write_text('FROM private-market:mono-b-unified-0955be1\n')
        ui=publish('ui',base)
        market=CONTEXT/'market'
        for local,original in [('runtime_chutes.py',ROOT/'deploy/phala/runtime_chutes.py'),
            ('bootstrap_chutes.py',ROOT/'deploy/phala/bootstrap_chutes.py'),
            ('recovery_guard.py',ROOT/'scripts/check-baseline-bootstrap-recovery.py')]:
            assert (market/local).read_bytes()==original.read_bytes(),'packaged source drift'
        seed=json.loads((market/'chutes-seed.json').read_bytes());plan=json.loads(seed['files']['plan.json'])
        for name,expected in plan['tokenizer_files_sha256'].items():
            download(seed['tokenizer_urls'][name],market/name,expected)
        assets={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in market.iterdir() if p.is_file() and p.name!='assets.json'}
        (market/'assets.json').write_text(json.dumps(assets,sort_keys=True)+'\n')
        market_ref=publish('market',market,('--build-arg','RUNTIME_BASE='+runtime))
        ingress=publish('ingress',CONTEXT/'ingress')
        diagnostics=publish('diagnostics',CONTEXT/'diagnostics',('--build-arg','INGRESS_BASE='+ingress))
        result={'sourceRevision':os.environ['GITHUB_SHA'],'workflowRunId':os.environ['GITHUB_RUN_ID'],
            'preLaunchScriptRequired':False,'runtimeBase':runtime,'images':{'market':market_ref,'agent-preview':ui,
                'domain-ingress':ingress,'domain-diagnostics':diagnostics},'seedSha256':hashlib.sha256((market/'chutes-seed.json').read_bytes()).hexdigest(),
            'scope':'controlled P2 frontend; fixed B credit settlement; native-funded B disabled'}
        Path('published-images.json').write_text(json.dumps(result,indent=2)+'\n')
        print(json.dumps(result,indent=2))


if __name__=='__main__':main()
