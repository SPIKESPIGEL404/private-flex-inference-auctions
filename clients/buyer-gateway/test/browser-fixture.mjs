// Explicit, loopback-only browser acceptance. This is not imported by src/main.
// Every Agent API response comes from AgentFixture; no real wallet or funds.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createGateway } from '../src/server.mjs';
import { setup, allocationInput, authorize, ownerKeys } from './support.mjs';

const env = setup({ origin: 'http://127.0.0.1:4281', fundingEnabled: false,
  staticDir: resolve(import.meta.dirname, '../../market-playground/dist') });
let plan = await authorize(env, await env.onboarding.create(env.owner, allocationInput(2)));
for (const buyer of plan.buyers) env.fixture.balances.set(buyer.agentId, [{ asset_id: env.config.assetId, available_raw: '149999' }]);
plan = await env.onboarding.refresh(env.owner, plan.id);
const { server, auth } = createGateway(env);
const challenge = auth.challenge();
const session = await auth.verify(challenge.token, { accountId: env.owner.account_id,
  publicKey: env.owner.public_key, signature: env.sign(challenge.payload) });
const newcomer = ownerKeys('bob.near'), freshChallenge = auth.challenge();
const freshSession = await auth.verify(freshChallenge.token, { accountId: newcomer.owner.account_id,
  publicKey: newcomer.owner.public_key, signature: newcomer.sign(freshChallenge.payload) });
mkdirSync('.state', { recursive: true, mode: 0o700 });
writeFileSync('.state/browser-session.json', JSON.stringify({ token: session.token, owner: env.owner, allocationId: plan.id,
  freshToken: freshSession.token, freshOwner: newcomer.owner }), { mode: 0o600 });
server.listen(4281, '127.0.0.1', () => process.stdout.write('Controlled browser fixture: http://127.0.0.1:4281 (no real funds)\n'));
const close = () => server.close(() => { env.store.close(); process.exit(0); });
process.on('SIGINT', close); process.on('SIGTERM', close);
