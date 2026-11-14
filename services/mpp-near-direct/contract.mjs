import { createHash } from 'node:crypto';
import { Method, z } from 'mppx';

export const METHOD = 'bitrouter-near-direct';
export const YOCTO = 10n ** 24n;
export const account = /^(?=.{2,64}$)[a-z0-9]+(?:[-_.][a-z0-9]+)*$/;
export function requireThat(ok, code) { if (!ok) throw new Error(code); }
export function uint(value) {
  requireThat(typeof value === 'string' && /^(0|[1-9][0-9]{0,38})$/.test(value), 'invalid_integer');
  const n = BigInt(value); requireThat(n <= (1n << 128n) - 1n, 'integer_exceeds_u128'); return n;
}
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  requireThat(value !== undefined && (typeof value !== 'number' || Number.isSafeInteger(value)), 'noncanonical_value');
  return JSON.stringify(value);
}
export const hash = value => createHash('sha256').update(typeof value === 'string' ? value : canonical(value)).digest('hex');
export function challengeIdentity(challenge) {
  // mppx hydrates `meta` from authenticated opaque on the server, while HTTP
  // clients retain opaque only. Accept exactly that derived representation.
  const { meta, ...wire } = challenge;
  if (meta !== undefined) requireThat(typeof wire.opaque === 'string'
    && canonical(meta) === canonical(JSON.parse(Buffer.from(wire.opaque, 'base64url').toString('utf8'))), 'unbound_challenge_meta');
  return canonical(wire);
}
const text = pattern => z.string().check(z.regex(pattern));
const hex = text(/^[0-9a-f]{64}$/);
const raw = text(/^[1-9][0-9]{0,38}$/);
const epoch = z.number().check(z.int(), z.minimum(1), z.maximum(Number.MAX_SAFE_INTEGER));
const requestFields = {
  version: z.literal(1), network: z.enum(['mainnet', 'testnet']), currency: z.literal('NEAR'),
  decimals: z.literal(24), amount: raw, recipient: text(account), payer: text(account),
  refundTo: text(account), bindingVersion: z.string().check(z.minLength(1), z.maxLength(128)),
  orderRef: hex, termsHash: hex, nativeRequestHash: hex,
  nonce: text(/^[A-Za-z0-9+/]{43}=$/), issuedAtMs: epoch, expiresAtMs: epoch,
  signingRecipient: text(/^[a-z0-9.-]{1,128}$/),
};
export const requestSchema = z.strictObject(requestFields);
// mppx 0.17 feeds the route-level expiry through the method input schema.
// Admit this ONE SDK option, require alignment, and omit it from wire request.
const sdkRequestSchema = z.pipe(z.strictObject({ ...requestFields, expires: z.optional(z.string()) })
  .check(z.refine(v => v.expires === undefined || Date.parse(v.expires) === v.expiresAtMs)),
z.transform(({ expires: _expires, ...r }) => r));
export const payloadSchema = z.strictObject({
  txHash: text(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/),
  publicKey: text(/^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$/),
  signature: text(/^[A-Za-z0-9+/]{86}==$/),
});
export const nearDirect = Method.from({ name: METHOD, intent: 'charge', schema: {
  request: sdkRequestSchema, credential: { payload: payloadSchema },
} });

export function validateRequest(input) {
  const r = requestSchema.parse(input);
  uint(r.amount);
  requireThat(r.refundTo === r.payer && r.payer !== r.recipient, 'invalid_account_binding');
  requireThat(r.expiresAtMs > r.issuedAtMs && r.expiresAtMs - r.issuedAtMs <= 120_000, 'invalid_payment_window');
  const nonce = Buffer.from(r.nonce, 'base64');
  requireThat(nonce.length === 32 && nonce.toString('base64') === r.nonce, 'invalid_nonce');
  return r;
}
// This exact signed array binds the original MPP resource and chain movement.
export function bindingMessage(challenge, txHash) {
  return canonical([METHOD, 1, challenge.realm, challenge.id, hash(validateRequest(challenge.request)), txHash]);
}
export function signedPayload(challenge, txHash) {
  return { message: bindingMessage(challenge, txHash), nonce: challenge.request.nonce,
    recipient: challenge.request.signingRecipient };
}
const ceilDiv = (n, d) => { requireThat(d > 0n, 'invalid_rate'); return (n + d - 1n) / d; };
export function nearForNanoUsd(nano, nanoUsdPerNear) { return ceilDiv(uint(nano) * YOCTO, uint(nanoUsdPerNear)); }
export function nanoUsdForNear(yocto, nanoUsdPerNear) {
  const rate = uint(nanoUsdPerNear); requireThat(rate > 0n, 'invalid_rate');
  return ceilDiv(uint(yocto) * rate, YOCTO);
}
// Inverse of the owning source's provider MicroUsd -> NanoUsd + platform fee.
export function providerCapMicroUsd(serviceCapNano, platformFeeNano) {
  const cap = uint(serviceCapNano), fee = uint(platformFeeNano);
  requireThat(cap >= fee, 'platform_fee_exceeds_cap');
  return (cap - fee) / 1000n;
}
export function meterSettlement({ principalYocto, actualServiceNano, serviceMaximumNano, nanoUsdPerNear }) {
  const p = uint(principalYocto), actual = uint(actualServiceNano), max = uint(serviceMaximumNano);
  requireThat(actual <= max && p === nearForNanoUsd(String(max), nanoUsdPerNear), 'settlement_contract_mismatch');
  const c = nearForNanoUsd(String(actual), nanoUsdPerNear);
  requireThat(c <= p, 'charge_exceeds_principal');
  return { P: String(p), C: String(c), H: '0', W: String(p - c), R: '0' };
}
export function checkConservation({ P, C, H, W, R }) {
  requireThat(uint(P) === uint(C) + uint(H) + uint(W) + uint(R), 'principal_not_conserved');
}
// Input is produced by the trusted native-chain reader and the single wallet
// reservation authority, never by Credential/source or an Intents balance API.
export function nativeReadyBalance({ request, balance, nowMs }) {
  const r = validateRequest(request);
  requireThat(Number.isSafeInteger(nowMs) && nowMs >= r.issuedAtMs && nowMs < r.expiresAtMs, 'payment_window_closed');
  requireThat(balance?.source === 'near-rpc-view-account' && balance.ledger === 'NEAR_CHAIN'
    && balance.asset === 'native:NEAR' && balance.decimals === 24 && balance.finality === 'final'
    && balance.network === r.network && balance.accountId === r.payer, 'not_native_chain_balance');
  requireThat(typeof balance.blockHash === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(balance.blockHash)
    && Number.isSafeInteger(balance.observedAtMs) && balance.observedAtMs <= nowMs
    && nowMs - balance.observedAtMs <= 5000, 'native_balance_stale_or_unfinalized');
  const available = uint(balance.availableAfterStorageYocto), held = uint(balance.reservedYocto);
  requireThat(available >= held, 'native_balance_overreserved');
  return available - held;
}
// A budget authorization is NOT a wallet/cash balance. The owning writer must
// atomically reserve this amount with the money fence and order-purpose check.
export function paymentExposure({ request, gasCapYocto, nanoUsdPerNear, bidNano,
  serviceCapNano, callCapNano, taskRemainingNano, nativeBalance, nowMs, gasFloorYocto }) {
  const r = validateRequest(request), p = uint(r.amount), g = uint(gasCapYocto);
  const service = nanoUsdForNear(r.amount, nanoUsdPerNear);
  const max = service + nanoUsdForNear(gasCapYocto, nanoUsdPerNear);
  requireThat(service <= uint(bidNano) && uint(bidNano) <= uint(serviceCapNano), 'service_cap_exceeded');
  requireThat(max <= uint(callCapNano) && max <= uint(taskRemainingNano), 'task_or_call_cap_exceeded');
  requireThat(nativeReadyBalance({ request: r, balance: nativeBalance, nowMs }) >= p + g + uint(gasFloorYocto), 'native_balance_or_gas_insufficient');
  return { reserveNano: String(max), principalYocto: String(p), gasCapYocto: String(g) };
}

export function nativePolicy({ merchant, signingRecipient, maxPrincipalYocto }) {
  requireThat(account.test(merchant) && /^[a-z0-9.-]{1,128}$/.test(signingRecipient), 'invalid_policy_target');
  requireThat(uint(maxPrincipalYocto) > 0n, 'invalid_principal_cap');
  // New policies require confidential:true for their Intents side. This does
  // not hide native transfers. No Intents spend action is needed for native.
  return { frozen: false, actions: [], confidential: true, owner_approval: false,
    assets: ['nep141:wrap.near'], limits: { per_transaction: { 'nep141:wrap.near': maxPrincipalYocto } },
    max_actions_per_hour: 60, destinations: { mode: 'only', list: [
      { action: 'withdraw', chain: 'near', address: merchant, memo: null },
    ] }, budget: { daily_usd: null, weekly_usd: null, monthly_usd: null }, timelock_ms: 0,
    native: { near: { sign_message: [signingRecipient], transfer: true, call: [] },
      evm: { sign_typed_data: [], sign_message: false, sign_transaction: false },
      solana: { sign_in: [], sign_message: false, sign_transaction: false } } };
}
export function nativePlan(challenge, authenticatedBinding) {
  const r = validateRequest(challenge.request);
  requireThat(challenge.method === METHOD && challenge.intent === 'charge', 'wrong_method');
  requireThat(r.payer === authenticatedBinding.payer && r.refundTo === authenticatedBinding.refundTo
    && r.bindingVersion === authenticatedBinding.version && r.network === authenticatedBinding.network,
  'wrong_agent_binding');
  requireThat(r.recipient === authenticatedBinding.merchant
    && r.signingRecipient === authenticatedBinding.signingRecipient
    && challenge.realm === authenticatedBinding.signingRecipient, 'unreviewed_merchant_or_relying_party');
  return { agentId: authenticatedBinding.agentId, orderRef: r.orderRef,
    idempotencyKey: `near-pay-v1-${r.orderRef}`, transfer: { to: r.recipient, amount: r.amount } };
}
export function fundingAllocation({ totalRaw, sourceDecimals, agentAccounts }) {
  requireThat(Number.isInteger(sourceDecimals) && sourceDecimals >= 0 && sourceDecimals <= 24, 'invalid_source_precision');
  requireThat(Array.isArray(agentAccounts) && agentAccounts.length >= 1 && agentAccounts.length <= 8
    && agentAccounts.every(a => account.test(a)) && new Set(agentAccounts).size === agentAccounts.length, 'invalid_agents');
  const total = uint(totalRaw), n = BigInt(agentAccounts.length), per = total / n;
  requireThat(per > 0n, 'allocation_too_small');
  return { sourceDecimals, remainderRaw: String(total % n), legs: agentAccounts.map(recipient => ({
    principalRaw: String(per), recipient, recipientType: 'DESTINATION_CHAIN',
    destinationNetwork: 'near', destinationAsset: 'native:NEAR', destinationDecimals: 24,
  })) };
}

export const POLICY_V1 = Object.freeze({ version: 'cost-speed-v1', freshnessMs: 30_000,
  tickMs: 1_000, paymentWindowMs: 60_000, reservationHoldMs: 75_000, clockSkewMs: 2_000,
  futureReserveBps: 2500, lossNanoPerMs: { save: 1n, balanced: 20n, fast: 100n } });
// Quotes describe total usable-terminal time FROM ADMISSION. Payment, admission
// and delivery stages are disjoint; TTFT is never added to full generation time.
export function chooseQuote({ nowMs, startedAtMs, deadlineMs, maxWaitMs, preference,
  availableNano, hardBidNano, paymentMs, admissionMs, deliveryMs, quotes }) {
  const lambda = POLICY_V1.lossNanoPerMs[preference];
  requireThat(lambda !== undefined && [nowMs, startedAtMs, deadlineMs, maxWaitMs, paymentMs, admissionMs, deliveryMs]
    .every(Number.isSafeInteger) && nowMs >= startedAtMs && paymentMs >= 0 && admissionMs >= 0 && deliveryMs >= 0, 'invalid_clock_or_preference');
  if (nowMs >= deadlineMs || nowMs - startedAtMs >= maxWaitMs) return { action: 'stop', reason: 'deadline_or_wait_limit', version: POLICY_V1.version };
  requireThat(Array.isArray(quotes) && quotes.length <= 256
    && new Set(quotes.map(q => q.id)).size === quotes.length, 'invalid_quote_set');
  const available = uint(availableNano), bid = uint(hardBidNano);
  // Retain 25% of still-unallocated task authorization for later tool rounds.
  const allocation = available - ceilDiv(available * BigInt(POLICY_V1.futureReserveBps), 10_000n);
  const candidates = quotes.flatMap(q => {
    requireThat(typeof q.id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(q.id), 'invalid_quote_id');
    if (![q.observedAtMs, q.usableMs, q.expiresAtMs].every(Number.isSafeInteger)
      || q.observedAtMs > nowMs || nowMs - q.observedAtMs > POLICY_V1.freshnessMs || q.usableMs < 0
      || q.scopeMatches !== true || q.estimateKind !== 'p95' || q.hardCommitmentRequired === true) return [];
    const remaining = paymentMs + admissionMs + q.usableMs + deliveryMs;
    if (nowMs + remaining > deadlineMs || q.expiresAtMs < nowMs + paymentMs + admissionMs + POLICY_V1.clockSkewMs) return [];
    const max = uint(q.serviceMaximumNano) + uint(q.routeMaximumNano);
    if (uint(q.serviceMaximumNano) > bid || max > allocation) return [];
    const expected = uint(q.expectedServiceNano) + uint(q.routeMaximumNano);
    requireThat(uint(q.expectedServiceNano) <= uint(q.serviceMaximumNano), 'invalid_cost_forecast');
    const slack = deadlineMs - nowMs;
    const urgency = remaining * 2 >= slack ? 4n : 1n;
    const totalMs = nowMs - startedAtMs + remaining;
    const score = expected + lambda * urgency * BigInt(totalMs) + uint(q.riskNano);
    return [{ id: q.id, score, totalMs, max, urgency }];
  }).sort((a, b) => a.score < b.score ? -1 : a.score > b.score ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return candidates.length ? { action: 'accept', id: candidates[0].id, version: POLICY_V1.version,
    scoreNano: String(candidates[0].score), endToEndMs: candidates[0].totalMs,
    reserveNano: String(candidates[0].max), urgencyMultiplier: String(candidates[0].urgency) }
    : { action: 'wait', reason: 'no_eligible_quote', version: POLICY_V1.version };
}
