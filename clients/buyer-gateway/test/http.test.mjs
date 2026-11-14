import test from 'node:test';
import assert from 'node:assert/strict';
import { createGateway } from '../src/server.mjs';
import { setup, allocationInput } from './support.mjs';

test('HTTP login, cookies, origin enforcement, owner isolation, logout, and procurement gate', async t => {
  const env = setup({ fundingEnabled: false }); t.after(() => env.store.close());
  const { server } = createGateway(env);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/buyer-api`;
  let jar = '';
  async function call(path, body, origin = env.config.origin) {
    const result = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: {
      ...(body === undefined ? {} : { origin, 'content-type': 'application/json' }), ...(jar ? { cookie: jar } : {}),
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    for (const cookie of result.headers.getSetCookie()) {
      const next = cookie.split(';')[0], name = next.split('=')[0];
      jar = [...jar.split('; ').filter(old => old && !old.startsWith(name + '=')), next].join('; ');
      assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/);
    }
    return { response: result, value: await result.json() };
  }
  assert.equal((await call('/session')).value.owner, null);
  assert.equal((await call('/allocations', allocationInput())).response.status, 401);
  assert.equal((await call('/auth/challenge', {}, 'https://attacker.example')).response.status, 403);
  const challenge = await call('/auth/challenge', {});
  const signed = { accountId: env.owner.account_id, publicKey: env.owner.public_key, signature: env.sign(challenge.value) };
  assert.equal((await call('/auth/verify', signed)).response.status, 200);
  assert.equal((await call('/auth/verify', signed)).response.status, 401);
  const input = allocationInput(1);
  const created = await call('/allocations', input);
  assert.equal(created.response.status, 200);
  const restored = await call('/session');
  assert.equal(restored.value.allocations[0].id, created.value.id);
  const forbidden = await call('/inference', { buyerId: input.buyers[0].id, ownerScope: 'bob.near:another-key' });
  assert.equal(forbidden.value.error, 'owner_session_changed');
  const inference = await call('/inference', { buyerId: input.buyers[0].id, ownerScope: `${env.owner.account_id}:${env.owner.public_key}` });
  assert.equal(inference.response.status, 503);
  assert.equal(inference.value.error, 'procurement_not_ready');
  assert.equal((await call(`/allocations/${created.value.id}/deposits`, {})).value.error, 'wallet_funding_disabled');
  assert.equal(env.fixture.requests.filter(request => request.path.includes('transfer')).length, 0);
  await call('/auth/logout', {});
  assert.equal((await call('/session')).value.owner, null);
  assert.ok(!JSON.stringify(restored.value).includes('controlled-partner-key'));
});
