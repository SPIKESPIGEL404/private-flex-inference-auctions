// Explicit loopback-only UI fixture. No real GPU, wallet, payment or inference.
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { ProviderTelemetry } from '../src/provider-telemetry.mjs';
import { createGateway } from '../src/server.mjs';
import { setup } from './support.mjs';
let mode = 'live', epoch = Date.now() / 1000 - 900;
const control = createServer((request, response) => {
  const action = request.url.slice(1);
  if (!['live', 'offline', 'stale', 'restart'].includes(action)) { response.writeHead(404).end(); return; }
  mode = action;
  if (mode === 'restart') epoch = Date.now() / 1000;
  response.writeHead(200, { 'content-type': 'text/plain' }); response.end('Controlled UI fixture: ' + mode);
});
const telemetry = new ProviderTelemetry({ url: 'http://127.0.0.1:1', job: 'fixture', public: true }, {
  intervalMs: 500,
  fetchImpl: async () => {
    if (mode === 'offline') throw new Error('controlled_failure');
    const now = Date.now() / 1000;
    const values = { up: 1, targets: 1, series: 1, sampledAt: now - (mode === 'stale' ? 40 : 0), epoch, epochChanges: 0,
      running: 2, waiting: 3, kvUsage: .4, outputTokensPerSecond: 40, inputTokensPerSecond: 120,
      cacheHitRate: .6, ttftP95Ms: 250, queueP95Ms: 100, newPrefillTokensPerRequest: 24,
      preemptionsTotal: 1, completedPerSecond: .8 };
    return Response.json({ status: 'success', data: { resultType: 'vector', result: Object.entries(values).map(([key, value]) =>
      ({ metric: { dashboard_metric: key }, value: [now, String(value)] })) } });
  },
});
const env = setup({ origin: 'http://127.0.0.1:4299', fundingEnabled: false, apiConfigured: false,
  providerTelemetry: { public: true }, staticDir: resolve(import.meta.dirname, '../../market-playground/dist') });
const { server } = createGateway({ ...env, telemetry });
control.listen(4399, '127.0.0.1');
server.listen(4299, '127.0.0.1', () => console.log('CONTROLLED telemetry UI fixture http://127.0.0.1:4299/gpu; control http://127.0.0.1:4399/{live,offline,stale,restart}'));
const close = () => { telemetry.stop(); control.close(); server.closeAllConnections(); server.close(() => { env.store.close(); process.exit(0); }); };
process.on('SIGINT', close); process.on('SIGTERM', close);
