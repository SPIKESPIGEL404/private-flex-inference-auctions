#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, relative, join } from 'node:path';

if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Node >=24 required by pinned Agent API SDK');
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const pkg = join(root, 'services/mpp-near-direct');
const requiredSuites = ['test/contracts.test.mjs', 'test/interop.test.mjs', 'test/verification.test.mjs'];
const files = readdirSync(join(pkg, 'test')).filter(f => f.endsWith('.test.mjs')).sort().map(f => `test/${f}`);
for (const suite of requiredSuites) if (!files.includes(suite)) throw new Error(`Missing required suite: ${suite}`);
const log = execFileSync(process.execPath, ['--test', '--test-reporter=tap', ...files], { cwd: pkg, encoding: 'utf8' });
const counts = Object.fromEntries(['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'].map(k => {
  const match = log.match(new RegExp(`^# ${k} (\\d+)$`, 'm'));
  if (!match) throw new Error(`Missing test result ${k}`); return [k, Number(match[1])];
}));
if (counts.fail || counts.cancelled || counts.skipped || counts.todo || counts.pass !== counts.tests) throw new Error('Incomplete P0 checks');
const requiredGates = [
  'official mppx client/server 402 -> persisted original proof -> receipt, no second transfer',
  'official Agent API SDK encodes native transfer/signing routes with original operation key and grant',
  'independently verifies final native transfer, full-access key and signed order binding',
  'concurrent task reservations from independent workers cannot overspend one authorization',
  'two independently valid signed assignments cannot buy two orders with the same movement',
  'equal merchant transfer cannot be relabelled as an unrelated refund; original unknown holds W',
  'native policy conforms to official pinned Policy schema and new-policy rules',
];
for (const gate of requiredGates) if (!log.includes(`# Subtest: ${gate}\n`)) throw new Error(`Missing required gate: ${gate}`);
const digest = data => createHash('sha256').update(data).digest('hex');
const selected = [];
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path); else selected.push(relative(root, path));
  }
}
walk(pkg);
selected.push('scripts/accept-agent-mpp-p0.mjs', 'docs/specs/2026-11-14-agent-mpp-inference-integration.md',
  'docs/specs/2026-11-14-agent-mpp-p0-contract.md', 'docs/specs/2026-11-14-agent-mpp-p0-owning-interfaces.md');
const sources = Object.fromEntries(selected.sort().map(p => [p, digest(readFileSync(join(root, p)))]));
const evidence = { schema: 'agent-mpp-p0-evidence-v1', generatedAt: new Date().toISOString(),
  node: process.version, baseline: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  prototypeVerdict: 'PASS', overallPhase0: 'PARTIAL', liveActivation: 'BLOCKED',
  blockers: ['F1: unmodified Agent API SDK cannot enforce the frozen per-operation native fee bound'],
  decisions: { asset: 'native:NEAR', decimals: 24, price: 'metered-prepay-refund', approval: 'user-confirmed-2026-11-14' },
  scope: 'Controlled SDK/RPC/SQLite feasibility only; no Market PG/Redis integration or real funds/provider/deployment',
  counts, requiredSuites, requiredGates, externalTransactions: 0, providerCalls: 0, sourceSha256: sources,
  testLogSha256: digest(log), command: 'node scripts/accept-agent-mpp-p0.mjs' };
writeFileSync(join(root, 'docs/acceptance/2026-11-14-agent-mpp-p0-tests.tap'), log);
writeFileSync(join(root, 'docs/acceptance/2026-11-14-agent-mpp-p0-evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify({ prototypeVerdict: evidence.prototypeVerdict, overallPhase0: evidence.overallPhase0,
  liveActivation: evidence.liveActivation, counts, artifacts: Object.keys(sources).length }));
