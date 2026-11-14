import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { Onboarding } from '../src/onboarding.mjs';
import { setup, allocationInput, authorize, ownerKeys } from './support.mjs';

test('two independently owned wallets, equal integer principal, separate grants, no secret in DTOs', async t => {
  const env = setup(); t.after(() => env.store.close());
  const input = allocationInput();
  let plan = await env.onboarding.create(env.owner, input);
  assert.equal(plan.perAgentRaw, '150000'); assert.equal(plan.remainderRaw, '1');
  assert.equal((await env.onboarding.create(env.owner, input)).id, plan.id);
  await assert.rejects(env.onboarding.create(env.owner, { ...input, total: '0.40' }), { code: 'allocation_conflict' });
  plan = await authorize(env, plan);
  assert.equal(new Set(plan.buyers.map(b => b.wallet)).size, 2);
  const credentials = input.buyers.map(b => env.onboarding.buyer(env.owner, b.id).credential);
  assert.notEqual(credentials[0].token, credentials[1].token);
  for (const credential of credentials) assert.ok(!JSON.stringify(plan).includes(credential.token));
  assert.ok(plan.buyers.every(b => b.phase === 'funding_pending'));
  const creates = env.fixture.requests.filter(r => r.path === '/v1/generate-intent' && r.body.type === 'agent_create');
  assert.equal(creates.length, 2);
  for (const create of creates) {
    assert.deepEqual(create.body.owner, env.owner);
    assert.equal(create.body.policy.destinations.mode, 'only');
    assert.equal(create.body.policy.owner_approval, false);
    assert.equal(create.body.policy.native, undefined);
  }
  assert.deepEqual(env.fixture.requests.filter(r => r.path.endsWith('/deposit')), []);
  assert.equal((await env.onboarding.prepare(env.owner, plan.id)).signing, null);
  assert.equal(env.fixture.agents.size, 2);
});

test('grant renewal keeps the existing wallet; unsigned policy widening never reaches a signer', async t => {
  const env = setup(); t.after(() => env.store.close());
  let plan = await authorize(env, await env.onboarding.create(env.owner, allocationInput(1)));
  const originalWallet = plan.buyers[0].wallet;
  for (const op of env.fixture.generated.values()) if (op.body.type === 'grant_issue') op.body.expires_at = new Date(Date.now() - 1).toISOString();
  const { signing } = await env.onboarding.prepare(env.owner, plan.id);
  assert.equal(signing.type, 'grant_issue');
  plan = await env.onboarding.submit(env.owner, plan.id, { buyerId: signing.buyerId, correlationId: signing.correlationId, signature: env.sign(signing.intent.payload) });
  assert.equal(plan.buyers[0].wallet, originalWallet);
  assert.equal(env.fixture.agents.size, 1);
  env.fixture.wrongPreview = true;
  const other = await env.onboarding.create(env.owner, allocationInput(1));
  await assert.rejects(env.onboarding.prepare(env.owner, other.id), { code: 'upstream_policy_mismatch' });
});

test('terms acceptance is persisted and omitted acceptance cannot start allocation or funding', async t => {
  const env = setup(); t.after(() => env.store.close());
  const input = allocationInput(1);
  await assert.rejects(env.onboarding.create(env.owner, { ...input, acceptance: undefined }), { code: 'owner_acceptance_required' });
  assert.equal(env.fixture.requests.length, 0);
  const plan = await env.onboarding.create(env.owner, input);
  const saved = env.store.get('allocation', plan.id, env.owner.account_id);
  assert.equal(saved.acceptance.ownerTermsUrl, env.config.ownerTermsUrl);
  assert.deepEqual(saved.acceptance.owner, env.owner);
  await assert.rejects(env.onboarding.beginFunding(env.owner, plan.id), { code: 'owner_acceptance_required' });
});

test('lost generate and submit acknowledgments reuse the original work across restart', async t => {
  const env = setup(); t.after(() => env.store.close());
  const plan = await env.onboarding.create(env.owner, allocationInput(1));
  env.fixture.loseGenerateAck = true;
  await assert.rejects(env.onboarding.prepare(env.owner, plan.id));
  const restarted = new Onboarding({ store: env.store, api: env.api, rpc: env.rpc, config: env.config });
  const { signing } = await restarted.prepare(env.owner, plan.id);
  const generations = env.fixture.requests.filter(r => r.path === '/v1/generate-intent');
  assert.equal(generations[0].key, generations[1].key);
  assert.equal(env.fixture.agents.size, 1);
  env.fixture.loseSubmitAck = true;
  await assert.rejects(restarted.submit(env.owner, plan.id, { buyerId: signing.buyerId, correlationId: signing.correlationId, signedDelegate: 'controlled-delegate' }));
  const recovered = await restarted.retrySubmitted(env.owner, plan.id);
  assert.equal(recovered.buyers[0].phase, 'grant_pending');
  assert.equal(env.fixture.requests.filter(r => r.path === '/v1/submit-intent').length, 1);
});

test('uncertain creation is observed without preparing a second agent or a grant', async t => {
  const env = setup(); t.after(() => env.store.close());
  const plan = await env.onboarding.create(env.owner, allocationInput(1));
  const { signing } = await env.onboarding.prepare(env.owner, plan.id);
  env.fixture.uncertain = true;
  await env.onboarding.submit(env.owner, plan.id, { buyerId: signing.buyerId, correlationId: signing.correlationId, signedDelegate: 'controlled-delegate' });
  assert.equal((await env.onboarding.prepare(env.owner, plan.id)).signing, null);
  await env.onboarding.retrySubmitted(env.owner, plan.id);
  assert.equal(env.fixture.agents.size, 1);
  assert.equal(env.fixture.requests.filter(r => r.path === '/v1/submit-intent').length, 1);
});

test('owner isolation, full owner-key binding, and stored grant payload prevent substitutions', async t => {
  const env = setup(); t.after(() => env.store.close());
  const plan = await env.onboarding.create(env.owner, allocationInput(1));
  const other = ownerKeys('bob.near');
  await assert.rejects(env.onboarding.prepare(other.owner, plan.id), { code: 'allocation_not_found' });
  await assert.rejects(env.onboarding.prepare(ownerKeys('alice.near').owner, plan.id), { code: 'original_owner_key_required' });
  let { signing } = await env.onboarding.prepare(env.owner, plan.id);
  await env.onboarding.submit(env.owner, plan.id, { buyerId: signing.buyerId, correlationId: signing.correlationId, signedDelegate: 'controlled-delegate' });
  ({ signing } = await env.onboarding.prepare(env.owner, plan.id));
  await assert.rejects(env.onboarding.submit(env.owner, plan.id, { buyerId: signing.buyerId, correlationId: signing.correlationId,
    signature: env.sign({ ...signing.intent.payload, message: 'a different grant' }) }), { code: 'invalid_signature' });
});

test('funding uses saved addresses, persists intent before wallet broadcast, never trusts a tx hash as credit', async t => {
  const env = setup(); t.after(() => env.store.close());
  let plan = await authorize(env, await env.onboarding.create(env.owner, allocationInput()));
  plan = await env.onboarding.deposits(env.owner, plan.id);
  await env.onboarding.deposits(env.owner, plan.id);
  assert.equal(env.fixture.requests.filter(r => r.path.endsWith('/deposit')).length, 2);
  const attempt = await env.onboarding.beginFunding(env.owner, plan.id, env.config.acceptanceVersion);
  assert.equal(attempt.transactions.length, 2);
  await assert.rejects(env.onboarding.beginFunding(env.owner, plan.id, env.config.acceptanceVersion), { code: 'funding_already_started' });
  plan = await env.onboarding.reportFunding(env.owner, plan.id, { attemptId: attempt.attemptId, hashes: ['1'.repeat(44)] });
  assert.equal(plan.ready, false);
  for (const buyer of plan.buyers) {
    const deposit = env.fixture.operations.get(buyer.deposit.correlationId);
    deposit.status = 'SUCCESS';
    env.fixture.balances.set(buyer.agentId, [{ asset_id: env.config.assetId, available_raw: '149999' }]);
  }
  plan = await env.onboarding.refresh(env.owner, plan.id);
  assert.equal(plan.ready, true);
  assert.equal(plan.procurementReady, false);
  await assert.rejects(env.onboarding.modelCall(), { code: 'procurement_not_ready' });
});

test('funding disabled or a changed policy blocks deposit preparation', async t => {
  const env = setup({ fundingEnabled: false }); t.after(() => env.store.close());
  const plan = await authorize(env, await env.onboarding.create(env.owner, allocationInput(1)));
  await assert.rejects(env.onboarding.deposits(env.owner, plan.id), { code: 'wallet_funding_disabled' });
  env.config.fundingEnabled = true; env.fixture.wrongPolicy = true;
  await assert.rejects(env.onboarding.deposits(env.owner, plan.id), { code: 'wallet_not_authorized' });
  assert.equal(env.fixture.requests.filter(r => r.path.endsWith('/deposit')).length, 0);
});

test('encrypted WAL survives reopening and refuses another key; plaintext grants never reach disk', t => {
  const directory = mkdtempSync(join(tmpdir(), 'buyer-store-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'state.sqlite'), key = randomBytes(32);
  let store = new Store(path, key);
  store.put('buyer', 'a', 'alice.near', { token: 'ngt_super_secret_grant_value' });
  for (const file of [path, path + '-wal']) assert.ok(!readFileSync(file).includes('ngt_super_secret_grant_value'));
  store.close(); store = new Store(path, key);
  assert.equal(store.get('buyer', 'a', 'bob.near'), null);
  assert.equal(store.get('buyer', 'a', 'alice.near').token, 'ngt_super_secret_grant_value');
  store.close(); store = new Store(path, randomBytes(32));
  assert.throws(() => store.get('buyer', 'a', 'alice.near')); store.close();
});
