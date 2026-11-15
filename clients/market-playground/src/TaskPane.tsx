import {forwardRef, useEffect, useImperativeHandle, useRef, useState} from 'react';
import {Terminal} from '@wterm/react';
import {GhosttyCore} from '@wterm/ghostty';
import type {WTerm} from '@wterm/dom';
import ghosttyWasm from '@wterm/ghostty/ghostty-vt.wasm?url';
import fxWasm from '../node_modules/libfx/fx-core.wasm?url';
import {createTaskRuntime} from '../../../services/mpp-near-direct/p2/fx-runtime.mjs';
import {taskApi, TaskApiError, nanoUsd} from './task-api';
import type {AgentSession, TaskStatus} from './task-api';

export interface PaneHandle { run(): Promise<void>; pause(): Promise<boolean>; reset(): Promise<string | undefined>; focus(): void }
interface Props {
  session: AgentSession; selected: boolean; enabled: boolean; hosted: boolean;
  onSelect(): void; refresh(): Promise<void>; onUnauthorized(): void;
  onDetail(id: string, value: TaskStatus): void; onInput(data: string): boolean;
  onReady(id: string): void;
  configure(): void; newTask(prompt?: string): void; wallet(): void;
}
// Model/tool text is display data, never terminal control sequences.
const text = (s: string) => s.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').replace(/\n/g, '\r\n');

export const TaskPane = forwardRef<PaneHandle, Props>(function TaskPane(props, ref) {
  const {session, hosted, onDetail, onUnauthorized} = props;
  const [core, setCore] = useState<GhosttyCore>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const terminal = useRef<WTerm | null>(null);
  const detail = useRef<TaskStatus | null>(null);
  const runtime = useRef<Awaited<ReturnType<typeof createTaskRuntime>> | null>(null);
  const active = useRef(true), running = useRef(false), stopping = useRef(false), line = useRef('');
  const finished = useRef<Promise<void>>(Promise.resolve());
  const resetRequest = useRef<{action: 'reset'; expectedRevision: string; operation: string} | null>(null);
  const latest = useRef(props); latest.current = props;
  const transcript = useRef('');
  const prompt = () => terminal.current?.write('\r\n\x1b[90mmarket>\x1b[0m ');
  function render(saved?: TaskStatus) {
    if (!terminal.current || running.current) return;
    const output = saved?.transcript ?? (hosted ? '> ' + latest.current.session.prompt + '\n'
      : 'Agent wallet setup\nModel procurement is not enabled on this backend.\nUse the wallet button to prepare your agents.\n');
    if (transcript.current === output) return;
    transcript.current = output;
    terminal.current.write('\x1b[2J\x1b[H' + text(output));
    if (saved?.workspace['/workspace/result.txt']) terminal.current.write('\r\nresult.txt: ' + text(saved.workspace['/workspace/result.txt']));
    terminal.current.write('\r\n\x1b[90m/help · run · pause · status · /task\x1b[0m');
    line.current = ''; prompt();
  }
  useEffect(() => {
    active.current = true;
    let disposed = false, loaded: GhosttyCore | undefined;
    void GhosttyCore.load({wasmPath: ghosttyWasm, backgroundColor: '#000000', foregroundColor: '#ededed',
      scrollbackLines: 1200, imageStorageLimit: 0}).then(value => {
      if (disposed) value.dispose(); else { loaded = value; setCore(value); }
    }).catch(() => { if (!disposed) setError('Terminal could not load. Refresh to try again.'); });
    return () => {
      disposed = true; active.current = false;
      void runtime.current?.close().catch(() => {}); runtime.current = null; loaded?.dispose();
    };
  }, []);
  useEffect(() => {
    if (!hosted) return;
    const abort = new AbortController();
    let disposed = false, timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const value = await taskApi<TaskStatus>('sessions/' + session.id, undefined, undefined, abort.signal);
        if (disposed) return;
        detail.current = value; onDetail(session.id, value); render(value);
        setError(old=>old==='Workspace could not refresh. Your original task is retained.'?'':old);
      } catch (e) {
        if (disposed) return;
        if (e instanceof Error && 'code' in e && ['unauthorized','login_required'].includes(String(e.code))) onUnauthorized();
        else setError('Workspace could not refresh. Your original task is retained.');
      } finally { if (!disposed) timer = setTimeout(() => void poll(), 1000); }
    }
    void poll();
    return () => { disposed = true; abort.abort(); clearTimeout(timer); };
  }, [hosted, session.id, onDetail, onUnauthorized]);
  useEffect(() => { if (ready) render(detail.current ?? undefined); }, [ready]);

  async function run() {
    const p = latest.current;
    if (!p.enabled || !hosted || running.current || p.session.state === 'complete' || !terminal.current) return;
    running.current = true; stopping.current = false; setBusy(true); setError('');
    let settle!: () => void;
    finished.current = new Promise(resolve => { settle = resolve; });
    try {
      if (p.session.paused) await taskApi('sessions/' + session.id + '/control', {
        action: 'resume', expectedRevision: p.session.revision, operation: crypto.randomUUID(),
      });
      const r = await createTaskRuntime({url: location.origin, sessionId: session.id, wasm: fxWasm, force: false,
        onEvent: (event: Record<string, unknown>) => {
          if (!active.current) return;
          if (event.type === 'text_delta') terminal.current?.write(text(String(event.text ?? event.delta ?? '')));
          if (event.type === 'tool_call') terminal.current?.write('\r\n[tool]\r\n');
        }});
      if (!active.current || stopping.current) { await r.close(); return; }
      runtime.current = r;
      terminal.current.write('\x1b[2J\x1b[H> ' + text(p.session.prompt) + '\r\n');
      const result = await r.run(); terminal.current?.write('\r\n[' + text(result.stopReason) + ']\r\n');
      if (!['end_turn', 'cancelled'].includes(result.stopReason) && !stopping.current) setError('Task stopped: ' + result.stopReason + '. Resume or reset this task.');
    } catch (e) {
      if (active.current && !stopping.current) setError(e instanceof Error ? e.message : 'Task outcome unavailable. Resume the original task.');
    } finally {
      try {
        await runtime.current?.close().catch(() => {}); runtime.current = null; running.current = false;
        if (active.current) { setBusy(false); transcript.current = ''; render(detail.current ?? undefined); await latest.current.refresh(); }
      } finally { settle(); }
    }
  }
  async function pause(internal = false) {
    const p = latest.current;
    if (!hosted) return true;
    if (!p.enabled && !internal) return false;
    setError('');
    try {
      if (p.session.state !== 'complete' && !p.session.paused)
        await taskApi('sessions/' + session.id + '/control', {action: 'pause', expectedRevision: p.session.revision, operation: crypto.randomUUID()});
      stopping.current = true; await runtime.current?.close();
      await finished.current;
      await p.refresh(); return true;
    } catch (e) { if (active.current) setError(e instanceof Error ? e.message : 'Pause was not confirmed.'); return false; }
  }
  async function reset() {
    if (!hosted || !active.current) return;
    setBusy(true); setError('');
    try {
      if (!resetRequest.current) {
        if (!await pause(true)) return;
        const saved = await taskApi<TaskStatus>('sessions/' + session.id);
        resetRequest.current = {action: 'reset', expectedRevision: saved.task.revision, operation: crypto.randomUUID()};
      }
      // A completed turn may precede its final refund by a few ticks.
      for (let attempt = 0; active.current; attempt++) {
        try {
          const next = await taskApi<{id: string}>('sessions/' + session.id + '/control', resetRequest.current);
          return next.id;
        } catch (e) {
          if (!(e instanceof TaskApiError) || e.code !== 'original_settlement_pending' || attempt >= 40) throw e;
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }
    } catch (e) {
      if (active.current) setError(e instanceof Error ? e.message : 'Reset was not confirmed.');
    } finally { if (active.current) setBusy(false); }
  }
  useImperativeHandle(ref, () => ({run, pause, reset, focus: () => terminal.current?.focus()}));
  function input(data: string) {
    const p = latest.current;
    if (p.onInput(data)) return;
    if (data === '\x03') { if (running.current) void pause(); else { line.current = ''; terminal.current?.write('^C'); prompt(); } return; }
    if (running.current) return;
    if (data === '\r') {
      const command = line.current.trim(); line.current = ''; terminal.current?.write('\r\n');
      if (['run', '/run'].includes(command)) { if (hosted) void run(); else p.wallet(); }
      else if (command === 'pause') void pause();
      else if (command === '/task') p.configure();
      else if (command === '/wallet') p.wallet();
      else if (['status', 'market status'].includes(command)) terminal.current?.write(text(`${p.session.agent_id} · ${p.session.state}\nspent ${nanoUsd(p.session.spent_nano)} · reserved ${nanoUsd(p.session.reserved_nano)} · task cap ${nanoUsd(p.session.budget_nano)}\n`));
      else if (['/help', 'help'].includes(command)) terminal.current?.write('run / pause: control this task\r\nstatus: server task budget\r\n/task: configure task\r\n/wallet: funding availability\r\nType a new task to review its budget before creating it.\r\n');
      else if (command) p.newTask(command);
      prompt(); return;
    }
    if (data === '\x7f' || data === '\b') { if (line.current) { line.current = line.current.slice(0, -1); terminal.current?.write('\b \b'); } return; }
    if (data.includes('\x1b') || /[\x00-\x1f]/.test(data)) return;
    if (line.current.length + data.length <= 1000) { line.current += data; terminal.current?.write(data); }
  }
  return <section className={`buyer-terminal hosted-terminal ${props.selected ? 'is-selected' : ''}`} aria-label={session.agent_id + ' task'}
    onPointerDown={props.onSelect} onFocusCapture={props.onSelect}>
    <div className="task-pane-heading"><strong>{session.agent_id}</strong><span>{session.state}</span><span className="task-pane-money">{nanoUsd(session.spent_nano)} / {nanoUsd(session.budget_nano)}</span>
      {hosted && <button className="pane-run" disabled={!ready || !props.enabled || session.state === 'complete' || busy} onClick={() => void run()} aria-label={'Run ' + session.id}>run ↵</button>}</div>
    {core ? <Terminal core={core} autoResize onReady={value => {terminal.current = value; transcript.current = ''; setReady(true); latest.current.onReady(session.id);}}
      onData={input} scrollbackLines={1200} onError={() => setError('Terminal rendering failed. Refresh to recover the saved task.')} />
      : <div className="terminal-loading">starting fx<span className="cursor">▌</span></div>}
    {error && <div className="terminal-error" role="alert">{error}</div>}
  </section>;
});
