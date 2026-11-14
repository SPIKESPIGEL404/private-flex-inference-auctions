"""Read-only guard for the specific pre-registration B bootstrap failure.

Run only after the previous container has stopped. A successful guard authorizes
using a NEW namespace; it never deletes or repairs the failed namespace.
"""
import argparse
import json
import os
from pathlib import Path


def check(root, expected_market_id):
    assert root.is_dir() and not root.is_symlink(), 'failed bootstrap root missing or redirected'
    for name in ['runtime.json','plan.json','registration-input.json']:
        assert (root/name).is_file() and not (root/name).is_symlink(), 'failed bootstrap evidence missing or redirected'
    assert expected_market_id.startswith('baseline_b_v2_')
    assert json.loads((root/'plan.json').read_bytes())['market_id']==expected_market_id, 'unexpected failed market'
    assert json.loads((root/'runtime.json').read_bytes())['database']==expected_market_id, 'unexpected failed database'
    assert not os.path.lexists(root/'state'), 'registration may have begun; investigate'
    assert not any(root.glob('calibration*')) and not any(root.glob('measurement*')), 'inference may have begun; investigate'
    assert not os.path.lexists(root/'host.log'), 'host may have served requests; investigate'
    return {'version':1,'failedBootstrapPreserved':True,'registrationStarted':False,'calibrationStarted':False}


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root',required=True,choices=['/data/baseline-b-v2'])
    parser.add_argument('--market-id',required=True)
    args=parser.parse_args()
    print('BASELINE_B_RECOVERY_GUARD '+json.dumps(check(Path(args.root),args.market_id)))
