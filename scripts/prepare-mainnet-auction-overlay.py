#!/usr/bin/env python3
"""Render an additive Mainnet service. No CVM or sealed-environment mutation."""
import argparse,copy,hashlib,json,re
from pathlib import Path
import yaml

def prepare(before,image,config):
 if not re.fullmatch(r'ghcr\.io/[a-z0-9_./-]+@sha256:[a-f0-9]{64}',image):raise ValueError('immutable_ghcr_image_required')
 if before.get('pre_launch_script') or before.get('init_script'):raise ValueError('no_prelaunch_manifest_required')
 if before.get('requirements',{}).get('ephemeral_data_disk'):raise ValueError('persistent_disk_required')
 if not re.fullmatch('[a-f0-9]{64}',config.get('reviewedPlanHash','')) or config['plan'].get('mode')!='bounded-mainnet-v1' or config['plan'].get('network')!='mainnet':raise ValueError('reviewed_mainnet_plan_required')
 raw=json.dumps(config)
 if re.search(r'"(?:apiKey|privateKey|secret|merchantKey|nearAiKey|storageKey|marketSecret)"\s*:',raw):raise ValueError('private_value_in_public_manifest')
 if config.get('dataDirectory')!='/data/mainnet-v1' or config.get('port',3000)!=3000:raise ValueError('dedicated_mainnet_paths_required')
 original=yaml.safe_load(before['docker_compose_file']);compose=copy.deepcopy(original)
 if 'mainnet-auction' in compose['services'] or 'mainnet-auction-data' in compose.get('volumes',{}) or 'mainnet-auction-private' in compose.get('networks',{}):raise ValueError('inspect_existing_mainnet_service_before_updating')
 service={'image':image,'pull_policy':'always','restart':'unless-stopped','ports':['3001:3000'],
  'volumes':['mainnet-auction-data:/data'],'networks':['mainnet-auction-private'],'environment':{'ENABLE_BOUNDED_MAINNET':config['reviewedPlanHash'],
   'MAINNET_AUCTION_CONFIG_JSON':raw.replace('$','$$'),'MAINNET_AUCTION_PRIVATE_JSON':'${MAINNET_AUCTION_PRIVATE_JSON:?sealed Mainnet credentials required}'},
  'read_only':True,'tmpfs':['/tmp:rw,nosuid,noexec,size=134217728,mode=1777'],'security_opt':['no-new-privileges:true'],
  'cap_drop':['ALL'],'mem_limit':'1536m','cpus':1.0,'pids_limit':192,'stop_grace_period':'90s',
  'logging':{'driver':'json-file','options':{'max-size':'5m','max-file':'2'}}}
 compose['services']['mainnet-auction']=service;compose.setdefault('volumes',{})['mainnet-auction-data']={};compose.setdefault('networks',{})['mainnet-auction-private']={}
 after=copy.deepcopy(before);after['docker_compose_file']=yaml.safe_dump(compose,sort_keys=False)
 after['allowed_envs']=list(before.get('allowed_envs',[]))+([] if 'MAINNET_AUCTION_PRIVATE_JSON' in before.get('allowed_envs',[]) else ['MAINNET_AUCTION_PRIVATE_JSON'])
 assert all(compose['services'][k]==v for k,v in original['services'].items())
 assert all(compose['volumes'][k]==v for k,v in original.get('volumes',{}).items())
 assert all(compose['networks'][k]==v for k,v in original.get('networks',{}).items())
 assert all(after[k]==v for k,v in before.items() if k not in ['docker_compose_file','allowed_envs'])
 report={'scope':'render-only','newService':'mainnet-auction','newVolume':'mainnet-auction-data','newPort':3001,
  'originalServicesPreserved':list(original['services']),'originalVolumesPreserved':list(original.get('volumes',{})),
  'existingSealedEnvironmentNamesPreserved':list(before.get('allowed_envs',[])),
  'newSealedEnvironmentName':'MAINNET_AUCTION_PRIVATE_JSON','preLaunchScriptRequired':False,
  'reviewedPlanHash':config['reviewedPlanHash'],'image':image,
  'beforeSha256':hashlib.sha256(json.dumps(before,sort_keys=True,separators=(',',':')).encode()).hexdigest()}
 return after,report
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('before');p.add_argument('image');p.add_argument('public_config');p.add_argument('output');p.add_argument('--report',required=True);a=p.parse_args()
 after,report=prepare(json.loads(Path(a.before).read_text()),a.image,json.loads(Path(a.public_config).read_text()))
 Path(a.output).write_text(json.dumps(after,indent=2)+'\n');Path(a.report).write_text(json.dumps(report,indent=2)+'\n')
