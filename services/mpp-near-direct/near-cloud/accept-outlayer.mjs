// Explicit, bounded testnet acceptance. No browser, Chutes, or mainnet route.
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { KeyPair, KeyPairSigner, createTransaction, actions, baseDecode, baseEncode, SignedTransaction } from 'near-api-js';
import { Challenge, Credential } from 'mppx';
import { Store } from '../../../clients/buyer-gateway/src/store.mjs';
import { OutLayer, FileCredentials, publicKey, paymentPolicy, contractView, verifyPolicy } from '../p3/outlayer.mjs';
import { BoundedNativeProvider, TestnetAcceptanceRpc } from '../p3/rpc-provider.mjs';
import { sdkClient, inspectStream } from '../../inference-comparison/near-bridge.mjs';
import { freezeNearTariff, MODEL } from '../../inference-comparison/core.mjs';
import { startCloudMpp } from './server.mjs';
import { outlayerCloudBuyer } from './outlayer-client.mjs';
import { verifyReceipt } from './authority.mjs';
import { auditEvidence } from './verify-evidence.mjs';
import { hash, requireThat, uint, checkConservation, METHOD } from '../contract.mjs';

const GAS = '10000000000000000000000', FLOOR = GAS, STORAGE = '10000000000000000000';
const privateJson = file => {
  requireThat((statSync(file).mode & 0o077) === 0, 'private_credential_permissions_required');
  return JSON.parse(readFileSync(file, 'utf8'));
};
const write = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });

export async function acceptOutlayer({ directory, merchantFile, apiKeyFile }) {
  directory = resolve(directory); mkdirSync(directory, { recursive: true, mode: 0o700 });
  requireThat((statSync(directory).mode & 0o077) === 0, 'private_acceptance_directory_required');
  const lockPath = join(directory, 'process.lock'), fd = openSync(lockPath, 'wx', 0o600);
  writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: Date.now() })); closeSync(fd);
  let store, app;
  try {
    const merchant = privateJson(merchantFile);
    requireThat(merchant.network === 'testnet', 'testnet_merchant_required');
    requireThat((statSync(apiKeyFile).mode & 0o077) === 0, 'private_provider_key_required');
    const storageFile = join(directory, 'storage.key');
    if (!existsSync(storageFile)) writeFileSync(storageFile, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
    const storageKey = readFileSync(storageFile, 'utf8').trim();
    store = new Store(join(directory, 'journal.sqlite'), Buffer.from(storageKey, 'hex'));
    const rpc = new TestnetAcceptanceRpc(store), provider = new BoundedNativeProvider(rpc);
    const credentials = new FileCredentials(join(directory, 'wallets'));
    const api = new OutLayer({ network: 'testnet', credentials });
    const key = KeyPair.fromString(merchant.private_key);
    requireThat(key.getPublicKey().toString() === merchant.public_key, 'merchant_key_mismatch');
    const runFile = join(directory, 'run.json'); let run;
    if (existsSync(runFile)) run = privateJson(runFile);
    else {
      const catalog = await fetch('https://cloud-api.near.ai/v1/model/list', { redirect: 'error', signal: AbortSignal.timeout(15000) });
      requireThat(catalog.ok, 'cloud_catalog_unavailable');
      run = { version: 1, network: 'testnet', merchant: merchant.account_id, merchantPublicKey: merchant.public_key,
        realm: 'outlayer-cloud-mpp.bitrouter.ai', tariff: freezeNearTariff(await catalog.json(), { validForMs: 3600000 }),
        request: { messages: [{ role: 'user', content: 'Reply with a single character: 4.' }], temperature: 0, max_completion_tokens: 128 },
        maximumProjectMicroUsd: '10000', maximumProviderCalls: 2,
        fx: { kind: 'testnet-accounting-convention', nanoUsdPerNear: '1000000000', note: 'One test NEAR represents one USD; not market FX.' },
        agents: [{ id: 'agent-a', fundingYocto: '50000000000000000000000', totalYocto: '20000000000000000000000' },
          { id: 'agent-b', fundingYocto: '60000000000000000000000', totalYocto: '30000000000000000000000' }],
        secret: randomBytes(32).toString('hex'), agentToken: randomBytes(32).toString('hex') };
      write(runFile, run);
    }
    requireThat(run.network === 'testnet' && run.merchant === merchant.account_id && run.merchantPublicKey === merchant.public_key
      && run.maximumProjectMicroUsd === '10000' && run.maximumProviderCalls === 2, 'original_testnet_run_required');
    // Local owner signs policy/funding transactions, never the agent's key.
    // Exact signed bytes are persisted before the first and only broadcast.
    async function ownerSend(id, receiver, action, description) {
      let record = store.get('outlayer-owner-send', id, 'owner');
      if (record) requireThat(hash(record.description) === hash(description), 'original_owner_action_conflict');
      if (!record) {
        const all = store.list('outlayer-owner-send', 'owner');
        requireThat(all.every(r => r.state === 'final'), 'original_owner_transaction_pending');
        requireThat(all.reduce((n, r) => n + uint(r.deposit) + uint(r.gasActualYocto), 0n)
          + uint(description.deposit ?? '0') + uint(GAS) <= 300000000000000000000000n, 'owner_setup_budget_exhausted');
        const access = await provider.viewAccessKey({ accountId: merchant.account_id, publicKey: merchant.public_key, finalityQuery: { finality: 'final' } });
        requireThat(access.permission === 'FullAccess', 'owner_full_access_required');
        const highest = all.reduce((n, r) => BigInt(r.nonce) > n ? BigInt(r.nonce) : n, BigInt(access.nonce));
        const tx = createTransaction(merchant.account_id, key.getPublicKey(), receiver, highest + 1n, [action], baseDecode(access.block_hash));
        const signed = await new KeyPairSigner(key).signTransaction(tx);
        record = { id, description, receiver, deposit: description.deposit ?? '0', nonce: String(highest + 1n), state: 'signed',
          txHash: baseEncode(signed.txHash), bytes: Buffer.from(signed.signedTransaction.encode()).toString('base64') };
        store.transaction(() => store.put('outlayer-owner-send', id, 'owner', record));
      }
      if (record.state === 'final') return record;
      if (record.state === 'signed') {
        record = { ...record, state: 'unknown' }; store.transaction(() => store.put('outlayer-owner-send', id, 'owner', record));
        try { await provider.sendTransactionUntil(SignedTransaction.decode(Buffer.from(record.bytes, 'base64')), 'FINAL'); }
        catch { /* Reconcile only this hash. Never create a replacement. */ }
      }
      const tx = await rpc.transaction(record.txHash, merchant.account_id);
      requireThat(tx.final_execution_status === 'FINAL' && typeof tx.status?.SuccessValue === 'string'
        && tx.transaction.hash === record.txHash && tx.transaction.signer_id === merchant.account_id
        && tx.transaction.receiver_id === receiver && tx.transaction.public_key === merchant.public_key, 'owner_original_action_not_final');
      const gasActualYocto = String([tx.transaction_outcome, ...tx.receipts_outcome].reduce((n, r) => n + uint(r.outcome.tokens_burnt), 0n));
      requireThat(uint(gasActualYocto) <= uint(GAS), 'owner_gas_overrun_stop');
      record = { ...record, state: 'final', gasActualYocto };
      store.transaction(() => store.put('outlayer-owner-send', id, 'owner', record)); return record;
    }
    const readPolicy = binding => contractView(rpc, 'outlayer.testnet', 'get_wallet_policy', { wallet_pubkey: 'ed25519:' + binding.payer });
    async function freeze(binding, id) {
      const args = { wallet_pubkey: 'ed25519:' + binding.payer };
      const sent = await ownerSend(id, 'outlayer.testnet', actions.functionCall('freeze_wallet', args, 30000000000000n, 0n),
        { method: 'freeze_wallet', args, deposit: '0' });
      const policy = await readPolicy(binding); requireThat(policy.owner === merchant.account_id && policy.frozen, 'freeze_readback_required');
      return sent.txHash;
    }
    for (const agent of run.agents) {
      let binding = store.get('outlayer-agent-binding', agent.id, 'run');
      if (!binding) {
        const reg = store.get('outlayer-register', agent.id, 'run');
        requireThat(!reg, 'unfunded_registration_ack_unknown');
        store.transaction(() => store.put('outlayer-register', agent.id, 'run', { possiblySent: true }));
        const registered = await api.register();
        await credentials.put(agent.id, { walletId: registered.wallet_id, apiKey: registered.api_key });
        binding = { agentId: agent.id, walletId: registered.wallet_id, credentialRef: agent.id, payer: registered.near_account_id,
          refundTo: registered.near_account_id, publicKey: publicKey('ed25519:' + registered.near_account_id).base58,
          network: 'testnet', version: 'outlayer-cloud-v1-' + agent.id, merchant: merchant.account_id, signingRecipient: run.realm };
        await api.identity(binding);
        store.transaction(() => store.put('outlayer-agent-binding', agent.id, 'run', binding));
      }
      if (!binding.policy) {
        let install = store.get('outlayer-policy-install', agent.id, 'run');
        if (!install) {
          requireThat((await readPolicy(binding)) === null, 'unexpected_existing_controller');
          const policy = paymentPolicy({ merchant: merchant.account_id, realm: run.realm, maximumYocto: '1000000000000000000000' });
          const encrypted = await api.encrypt(binding, policy), signed = await api.signPolicy(binding, encrypted.encrypted_base64, merchant.account_id);
          requireThat(publicKey('ed25519:' + signed.public_key_hex).base58 === binding.publicKey && signed.version === 1
            && signed.locked === false && signed.policy_hash === encrypted.policy_hash, 'policy_signature_binding_mismatch');
          const args = { wallet_pubkey: 'ed25519:' + signed.public_key_hex, encrypted_data: encrypted.encrypted_base64,
            wallet_signature: signed.signature_hex, version: signed.version, locked: false, valid_until: signed.valid_until, storage_refund_to: null };
          const deposit = await contractView(rpc, 'outlayer.testnet', 'estimate_wallet_policy_cost',
            { wallet_pubkey: args.wallet_pubkey, encrypted_data: args.encrypted_data, storage_refund_to: null });
          requireThat(uint(deposit) < 50000000000000000000000n, 'bounded_policy_deposit_required');
          install = { args, deposit, policy }; store.transaction(() => store.put('outlayer-policy-install', agent.id, 'run', install));
        }
        const sent = await ownerSend('policy-' + agent.id, 'outlayer.testnet', actions.functionCall('store_wallet_policy', install.args, 30000000000000n, uint(install.deposit)),
          { method: 'store_wallet_policy', args: install.args, deposit: install.deposit });
        binding = { ...binding, policy: { controller: merchant.account_id, version: 1, encryptedHash: hash(install.args.encrypted_data) }, policyTxHash: sent.txHash };
        await verifyPolicy({ binding, rpc, api });
        const displayed = await api.request(agent.id, '/wallet/v1/policy');
        requireThat(hash(displayed.rules) === hash(install.policy.rules) && hash(displayed.capabilities) === hash(install.policy.capabilities)
          && displayed.approval == null && !displayed.frozen, 'policy_plaintext_readback_mismatch');
        store.transaction(() => store.put('outlayer-agent-binding', agent.id, 'run', binding));
      }
      if (!store.get('outlayer-funded', agent.id, 'run')) {
        await verifyPolicy({ binding, rpc, api }); // policy BEFORE funding
        const funded = await ownerSend('fund-' + agent.id, binding.payer, actions.transfer(uint(agent.fundingYocto)),
          { transfer: binding.payer, deposit: agent.fundingYocto });
        store.transaction(() => store.put('outlayer-funded', agent.id, 'run', { txHash: funded.txHash }));
      }
    }
    const bindings = run.agents.map(a => store.get('outlayer-agent-binding', a.id, 'run'));
    requireThat(new Set(bindings.map(b => b.payer)).size === 2 && new Set(bindings.map(b => b.walletId)).size === 2, 'independent_agent_wallets_required');
    console.log(JSON.stringify({ phase: 'outlayer_setup_passed', agents: bindings.map(b => ({ id: b.agentId, payer: b.payer })), maximumProviderCalls: 2, maximumUpstreamUsd: '0.01' }));
    const sdk = await sdkClient(readFileSync(apiKeyFile, 'utf8').trim()); let callsThisProcess = 0;
    for (let index = 0; index < 2; index++) {
      const agent = run.agents[index], binding = bindings[index];
      if (index === 1) requireThat((await readPolicy(bindings[0])).frozen === true, 'agent_a_must_remain_frozen');
      const config = { namespace: 'outlayer-cloud-' + agent.id, network: 'testnet', realm: run.realm, agentToken: run.agentToken, secret: run.secret,
        agent: { accountId: binding.payer, publicKey: binding.publicKey, bindingVersion: binding.version },
        merchant: merchant.account_id, merchantPublicKey: merchant.public_key, merchantSecretKey: merchant.private_key,
        request: run.request, tariff: run.tariff, qualifiedInputTokens: 8192, upstreamBudgetMicro: '5000', fx: run.fx,
        agentGasReserveYocto: GAS, merchantGasReserveYocto: GAS, merchantTotalYocto: '100000000000000000000000', storagePriceYocto: STORAGE };
      const observed = { verify: m => sdk.verify(m), verifyResponse: id => sdk.verifyResponse(id), fetch: (...args) => {
        const native = JSON.parse(args[1].body), id = native.user;
        store.transaction(() => {
          requireThat(!store.get('outlayer-provider-dispatch', id, 'project'), 'original_provider_already_possibly_sent');
          const all = store.list('outlayer-provider-dispatch', 'project');
          requireThat(all.length < 2 && all.reduce((n, r) => n + uint(r.maximumMicro), 0n) + uint(app.authority.maximumMicro) <= 10000n, 'project_provider_allowance_exhausted');
          store.put('outlayer-provider-dispatch', id, 'project', { id, maximumMicro: app.authority.maximumMicro, attempts: 1, possiblySent: true });
        });
        callsThisProcess++; return sdk.fetch(...args);
      } };
      app = await startCloudMpp(config, { store, rpc, client: observed });
      const body = JSON.stringify({ ...run.request, model: MODEL, stream: true, stream_options: { include_usage: true } });
      const buyer = outlayerCloudBuyer({ url: app.url, token: run.agentToken, binding, api, store, rpc, body,
        limits: { totalYocto: agent.totalYocto, principalCapYocto: '1000000000000000000000', gasReserveYocto: GAS,
          gasFloorYocto: FLOOR, storagePriceYocto: STORAGE, nanoUsdPerNear: run.fx.nanoUsdPerNear },
        afterPaid: index === 0 ? async () => freeze(binding, 'freeze-a-after-payment') : undefined });
      for (const old of app.authority.orders().filter(o => o.state === 'quoted' && Date.now() >= o.request.expiresAtMs)) {
        const id = 'near-pay-v1-' + old.id, operation = await buyer.operations.get(id);
        requireThat(operation?.attempts === 0 && operation.state === 'prepared', 'original_expired_payment_requires_reconciliation');
        requireThat((await buyer.wallet.cancel(id)).knownUnsent, 'original_payment_not_known_unsent');
        app.authority.cancelUnsent(old.id, await buyer.operations.get(id));
      }
      const cancelled = app.authority.orders().filter(o => o.state === 'cancelled').length;
      const logicalKey = cancelled ? 'one-real-cloud-task-unsent-renewal-' + cancelled : 'one-real-cloud-task';
      const response = await buyer.invoke(logicalKey), raw = Buffer.from(await response.arrayBuffer());
      requireThat(response.ok, 'original_outlayer_cloud_request_not_delivered');
      const orderId = response.headers.get('x-order-id'), summary = inspectStream(raw);
      const answer = raw.toString('utf8').split(/\r?\n/).filter(line => line.startsWith('data:') && line.slice(5).trim().startsWith('{'))
        .flatMap(line => JSON.parse(line.slice(5)).choices ?? []).map(c => typeof c.delta?.content === 'string' ? c.delta.content : '').join('').trim();
      requireThat(answer === '4', 'cloud_task_answer_incorrect');
      requireThat(orderId && response.headers.get('payment-receipt'), 'mpp_receipt_required');
      const replay = await buyer.invoke(logicalKey);
      requireThat(replay.ok && hash(Buffer.from(await replay.arrayBuffer())) === hash(raw), 'original_result_replay_failed');
      let order;
      for (let n = 0; n < 120; n++) {
        await app.refundTick(); order = await buyer.status(orderId);
        if (order.refund && order.principal.W === '0') break;
        await new Promise(r => setTimeout(r, 1000));
      }
      requireThat(order?.state === 'refunded' && order.provider.verification.signatureKind === 'provider_tee', 'outlayer_cloud_refund_not_final');
      verifyReceipt(order.financialReceipt, merchant.public_key); verifyReceipt(order.refundReceipt, merchant.public_key); checkConservation(order.principal);
      const payment = await buyer.operations.get('near-pay-v1-' + orderId);
      requireThat(payment?.attempts === 1 && payment.state === 'final', 'one_original_outlayer_payment_required');
      const evidence = { version: 1, scope: 'outlayer-agent-real-cloud-mpp-testnet', network: 'testnet', model: MODEL,
        browserWalletIntegration: false, realInference: true, providerInvoiceVerified: false, requestHash: hash(body), usage: summary.usage,
        responseDigest: hash(raw), answer, taskCompleted: true, walletBinding: binding, agentBudgetYocto: agent.totalYocto, order,
        paymentCredential: Credential.serialize(payment.credential), mppReceipt: response.headers.get('payment-receipt'),
        paymentAttempts: payment.attempts, outlayerRequestId: payment.requestId, replaySameResponse: true,
        frozenBeforeInferenceAndRefund: index === 0, agentAStillFrozenDuringB: index === 1, mainnetTransactions: 0, chutesInvocations: 0 };
      const audit = await auditEvidence(evidence, rpc);
      write(join(directory, agent.id + '-evidence.json'), evidence); write(join(directory, agent.id + '-audit.json'), audit);
      writeFileSync(join(directory, agent.id + '-response.sse'), raw, { mode: 0o600 });
      if (index === 0 && !store.get('outlayer-frozen-purchase-check', agent.id, 'run')) {
        const original = payment.frozen.challenge, now = Date.now(), request = { ...original.request,
          orderRef: hash(['frozen-rejection', binding.payer]), issuedAtMs: now, expiresAtMs: now + 120000, nonce: randomBytes(32).toString('base64') };
        const challenge = Challenge.from({ realm: run.realm, secretKey: run.secret, method: METHOD, intent: 'charge', request, expires: new Date(request.expiresAtMs).toISOString() });
        const op = await buyer.wallet.prepare({ challenge, binding, gasReserveYocto: GAS, gasFloorYocto: FLOOR,
          nanoUsdPerNear: run.fx.nanoUsdPerNear, taskId: 'frozen-purchase-check', userId: agent.id });
        const denied = await buyer.wallet.recover(op.id);
        requireThat(denied.attempts === 0 && denied.lastError === 'wallet_policy_changed_or_frozen', 'frozen_agent_purchase_not_blocked');
        store.transaction(() => store.put('outlayer-frozen-purchase-check', agent.id, 'run', { passed: true, paymentPosts: 0, providerCalls: 0 }));
      }
      console.log(JSON.stringify({ phase: agent.id + '_passed', payment: order.payment.txHash, refund: order.refund.txHash,
        actualServiceMicroUsd: order.financialReceipt.document.actualServiceMicroUsd, usage: summary.usage, principal: order.principal }));
      await app.close(); app = null; store = new Store(join(directory, 'journal.sqlite'), Buffer.from(storageKey, 'hex')); rpc.store = store;
    }
    await freeze(bindings[1], 'freeze-b-cleanup');
    const dispatches = store.list('outlayer-provider-dispatch', 'project');
    const result = { version: 1, scope: 'two-outlayer-agents-real-cloud-mpp-testnet', passed: true, network: 'testnet',
      providerInvocationsThisProcess: callsThisProcess, totalProviderAttempts: dispatches.length,
      retainedMaximumProviderMicroUsd: String(dispatches.reduce((n, r) => n + uint(r.maximumMicro), 0n)), maximumUpstreamMicroUsd: '10000',
      twoIndependentWallets: true, agentAFrozenPurchaseBlocked: !!store.get('outlayer-frozen-purchase-check', 'agent-a', 'run')?.passed,
      bothAgentsFinallyFrozen: (await Promise.all(bindings.map(readPolicy))).every(p => p.frozen),
      browserWalletIntegration: false, marketAutobidderIntegration: false, chutesInvocations: 0, mainnetTransactions: 0,
      ownerControllerMode: 'local-testnet-merchant-key-via-cli', agentPrivateKeysInProject: false,
      cases: run.agents.map(a => JSON.parse(readFileSync(join(directory, a.id + '-audit.json'), 'utf8'))) };
    requireThat(result.bothAgentsFinallyFrozen && result.totalProviderAttempts === 2, 'acceptance_final_invariants_failed');
    write(join(directory, 'evidence.json'), result); console.log(JSON.stringify({ phase: 'passed', ...result }));
    return result;
  } finally {
    await app?.close(); if (!app) store?.close(); unlinkSync(lockPath);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  requireThat(process.argv[2] === '--execute-testnet' && process.argv.length === 6, 'usage_execute_testnet_directory_merchant_file_api_key_file');
  try { await acceptOutlayer({ directory: process.argv[3], merchantFile: process.argv[4], apiKeyFile: process.argv[5] }); }
  catch (error) { console.error(JSON.stringify({ phase: 'unresolved', error: /^[a-z][a-z0-9_]+$/.test(error.message) ? error.message : 'acceptance_failed_unknown' })); process.exitCode = 2; }
}
