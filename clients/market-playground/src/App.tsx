import {useCallback, useEffect, useRef, useState, useSyncExternalStore} from 'react';
import {TaskPane} from './TaskPane';
import type {PaneHandle} from './TaskPane';
import {Modal, NewTask, TaskSettings} from './WorkspaceDialogs';
import {TaskActivity} from './TaskActivity';
import {SupplyAvailability} from './SupplyAvailability';
import {NativeWalletController} from './native-wallet';
import {NativeWallets} from './NativeWallets';
import {WalletController} from './wallet-api';
import {WalletSetup} from './WalletSetup';
import {AttestationPanel} from './AttestationPanel';
import {loadBrowserSession, resizeSession, tilePanes} from './model';
import type {Buyer} from './model';
import {taskApi, TaskApiError, nanoUsd} from './task-api';
import type {AgentSession, AgentLimit, Call, Capabilities, Preference, TaskStatus} from './task-api';

interface Hosted {ownerScope: string; agents: AgentSession[]; limits: AgentLimit[]}
type Dialog = 'settings' | 'new' | 'wallet' | 'help' | 'mode' | null;
const layoutKey = (scope: string) => 'private-market.workspace.layout.v1:' + scope;

export default function App() {
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [connection, setConnection] = useState('loading');
  const [hosted, setHosted] = useState<Hosted | null>(null);
  const [nativeController] = useState(() => new NativeWalletController());
  const native = useSyncExternalStore(nativeController.subscribe,nativeController.snapshot);
  const [walletController] = useState(() => new WalletController());
  const wallet = useSyncExternalStore(walletController.subscribe, walletController.snapshot);
  const [draft, setDraft] = useState(() => loadBrowserSession('disconnected'));
  const walletScope = wallet.owner ? wallet.owner.account_id + ':' + wallet.owner.public_key : 'disconnected';
  const allocation = wallet.allocations.at(-1);
  const [visible, setVisible] = useState<string[]>([]), [selected, setSelected] = useState('');
  const [zoomed, setZoomed] = useState<string | null>(null), [countDraft, setCountDraft] = useState('2');
  const [dialog, setDialog] = useState<Dialog>(null), [newPrompt, setNewPrompt] = useState('');
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [viewEpoch, setViewEpoch] = useState(0), [details, setDetails] = useState<Record<string, TaskStatus>>({});
  const [ready, setReady] = useState<Set<string>>(() => new Set()), [activity, setActivity] = useState(false);
  const epoch = useRef(0), switching = useRef(false), ownerScope = useRef('');
  const handles = useRef(new Map<string, PaneHandle>()), prefix = useRef(0);
  const workspace = useRef<HTMLElement>(null), [size, setSize] = useState({width: 1280, height: 720});
  const tasks = capabilities?.tasks === true;
  const buyers: Buyer[] = allocation ? allocation.buyers.map((b, i) => draft.buyers.find(x => x.id === b.id) ?? {
    id: b.id, number: i + 1, task: 'Complete the configured task.', budgetMicros: 10000, scenario: 'complete', previewMicros: 0, turns: 0,
  }) : draft.buyers;
  const sessions: AgentSession[] = tasks ? hosted?.agents ?? [] : capabilities ? buyers.map((b, i) => ({
    id: b.id, agent_id: 'agent-' + (i + 1), payer: allocation?.buyers[i]?.wallet ?? 'wallet not prepared',
    state: allocation?.buyers[i]?.phase ?? 'wallet setup', paused: true, task_id: b.id, revision: '0', generation: '0',
    preference: 'balanced', budget_nano: String(b.budgetMicros * 1000), reserved_nano: '0', spent_nano: '0', prompt: b.task, deadline_ms: '0',
  })) : [];
  const shown = visible.map(id => sessions.find(s => s.id === id)).filter((s): s is AgentSession => !!s);
  const current = sessions.find(s => s.id === selected) ?? shown[0];
  const authenticated = tasks ? hosted !== null : capabilities?.walletSetup === true;

  const clearOwner = useCallback((force = false) => {
    if (!ownerScope.current && !force) return;
    epoch.current++; ownerScope.current = ''; setViewEpoch(epoch.current); setHosted(null);
    setDetails({}); setReady(new Set()); setVisible([]); setSelected(''); setZoomed(null); setDialog(null);
  }, []);
  const refresh = useCallback(async () => {
    if (switching.current) return;
    const requestEpoch = epoch.current;
    try {
      const value = await taskApi<Hosted>('agents');
      if (requestEpoch !== epoch.current || switching.current) return;
      if (ownerScope.current !== value.ownerScope) {
        epoch.current++; setViewEpoch(epoch.current); setDetails({}); setReady(new Set()); setDialog(null); setZoomed(null);
        let ids = value.agents.map(s => s.id), chosen = ids[0] ?? '';
        try {
          const saved = JSON.parse(sessionStorage.getItem(layoutKey(value.ownerScope)) ?? 'null');
          if (Array.isArray(saved?.visible)) { const valid = [...new Set<string>(saved.visible)].filter(id => ids.includes(id)); if (valid.length) ids = valid; }
          chosen = ids.includes(saved?.selected) ? saved.selected : ids[0] ?? '';
        } catch { /* Layout preferences never authorize a session. */ }
        ownerScope.current = value.ownerScope; setVisible(ids); setSelected(chosen);
      }
      setHosted(value); setError('');
    } catch (e) {
      if (requestEpoch !== epoch.current || switching.current) return;
      if (e instanceof TaskApiError && ['unauthorized','login_required'].includes(e.code)) { clearOwner(); void nativeController.load(); }
      else setError('Workspace unavailable. Existing tasks and orders are retained.');
    }
  }, [clearOwner,nativeController]);
  const discover = useCallback(async () => {
    setConnection('loading'); setError('');
    try {
      const value = await taskApi<Capabilities>('capabilities');
      if (value.version !== 1 || value.realInferencePayments !== false
        || !((value.mode === 'controlled' && value.tasks && !value.walletSetup) || (value.mode === 'wallet-setup' && !value.tasks && value.walletSetup))) throw new Error('unsupported workspace');
      setCapabilities(value); setConnection('ready');
    } catch { setConnection('error'); setError('Workspace API unavailable. No task or payment was started.'); }
  }, []);
  useEffect(() => { void discover(); }, [discover]);
  useEffect(() => {
    if (!capabilities) return;
    if (!capabilities.tasks) { void walletController.load(); return; }
    if(capabilities.nativeWallets && !native.owner) return;
    let disposed = false, timer: ReturnType<typeof setTimeout>;
    async function poll() { await refresh(); if (!disposed) timer = setTimeout(() => void poll(), 1000); }
    void poll(); return () => { disposed = true; clearTimeout(timer); };
  }, [capabilities, refresh, walletController, native.owner]);
  useEffect(()=>{if(capabilities?.nativeWallets)void nativeController.load();},[capabilities?.nativeWallets,nativeController]);
  useEffect(()=>{if(capabilities?.nativeWallets&&!native.owner)clearOwner();},[native.owner,capabilities?.nativeWallets,clearOwner]);
  useEffect(() => {
    if (capabilities?.walletSetup !== true) return;
    const next = loadBrowserSession(walletScope); setDraft(next); setVisible(next.buyers.map(b => b.id));
    setSelected(next.buyers[0].id); setZoomed(null); setDetails({}); setReady(new Set());
  }, [walletScope, capabilities?.walletSetup]);
  useEffect(() => {
    if (tasks || !allocation) return;
    const ids = allocation.buyers.map(b => b.id); setVisible(ids); setSelected(ids[0] ?? '');
    setDraft(old => ({buyers: allocation.buyers.map((b, i) => old.buyers.find(x => x.id === b.id) ?? {
      id: b.id, number: i + 1, task: 'Complete the configured task.', budgetMicros: 10000, scenario: 'complete', previewMicros: 0, turns: 0,
    }), parked: []}));
  }, [tasks, allocation]);
  useEffect(() => {
    if (!hosted || switching.current) return;
    try { sessionStorage.setItem(layoutKey(hosted.ownerScope), JSON.stringify({visible, selected})); } catch { /* Optional, owner-scoped layout only. */ }
  }, [hosted, visible, selected]);
  useEffect(() => { setCountDraft(String(shown.length)); }, [shown.length]);
  useEffect(() => {
    const element = workspace.current; if (!element) return;
    const observer = new ResizeObserver(([entry]) => { const {width, height} = entry.contentRect; if (width && height) setSize({width, height}); });
    observer.observe(element); return () => observer.disconnect();
  }, []);
  const recordDetail = useCallback((id: string, value: TaskStatus) => {
    if (epoch.current === viewEpoch) setDetails(old => ({...old, [id]: value}));
  }, [viewEpoch]);
  const paneReady = useCallback((id: string) => {
    if (epoch.current === viewEpoch) setReady(old => new Set(old).add(id));
  }, [viewEpoch]);
  const focus = useCallback((id: string) => { setSelected(id); setZoomed(old => old ? id : null); handles.current.get(id)?.focus(); }, []);
  const resize = useCallback(async (count: number) => {
    if (busy || !Number.isInteger(count) || count < 1 || count > (tasks ? sessions.length : allocation ? buyers.length : 8)) return;
    const requestEpoch = epoch.current; setBusy(true); setError('');
    try {
      if (!tasks && !allocation) {
        const next = resizeSession(draft, count); setDraft(next); setVisible(next.buyers.map(b => b.id)); return;
      }
      if (count < shown.length) {
        const answers = await Promise.all(shown.slice(count).map(s => handles.current.get(s.id)?.pause() ?? Promise.resolve(false)));
        if (answers.some(x => !x)) throw new Error('Pause was not confirmed for every pane. Layout was retained.');
      }
      if (requestEpoch !== epoch.current) return;
      const ids = visible.slice(0, count);
      for (const s of sessions) if (ids.length < count && !ids.includes(s.id)) ids.push(s.id);
      setVisible(ids); setZoomed(null); if (!ids.includes(selected)) setSelected(ids[0]);
    } catch (e) { if (requestEpoch === epoch.current) setError((e as Error).message); }
    finally { if (requestEpoch === epoch.current) setBusy(false); }
  }, [busy, tasks, sessions, allocation, buyers.length, draft, shown, visible, selected]);
  const prefixAction = useCallback((id: string, key: string) => {
    if (key === 'z') { setSelected(id); setZoomed(old => old === id ? null : id); }
    else if (key === '%') void resize(shown.length + 1);
    else if (key === 'x') void resize(shown.length - 1);
    else if (['ArrowLeft', '\x1b[D', 'ArrowRight', '\x1b[C'].includes(key)) {
      const i = shown.findIndex(s => s.id === id), direction = ['ArrowLeft', '\x1b[D'].includes(key) ? -1 : 1;
      if (shown.length) focus(shown[(i + direction + shown.length) % shown.length].id);
    } else return false;
    return true;
  }, [shown, resize, focus]);
  const terminalInput = useCallback((id: string, data: string) => {
    if (data === '\x02') { prefix.current = Date.now(); return true; }
    if (Date.now() - prefix.current >= 10000) return false;
    prefix.current = 0; return prefixAction(id, data);
  }, [prefixAction]);
  useEffect(() => {
    const keydown = (e: KeyboardEvent) => {
      if (dialog || !authenticated) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); e.stopPropagation(); if (current) setDialog('settings'); return; }
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); if (tasks) void handles.current.get(selected)?.run(); else setDialog('wallet'); return; }
      if (e.ctrlKey && e.key.toLowerCase() === 'b') { e.preventDefault(); e.stopPropagation(); prefix.current = Date.now(); return; }
      if (Date.now() - prefix.current < 10000) { prefix.current = 0; if (prefixAction(selected, e.key.length === 1 ? e.key.toLowerCase() : e.key)) { e.preventDefault(); e.stopPropagation(); } }
    };
    window.addEventListener('keydown', keydown, true); return () => window.removeEventListener('keydown', keydown, true);
  }, [dialog, authenticated, current, selected, tasks, prefixAction]);
  async function login() {
    setBusy(true); setError('');
    try { await nativeController.connect(); if(nativeController.snapshot().owner)await refresh(); }
    finally { setBusy(false); }
  }
  async function logout() {
    switching.current = true; epoch.current++; setBusy(true); setError('');
    try { if(capabilities?.nativeWallets)await nativeController.disconnect(); else if (tasks) await taskApi('logout', {}); else await walletController.disconnect(); clearOwner(true); }
    catch (e) { setError((e as Error).message); setViewEpoch(epoch.current); }
    finally { switching.current = false; setBusy(false); }
  }
  function newTask(prompt = '') { setNewPrompt(prompt); setDialog(tasks ? 'new' : 'settings'); }
  const hasRunning = shown.some(s => !s.paused && s.state === 'running');
  async function runAll() { setError(''); if (hasRunning) await Promise.all(shown.map(s => handles.current.get(s.id)?.pause())); else await Promise.all(shown.map(s => handles.current.get(s.id)?.run())); }
  async function saveSettings(budget: string, preference: Preference, prompt: string) {
    if (!current) return;
    if (!tasks) {
      if (BigInt(budget) > 100_000_000_000n || BigInt(budget) % 1000n) throw new Error('Unsigned drafts support up to $100 and six decimal places.');
      setDraft(old => ({...old, buyers: old.buyers.map(b => b.id === current.id ? {...b, task: prompt, budgetMicros: Number(BigInt(budget) / 1000n)} : b)})); setDialog(null); return;
    }
    const requestEpoch = epoch.current;
    let revision = current.revision, saved = false;
    try {
      if (preference !== current.preference) {
        const r = await taskApi<{revision: string}>('sessions/' + current.id + '/control', {action: 'preference', preference, expectedRevision: revision, operation: crypto.randomUUID()}); revision = r.revision; saved = true;
      }
      if (requestEpoch !== epoch.current) throw new Error('Owner session changed.');
      if (budget !== current.budget_nano) await taskApi('sessions/' + current.id + '/control', {action: 'budget', budgetNano: budget, expectedRevision: revision, operation: crypto.randomUUID()});
      await refresh(); if (requestEpoch === epoch.current) setDialog(null);
    } catch (e) { await refresh(); throw new Error((saved ? 'Preference saved; budget update failed: ' : '') + (e as Error).message); }
  }
  async function createTask(agent: string, prompt: string, budgetNano: string, preference: Preference) {
    const requestEpoch = epoch.current;
    const result = await taskApi<{id: string}>('agents/' + agent + '/tasks', {prompt, budgetNano, preference});
    await refresh(); if (requestEpoch !== epoch.current) return;
    setVisible(old => [...new Set([...old, result.id])]); setSelected(result.id); setZoomed(null); setDialog(null);
  }
  async function changeBid(call: Call, action: string, bidNano?: string) {
    await taskApi('calls/' + call.id, {action, ...(bidNano ? {bidNano} : {}), expectedRevision: call.revision, operation: crypto.randomUUID()}, 'PATCH'); await refresh();
  }
  const layout = tilePanes(shown.length, size.width, size.height);
  return <div className="app-shell">
    <header className="app-header"><div className="topbar">
      <a className="wordmark" href="/" aria-label="Private Market"><span className="brand-mark">∕</span> private market</a>
      <nav aria-label="Main navigation"><span className="nav-current">try</span><a href="/proposal">proposal</a><a href="https://github.com/SPIKESPIGEL404/private-flex-inference-auctions" target="_blank" rel="noreferrer">source ↗</a></nav>
      <div className="header-controls">
        <button className="preview-link" onClick={() => setDialog('mode')}>{tasks ? 'controlled' : capabilities ? 'wallet setup' : 'connecting'}</button>
        {authenticated && <><button className="outline-button" onClick={() => setDialog('wallet')}>{capabilities?.nativeWallets ? native.owner?.account_id ?? 'wallets' : tasks ? 'wallets' : wallet.owner?.account_id ?? 'connect NEAR'}</button>
          <button className="outline-button" aria-expanded={activity} onClick={() => setActivity(old => !old)}>activity</button>
          <label className="pane-count">panes <input aria-label="Pane count" type="number" min={1} max={tasks ? sessions.length : allocation ? buyers.length : 8} value={countDraft} disabled={busy || !sessions.length}
            onChange={e => {setCountDraft(e.target.value); if (/^[1-8]$/.test(e.target.value)) void resize(Number(e.target.value));}} onBlur={() => setCountDraft(String(shown.length))} /></label>
          <button className="outline-button" aria-label="Configure task" disabled={busy || !current} onClick={() => setDialog('settings')}><span className="configure-full">configure</span><span className="configure-short">config</span> <kbd>⌘K</kbd></button>
          <button className="outline-button" aria-label="New task" disabled={busy || !tasks || !sessions.length} onClick={() => newTask()}>+ task</button>
          <button className="outline-button" disabled={busy || !tasks || !shown.some(s => ready.has(s.id) && s.state !== 'complete')} onClick={() => void runAll()}>{hasRunning ? 'pause all' : 'run all'}</button>
          {(tasks || wallet.owner) && <button className="help-button" disabled={busy} onClick={() => void logout()}>disconnect</button>}</>}
        <button className="help-button" aria-label="Keyboard shortcuts" onClick={() => setDialog('help')}>?</button>
      </div>
    </div><div className="sessionbar"><span className="session-name">[market]</span>
      <div className="window-list" aria-label="Agent sessions">{shown.map((s, i) => <button key={s.id} className={current?.id === s.id ? 'window-current' : ''} aria-label={'Select ' + s.id} aria-pressed={current?.id === s.id}
        onClick={() => focus(s.id)} onDoubleClick={() => setZoomed(old => old === s.id ? null : s.id)} title={s.agent_id + ' · ' + s.prompt}>{i + 1}:fx{current?.id === s.id ? '*' : ''}</button>)}</div>
      <div className="session-actions">{current && <><button className="selected-state" onClick={() => setDialog('settings')}>{current.agent_id} · {current.state}</button>
        <button className="zoom-button" aria-label={zoomed ? 'Restore panes' : 'Zoom selected pane'} onClick={() => setZoomed(old => old ? null : current.id)}>{zoomed ? 'unzoom' : 'zoom'}</button></>}</div>
    </div></header>
    <div className="gateway-status" role="status"><button onClick={() => setDialog('mode')}>{tasks ? capabilities?.nativeWallets ? 'Controlled inference · virtual settlement · wallet funding is real NEAR' : 'Controlled inference · virtual settlement · no real inference payments' : 'Wallet preparation · inference procurement not enabled'}</button>
      <span>{tasks ? 'independent agents · MPP / Market' : 'owner authorization required'}</span></div>
    <SupplyAvailability />
    {error && <div className="workspace-error" role="alert">{error}</div>}
    <main className="terminal-workspace" ref={workspace} aria-label="Agent terminals">
      {connection === 'loading' && <div className="workspace-empty">connecting to workspace…</div>}
      {connection === 'error' && <div className="workspace-empty"><p>Workspace service unavailable.</p><button className="outline-button" onClick={() => void discover()}>retry connection</button></div>}
      {connection === 'ready' && tasks && !hosted && <div className="workspace-login"><span className="login-eyebrow">PRIVATE MARKET · PUBLIC PLAYGROUND</span><h1>Give each agent a task.</h1><p>Connect an ordinary NEAR wallet to open your own workspace. No access code. Sign-in is a message signature, with no on-chain fee.</p>
        <p>Run controlled agent tasks for free, or create and fund independent agent wallets. Real inference payments are not enabled in this release.</p>
        {native.error&&<p role="alert">{native.error}</p>}<button className="solid-button" disabled={busy||native.busy} onClick={()=>void login()}>{busy||native.busy?'connecting…':'connect NEAR wallet ↗'}</button></div>}
      {shown.map((session, i) => {const rect = layout[i]; return <div key={viewEpoch + ':' + session.id} id={'pane-' + session.id}
        className={`pane-slot ${zoomed === session.id ? 'is-zoomed' : ''} ${zoomed && zoomed !== session.id ? 'is-hidden' : ''}`}
        style={{left: rect.left + '%', top: rect.top + '%', width: rect.width + '%', height: rect.height + '%', borderRightWidth: rect.rightEdge ? 0 : 1, borderBottomWidth: rect.bottomEdge ? 0 : 1}}>
        <TaskPane ref={value => {if (value) handles.current.set(session.id, value); else handles.current.delete(session.id);}}
          session={session} hosted={tasks} selected={selected === session.id} enabled={!busy} onSelect={() => setSelected(session.id)}
          refresh={refresh} onDetail={recordDetail} onReady={paneReady} onUnauthorized={clearOwner} onInput={data => terminalInput(session.id, data)}
          configure={() => {setSelected(session.id); setDialog('settings');}} newTask={prompt => {setSelected(session.id); newTask(prompt);}} wallet={() => setDialog('wallet')} />
      </div>;})}
    </main>
    {authenticated && tasks && <TaskActivity open={activity} session={current} status={current ? details[current.id] : undefined} toggle={() => setActivity(old => !old)} change={changeBid} />}
    <AttestationPanel />
    {dialog === 'settings' && current && <TaskSettings key={current.id} session={current} limit={hosted?.limits.find(l => l.agent_id === current.agent_id)} hosted={tasks}
      onClose={() => setDialog(null)} onSave={saveSettings} onNew={() => {if (tasks) newTask(); else setDialog('wallet');}} />}
    {dialog === 'new' && tasks && hosted && <NewTask sessions={sessions} limits={hosted.limits} maxTasks={capabilities?.maxTasksPerAgent ?? 2} initialAgent={current?.agent_id}
      initialPrompt={newPrompt || undefined} windowMs={capabilities?.taskWindowMs ?? 180000} onClose={() => setDialog(null)} onCreate={createTask} />}
    {dialog === 'wallet' && capabilities?.walletSetup && <WalletSetup controller={walletController} buyers={buyers} onClose={() => setDialog(null)} />}
    {dialog === 'wallet' && capabilities?.nativeWallets && <NativeWallets controller={nativeController} ids={sessions.map(s=>s.agent_id)} onClose={()=>setDialog(null)} />}
    {dialog === 'wallet' && !capabilities?.walletSetup && !capabilities?.nativeWallets && <Modal title="agent wallets" onClose={() => setDialog(null)}><p className="dialog-note">This controlled release uses virtual balances. Real wallet connection and funding are not enabled.</p>
      {hosted?.limits.map(l => <div className="wallet-limit" key={l.agent_id}><strong>{l.agent_id}</strong><span>authorization {nanoUsd(l.budget_nano)}</span><span>spent {nanoUsd(l.spent_nano)}</span><span>reserved {nanoUsd(l.reserved_nano)}</span></div>)}</Modal>}
    {dialog === 'mode' && <Modal title={tasks ? 'controlled workspace' : 'wallet preparation'} onClose={() => setDialog(null)}><p className="dialog-note">{tasks ? 'Independent fx sessions call the MPP proxy. The server owns procurement, budget reservations, durable workspaces and refund reconciliation. Inference model replies and settlement receipts are local fixtures. Ordinary agent wallet funding is a separate real NEAR mainnet transfer; it does not pay for these controlled tasks.' : 'This backend supports owner wallet authorization and agent preparation. Task procurement is not enabled. Funding availability follows the host configuration and owner approval.'}</p></Modal>}
    {dialog === 'help' && <Modal title="keys" onClose={() => setDialog(null)}><dl className="key-list"><dt>configure task</dt><dd>⌘ / Ctrl K</dd><dt>run selected task</dt><dd>⌘ / Ctrl ↵</dd><dt>switch pane</dt><dd>Ctrl B ← / →</dd><dt>zoom / restore</dt><dd>Ctrl B Z</dd><dt>restore pane</dt><dd>Ctrl B %</dd><dt>pause & park last pane</dt><dd>Ctrl B X</dd><dt>terminal commands</dt><dd>/help</dd></dl><p className="dialog-note">Pane count changes only the view. Parking first pauses the original task. Restoring never creates an agent or replenishes funds. Use + task to create another bounded task for an existing agent.</p></Modal>}
  </div>;
}
