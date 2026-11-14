import test from 'node:test';
import assert from 'node:assert/strict';
import { fundingPreflight } from '../preflight.mjs';
const document = { network: 'mainnet', wallets: ['merchant', 'agent-1', 'agent-2'].map((role, i) => ({ role, account: String(i + 1).repeat(64), fundNear: '0.01' })) };
test('funding preflight reads FINAL native balances only; incomplete evidence stays unverified', async () => {
  const calls = [], rpc = { network: 'mainnet', async call(method, params) {
    calls.push({ method, params });
    if (method === 'status') return { chain_id: 'mainnet' };
    assert.equal(params.finality, 'final');
    if (params.account_id === document.wallets[2].account) throw new Error('unavailable');
    return { amount: params.account_id === document.wallets[0].account ? '10000000000000000000000' : '1', block_hash: 'original-final-block' };
  } };
  const result = await fundingPreflight(document, rpc);
  assert.deepEqual(result.wallets.map(w => w.state), ['funded', 'below_plan', 'unverified']);
  assert.equal(result.wallets[2].balanceYocto, null); assert.equal(result.funded, false);
  assert.equal(result.realPayments, 0); assert.equal(result.providerInvocations, 0);
  assert.equal(calls.length, 4); assert.ok(calls.every(c => ['status', 'query'].includes(c.method)));
  await assert.rejects(fundingPreflight(document, { ...rpc, network: 'testnet' }), /invalid_funding_plan/);
});
