import importlib.util
import json
from pathlib import Path
import unittest
import yaml
s=importlib.util.spec_from_file_location('baseline_overlay',Path(__file__).with_name('prepare-baseline-b-overlay.py'))
m=importlib.util.module_from_spec(s);s.loader.exec_module(m)


class BaselineOverlay(unittest.TestCase):
    def setUp(self):
        original={'docker_compose_file':yaml.safe_dump({'services':{'market':{'image':'sha256:'+'a'*64,'ports':['8080:8080'],'volumes':['ledger:/data','/run/runtime_chutes.py:/opt/market/runtime_chutes.py:ro','/run/private-market-chutes/seed.json:/opt/market/chutes-seed.json:ro'],'environment':{'KEEP':'unchanged'}},'domain-ingress':{'image':'original-domain'}},'volumes':{'ledger':{'name':'original-ledger'}},'networks':{'default':{}}}),'pre_launch_script':'# original measured inputs\n','requirements':{'ephemeral_data_disk':False},'init_script':'','allowed_envs':['SEALED_KEY']}
        self.ui={'classicImageId':'sha256:'+'b'*64,'archiveSha256':'c'*64,'archiveUrl':'https://github.com/owner/repo/releases/download/release/ui.tar.gz'}
        self.before,_=m.preview.prepare(original,self.ui['classicImageId'],self.ui['archiveUrl'],self.ui['archiveSha256'],'d'*64,'e'*40,'https://preview.example.com')
        self.market={'classicImageId':'sha256:'+'f'*64,'archiveSha256':'1'*64,'archiveUrl':'https://github.com/owner/repo/releases/download/release/b.tar.gz'}
        self.seed={'files':{'gateway.json':json.dumps({'key_file':'/data/baseline-b-v2/chutes.key'}),'plan.json':json.dumps({'market_id':'baseline_b_v2_test'}),'buyers.public.json':json.dumps({'public_keys':['a','b','c']}),'attestation.json':'{}','nginx.conf':'reviewed nginx'}}

    def test_update_preserves_owner_sealed_environment_and_all_ledgers(self):
        after,report=m.prepare(self.before,self.market,self.ui,json.dumps(self.seed).encode(),'2'*40)
        before=yaml.safe_load(self.before['docker_compose_file']);new=yaml.safe_load(after['docker_compose_file'])
        self.assertEqual(new['volumes'],before['volumes']);self.assertEqual(new['services']['domain-ingress'],before['services']['domain-ingress'])
        self.assertEqual(new['services']['market']['environment'],before['services']['market']['environment'])
        self.assertIn('ledger:/data',new['services']['market']['volumes']);self.assertEqual(after['allowed_envs'],self.before['allowed_envs'])
        self.assertTrue(report['persistentVolumesUnchanged']);self.assertTrue(after['pre_launch_script'].startswith(self.before['pre_launch_script']))
        self.assertEqual(new['services']['agent-preview']['environment']['AGENT_PREVIEW_SUPPLY_URL'],'http://market:8080/market/v1/supply')
        command=new['services']['market']['command']
        seed_target=command[command.index('--seed')+1]
        self.assertEqual(seed_target,'/opt/market/chutes-seed.json')
        self.assertIn('/run/private-market-chutes/seed.json:'+seed_target+':ro',new['services']['market']['volumes'])

    def test_refuses_reusing_original_namespace_or_unknown_seed_files(self):
        self.seed['files']['plan.json']=json.dumps({'market_id':'original'})
        with self.assertRaises(AssertionError):m.prepare(self.before,self.market,self.ui,json.dumps(self.seed).encode(),'2'*40)
        self.seed['files']['plan.json']=json.dumps({'market_id':'baseline_b_v2_test'});self.seed['files']['private-key']='secret'
        with self.assertRaises(AssertionError):m.prepare(self.before,self.market,self.ui,json.dumps(self.seed).encode(),'2'*40)

if __name__=='__main__':unittest.main()
