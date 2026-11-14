import {useState} from 'react';
import {nanoUsd, parseNanoUsd} from './task-api';
import type {AgentSession, TaskStatus, Call} from './task-api';

function Bid({call, maximum, change}: {call: Call; maximum: string; change(call: Call, action: string, bid?: string): Promise<void>}) {
  const [value, setValue] = useState(nanoUsd(call.bid_nano).slice(1));
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function submit(action: string) {
    const bid = parseNanoUsd(value);
    if (action === 'revise_bid' && (!bid || BigInt(bid) > BigInt(maximum))) { setError('Bid must be positive and within the authorized call cap.'); return; }
    setBusy(true); setError('');
    try { await change(call, action, bid ?? undefined); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return <div className="bid-control"><label>bid USD<input aria-label="Bid USD" value={value} inputMode="decimal" onChange={e => setValue(e.target.value)} /></label>
    <button className="outline-button" disabled={busy} onClick={() => void submit('revise_bid')}>set manual bid</button>
    <button className="outline-button" disabled={busy || !call.manual} onClick={() => void submit('resume_auto')}>resume auto</button>
    <button className="outline-button" disabled={busy} onClick={() => void submit('cancel')}>cancel bid</button>
    {error && <span role="alert">{error}</span>}
  </div>;
}
export function TaskActivity({open, session, status, toggle, change}: {
  open: boolean; session?: AgentSession; status?: TaskStatus; toggle(): void;
  change(call: Call, action: string, bid?: string): Promise<void>;
}) {
  const [view, setView] = useState<'orders' | 'workspace'>('orders');
  return <section className={`provider-stats task-activity ${open ? 'stats-expanded' : ''}`} aria-label="Task activity">
    <div className="stats-heading"><button className="stats-heading-toggle" aria-expanded={open} onClick={toggle}>{open ? '⌄' : '›'} activity</button>
      <span className="stats-provider-name">{session?.agent_id ?? 'workspace'} · {session?.state ?? 'not connected'}</span>
      <span className="stats-source">server ledger · controlled</span>
      {session && <span className="activity-budget">spent {nanoUsd(session.spent_nano)} · reserved {nanoUsd(session.reserved_nano)} · cap {nanoUsd(session.budget_nano)}</span>}
    </div>
    {open && <div className="activity-body"><div className="activity-tabs" role="tablist" aria-label="Activity views">
      <button role="tab" aria-selected={view === 'orders'} onClick={() => setView('orders')}>orders & bids</button>
      <button role="tab" aria-selected={view === 'workspace'} onClick={() => setView('workspace')}>workspace</button>
    </div>
      {view === 'workspace' ? <div role="tabpanel" className="workspace-files">{status ? Object.entries(status.workspace).map(([path, content]) => <details key={path} open={path.endsWith('/result.txt')}><summary>{path}</summary><pre>{content}</pre></details>) : <p>No task workspace loaded.</p>}</div>
        : <div role="tabpanel">{status?.calls.map(call => <div className="activity-call" key={call.id}><span>{call.state} · {nanoUsd(call.bid_nano)} · {call.manual ? 'manual' : 'auto'}</span><span>{call.decision?.result.reason?.replaceAll('_', ' ')}</span>
          {call.state === 'bidding' && <Bid call={call} maximum={status.task.hard_bid_nano} change={change} />}
        </div>)}
          {!!status?.orders.length && <div className="order-table"><table><caption>Virtual native NEAR principal · yoctoNEAR</caption><thead><tr><th>order</th><th>received</th><th>charged</th><th>held</th><th>refund pending</th><th>refunded</th></tr></thead>
            <tbody>{status.orders.map((order, i) => <tr key={i}><th>{order.state}</th>{(['P', 'C', 'H', 'W', 'R'] as const).map(k => <td key={k}>{order.principal[k]}</td>)}</tr>)}</tbody></table></div>}
          {!status?.calls.length && <p className="dialog-note">No inference orders yet. Provider telemetry and hardware verification are not connected to this controlled task.</p>}
        </div>}
    </div>}
  </section>;
}
