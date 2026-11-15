#!/usr/bin/env python3
"""Exercise local materialized-tree tamper repair without editing shared Cargo sources."""
import hashlib,json,pathlib,subprocess,sys
root=pathlib.Path(__file__).resolve().parent.parent
target=root/'.market-p2-upstream'
manifest=target/'.p2-source.json'
before=json.loads(manifest.read_text())
file=target/'src/market/pg/paid_tasks.sql'
original=file.read_bytes()
try:
 file.write_bytes(original+b'\n-- local acceptance tamper\n')
 subprocess.run([sys.executable,str(root/'scripts/materialize-market-p2.py')],check=True,capture_output=True)
 assert file.read_bytes()==original,'materialized source was not repaired'
 assert json.loads(manifest.read_text())==before,'repair changed pinned inputs'
 inputs=sorted([p for d in ['p1','p2','auction'] for p in (root/'crates/private-market-host/upstream'/d).iterdir() if p.is_file()]+[root/'scripts/materialize-market-p2.py'])
 digest=hashlib.sha256(json.dumps({str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest() for p in inputs},sort_keys=True).encode()).hexdigest()
 assert before['patch_sha256']==digest,'materializer transformation is not fingerprinted'
 assert before['base']=='244177cafa26e8c8b001e61297cf4e7f89ac8de9'
 print('PASS P2 pinned source, materializer fingerprint and local tamper repair')
finally:
 if file.read_bytes()!=original:
  file.write_bytes(original)
  subprocess.run([sys.executable,str(root/'scripts/materialize-market-p2.py')],check=True,capture_output=True)
