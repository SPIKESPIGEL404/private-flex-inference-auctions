import { useEffect, useState, useRef } from "react";
import { Modal } from "./WorkspaceDialogs";
import { taskApi, nanoUsd } from "./task-api";
import { NativeWalletController, nearAmount, parseNear } from "./native-wallet";
type Transaction = Parameters<
  NativeWalletController["signOwnerTransaction"]
>[0];
interface Wallet {
  id: string;
  state: string;
  agentId: string | null;
  payer: string | null;
  policyInstalled: boolean;
}
interface Data {
  readiness: { ready: boolean; newPurchasesOpen: boolean };
  deadlineMs: number;
  limits: {
    ownerBudgetNano: string;
    agentBudgetNano: string;
    callCapMicro: string;
    principalCapYocto: string;
    gasReserveYocto: string;
    fundingCapYocto: string;
  };
  orders: Array<{
    agentId: string;
    gasActualYocto: string | null;
    paymentState: string;
    principal: {
      prepaid: string;
      charged: string;
      refundPending: string;
      refunded: string;
    };
  }>;
  withdrawals: Array<{
    id: string;
    walletId: string;
    state: string;
    amount: string;
    recipient: string;
    txHash: string | null;
    gasActualYocto: string | null;
    transaction?: Transaction;
    policyVersion?: number;
  }>;
  wallets: Wallet[];
  funding: Array<{
    id: string;
    wallet_id: string;
    amount: string;
    tx_hash: string | null;
    state: string;
  }>;
}
export function OutlayerWallets({
  controller,
  onClose,
  onUpdated,
}: {
  controller: NativeWalletController;
  onClose(): void;
  onUpdated(): Promise<void>;
}) {
  const [data, setData] = useState<Data | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [amount, setAmount] = useState("0.01"),
    [originalHashes, setHashes] = useState<Record<string, string>>({});
  const actionLock = useRef(false);
  const load = async () => {
    const [wallets, financial] = await Promise.all([
      taskApi<Data>("live-wallets"),
      taskApi<{ orders: Data["orders"] }>("orders"),
    ]);
    setData({ ...wallets, orders: financial.orders });
  };
  useEffect(() => {
    void load().catch((e) => setError(e.message));
    const timer = setInterval(() => void load().catch(() => {}), 5000);
    return () => clearInterval(timer);
  }, []);
  async function action(fn: () => Promise<void>) {
    if (actionLock.current) return;
    actionLock.current = true;
    setBusy(true);
    setError("");
    try {
      await fn();
      await onUpdated();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      await load().catch(() => {});
      actionLock.current = false;
      setBusy(false);
    }
  }
  return (
    <Modal
      title="agent wallets · NEAR Mainnet"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <p className="dialog-note">
        Real funds. The owner installs each merchant-only OutLayer policy and
        approves funding. Agents then pay their own inference principal and gas.
        Refunds return to the same agent wallet. Wallet credentials stay on the
        server; the model never receives them.
      </p>
      {error && (
        <p role="alert" className="wallet-error">
          {error}
        </p>
      )}
      {data && (
        <>
          <p role="status">
            {data.readiness.ready
              ? "Inference and merchant refunds are ready."
              : "Inference or merchant refund readiness is unavailable. New payments are blocked."}
          </p>
          <p>
            Owner cap {nanoUsd(data.limits.ownerBudgetNano)} · per-agent cap{" "}
            {nanoUsd(data.limits.agentBudgetNano)} · per-call cap{" "}
            {nanoUsd(String(BigInt(data.limits.callCapMicro) * 1000n))}. New
            purchases close at {new Date(data.deadlineMs).toLocaleString()}.
          </p>
          <p>
            Per-payment principal ≤ {nearAmount(data.limits.principalCapYocto)}{" "}
            NEAR; gas reserve {nearAmount(data.limits.gasReserveYocto)} NEAR.
            Gas is paid separately and is not refunded.
          </p>
          <button
            className="outline-button"
            disabled={busy || Date.now() >= data.deadlineMs}
            onClick={() =>
              void action(async () => {
                setData(
                  await taskApi<Data>("live-wallets", {
                    operation: crypto.randomUUID(),
                    acceptLimits: true,
                  }),
                );
              })
            }
          >
            accept caps &amp; create agent wallet
          </button>
          <label className="native-field">
            Fund each agent (NEAR, total cap{" "}
            {nearAmount(data.limits.fundingCapYocto)})
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal"
            />
          </label>
          {data.wallets.map((w) => {
            const orders = (data.orders ?? []).filter(
              (o) => o.agentId === w.agentId,
            );
            const sum = (field: keyof Data["orders"][number]["principal"]) =>
              String(
                orders.reduce((n, o) => n + BigInt(o.principal[field]), 0n),
              );
            const knownGas = String(
              orders.reduce((n, o) => n + BigInt(o.gasActualYocto ?? "0"), 0n),
            );
            const gasUnknown = orders.some(
              (o) =>
                ["pending", "unknown", "confirmed"].includes(o.paymentState) &&
                o.gasActualYocto === null,
            );
            const exit = [...data.withdrawals]
              .reverse()
              .find((x) => x.walletId === w.id);
            const pending = data.funding.find(
              (f) => f.wallet_id === w.id && f.state === "pending",
            );
            return (
              <section className="native-agent" key={w.id}>
                <h3>{w.agentId ?? "new agent"}</h3>
                <p className="native-address">
                  {w.payer ?? "registration outcome unknown — do not fund"}
                </p>
                <p>{w.state}</p>
                {orders.length > 0 && (
                  <p>
                    Inference principal charged {nearAmount(sum("charged"))}{" "}
                    NEAR · gas paid {nearAmount(knownGas)} NEAR
                    {gasUnknown ? " + unresolved original gas" : ""} · refund
                    pending {nearAmount(sum("refundPending"))} NEAR · refunded{" "}
                    {nearAmount(sum("refunded"))} NEAR.
                  </p>
                )}
                {w.payer && w.state !== "ready" && !exit && (
                  <>
                    <button
                      disabled={busy}
                      onClick={() =>
                        void action(async () => {
                          const result = await taskApi<{
                            transaction?: Transaction;
                            alreadyInstalled?: boolean;
                          }>(`live-wallets/${w.id}/policy`, {});
                          if (result.transaction)
                            await controller.signOwnerTransaction(
                              result.transaction,
                              w.payer!,
                            );
                          await taskApi(`live-wallets/${w.id}/confirm`, {});
                        })
                      }
                    >
                      install merchant-only policy
                    </button>
                    <button
                      disabled={busy}
                      onClick={() =>
                        void action(async () => {
                          await taskApi(`live-wallets/${w.id}/confirm`, {});
                        })
                      }
                    >
                      check original policy
                    </button>
                  </>
                )}
                {w.state === "ready" && (
                  <button
                    disabled={busy || !!pending}
                    onClick={() =>
                      void action(async () => {
                        const intent = await taskApi<{
                          id: string;
                          state: string;
                          transaction: Transaction;
                        }>(`live-wallets/${w.id}/funding`, {
                          operation: crypto.randomUUID(),
                          amount: parseNear(amount),
                        });
                        if (intent.state !== "pending") return;
                        const txHash = await controller.signOwnerTransaction(
                          intent.transaction,
                          w.payer!,
                        );
                        if (!txHash)
                          throw Error(
                            "Funding outcome unknown. Use the original hash from wallet history; do not fund again.",
                          );
                        setHashes((old) => ({ ...old, [intent.id]: txHash }));
                        await taskApi(`live-funding/${intent.id}/reconcile`, {
                          txHash,
                        });
                      })
                    }
                  >
                    approve funding in owner wallet
                  </button>
                )}
                {pending && (
                  <>
                    <p>
                      Original funding pending: {nearAmount(pending.amount)}{" "}
                      NEAR. No automatic resend.
                    </p>
                    <label>
                      Original transaction hash
                      <input
                        value={
                          originalHashes[pending.id] || pending.tx_hash || ""
                        }
                        onChange={(e) =>
                          setHashes((old) => ({
                            ...old,
                            [pending.id]: e.target.value,
                          }))
                        }
                      />
                    </label>
                    <button
                      disabled={busy}
                      onClick={() =>
                        void action(async () => {
                          await taskApi(
                            `live-funding/${pending.id}/reconcile`,
                            {
                              txHash:
                                originalHashes[pending.id] || pending.tx_hash,
                            },
                          );
                        })
                      }
                    >
                      reconcile original funding
                    </button>
                  </>
                )}
                {w.policyInstalled && (!exit || exit.state === "final") && (
                  <button
                    disabled={busy}
                    onClick={() =>
                      void action(async () => {
                        const original = await taskApi<
                          Data["withdrawals"][number]
                        >(`live-wallets/${w.id}/withdrawal`, {
                          confirmExit: true,
                        });
                        if (original.transaction)
                          await controller.signOwnerTransaction(
                            original.transaction,
                            w.payer!,
                            "withdrawal",
                          );
                        await taskApi(
                          `live-withdrawals/${original.id}/confirm`,
                          {},
                        );
                        await taskApi(
                          `live-withdrawals/${original.id}/send`,
                          {},
                        );
                      })
                    }
                  >
                    stop agent &amp; withdraw unused funds to owner
                  </button>
                )}
                {exit && (
                  <div>
                    <p>
                      Owner exit: {exit.state} · {nearAmount(exit.amount)} NEAR
                      → {exit.recipient}. A storage/gas floor stays in the
                      agent.
                    </p>
                    {exit.txHash && (
                      <p className="native-address">{exit.txHash}</p>
                    )}
                    {exit.gasActualYocto && (
                      <p>
                        Withdrawal gas paid by agent:{" "}
                        {nearAmount(exit.gasActualYocto)} NEAR
                      </p>
                    )}
                    {exit.state === "policy" && (
                      <button
                        disabled={busy}
                        onClick={() =>
                          void action(async () => {
                            if (exit.transaction)
                              await controller.signOwnerTransaction(
                                exit.transaction,
                                w.payer!,
                                "withdrawal",
                              );
                            await taskApi(
                              `live-withdrawals/${exit.id}/confirm`,
                              {},
                            );
                          })
                        }
                      >
                        install owner-only exit policy
                      </button>
                    )}
                    {exit.state === "policy" && (
                      <button
                        disabled={busy}
                        onClick={() =>
                          void action(async () => {
                            await taskApi(
                              `live-withdrawals/${exit.id}/confirm`,
                              {},
                            );
                          })
                        }
                      >
                        check original exit policy
                      </button>
                    )}
                    {exit.state === "prepared" && (
                      <button
                        disabled={busy}
                        onClick={() =>
                          void action(async () => {
                            await taskApi(
                              `live-withdrawals/${exit.id}/send`,
                              {},
                            );
                          })
                        }
                      >
                        approve original withdrawal
                      </button>
                    )}
                    {!["final", "cancelled", "policy", "prepared"].includes(
                      exit.state,
                    ) && (
                      <>
                        <p>
                          No automatic replacement transfer. Unknown ACK needs
                          original-operation review.
                        </p>
                        <button
                          disabled={busy}
                          onClick={() =>
                            void action(async () => {
                              await taskApi(
                                `live-withdrawals/${exit.id}/recover`,
                                {},
                              );
                            })
                          }
                        >
                          check original withdrawal
                        </button>
                      </>
                    )}
                  </div>
                )}
                {w.policyInstalled && !exit && (
                  <button
                    disabled={busy}
                    onClick={() =>
                      void action(async () => {
                        const r = await taskApi<{ transaction: Transaction }>(
                          `live-wallets/${w.id}/freeze`,
                          {},
                        );
                        await controller.signOwnerTransaction(
                          r.transaction,
                          w.payer!,
                        );
                      })
                    }
                  >
                    stop purchases &amp; freeze policy
                  </button>
                )}
              </section>
            );
          })}
        </>
      )}
    </Modal>
  );
}
