import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import assert from 'node:assert/strict';
import bs58 from 'bs58';
import { createAgentApi } from '@near-intents-agent-api/sdk';
import { Store } from '../src/store.mjs';
import { Onboarding } from '../src/onboarding.mjs';
import { nep413Hash } from '../src/near.mjs';

export function ownerKeys(account = 'alice.near') {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  const owner = { type: 'near', account_id: account, public_key: 'ed25519:' + bs58.encode(raw) };
  return { owner, sign: payload => sign(null, nep413Hash(payload), privateKey).toString('base64') };
}
export const configuration = overrides => ({ origin: 'http://127.0.0.1:4173', apiConfigured: true,
  assetId: 'nep141:usdt.tether-token.near', tokenContract: 'usdt.tether-token.near', symbol: 'USDT',
  merchantAccount: 'market.near', fundingEnabled: true, staticDir: '/nonexistent',
  ownerTermsUrl: 'https://example.org/controlled-owner-terms', outlayerTermsUrl: 'https://app.outlayer.ai/terms', acceptanceVersion: 'agent-wallet-setup-v1', ...overrides });

// Real pinned SDK over a controlled HTTP boundary. No mainnet or paid calls.
export class AgentFixture {
  requests = []; generated = new Map(); operations = new Map(); agents = new Map(); balances = new Map();
  loseGenerateAck = false; loseSubmitAck = false; uncertain = false; wrongPolicy = false; wrongPreview = false;
  fetch = async (url, init) => {
    const path = new URL(url).pathname, query = new URL(url).searchParams;
    const body = init.body ? JSON.parse(init.body) : null, headers = new Headers(init.headers);
    assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit');
    assert.equal(headers.get('X-API-Key'), 'controlled-partner-key');
    assert.equal(headers.get('X-Grant-Token'), null);
    this.requests.push({ path, body, key: headers.get('Idempotency-Key') });
    let result;
    if (path === '/v1/network') result = { network: 'mainnet', supported_owner_types: ['near'] };
    else if (path === '/v1/tokens') result = { data: [{ asset_id: 'nep141:usdt.tether-token.near', decimals: 6, symbol: 'USDT', blockchain: 'near' }] };
    else if (path === '/v1/generate-intent') {
      const key = headers.get('Idempotency-Key'); assert.ok(key);
      if (!this.generated.has(key)) {
        const agentId = body.agent_id ?? `agent_${randomUUID()}`;
        const agent = this.agents.get(agentId);
        const owner = body.owner ?? agent.owner;
        result = { correlation_id: `intent_${randomUUID()}`, type: body.type, status: 'PENDING_SIGNATURE', agent_id: agentId,
          expires_at: new Date(Date.now() + 290_000).toISOString(), signer: owner,
          intent: body.type === 'agent_create' ? { standard: 'nep366', payload: { receiverId: 'outlayer.near', actions: [
            { type: 'FunctionCall', params: { methodName: 'controlled_install_policy', args: { policy: body.policy }, gas: '30000000000000', deposit: '0' } },
          ] } } : { standard: 'nep413', payload: { message: JSON.stringify(body), recipient: 'api.agentsonintents.com', nonce: randomBytes(32).toString('base64') } },
          preview: { summary: body.type, ...(body.policy ? { policy: body.policy } : {}) } };
        this.generated.set(key, { result, body });
        this.operations.set(result.correlation_id, { correlation_id: result.correlation_id, type: body.type, agent_id: agentId,
          status: 'PENDING_SIGNATURE', failure_code: null, dispatch_committed_at: null, details: {} });
        if (body.type === 'agent_create') this.agents.set(agentId, { id: agentId, owner, status: 'PENDING', policy: body.policy, wallet: { near_account_id: `wallet-${this.agents.size}.near` } });
      }
      result = this.generated.get(key).result;
      if (this.wrongPreview && body.type === 'agent_create') result = { ...result, preview: { ...result.preview, policy: { ...body.policy, assets: 'any' } } };
      if (this.loseGenerateAck) { this.loseGenerateAck = false; throw new TypeError('controlled lost generate acknowledgment'); }
    } else if (path === '/v1/submit-intent') {
      const op = this.operations.get(body.correlation_id); assert.ok(op);
      op.status = this.uncertain ? 'UNCERTAIN' : 'SUCCESS';
      if (op.type === 'agent_create' && !this.uncertain) this.agents.get(op.agent_id).status = 'ACTIVE';
      result = op;
      if (this.loseSubmitAck) { this.loseSubmitAck = false; throw new TypeError('controlled lost submit acknowledgment'); }
    } else if (path === '/v1/status') result = this.operations.get(query.get('correlation_id'));
    else {
      const match = /^\/v1\/agents\/(agent_[0-9a-f-]+)(?:\/(policy|balances|grants|deposit))?$/.exec(path);
      assert.ok(match, path);
      const [, agentId, action] = match, agent = this.agents.get(agentId);
      assert.ok(agent);
      if (!action) result = agent;
      else if (action === 'policy') result = { status: 'APPLIED', provider_policy_synced: true,
        policy: this.wrongPolicy ? { ...agent.policy, destinations: { mode: 'any', list: [] } } : agent.policy };
      else if (action === 'balances') result = { balances: this.balances.get(agentId) ?? [] };
      else if (action === 'grants') result = { data: [...this.generated.values()].filter(g => g.body.type === 'grant_issue'
        && g.body.agent_id === agentId && this.operations.get(g.result.correlation_id).status === 'SUCCESS')
        .map(g => ({ grant_id: g.result.correlation_id, expires_at: g.body.expires_at, revoked_at: null,
          owner_message: { credential: g.body.credential } })) };
      else if (action === 'deposit') {
        const key = headers.get('Idempotency-Key'); assert.ok(key);
        if (!this.generated.has(key)) {
          const op = { correlation_id: `op_${randomUUID()}`, agent_id: agentId, type: 'deposit', status: 'PENDING_DEPOSIT',
            failure_code: null, details: { deposit_address: `deposit-${[...this.agents.keys()].indexOf(agentId)}.near`, memo: null, min_amount: body.amount,
              expires_at: new Date(Date.now() + 86_400_000).toISOString(), refund_to: agent.wallet.near_account_id } };
          this.operations.set(op.correlation_id, op); this.generated.set(key, { result: op, body });
        }
        result = this.generated.get(key).result;
      }
    }
    assert.ok(result, path);
    return Response.json(result);
  };
}
export function setup(overrides = {}) {
  const keys = ownerKeys();
  const fixture = new AgentFixture();
  const store = new Store(':memory:', randomBytes(32));
  const rpc = { fullAccess: async () => {}, fundingTransaction: async (owner, token, deposit, amount) => ({ signerId: owner.account_id,
    receiverId: token, actions: [{ type: 'FunctionCall', params: { methodName: 'ft_transfer', args: { receiver_id: deposit.deposit_address, amount }, gas: '30000000000000', deposit: '1' } }] }) };
  const config = configuration(overrides);
  const api = createAgentApi({ apiKey: 'controlled-partner-key', fetch: fixture.fetch });
  const onboarding = new Onboarding({ store, rpc, api, config });
  return { ...keys, fixture, store, rpc, api, config, onboarding };
}
export function allocationInput(count = 2, total = '0.300001') {
  return { requestId: randomUUID(), total, acceptance: 'agent-wallet-setup-v1', buyers: Array.from({ length: count }, (_, i) => ({ id: randomUUID(), number: i + 1 })) };
}
export async function authorize(env, plan) {
  for (let i = 0; i < plan.buyers.length * 2; i++) {
    const { signing } = await env.onboarding.prepare(env.owner, plan.id);
    assert.ok(signing);
    plan = await env.onboarding.submit(env.owner, plan.id, { buyerId: signing.buyerId, correlationId: signing.correlationId,
      ...(signing.intent.standard === 'nep413' ? { signature: env.sign(signing.intent.payload) } : { signedDelegate: 'controlled-delegate-not-a-real-signature' }) });
  }
  return plan;
}
