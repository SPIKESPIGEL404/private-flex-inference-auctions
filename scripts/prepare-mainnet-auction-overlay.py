#!/usr/bin/env python3
"""Render an additive Mainnet service. No CVM or sealed-environment mutation."""
import argparse,copy,hashlib,json,re
from pathlib import Path
import yaml

def prepare(before,image,config,enable_paid_probe=False,enable_user_payments=False):
 if not re.fullmatch(r'ghcr\.io/[a-z0-9_./-]+@sha256:[a-f0-9]{64}',image):raise ValueError('immutable_ghcr_image_required')
 if before.get('pre_launch_script') or before.get('init_script'):raise ValueError('no_prelaunch_manifest_required')
 if before.get('requirements',{}).get('ephemeral_data_disk'):raise ValueError('persistent_disk_required')
 intents=config.get('paymentMethod')=='nearintents'
 valid= config['plan'].get('mode')=='live' if intents else config['plan'].get('mode')=='bounded-mainnet-v1' and config['plan'].get('network')=='mainnet'
 if not re.fullmatch('[a-f0-9]{64}',config.get('reviewedPlanHash','')) or not valid:raise ValueError('reviewed_mainnet_plan_required')
 raw=json.dumps(config)
 if re.search(r'"(?:apiKey|privateKey|secret|merchantKey|nearAiKey|storageKey|marketSecret)"\s*:',raw):raise ValueError('private_value_in_public_manifest')
 data='/data/nearintents-v1' if intents else '/data/mainnet-v1'
 if config.get('dataDirectory')!=data or config.get('port',3000)!=3000:raise ValueError('dedicated_mainnet_paths_required')
 original=yaml.safe_load(before['docker_compose_file']);compose=copy.deepcopy(original)
 name='nearintents-auction' if intents else 'mainnet-auction';volume=name+'-data';network=name+'-private';prefix='NEARINTENTS_AUCTION' if intents else 'MAINNET_AUCTION'
 if name in compose['services'] or volume in compose.get('volumes',{}) or network in compose.get('networks',{}):raise ValueError('inspect_existing_mainnet_service_before_updating')
 for old in compose['services'].values():
  for port in old.get('ports',[]):
   published=port.get('published') if isinstance(port,dict) else (str(port).split(':')[-2] if ':' in str(port) else None)
   if str(published)=='3001':raise ValueError('canary_port_already_in_use')
 service={'image':image,'pull_policy':'always','restart':'unless-stopped','ports':['3001:3000'],
  'volumes':['mainnet-auction-data:/data'],'networks':['mainnet-auction-private'],'environment':{'ENABLE_BOUNDED_MAINNET':config['reviewedPlanHash'],
   'MAINNET_AUCTION_CONFIG_JSON':raw.replace('$','$$'),'MAINNET_AUCTION_PRIVATE_JSON':'${MAINNET_AUCTION_PRIVATE_JSON:?sealed Mainnet credentials required}'},
  'read_only':True,'tmpfs':['/tmp:rw,nosuid,noexec,size=134217728,mode=1777'],'security_opt':['no-new-privileges:true'],
  'cap_drop':['ALL'],'mem_limit':'1536m','cpus':1.0,'pids_limit':192,'stop_grace_period':'90s',
  'logging':{'driver':'json-file','options':{'max-size':'5m','max-file':'2'}}}
 if intents:
  service.update(volumes=[volume+':/data'],networks=[network],mem_limit='1024m',stop_grace_period='300s')
  service['environment']={'AUCTION_PAYMENT_PROFILE':'nearintents','ENABLE_NEARINTENTS_AUCTION':config['reviewedPlanHash'],prefix+'_CONFIG_JSON':raw.replace('$','$$'),prefix+'_PRIVATE_JSON':'${NEARINTENTS_AUCTION_PRIVATE_JSON:?sealed Intents credentials required}'}
  if enable_paid_probe:service['environment']['ENABLE_NEARINTENTS_PAID_PROBE']=config['reviewedPlanHash']
  if enable_user_payments:service['environment']['ENABLE_NEARINTENTS_USER_PAYMENTS']=config['reviewedPlanHash']
 compose['services'][name]=service;compose.setdefault('volumes',{})[volume]={};compose.setdefault('networks',{})[network]={}
 after=copy.deepcopy(before);after['docker_compose_file']=yaml.safe_dump(compose,sort_keys=False)
 after['allowed_envs']=list(before.get('allowed_envs',[]))+([] if prefix+'_PRIVATE_JSON' in before.get('allowed_envs',[]) else [prefix+'_PRIVATE_JSON'])
 assert all(compose['services'][k]==v for k,v in original['services'].items())
 assert all(compose['volumes'][k]==v for k,v in original.get('volumes',{}).items())
 assert all(compose['networks'][k]==v for k,v in original.get('networks',{}).items())
 assert all(after[k]==v for k,v in before.items() if k not in ['docker_compose_file','allowed_envs'])
 report={'scope':'render-only','newService':name,'newVolume':volume,'newPort':3001,
  'originalServicesPreserved':list(original['services']),'originalVolumesPreserved':list(original.get('volumes',{})),
  'existingSealedEnvironmentNamesPreserved':list(before.get('allowed_envs',[])),
  'newSealedEnvironmentName':prefix+'_PRIVATE_JSON','preLaunchScriptRequired':False,'paidProbeEnabled':bool(intents and enable_paid_probe),
  'userPaymentsEnabled':bool(intents and enable_user_payments),
  'reviewedPlanHash':config['reviewedPlanHash'],'image':image,
  'beforeSha256':hashlib.sha256(json.dumps(before,sort_keys=True,separators=(',',':')).encode()).hexdigest()}
 return after,report
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('before');p.add_argument('image');p.add_argument('public_config');p.add_argument('output');p.add_argument('--report',required=True);p.add_argument('--enable-paid-probe',action='store_true');p.add_argument('--enable-user-payments',action='store_true');a=p.parse_args()
 after,report=prepare(json.loads(Path(a.before).read_text()),a.image,json.loads(Path(a.public_config).read_text()),a.enable_paid_probe,a.enable_user_payments)
 Path(a.output).write_text(json.dumps(after,indent=2)+'\n');Path(a.report).write_text(json.dumps(report,indent=2)+'\n')
