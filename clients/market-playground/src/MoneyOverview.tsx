import { useEffect, useId, useState } from 'react';
import type { Buyer } from './model';
import type { WalletState } from './wallet-api';
import { formatAtomic, summarizeMoney } from './money';

export function MoneyOverview({ wallet, buyers, preview, onWallet, onRefresh }: {
  wallet: WalletState; buyers: Buyer[]; preview: boolean;
  onWallet: () => void; onRefresh: () => void;
}) {
  const [open, setOpen] = useState(true), [now, setNow] = useState(Date.now);
  const id = useId();
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 10_000); return () => clearInterval(timer); }, []);
  const summary = summarizeMoney(wallet, buyers, preview, now);
  const available = summary.availableRaw === null || !summary.symbol ? '—' : formatAtomic(summary.availableRaw, summary.symbol);
  const budget = summary.taskBudgetMicros === null ? '—' : formatAtomic(summary.taskBudgetMicros, 'USD');
  const plan = wallet.allocations.at(-1);
  const status = preview ? 'preview · no real funds' : wallet.loading ? 'loading wallet…'
    : wallet.error ? 'wallet unavailable' : !wallet.config?.configured ? 'wallet service awaiting configuration'
    : !wallet.owner ? 'connect wallet' : summary.state === 'snapshot' ? 'wallet snapshot'
    : summary.state === 'stale' ? 'snapshot expired · refresh balances' : 'balance unavailable';
  const groups = [
    { name: 'Agent funds', cards: [
      ['Available', available, summary.state === 'snapshot' ? 'observed wallet balance' : `${summary.coverage}/${summary.total} balances checked`],
      ['Task limits', budget, 'configured USD · not funds'],
      ['Spent', '—', 'settlement feed pending'],
      ['Held', '—', 'settlement feed pending'],
    ] },
    { name: 'Seller economics', cards: [
      ['Revenue', '—', 'USD · settlement pending'], ['GPU cost', '—', 'USD · billing pending'],
      ['Refunds', '—', 'USD · settlement pending'], ['Net earnings', '—', 'USD · costs + settlement pending'],
    ] },
  ];
  return <section className={`money-overview ${open ? 'money-expanded' : 'money-collapsed'}`} aria-label="Money overview">
    <div className="money-heading">
      <button className="money-toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}>[money] {open ? '⌄' : '⌃'}</button>
      <span className="money-state" role="status">{status}</span>
      {!open ? <span className="money-collapsed-summary">available {available} · task limits {budget}</span> : null}
      <div className="money-actions">
        <button onClick={onRefresh} disabled={preview || wallet.busy || !wallet.owner || !plan || !wallet.config?.configured}>refresh balances</button>
        <button onClick={onWallet}>{wallet.owner ? 'wallets / funding' : 'connect wallet'}</button>
      </div>
    </div>
    <div id={id} className="money-content" hidden={!open}>
      <div className="money-groups" tabIndex={0} role="group" aria-label="Agent funds and seller economics; scroll horizontally on small screens">{groups.map(group => <div className="money-group" key={group.name}>
        <div className="money-group-label">{group.name}<span className="money-scroll-hint">scroll → for more</span></div>
        <dl className="money-cards">{group.cards.map(([label, value, source]) => <div key={label}>
          <dt>{label}</dt><dd title={value}>{value}</dd><dd className="money-card-source">{source}</dd>
        </div>)}</dl>
      </div>)}</div>
      <div className="money-sources">
        <span>{summary.observedAt !== null ? `oldest wallet observation: ${new Date(summary.observedAt).toLocaleTimeString()}` : 'Wallet balances require an observed, owner-matched snapshot.'}
          {summary.state === 'stale' ? ' · refresh required' : ''}</span>
        <span>Seller settlement / billing not connected · missing amounts stay —</span>
      </div>
    </div>
  </section>;
}
