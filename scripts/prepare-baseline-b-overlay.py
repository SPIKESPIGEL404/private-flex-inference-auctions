#!/usr/bin/env python3
"""Update the fixed B host and Mono UI while retaining CVM history and ownership."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import shlex
import yaml
spec=importlib.util.spec_from_file_location('preview_overlay',Path(__file__).with_name('prepare-agent-preview-overlay.py'))
preview=importlib.util.module_from_spec(spec);spec.loader.exec_module(preview)


def prepare(before, market, ui, seed, revision):
    original=yaml.safe_load(before['docker_compose_file']);owner=original['services']['agent-preview']['environment']
    after,_=preview.prepare(before,ui['classicImageId'],ui['archiveUrl'],ui['archiveSha256'],owner['AGENT_PREVIEW_OWNER_HASH'],revision,owner['AGENT_PREVIEW_ORIGIN'],owner.get('AGENT_PREVIEW_FALLBACK_ORIGIN'))
    for key in ['classicImageId','archiveSha256']:
        assert re.fullmatch('sha256:[a-f0-9]{64}' if key=='classicImageId' else '[a-f0-9]{64}',market[key])
    assert re.fullmatch(r'https://github.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/releases/download/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+',market['archiveUrl'])
    bseed=json.loads(seed);plan=json.loads(bseed['files']['plan.json']);config=json.loads(bseed['files']['gateway.json'])
    assert set(bseed['files'])=={'gateway.json','plan.json','buyers.public.json','attestation.json','nginx.conf'}
    assert set(json.loads(bseed['files']['buyers.public.json']))=={'public_keys'}
    assert config['key_file']=='/data/baseline-b-v2/chutes.key' and plan['market_id'].startswith('baseline_b_v2_')
    assert len(json.loads(bseed['files']['buyers.public.json'])['public_keys'])==3
    compose=yaml.safe_load(after['docker_compose_file']);service=compose['services']['market']
    service['image']=market['classicImageId']
    service['command']=['--seed','/opt/market/chutes-seed.json','--seed-sha256',hashlib.sha256(seed).hexdigest(),'--run-directory','/data/baseline-b-v2','--credential-source-directory','/data/chutes-run']
    # The new image owns the updated runtime. Retain the existing ingress helper,
    # certificate evidence and all persistent volume mounts.
    service['volumes']=[v for v in service['volumes'] if not isinstance(v,str) or v.split(':')[1]!='/opt/market/runtime_chutes.py']
    app=compose['services']['agent-preview'];app['environment']['AGENT_PREVIEW_SUPPLY_URL']='http://market:8080/market/v1/supply'
    if 'default' not in app['networks']:app['networks'].append('default')
    compose.setdefault('networks',{}).setdefault('default',{})
    after['docker_compose_file']=yaml.safe_dump(compose,sort_keys=False)
    encoded=__import__('base64').b64encode(seed).decode();seed_hash=hashlib.sha256(seed).hexdigest()
    after['pre_launch_script']+=f'''\n# Reviewed fixed B baseline: new namespace; original ledgers and sealed env retained.
(
 set -eu
 baseline_image='{market['classicImageId']}'
 baseline_sha='{market['archiveSha256']}'
 baseline_cache=/dstack/persistent/baseline-b-images
 if ! docker image inspect "$baseline_image" >/dev/null 2>&1; then
  mkdir -p "$baseline_cache"
  baseline_archive="$baseline_cache/$baseline_sha.tar.gz"
  if ! test -f "$baseline_archive" || ! printf '%s  %s\\n' "$baseline_sha" "$baseline_archive" | sha256sum -c - >/dev/null 2>&1; then
   curl --fail --location --proto '=https' --proto-redir '=https' --tlsv1.2 --retry 4 --connect-timeout 20 --max-time 600 {shlex.quote(market['archiveUrl'])} -o "$baseline_archive.partial"
   printf '%s  %s\\n' "$baseline_sha" "$baseline_archive.partial" | sha256sum -c -
   mv "$baseline_archive.partial" "$baseline_archive"
  fi
  gzip -dc "$baseline_archive" | docker load
  docker image inspect "$baseline_image" >/dev/null
 fi
 printf '%s' '{encoded}' | base64 -d > /run/private-market-chutes/baseline-seed.new
 printf '%s  %s\\n' '{seed_hash}' /run/private-market-chutes/baseline-seed.new | sha256sum -c -
 chmod 444 /run/private-market-chutes/baseline-seed.new
 mv /run/private-market-chutes/baseline-seed.new /run/private-market-chutes/seed.json
)
'''
    assert after['pre_launch_script'].startswith(before['pre_launch_script'])
    assert all(after[k]==v for k,v in before.items() if k not in ['pre_launch_script','docker_compose_file'])
    assert all(compose['services'][k]==v for k,v in original['services'].items() if k not in ['market','agent-preview'])
    assert compose['volumes']==original['volumes']
    old=copy.deepcopy(original['services']['market']);new=copy.deepcopy(service)
    for v in [old,new]:
        for key in ['image','command','volumes']:v.pop(key,None)
    assert old==new
    assert all(v in service['volumes'] for v in original['services']['market']['volumes'] if ':/' in v and '/opt/market/runtime_chutes.py' not in v)
    assert owner['AGENT_PREVIEW_OWNER_HASH']==app['environment']['AGENT_PREVIEW_OWNER_HASH']
    return after,{'version':1,'persistentVolumesUnchanged':True,'sealedEnvironmentUnchanged':True,'ingressServicesUnchanged':True,'previewOwnerUnchanged':True,
        'previewNetworkChange':'adds existing default network for read-only market supply observation; private credentials and data volumes remain unshared',
        'originalRuntimeRetainedAt':'/data/chutes-run','newRuntime':'/data/baseline-b-v2','marketId':plan['market_id'],
        'expectedComposeHash':hashlib.sha256(json.dumps(after,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()).hexdigest()}
