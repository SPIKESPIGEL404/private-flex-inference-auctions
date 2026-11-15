import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { KeyPair } from 'near-api-js';
import { Store } from '../../../clients/buyer-gateway/src/store.mjs';
import { CloudAuthority } from './authority.mjs';
import { TestnetAcceptanceRpc, BoundedNativeProvider } from '../p3/rpc-provider.mjs';
import { NativeSender } from '../p3/native-sender.mjs';
import { verifyRefund } from '../near.mjs';
import { hash, requireThat } from '../contract.mjs';
const [walletDirectory, evidenceDirectory, orderId] = process.argv.slice(2);
requireThat(walletDirectory && evidenceDirectory && /^[a-f0-9]{64}$/.test(orderId), 'explicit_original_order_required');
const config = JSON.parse(readFileSync(join(evidenceDirectory, 'run.json')));
const merchant = JSON.parse(readFileSync(join(walletDirectory, 'merchant.json')));
const key = Buffer.from(readFileSync(join(walletDirectory, 'storage.key'), 'utf8').trim(), 'hex');
const store = new Store(join(evidenceDirectory, 'server.sqlite'), key), rpc = new TestnetAcceptanceRpc(store);
const { agentToken, secret, ...policy } = config;
const authority = new CloudAuthority({ store, config: policy, receiptKey: KeyPair.fromString(merchant.private_key) });
const sender = new NativeSender({ store, rpc, provider: new BoundedNativeProvider(rpc), accountId: config.merchant,
  secretKey: merchant.private_key, maxTotalYocto: config.merchantTotalYocto, gasCapYocto: config.merchantGasReserveYocto,
  storagePriceYocto: config.storagePriceYocto });
try {
  let order = authority.get(orderId); requireThat(order, 'unknown_cloud_order');
  if (!order.waiver) authority.waiveIntegrationFailure(orderId, 'integration_parser_rejected_unretained_response');
  const plan = authority.refundFor(orderId), original = await sender.prepare(plan);
  let final = original;
  if (original.state === 'signed') final = await sender.broadcast(plan.idempotencyKey);
  else if (original.state !== 'final') final = await sender.reconcile(plan.idempotencyKey);
  const originalSend = { operationId: plan.operationId, idempotencyKey: plan.idempotencyKey, planHash: hash(plan), txHash: final.txHash };
  const proof = await verifyRefund({ plan, originalSend, txHash: final.txHash, publicKey: config.merchantPublicKey, rpc });
  order = authority.recordRefund(orderId, proof, final.proof.gasActualYocto);
  writeFileSync(join(evidenceDirectory, 'original-waiver.json'), JSON.stringify(authority.view(order), null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify({ orderId, state: order.state, refundTxHash: proof.txHash, principal: order.principal,
    upstreamExpenseNotErased: order.waiver.retainedUpstreamReserveMicro }));
} finally { store.close(); }
