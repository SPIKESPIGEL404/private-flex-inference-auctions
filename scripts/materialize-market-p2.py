#!/usr/bin/env python3
"""Materialize reviewed source patch, leaving Cargo's shared checkout untouched."""
import hashlib, io, json, os, pathlib, shutil, subprocess, tarfile, tempfile
ROOT=pathlib.Path(__file__).resolve().parent.parent
PIN='244177cafa26e8c8b001e61297cf4e7f89ac8de9'
source_dir=ROOT/'crates/private-market-host/upstream/p2'
p1_dir=ROOT/'crates/private-market-host/upstream/p1'
auction_dir=ROOT/'crates/private-market-host/upstream/auction'
target=ROOT/'.market-p2-upstream'
inputs=sorted([p for d in [p1_dir,source_dir,auction_dir] for p in d.iterdir() if p.is_file()]+[pathlib.Path(__file__).resolve()])
digest=hashlib.sha256(json.dumps({str(p.relative_to(ROOT)):hashlib.sha256(p.read_bytes()).hexdigest() for p in inputs},sort_keys=True).encode()).hexdigest()
marker=target/'.p2-source.json'
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
patch=p1_dir/'owning.patch'
subprocess.run(['patch','--batch','--forward','-p1','-i',str(patch)],cwd=target,check=True,capture_output=True)
for name in ['paid_orders.rs','paid_orders.sql']:
 shutil.copyfile(p1_dir/name,target/'src/market/pg'/name)
module=target/'src/market/pg/paid_orders.rs'
original=module.read_text()
assert original.count('let hash = fingerprint(db).await?;')==1,'owning install anchor changed'
module.write_text(original.replace('let hash = fingerprint(db).await?;', '''if std::env::var("PRIVATE_MARKET_AGENT_P2").as_deref() == Ok("controlled") {
            db.execute_unprepared(include_str!("paid_tasks.sql")).await?;
        }
        if std::env::var("PRIVATE_MARKET_AUCTION").as_deref() == Ok("controlled") {
            db.execute_unprepared(include_str!("auction.sql")).await?;
        }
        let hash = fingerprint(db).await?;'''))
patched=module.read_text()
verify_anchor='pub(super) async fn verify(db: &impl ConnectionTrait) -> Result<()> {'
assert patched.count(verify_anchor)==1
module.write_text(patched.replace(verify_anchor, verify_anchor+'''
    let auction = db.query_one(sql(
        "SELECT to_regclass('public.mpp_direct_auction_state') IS NOT NULL AS found", vec![]
    )).await?.context("auction mode probe")?.try_get::<bool>("", "found")?;
    ensure!(auction == (std::env::var("PRIVATE_MARKET_AUCTION").as_deref() == Ok("controlled")),
        "native auction mode differs from owning schema");
'''))
shutil.copyfile(source_dir/'paid_tasks.sql',target/'src/market/pg/paid_tasks.sql')
shutil.copyfile(auction_dir/'market.sql',target/'src/market/pg/auction.sql')
marker.write_text(json.dumps({'base':PIN,'patch_sha256':digest,'source_sha256':tree_hash()},indent=2)+'\n')
print(str(target))
