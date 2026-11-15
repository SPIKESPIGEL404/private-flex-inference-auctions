#!/usr/bin/env python3
"""Packaging/startup gates only; no CVM, provider or chain calls."""
import copy,importlib.util,json,pathlib,subprocess,tempfile,unittest
ROOT=pathlib.Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('overlay',ROOT/'scripts/prepare-mainnet-auction-overlay.py');overlay=importlib.util.module_from_spec(spec);spec.loader.exec_module(overlay)
import yaml
class PackageTests(unittest.TestCase):
 def before(self):return {'allowed_envs':['EXISTING_SECRET'],'docker_compose_file':yaml.safe_dump({'services':{'old':{'image':'old@sha256:abc','environment':{'OLD':'${EXISTING_SECRET}'}}},'volumes':{'old-data':{}}}),'requirements':{'ephemeral_data_disk':False},'init_script':[],'public_logs':False}
 def config(self):return {'reviewedPlanHash':'a'*64,'dataDirectory':'/data/mainnet-v1','plan':{'mode':'bounded-mainnet-v1','network':'mainnet'}}
 def test_additive_preservation(self):
  before=self.before();after,report=overlay.prepare(before,'ghcr.io/owner/repo@sha256:'+'b'*64,self.config());self.assertEqual(before,self.before())
  parsed=yaml.safe_load(after['docker_compose_file']);self.assertEqual(parsed['services']['old'],yaml.safe_load(before['docker_compose_file'])['services']['old']);self.assertEqual(parsed['volumes']['old-data'],{})
  self.assertEqual(parsed['services']['mainnet-auction']['ports'],['3001:3000']);self.assertEqual(after['allowed_envs'],['EXISTING_SECRET','MAINNET_AUCTION_PRIVATE_JSON']);self.assertFalse(report['preLaunchScriptRequired'])
 def test_rejects_mutable_image_script_ephemeral_or_public_secret(self):
  for before,image,config in [(self.before(),'repo:latest',self.config()),({**self.before(),'pre_launch_script':'echo run'},'ghcr.io/o/r@sha256:'+'b'*64,self.config()),({**self.before(),'requirements':{'ephemeral_data_disk':True}},'ghcr.io/o/r@sha256:'+'b'*64,self.config()),(self.before(),'ghcr.io/o/r@sha256:'+'b'*64,{**self.config(),'nearAiKey':'private'})]:
   with self.assertRaises(ValueError):overlay.prepare(before,image,config)
 def test_wrong_mainnet_gate_cannot_initialize_any_state(self):
  with tempfile.TemporaryDirectory() as temp:
   path=pathlib.Path(temp)/'config.json';path.write_text(json.dumps({'reviewedPlanHash':'a'*64,'dataDirectory':temp+'/state','plan':{'mode':'bounded-mainnet-v1','network':'mainnet'}}))
   result=subprocess.run(['python3',str(ROOT/'scripts/bootstrap-mainnet-auction.py'),str(path)],capture_output=True,text=True)
   self.assertNotEqual(result.returncode,0);self.assertIn('explicit_mainnet_plan_gate_required',result.stderr);self.assertFalse((path.parent/'state').exists())
 def test_nearintents_has_a_separate_explicit_gate_before_state_creation(self):
  import os
  with tempfile.TemporaryDirectory() as temp:
   path=pathlib.Path(temp)/'config.json';path.write_text(json.dumps({'paymentMethod':'nearintents','reviewedPlanHash':'a'*64,'dataDirectory':temp+'/state','plan':{'mode':'live'}}))
   env={**os.environ,'ENABLE_BOUNDED_MAINNET':'a'*64};env.pop('ENABLE_NEARINTENTS_AUCTION',None)
   result=subprocess.run(['python3',str(ROOT/'scripts/bootstrap-mainnet-auction.py'),str(path)],capture_output=True,text=True,env=env)
   self.assertNotEqual(result.returncode,0);self.assertIn('explicit_mainnet_plan_gate_required',result.stderr);self.assertFalse((path.parent/'state').exists())
if __name__=='__main__':unittest.main()
