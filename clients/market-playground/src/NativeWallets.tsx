import { useEffect, useState, useSyncExternalStore } from "react";
import { Modal } from "./WorkspaceDialogs";
import { nanoUsd } from "./task-api";
import { nearAmount, NativeWalletController } from "./native-wallet";
export function NativeWallets({
  controller,
  ids,
  onClose,
  network = "mainnet",
  authorizations,
}: {
  controller: NativeWalletController;
  ids: string[];
  onClose: () => void;
  network?: "mainnet" | "testnet";
  authorizations?: Array<{
    agent_id: string;
    payer: string;
    agent_cap_nano: string;
    agent_reserved_nano: string;
    agent_spent_nano: string;
  }>;
}) {
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot),
    [password, setPassword] = useState(""),
    [amount, setAmount] = useState("0.01"),
    [hash, setHash] = useState(""),
    [confirmed, setConfirmed] = useState(false);
  useEffect(() => {
    if (!authorizations) void controller.balances();
  }, [controller, state.agents.length, authorizations]);
  if (authorizations)
    return (
      <Modal title={"NEAR wallets · " + network} onClose={onClose}>
        <p className="dialog-note">
          Connected owner:{" "}
          <strong>{state.owner?.account_id ?? "disconnected"}</strong>
        </p>
        <p className="dialog-note">
          Native funding is not enabled for this controlled build. Existing
          order commitments and pending refunds remain reserved.
        </p>
        {[...new Map(authorizations.map((a) => [a.agent_id, a])).values()].map(
          (a) => (
            <section className="native-agent" key={a.agent_id}>
              <h3>{a.agent_id}</h3>
              <p className="native-address">{a.payer}</p>
              <p>
                authorized {nanoUsd(a.agent_cap_nano)} · spent{" "}
                {nanoUsd(a.agent_spent_nano)} · held{" "}
                {nanoUsd(a.agent_reserved_nano)}
              </p>
            </section>
          ),
        )}
      </Modal>
    );
  return (
    <Modal
      title="ordinary NEAR wallets · mainnet"
      onClose={() => {
        if (!state.busy) onClose();
      }}
    >
      <p className="dialog-note">
        Connected owner:{" "}
        <strong>{state.owner?.account_id ?? "disconnected"}</strong>. Each agent
        wallet has its own browser-held key. The server and model never receive
        it.
      </p>
      <p className="dialog-note">
        Real funding is optional. Controlled inference uses a separate virtual
        ledger and does not spend this NEAR.
      </p>
      {state.error && (
        <p role="alert" className="wallet-error">
          {state.error}
        </p>
      )}
      {state.message && <p role="status">{state.message}</p>}
      {!state.agents.length && (
        <button
          className="outline-button"
          disabled={state.busy || !state.owner}
          onClick={() => void controller.prepare([...new Set(ids)])}
        >
          create local agent wallets
        </button>
      )}
      <label className="native-field">
        backup password (12+ characters)
        <input
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </label>
      <div className="native-actions">
        <button
          className="outline-button"
          disabled={state.busy || !state.agents.length}
          onClick={() => void controller.backup(password)}
        >
          download encrypted backup
        </button>
        {
          <label className="outline-button">
            restore backup
            <input
              type="file"
              accept="application/json"
              disabled={state.busy}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file && file.size <= 500000)
                  void file
                    .text()
                    .then((text) =>
                      controller.restore(text, password, [...new Set(ids)]),
                    );
              }}
            />
          </label>
        }
      </div>
      <label className="native-field">
        transfer amount · NEAR
        <input
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
      </label>
      <label className="native-confirm">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
        />
        I saved the encrypted backup and its password. These are real mainnet
        transfers.
      </label>
      {state.agents.map((a, i) => (
        <section className="native-agent" key={a.id}>
          <h3>
            agent {i + 1} <small>{a.id}</small>
          </h3>
          <p className="native-address">{a.address}</p>
          <p>
            real balance:{" "}
            {state.balances[a.id] === "uncreated"
              ? "account not funded yet"
              : state.balances[a.id] === "unavailable"
                ? "RPC unavailable"
                : state.balances[a.id]
                  ? nearAmount(state.balances[a.id]) + " NEAR"
                  : "checking…"}
          </p>
          <div className="native-actions">
            <button
              className="outline-button"
              disabled={
                state.busy ||
                !a.backedUp ||
                !confirmed ||
                a.attempts.some((t) => t.state === "pending")
              }
              onClick={() => void controller.fund(a.id, amount)}
            >
              fund from owner wallet ↗
            </button>
            <button
              className="outline-button"
              disabled={
                state.busy ||
                !a.backedUp ||
                !confirmed ||
                a.attempts.some((t) => t.state === "pending")
              }
              onClick={() => void controller.withdraw(a.id, amount)}
            >
              return amount to owner
            </button>
          </div>
          <p className="dialog-note">
            Funding: max 0.1 NEAR per transfer, plus owner wallet gas. Return:
            agent pays gas; retain 0.002 NEAR for storage and gas.
          </p>
          {a.attempts.map((t) => (
            <div className="native-transfer" key={t.id}>
              {t.kind} · {nearAmount(t.amount)} NEAR · {t.state}
              {t.hash && (
                <a
                  href={"https://nearblocks.io/txns/" + t.hash}
                  target="_blank"
                  rel="noreferrer"
                >
                  transaction ↗
                </a>
              )}
              {t.state === "pending" && (
                <>
                  <input
                    aria-label="Original transaction hash"
                    placeholder="original transaction hash from wallet history"
                    value={hash}
                    onChange={(e) => setHash(e.target.value)}
                  />
                  <button
                    className="outline-button"
                    disabled={state.busy}
                    onClick={() =>
                      void controller.reconcile(a.id, hash || undefined)
                    }
                  >
                    reconcile original
                  </button>
                  {t.kind === "withdraw" && t.bytes && (
                    <button
                      className="outline-button"
                      disabled={state.busy || !confirmed}
                      onClick={() => void controller.resumeWithdrawal(a.id)}
                    >
                      broadcast original signed withdrawal
                    </button>
                  )}
                </>
              )}
            </div>
          ))}
        </section>
      ))}
      {!!state.agents.length && (
        <button
          className="outline-button"
          disabled={state.busy}
          onClick={() => void controller.balances()}
        >
          refresh final balances
        </button>
      )}
    </Modal>
  );
}
