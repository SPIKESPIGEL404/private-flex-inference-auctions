"""Explicit packaged startup; never loads images or host scripts."""
import hashlib
import json
import os
from pathlib import Path
import sys

HERE=Path('/opt/package')


def verify_package():
    assets=json.loads((HERE/'assets.json').read_bytes())
    for name,expected in assets.items():
        assert Path(name).name==name and hashlib.sha256((HERE/name).read_bytes()).hexdigest()==expected, 'packaged asset mismatch'
    seed=json.loads((HERE/'chutes-seed.json').read_bytes())
    plan=json.loads(seed['files']['plan.json'])
    assert plan['market_id'].startswith('baseline_b_v3_')
    assert set(plan['tokenizer_files_sha256'])=={'tokenizer.json','tokenizer_config.json'}
    return assets,seed,plan


def main():
    assets,seed,plan=verify_package()
    if sys.argv[1:]==['--check-package']:
        print(json.dumps({'packageVerified':True,'assetCount':len(assets),'preLaunchRequired':False,'inferenceCalls':0,'stateWrites':0}))
        return
    assert len(sys.argv)==1, 'only the reviewed startup or package check is supported'
    from recovery_guard import check
    # Compose must stop the predecessor before starting this replacement.
    check(Path('/data/baseline-b-v2'),plan['market_id'].replace('baseline_b_v3_','baseline_b_v2_',1))
    from bootstrap_chutes import install
    os.umask(0o077)
    root=Path('/data/baseline-b-v3');root.mkdir(mode=0o700,exist_ok=True)
    for name in plan['tokenizer_files_sha256']:
        assert plan['tokenizer_files'][name]==str(root/name)
        install(root/name,(HERE/name).read_bytes())
    seed_path=HERE/'chutes-seed.json'
    command=[sys.executable,'/opt/market/bootstrap_chutes.py','--seed',str(seed_path),
        '--seed-sha256',assets['chutes-seed.json'],'--run-directory',str(root),
        '--credential-source-directory','/data/chutes-run']
    os.execv(sys.executable,command)


if __name__=='__main__':
    sys.path.insert(0,'/opt/market')
    main()
