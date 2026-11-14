import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@wterm/react';
import { GhosttyCore } from '@wterm/ghostty';
import ghosttyWasm from '@wterm/ghostty/ghostty-vt.wasm?url';
import type { WTerm } from '@wterm/dom';
import { BuyerRuntime } from './runtime';
import { loadBrowserSession, maxBuyers, money, parseBudget, resizeSession, sessionConfigKey, tilePanes } from './model';
import type { Buyer, BuyerStatus } from './model';

type Dialog = 'settings' | 'help' | 'preview' | null;
type Registry = (id: string, runtime?: BuyerRuntime) => void;

function BuyerPane({ buyer, selected, status, onSelect, onStatus, onUsage, onRuntime, onInput }: {
  buyer: Buyer; selected: boolean; status: BuyerStatus;
  onSelect: (id: string) => void; onStatus: (id: string, value: BuyerStatus) => void;
  onUsage: (id: string, micros: number, turns: number) => void;
  onRuntime: Registry; onInput: (id: string, value: string) => boolean;
}) {
  const [core, setCore] = useState<GhosttyCore>();
  const runtime = useRef<BuyerRuntime | null>(null);
  const currentBuyer = useRef(buyer);
  useEffect(() => { currentBuyer.current = buyer; runtime.current?.update(buyer); }, [buyer]);
  useEffect(() => {
    let cancelled = false;
    onStatus(buyer.id, { phase: 'booting' });
    void GhosttyCore.load({ wasmPath: ghosttyWasm, backgroundColor: '#000000', foregroundColor: '#ededed',
      scrollbackLines: 1200, imageStorageLimit: 0 }).then(value => {
      if (cancelled) value.dispose(); else setCore(value);
    }).catch(() => { if (!cancelled) onStatus(buyer.id, { phase: 'error', detail: 'Terminal could not load. Refresh to try again.' }); });
    return () => { cancelled = true; runtime.current?.dispose(); onRuntime(buyer.id); };
  }, [buyer.id, onStatus, onRuntime]);
  const ready = useCallback((wt: WTerm) => {
    if (runtime.current) return;
    const controller = new BuyerRuntime(currentBuyer.current, value => onStatus(buyer.id, value),
      (micros, turns) => onUsage(buyer.id, micros, turns));
    runtime.current = controller;
    void controller.mount(bytes => wt.write(bytes), () => ({ cols: wt.cols, rows: wt.rows }))
      .then(mounted => { if (mounted) onRuntime(buyer.id, controller); })
      .catch(error => onStatus(buyer.id, { phase: 'error', detail: error instanceof Error ? error.message : 'Session could not start.' }));
  }, [buyer.id, onRuntime, onStatus, onUsage]);
  return <section className={`buyer-terminal ${selected ? 'is-selected' : ''}`} aria-label={`Buyer ${buyer.number} terminal`}
    onPointerDown={() => onSelect(buyer.id)} onFocusCapture={() => onSelect(buyer.id)}>
    {core ? <Terminal core={core} autoResize onReady={ready}
      onData={data => { if (!onInput(buyer.id, data)) runtime.current?.input(data); }}
      onResize={() => runtime.current?.resize()} scrollbackLines={1200}
      onError={() => onStatus(buyer.id, { phase: 'error', detail: 'Terminal rendering failed.' })} />
      : <div className="terminal-loading">starting fx<span className="cursor">▌</span></div>}
    {status.phase === 'error' && <div className="terminal-error" role="alert">! {status.detail}</div>}
  </section>;
}

function Settings({ buyer, onClose, onSave }: { buyer: Buyer; onClose: () => void;
  onSave: (task: string, budget: number, scenario: Buyer['scenario'], all: boolean) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [task, setTask] = useState(buyer.task);
  const [budget, setBudget] = useState(String(buyer.budgetMicros / 1e6));
  const [scenario, setScenario] = useState(buyer.scenario);
  const [all, setAll] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { ref.current?.showModal(); ref.current?.querySelector('textarea')?.focus(); }, []);
  return <dialog ref={ref} aria-labelledby="settings-title" onCancel={onClose}
    onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
    <form onChange={() => setError('')} onSubmit={e => {
      e.preventDefault(); const amount = parseBudget(budget);
      if (!task.trim() || task.length > 2000) { setError('Enter a task of 1–2,000 characters.'); return; }
      if (amount === null) { setError('Budget must be $0.000001–$100, with at most six decimal places.'); return; }
      onSave(task.trim(), amount, scenario, all);
    }}>
      <div className="dialog-heading"><h1 id="settings-title">buyer-{String(buyer.number).padStart(2, '0')}</h1>
        <button type="button" className="close-button" aria-label="Close settings" onClick={onClose}>×</button></div>
      <label htmlFor="task">task</label>
      <textarea id="task" rows={4} maxLength={2000} value={task} onChange={e => setTask(e.target.value)} required />
      <label htmlFor="budget">budget <span>USD · preview</span></label>
      <div className="money-input"><span>$</span><input id="budget" value={budget} onChange={e => setBudget(e.target.value)} inputMode="decimal" required /></div>
      <div className="setting-summary"><span>simulated usage</span><span>{money(buyer.previewMicros)}</span></div>
      <label className="checkbox-label"><input type="checkbox" checked={all} onChange={e => setAll(e.target.checked)} />apply to all buyers</label>
      <details className="advanced"><summary>preview response</summary>
        <select aria-label="Preview response" value={scenario} onChange={e => setScenario(e.target.value as Buyer['scenario'])}>
          <option value="complete">complete</option><option value="waiting">waiting for supply</option><option value="limit">budget stop</option>
        </select>
      </details>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-footer"><button type="button" className="outline-button" onClick={onClose}>cancel</button><button className="solid-button" type="submit">apply ↵</button></div>
    </form>
  </dialog>;
}

function Info({ kind, onClose }: { kind: 'help' | 'preview'; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  return <dialog ref={ref} className="info-dialog" aria-labelledby="info-title" onCancel={onClose}
    onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div className="dialog-heading"><h1 id="info-title">{kind === 'help' ? 'keys' : 'preview'}</h1>
      <button className="close-button" aria-label="Close information" onClick={onClose}>×</button></div>
    {kind === 'help' ? <>
      <dl className="key-list"><dt>configure buyer</dt><dd>⌘ / Ctrl K</dd><dt>run buyer</dt><dd>⌘ / Ctrl ↵</dd>
        <dt>switch pane</dt><dd>Ctrl B ← / →</dd><dt>zoom / restore</dt><dd>Ctrl B Z</dd>
        <dt>add pane</dt><dd>Ctrl B %</dd><dt>close last pane</dt><dd>Ctrl B X</dd>
        <dt>fx commands</dt><dd>/help</dd></dl>
      <p>Set the buyer count in the header. Panes retile automatically. Reducing the count pauses the extra buyers; increasing it restores them.</p>
    </> : <>
      <p>Real fx terminals and independent just-bash workspaces. Responses and purchase states are scripted fixtures.</p>
      <dl className="key-list"><dt>market</dt><dd>not connected</dd><dt>provider calls</dt><dd>0</dd>
        <dt>actual spend</dt><dd>$0.00</dd><dt>attestation / signatures</dt><dd>not checked</dd></dl>
      <p>Per-call Market procurement is deferred. This preview contains no provider credentials.</p>
    </>}
  </dialog>;
}

export default function App() {
  const [session, setSession] = useState(loadBrowserSession);
  const buyers = session.buyers;
  const [statuses, setStatuses] = useState<Record<string, BuyerStatus>>({});
  const [selected, setSelected] = useState(() => buyers[0].id);
  const [zoomed, setZoomed] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [countDraft, setCountDraft] = useState(String(buyers.length));
  const [storageError, setStorageError] = useState(false);
  const workspace = useRef<HTMLElement>(null);
  const [size, setSize] = useState({ width: 1280, height: 720 });
  const runtimes = useRef(new Map<string, BuyerRuntime>());
  const prefix = useRef(0);
  const status = useCallback((id: string, value: BuyerStatus) => setStatuses(old => ({ ...old, [id]: value })), []);
  const usage = useCallback((id: string, previewMicros: number, turns: number) => setSession(old => ({ ...old,
    buyers: old.buyers.map(b => b.id === id ? { ...b, previewMicros, turns } : b) })), []);
  const register = useCallback<Registry>((id, runtime) => {
    if (runtime) runtimes.current.set(id, runtime); else runtimes.current.delete(id);
  }, []);
  const focusBuyer = useCallback((id: string) => {
    setSelected(id); setZoomed(old => old ? id : null);
    requestAnimationFrame(() => document.getElementById(`pane-${id}`)?.querySelector<HTMLElement>('textarea')?.focus());
  }, []);
  const zoom = useCallback((id: string) => { setSelected(id); setZoomed(old => old === id ? null : id); }, []);
  const resize = useCallback((count: number) => {
    if (!Number.isInteger(count) || count < 1 || count > maxBuyers) return;
    for (const buyer of buyers.slice(count)) runtimes.current.get(buyer.id)?.pause();
    setSession(old => resizeSession(old, count)); setZoomed(null);
  }, [buyers]);
  const nextPane = useCallback((id: string, direction: number) => {
    const index = buyers.findIndex(b => b.id === id);
    focusBuyer(buyers[(index + direction + buyers.length) % buyers.length].id);
  }, [buyers, focusBuyer]);
  const prefixAction = useCallback((id: string, key: string) => {
    if (key === 'z') zoom(id);
    else if (key === '%' && buyers.length < maxBuyers) resize(buyers.length + 1);
    else if (key === 'x' && buyers.length > 1) resize(buyers.length - 1);
    else if (key === 'ArrowRight' || key === '\x1b[C') nextPane(id, 1);
    else if (key === 'ArrowLeft' || key === '\x1b[D') nextPane(id, -1);
    else return false;
    return true;
  }, [buyers.length, resize, zoom, nextPane]);
  const terminalInput = useCallback((id: string, data: string) => {
    if (data === '\x02') { prefix.current = Date.now(); return true; }
    if (Date.now() - prefix.current >= 10000) return false;
    prefix.current = 0; return prefixAction(id, data);
  }, [prefixAction]);
  useEffect(() => {
    try { sessionStorage.setItem(sessionConfigKey, JSON.stringify(session)); } catch { setStorageError(true); }
  }, [session]);
  useEffect(() => { setCountDraft(String(buyers.length)); }, [buyers.length]);
  useEffect(() => {
    if (!buyers.some(b => b.id === selected)) setSelected(buyers[0].id);
    if (zoomed && !buyers.some(b => b.id === zoomed)) setZoomed(null);
  }, [buyers, selected, zoomed]);
  useEffect(() => {
    const element = workspace.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) setSize(old => old.width === width && old.height === height ? old : { width, height });
    });
    observer.observe(element); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const keydown = (e: KeyboardEvent) => {
      if (dialog) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault(); e.stopPropagation(); setDialog('settings'); return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault(); e.stopPropagation(); runtimes.current.get(selected)?.start(); return;
      }
      if (((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') || e.key === '\x02') {
        e.preventDefault(); e.stopPropagation(); prefix.current = Date.now(); return;
      }
      if (Date.now() - prefix.current < 10000) {
        prefix.current = 0;
        if (prefixAction(selected, e.key.length === 1 ? e.key.toLowerCase() : e.key)) { e.preventDefault(); e.stopPropagation(); }
      }
    };
    window.addEventListener('keydown', keydown, true); return () => window.removeEventListener('keydown', keydown, true);
  }, [selected, dialog, prefixAction]);
  const current = buyers.find(b => b.id === selected) ?? buyers[0];
  const currentStatus = statuses[current.id]?.phase ?? 'booting';
  const running = buyers.some(b => statuses[b.id]?.phase === 'running');
  const ready = buyers.some(b => statuses[b.id] && !['booting', 'error'].includes(statuses[b.id].phase));
  const layout = tilePanes(buyers.length, size.width, size.height);
  return <div className="app-shell">
    <header className="app-header">
      <div className="topbar">
        <a className="wordmark" href="./" aria-label="Private Market"><span className="brand-mark">∕</span> private market</a>
        <nav aria-label="Main navigation"><span className="nav-current">try</span>
          <a href="https://github.com/SPIKESPIGEL404/private-flex-inference-auctions" target="_blank" rel="noreferrer">source ↗</a></nav>
        <div className="header-controls">
          <button className="preview-link" onClick={() => setDialog('preview')}>preview</button>
          <label className="pane-count">buyers <input aria-label="Buyer count" type="number" min={1} max={maxBuyers} value={countDraft}
            onChange={e => { setCountDraft(e.target.value); if (/^[1-8]$/.test(e.target.value)) resize(Number(e.target.value)); }}
            onBlur={() => setCountDraft(String(buyers.length))} /></label>
          <button className="outline-button" onClick={() => setDialog('settings')}>configure <kbd>⌘K</kbd></button>
          <button className="outline-button" disabled={!ready} onClick={() => {
            if (running) for (const b of buyers) runtimes.current.get(b.id)?.pause();
            else for (const b of buyers) runtimes.current.get(b.id)?.start();
          }}>{running ? 'pause all' : 'run all'}</button>
          <button className="help-button" aria-label="Keyboard shortcuts" onClick={() => setDialog('help')}>?</button>
        </div>
      </div>
      <div className="sessionbar">
        <span className="session-name">[market]</span>
        <div className="window-list" aria-label="Buyer sessions">{buyers.map(b => <button key={b.id}
          className={current.id === b.id ? 'window-current' : ''} aria-label={`Select buyer ${b.number}`}
          aria-pressed={current.id === b.id} onClick={() => focusBuyer(b.id)} onDoubleClick={() => zoom(b.id)}>
          {b.number}:fx{current.id === b.id ? '*' : ''}</button>)}</div>
        <div className="session-actions">{storageError && <span className="storage-error">not saved</span>}
          <button className="selected-state" aria-label="Configure selected buyer" onClick={() => setDialog('settings')}>buyer-{String(current.number).padStart(2, '0')} · {currentStatus}</button>
          <button className="zoom-button" aria-label={zoomed ? 'Restore panes' : 'Zoom selected pane'} onClick={() => zoom(current.id)}>{zoomed ? 'unzoom' : 'zoom'}</button>
        </div>
      </div>
    </header>
    <main className="terminal-workspace" ref={workspace} aria-label="Buyer terminals">{buyers.map((buyer, index) => {
      const rect = layout[index];
      return <div key={buyer.id} id={`pane-${buyer.id}`} className={`pane-slot ${zoomed === buyer.id ? 'is-zoomed' : ''} ${zoomed && zoomed !== buyer.id ? 'is-hidden' : ''}`}
        style={{ left: `${rect.left}%`, top: `${rect.top}%`, width: `${rect.width}%`, height: `${rect.height}%`,
          borderRightWidth: rect.rightEdge ? 0 : 1, borderBottomWidth: rect.bottomEdge ? 0 : 1 }}>
        <BuyerPane buyer={buyer} selected={selected === buyer.id} status={statuses[buyer.id] ?? { phase: 'booting' }}
          onSelect={setSelected} onStatus={status} onUsage={usage} onRuntime={register} onInput={terminalInput} />
      </div>;
    })}</main>
    {dialog === 'settings' && <Settings key={current.id} buyer={current} onClose={() => setDialog(null)} onSave={(task, budgetMicros, scenario, all) => {
      for (const b of buyers) if (all || b.id === current.id) runtimes.current.get(b.id)?.pause();
      const update = (b: Buyer) => all || b.id === current.id ? { ...b, task, budgetMicros, scenario, previewMicros: Math.min(b.previewMicros, budgetMicros) } : b;
      setSession(old => ({ buyers: old.buyers.map(update), parked: old.parked.map(update) })); setDialog(null);
    }} />}
    {(dialog === 'help' || dialog === 'preview') && <Info kind={dialog} onClose={() => setDialog(null)} />}
  </div>;
}
