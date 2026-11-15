#!/usr/bin/env python3
"""Render the reviewed B deployment without host-side pre-launch code."""
import argparse
import copy
import hashlib
import json
from pathlib import Path
import re
import yaml


def prepare(before,published):
    after=copy.deepcopy(before);compose=yaml.safe_load(before['docker_compose_file'])
    assert set(published['images'])=={'market','agent-preview','domain-ingress','domain-diagnostics'}
    for image in published['images'].values():
        assert re.fullmatch(r'ghcr\.io/spikespigel404/private-flex-inference-auctions@sha256:[a-f0-9]{64}',image)
    assert published['preLaunchScriptRequired'] is False
    assert published['seedSha256']=='cef6fea902ec6fa85160fb5f72e4a3157bbf2b86c52f66f812828ab39239ae4a'
    market=compose['services']['market']
    assert '/data/baseline-b-v2' in market['command'], 'unreviewed predecessor runtime'
    assert compose['services']['agent-preview']['environment']['AGENT_PREVIEW_REVISION']=='0955be168023d0720d563aedfdeff1679df841bd'
    remove={'/run/private-market-chutes/seed.json','/run/private-market-chutes/nginx.conf',
        '/run/private-market-custom-domain/public_tls.py','/run/private-market-custom-domain/attestation.json',
        '/run/private-market-custom-domain/runtime_chutes.py',
        '/run/private-market-baseline-recovery/baseline-recovery-bootstrap.py',
        '/run/private-market-baseline-recovery/baseline-recovery-runtime.py'}
    market['volumes']=[v for v in market['volumes'] if v.split(':')[0] not in remove|{'/run/private-market-domain-observer'}]
    market['volumes'].append('domain-observer:/run/domain-observer:ro');market['command']=[]
    ingress=compose['services']['domain-ingress']
    ingress['volumes']=[v for v in ingress['volumes'] if v.split(':')[0]!='/run/private-market-custom-domain/tlsalpn.sh']
    diagnostics=compose['services']['domain-diagnostics']
    assert diagnostics['volumes']==['/run/private-market-custom-domain/network_probe.py:/probe.py:ro','/run/private-market-domain-observer:/out']
    diagnostics['volumes']=['domain-observer:/out']
    assert 'domain-observer' not in compose['volumes']
    compose['volumes']['domain-observer']={'name':'dstack_market-domain-observer-packaged-20261114'}
    for name,image in published['images'].items():
        service=compose['services'][name];service['image']=image;service['pull_policy']='if_not_present'
    assert not any(v.startswith('/run/') for s in compose['services'].values() for v in s.get('volumes',[]))
    after['docker_compose_file']=yaml.safe_dump(compose,sort_keys=False)
    after['pre_launch_script']=''
    assert all(after[k]==v for k,v in before.items() if k not in ['docker_compose_file','pre_launch_script'])
    report={'preLaunchScriptBytes':0,'allPriorVolumeDefinitionsPreserved':True,'sealedEnvironmentAndVmSettingsPreserved':True,
        'sourceRevision':published['sourceRevision'],'newTemporaryObserverVolume':'dstack_market-domain-observer-packaged-20261114',
        'priorHostObserverPathNotMigrated':True,'expectedComposeHash':hashlib.sha256(json.dumps(after,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()).hexdigest()}
    original=yaml.safe_load(before['docker_compose_file'])
    assert all(compose['volumes'][k]==v for k,v in original['volumes'].items())
    for name in published['images']:
        old=copy.deepcopy(original['services'][name]);new=copy.deepcopy(compose['services'][name])
        for s in [old,new]:
            for key in ['image','pull_policy','volumes']:s.pop(key,None)
            if name=='market':s.pop('command',None)
        assert old==new,'unexpected service change'
    return after,report


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--before',type=Path,required=True);parser.add_argument('--images',type=Path,required=True)
    parser.add_argument('--output',type=Path,required=True);args=parser.parse_args()
    after,report=prepare(json.loads(args.before.read_bytes()),json.loads(args.images.read_bytes()))
    args.output.mkdir(parents=True,exist_ok=True)
    for name,value in [('manifest.json',json.dumps(after,indent=2)+'\n'),('compose.yaml',after['docker_compose_file']),
        ('report.json',json.dumps(report,indent=2)+'\n')]:
        (args.output/name).write_text(value)
    print(json.dumps(report))
