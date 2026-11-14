// Explicit real TESTNET payment-protocol acceptance. No inference, Market
// crediting, mainnet RPC, Intents, wallet API or provider credentials exist here.
import http from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { KeyPair, KeyPairSigner } from 'near-api-js';
import { Challenge, Credential } from 'mppx';
import { Mppx as Server } from 'mppx/server';
import { Mppx as Client } from 'mppx/client';
import { Store } from '../../../clients/buyer-gateway/src/store.mjs';
import { NativeSender } from './native-sender.mjs';
import { BoundedNativeProvider, TestnetAcceptanceRpc } from './rpc-provider.mjs';
import { verifyAgentPaidCredential } from './native-verification.mjs';
import { verifyRefund } from '../near.mjs';
import { deliveredResponse, originalRefundPlan } from './testnet-settlement.mjs';
import { clientMethod, serverMethod } from '../method.mjs';
import { METHOD, hash, requireThat, nativePlan, signedPayload, meterSettlement, checkConservation } from '../contract.mjs';

// Official near-cli-rs testnet default; historical key queries remain available.
const RPC = 'https://archival-rpc.testnet.fastnear.com';
const REALM = 'mpp-testnet.bitrouter.ai';
export async function runTestnetMpp(directory, caseId = 'initial', { interruptAfterPayment = false } = {}) {
  requireThat(/^[a-zA-Z0-9_-]{1,64}$/.test(caseId), 'invalid_testnet_case_id');
  const wallets = Object.fromEntries(['merchant', 'agent-1', 'agent-2'].map(role => {
    const wallet = JSON.parse(readFileSync(join(directory, role + '.json'), 'utf8'));
    requireThat(wallet.network === 'testnet' && wallet.role === role, 'testnet_credentials_required');
    const key = KeyPair.fromString(wallet.private_key);
    requireThat(key.getPublicKey().toString() === wallet.public_key
      && (wallet.account_id.endsWith('.testnet') || Buffer.from(key.getPublicKey().data).toString('hex') === wallet.account_id), 'dedicated_testnet_wallet_required');
    return [role, wallet];
  }));
  const store = new Store(join(directory, 'mpp-testnet.sqlite'), Buffer.from(readFileSync(join(directory, 'storage.key'), 'utf8').trim(), 'hex'));
  const rpc = new TestnetAcceptanceRpc(store), provider = new BoundedNativeProvider(rpc);
  requireThat((await rpc.call('status', [])).chain_id === 'testnet', 'testnet_required');
  for (const wallet of Object.values(wallets)) {
    const b = await rpc.call('query', { request_type: 'view_account', account_id: wallet.account_id, finality: 'final' });
    requireThat(BigInt(b.amount) >= 10n ** 22n, 'testnet_wallet_unfunded');
  }
  const sender = role => new NativeSender({ store, provider, rpc, accountId: wallets[role].account_id,
    secretKey: wallets[role].private_key, maxTotalYocto: '50000000000000000000000',
    gasCapYocto: '10000000000000000000000', storagePriceYocto: '10000000000000000000' });
  let secret = store.get('testnet-mpp-secret', 'original');
  if (!secret) { secret = randomBytes(32).toString('hex'); store.put('testnet-mpp-secret', 'original', 'testnet', secret); }
  const body = JSON.stringify({ model: 'testnet-payment-protocol-fixture', messages: [{ role: 'user', content: 'Verify payment protocol; do not invoke inference.' }] });
  const orderFor = role => hash(caseId === 'initial'
    ? ['testnet-mpp-v1', wallets[role].account_id, wallets.merchant.account_id, hash(body)]
    : ['testnet-mpp-v1', caseId, wallets[role].account_id, wallets.merchant.account_id, hash(body)]);
  const authority = {
    async loadChallenge(id) { return store.get('testnet-mpp-challenge', id); },
    async journalPresentation(c) {
      const order = store.get('testnet-mpp-order', c.challenge.request.orderRef);
      requireThat(order && hash(order.request) === hash(c.challenge.request), 'original_testnet_order_required');
      store.put('testnet-mpp-presentation', hash(c), 'testnet', c);
    },
    async consumeVerifiedPayment(proof) {
      return store.transaction(() => {
        const original = store.get('testnet-mpp-movement', hash(proof.movementKey));
        requireThat(!original || original.orderRef === proof.orderRef, 'movement_already_consumed');
        const order = store.get('testnet-mpp-order', proof.orderRef);
        requireThat(order && proof.amount === order.request.amount && proof.payer === order.request.payer, 'testnet_payment_binding_mismatch');
        requireThat(!order.proof || order.proof.movementKey === proof.movementKey, 'original_payment_already_bound');
        store.put('testnet-mpp-movement', hash(proof.movementKey), 'testnet', proof);
        store.put('testnet-mpp-order', proof.orderRef, 'testnet', { ...order, proof });
        // This test-only authority projects protocol payment, never Market cash.
        return { committed: true, projectionReady: !proof.late && order.settlementKind !== 'abandoned' && !order.cleanup, orderRef: proof.orderRef };
      });
    },
  };
  const mpp = Server.create({ realm: REALM, secretKey: secret, credentialHeader: 'Payment-Authorization',
    methods: [serverMethod({ rpc, authority, verify: verifyAgentPaidCredential })] });
  const server = http.createServer(async (req, res) => {
    try {
      requireThat(req.method === 'POST' && req.url === '/v1/chat/completions', 'not_found');
      const role = req.headers['x-test-agent']; requireThat(['agent-1', 'agent-2'].includes(role), 'unknown_test_agent');
      let raw = ''; for await (const chunk of req) { raw += chunk; requireThat(raw.length <= 8192, 'body_too_large'); }
      requireThat(raw === body, 'original_body_required');
      const orderRef = orderFor(role);
      let order = store.get('testnet-mpp-order', orderRef);
      if (!order) {
        const now = Date.now();
        const request = { version: 1, network: 'testnet', currency: 'NEAR', decimals: 24, amount: '1000000000000000000000',
          payer: wallets[role].account_id, recipient: wallets.merchant.account_id, refundTo: wallets[role].account_id,
          bindingVersion: 'testnet-ordinary-v1', orderRef, termsHash: hash(['protocol-fixture-not-inference', body]), nativeRequestHash: hash(body),
          nonce: randomBytes(32).toString('base64'), issuedAtMs: now, expiresAtMs: now + (interruptAfterPayment ? 15000 : 120000), signingRecipient: REALM };
        order = { role, caseId, request }; store.put('testnet-mpp-order', orderRef, 'testnet', order);
      }
      requireThat(order.settlementKind !== 'abandoned' && !order.cleanup, 'testnet_order_already_abandoned');
      let response;
      if (order.response) response = new Response(order.response.body, { status: 200, headers: order.response.headers });
      else {
        const request = new Request('http://127.0.0.1:' + server.address().port + req.url, { method: 'POST', headers: req.headers, body: raw });
        const charged = await mpp[METHOD].charge({ ...order.request, expires: new Date(order.request.expiresAtMs).toISOString() })(request);
        if (charged.status === 402) {
          const challenge = Challenge.fromResponse(charged.challenge);
          const prior = await authority.loadChallenge(challenge.id);
          requireThat(!prior || hash(prior) === hash(challenge), 'original_challenge_conflict');
          store.put('testnet-mpp-challenge', challenge.id, 'testnet', challenge);
          response = charged.challenge;
        } else {
          requireThat(!interruptAfterPayment, 'testnet_fault_after_verified_payment');
          response = charged.withReceipt(Response.json({ scope: 'testnet-mpp-payment-protocol-only', realInference: false, orderRef }));
          const frozen = { body: await response.clone().text(), headers: Object.fromEntries(response.headers) };
          deliveredResponse(store, orderRef, frozen);
        }
      }
      res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(await response.text());
    } catch (e) { res.writeHead(503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const evidence = { version: 1, caseId, scope: 'real-testnet-mpp-payment-protocol', network: 'testnet', rpc: RPC,
    actualInference: false, meteringSource: 'deterministic-protocol-fixture', moneyAuthority: 'test-only-sqlite-not-Market-cash',
    nativeBody: body, mainnetTransactions: 0, agents: [] };
  try {
    for (const role of ['agent-1', 'agent-2']) {
      const wallet = wallets[role], payer = sender(role); let challenges = 0;
      const client = Client.create({ polyfill: false, methods: [clientMethod({ recoverPayment: async challenge => {
        challenges++;
        nativePlan(challenge, { payer: wallet.account_id, refundTo: wallet.account_id, version: 'testnet-ordinary-v1', network: 'testnet',
          agentId: role, merchant: wallets.merchant.account_id, signingRecipient: REALM });
        requireThat(challenge.request.orderRef === orderFor(role) && challenge.request.nativeRequestHash === hash(body)
          && challenge.request.amount === '1000000000000000000000', 'unreviewed_testnet_payment');
        const existing = store.get('testnet-mpp-credential', challenge.request.orderRef);
        if (existing) return Credential.deserialize(existing);
        requireThat(store.get('testnet-mpp-order', challenge.request.orderRef)?.settlementKind !== 'abandoned', 'testnet_order_already_abandoned');
        const plan = { network: 'testnet', asset: 'native:NEAR', sender: wallet.account_id, recipient: wallets.merchant.account_id,
          amount: challenge.request.amount, orderRef: challenge.request.orderRef, operationId: 'payment-' + challenge.request.orderRef,
          idempotencyKey: 'near-pay-v1-' + challenge.request.orderRef, createdAtMs: challenge.request.issuedAtMs };
        const original = await payer.prepare(plan);
        if (original.state !== 'final') {
          requireThat(store.get('testnet-mpp-order', challenge.request.orderRef)?.settlementKind !== 'abandoned', 'testnet_order_already_abandoned');
          try { await payer.reconcile(plan.idempotencyKey); } catch { await payer.broadcast(plan.idempotencyKey); }
        }
        const payload = signedPayload(challenge, original.txHash);
        const signed = await new KeyPairSigner(KeyPair.fromString(wallet.private_key)).signNep413Message(wallet.account_id,
          { ...payload, nonce: Buffer.from(payload.nonce, 'base64') });
        const credential = { challenge, payload: { txHash: original.txHash, publicKey: wallet.public_key, signature: Buffer.from(signed.signature).toString('base64') } };
        const serialized = Credential.serialize(credential);
        store.put('testnet-mpp-credential', challenge.request.orderRef, 'testnet', serialized); return credential;
      } })] });
      const url = 'http://127.0.0.1:' + server.address().port + '/v1/chat/completions';
      const invoke = () => client.fetch(url, { method: 'POST', signal: AbortSignal.timeout(90000), headers: { 'content-type': 'application/json', 'x-test-agent': role }, body });
      const response = await invoke();
      requireThat(response.ok && response.headers.get('payment-receipt'), 'testnet_mpp_payment_failed_' + response.status);
      const result = await response.json();
      requireThat(result.scope === 'testnet-mpp-payment-protocol-only' && result.realInference === false, 'wrong_testnet_protocol_result');
      const replay = await invoke(); requireThat(replay.ok && replay.headers.get('payment-receipt'), 'testnet_mpp_replay_failed');
      requireThat(hash(await replay.json()) === hash(result), 'original_protocol_response_mismatch');
      const order = store.get('testnet-mpp-order', orderFor(role));
      requireThat(order.proof && !order.proof.late, 'testnet_original_payment_not_admitted');
      // Adopt a cached response written by the earlier protocol-only harness.
      deliveredResponse(store, orderFor(role), order.response);
      const originalCredential = Credential.deserialize(store.get('testnet-mpp-credential', orderFor(role)));
      const method = serverMethod({ rpc, authority, verify: verifyAgentPaidCredential });
      await method.verify({ credential: originalCredential });
      await method.verify({ credential: originalCredential });
      const principal = meterSettlement({ principalYocto: order.request.amount, actualServiceNano: '400000', serviceMaximumNano: '1000000', nanoUsdPerNear: '1000000000' });
      const id = 'refund-' + orderFor(role);
      const plan = originalRefundPlan(store, orderFor(role), { kind: 'delivered', amount: principal.W, createdAtMs: Date.now() });
      const merchant = sender('merchant'), original = await merchant.prepare(plan);
      if (original.state !== 'final') { try { await merchant.reconcile(plan.idempotencyKey); } catch { await merchant.broadcast(plan.idempotencyKey); } }
      const final = merchant.get(plan.idempotencyKey), originalSend = { operationId: id, idempotencyKey: plan.idempotencyKey, planHash: hash(plan), txHash: final.txHash };
      const refund = await verifyRefund({ plan, originalSend, txHash: final.txHash, publicKey: wallets.merchant.public_key, rpc });
      const settled = { ...principal, W: '0', R: principal.W }; checkConservation(settled);
      evidence.agents.push({ role, payer: wallet.account_id, merchant: wallets.merchant.account_id, payment: order.proof,
        refund: { ...refund, gasActualYocto: final.proof.gasActualYocto, gasPayer: wallets.merchant.account_id }, principal: settled,
        challengesThisRun: challenges, mppReceipt: response.headers.get('payment-receipt'), replaySameOrder: true,
        credential: Credential.serialize(originalCredential),
        original402ChallengePersisted: !!await authority.loadChallenge(originalCredential.challenge.id),
        credentialVerifiedTwice: true,
        originalPaymentCount: store.list('native-signed-send', payer.scope).filter(r => r.plan.orderRef === orderFor(role)).length });
      writeFileSync(join(directory, 'mpp-testnet-' + caseId + '-evidence.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
      console.log(JSON.stringify({ role, paymentTxHash: order.proof.txHash, refundTxHash: refund.txHash, principal: settled }));
    }
    return evidence;
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runTestnetMpp(process.argv[2], process.argv[3], { interruptAfterPayment: process.argv[4] === '--interrupt-after-payment' });
}
