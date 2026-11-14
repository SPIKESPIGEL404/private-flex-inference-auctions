#!/usr/bin/env python3
"""Materialize reviewed source patch, leaving Cargo's shared checkout untouched."""
import hashlib, io, json, os, pathlib, shutil, subprocess, tarfile, tempfile
ROOT=pathlib.Path(__file__).resolve().parent.parent
PIN='244177cafa26e8c8b001e61297cf4e7f89ac8de9'
source_dir=ROOT/'crates/private-market-host/upstream/p1'
target=ROOT/'.market-p1-upstream'
inputs=sorted(p for p in source_dir.iterdir() if p.is_file())
digest=hashlib.sha256(b''.join(p.name.encode()+p.read_bytes() for p in inputs)).hexdigest()
marker=target/'.p1-source.json'
def tree_hash():
 return {str(p.relative_to(target)):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(target.rglob('*')) if p.is_file() and p!=marker}
if marker.exists():
 previous=json.loads(marker.read_text())
 if previous.get('base')==PIN and previous.get('patch_sha256')==digest and previous.get('source_sha256')==tree_hash():
  print(str(target)); raise SystemExit(0)
candidates=list((pathlib.Path(os.environ.get('CARGO_HOME',pathlib.Path.home()/'.cargo'))/'git/checkouts').glob('bitrouter-cloud-*/*'))
source=next((p for p in candidates if subprocess.run(['git','-C',str(p),'rev-parse','HEAD'],capture_output=True,text=True).stdout.strip()==PIN),None)
if source is None:
 with tempfile.TemporaryDirectory(prefix='market-p1-source-') as temp:
  subprocess.run(['git','init','--bare',temp],check=True,capture_output=True)
  subprocess.run(['git','-C',temp,'fetch','--depth=1','https://github.com/bitrouter/bitrouter-cloud.git',PIN],check=True,capture_output=True)
  archive=subprocess.check_output(['git','-C',temp,'archive',PIN])
else: archive=subprocess.check_output(['git','-C',str(source),'archive',PIN])
if target.exists(): shutil.rmtree(target)
target.mkdir()
with tarfile.open(fileobj=io.BytesIO(archive)) as tf:
 for member in tf.getmembers():
  if member.name.startswith('/') or '..' in pathlib.PurePosixPath(member.name).parts: raise SystemExit('Invalid archive path')
 tf.extractall(target)
patch=source_dir/'owning.patch'
subprocess.run(['patch','--batch','--forward','-p1','-i',str(patch)],cwd=target,check=True,capture_output=True)
for name in ['paid_orders.rs','paid_orders.sql']:
 shutil.copyfile(source_dir/name,target/'src/market/pg'/name)
marker.write_text(json.dumps({'base':PIN,'patch_sha256':digest,'source_sha256':tree_hash()},indent=2)+'\n')
print(str(target))
