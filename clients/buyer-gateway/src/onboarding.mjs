import { randomUUID, createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { createGrantCredential } from '@near-intents-agent-api/sdk';
import { check, GatewayError } from './errors.mjs';
import { Locks } from './store.mjs';
import { accountPattern, verifyMessage } from './near.mjs';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const terminal = new Set(['SUCCESS', 'FAILED', 'REFUNDED']);
const hash = value => createHash('sha256').update(value).digest('hex');
export function parseAmount(text) {
  check(typeof text === 'string' && /^(0|[1-9]\d{0,2})(\.\d{1,6})?$/.test(text), 'invalid_amount');
  const [whole, fraction = ''] = text.split('.');
  const value = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'));
  check(value > 0n && value <= 100_000_000n, 'amount_out_of_range');
  return value;
}
export const decimal = raw => `${BigInt(raw) / 1_000_000n}.${String(BigInt(raw) % 1_000_000n).padStart(6, '0')}`;

export function policyFor(owner, amount, config) {
  return { frozen: false, actions: ['transfer', 'withdraw'], confidential: true, owner_approval: false,
    assets: [config.assetId], limits: { per_transaction: { [config.assetId]: amount }, daily: { [config.assetId]: amount } },
    max_actions_per_hour: 60,
    destinations: { mode: 'only', list: [
      { action: 'transfer', address: config.merchantAccount, confidential: true },
      { action: 'withdraw', chain: 'near', address: owner.account_id, memo: null },
    ] },
    budget: { daily_usd: decimal(amount), weekly_usd: null, monthly_usd: null }, timelock_ms: 0 };
}

export class Onboarding {
  locks = new Locks();
  constructor({ store, api, rpc, config, now = Date.now }) { Object.assign(this, { store, api, rpc, config, now }); }
  configured() {
    check(this.config.apiConfigured && accountPattern.test(this.config.merchantAccount ?? '') && this.config.ownerTermsUrl, 'gateway_not_configured', 503);
  }
  async preflight() {
    const [network, tokens] = await Promise.all([this.api.getNetwork(), this.api.getTokens()]);
    check(network.network === 'mainnet' && network.supported_owner_types?.includes('near'), 'near_owner_unavailable', 503);
    check(tokens.some(token => token.asset_id === this.config.assetId && token.blockchain === 'near'
      && token.decimals === 6 && token.symbol === this.config.symbol), 'funding_asset_unavailable', 503);
  }
  buyerKey(owner, id) { return `${owner.account_id}/${id}`; }
  buyer(owner, id) { return this.store.get('buyer', this.buyerKey(owner, id), owner.account_id); }
  saveBuyer(buyer) { this.store.put('buyer', this.buyerKey(buyer.owner, buyer.id), buyer.owner.account_id, buyer); }
  plan(owner, id, signing = false) {
    const plan = this.store.get('allocation', id, owner.account_id);
    check(plan, 'allocation_not_found', 404);
    if (signing) check(plan.owner.public_key === owner.public_key, 'original_owner_key_required', 403);
    return plan;
  }
  list(owner) { return this.store.list('allocation', owner.account_id).map(plan => this.publicPlan(plan)); }
  publicPlan(plan) {
    const buyers = plan.buyerIds.map(id => {
      const buyer = this.buyer(plan.owner, id);
      const deposit = plan.deposits[id];
      const ready = buyer.active && buyer.grantActive && buyer.policyReady && BigInt(buyer.availableRaw ?? '0') > 0n;
      const phase = !buyer.active ? 'create_pending' : !buyer.grantActive ? 'grant_pending'
        : !buyer.policyReady ? 'policy_pending' : !ready ? 'funding_pending' : 'ready';
      const operation = !buyer.active ? buyer.create : !buyer.grantActive ? buyer.grant : null;
      return { id, number: buyer.number, agentId: buyer.agentId ?? null, wallet: buyer.wallet ?? null, phase,
        availableRaw: buyer.availableRaw ?? '0', grantExpiresAt: buyer.grantExpiresAt ?? null,
        operationStatus: operation?.status?.status ?? (operation?.generated ? 'PENDING_SIGNATURE' : null),
        failureCode: operation?.status?.failure_code ?? null,
        deposit: deposit?.result ? { correlationId: deposit.result.correlation_id, status: deposit.result.status,
          address: deposit.result.details?.deposit_address ?? null, memo: deposit.result.details?.memo ?? null,
          minAmount: deposit.result.details?.min_amount ?? null, expiresAt: deposit.result.details?.expires_at ?? null,
          refundTo: deposit.result.details?.refund_to ?? null, failureCode: deposit.result.failure_code ?? null } : null };
    });
    return { id: plan.id, ownerAccount: plan.owner.account_id, ownerPublicKey: plan.owner.public_key,
      createdAt: plan.createdAt, assetId: plan.assetId, symbol: this.config.symbol, totalRaw: plan.totalRaw,
      perAgentRaw: plan.perAgentRaw, remainderRaw: plan.remainderRaw, buyers,
      fundingAttempt: plan.fundingAttempt ? { status: plan.fundingAttempt.status, hashes: plan.fundingAttempt.hashes } : null,
      fundingEnabled: this.config.fundingEnabled, procurementReady: false,
      ready: buyers.every(buyer => buyer.phase === 'ready') };
  }
  async create(owner, input) {
    this.configured();
    return this.locks.run(owner.account_id, async () => {
      check(uuid.test(input?.requestId), 'invalid_request_id');
      const requestKey = `${owner.account_id}/${input.requestId}`;
      const previous = this.store.get('allocation-request', requestKey, owner.account_id);
      const bodyHash = hash(JSON.stringify(input));
      if (previous) {
        check(previous.bodyHash === bodyHash, 'allocation_conflict', 409);
        return this.publicPlan(this.plan(owner, previous.id, true));
      }
      const ids = input.buyers;
      check(input.acceptance === this.config.acceptanceVersion, 'owner_acceptance_required', 400);
      check(Array.isArray(ids) && ids.length >= 1 && ids.length <= 8
        && ids.every(b => b && uuid.test(b.id) && Number.isInteger(b.number) && b.number >= 1 && b.number <= 1000)
        && new Set(ids.map(b => b.id)).size === ids.length && new Set(ids.map(b => b.number)).size === ids.length, 'invalid_buyers');
      const total = parseAmount(input.total), amount = total / BigInt(ids.length);
      check(amount > 0n, 'allocation_too_small');
      const existing = this.store.list('buyer', owner.account_id);
      check(existing.length + ids.filter(b => !this.buyer(owner, b.id)).length <= 8, 'owner_agent_limit', 409);
      for (const { id } of ids) check(!this.buyer(owner, id), 'buyer_already_allocated', 409);
      await this.preflight();
      const plan = { id: randomUUID(), owner, createdAt: new Date(this.now()).toISOString(), assetId: this.config.assetId,
        totalRaw: String(total), perAgentRaw: String(amount), remainderRaw: String(total - amount * BigInt(ids.length)),
        buyerIds: ids.map(b => b.id), deposits: {}, fundingAttempt: null };
      plan.acceptance = { version: this.config.acceptanceVersion, ownerTermsUrl: this.config.ownerTermsUrl,
        outlayerTermsUrl: this.config.outlayerTermsUrl, acceptedAt: new Date(this.now()).toISOString(), owner };
      this.store.transaction(() => {
        for (const { id, number } of ids) this.saveBuyer({ id, number, owner, active: false, grantActive: false, policyReady: false,
          policy: policyFor(owner, String(amount), this.config), create: { key: randomUUID() }, grant: { key: randomUUID() } });
        this.store.put('allocation', plan.id, owner.account_id, plan);
        this.store.put('allocation-request', requestKey, owner.account_id, { id: plan.id, bodyHash });
      });
      return this.publicPlan(plan);
    });
  }
  async observeOperation(operation) {
    if (operation?.submitted && operation.generated && !terminal.has(operation.status?.status)) {
      operation.status = await this.api.getStatus(operation.generated.correlation_id);
      check(operation.status.correlation_id === operation.generated.correlation_id, 'upstream_identity_mismatch', 502);
    }
  }
  async refreshUnlocked(owner, plan) {
    for (const id of plan.buyerIds) {
      const buyer = this.buyer(owner, id);
      await this.observeOperation(buyer.create);
      if (buyer.create.status?.status === 'SUCCESS') {
        const agent = await this.api.getAgent(buyer.agentId);
        check(agent.id === buyer.agentId && isDeepStrictEqual(agent.owner, buyer.owner), 'agent_owner_mismatch', 502);
        buyer.active = agent.status === 'ACTIVE';
        buyer.wallet = agent.wallet?.near_account_id ?? null;
      }
      if (buyer.active) {
        await this.observeOperation(buyer.grant);
        if (buyer.grant.status?.status === 'SUCCESS') {
          const grants = await this.api.listGrants(buyer.agentId);
          const grant = grants.find(g => g.owner_message?.credential === buyer.credential?.commitment);
          buyer.grantActive = !!grant && !grant.revoked_at && Date.parse(grant.expires_at) > this.now();
          buyer.grantExpiresAt = grant?.expires_at ?? buyer.grantExpiresAt;
        }
        const policy = await this.api.getPolicy(buyer.agentId);
        buyer.policyReady = policy.status === 'APPLIED' && policy.provider_policy_synced === true
          && isDeepStrictEqual(policy.policy, buyer.policy);
        const { balances } = await this.api.getBalances(buyer.agentId);
        const balance = balances.find(b => b.asset_id === this.config.assetId);
        check(!balance || /^\d+$/.test(balance.available_raw), 'invalid_balance', 502);
        buyer.availableRaw = balance?.available_raw ?? '0';
      }
      // Persist each observation; a later agent's failed read cannot lose progress.
      this.saveBuyer(buyer);
      const deposit = plan.deposits[id];
      if (deposit?.result && !terminal.has(deposit.result.status)) {
        const observed = await this.api.getStatus(deposit.result.correlation_id);
        check(observed.type === 'deposit' && observed.agent_id === buyer.agentId, 'upstream_identity_mismatch', 502);
        deposit.result = observed;
        this.store.put('allocation', plan.id, owner.account_id, plan);
      }
    }
    return this.publicPlan(plan);
  }
  async refresh(owner, id) {
    this.configured();
    return this.locks.run(owner.account_id, () => this.refreshUnlocked(owner, this.plan(owner, id)));
  }
  async prepare(owner, id) {
    this.configured();
    return this.locks.run(owner.account_id, async () => {
      const plan = this.plan(owner, id, true);
      await this.preflight();
      await this.refreshUnlocked(owner, plan);
      for (const buyerId of plan.buyerIds) {
        const buyer = this.buyer(owner, buyerId);
        let operation, body;
        if (!buyer.active) {
          operation = buyer.create;
          body = { type: 'agent_create', name: `Private Market buyer ${buyer.number}`, external_user_id: `fx:${hash(owner.account_id)}`,
            owner, policy: buyer.policy };
        } else if (!buyer.grantActive) {
          operation = buyer.grant;
          // Renew only grants proven expired/revoked, keeping the same wallet.
          if (operation.status?.status === 'SUCCESS') {
            buyer.grant = operation = { key: randomUUID() };
            delete buyer.credential;
          }
          if (!buyer.credential) {
            buyer.credential = createGrantCredential();
            buyer.grantExpiresAt = new Date(this.now() + 7 * 24 * 60 * 60_000).toISOString();
          }
          body = { type: 'grant_issue', agent_id: buyer.agentId, label: `Private Market buyer ${buyer.number}`,
            credential: buyer.credential.commitment, expires_at: buyer.grantExpiresAt };
        } else continue;
        check(operation.status?.status !== 'FAILED', operation.status?.failure_code ?? 'owner_intent_failed', 409);
        if (operation.submitted) return { plan: this.publicPlan(plan), signing: null };
        // Write credentials and stable key BEFORE any external request.
        this.saveBuyer(buyer);
        if (!operation.generated) {
          operation.generated = await this.api.generateIntent(body, { idempotencyKey: operation.key });
          check(operation.generated.type === body.type && isDeepStrictEqual(operation.generated.signer, owner), 'upstream_signer_mismatch', 502);
          if (body.type === 'agent_create') {
            check(operation.generated.intent.standard === 'nep366' && isDeepStrictEqual(operation.generated.preview.policy, buyer.policy), 'upstream_policy_mismatch', 502);
            buyer.agentId = operation.generated.agent_id;
          } else {
            check(operation.generated.agent_id === buyer.agentId, 'upstream_identity_mismatch', 502);
            check(operation.generated.intent.standard === 'nep413', 'upstream_standard_mismatch', 502);
          }
          this.saveBuyer(buyer);
        }
        check(Date.parse(operation.generated.expires_at) > this.now(), 'owner_intent_expired', 409);
        return { plan: this.publicPlan(plan), signing: { buyerId, correlationId: operation.generated.correlation_id,
          type: operation.generated.type, intent: operation.generated.intent, preview: operation.generated.preview,
          expiresAt: operation.generated.expires_at } };
      }
      return { plan: this.publicPlan(plan), signing: null };
    });
  }
  async submit(owner, id, input) {
    this.configured();
    return this.locks.run(owner.account_id, async () => {
      const plan = this.plan(owner, id, true);
      check(plan.buyerIds.includes(input?.buyerId), 'buyer_not_found', 404);
      const buyer = this.buyer(owner, input.buyerId);
      const operation = [buyer.create, buyer.grant].find(op => op.generated?.correlation_id === input.correlationId);
      check(operation, 'intent_not_found', 404);
      if (terminal.has(operation.status?.status)) return this.publicPlan(plan);
      const generated = operation.generated;
      // Never accept a browser-supplied payload, type, owner, policy, or grant.
      let signedData;
      if (generated.intent.standard === 'nep413') {
        check(typeof input.signature === 'string', 'invalid_signature');
        verifyMessage(generated.intent.payload, owner.public_key, input.signature);
        signedData = { ...generated.intent, signature: input.signature, public_key: owner.public_key };
      } else {
        check(generated.intent.standard === 'nep366' && typeof input.signedDelegate === 'string' && input.signedDelegate.length < 64_000, 'invalid_delegate');
        signedData = { ...generated.intent, signed_delegate: input.signedDelegate };
      }
      if (operation.signedData) check(isDeepStrictEqual(operation.signedData, signedData), 'signature_conflict', 409);
      operation.signedData = signedData;
      operation.submitted = true;
      this.saveBuyer(buyer);
      // A lost acknowledgment is retried with the EXACT stored signature.
      const status = await this.api.submitIntent({ type: generated.type, correlation_id: generated.correlation_id, signed_data: operation.signedData });
      check(status.correlation_id === generated.correlation_id, 'upstream_identity_mismatch', 502);
      operation.status = status;
      this.saveBuyer(buyer);
      return this.refreshUnlocked(owner, plan);
    });
  }
  async retrySubmitted(owner, id) {
    this.configured();
    return this.locks.run(owner.account_id, async () => {
      const plan = this.plan(owner, id, true);
      for (const buyerId of plan.buyerIds) {
        const buyer = this.buyer(owner, buyerId);
        for (const op of [buyer.create, buyer.grant]) if (op.submitted && op.signedData && !terminal.has(op.status?.status)) {
          // Query first. Uncertain work is observed, never replaced.
          const status = await this.api.getStatus(op.generated.correlation_id);
          op.status = status;
          if (status.status === 'PENDING_SIGNATURE') op.status = await this.api.submitIntent({ type: op.generated.type,
            correlation_id: op.generated.correlation_id, signed_data: op.signedData });
          this.saveBuyer(buyer);
        }
      }
      return this.refreshUnlocked(owner, plan);
    });
  }
  async deposits(owner, id) {
    this.configured();
    check(this.config.fundingEnabled, 'wallet_funding_disabled', 503);
    return this.locks.run(owner.account_id, async () => {
      const plan = this.plan(owner, id, true);
      await this.refreshUnlocked(owner, plan);
      for (const buyerId of plan.buyerIds) {
        const buyer = this.buyer(owner, buyerId);
        check(buyer.active && buyer.grantActive && buyer.policyReady, 'wallet_not_authorized', 409);
        let deposit = plan.deposits[buyerId];
        if (!deposit) {
          deposit = plan.deposits[buyerId] = { key: randomUUID() };
          this.store.put('allocation', plan.id, owner.account_id, plan);
        }
        if (!deposit.result) {
          deposit.result = await this.api.deposit(buyer.agentId, { origin_asset: plan.assetId, amount: plan.perAgentRaw }, { idempotencyKey: deposit.key });
          check(deposit.result.type === 'deposit' && deposit.result.agent_id === buyer.agentId, 'upstream_identity_mismatch', 502);
          this.store.put('allocation', plan.id, owner.account_id, plan);
        }
      }
      return this.publicPlan(plan);
    });
  }
  async beginFunding(owner, id, acceptance) {
    this.configured();
    check(this.config.fundingEnabled, 'wallet_funding_disabled', 503);
    return this.locks.run(owner.account_id, async () => {
      const plan = this.plan(owner, id, true);
      check(acceptance === this.config.acceptanceVersion, 'owner_acceptance_required', 400);
      check(!plan.fundingAttempt, 'funding_already_started', 409);
      await this.preflight();
      await this.refreshUnlocked(owner, plan);
      await this.rpc.fullAccess(owner.account_id, owner.public_key);
      const transactions = [];
      const destinations = new Set();
      for (const buyerId of plan.buyerIds) {
        const buyer = this.buyer(owner, buyerId), deposit = plan.deposits[buyerId]?.result;
        check(buyer.active && buyer.grantActive && buyer.policyReady, 'wallet_not_authorized', 409);
        check(deposit?.status === 'PENDING_DEPOSIT' && deposit.details?.deposit_address && Date.parse(deposit.details.expires_at) > this.now() + 60_000,
          'deposit_not_payable', 409);
        check(!deposit.details.min_amount || BigInt(plan.perAgentRaw) >= BigInt(deposit.details.min_amount), 'amount_below_route_minimum', 409);
        check(deposit.details.refund_to === buyer.wallet, 'deposit_refund_mismatch', 409);
        check(!deposit.details.memo || (typeof deposit.details.memo === 'string' && deposit.details.memo.length <= 2048), 'unsupported_deposit_memo', 409);
        const destination = JSON.stringify([deposit.details.deposit_address, deposit.details.memo ?? null]);
        check(!destinations.has(destination), 'deposit_destinations_overlap', 409);
        destinations.add(destination);
        transactions.push(await this.rpc.fundingTransaction(owner, this.config.tokenContract, deposit.details, plan.perAgentRaw));
      }
      plan.fundingAttempt = { id: randomUUID(), status: 'awaiting_chain', hashes: [], startedAt: new Date(this.now()).toISOString(),
        acceptance: { version: acceptance, ownerTermsUrl: this.config.ownerTermsUrl, outlayerTermsUrl: this.config.outlayerTermsUrl } };
      this.store.put('allocation', plan.id, owner.account_id, plan);
      return { attemptId: plan.fundingAttempt.id, transactions };
    });
  }
  async reportFunding(owner, id, input) {
    return this.locks.run(owner.account_id, async () => {
      const plan = this.plan(owner, id, true);
      check(plan.fundingAttempt?.id === input.attemptId, 'funding_attempt_not_found', 404);
      check(Array.isArray(input.hashes) && input.hashes.length <= 8 && input.hashes.every(h => typeof h === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(h)), 'invalid_transaction_hash');
      plan.fundingAttempt.hashes = [...new Set([...plan.fundingAttempt.hashes, ...input.hashes])];
      // Hashes are hints, never proof of payment or authority to credit a balance.
      this.store.put('allocation', plan.id, owner.account_id, plan);
      return this.publicPlan(plan);
    });
  }
  async modelCall() { throw new GatewayError('procurement_not_ready', 503); }
}
