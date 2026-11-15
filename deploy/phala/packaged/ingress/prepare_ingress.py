"""Adapt pinned ingress 2.3 to this gateway's app-ID routing contract.

This deployment has exactly one CVM. Do not add replicas while ACME TLS-ALPN
validation uses app-level routing: every validation must reach this instance.
"""
import hashlib
from pathlib import Path


source = Path("/scripts/tlsalpn.sh").read_bytes()
assert hashlib.sha256(source).hexdigest() == "17ac47b479b578a5e2f3b07f91c0f21f4e18881e605a674aaf8f65210e187354", "ingress source differs from the pinned release"
old = b'txt_record_value() { echo "${DSTACK_INSTANCE_ID}:${PORT}"; }'
new = b'txt_record_value() { echo "${DSTACK_APP_ID}:${PORT}"; }'
assert source.count(old) == 1, "unexpected ingress routing implementation"
target = Path("/custom/tlsalpn.sh")
target.write_bytes(source.replace(old, new))
target.chmod(0o755)
print("Prepared pinned ingress for the single-CVM app-ID gateway route")
