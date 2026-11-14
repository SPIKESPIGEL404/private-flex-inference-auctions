import { randomBytes, createPublicKey, verify } from 'node:crypto';
import bs58 from 'bs58';
import { hash, uint, requireThat, nearForNanoUsd, meterSettlement, checkConservation, challengeIdentity } from '../contract.mjs';
import { validateTariff, usageCostMicro, comparisonRequest, MODEL } from '../../inference-comparison/core.mjs';
import { refundPlan } from '../near.mjs';

export function signReceipt(document, key) {
  const digest = hash(document);
  return { document, digest, publicKey: key.getPublicKey().toString(),
    signature: Buffer.from(key.sign(Buffer.from(digest, 'hex')).signature).toString('base64') };
}
export function verifyReceipt(receipt, expectedKey) {
  requireThat(receipt.publicKey === expectedKey && receipt.digest === hash(receipt.document), 'financial_receipt_binding_mismatch');
  const key = createPublicKey({ format: 'der', type: 'spki', key: Buffer.concat([
    Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(bs58.decode(expectedKey.slice(8))),
  ]) });
  requireThat(verify(null, Buffer.from(receipt.digest, 'hex'), key, Buffer.from(receipt.signature, 'base64')), 'financial_receipt_signature_invalid');
  checkConservation(receipt.document.principal); return receipt.document;
}
export class CloudAuthority {
  constructor({ store, config, receiptKey, now = Date.now }) {
    Object.assign(this, { store, config, receiptKey, now });
    requireThat(config.network === 'testnet' && config.fx.kind === 'testnet-accounting-convention'
      && uint(config.fx.nanoUsdPerNear) > 0n, 'testnet_fx_contract_required');
    this.common = comparisonRequest(config.request);
    // A stale price blocks NEW purchases, never recovery of an existing debt.
    this.tariff = validateTariff(config.tariff, config.tariff.observedAtMs);
    requireThat(this.tariff.observedAtMs <= now(), 'future_cloud_tariff');
    requireThat(this.tariff.model === MODEL && config.qualifiedInputTokens > 0 && config.qualifiedInputTokens <= 8192,
      'qualified_cloud_scope_required');
    this.maximumMicro = usageCostMicro(this.tariff.rates, { prompt_tokens: config.qualifiedInputTokens,
      completion_tokens: this.common.max_completion_tokens });
    requireThat(uint(this.maximumMicro) <= uint(config.upstreamBudgetMicro) && uint(config.upstreamBudgetMicro) <= 10000n,
      'bounded_cloud_budget_required');
    const fingerprint = hash({ config, receiptKey: receiptKey.getPublicKey().toString() });
    store.transaction(() => {
      const old = store.get('cloud-policy', config.namespace);
      requireThat(!old || old.fingerprint === fingerprint, 'cloud_policy_changed');
      if (!old) store.put('cloud-policy', config.namespace, config.namespace, { fingerprint });
    });
  }
  get(id) { return this.store.get('cloud-order', id, this.config.namespace); }
  put(order) { this.store.put('cloud-order', order.id, this.config.namespace, order); }
  orders() { return this.store.list('cloud-order', this.config.namespace); }
  prepare(key, raw) {
    requireThat(/^[a-zA-Z0-9_-]{1,96}$/.test(key), 'idempotency_key_required');
    const body = JSON.parse(raw);
    requireThat(body.model === MODEL && body.stream === true && body.stream_options?.include_usage === true
      && Object.keys(body).every(k => ['model','messages','temperature','seed','max_completion_tokens','stream','stream_options'].includes(k)), 'unsupported_cloud_request');
    const { model, stream, stream_options, ...common } = body;
    requireThat(hash(comparisonRequest(common)) === hash(this.common), 'request_outside_authorization');
    const id = hash([this.config.namespace, this.config.agent.accountId, key]);
    return this.store.transaction(() => {
      const old = this.get(id);
      if (old) { requireThat(old.bodyHash === hash(raw), 'original_request_conflict'); return old; }
      const existing = this.orders();
      const settledWaiver = existing.length === 1 && existing[0].waiver && existing[0].state === 'refunded'
        && existing[0].principal.R === existing[0].principal.P;
      requireThat(existing.length === 0 || settledWaiver, 'cloud_order_authorization_exhausted');
      requireThat(existing.reduce((n, o) => n + uint(o.terms.maximumMicro), 0n) + uint(this.maximumMicro) <= uint(this.config.upstreamBudgetMicro), 'cloud_upstream_budget_exhausted');
      validateTariff(this.tariff, this.now());
      const now = this.now(), maximumNano = String(uint(this.maximumMicro) * 1000n);
      const terms = { version: 1, provider: 'near-ai-cloud', model: MODEL, bodyHash: hash(raw),
        tariff: this.tariff, inputTokenCap: this.config.qualifiedInputTokens, maximumMicro: this.maximumMicro,
        fx: this.config.fx, gasReserveYocto: this.config.agentGasReserveYocto };
      const request = { version: 1, network: 'testnet', currency: 'NEAR', decimals: 24,
        amount: String(nearForNanoUsd(maximumNano, this.config.fx.nanoUsdPerNear)),
        payer: this.config.agent.accountId, recipient: this.config.merchant, refundTo: this.config.agent.accountId,
        bindingVersion: this.config.agent.bindingVersion, orderRef: id, termsHash: hash(terms), nativeRequestHash: hash(raw),
        nonce: randomBytes(32).toString('base64'), issuedAtMs: now, expiresAtMs: now + 120000, signingRecipient: this.config.realm };
      const order = { id, key, bodyHash: hash(raw), raw, terms, request, state: 'quoted',
        principal: { P: '0', C: '0', H: '0', W: '0', R: '0' } };
      this.put(order); return order;
    });
  }
  saveChallenge(challenge) {
    const order = this.get(challenge.request.orderRef);
    requireThat(order && hash(order.request) === hash(challenge.request), 'original_cloud_order_required');
    const old = this.store.get('cloud-challenge', challenge.id);
    requireThat(!old || hash(old) === hash(challenge), 'original_challenge_conflict');
    this.store.put('cloud-challenge', challenge.id, this.config.namespace, challenge);
  }
  async loadChallenge(id) { return this.store.get('cloud-challenge', id, this.config.namespace); }
  async journalPresentation(credential) {
    this.store.transaction(() => {
      const order = this.get(credential.challenge.request.orderRef); requireThat(order, 'unknown_cloud_order');
      const expected = this.store.get('cloud-challenge', credential.challenge.id, this.config.namespace);
      requireThat(expected && challengeIdentity(expected) === challengeIdentity(credential.challenge), 'original_challenge_required');
      requireThat(!order.paymentCredential || (hash(order.paymentCredential.payload) === hash(credential.payload)
        && challengeIdentity(order.paymentCredential.challenge) === challengeIdentity(credential.challenge)), 'original_payment_credential_conflict');
      this.store.put('cloud-presentation', hash(credential), this.config.namespace, credential);
      this.put({ ...order, paymentCredential: credential });
    });
  }
  async consumeVerifiedPayment(proof) {
    return this.store.transaction(() => {
      const order = this.get(proof.orderRef);
      requireThat(order && proof.amount === order.request.amount && proof.payer === order.request.payer
        && proof.recipient === order.request.recipient && proof.publicKey === this.config.agent.publicKey, 'payment_order_mismatch');
      const identity = hash(proof.movementKey), old = this.store.get('cloud-movement', identity);
      requireThat(!old || old.orderRef === order.id, 'movement_already_consumed');
      requireThat(!order.payment || order.payment.movementKey === proof.movementKey, 'original_payment_already_assigned');
      if (!old) {
        this.store.put('cloud-movement', identity, this.config.namespace, { orderRef: order.id, proof });
        const refundable = proof.late || this.now() >= order.request.expiresAtMs || uint(proof.gasActualYocto) > uint(this.config.agentGasReserveYocto);
        this.put({ ...order, payment: proof, state: refundable ? 'refund_due' : 'paid',
          principal: { P: proof.amount, C: '0', H: refundable ? '0' : proof.amount, W: refundable ? proof.amount : '0', R: '0' } });
      }
      const latest = this.get(order.id);
      return { committed: true, projectionReady: !proof.late && (latest.state === 'paid' || !!latest.response), orderRef: order.id };
    });
  }
  claimInference(id) {
    return this.store.transaction(() => {
      const order = this.get(id); requireThat(order, 'unknown_cloud_order');
      if (order.state !== 'paid') return { claimed: false, order };
      if (this.now() >= order.request.expiresAtMs || this.now() >= this.tariff.expiresAtMs) {
        const next = { ...order, state: 'refund_due', principal: { ...order.principal, H: '0', W: order.principal.P } };
        this.put(next); return { claimed: false, order: next };
      }
      const native = { ...this.common, model: MODEL, stream: true, stream_options: { include_usage: true }, user: 'mpp-' + id };
      const next = { ...order, state: 'inference_pending', provider: { operation: 'mpp-' + id, body: native, bodyHash: hash(native),
        startedAtMs: this.now(), attempts: 1 } };
      this.put(next); // exact original provider intent and money hold, one FULL commit
      return { claimed: true, order: next };
    });
  }
  expireUnadmitted(id, reason) {
    return this.store.transaction(() => {
      const order = this.get(id);
      if (order?.state === 'paid' && (reason || this.now() >= order.request.expiresAtMs))
        this.put({ ...order, state: 'refund_due', lastError: reason ?? 'admission_expired',
          principal: { ...order.principal, H: '0', W: order.principal.P } });
    });
  }
  recordVerified(id, { raw, summary, verification }) {
    requireThat(verification.id === summary.id && verification.signatureKind === 'provider_tee', 'provider_signature_required');
    requireThat(summary.usage.prompt_tokens <= this.config.qualifiedInputTokens
      && summary.usage.completion_tokens <= this.common.max_completion_tokens, 'usage_exceeds_authorization');
    verification = JSON.parse(JSON.stringify(verification, (_, value) => typeof value === 'bigint' ? String(value) : value));
    return this.store.transaction(() => {
      const order = this.get(id); requireThat(order?.state === 'inference_pending', 'original_inference_not_pending');
      const actualMicro = usageCostMicro(order.terms.tariff.rates, summary.usage);
      const principal = meterSettlement({ principalYocto: order.request.amount, actualServiceNano: String(uint(actualMicro) * 1000n),
        serviceMaximumNano: String(uint(order.terms.maximumMicro) * 1000n), nanoUsdPerNear: order.terms.fx.nanoUsdPerNear });
      const responseHash = hash(raw), financial = { version: 1, revision: 1, orderRef: id, requestHash: order.bodyHash,
        termsHash: order.request.termsHash, provider: 'near-ai-cloud', responseId: summary.id, responseHash,
        usage: summary.usage, tariffVersion: order.terms.tariff.priceVersion, actualServiceMicroUsd: actualMicro,
        fx: order.terms.fx, principal, paymentTxHash: order.payment.txHash, agentGasYocto: order.payment.gasActualYocto,
        verificationDigest: hash(verification) };
      const next = { ...order, state: principal.W === '0' ? 'settled' : 'refund_due', principal,
        financialReceipt: signReceipt(financial, this.receiptKey), response: raw.toString('base64'),
        provider: { ...order.provider, state: 'verified', responseId: summary.id, usage: summary.usage, verification, responseHash, verifiedAtMs: this.now() } };
      this.put(next); return next;
    });
  }
  capture(id, raw, responseId, verification) {
    return this.store.transaction(() => {
      const order = this.get(id); requireThat(order?.state === 'inference_pending', 'original_inference_not_pending');
      const serialized = verification && JSON.parse(JSON.stringify(verification, (_, value) => typeof value === 'bigint' ? String(value) : value));
      const provider = { ...order.provider, capturedResponse: raw.toString('base64'), capturedId: responseId,
        ...(serialized ? { verification: serialized } : {}) };
      requireThat(!order.provider.capturedResponse || order.provider.capturedResponse === provider.capturedResponse, 'original_captured_response_conflict');
      this.put({ ...order, provider });
    });
  }
  waiveIntegrationFailure(id, reason) {
    return this.store.transaction(() => {
      const order = this.get(id);
      requireThat(order?.state === 'inference_pending' && !order.response && !order.provider.capturedResponse
        && order.lastError === 'multiple_final_usage' && reason === 'integration_parser_rejected_unretained_response', 'explicit_integration_waiver_required');
      this.put({ ...order, state: 'refund_due',
        waiver: { reason, approvedBy: 'local-acceptance-operator', upstreamMayBeCharged: true,
          retainedUpstreamReserveMicro: order.terms.maximumMicro, approvedAtMs: this.now() },
        principal: { ...order.principal, C: '0', H: '0', W: order.principal.P } });
    });
  }
  recordUnknown(id, code) {
    this.store.transaction(() => {
      const current = this.get(id);
      if (current?.state === 'inference_pending') this.put({ ...current, lastError: code, provider: { ...current.provider, state: 'unknown' } });
    });
  }
  refundFor(id) {
    return this.store.transaction(() => {
      let order = this.get(id); requireThat(order && uint(order.principal.W) > 0n, 'no_refund_due');
      if (order.refundPlan) return order.refundPlan;
      const plan = refundPlan({ orderRef: id, binding: order.request, amount: order.principal.W,
        refundableYocto: order.principal.W, operationId: 'refund-' + id, createdAtMs: this.now() });
      this.put({ ...order, refundPlan: plan }); return plan;
    });
  }
  recordRefund(id, proof, gasYocto) {
    return this.store.transaction(() => {
      const order = this.get(id); requireThat(order?.refundPlan && proof.amount === order.refundPlan.amount
        && proof.recipient === order.request.refundTo && proof.payer === order.request.recipient, 'refund_order_mismatch');
      if (order.refund) { requireThat(order.refund.movementKey === proof.movementKey, 'original_refund_conflict'); return order; }
      const identity = hash(proof.movementKey);
      requireThat(!this.store.get('cloud-movement', identity), 'movement_already_consumed');
      const principal = { ...order.principal, W: '0', R: String(uint(order.principal.R) + uint(proof.amount)) }; checkConservation(principal);
      this.store.put('cloud-movement', identity, this.config.namespace, { orderRef: id, proof });
      const refund = { ...proof, gasActualYocto: gasYocto, gasPayer: order.request.recipient };
      const next = { ...order, state: 'refunded', principal, refund,
        refundReceipt: signReceipt({ version: 1, revision: 2, orderRef: id, principal, serviceWaiver: order.waiver ?? null, refundTxHash: proof.txHash,
          paymentTxHash: order.payment.txHash, merchantGasYocto: gasYocto }, this.receiptKey) };
      this.put(next); return next;
    });
  }
  view(order) {
    return { id: order.id, state: order.state, terms: order.terms, principal: order.principal,
      payment: order.payment ?? null, provider: order.provider ? { ...order.provider, body: undefined } : null,
      financialReceipt: order.financialReceipt ?? null, refund: order.refund ?? null, refundReceipt: order.refundReceipt ?? null };
  }
}
