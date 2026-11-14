import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Ajv from 'ajv';
import { nearForNanoUsd, nanoUsdForNear, providerCapMicroUsd, meterSettlement, checkConservation,
  paymentExposure, nativeReadyBalance, nativePolicy, nativePlan, fundingAllocation, chooseQuote, YOCTO, hash } from '../contract.mjs';
import { fixture, now } from './support.mjs';

test('integer USD/NEAR conversions round conservatively at 24-place and provider cap boundaries', () => {
  const rate = '3000000000';
  assert.equal(nearForNanoUsd('1', rate), 333333333333334n);
  assert.equal(nanoUsdForNear('333333333333334', rate), 2n);
  assert.equal(nearForNanoUsd('3000000000', rate), YOCTO);
  assert.equal(providerCapMicroUsd('1000999', '1000'), 999n);
  assert.throws(() => nearForNanoUsd('1.0', rate), /invalid_integer/);
  assert.throws(() => nearForNanoUsd('1', '0'), /invalid_rate/);
  assert.throws(() => nanoUsdForNear(String(YOCTO), '0'), /invalid_rate/);
});
test('metered P=C+H+W+R, no credit for pending refund, charges never exceed principal', () => {
  for (let i = 0n; i <= 100n; i++) {
    const s = meterSettlement({ principalYocto: String(nearForNanoUsd('100', '3000000000')),
      actualServiceNano: String(i), serviceMaximumNano: '100', nanoUsdPerNear: '3000000000' });
    checkConservation(s); assert.equal(s.R, '0');
  }
  assert.throws(() => meterSettlement({ principalYocto: '1', actualServiceNano: '101', serviceMaximumNano: '100', nanoUsdPerNear: '3000000000' }), /settlement_contract_mismatch/);
});
test('payment cap includes converted principal plus native gas; wrong unit/budget/balance fails closed', () => {
  const f = fixture(); const x = { request: f.request, gasCapYocto: '100000000000000000000', nanoUsdPerNear: '2000000000',
    bidNano: '2000000', serviceCapNano: '2100000', callCapNano: '2200000', taskRemainingNano: '3000000',
    nowMs: now, nativeBalance: { source: 'near-rpc-view-account', ledger: 'NEAR_CHAIN', asset: 'native:NEAR',
      decimals: 24, finality: 'final', network: 'testnet', accountId: f.request.payer,
      blockHash: f.txHash, observedAtMs: now, availableAfterStorageYocto: '1300000000000000000000', reservedYocto: '0' },
    gasFloorYocto: '100000000000000000000' };
  assert.equal(paymentExposure(x).reserveNano, '2200000');
  assert.throws(() => paymentExposure({ ...x, taskRemainingNano: '2199999' }), /task_or_call_cap_exceeded/);
  assert.throws(() => paymentExposure({ ...x, bidNano: '1999999' }), /service_cap_exceeded/);
  assert.throws(() => paymentExposure({ ...x, nativeBalance: { ...x.nativeBalance, availableAfterStorageYocto: '1199999999999999999999' } }), /native_balance_or_gas_insufficient/);
  assert.throws(() => paymentExposure({ ...x, nanoUsdPerNear: '0' }), /invalid_rate/);
  for (const change of [{ ledger: 'INTENTS' }, { asset: 'nep141:wrap.near' }, { accountId: 'other.testnet' }, { finality: 'optimistic' }])
    assert.throws(() => paymentExposure({ ...x, nativeBalance: { ...x.nativeBalance, ...change } }), /not_native_chain_balance/);
  assert.throws(() => nativeReadyBalance({ request: f.request, balance: { ...x.nativeBalance, observedAtMs: now - 5001 }, nowMs: now }), /stale_or_unfinalized/);
  assert.throws(() => nativeReadyBalance({ request: f.request, balance: x.nativeBalance, nowMs: now + 60000 }), /payment_window_closed/);
});
test('native policy enables only merchant transfer and relying-party signature, no contract calls', () => {
  const p = nativePolicy({ merchant: 'merchant.testnet', signingRecipient: 'payments.example.com', maxPrincipalYocto: '1000' });
  assert.deepEqual(p.native.near, { transfer: true, call: [], sign_message: ['payments.example.com'] });
  assert.equal(p.destinations.list.length, 1); assert.deepEqual(p.assets, ['nep141:wrap.near']);
  assert.equal(p.confidential, true); assert.deepEqual(p.actions, []);
  const f = fixture(), b = { payer: f.request.payer, refundTo: f.request.refundTo, version: f.request.bindingVersion, network: 'testnet', agentId: 'agent-1', merchant: f.request.recipient, signingRecipient: f.request.signingRecipient };
  assert.equal(nativePlan(f.challenge, b).idempotencyKey, `near-pay-v1-${f.request.orderRef}`);
  assert.throws(() => nativePlan(f.challenge, { ...b, payer: 'other.testnet' }), /wrong_agent_binding/);
  assert.throws(() => nativePlan(f.challenge, { ...b, merchant: 'other.testnet' }), /unreviewed_merchant_or_relying_party/);
});
test('native policy conforms to official pinned Policy schema and new-policy rules', () => {
  const { policySchema } = JSON.parse(readFileSync(new URL('./fixtures/agent-api-policy-contract.json', import.meta.url)));
  const validate = new Ajv({ strict: false }).compile(policySchema);
  const p = nativePolicy({ merchant: 'merchant.near', signingRecipient: 'payments.example.com', maxPrincipalYocto: '1000' });
  assert.equal(validate(p), true, JSON.stringify(validate.errors));
  assert.equal(p.confidential, true); assert.deepEqual(p.actions, []);
  assert.equal(validate({ ...p, native: { near: { transfer: true } } }), false);
});
test('cross-chain allocation keeps exact source precision/remainder and requires chain delivery', () => {
  const p = fundingAllocation({ totalRaw: '1000000000000000001', sourceDecimals: 18, agentAccounts: ['a.near', 'b.near'] });
  assert.equal(p.remainderRaw, '1'); assert.equal(p.legs[0].principalRaw, '500000000000000000');
  assert.equal(p.legs[1].recipientType, 'DESTINATION_CHAIN'); assert.equal(p.legs[1].destinationDecimals, 24);
});

const quotes = [
  { id: 'cheap', expectedServiceNano: '10000', serviceMaximumNano: '11000', routeMaximumNano: '1000', usableMs: 3000 },
  { id: 'quick', expectedServiceNano: '150000', serviceMaximumNano: '151000', routeMaximumNano: '1000', usableMs: 500 },
].map(q => ({ ...q, scopeMatches: true, estimateKind: 'p95', observedAtMs: now, expiresAtMs: now + 60_000, riskNano: '0' }));
const decision = { nowMs: now, startedAtMs: now, deadlineMs: now + 30_000, maxWaitMs: 20_000,
  availableNano: '1000000', hardBidNano: '200000', paymentMs: 1000, admissionMs: 50, deliveryMs: 50, quotes };
test('same native scope chooses cheap/fast by preference; near deadline changes decision, never caps', () => {
  assert.equal(chooseQuote({ ...decision, preference: 'save' }).id, 'cheap');
  assert.equal(chooseQuote({ ...decision, preference: 'fast' }).id, 'quick');
  assert.equal(chooseQuote({ ...decision, preference: 'save', deadlineMs: now + 2500 }).id, 'quick');
  assert.equal(chooseQuote({ ...decision, preference: 'fast', availableNano: '10000' }).action, 'wait');
  assert.equal(chooseQuote({ ...decision, preference: 'fast', nowMs: now + 20000 }).action, 'stop');
});
test('stale/unknown/guarantee-only timing cannot become zero latency; payment cost/time count', () => {
  assert.equal(chooseQuote({ ...decision, preference: 'save', quotes: quotes.map(q => ({ ...q, observedAtMs: now - 30001 })) }).action, 'wait');
  assert.equal(chooseQuote({ ...decision, preference: 'save', quotes: quotes.map(q => ({ ...q, hardCommitmentRequired: true })) }).action, 'wait');
  assert.equal(chooseQuote({ ...decision, preference: 'save', paymentMs: 31000 }).action, 'wait');
  assert.equal(chooseQuote({ ...decision, preference: 'fast', quotes: [{ ...quotes[0], usableMs: undefined }] }).action, 'wait');
  assert.equal(chooseQuote({ ...decision, preference: 'fast', quotes: [quotes[0]] }).id, 'cheap');
  assert.throws(() => chooseQuote({ ...decision, preference: 'fast', nowMs: now - 1 }), /invalid_clock_or_preference/);
});
test('native body fingerprint changes with tool scope; order IDs are full SHA256', () => {
  assert.notEqual(hash({ model: 'm', tools: [] }), hash({ model: 'm', tools: [{ name: 'bash' }] }));
  assert.equal(hash('order').length, 64);
});
