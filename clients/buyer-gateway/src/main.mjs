import { createAgentApi } from '@near-intents-agent-api/sdk';
import { Store } from './store.mjs';
import { NearRpc } from './near.mjs';
import { configFromEnv } from './config.mjs';
import { createGateway } from './server.mjs';
import { publicError } from './errors.mjs';

try {
  process.umask(0o077);
  const config = configFromEnv();
  const store = new Store(config.dbPath, config.storageKey);
  const api = createAgentApi({ apiKey: config.apiKey || 'not-configured', baseUrl: config.apiUrl, timeoutMs: 25_000 });
  const { server } = createGateway({ config, store, api, rpc: new NearRpc(config.rpcUrl) });
  server.listen(config.port, config.host, () => process.stdout.write(`Buyer gateway listening on ${config.host}:${config.port}\n`));
  const close = () => { server.close(() => { store.close(); process.exit(0); }); };
  process.on('SIGTERM', close); process.on('SIGINT', close);
} catch (error) {
  process.stderr.write(`Buyer gateway startup failed: ${publicError(error).code}\n`);
  process.exitCode = 1;
}
