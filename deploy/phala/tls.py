"""Keep the TLS leaf key in RAM; retain only its signing CA on encrypted disk.

The root keeps client setup stable across boots. Hardware SPKI pinning is still
mandatory: possession of the CA alone cannot impersonate a fresh attested leaf.
"""
import hashlib
import os
from pathlib import Path
import subprocess
import tempfile
import secrets


def run(*args, input=None):
    return subprocess.run(args, input=input, check=True, capture_output=True).stdout


def public_key(key):
    return run('openssl', 'pkey', '-in', str(key), '-pubout', '-outform', 'DER')


def certificate_key(cert):
    return run('openssl', 'pkey', '-pubin', '-outform', 'DER',
        input=run('openssl', 'x509', '-in', str(cert), '-pubkey', '-noout'))


def prepare(config_file='/opt/market/attestation.json', ca_directory='/tls-ca'):
    import json
    config = json.loads(Path(config_file).read_text())
    domain = config['public_domain']
    assert domain and all(c.isalnum() or c in '.-' for c in domain)
    root, ca = Path(config['tls_certificate']).parent, Path(ca_directory)
    for directory in [root, ca]:
        assert directory.is_dir() and directory.stat().st_uid == os.getuid()
        directory.chmod(0o700)
    ca_present = [(ca / name).exists() for name in ['ca.pem', 'ca.key']]
    if not any(ca_present):
        with tempfile.TemporaryDirectory(dir=ca) as temp:
            temp = Path(temp)
            run('openssl', 'genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256', '-out', str(temp / 'ca.key'))
            run('openssl', 'req', '-x509', '-new', '-key', str(temp / 'ca.key'), '-out', str(temp / 'ca.pem'),
                '-days', '3650', '-subj', '/CN=Private Market deployment trust root',
                '-addext', 'basicConstraints=critical,CA:TRUE,pathlen:0',
                '-addext', 'keyUsage=critical,keyCertSign,cRLSign')
            for name in ['ca.pem', 'ca.key']:
                (temp / name).chmod(0o600 if name.endswith('.key') else 0o644)
                os.replace(temp / name, ca / name)
    else:
        assert all(ca_present), 'partial CA bootstrap: preserve and investigate'
    assert (ca / 'ca.key').stat().st_mode & 0o077 == 0
    assert certificate_key(ca / 'ca.pem') == public_key(ca / 'ca.key'), 'CA key mismatch'
    run('openssl', 'x509', '-in', str(ca / 'ca.pem'), '-noout', '-checkend', str(90 * 86400))
    leaf_present = [(root / name).exists() for name in ['leaf.pem', 'leaf.key']]
    assert all(leaf_present) or not any(leaf_present), 'partial TLS bootstrap: preserve and investigate'
    renew = not all(leaf_present)
    if not renew:
        renew = subprocess.run(['openssl', 'x509', '-in', str(root / 'leaf.pem'), '-noout', '-checkend', str(7 * 86400)], capture_output=True).returncode != 0
    if renew:
        with tempfile.TemporaryDirectory(dir=root) as temp:
            temp = Path(temp)
            key = root / 'leaf.key' if all(leaf_present) else temp / 'leaf.key'
            if not all(leaf_present):
                run('openssl', 'genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256', '-out', str(key))
            # Phala hostnames exceed the X.509 common-name length limit. The
            # full DNS identity belongs in SAN; CN is only a display label.
            run('openssl', 'req', '-new', '-key', str(key), '-out', str(temp / 'leaf.csr'), '-subj', '/CN=Private Market leaf')
            (temp / 'leaf.ext').write_text('basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:' + domain + '\n')
            run('openssl', 'x509', '-req', '-in', str(temp / 'leaf.csr'), '-CA', str(ca / 'ca.pem'),
                '-CAkey', str(ca / 'ca.key'), '-set_serial', str(secrets.randbits(159) + 1), '-out', str(temp / 'leaf.pem'),
                '-days', '90', '-extfile', str(temp / 'leaf.ext'))
            # A renewal retains this boot's RAM-only key/SPKI so the running
            # ACI identity remains bound to nginx across certificate reloads.
            for name in (['leaf.pem'] if all(leaf_present) else ['leaf.pem', 'leaf.key']):
                (temp / name).chmod(0o600 if name.endswith('.key') else 0o644)
                os.replace(temp / name, root / name)
    key = root / 'leaf.key'
    assert key.stat().st_uid == os.getuid() and key.stat().st_mode & 0o077 == 0
    run('openssl', 'verify', '-CAfile', str(ca / 'ca.pem'), '-verify_hostname', domain, str(root / 'leaf.pem'))
    run('openssl', 'x509', '-in', str(root / 'leaf.pem'), '-noout', '-checkend', '86400')
    cert_der, key_der = certificate_key(root / 'leaf.pem'), public_key(key)
    assert cert_der == key_der, 'TLS leaf/key mismatch'
    return hashlib.sha256(cert_der).hexdigest()
