import { useState } from "react";
import { nanoUsd, parseNanoUsd, multiplier, parseMultiplier } from "./task-api";
import { nearAmount } from "./native-wallet";
import type { AgentSession, TaskStatus, Call } from "./task-api";
function Bid({
  call,
  maximum,
  change,
}: {
  call: Call;
  maximum: string;
  change(call: Call, action: string, bid?: string): Promise<void>;
}) {
  const auction = call.bid_multiplier !== undefined;
  const [value, setValue] = useState(
    auction
      ? multiplier(call.bid_multiplier!)
      : nanoUsd(call.bid_nano).slice(1),
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function submit(action: string) {
    const bid = auction ? parseMultiplier(value) : parseNanoUsd(value),
      ceiling = auction ? (call.max_multiplier ?? "1000000") : maximum;
    if (action === "revise_bid" && (!bid || BigInt(bid) > BigInt(ceiling))) {
      setError(
        auction
          ? "Bid must be within the configured multiplier ceiling."
          : "Bid must be positive and within the authorized call cap.",
      );
      return;
    }
    setBusy(true);
    setError("");
    try {
      await change(call, action, bid ?? undefined);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="bid-control">
      <label>
        {auction ? "bid multiplier" : "bid USD"}
        <input
          aria-label={auction ? "Bid multiplier" : "Bid USD"}
          value={value}
          inputMode="decimal"
          onChange={(e) => setValue(e.target.value)}
        />
      </label>
      <button
        className="outline-button"
        disabled={busy}
        onClick={() => void submit("revise_bid")}
      >
        set manual bid
      </button>
      <button
        className="outline-button"
        disabled={busy || !call.manual}
        onClick={() => void submit("resume_auto")}
      >
        resume auto
      </button>
      <button
        className="outline-button"
        disabled={busy}
        onClick={() => void submit("cancel")}
      >
        cancel bid
      </button>
      {error && <span role="alert">{error}</span>}
    </div>
  );
}
export function TaskActivity({
  open,
  session,
  status,
  toggle,
  change,
  exportEvidence,
  clientOwned = false,
}: {
  open: boolean;
  clientOwned?: boolean;
  session?: AgentSession;
  status?: TaskStatus;
  toggle(): void;
  change(call: Call, action: string, bid?: string): Promise<void>;
  exportEvidence?: () => void;
}) {
  const [view, setView] = useState<"orders" | "workspace">("orders");
  const memory = clientOwned || status?.source === "client-memory";
  return (
    <section
      className={`provider-stats task-activity ${open ? "stats-expanded" : ""}`}
      aria-label="Task activity"
    >
      <div className="stats-heading">
        <button
          className="stats-heading-toggle"
          aria-expanded={open}
          onClick={toggle}
        >
          {open ? "⌄" : "›"} activity
        </button>
        <span className="stats-provider-name">
          {session?.agent_id ?? "workspace"} ·{" "}
          {session?.state ?? "no active task"}
        </span>
        <span className="stats-source">
          {memory
            ? "task files · this page / financial records · Market"
            : "server ledger · controlled"}
        </span>
        {session && (
          <span className="activity-budget">
            spent {nanoUsd(session.spent_nano)} · held{" "}
            {nanoUsd(session.reserved_nano)} · cap{" "}
            {nanoUsd(session.budget_nano)}
          </span>
        )}
        {exportEvidence && session && (
          <button className="outline-button" onClick={exportEvidence}>
            export evidence
          </button>
        )}
      </div>
      {open && (
        <div className="activity-body">
          <div
            className="activity-tabs"
            role="tablist"
            aria-label="Activity views"
          >
            <button
              role="tab"
              aria-selected={view === "orders"}
              onClick={() => setView("orders")}
            >
              orders & bids
            </button>
            <button
              role="tab"
              aria-selected={view === "workspace"}
              onClick={() => setView("workspace")}
            >
              workspace
            </button>
          </div>
          {view === "workspace" ? (
            <div role="tabpanel" className="workspace-files">
              {status ? (
                Object.entries(status.workspace).map(([path, content]) => (
                  <details key={path} open={/\/result\.(json|txt)$/.test(path)}>
                    <summary>{path}</summary>
                    <pre>{content}</pre>
                  </details>
                ))
              ) : (
                <p>No task workspace loaded.</p>
              )}
            </div>
          ) : (
            <div role="tabpanel">
              {status?.calls.map((call) => (
                <div className="activity-call" key={call.id}>
                  <span>
                    {call.historical ? "previous page/run · " : ""}
                    {call.state.replaceAll("_", " ")} ·{" "}
                    {call.bid_multiplier
                      ? multiplier(call.bid_multiplier) + "×"
                      : nanoUsd(call.bid_nano)}{" "}
                    · {call.manual ? "manual" : "auto"}
                  </span>
                  <span>
                    {call.decision?.result.reason?.replaceAll("_", " ")}
                  </span>
                  {call.state === "bidding" &&
                    !call.historical &&
                    (!memory || /^[a-f0-9]{64}$/.test(call.id)) && (
                      <Bid
                        key={call.id + ":" + call.revision}
                        call={call}
                        maximum={status.task.hard_bid_nano}
                        change={change}
                      />
                    )}
                </div>
              ))}
              {!!status?.orders.length && (
                <div className="order-table">
                  <table>
                    <caption>
                      {memory
                        ? "Original orders · native NEAR · controlled"
                        : "Virtual native NEAR principal · yoctoNEAR"}
                    </caption>
                    <thead>
                      {memory ? (
                        <tr>
                          <th>order</th>
                          <th>execution</th>
                          <th>payment</th>
                          <th>settlement</th>
                          <th>bid</th>
                          <th>maximum NEAR</th>
                          <th>charged NEAR</th>
                          <th>refund pending</th>
                          <th>refunded NEAR</th>
                        </tr>
                      ) : (
                        <tr>
                          <th>order</th>
                          <th>received</th>
                          <th>charged</th>
                          <th>held</th>
                          <th>refund pending</th>
                          <th>refunded</th>
                        </tr>
                      )}
                    </thead>
                    <tbody>
                      {status.orders.map((order, i) => (
                        <tr key={order.orderId ?? i}>
                          {memory ? (
                            <>
                              <th>
                                {order.historical ? "previous run · " : ""}
                                {order.orderId?.slice(0, 12)}
                              </th>
                              <td>
                                {order.executionState?.replaceAll("_", " ")}
                              </td>
                              <td>
                                {order.paymentState?.replaceAll("_", " ")}
                              </td>
                              <td>
                                {order.settlementState?.replaceAll("_", " ")}
                              </td>
                              <td>
                                {order.contract
                                  ? multiplier(order.contract.bidMultiplier) +
                                    "×"
                                  : "—"}
                              </td>
                              <td>{nearAmount(order.principal.P)}</td>
                              <td>
                                {order.financial ||
                                ["settled", "refund_confirmed"].includes(
                                  order.settlementState ?? "",
                                )
                                  ? nearAmount(order.principal.C)
                                  : "—"}
                              </td>
                              <td>{nearAmount(order.principal.W)}</td>
                              <td>{nearAmount(order.principal.R)}</td>
                            </>
                          ) : (
                            <>
                              <th>{order.state}</th>
                              {(["P", "C", "H", "W", "R"] as const).map((k) => (
                                <td key={k}>{order.principal[k]}</td>
                              ))}
                            </>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {!status?.calls.length && !status?.orders.length && (
                <p className="dialog-note">No inference orders yet.</p>
              )}
              {memory && status?.orders.some((o) => o.historical) && (
                <p className="dialog-note">
                  Previous orders remain available after refresh. Local
                  conversation and files are not restored.
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
