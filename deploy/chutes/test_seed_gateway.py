"""Seed publication excludes credentials and buyer signing secrets."""
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from gateway import CHUTE_ID, NATIVE_MODEL, PUBLIC_MODEL, ORIGIN, canonical
from seed_gateway import prepare


class SeedTests(unittest.TestCase):
    def test_only_public_inputs_and_token_digest_are_published(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            profile = {'mrtd': '00' * 48, 'runtime_rtmrs': {f'RTMR{i}': '00' * 48 for i in range(4)}}
            config = dict(version=1, public_model=PUBLIC_MODEL, native_model=NATIVE_MODEL, chute_id=CHUTE_ID,
                origin=ORIGIN, approved_measurement_policy=True, measurement_profiles=[profile],
                chute_code_sha256='ab' * 32, chute_version='1dd34c0e-e472-5a33-8c7a-cadbbd349267',
                chute_image='6e46a33c-329a-5b55-a1dd-c9a5c9866943', model_revision='017b9c7af6b5689d5dd426a76e0bc077eb5ca20a')
            plan = {'tokenizer_files': {'tokenizer.json': '/private/local.json'}, 'market_id': 'private_market_test'}
            buyers = {'public_keys': ['ed25519:' + '1' * 31 + ending for ending in ['1', '2', '3']]}
            tokens = canonical(['brk_private-token-' + str(i) for i in range(3)])
            for name, value in [('gateway.json', config), ('plan.json', plan), ('public.json', buyers)]:
                (root / name).write_bytes(canonical(value))
            key_file = root / 'tokens.json'; key_file.write_bytes(tokens); key_file.chmod(0o600)
            (root / 'attestation.json').write_text('{}')
            (root / 'nginx.conf').write_text('events {}\n')
            output = root / 'seed.json'
            def build(destination):
                return prepare(root, root / 'public.json', key_file, destination, root / 'attestation.json', root / 'nginx.conf')
            digest = build(output)
            raw = output.read_bytes(); seed = json.loads(raw)
            self.assertEqual(digest, hashlib.sha256(raw).hexdigest())
            self.assertEqual(seed['buyer_tokens_sha256'], hashlib.sha256(tokens).hexdigest())
            self.assertNotIn(b'brk_private-token', raw)
            self.assertEqual(json.loads(seed['files']['gateway.json'])['key_file'], '/data/chutes-run/chutes.key')
            key_file.chmod(0o644)
            with self.assertRaises(AssertionError): build(root / 'denied.json')
            key_file.chmod(0o600)
            buyers['secretKey'] = 'must-not-be-published'
            (root / 'public.json').write_bytes(canonical(buyers))
            with self.assertRaises(AssertionError): build(root / 'denied.json')
            (root / 'public.json').write_bytes(canonical({'public_keys': buyers['public_keys']}))
            config['api_key'] = 'must-not-be-published'
            (root / 'gateway.json').write_bytes(canonical(config))
            with self.assertRaises(AssertionError): build(root / 'denied.json')


if __name__ == '__main__': unittest.main()
