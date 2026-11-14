import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { Mppx } from 'mppx/server';
import { Challenge, Credential, Receipt } from 'mppx';
import { KeyPair } from 'near-api-js';
import { Store, Locks } from '../../../clients/buyer-gateway/src/store.mjs';
import { serverMethod } from '../method.mjs';
import { verifyAgentPaidCredential } from '../p3/native-verification.mjs';
import { NativeSender } from '../p3/native-sender.mjs';
import { BoundedNativeProvider, TestnetAcceptanceRpc } from '../p3/rpc-provider.mjs';
import { CloudAuthority } from './authority.mjs';
import { inspectStream, sdkClient } from '../../inference-comparison/near-bridge.mjs';
import { MODEL } from '../../inference-comparison/core.mjs';
import { METHOD, hash, requireThat } from '../contract.mjs';
import { verifyRefund, verifyBinding } from '../near.mjs';

const json = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); };
const authorized = (actual, expected) => typeof actual === 'string' && Buffer.byteLength(actual) === Buffer.byteLength(expected)
  && timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
async function read(req) {
  const parts = []; let n = 0;
  for await (const part of req) { n += part.length; requireThat(n <= 8192, 'request_too_large'); parts.push(part); }
  return new TextDecoder('utf8', { fatal: true }).decode(Buffer.concat(parts));
}
export async function startCloudMpp(config, { client, store, rpc, merchantSender, now = Date.now } = {}) {
  requireThat(config.network === 'testnet' && config.agentToken?.length >= 32 && config.secret?.length >= 32, 'private_testnet_configuration_required');
  store ??= new Store(config.storePath, Buffer.from(config.storageKey, 'hex'));
  rpc ??= new TestnetAcceptanceRpc(store);
  const key = KeyPair.fromString(config.merchantSecretKey);
  requireThat(key.getPublicKey().toString() === config.merchantPublicKey, 'merchant_key_mismatch');
  const { agentToken, secret, merchantSecretKey, storageKey, apiKey, storePath, ...policy } = config;
  const authority = new CloudAuthority({ store, config: policy, receiptKey: key, now });
  let providerVerified = false;
  async function readyProvider() {
    if (providerVerified) return;
    client ??= await sdkClient(apiKey);
    await client.verify(MODEL); providerVerified = true;
  }
  // Unpaid deployment verification precedes a NEW payable 402. An existing
  // payment/refund journal remains recoverable during provider outages.
  if (authority.orders().length === 0) await readyProvider();
  merchantSender ??= new NativeSender({ store, rpc, provider: new BoundedNativeProvider(rpc), accountId: config.merchant,
    secretKey: merchantSecretKey, maxTotalYocto: config.merchantTotalYocto, gasCapYocto: config.merchantGasReserveYocto,
    storagePriceYocto: config.storagePriceYocto });
  const method = serverMethod({ rpc, authority, verify: verifyAgentPaidCredential });
  const mpp = Mppx.create({ realm: config.realm, secretKey: secret, requiresAuth: true, methods: [method] });
  const locks = new Locks(), jobs = new Set(); let stopping = false, refundBusy = false;
  const paymentReceipt = proof => Receipt.serialize(Receipt.from({ method: METHOD, status: 'success',
    reference: proof.movementKey, timestamp: new Date(proof.paidAtMs).toISOString() }));
  async function refundTick() {
    if (stopping || refundBusy) return; refundBusy = true;
    try {
      for (const order of authority.orders()) {
        try {
          if (!order.payment && order.paymentCredential) {
            const proof = await verifyAgentPaidCredential({ credential: order.paymentCredential,
              expectedChallenge: await authority.loadChallenge(order.paymentCredential.challenge.id), rpc });
            await authority.consumeVerifiedPayment(proof);
          }
          authority.expireUnadmitted(order.id);
        } catch { /* Original hash remains pending; absence never proves zero principal. */ }
      }
      for (const order of authority.orders().filter(o => o.principal.W !== '0')) {
        try {
          const plan = authority.refundFor(order.id), original = await merchantSender.prepare(plan);
          let final = original;
          if (original.state === 'signed') final = await merchantSender.broadcast(plan.idempotencyKey);
          else if (original.state !== 'final') final = await merchantSender.reconcile(plan.idempotencyKey);
          const originalSend = { operationId: plan.operationId, idempotencyKey: plan.idempotencyKey, planHash: hash(plan), txHash: final.txHash };
          const proof = await verifyRefund({ plan, originalSend, txHash: final.txHash, publicKey: config.merchantPublicKey, rpc });
          authority.recordRefund(order.id, proof, final.proof.gasActualYocto);
        } catch (error) {
          store.transaction(() => { const latest = authority.get(order.id); authority.put({ ...latest, refundError: error.message }); });
        }
      }
    } finally { refundBusy = false; }
  }
  async function inference(id) {
    return locks.run(id, async () => {
      const current = authority.get(id);
      if (current.state === 'inference_pending' && current.provider.capturedResponse && current.provider.verification) {
        const raw = Buffer.from(current.provider.capturedResponse, 'base64');
        return authority.recordVerified(id, { raw, summary: inspectStream(raw), verification: current.provider.verification });
      }
      if (current.state !== 'paid') return current;
      try { await readyProvider(); }
      catch { authority.expireUnadmitted(id, 'provider_preflight_unavailable'); return authority.get(id); }
      const claimed = authority.claimInference(id);
      if (!claimed.claimed) return claimed.order;
      const order = claimed.order;
      try {
        const response = await client.fetch('https://cloud-api.near.ai/v1/chat/completions', {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(120000),
          headers: { 'content-type': 'application/json' }, body: JSON.stringify(order.provider.body),
        });
        requireThat(response.ok && response.headers.get('content-type')?.startsWith('text/event-stream'), 'original_provider_response_unavailable');
        let size = 0; const parts = [];
        for await (const part of response.body) { size += part.length; requireThat(size <= 1024 * 1024, 'provider_response_too_large'); parts.push(part); }
        const raw = Buffer.concat(parts);
        const first = raw.toString('utf8').split(/\r?\n/).find(line => line.startsWith('data:') && line.slice(5).trim().startsWith('{'));
        requireThat(first, 'provider_response_id_missing');
        const responseId = JSON.parse(first.slice(5)).id;
        requireThat(typeof responseId === 'string' && responseId.length <= 256, 'provider_response_id_missing');
        authority.capture(id, raw, responseId);
        const verification = await client.verifyResponse(responseId);
        requireThat(verification.signatureKind === 'provider_tee' && verification.id === responseId, 'provider_signature_required');
        authority.capture(id, raw, responseId, verification);
        const summary = inspectStream(raw);
        return authority.recordVerified(id, { raw, summary, verification });
      } catch (error) {
        authority.recordUnknown(id, error.message); return authority.get(id);
      }
    });
  }
  const server = http.createServer(async (req, res) => {
    const job = Promise.withResolvers(); jobs.add(job.promise);
    try {
      requireThat(!stopping, 'server_closing');
      requireThat(!req.headers.origin, 'browser_integration_not_enabled');
      if (req.method === 'GET' && req.url === '/healthz') return json(res, 200, { ready: true, scope: 'near-cloud-mpp-direct', network: 'testnet', realInference: true });
      requireThat(authorized(req.headers.authorization, 'Bearer ' + agentToken), 'unauthorized');
      const register = req.url.match(/^\/v1\/orders\/([a-f0-9]{64})\/payment$/);
      if (req.method === 'POST' && register) {
        const body = JSON.parse(await read(req)), credential = Credential.deserialize(body.credential);
        requireThat(credential.challenge.request.orderRef === register[1]
          && credential.payload.publicKey === config.agent.publicKey, 'original_payment_resource_required');
        verifyBinding(credential.challenge, credential.payload);
        await authority.journalPresentation(credential);
        return json(res, 202, { orderId: register[1], originalTxHash: credential.payload.txHash });
      }
      const status = req.url.match(/^\/v1\/orders\/([a-f0-9]{64})$/);
      if (req.method === 'GET' && status) {
        const order = authority.get(status[1]); requireThat(order, 'unknown_cloud_order');
        return json(res, 200, authority.view(order));
      }
      requireThat(req.method === 'POST' && req.url === '/v1/chat/completions', 'not_found');
      const raw = await read(req), order = authority.prepare(String(req.headers['idempotency-key'] ?? ''), raw);
      let receipt = order.paymentReceipt ?? (order.payment ? paymentReceipt(order.payment) : null);
      if (!order.payment) {
        if (req.headers['payment-authorization']) {
          const credential = Credential.deserialize(String(req.headers['payment-authorization']));
          requireThat(credential.challenge.request.orderRef === order.id, 'original_payment_resource_required');
          receipt = Receipt.serialize(await method.verify({ credential }));
          store.transaction(() => { const latest = authority.get(order.id); authority.put({ ...latest, paymentReceipt: receipt }); });
        } else {
        const request = new Request('http://127.0.0.1:' + server.address().port + req.url, { method: 'POST', headers: req.headers, body: raw });
        const result = await mpp[METHOD].charge({ ...order.request, expires: new Date(order.request.expiresAtMs).toISOString() })(request);
        if (result.status === 402) {
          authority.saveChallenge(Challenge.fromResponse(result.challenge));
          res.writeHead(402, Object.fromEntries(result.challenge.headers)); res.end(await result.challenge.text()); return;
        }
        const paid = result.withReceipt(Response.json({ paid: true }));
        receipt = paid.headers.get('payment-receipt');
        store.transaction(() => { const latest = authority.get(order.id); authority.put({ ...latest, paymentReceipt: receipt }); });
        }
      }
      const current = await inference(order.id);
      if (!current.response) return json(res, current.state === 'inference_pending' ? 503 : 409,
        { error: current.lastError ?? current.state, orderId: current.id, retry: 'read-original-order-only' });
      const headers = { 'content-type': 'text/event-stream', 'cache-control': 'no-store',
        'payment-receipt': receipt, 'x-order-id': current.id, 'x-settlement-state': current.state };
      res.writeHead(200, headers); res.end(Buffer.from(current.response, 'base64'));
      void refundTick();
    } catch (error) {
      const message = /^[a-z][a-z0-9_]+$/.test(error.message) ? error.message : 'original_operation_unknown';
      if (!res.headersSent) json(res, message === 'unauthorized' ? 401 : 503, { error: message }); else res.destroy();
    } finally { jobs.delete(job.promise); job.resolve(); }
  });
  await new Promise(resolve => server.listen(config.port ?? 0, '127.0.0.1', resolve));
  const timer = setInterval(() => void refundTick(), 2000);
  return { url: 'http://127.0.0.1:' + server.address().port, authority, refundTick,
    async close() {
      stopping = true; clearInterval(timer); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
      await Promise.allSettled([...jobs]);
      while (refundBusy) await new Promise(resolve => setTimeout(resolve, 50));
      store.close();
    } };
}
