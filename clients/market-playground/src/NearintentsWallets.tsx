import { useCallback, useEffect, useRef, useState } from "react";
import { Modal } from "./WorkspaceDialogs";
import { taskApi, nanoUsd } from "./task-api";
import {
  fundingAccount,
  fundingDefaults,
  fundingTransaction,
  parseUnits,
  units,
} from "./evm-funding";
import type { EvmProvider } from "./evm-funding";
interface Funding {
  id: string;
  agent_id: string;
  kind: "token" | "gas";
  amount: string;
  state: string;
  tx_hash: string | null;
}
interface Data {
  exits: Array<{
    id: string;
    operation: string;
    agentId: string;
    kind: "token" | "gas";
    recipient: string;
    amount: string;
    state: string;
    txHash: string;
    gasWei: string | null;
  }>;
  mode: "controlled" | "live";
  chainId: number;
  token: { address: string; symbol: string; decimals: number };
  deadlineMs: number;
  limits: {
    maximumAmountIn: string;
    maximumTotalAmountIn: string;
    maximumGasWei: string;
    maximumTotalGasWei: string;
    principalCapYocto: string;
    agentBudgetNano: string;
    callCapMicro: string;
  };
  wallets: Array<{
    id: string;
    address: string;
    active: boolean;
    balance: { sourceAtoms?: string; gasWei?: string };
    agentId: string;
  }>;
  funding: Funding[];
}
export function NearintentsWallets({
  onClose,
  onUpdated,
  paymentsPaused = false,
}: {
  onClose(): void;
  onUpdated(): Promise<void>;
  paymentsPaused?: boolean;
}) {
  const [data, setData] = useState<Data | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [tokenAmount, setTokenAmount] = useState("2"),
    [gasAmount, setGasAmount] = useState("0.0002"),
    [hashes, setHashes] = useState<Record<string, string>>({});
  const locked = useRef(false),
    mounted = useRef(true),
    initialized = useRef(false),
    sequence = useRef(0);
  const load = useCallback(async () => {
    const request = ++sequence.current;
    const next = await taskApi<Data>("nearintents-wallets");
    if (mounted.current && request === sequence.current) {
      if (!initialized.current) {
        initialized.current = true;
        const defaults = fundingDefaults(next.limits);
        setTokenAmount(defaults.token);
        setGasAmount(defaults.gas);
      }
      setData(next);
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void load().catch((e) => setError(e.message));
    const timer = setInterval(() => void load().catch(() => {}), 5000);
    return () => {
      mounted.current = false;
      clearInterval(timer);
    };
  }, [load]);
  async function action(fn: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    try {
      await fn();
      await onUpdated();
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
    } finally {
      await load().catch(() => {});
      locked.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  const provider = () => {
    const p = (window as unknown as { ethereum?: EvmProvider }).ethereum;
    if (!p) throw Error("Open an EVM wallet extension to fund the agent.");
    return p;
  };
  async function fund(id: string, kind: "token" | "gas") {
    const p = provider(),
      from = await fundingAccount(p, data!.chainId),
      amount = parseUnits(
        kind === "token" ? tokenAmount : gasAmount,
        kind === "token" ? data!.token.decimals : 18,
      );
    const original = await taskApi<{
      id: string;
      to: string;
      kind: "token" | "gas";
      amount: string;
      tokenAddress: string;
    }>("nearintents-wallets/" + id + "/funding", {
      from,
      amount,
      kind,
      operation: crypto.randomUUID(),
    });
    // The backend intent exists before the wallet popup. Unknown ACKs remain
    // visible after refresh and must reconcile the original transfer.
    if (!mounted.current)
      throw Error("Owner changed before wallet submission.");
    let hash: string;
    try {
      hash = (await p.request({
        method: "eth_sendTransaction",
        params: [fundingTransaction({ from, ...original })],
      })) as string;
    } catch (e) {
      if ((e as { code?: number }).code === 4001)
        await taskApi("nearintents-funding/" + original.id + "/cancel", {
          walletRejected: true,
        });
      throw e;
    }
    if (!/^0x[a-fA-F0-9]{64}$/.test(hash))
      throw Error(
        "Wallet response is unknown. Recover the original transaction hash.",
      );
    localStorage.setItem("nearintents-funding:" + original.id, hash);
    setHashes((old) => ({ ...old, [original.id]: hash }));
    await taskApi("nearintents-funding/" + original.id + "/reconcile", {
      txHash: hash,
    });
  }
  async function exit(id: string, kind: "token" | "gas") {
    const recipient = await fundingAccount(provider(), data!.chainId);
    if (!mounted.current)
      throw Error("Owner changed before wallet submission.");
    await taskApi("nearintents-wallets/" + id + "/exit", {
      kind,
      recipient,
      operation: crypto.randomUUID(),
    });
  }
  return (
    <Modal
      title="agent wallets · NEAR Intents"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <p className="dialog-note">
        The owner signs in with NEAR. Fund each agent on Arbitrum with USDC and
        ETH for gas. Agents buy inference through the Chat Completions API and
        pay from their own wallet; keys stay in the trusted service.
      </p>
      <p className="dialog-note">
        Freeze the agent to withdraw unused USDC and ETH. Exit gas is additional
        to the inference gas budget, with at most eight exits per agent under
        the per-transfer cap. Paid inference refunds remain separate.
      </p>
      {paymentsPaused && (
        <p role="status">
          Purchasing inference is paused. Token funding is disabled until
          activation.
        </p>
      )}
      <p className="dialog-note">
        Each winning auction fixes one request price, including the service
        token limits. Successful requests have no usage rebate. Source-chain
        fees and exchange costs are additional. Failed delivery requires refund
        reconciliation.
      </p>
      {error && (
        <p role="alert" className="wallet-error">
          {error}
        </p>
      )}
      {!data && <p role="status">Loading agent wallets…</p>}
      {data && (
        <>
          <p role="status">
            {data.mode === "controlled"
              ? "Controlled payments and inference · no real funds"
              : "Real payments · Arbitrum USDC → merchant NEAR"}
          </p>
          <p>
            Agent service budget {nanoUsd(data.limits.agentBudgetNano)} · call
            cap {nanoUsd(String(BigInt(data.limits.callCapMicro) * 1000n))}.
            Source cap {units(data.limits.maximumAmountIn, 6)} USDC per call,{" "}
            {units(data.limits.maximumTotalAmountIn, 6)} USDC total.
          </p>
          <p>
            Inference gas cap {units(data.limits.maximumGasWei, 18)} ETH per
            transfer, {units(data.limits.maximumTotalGasWei, 18)} ETH total. Gas
            is paid separately and is not refunded.
          </p>
          <button
            className="outline-button"
            disabled={
              busy || data.wallets.length >= 2 || Date.now() >= data.deadlineMs
            }
            onClick={() =>
              void action(async () => {
                await taskApi("nearintents-wallets", {
                  operation: crypto.randomUUID(),
                  acceptLimits: true,
                });
              })
            }
          >
            accept caps &amp; create agent wallet
          </button>
          <div className="native-field">
            <label htmlFor="ni-usdc">Fund USDC</label>
            <input
              id="ni-usdc"
              inputMode="decimal"
              value={tokenAmount}
              onChange={(e) => setTokenAmount(e.target.value)}
            />
          </div>
          <div className="native-field">
            <label htmlFor="ni-gas">Fund gas (ETH)</label>
            <input
              id="ni-gas"
              inputMode="decimal"
              value={gasAmount}
              onChange={(e) => setGasAmount(e.target.value)}
            />
          </div>
          {data.wallets.map((w) => {
            const pending = data.funding.some(
              (f) => f.agent_id === w.id && f.state === "pending",
            );
            return (
              <section className="native-agent" key={w.id}>
                <p>
                  <strong>{w.id.slice(0, 12)}</strong> ·{" "}
                  {w.active ? "active" : "frozen"}
                </p>
                <code>{w.address}</code>
                <p>
                  {units(w.balance.sourceAtoms ?? "0", 6)} USDC ·{" "}
                  {units(w.balance.gasWei ?? "0", 18)} ETH
                </p>
                <p>
                  Before bidding, available funds must cover the per-call source
                  and gas caps.
                </p>
                <div className="dialog-actions">
                  <button
                    className="outline-button"
                    disabled={busy || pending || !w.active || paymentsPaused}
                    onClick={() => void action(() => fund(w.id, "token"))}
                  >
                    fund USDC
                  </button>
                  <button
                    className="outline-button"
                    disabled={busy || pending}
                    onClick={() => void action(() => fund(w.id, "gas"))}
                  >
                    fund gas
                  </button>
                  <button
                    className="outline-button"
                    disabled={busy || !w.active}
                    onClick={() =>
                      void action(async () => {
                        await taskApi(
                          "nearintents-wallets/" + w.id + "/freeze",
                          {},
                        );
                      })
                    }
                  >
                    freeze agent
                  </button>
                  <button
                    className="outline-button"
                    disabled={busy || w.active}
                    onClick={() => void action(() => exit(w.id, "token"))}
                  >
                    withdraw USDC
                  </button>
                  <button
                    className="outline-button"
                    disabled={busy || w.active}
                    onClick={() => void action(() => exit(w.id, "gas"))}
                  >
                    withdraw ETH
                  </button>
                </div>
                {data.funding
                  .filter((f) => f.agent_id === w.id)
                  .map((f) => (
                    <div className="native-field" key={f.id}>
                      <p>
                        {f.kind === "token"
                          ? units(f.amount, 6) + " USDC"
                          : units(f.amount, 18) + " ETH"}{" "}
                        · {f.state}
                      </p>
                      {f.state === "pending" && (
                        <>
                          <label htmlFor={"ni-hash-" + f.id}>
                            Original transaction hash
                          </label>
                          <input
                            id={"ni-hash-" + f.id}
                            value={
                              hashes[f.id] ??
                              f.tx_hash ??
                              localStorage.getItem(
                                "nearintents-funding:" + f.id,
                              ) ??
                              ""
                            }
                            onChange={(e) =>
                              setHashes((old) => ({
                                ...old,
                                [f.id]: e.target.value,
                              }))
                            }
                          />
                          <button
                            className="outline-button"
                            disabled={busy}
                            onClick={() =>
                              void action(async () => {
                                const txHash =
                                  hashes[f.id] ??
                                  f.tx_hash ??
                                  localStorage.getItem(
                                    "nearintents-funding:" + f.id,
                                  );
                                await taskApi(
                                  "nearintents-funding/" + f.id + "/reconcile",
                                  { txHash },
                                );
                              })
                            }
                          >
                            check original transfer
                          </button>
                        </>
                      )}
                    </div>
                  ))}
                {data.exits
                  ?.filter((e) => e.agentId === w.id)
                  .map((e) => (
                    <div key={e.id} className="native-field">
                      <p>
                        {e.kind === "token"
                          ? units(e.amount, 6) + " USDC"
                          : units(e.amount, 18) + " ETH"}{" "}
                        → {e.recipient} · {e.state}
                      </p>
                      {e.state === "signed" && (
                        <button
                          className="outline-button"
                          disabled={busy}
                          onClick={() =>
                            void action(async () => {
                              await taskApi(
                                "nearintents-wallets/" + w.id + "/exit",
                                {
                                  kind: e.kind,
                                  recipient: e.recipient,
                                  operation: e.operation,
                                },
                              );
                            })
                          }
                        >
                          recover original exit
                        </button>
                      )}
                    </div>
                  ))}
              </section>
            );
          })}
        </>
      )}
    </Modal>
  );
}
