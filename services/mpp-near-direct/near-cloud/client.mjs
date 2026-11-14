import { Mppx } from 'mppx/client';
import { Credential } from 'mppx';
import { KeyPair, KeyPairSigner } from 'near-api-js';
import { clientMethod } from '../method.mjs';
import { NativeSender } from '../p3/native-sender.mjs';
import { BoundedNativeProvider } from '../p3/rpc-provider.mjs';
import { nativePlan, signedPayload, hash, requireThat } from '../contract.mjs';

// Acceptance client owns its agent key. The proxy receives only public wallet
// binding, original signed order assignment and transaction hash, never the key.
export function cloudBuyer({ url, token, wallet, store, rpc, policy, body }) {
  const sender = new NativeSender({ store, rpc, provider: new BoundedNativeProvider(rpc), accountId: wallet.account_id,
    secretKey: wallet.private_key, maxTotalYocto: policy.totalYocto, gasCapYocto: policy.gasReserveYocto,
    storagePriceYocto: policy.storagePriceYocto });
  const headers = { authorization: 'Bearer ' + token, 'content-type': 'application/json' };
  const client = Mppx.create({ polyfill: false, methods: [clientMethod({ recoverPayment: async challenge => {
    const plan = nativePlan(challenge, { payer: wallet.account_id, refundTo: wallet.account_id,
      version: policy.bindingVersion, network: 'testnet', agentId: 'agent', merchant: policy.merchant, signingRecipient: policy.realm });
    requireThat(challenge.request.nativeRequestHash === hash(body) && BigInt(challenge.request.amount) <= BigInt(policy.principalCapYocto), 'unreviewed_cloud_payment');
    const transfer = { network: 'testnet', asset: 'native:NEAR', sender: wallet.account_id, recipient: plan.transfer.to,
      amount: plan.transfer.amount, orderRef: plan.orderRef, operationId: plan.idempotencyKey,
      idempotencyKey: plan.idempotencyKey, createdAtMs: challenge.request.issuedAtMs };
    const original = await sender.prepare(transfer);
    let serialized = store.get('cloud-client-credential', plan.orderRef, wallet.account_id);
    if (!serialized) {
      const payload = signedPayload(challenge, original.txHash);
      const signed = await new KeyPairSigner(KeyPair.fromString(wallet.private_key)).signNep413Message(wallet.account_id,
        { ...payload, nonce: Buffer.from(payload.nonce, 'base64') });
      serialized = Credential.serialize({ challenge, payload: { txHash: original.txHash, publicKey: wallet.public_key,
        signature: Buffer.from(signed.signature).toString('base64') } });
      store.put('cloud-client-credential', plan.orderRef, wallet.account_id, serialized);
    }
    const registered = await fetch(url + '/v1/orders/' + plan.orderRef + '/payment', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000), headers, body: JSON.stringify({ credential: serialized }),
    });
    requireThat(registered.ok, 'original_payment_registration_unknown');
    await registered.text();
    if (original.state === 'signed') await sender.broadcast(plan.idempotencyKey);
    else if (original.state !== 'final') await sender.reconcile(plan.idempotencyKey);
    return Credential.deserialize(serialized);
  } })] });
  return { sender,
    async invoke(key) {
      return client.fetch(url + '/v1/chat/completions', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(180000),
        headers: { ...headers, 'idempotency-key': key }, body });
    },
    async status(id) {
      const r = await fetch(url + '/v1/orders/' + id, { redirect: 'error', signal: AbortSignal.timeout(15000), headers });
      requireThat(r.ok, 'original_cloud_order_unavailable'); return r.json();
    },
  };
}
