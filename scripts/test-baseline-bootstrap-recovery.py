import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec=importlib.util.spec_from_file_location('recovery',Path(__file__).with_name('check-baseline-bootstrap-recovery.py'))
recovery=importlib.util.module_from_spec(spec);spec.loader.exec_module(recovery)


class RecoveryGuard(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);self.market='baseline_b_v2_failed'
        for name,value in [('plan.json',{'market_id':self.market}),('runtime.json',{'database':self.market}),('registration-input.json',{})]:
            (self.root/name).write_text(json.dumps(value))

    def test_accepts_only_pre_registration_failure(self):
        self.assertFalse(recovery.check(self.root,self.market)['calibrationStarted'])

    def test_rejects_possible_registration_inference_and_dangling_links(self):
        for name in ['state','calibration-intent.json','measurement.retry.json','host.log']:
            path=self.root/name;path.symlink_to(self.root/'nonexistent')
            with self.assertRaises(AssertionError):recovery.check(self.root,self.market)
            path.unlink()

    def test_refuses_other_market_or_database(self):
        with self.assertRaises(AssertionError):recovery.check(self.root,'baseline_b_v2_other')
        (self.root/'runtime.json').write_text('{"database":"private_market_already_repaired"}')
        with self.assertRaises(AssertionError):recovery.check(self.root,self.market)


if __name__=='__main__':unittest.main()
