import {useEffect, useRef, useState} from 'react';
import type {ReactNode} from 'react';
import type {AgentSession, AgentLimit, Preference} from './task-api';
import {editableUsd, nanoUsd, parseNanoUsd} from './task-api';

export function Modal({title, onClose, children}: {title: string; onClose(): void; children: ReactNode}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { const element = dialog.current; if (element && !element.open) element.showModal(); }, []);
  return <dialog ref={dialog} aria-labelledby="workspace-dialog-title" onCancel={event => {event.preventDefault(); onClose();}}
    onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="dialog-heading"><h1 id="workspace-dialog-title">{title}</h1><button className="close-button" onClick={onClose} aria-label="Close dialog">×</button></div>
    {children}
  </dialog>;
}

export function TaskSettings({session, limit, hosted, onClose, onSave, onNew}: {
  session: AgentSession; limit?: AgentLimit; hosted: boolean; onClose(): void;
  onSave(budget: string, preference: Preference, prompt: string): Promise<void>; onNew(): void;
}) {
  const [budget, setBudget] = useState(editableUsd(session.budget_nano));
  const [prompt, setPrompt] = useState(session.prompt);
  const [preference, setPreference] = useState(session.preference);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  return <Modal title={session.agent_id + ' · task settings'} onClose={() => { if (!busy) onClose(); }}>
    <form onSubmit={event => { event.preventDefault(); const value = parseNanoUsd(budget);
      if (!value || (limit && BigInt(value) > BigInt(limit.budget_nano))) { setError('Enter a positive task cap within the agent authorization.'); return; }
      setBusy(true); setError(''); void onSave(value, preference, prompt).catch(e => setError(e.message)).finally(() => setBusy(false));
    }}>
      <label htmlFor="task-prompt">task</label><textarea id="task-prompt" value={prompt} onChange={e => setPrompt(e.target.value)} readOnly={hosted} maxLength={1000} required rows={4} />
      {hosted && <p className="dialog-note">This task keeps its original prompt. Create a new task to change the instructions.</p>}
      <label htmlFor="task-budget">task cap <span>USD · {hosted ? 'virtual funds' : 'unsigned draft'}</span></label>
      <div className="money-input"><span>$</span><input id="task-budget" value={budget} onChange={e => setBudget(e.target.value)} inputMode="decimal" required /></div>
      <label htmlFor="task-preference">cost / time preference</label><select id="task-preference" value={preference} onChange={e => setPreference(e.target.value as Preference)}>
        <option value="save">save</option><option value="balanced">balanced</option><option value="fast">finish sooner</option>
      </select>
      {limit && <p className="dialog-note">Agent authorization {nanoUsd(limit.budget_nano)} · spent {nanoUsd(limit.spent_nano)} · reserved {nanoUsd(limit.reserved_nano)}. A task cap does not add funds.</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-footer"><button className="outline-button" type="button" disabled={busy} onClick={onNew}>new task</button>
        <button className="solid-button" disabled={busy} type="submit">{busy ? 'saving…' : 'apply ↵'}</button></div>
    </form>
  </Modal>;
}

export function NewTask({sessions, limits, maxTasks, initialAgent, initialPrompt, windowMs, onClose, onCreate}: {
  sessions: AgentSession[]; limits: AgentLimit[]; maxTasks: number; initialAgent?: string; initialPrompt?: string; windowMs: number;
  onClose(): void; onCreate(agent: string, prompt: string, budget: string, preference: Preference): Promise<void>;
}) {
  const agents = [...new Set(sessions.map(s => s.agent_id))];
  const [agent, setAgent] = useState(initialAgent ?? agents[0]);
  const [prompt, setPrompt] = useState(initialPrompt ?? 'Compute the sum of numbers.txt, write result.txt, and verify the result.');
  const [budget, setBudget] = useState('0.01'), [preference, setPreference] = useState<Preference>('balanced');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const count = sessions.filter(s => s.agent_id === agent).length, limit = limits.find(l => l.agent_id === agent);
  return <Modal title="new task" onClose={() => { if (!busy) onClose(); }}>
    <form onSubmit={event => { event.preventDefault(); const value = parseNanoUsd(budget);
      if (!value || (limit && BigInt(value) > BigInt(limit.budget_nano))) { setError('Task cap exceeds this agent’s authorization.'); return; }
      setBusy(true); setError(''); void onCreate(agent, prompt, value, preference).catch(e => setError(e.message)).finally(() => setBusy(false));
    }}>
      <label htmlFor="new-agent">agent</label><select id="new-agent" value={agent} onChange={e => setAgent(e.target.value)}>{agents.map(a => <option key={a}>{a}</option>)}</select>
      <label htmlFor="new-prompt">task</label><textarea id="new-prompt" value={prompt} onChange={e => setPrompt(e.target.value)} required maxLength={1000} rows={4} />
      <label htmlFor="new-budget">task cap <span>USD · virtual funds</span></label><div className="money-input"><span>$</span><input id="new-budget" value={budget} onChange={e => setBudget(e.target.value)} inputMode="decimal" required /></div>
      <label htmlFor="new-preference">cost / time preference</label><select id="new-preference" value={preference} onChange={e => setPreference(e.target.value as Preference)}>
        <option value="save">save</option><option value="balanced">balanced</option><option value="fast">finish sooner</option>
      </select>
      <p className="dialog-note">Controlled tasks use the scripted model and this agent’s virtual workspace. {Math.max(0, maxTasks - count)} new task remaining · start within {Math.round(windowMs / 60000)} minutes. Existing budgets and orders are retained.</p>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-footer"><button className="outline-button" type="button" disabled={busy} onClick={onClose}>cancel</button>
        <button className="solid-button" type="submit" disabled={busy || count >= maxTasks}>{busy ? 'creating…' : 'create task ↵'}</button></div>
    </form>
  </Modal>;
}
