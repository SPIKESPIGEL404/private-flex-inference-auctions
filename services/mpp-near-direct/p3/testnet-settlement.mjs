import { hash, requireThat } from '../contract.mjs';
import { refundPlan } from '../near.mjs';

// Test-only order authority shared by the HTTP protocol case and interrupted
// cleanup. One settlement claim and one refund operation belong to each order.
export function deliveredResponse(store, id, response) {
  requireThat(typeof response?.body === 'string' && response.headers && typeof response.headers === 'object', 'testnet_original_response_required');
  return store.transaction(() => {
    const order = store.get('testnet-mpp-order', id);
    requireThat(order && order.settlementKind !== 'abandoned' && !order.cleanup, 'testnet_order_already_abandoned');
    requireThat(!order.response || hash(order.response) === hash(response), 'original_response_conflict');
    const next = { ...order, settlementKind: 'delivered', response };
    store.put('testnet-mpp-order', id, 'testnet', next); return next;
  });
}
export function claimAbandoned(store, id, now) {
  return store.transaction(() => {
    const current = store.get('testnet-mpp-order', id);
    if (!current || current.response || current.settlementKind === 'delivered' || now <= current.request.expiresAtMs) return null;
    requireThat(!current.settlementKind || current.settlementKind === 'abandoned', 'testnet_settlement_conflict');
    const next = { ...current, settlementKind: 'abandoned' };
    store.put('testnet-mpp-order', id, 'testnet', next); return next;
  });
}
export function originalRefundPlan(store, id, { kind, amount, createdAtMs }) {
  return store.transaction(() => {
    const current = store.get('testnet-mpp-order', id);
    requireThat(['abandoned', 'delivered'].includes(kind) && current?.settlementKind === kind
      && (kind === 'abandoned' ? !current.response : !!current.response), 'testnet_settlement_claim_required');
    requireThat(kind !== 'abandoned' || amount === current.request.amount, 'testnet_abandoned_full_refund_required');
    const operationId = 'refund-' + id;
    const old = store.get('testnet-mpp-refund-plan', operationId);
    if (old) { requireThat(old.orderRef === id && old.amount === amount, 'original_refund_amount_conflict'); return old; }
    const plan = refundPlan({ orderRef: id, binding: current.request, amount, refundableYocto: amount, operationId, createdAtMs });
    store.put('testnet-mpp-refund-plan', operationId, 'testnet', plan); return plan;
  });
}
export function recordCleanup(store, id, evidence) {
  return store.transaction(() => {
    const current = store.get('testnet-mpp-order', id);
    requireThat(current?.settlementKind === 'abandoned' && !current.response, 'testnet_cleanup_claim_lost');
    const next = { ...current, cleanup: evidence }; store.put('testnet-mpp-order', id, 'testnet', next); return next;
  });
}
