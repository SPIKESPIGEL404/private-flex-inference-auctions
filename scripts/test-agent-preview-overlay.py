#!/usr/bin/env python3
import copy
import importlib.util
from pathlib import Path
import unittest
import yaml
spec=importlib.util.spec_from_file_location('overlay',Path(__file__).with_name('prepare-agent-preview-overlay.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class Overlay(unittest.TestCase):
 def setUp(self):
  self.before={'docker_compose_file':yaml.safe_dump({'services':{'market':{'image':'sha256:'+'a'*64,'volumes':['gateway:/state'],'environment':{'KEEP':'unchanged'}}},'volumes':{'gateway':{'name':'original-ledger'}},'networks':{'default':{}}}), 'pre_launch_script':'# measured original\n', 'requirements':{'ephemeral_data_disk':False},'init_script':'','allowed_envs':['SEALED_KEY']}
 def prepare(self,before,image='b'):
  return m.prepare(before,'sha256:'+image*64,'https://github.com/owner/repo/releases/download/release/image.tar.gz','c'*64,'d'*64,'e'*40,'https://preview.example.com')
 def test_install_and_update_preserve_original_manifest_and_preview_configuration(self):
  installed,first=self.prepare(self.before);updated,second=self.prepare(installed,'f')
  original=yaml.safe_load(self.before['docker_compose_file']);new=yaml.safe_load(updated['docker_compose_file'])
  self.assertEqual(original['services']['market'],new['services']['market']);self.assertEqual(original['volumes']['gateway'],new['volumes']['gateway'])
  self.assertEqual(updated['allowed_envs'],self.before['allowed_envs']);self.assertTrue(updated['pre_launch_script'].startswith(installed['pre_launch_script']))
  self.assertEqual(second['operation'],'update');self.assertTrue(second['existingPreviewUnchangedExceptImageRevision'])
 def test_update_refuses_owner_or_origin_drift(self):
  installed,_=self.prepare(self.before);c=yaml.safe_load(installed['docker_compose_file']);c['services']['agent-preview']['environment']['AGENT_PREVIEW_ORIGIN']='https://other.example.com';installed['docker_compose_file']=yaml.safe_dump(c)
  with self.assertRaisesRegex(ValueError,'origin or ownership'):self.prepare(installed)
if __name__=='__main__':unittest.main()
