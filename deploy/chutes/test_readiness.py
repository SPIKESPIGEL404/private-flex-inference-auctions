import unittest
from readiness import SupplyMonitor


class Gateway:
    config={'model_revision':'pinned'}
    def __init__(self):self.instances=[];self.verifies=0;self.fail=False;self.reads=0
    async def bounded_json(self,*_,**__):self.reads+=1;return {'instances':self.instances,'disabled':False}
    async def verify(self):
        self.verifies+=1
        if self.fail:raise RuntimeError('private upstream details')
        return {'instance_id':'one'},'a'*64


class ReadinessTests(unittest.IsolatedAsyncioTestCase):
    async def test_offline_and_warming_are_not_ready_and_never_verify_or_invoke(self):
        gateway=Gateway();monitor=SupplyMonitor(gateway,lambda:100000)
        self.assertEqual((await monitor.refresh())['state'],'offline')
        gateway.instances=[{'active':False,'verified':False}]
        self.assertEqual((await monitor.refresh())['state'],'warming');self.assertEqual(gateway.verifies,0)
        for _ in range(100):monitor.snapshot()
        self.assertEqual(gateway.reads,2)

    async def test_ready_requires_verification_and_expires_without_warmup(self):
        now=[100000];gateway=Gateway();gateway.instances=[{'instance_id':'one','active':True,'verified':True}]
        monitor=SupplyMonitor(gateway,lambda:now[0]);ready=await monitor.refresh()
        self.assertTrue(ready['ready']);self.assertEqual(gateway.verifies,1)
        now[0]+=45001;self.assertEqual(monitor.snapshot()['state'],'unknown')
        gateway.fail=True;failed=await monitor.refresh();self.assertEqual(failed['state'],'unavailable');self.assertNotIn('private',str(failed))
