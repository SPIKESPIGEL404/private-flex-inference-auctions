import unittest
from datetime import datetime, timezone, timedelta
from decimal import Decimal
from billing_snapshot import summarize
from gateway import CHUTE_ID


class BillingTests(unittest.TestCase):
    def test_provider_decimal_amount_and_window_scope_are_preserved(self):
        start=datetime(2026,11,14,tzinfo=timezone.utc);end=start+timedelta(minutes=1)
        row={'chute_id':CHUTE_ID,'bucket':start.isoformat(),'amount':Decimal('0.00000101'),'count':1,'input_tokens':2,'output_tokens':3}
        value=summarize([row],start,end)
        self.assertEqual(value['reportedUsageUsd'],'0.00000101');self.assertEqual(value['reportedUsageMicroUsdCeil'],'2');self.assertIsNone(value['providerBillMicroPerRequest'])
        with self.assertRaises(AssertionError):summarize([dict(row,chute_id='other')],start,end)
        with self.assertRaises(AssertionError):summarize([dict(row,amount=Decimal('NaN'))],start,end)
