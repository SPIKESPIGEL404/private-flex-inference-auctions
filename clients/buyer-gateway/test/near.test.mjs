import test from 'node:test';
import assert from 'node:assert/strict';
import { NearRpc } from '../src/near.mjs';

test('token funding checks recipient storage and preserves the exact amount and memo', async () => {
  const calls = [];
  const rpc = new NearRpc('https://rpc.example', async (_, init) => {
    const request = JSON.parse(init.body); calls.push(request.params);
    const result = request.params.method_name === 'storage_balance_of' ? null : { min: '1250000000000000000000' };
    return Response.json({ result: { result: [...Buffer.from(JSON.stringify(result))] } });
  });
  const tx = await rpc.fundingTransaction({ account_id: 'alice.near' }, 'usdt.tether-token.near', { deposit_address: 'deposit.near', memo: 'opaque-route-memo' }, '150000');
  assert.equal(tx.signerId, 'alice.near');
  assert.equal(tx.receiverId, 'usdt.tether-token.near');
  assert.equal(tx.actions[0].params.methodName, 'storage_deposit');
  assert.equal(tx.actions[1].params.deposit, '1');
  assert.deepEqual(tx.actions[1].params.args, { receiver_id: 'deposit.near', amount: '150000', memo: 'opaque-route-memo' });
  assert.equal(calls.length, 2);
});

test('bad deposit addresses, function-call owner keys, and expensive storage are refused', async () => {
  const rpc = new NearRpc('https://rpc.example', async (_, init) => {
    const { params } = JSON.parse(init.body);
    if (params.request_type === 'view_access_key') return Response.json({ result: { permission: { FunctionCall: {} } } });
    return Response.json({ result: { result: [...Buffer.from(JSON.stringify(params.method_name === 'storage_balance_of' ? null : { min: '1000000000000000000000000' }))] } });
  });
  await assert.rejects(rpc.fullAccess('alice.near', 'ed25519:example'), { code: 'owner_key_not_full_access' });
  await assert.rejects(rpc.fundingTransaction({ account_id: 'alice.near' }, 'usdt.tether-token.near', { deposit_address: 'invalid/address' }, '1'), { code: 'unsupported_deposit_address' });
  await assert.rejects(rpc.fundingTransaction({ account_id: 'alice.near' }, 'usdt.tether-token.near', { deposit_address: 'deposit.near' }, '1'), { code: 'storage_cost_too_high' });
});
