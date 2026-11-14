import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
import { Store } from '../../../clients/buyer-gateway/src/store.mjs';
import { sdkClient, inspectStream } from '../../inference-comparison/near-bridge.mjs';
import { freezeNearTariff, MODEL } from '../../inference-comparison/core.mjs';
import { TestnetAcceptanceRpc } from '../p3/rpc-provider.mjs';
import { startCloudMpp } from './server.mjs';
import { cloudBuyer } from './client.mjs';
import { verifyReceipt } from './authority.mjs';
import { requireThat, checkConservation, hash } from '../contract.mjs';

export async function accept({ walletDirectory, apiKeyFile, evidenceDirectory, retryAfterWaiver = false }) {
  mkdirSync(evidenceDirectory, { recursive: true, mode: 0o700 });
  for (const file of ['merchant.json', 'agent.json', 'storage.key'].map(name => join(walletDirectory, name)).concat(apiKeyFile))
    requireThat((statSync(file).mode & 0o077) === 0, 'private_credential_file_permissions_required');
  const merchant = JSON.parse(readFileSync(join(walletDirectory, 'merchant.json'), 'utf8'));
  const wallet = JSON.parse(readFileSync(join(walletDirectory, 'agent.json'), 'utf8'));
  requireThat(merchant.network === 'testnet' && wallet.network === 'testnet', 'dedicated_testnet_wallets_required');
  const key = Buffer.from(readFileSync(join(walletDirectory, 'storage.key'), 'utf8').trim(), 'hex');
  const configFile = join(evidenceDirectory, 'run.json'); let config;
  if (existsSync(configFile)) config = JSON.parse(readFileSync(configFile, 'utf8'));
  else {
    const r = await fetch('https://cloud-api.near.ai/v1/model/list', { redirect: 'error', signal: AbortSignal.timeout(15000) });
    requireThat(r.ok, 'cloud_catalog_unavailable'); const tariff = freezeNearTariff(await r.json(), { validForMs: 3600000 });
    config = { namespace: 'near-cloud-mpp-single-v1', realm: 'near-cloud-mpp.bitrouter.ai', network: 'testnet',
      agent: { accountId: wallet.account_id, publicKey: wallet.public_key, bindingVersion: 'near-cloud-testnet-v1' },
      merchant: merchant.account_id, merchantPublicKey: merchant.public_key,
      tariff, request: { messages: [{ role: 'user', content: 'Reply with a single character: 4.' }], temperature: 0, max_completion_tokens: 128 },
      qualifiedInputTokens: 8192, upstreamBudgetMicro: '10000',
      fx: { kind: 'testnet-accounting-convention', nanoUsdPerNear: '1000000000', note: 'One test NEAR represents one USD for protocol testing; this is not a market exchange rate.' },
      agentGasReserveYocto: '10000000000000000000000', merchantGasReserveYocto: '10000000000000000000000',
      merchantTotalYocto: '100000000000000000000000', storagePriceYocto: '10000000000000000000',
      agentToken: randomBytes(32).toString('hex'), secret: randomBytes(32).toString('hex') };
    writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  }
  const serverStore = new Store(join(evidenceDirectory, 'server.sqlite'), key), clientStore = new Store(join(evidenceDirectory, 'client.sqlite'), key);
  const rpc = new TestnetAcceptanceRpc(serverStore);
  for (const w of [merchant, wallet]) {
    const b = await rpc.call('query', { request_type: 'view_account', finality: 'final', account_id: w.account_id });
    requireThat(BigInt(b.amount) >= 10n ** 23n, 'testnet_wallet_unfunded');
  }
  const provider = await sdkClient(readFileSync(apiKeyFile, 'utf8').trim());
  let invocationsThisProcess = 0;
  const observedProvider = {
    verify: model => provider.verify(model),
    fetch: (...args) => { invocationsThisProcess++; return provider.fetch(...args); },
    verifyResponse: id => provider.verifyResponse(id),
  };
  const body = JSON.stringify({ ...config.request, model: MODEL, stream: true, stream_options: { include_usage: true } });
  let proxy, buyer;
  try {
    proxy = await startCloudMpp({ ...config, merchantSecretKey: merchant.private_key, storageKey: key.toString('hex') },
      { store: serverStore, rpc, client: observedProvider });
    buyer = cloudBuyer({ url: proxy.url, token: config.agentToken, wallet, store: clientStore, rpc,
      policy: { merchant: merchant.account_id, realm: config.realm, bindingVersion: config.agent.bindingVersion,
        totalYocto: '100000000000000000000000', principalCapYocto: '10000000000000000000000',
        gasReserveYocto: config.agentGasReserveYocto, storagePriceYocto: config.storagePriceYocto }, body });
    console.log(JSON.stringify({ phase: 'preflight_passed', model: MODEL, network: 'testnet', maximumUpstreamUsd: '0.01', requestHash: hash(body) }));
    const logicalKey = retryAfterWaiver ? 'single-real-cloud-retry-after-settled-waiver' : 'single-real-cloud-inference';
    const response = await buyer.invoke(logicalKey);
    const raw = Buffer.from(await response.arrayBuffer());
    if (!response.ok) {
      const order = proxy.authority.orders()[0];
      console.log(JSON.stringify({ phase: 'original_request_not_delivered', status: response.status,
        order: order ? proxy.authority.view(order) : null, response: raw.toString('utf8') }));
      throw new Error('original_cloud_operation_requires_reconciliation');
    }
    const orderId = response.headers.get('x-order-id'); requireThat(orderId && response.headers.get('payment-receipt'), 'mpp_receipt_required');
    const summary = inspectStream(raw);
    const replay = await buyer.invoke(logicalKey);
    requireThat(replay.ok && hash(Buffer.from(await replay.arrayBuffer())) === hash(raw), 'original_response_replay_failed');
    let order;
    for (let n = 0; n < 120; n++) {
      await proxy.refundTick(); order = await buyer.status(orderId);
      if (order.principal.W === '0' && order.principal.H === '0') break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    requireThat(order?.state === 'refunded' && order.refund && order.provider.verification.signatureKind === 'provider_tee', 'native_refund_not_final');
    verifyReceipt(order.financialReceipt, merchant.public_key); verifyReceipt(order.refundReceipt, merchant.public_key); checkConservation(order.principal);
    requireThat(order.financialReceipt.document.responseHash === hash(raw), 'receipt_response_binding_mismatch');
    const final = { version: 1, scope: 'real-near-ai-cloud-via-mpp-testnet', browserWalletIntegration: false,
      model: MODEL, network: 'testnet', realInference: true, simulatedMetering: false,
      serviceChargeBasis: 'verified-token-usage-at-frozen-cloud-tariff', providerInvoiceVerified: false,
      requestHash: hash(body), responseDigest: hash(raw), rawResponseSha256: createHash('sha256').update(raw).digest('hex'), usage: summary.usage, order,
      mppReceipt: response.headers.get('payment-receipt'), upstreamInvocationAttempts: order.provider.attempts,
      paymentCredential: clientStore.get('cloud-client-credential', orderId, wallet.account_id),
      replaySameResponse: true, agentPaymentCount: clientStore.list('native-signed-send', buyer.sender.scope).filter(r => r.plan.orderRef === orderId).length,
      totalProviderAttempts: proxy.authority.orders().reduce((n, o) => n + (o.provider?.attempts ?? 0), 0),
      providerInvocationsThisProcess: invocationsThisProcess,
      retainedUpstreamReserveMicro: String(proxy.authority.orders().reduce((n, o) => n + BigInt(o.terms.maximumMicro), 0n)),
      mainnetTransactions: 0, chutesInvocations: 0 };
    writeFileSync(join(evidenceDirectory, 'response.sse'), raw, { mode: 0o600 });
    writeFileSync(join(evidenceDirectory, 'evidence.json'), JSON.stringify(final, null, 2) + '\n', { mode: 0o600 });
    console.log(JSON.stringify({ phase: 'passed', paymentTxHash: order.payment.txHash, refundTxHash: order.refund.txHash,
      usage: summary.usage, actualServiceMicroUsd: order.financialReceipt.document.actualServiceMicroUsd, principal: order.principal }));
    return final;
  } finally { await proxy?.close(); clientStore.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [walletDirectory, apiKeyFile, evidenceDirectory] = process.argv.slice(2);
  requireThat(walletDirectory && apiKeyFile && evidenceDirectory, 'usage_wallet_directory_api_key_file_evidence_directory');
  await accept({ walletDirectory, apiKeyFile, evidenceDirectory, retryAfterWaiver: process.argv[5] === '--retry-after-waiver' });
}
