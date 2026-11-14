"""Bind the Market identity to the public certificate served by its CVM ingress.

Only public certificate evidence is shared with Market. The ACME private keys
remain in the ingress volume. A changed SPKI restarts the existing Market
runtime so it can publish a fresh identity; its persistent ledger is retained.
"""
import hashlib
import json
from pathlib import Path
import subprocess
import time


def certificate_spki(config_file):
    config = json.loads(Path(config_file).read_text())
    path = Path(config["tls_certificate"])
    domain = config["public_domain"]
    if not path.is_absolute() or domain != "api.demo.bitrouter.ai":
        raise ValueError("unexpected public identity configuration")
    raw = path.read_bytes()
    if len(raw) > 128 * 1024:
        raise ValueError("public certificate is too large")
    def openssl(*args, data=raw):
        return subprocess.run(["openssl", *args], input=data, check=True,
                              capture_output=True, timeout=10).stdout
    # verify checks the chain, hostname and lifetime against the image's system
    # roots. Unlike x509 -checkhost, its exit status rejects a hostname mismatch.
    openssl("verify", "-purpose", "sslserver", "-verify_hostname", domain,
            "-untrusted", str(path), str(path))
    openssl("x509", "-noout", "-checkend", "3600")
    public_key = openssl("x509", "-pubkey", "-noout")
    der = openssl("pkey", "-pubin", "-outform", "DER", data=public_key)
    return hashlib.sha256(der).hexdigest()


def wait_for_certificate(config_file, stop, timeout=1800):
    deadline = time.monotonic() + timeout
    while not stop.is_set():
        try:
            return certificate_spki(config_file)
        except (OSError, ValueError, subprocess.SubprocessError):
            if time.monotonic() >= deadline:
                raise RuntimeError("public ingress certificate readiness timed out") from None
            stop.wait(2)
    raise RuntimeError("shutdown requested while waiting for the public certificate")
