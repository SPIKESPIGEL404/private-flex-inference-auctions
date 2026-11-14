import test from 'node:test';
import assert from 'node:assert/strict';
import { formatAtomic, summarizeMoney } from '../src/money.ts';

const now = Date.parse('2026-11-14T18:00:00Z');
const buyers = [{ id: 'a', budgetMicros: 150000 }, { id: 'b', budgetMicros: 150000 }];
const owner = { account_id: 'alice.near', public_key: 'ed25519:owner' };
function wallet() {
  return { config: { configured: true, assetId: 'usdt', symbol: 'USDT' }, owner, allocations: [{
    ownerAccount: owner.account_id, ownerPublicKey: owner.public_key, assetId: 'usdt', symbol: 'USDT', totalRaw: '300000',
    buyers: buyers.map(b => ({ id: b.id, availableRaw: '149999', balanceObservedAt: new Date(now).toISOString() })),
  }] };
}
test('observed wallet funds and configured USD limits preserve exact amounts without inferring spend', () => {
  const result = summarizeMoney(wallet(), buyers, false, now);
  assert.equal(result.availableRaw, '299998'); assert.equal(result.taskBudgetMicros, '300000');
  assert.equal(result.plannedPrincipalRaw, '300000'); assert.equal(result.state, 'snapshot');
  assert.equal('spentRaw' in result, false);
  assert.equal(formatAtomic(result.availableRaw, 'USDT'), '0.299998 USDT');
  assert.equal(formatAtomic(result.taskBudgetMicros, 'USD'), '$0.30');
});
test('default zero is unknown until observed; an observed zero remains a valid zero', () => {
  const state = wallet();
  state.allocations[0].buyers = buyers.map(b => ({ id: b.id, availableRaw: '0' }));
  assert.equal(summarizeMoney(state, buyers, false, now).availableRaw, null);
  state.allocations[0].buyers.forEach(b => { b.balanceObservedAt = new Date(now).toISOString(); });
  assert.equal(summarizeMoney(state, buyers, false, now).availableRaw, '0');
  assert.equal(formatAtomic('0', 'USDT'), '0.00 USDT');
});
test('partial, duplicate, stale, malformed and future observations cannot create an aggregate', () => {
  for (const change of [
    s => { s.allocations[0].buyers.pop(); },
    s => { s.allocations[0].buyers[1].id = 'a'; },
    s => { s.allocations[0].buyers[0].balanceObservedAt = new Date(now - 120001).toISOString(); },
    s => { s.allocations[0].buyers[0].balanceObservedAt = new Date(now + 5001).toISOString(); },
    s => { s.allocations[0].buyers[0].availableRaw = 'NaN'; },
  ]) {
    const state = wallet(); change(state);
    assert.equal(summarizeMoney(state, buyers, false, now).availableRaw, null);
  }
});
test('owner, owner key, asset, configuration, preview and active buyer boundaries withhold prior funds', () => {
  for (const change of [
    s => { s.owner = null; },
    s => { s.owner = { ...owner, account_id: 'bob.near' }; },
    s => { s.owner = { ...owner, public_key: 'another key' }; },
    s => { s.config.assetId = 'usdc'; },
    s => { s.config.symbol = 'USDC'; },
    s => { s.config.configured = false; },
  ]) {
    const state = wallet(); change(state);
    assert.equal(summarizeMoney(state, buyers, false, now).availableRaw, null);
  }
  assert.equal(summarizeMoney(wallet(), buyers, true, now).availableRaw, null);
  assert.equal(summarizeMoney(wallet(), [{ id: 'another', budgetMicros: 1 }], false, now).availableRaw, null);
  assert.equal(summarizeMoney(wallet(), [], false, now).availableRaw, null);
});
test('large token balances never round through floating point; invalid limits are not added', () => {
  const state = wallet(); state.allocations[0].buyers[0].availableRaw = '999999999999999999999999';
  const result = summarizeMoney(state, buyers, false, now);
  assert.equal(result.availableRaw, '1000000000000000000149998');
  assert.equal(formatAtomic(result.availableRaw, 'USDT'), '1000000000000000000.149998 USDT');
  assert.equal(summarizeMoney(state, [{ id: 'a', budgetMicros: Number.MAX_SAFE_INTEGER + 1 }], false, now).taskBudgetMicros, null);
});
