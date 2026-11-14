"""Regression: market IDs are not necessarily safe host database names."""
import importlib.util
from pathlib import Path
import sys
import unittest

root=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(root/'deploy/phala'))
spec=importlib.util.spec_from_file_location('chutes_runtime',root/'deploy/phala/runtime_chutes.py')
runtime=importlib.util.module_from_spec(spec);spec.loader.exec_module(runtime)


class DatabaseNaming(unittest.TestCase):
    def test_market_ids_meet_host_and_postgres_contracts(self):
        for market in ['baseline_b_v2_e8d07ebf4cfb4a38bbe294f5a4114eef','market/with punctuation','市场'*200]:
            name=runtime.database_name(market)
            self.assertRegex(name,r'^private_market_[a-z0-9_]+$')
            self.assertLessEqual(len(name.encode()),63)
            self.assertEqual(name,runtime.database_name(market))
            runtime.validate_database_name(name)

    def test_distinct_market_ids_remain_isolated(self):
        self.assertNotEqual(runtime.database_name('baseline-b-v2'),runtime.database_name('baseline-b-v3'))

    def test_existing_invalid_database_requires_investigation(self):
        for name in ['baseline_b_v2_failed','private_market_'+'a'*64,'private_market_a;drop database x']:
            with self.assertRaises(AssertionError):runtime.validate_database_name(name)


if __name__=='__main__':unittest.main()
