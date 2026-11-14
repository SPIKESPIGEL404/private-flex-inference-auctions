"""TLS key custody and renewal checks using real OpenSSL certificates."""
import json
from pathlib import Path
import tempfile
import unittest

import tls


class TlsLifecycle(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.ram, self.ca = self.root / 'ram', self.root / 'ca'
        self.ram.mkdir()
        self.ca.mkdir()
        self.config = self.root / 'config.json'
        self.config.write_text(json.dumps({'public_domain': 'market.example',
            'tls_certificate': str(self.ram / 'leaf.pem')}))

    def prepare(self):
        return tls.prepare(str(self.config), str(self.ca))

    def test_process_restart_preserves_key_but_new_boot_replaces_leaf_key(self):
        first = self.prepare()
        root = (self.ca / 'ca.pem').read_bytes()
        self.assertEqual(self.prepare(), first)
        (self.ram / 'leaf.pem').unlink()
        (self.ram / 'leaf.key').unlink()
        self.assertNotEqual(self.prepare(), first)
        self.assertEqual((self.ca / 'ca.pem').read_bytes(), root)
        self.assertFalse((self.ca / 'leaf.key').exists())

    def test_certificate_renewal_retains_attested_spki(self):
        first = self.prepare()
        tls.run('openssl', 'req', '-new', '-key', str(self.ram / 'leaf.key'),
            '-out', str(self.root / 'short.csr'), '-subj', '/CN=market.example')
        (self.root / 'ext').write_text('subjectAltName=DNS:market.example\nextendedKeyUsage=serverAuth\n')
        tls.run('openssl', 'x509', '-req', '-in', str(self.root / 'short.csr'),
            '-CA', str(self.ca / 'ca.pem'), '-CAkey', str(self.ca / 'ca.key'),
            '-set_serial', '17', '-out', str(self.ram / 'leaf.pem'), '-days', '1',
            '-extfile', str(self.root / 'ext'))
        short = (self.ram / 'leaf.pem').read_bytes()
        self.assertEqual(self.prepare(), first)
        self.assertNotEqual((self.ram / 'leaf.pem').read_bytes(), short)

    def test_partial_root_or_leaf_is_rejected(self):
        self.prepare()
        (self.ram / 'leaf.key').unlink()
        with self.assertRaises(AssertionError):
            self.prepare()
        (self.ca / 'ca.key').unlink()
        with self.assertRaises(AssertionError):
            self.prepare()

    def test_wrong_leaf_private_key_is_rejected(self):
        self.prepare()
        tls.run('openssl', 'genpkey', '-algorithm', 'EC', '-pkeyopt',
            'ec_paramgen_curve:P-256', '-out', str(self.ram / 'leaf.key'))
        with self.assertRaises(AssertionError):
            self.prepare()

    def test_long_phala_hostname_uses_san(self):
        domain = 'e83279da3fa5b47453cc62317df738b70fedf08c-8443s.dstack-pha1-prod9.phala.network'
        self.config.write_text(json.dumps({'public_domain': domain,
            'tls_certificate': str(self.ram / 'leaf.pem')}))
        self.prepare()  # Includes real chain and hostname verification.


if __name__ == '__main__':
    unittest.main()
