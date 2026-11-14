// Local, read-only engine dashboard. Never configures wallet funding or inference.
import { mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
const { values } = parseArgs({ options: { port: { type: 'string', default: '4188' },
  prometheus: { type: 'string', default: 'http://127.0.0.1:19091' } } });
const port = Number(values.port);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('invalid_port');
const root = fileURLToPath(new URL('../', import.meta.url));
const state = resolve(root, '.market-runs/provider-dashboard');
process.umask(0o077); mkdirSync(state, { recursive: true, mode: 0o700 });
const keyFile = resolve(state, 'storage.key');
try { writeFileSync(keyFile, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 }); }
catch (error) { if (error.code !== 'EEXIST') throw error; }
if ((statSync(keyFile).mode & 0o077) !== 0) throw new Error('storage_key_must_be_private');
const storageKey = readFileSync(keyFile, 'utf8').trim();
if (!/^[0-9a-f]{64}$/.test(storageKey)) throw new Error('invalid_storage_key');
const child = spawn(process.execPath, ['src/main.mjs'], { cwd: resolve(root, 'clients/buyer-gateway'), stdio: 'inherit',
  env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), BUYER_APP_ORIGIN: `http://127.0.0.1:${port}`,
    BUYER_STORAGE_KEY: storageKey, BUYER_DATABASE: resolve(state, 'buyer.sqlite'),
    BUYER_STATIC_DIR: resolve(root, 'clients/market-playground/dist'),
    NEAR_INTENTS_AGENT_API_KEY: '', BUYER_MERCHANT_ACCOUNT: '', BUYER_OWNER_TERMS_URL: '', BUYER_WALLET_FUNDING_ENABLED: '0',
    PROVIDER_PROMETHEUS_URL: values.prometheus, PROVIDER_TELEMETRY_PUBLIC: '1' } });
console.log(`GPU dashboard: http://127.0.0.1:${port}/gpu (read-only engine telemetry)`);
process.on('SIGINT', () => child.kill('SIGINT')); process.on('SIGTERM', () => child.kill('SIGTERM'));
child.on('exit', code => { process.exitCode = code ?? 0; });
child.on('error', () => { process.stderr.write('Dashboard could not start\n'); process.exitCode = 1; });
