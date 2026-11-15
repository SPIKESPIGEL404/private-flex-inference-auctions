import { useEffect, useRef, useState } from "react";
import { defaultAuction, taskPrompt } from "./memory-tasks";
import type { ReactNode } from "react";
import type {
  AgentSession,
  AgentLimit,
  Preference,
  AuctionSettings,
} from "./task-api";
import {
  editableUsd,
  nanoUsd,
  parseNanoUsd,
  multiplier,
  parseMultiplier,
} from "./task-api";

export function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose(): void;
  children: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      aria-labelledby="workspace-dialog-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="dialog-heading">
        <h1 id="workspace-dialog-title">{title}</h1>
        <button
          className="close-button"
          onClick={onClose}
          aria-label="Close dialog"
        >
          ×
        </button>
      </div>
      {children}
    </dialog>
  );
}

interface AuctionDraft {
  policy: AuctionSettings["policy"];
  base: string;
  maximum: string;
  seconds: string;
}
const auctionDraft = (value = defaultAuction): AuctionDraft => ({
  policy: value.policy,
  base: multiplier(value.baseMultiplier),
  maximum: multiplier(value.maxMultiplier),
  seconds: String(value.deadlineSeconds),
});
function parseAuction(
  value: AuctionDraft,
  maxSeconds = 180,
): AuctionSettings | null {
  const base = parseMultiplier(value.base),
    maximum = parseMultiplier(value.maximum),
    seconds = Number(value.seconds);
  return base &&
    maximum &&
    BigInt(base) <= BigInt(maximum) &&
    Number.isInteger(seconds) &&
    seconds >= 30 &&
    seconds <= maxSeconds
    ? {
        policy: value.policy,
        baseMultiplier: base,
        maxMultiplier: maximum,
        deadlineSeconds: seconds,
      }
    : null;
}
function AuctionFields({
  value,
  onChange,
  disabled = false,
  maxSeconds = 180,
}: {
  value: AuctionDraft;
  onChange(value: AuctionDraft): void;
  disabled?: boolean;
  maxSeconds?: number;
}) {
  return (
    <fieldset disabled={disabled} className="auction-settings">
      <legend>model procurement</legend>
      <label htmlFor="auction-policy">buyer strategy</label>
      <select
        id="auction-policy"
        value={value.policy}
        onChange={(e) =>
          onChange({
            ...value,
            policy: e.target.value as AuctionSettings["policy"],
          })
        }
      >
        <option value="fixed">fixed bid</option>
        <option value="step-up">step up after a lost round</option>
        <option value="task-aware">retain funds for later steps</option>
      </select>
      <label htmlFor="auction-base">starting bid · multiplier</label>
      <input
        id="auction-base"
        inputMode="decimal"
        value={value.base}
        onChange={(e) => onChange({ ...value, base: e.target.value })}
      />
      <label htmlFor="auction-ceiling">economic bid ceiling · multiplier</label>
      <input
        id="auction-ceiling"
        inputMode="decimal"
        value={value.maximum}
        onChange={(e) => onChange({ ...value, maximum: e.target.value })}
      />
      <label htmlFor="auction-deadline">task duration · seconds</label>
      <input
        id="auction-deadline"
        type="number"
        min="30"
        max={maxSeconds}
        value={value.seconds}
        onChange={(e) => onChange({ ...value, seconds: e.target.value })}
      />
      <p className="dialog-note">
        The task cap limits spending. A higher cap does not raise the bid.
        Step-up increments are 0.1× per lost round, up to the economic ceiling.
      </p>
    </fieldset>
  );
}

export function TaskSettings({
  session,
  limit,
  hosted,
  onClose,
  onSave,
  onNew,
  maxTaskSeconds = 180,
  sourceCostsSeparate = false,
}: {
  session: AgentSession;
  limit?: AgentLimit;
  hosted: boolean;
  onClose(): void;
  onSave(
    budget: string,
    preference: Preference,
    prompt: string,
    auction?: AuctionSettings,
  ): Promise<void>;
  onNew(): void;
  maxTaskSeconds?: number;
  sourceCostsSeparate?: boolean;
}) {
  const [budget, setBudget] = useState(editableUsd(session.budget_nano));
  const [prompt, setPrompt] = useState(session.prompt);
  const [preference, setPreference] = useState(session.preference);
  const [bidding, setBidding] = useState(() => auctionDraft(session.auction));
  const editable = !session.clientOwned || !session.started;
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <Modal
      title={session.agent_id + " · task settings"}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const value = parseNanoUsd(budget);
          if (!value || (limit && BigInt(value) > BigInt(limit.budget_nano))) {
            setError(
              "Enter a positive task cap within the agent authorization.",
            );
            return;
          }
          const auction = session.clientOwned
            ? parseAuction(bidding, maxTaskSeconds)
            : undefined;
          if (session.clientOwned && !auction) {
            setError(
              `Enter bid multipliers from 1 to 100 and a duration from 30 to ${maxTaskSeconds} seconds.`,
            );
            return;
          }
          setBusy(true);
          setError("");
          void onSave(value, preference, prompt, auction ?? undefined)
            .catch((e) => setError(e.message))
            .finally(() => setBusy(false));
        }}
      >
        <label htmlFor="task-prompt">task</label>
        <textarea
          id="task-prompt"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          readOnly={(hosted && !session.clientOwned) || !editable}
          maxLength={1000}
          required
          rows={4}
        />
        {hosted && (!session.clientOwned || !editable) && (
          <p className="dialog-note">
            This task keeps its original prompt. Create a new task to change the
            instructions.
          </p>
        )}
        <label htmlFor="task-budget">
          task cap{" "}
          <span>
            USD ·{" "}
            {sourceCostsSeparate
              ? "service budget; source costs separate"
              : hosted
                ? "virtual funds"
                : "unsigned draft"}
          </span>
        </label>
        <div className="money-input">
          <span>$</span>
          <input
            id="task-budget"
            disabled={!editable}
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
            inputMode="decimal"
            required
          />
        </div>
        {session.clientOwned ? (
          <AuctionFields
            maxSeconds={maxTaskSeconds}
            value={bidding}
            onChange={setBidding}
            disabled={!editable}
          />
        ) : (
          <>
            <label htmlFor="task-preference">cost / time preference</label>
            <select
              id="task-preference"
              value={preference}
              onChange={(e) => setPreference(e.target.value as Preference)}
            >
              <option value="save">save</option>
              <option value="balanced">balanced</option>
              <option value="fast">finish sooner</option>
            </select>
          </>
        )}
        {limit && (
          <p className="dialog-note">
            Agent authorization {nanoUsd(limit.budget_nano)} · spent{" "}
            {nanoUsd(limit.spent_nano)} · reserved{" "}
            {nanoUsd(limit.reserved_nano)}. A task cap does not add funds.
          </p>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-footer">
          <button
            className="outline-button"
            type="button"
            disabled={busy}
            onClick={onNew}
          >
            new task
          </button>
          <button
            className="solid-button"
            disabled={busy || !editable}
            type="submit"
          >
            {busy ? "saving…" : "apply ↵"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function NewTask({
  sessions,
  limits,
  maxTasks,
  initialAgent,
  initialPrompt,
  windowMs,
  sourceCostsSeparate = false,
  liveIntents = false,
  onClose,
  onCreate,
}: {
  sessions: AgentSession[];
  limits: AgentLimit[];
  maxTasks: number;
  initialAgent?: string;
  initialPrompt?: string;
  windowMs: number;
  sourceCostsSeparate?: boolean;
  liveIntents?: boolean;
  onClose(): void;
  onCreate(
    agent: string,
    prompt: string,
    budget: string,
    preference: Preference,
    auction?: AuctionSettings,
  ): Promise<void>;
}) {
  const agents = [...new Set(sessions.map((s) => s.agent_id))];
  const memory = sessions.some((s) => s.clientOwned);
  const [bidding, setBidding] = useState(() =>
    auctionDraft({
      ...defaultAuction,
      ...(liveIntents
        ? { baseMultiplier: "3000000", maxMultiplier: "3200000" }
        : {}),
      deadlineSeconds: windowMs > 180000 ? Math.min(900, windowMs / 1000) : 120,
    }),
  );
  const [agent, setAgent] = useState(initialAgent ?? agents[0]);
  const [prompt, setPrompt] = useState(
    initialPrompt ??
      (memory
        ? taskPrompt
        : "Compute the sum of numbers.txt, write result.txt, and verify the result."),
  );
  const [budget, setBudget] = useState(liveIntents ? "0.02" : "0.01"),
    [preference, setPreference] = useState<Preference>("balanced");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const count = memory
      ? sessions.length
      : sessions.filter((s) => s.agent_id === agent).length,
    limit = limits.find((l) => l.agent_id === agent);
  return (
    <Modal
      title="new task"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      {liveIntents && (
        <p className="dialog-note">
          This canary starts at a 3× bid with a 3.2× ceiling and a $0.02 task
          cap. Review these before starting. Bridge minimums can reject smaller
          requests; each payment uses a fresh quote.
        </p>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const value = parseNanoUsd(budget);
          if (!value || (limit && BigInt(value) > BigInt(limit.budget_nano))) {
            setError("Task cap exceeds this agent’s authorization.");
            return;
          }
          const auction = memory
            ? parseAuction(bidding, windowMs / 1000)
            : undefined;
          if (memory && !auction) {
            setError("Invalid bidding multipliers or task duration.");
            return;
          }
          setBusy(true);
          setError("");
          void onCreate(agent, prompt, value, preference, auction ?? undefined)
            .catch((e) => setError(e.message))
            .finally(() => setBusy(false));
        }}
      >
        <label htmlFor="new-agent">agent</label>
        <select
          id="new-agent"
          value={agent}
          onChange={(e) => setAgent(e.target.value)}
        >
          {agents.map((a) => (
            <option key={a}>{a}</option>
          ))}
        </select>
        <label htmlFor="new-prompt">task</label>
        <textarea
          id="new-prompt"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          required
          maxLength={1000}
          rows={4}
        />
        <label htmlFor="new-budget">
          task cap{" "}
          <span>
            USD ·{" "}
            {sourceCostsSeparate
              ? "service budget; source costs separate"
              : "virtual funds"}
          </span>
        </label>
        <div className="money-input">
          <span>$</span>
          <input
            id="new-budget"
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
            inputMode="decimal"
            required
          />
        </div>
        {memory ? (
          <AuctionFields
            value={bidding}
            onChange={setBidding}
            maxSeconds={windowMs / 1000}
          />
        ) : (
          <>
            <label htmlFor="new-preference">cost / time preference</label>
            <select
              id="new-preference"
              value={preference}
              onChange={(e) => setPreference(e.target.value as Preference)}
            >
              <option value="save">save</option>
              <option value="balanced">balanced</option>
              <option value="fast">finish sooner</option>
            </select>
          </>
        )}
        <p className="dialog-note">
          {memory
            ? "The task budget applies when you run this task. Existing commitments and pending refunds remain reserved."
            : "Controlled tasks use the scripted model and this agent’s virtual workspace."}{" "}
          {Math.max(0, maxTasks - count)} task slots remaining.
        </p>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-footer">
          <button
            className="outline-button"
            type="button"
            disabled={busy}
            onClick={onClose}
          >
            cancel
          </button>
          <button
            className="solid-button"
            type="submit"
            disabled={busy || count >= maxTasks}
          >
            {busy ? "creating…" : "create task ↵"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
