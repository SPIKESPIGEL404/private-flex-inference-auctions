"""Short-lived supply observations. Public reads never start a GPU or invoke a model."""
import asyncio
import time


class SupplyMonitor:
    def __init__(self, gateway, clock=None):
        self.gateway = gateway
        self.clock = clock or (lambda: time.time_ns()//1000000)
        self.value = None
        self.lock = asyncio.Lock()

    def snapshot(self):
        now = self.clock()
        value = dict(self.value) if self.value else self.base('unknown', now)
        if now >= value['expiresAtMs']:
            value.update(state='unknown', ready=False, reason='observation_expired')
        return value

    def base(self, state, now):
        return {'version': 1, 'provider': 'chutes', 'model': 'qwen3.8-27b', 'state': state,
            'ready': state == 'ready', 'observedAtMs': now, 'expiresAtMs': now+45000,
            'modelRevisionRef': 'Qwen/Qwen3.8-27B-FP8@'+self.gateway.config['model_revision'],
            'coldStartEstimateSeconds': 600, 'autoShutdownSeconds': 3600,
            'inferenceCalls': 0, 'scope': 'provider-readiness-not-market-capacity'}

    async def refresh(self):
        if self.lock.locked(): return self.snapshot()
        async with self.lock:
            now = self.clock()
            try:
                from gateway import API, CHUTE_ID
                metadata = await self.gateway.bounded_json(f'{API}/chutes/{CHUTE_ID}', authenticated=True)
                if metadata.get('disabled') is True:
                    value = self.base('unavailable', now); value['reason'] = 'provider_disabled'
                else:
                    instances = metadata.get('instances') or []
                    active = [i for i in instances if i.get('active') is True and i.get('verified') is True]
                    if not active:
                        value = self.base('warming' if instances else 'offline', now)
                    else:
                        instance, session = await self.gateway.verify()
                        if instance['instance_id'] not in {i.get('instance_id') for i in active}:
                            raise ValueError('verified instance differs from active supply')
                        value = self.base('ready', self.clock())
                        value.update(instanceId=instance['instance_id'], evidenceSessionId=session)
            except Exception:
                value = self.base('unavailable', self.clock()); value['reason'] = 'provider_verification_unavailable'
            self.value = value
            return self.snapshot()

    async def run(self):
        while True:
            await self.refresh()
            await asyncio.sleep(15)
