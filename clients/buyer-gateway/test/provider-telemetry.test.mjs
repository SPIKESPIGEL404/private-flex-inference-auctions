import test from 'node:test';
import assert from 'node:assert/strict';
import { ProviderTelemetry, decodeTelemetry, telemetryConfig } from '../src/provider-telemetry.mjs';
import { createGateway } from '../src/server.mjs';
import { setup } from './support.mjs';

const at = 1_800_000_000_000;
const values = { up: 1, targets: 1, sampledAt: at / 1000, epoch: at / 1000 - 500,
  series: 1, epochChanges: 0, counterResets: 0, running: 2, waiting: 3, kvUsage: .4,
  outputTokensPerSecond: 40, inputTokensPerSecond: 120, cacheHitRate: .6,
  ttftP95Ms: 250, queueP95Ms: 100, newPrefillTokensPerRequest: 24,
  preemptionsTotal: 0, completedPerSecond: .8 };
const vector = (overrides = {}) => ({ status: 'success', data: { resultType: 'vector',
  result: Object.entries({ ...values, ...overrides }).filter(([, value]) => value !== undefined)
    .map(([key, value]) => ({ metric: { dashboard_metric: key }, value: [at / 1000, String(value)] })) } });

test('telemetry is opt-in; URLs and query selectors cannot inject credentials or arbitrary queries', () => {
  assert.equal(telemetryConfig({}), null);
  for (const url of ['http://remote.invalid', 'https://u:secret@example.com', 'https://example.com/query', 'https://example.com/?query=up'])
    assert.throws(() => telemetryConfig({ PROVIDER_PROMETHEUS_URL: url }));
  assert.throws(() => telemetryConfig({ PROVIDER_PROMETHEUS_URL: 'http://127.0.0.1:9090', PROVIDER_PROMETHEUS_JOB: 'x"} or up' }));
  assert.deepEqual(telemetryConfig({ PROVIDER_PROMETHEUS_URL: 'http://127.0.0.1:9090' }),
    { url: 'http://127.0.0.1:9090', job: 'chutes-qwen3.8-27b', public: false });
});

test('real-time values retain actual zeros; no observations produce null, not invented latency/cache ratios', () => {
  const next = decodeTelemetry(vector({ running: 0, waiting: 0, kvUsage: 0, cacheHitRate: 'NaN', ttftP95Ms: 'NaN' }), at);
  assert.equal(next.state, 'live'); assert.equal(next.metrics.running, 0); assert.equal(next.metrics.kvUsage, 0);
  assert.equal(next.metrics.cacheHitRate, null); assert.equal(next.metrics.ttftP95Ms, null);
  assert.equal(next.metrics.outputTokensPerSecond, 40);
});

test('scrape freshness uses the underlying sample timestamp, not query evaluation time', () => {
  const next = decodeTelemetry(vector({ sampledAt: at / 1000 - 30 }), at);
  assert.equal(next.state, 'stale'); assert.equal(next.metrics.running, null);
  assert.equal(decodeTelemetry(vector({ sampledAt: at / 1000 + 100 }), at).state, 'stale');
});

test('failed scrapes, ambiguous targets/engines and missing epochs do not produce live values', () => {
  for (const changes of [{ up: 0 }, { targets: 2 }, { series: 2 }, { epoch: undefined }, { running: undefined }]) {
    const next = decodeTelemetry(vector(changes), at); assert.equal(next.state, 'unavailable');
    assert.ok(Object.values(next.metrics).every(value => value === null));
  }
});

test('a boot-spanning rate/histogram window is withheld while fresh gauges remain available', () => {
  for (const changes of [{ epoch: at / 1000 - 20 }, { epochChanges: 1 }, { counterResets: 1 }]) {
    const next = decodeTelemetry(vector(changes), at);
    assert.equal(next.metrics.running, 2); assert.equal(next.metrics.ttftP95Ms, null);
    assert.equal(next.metrics.outputTokensPerSecond, null); assert.equal(next.metrics.cacheHitRate, null);
  }
});

test('malformed or partial-warning query responses are rejected', () => {
  for (const body of [{}, { ...vector(), warnings: ['partial data'] },
    { ...vector(), data: { resultType: 'matrix', result: [] } }]) assert.throws(() => decodeTelemetry(body, at));
  const duplicate = vector(); duplicate.data.result.push(duplicate.data.result[0]);
  assert.throws(() => decodeTelemetry(duplicate, at));
});

test('shared refresh, bounded history, process epochs, failure redaction and stale snapshots', async () => {
  let now = at, calls = 0, response = vector(), reject = false;
  const telemetry = new ProviderTelemetry({ url: 'http://127.0.0.1:9090', job: 'test', public: true }, {
    now: () => now, fetchImpl: async (url, options) => {
      calls++; assert.equal(url.pathname, '/api/v1/query'); assert.equal(options.redirect, 'error');
      assert.equal(options.headers, undefined);
      if (reject) throw new Error('Bearer secret-cpk-key and private network details');
      await Promise.resolve(); return Response.json(response);
    },
  });
  await Promise.all([telemetry.refresh(), telemetry.refresh(), telemetry.refresh()]); assert.equal(calls, 1);
  assert.equal(telemetry.snapshot().history.length, 1);
  await telemetry.refresh(); assert.equal(telemetry.snapshot().history.length, 1);
  now += 5000; response = vector({ sampledAt: now / 1000 }); await telemetry.refresh();
  assert.equal(telemetry.snapshot().history.length, 2);
  now += 5000; response = vector({ sampledAt: now / 1000, epoch: at / 1000 - 600 }); await telemetry.refresh();
  assert.equal(telemetry.snapshot().history.length, 1); assert.equal(telemetry.snapshot().metrics.outputTokensPerSecond, null);
  reject = true; await telemetry.refresh();
  assert.equal(telemetry.snapshot().state, 'stale'); assert.equal(telemetry.snapshot().metrics.running, null);
  assert.ok(!JSON.stringify(telemetry.snapshot()).includes('secret-cpk-key'));
  now += 400_000; await telemetry.refresh(); assert.equal(telemetry.snapshot().history.length, 0);
  telemetry.stop();
});

test('HTTP telemetry is GET-only, same-origin, session-gated by default, with explicit public aggregate mode', async t => {
  const env = setup(); t.after(() => env.store.close());
  const telemetry = new ProviderTelemetry(null);
  const config = { ...env.config, providerTelemetry: { public: false } };
  const { server, auth } = createGateway({ ...env, config, telemetry });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base + '/buyer-api/provider-telemetry')).status, 401);
  const challenge = auth.challenge();
  const session = await auth.verify(challenge.token, { accountId: env.owner.account_id,
    publicKey: env.owner.public_key, signature: env.sign(challenge.payload) });
  const headers = { cookie: 'private_market_session=' + session.token };
  const r = await fetch(base + '/buyer-api/provider-telemetry', { headers }); assert.equal(r.status, 200);
  assert.equal((await r.json()).state, 'disabled'); assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal((await fetch(base + '/buyer-api/provider-telemetry?query=up', { headers })).status, 400);
  assert.equal((await fetch(base + '/buyer-api/provider-telemetry', { method: 'POST', headers: { ...headers, origin: env.config.origin } })).status, 405);
  const privateStream = await fetch(base + '/buyer-api/provider-telemetry/events', { headers });
  const privateReader = privateStream.body.getReader(); await privateReader.read();
  auth.logout(session.token);
  for (const listener of telemetry.listeners) listener(telemetry.snapshot(false));
  assert.equal((await privateReader.read()).done, true, 'revoked sessions cannot continue receiving snapshots');
  assert.equal((await fetch(base + '/buyer-api/provider-telemetry', { headers })).status, 401);
  config.providerTelemetry.public = true;
  assert.equal((await fetch(base + '/buyer-api/provider-telemetry')).status, 200);
  const abort = new AbortController();
  const stream = await fetch(base + '/buyer-api/provider-telemetry/events', { signal: abort.signal });
  const reader = stream.body.getReader(); const { value } = await reader.read();
  assert.match(new TextDecoder().decode(value), /event: telemetry/); assert.equal(stream.headers.get('content-type'), 'text/event-stream');
  abort.abort(); await reader.cancel().catch(() => {});
  telemetry.stop(); server.closeAllConnections();
  assert.equal(env.fixture.requests.length, 0, 'telemetry never contacts the wallet API or submits inference');
});
