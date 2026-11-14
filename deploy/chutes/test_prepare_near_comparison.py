import hashlib
import json
from pathlib import Path
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from gateway import canonical
from prepare_near_comparison import prepare


class PrepareNearTests(unittest.TestCase):
    def fixture(self, root):
        now = time.time_ns()//1000000
        request = {'messages': [{'role': 'user', 'content': '42'}], 'temperature': 0, 'max_completion_tokens': 64}
        tariff = {'model': 'Qwen/Qwen3.8-27B', 'source': 'https://cloud-api.near.ai/v1/model/list',
            'expiresAtMs': now+300000, 'rates': {'input': '40000', 'cache_input': '18000', 'output': '1350000'}}
        tariff['priceVersion'] = hashlib.sha256(canonical(tariff)).hexdigest()
        plan = {'phase': 'fixed-supply-comparison', 'realAgentPayments': False, 'createdAtMs': now,
            'deadlineMs': now+100000, 'arms': {'A': {'tariff': tariff}}, 'request': request,
            'requestHash': hashlib.sha256(canonical(request)).hexdigest(), 'budgetPerArmMicro': '10000'}
        plan['planHash'] = hashlib.sha256(canonical(plan)).hexdigest()
        (root/'plan.json').write_bytes(canonical(plan)); (root/'key').write_text('not-a-real-key'); (root/'key').chmod(0o600)
        (root/'tokenizer.json').write_text('{"tokenizer_ref":"pinned/tokenizer", "tokenizer_files_sha256":{}}')
        return SimpleNamespace(comparison_plan=str(root/'plan.json'), reviewed_plan_hash=plan['planHash'],
            tokenizer_plan=str(root/'tokenizer.json'), api_key_file=str(root/'key'), output=str(root/'prepared'), bridge_port=8092, tokenizer_port=8093)

    @patch('prepare_near_comparison.Tokenizer')
    def test_zero_inference_preparation_keeps_keys_private_and_revision_unverified(self, tokenizer):
        tokenizer.return_value.tokenize.return_value = [42, 43]
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); args=self.fixture(root); result=prepare(args)
            self.assertEqual(result['inferenceCalls'], 0)
            config=json.loads((root/'prepared/bridge.json').read_bytes())
            registration=json.loads((root/'prepared/registration.json').read_bytes())
            self.assertEqual(config['maxUpstreamCalls'], 4)
            self.assertEqual(registration['rates']['output'], 1350000)
            self.assertTrue(registration['model_revision_ref'].endswith('/revision-unverified'))
            self.assertNotIn('not-a-real-key', (root/'prepared/registration.json').read_text())
            self.assertEqual((root/'prepared/bridge.json').stat().st_mode & 0o077, 0)

    @patch('prepare_near_comparison.Tokenizer')
    def test_unreviewed_plan_fails_before_creating_output_or_loading_tokenizer(self, tokenizer):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); args=self.fixture(root); args.reviewed_plan_hash='0'*64
            with self.assertRaises(AssertionError): prepare(args)
            tokenizer.assert_not_called(); self.assertFalse((root/'prepared').exists())
