import type { Buyer } from './model';
import type { WalletState } from './wallet-api';

const rawAmount = (value: unknown): value is string => typeof value === 'string' && /^\d{1,80}$/.test(value);
export const formatAtomic = (raw: string, symbol: string) => {
  const amount = BigInt(raw), fraction = String(amount % 1_000_000n).padStart(6, '0').replace(/0+$/, '').padEnd(2, '0');
  const value = `${amount / 1_000_000n}.${fraction}`;
  return symbol === 'USD' ? `$${value}` : `${value} ${symbol}`;
};

// Wallet balances, local task limits, and settlement are separate authorities.
// Neither planned principal nor a balance difference establishes actual spend.
export function summarizeMoney(wallet: WalletState, buyers: Pick<Buyer, 'id' | 'budgetMicros'>[], preview: boolean, now = Date.now()) {
  const taskBudgetMicros = buyers.length && buyers.every(b => Number.isSafeInteger(b.budgetMicros) && b.budgetMicros > 0)
    ? buyers.reduce((sum, b) => sum + BigInt(b.budgetMicros), 0n).toString() : null;
  const config = wallet.config, owner = wallet.owner, plan = wallet.allocations.at(-1);
  const base = { taskBudgetMicros, symbol: config?.symbol ?? null, availableRaw: null as string | null,
    plannedPrincipalRaw: null as string | null, observedAt: null as number | null, coverage: 0, total: buyers.length,
    state: preview ? 'preview' : !owner ? 'disconnected' : 'unobserved' };
  if (preview || !owner || !config?.configured || !plan || plan.ownerAccount !== owner.account_id ||
    plan.ownerPublicKey !== owner.public_key || plan.assetId !== config.assetId || plan.symbol !== config.symbol) return base;
  const ids = new Set(buyers.map(buyer => buyer.id));
  const entries = plan.buyers.filter(buyer => ids.has(buyer.id));
  const known = entries.filter(buyer => rawAmount(buyer.availableRaw) && buyer.balanceObservedAt &&
    Number.isFinite(Date.parse(buyer.balanceObservedAt)) && Date.parse(buyer.balanceObservedAt) <= now + 5000);
  const observedAt = known.length ? Math.min(...known.map(buyer => Date.parse(buyer.balanceObservedAt!))) : null;
  const result = { ...base, plannedPrincipalRaw: rawAmount(plan.totalRaw) ? plan.totalRaw : null,
    observedAt, coverage: known.length, state: 'partial' };
  if (!buyers.length || ids.size !== buyers.length || entries.length !== buyers.length ||
    new Set(entries.map(buyer => buyer.id)).size !== buyers.length || known.length !== buyers.length) return result;
  if (now - observedAt! > 120_000) return { ...result, state: 'stale' };
  return { ...result, availableRaw: known.reduce((sum, buyer) => sum + BigInt(buyer.availableRaw), 0n).toString(), state: 'snapshot' };
}
