import { taskApi, multiplier } from "./task-api";
import type {
  AgentSession,
  AgentLimit,
  AuctionSettings,
  Call,
  Preference,
  TaskStatus,
} from "./task-api";
import { buyerBid } from "./auction-policy";
import type { Pricing, Service } from "./auction-policy";
import type {
  MemoryTask,
  TaskDefinition,
  TaskEvidence,
} from "../../../services/mpp-near-direct/client/task.mjs";

export const taskPrompt =
  "Read /workspace/numbers.txt. Use bash to compute its sum and count. Write /workspace/result.json with exactly the numeric fields sum and count. Read it back and verify before finishing.";
export const defaultAuction: AuctionSettings = {
  policy: "fixed",
  baseMultiplier: "1000000",
  maxMultiplier: "2000000",
  deadlineSeconds: 120,
};
export const intentsCanaryAuction = (agentIndex = 0): AuctionSettings => ({
  ...defaultAuction,
  baseMultiplier: agentIndex % 2 ? "3200000" : "3000000",
  maxMultiplier: "3200000",
});
interface Grant {
  id: string;
  agent_id: string;
  payer: string;
  revision: string;
  deadline_ms: string;
  active: boolean;
  call_cap_micro: string;
  gas_cap_yocto?: string;
  agent_deadline_ms?: string;
  agent_call_cap_micro?: string;
  cap_nano: string;
  reserved_nano: string;
  spent_nano: string;
  agent_cap_nano: string;
  agent_reserved_nano: string;
  agent_spent_nano: string;
}
interface Bid {
  id: string;
  agent_id: string;
  grant_id: string;
  logical_call: string;
  revision: string;
  bid_multiplier: string;
  state: string;
}
interface Order {
  paymentMethod?: "nearintents";
  billing?: string;
  sourcePayment?: {
    asset: string;
    amount: string;
    state: string;
    receipt?: { reference: string; originTxHash?: string };
  };
  sourceFee?: {
    actualGasWei: string | null;
    reservedGasWei: string;
    transactionHash: string;
  } | null;
  allocationId: string;
  authorizationId: string;
  agentId: string;
  orderId: string;
  bidId: string;
  bidRevision: string;
  executionState: string;
  paymentState: string;
  settlementState: string;
  contract: { bidMultiplier: string };
  principal: {
    prepaid: string;
    charged: string;
    refundPending: string;
    refunded: string;
  };
  financial?: { totalMicro?: string };
}
interface MarketData {
  network?: "mainnet" | "testnet";
  paymentMethod?: "nearintents";
  paymentHeader?: "Authorization" | "Payment-Authorization";
  maxTaskSeconds?: number;
  inferenceEndpoint?: string;
  roots?: Grant[];
  grants: Grant[];
  bids: Bid[];
  service: Service;
  pricing: Pricing;
}
interface ModelCall {
  body: string;
  runId: string;
  logicalCallId: string;
  requestHash: string;
  signal: AbortSignal;
}
interface Waiting {
  bidId?: string;
  revision?: string;
  bidRevision?: string;
  state?: string;
  allocationId?: string;
  executionState?: string;
  lastRound?: { id: string; outcome: string; reason: string };
}
interface RuntimeOptions {
  task: TaskDefinition;
  transport: { invoke(call: ModelCall): Promise<Response> };
  runId: string;
  model: string;
  maxOutputTokens: number;
  deadlineMs: number;
  wasm?: string;
  onEvent(event: Record<string, unknown>): void;
}
type Factory = (options: RuntimeOptions) => Promise<MemoryTask>;
interface LocalCall {
  logicalId: string;
  bidId?: string;
  revision: string;
  bidMultiplier: string;
  manual: boolean;
  losses: number;
  lastRound?: string;
  state: string;
  reason?: string;
  ordinal: number;
}
interface Row {
  session: AgentSession;
  workspace: Record<string, string>;
  transcript: string;
  progress: string;
  error: string;
  calls: Map<string, LocalCall>;
  runtime?: MemoryTask;
  grant?: Grant;
  authorizationInput?: Record<string, unknown>;
  abort?: AbortController;
  running: boolean;
  stopping: boolean;
  evidence?: TaskEvidence;
}
export interface MemorySnapshot {
  ownerScope: string;
  sessions: AgentSession[];
  limits: AgentLimit[];
  details: Record<string, TaskStatus>;
  grants: Grant[];
}
const empty = (): MemorySnapshot => ({
  ownerScope: "",
  sessions: [],
  limits: [],
  details: {},
  grants: [],
});
const minimum = (...n: bigint[]) => n.reduce((a, b) => (a < b ? a : b));
const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done() {
      signal.removeEventListener("abort", abort);
      resolve();
    }
    function abort() {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    }
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });

// App-owned page lifetime. Panes subscribe to projections; mounting a view never
// claims a session, starts a turn, spends money or takes over another page.
export class MemoryTaskController {
  private rows = new Map<string, Row>();
  private listeners = new Set<() => void>();
  private value = empty();
  private data?: MarketData;
  private orders: Order[] = [];
  private epoch = 0;
  private refreshSequence = 0;
  constructor(
    private options: {
      api?: typeof taskApi;
      factory?: Factory;
      wasm?: string;
    } = {},
  ) {}
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  snapshot = () => this.value;
  private api = <T>(
    path: string,
    body?: unknown,
    method?: string,
    signal?: AbortSignal,
  ) => (this.options.api ?? taskApi)<T>(path, body, method, signal);
  reset() {
    this.epoch++;
    this.refreshSequence++;
    for (const row of this.rows.values()) {
      row.abort?.abort();
      void row.runtime?.close().catch(() => {});
    }
    this.rows.clear();
    this.data = undefined;
    this.orders = [];
    this.value = empty();
    this.emit();
  }
  private emit() {
    for (const listener of this.listeners) listener();
  }
  private row(id: string) {
    const row = this.rows.get(id);
    if (!row) throw Error("Task is no longer in this page.");
    return row;
  }
  private progress(row: Row, text: string) {
    if (row.progress !== text) {
      row.progress = text;
      this.publish();
    }
  }
  private publish() {
    const limits = new Map<string, AgentLimit>();
    for (const g of this.data?.roots ?? this.data?.grants ?? [])
      limits.set(g.agent_id, {
        agent_id: g.agent_id,
        budget_nano: g.agent_cap_nano,
        spent_nano: g.agent_spent_nano,
        reserved_nano: g.agent_reserved_nano,
      });
    const details: Record<string, TaskStatus> = {},
      sessions: AgentSession[] = [];
    for (const [id, row] of this.rows) {
      const grant =
        this.data?.grants.find((g) => g.id === row.grant?.id) ?? row.grant;
      if (grant) row.grant = grant;
      const orders = this.orders.filter(
        (o) => o.agentId === row.session.agent_id,
      );
      const current = orders.filter((o) => o.authorizationId === grant?.id);
      const session = {
        ...row.session,
        spent_nano: grant?.spent_nano ?? "0",
        reserved_nano: grant?.reserved_nano ?? "0",
        refund_pending_yocto: String(
          orders.reduce((n, o) => n + BigInt(o.principal.refundPending), 0n),
        ),
      };
      sessions.push(session);
      const calls: Call[] = [...row.calls.values()].map((c) => ({
        id: c.bidId ?? c.logicalId,
        logical_call: c.logicalId,
        state: c.state,
        revision: c.revision,
        bid_nano: "0",
        bid_multiplier: c.bidMultiplier,
        max_multiplier: session.auction!.maxMultiplier,
        manual: c.manual,
        decision: { result: { reason: c.reason } },
      }));
      for (const b of this.data?.bids.filter(
        (b) => b.agent_id === session.agent_id,
      ) ?? [])
        if (!calls.some((c) => c.id === b.id))
          calls.push({
            id: b.id,
            state: b.state,
            revision: b.revision,
            bid_nano: "0",
            bid_multiplier: b.bid_multiplier,
            manual: false,
            historical: true,
          });
      details[id] = {
        id,
        state: session.state,
        source: "client-memory",
        transcript: row.transcript,
        workspace: { ...row.workspace },
        progress: row.progress,
        error: row.error,
        task: {
          budget_nano: session.budget_nano,
          hard_bid_nano: session.budget_nano,
          preference: session.preference,
          revision: session.revision,
        },
        calls,
        orders: orders.map((o) => ({
          ...o,
          historical: !current.includes(o),
          state: o.executionState,
          principal: {
            P: o.principal.prepaid,
            C: o.principal.charged,
            H: "0",
            W: o.principal.refundPending,
            R: o.principal.refunded,
          },
        })),
      };
    }
    this.value = {
      ownerScope: this.value.ownerScope,
      sessions,
      limits: [...limits.values()],
      details,
      grants: this.data?.grants ?? [],
    };
    this.emit();
  }
  async refresh(ownerScope = this.value.ownerScope) {
    if (!ownerScope) return;
    const epoch = this.epoch,
      sequence = ++this.refreshSequence;
    const [data, financial] = await Promise.all([
      this.api<MarketData>("authorizations"),
      this.api<{ orders: Order[] }>("orders"),
    ]);
    if (epoch !== this.epoch || sequence !== this.refreshSequence) return;
    if (this.value.ownerScope && this.value.ownerScope !== ownerScope)
      this.reset();
    this.value = { ...this.value, ownerScope };
    this.data = data;
    this.orders = financial.orders;
    const liveIntents =
      data.paymentMethod === "nearintents" && data.network === "mainnet";
    for (const [agentIndex, grant] of (data.roots ?? data.grants).entries())
      if (
        ![...this.rows.values()].some(
          (r) => r.session.agent_id === grant.agent_id,
        )
      )
        this.add(
          grant.agent_id,
          taskPrompt,
          String(
            minimum(
              liveIntents ? 20000000n : 10000000n,
              BigInt(grant.agent_cap_nano),
            ),
          ),
          "balanced",
          this.data?.paymentMethod === "nearintents"
            ? {
                ...(liveIntents
                  ? intentsCanaryAuction(agentIndex)
                  : defaultAuction),
                deadlineSeconds: Math.min(
                  1800,
                  Math.max(
                    120,
                    Math.ceil(this.data.pricing.admissionWindowMs / 1000) * 3,
                  ),
                ),
              }
            : defaultAuction,
        );
    this.publish();
  }
  private add(
    agentId: string,
    prompt: string,
    budgetNano: string,
    preference: Preference,
    auction: AuctionSettings,
  ) {
    const root = (this.data?.roots ?? this.data?.grants)?.find(
      (g) => g.agent_id === agentId,
    );
    if (!root) throw Error("Agent authorization is unavailable.");
    const id = crypto.randomUUID(),
      numbers = agentId.endsWith("b") ? [5, 5, 9] : [3, 7, 32];
    const workspace = {
      "/workspace/numbers.txt": numbers.join("\n") + "\n",
      "/workspace/task.txt": prompt,
    };
    this.rows.set(id, {
      session: {
        id,
        agent_id: agentId,
        payer: root.payer,
        state: "ready",
        paused: false,
        task_id: id,
        revision: "0",
        generation: "0",
        preference,
        budget_nano: budgetNano,
        reserved_nano: "0",
        spent_nano: "0",
        prompt,
        deadline_ms: "0",
        clientOwned: true,
        started: false,
        auction: { ...auction },
      },
      workspace,
      transcript: "> " + prompt + "\n",
      progress: "Ready to start",
      error: "",
      calls: new Map(),
      running: false,
      stopping: false,
    });
    return id;
  }
  create(
    agentId: string,
    prompt: string,
    budgetNano: string,
    preference: Preference,
    auction = defaultAuction,
  ) {
    if (this.rows.size >= 8)
      throw Error("This page supports up to eight tasks.");
    this.validate(agentId, prompt, budgetNano, auction);
    const id = this.add(agentId, prompt, budgetNano, preference, auction);
    this.publish();
    return id;
  }
  private validate(
    agentId: string,
    prompt: string,
    budgetNano: string,
    auction: AuctionSettings,
  ) {
    const root = (this.data?.roots ?? this.data?.grants)?.find(
      (g) => g.agent_id === agentId,
    );
    if (
      !root ||
      !prompt.trim() ||
      prompt.length > 1000 ||
      !/^[1-9]\d*$/.test(budgetNano) ||
      BigInt(budgetNano) < 1000n ||
      BigInt(budgetNano) > BigInt(root.agent_cap_nano)
    )
      throw Error(
        "Task cap must be within the agent authorization and at least $0.000001.",
      );
    if (
      !["fixed", "step-up", "task-aware"].includes(auction.policy) ||
      !/^[1-9]\d*$/.test(auction.baseMultiplier) ||
      !/^[1-9]\d*$/.test(auction.maxMultiplier) ||
      BigInt(auction.baseMultiplier) < 1000000n ||
      BigInt(auction.maxMultiplier) < BigInt(auction.baseMultiplier) ||
      BigInt(auction.maxMultiplier) > 100000000n ||
      !Number.isInteger(auction.deadlineSeconds) ||
      auction.deadlineSeconds < 30 ||
      auction.deadlineSeconds > (this.data?.maxTaskSeconds ?? 180)
    )
      throw Error("Invalid bidding policy or deadline.");
  }
  configure(
    id: string,
    prompt: string,
    budgetNano: string,
    preference: Preference,
    auction = defaultAuction,
  ) {
    const row = this.row(id);
    if (row.session.started)
      throw Error(
        "Create a new task to change a running or completed task authorization.",
      );
    this.validate(row.session.agent_id, prompt, budgetNano, auction);
    Object.assign(row.session, {
      prompt,
      budget_nano: budgetNano,
      preference,
      auction: { ...auction },
    });
    row.workspace["/workspace/task.txt"] = prompt;
    row.transcript = "> " + prompt + "\n";
    this.publish();
  }
  async run(id: string) {
    const row = this.row(id);
    if (row.running || row.session.started || row.stopping) return;
    if (
      [...this.rows.values()].some(
        (r) =>
          r !== row && r.session.agent_id === row.session.agent_id && r.running,
      )
    )
      throw Error("This agent already has a task running.");
    const epoch = this.epoch,
      alive = () => {
        if (epoch !== this.epoch || row.stopping)
          throw new DOMException("Stopped", "AbortError");
      };
    row.running = true;
    row.session.started = true;
    row.session.state = "running";
    row.abort = new AbortController();
    this.progress(row, "Preparing authorization");
    try {
      const root = (this.data!.roots ?? this.data!.grants).find(
        (g) => g.agent_id === row.session.agent_id,
      )!;
      const deadlineMs = Math.min(
        Date.now() + row.session.auction!.deadlineSeconds * 1000,
        Number(root.agent_deadline_ms ?? root.deadline_ms),
      );
      row.session.deadline_ms = String(deadlineMs);
      const callCapMicro = String(
        minimum(
          BigInt(root.agent_call_cap_micro ?? root.call_cap_micro),
          BigInt(row.session.budget_nano) / 1000n,
        ),
      );
      row.authorizationInput = {
        agentId: row.session.agent_id,
        operation: "grant-" + id,
        budgetNano: row.session.budget_nano,
        callCapMicro,
        deadlineMs,
      };
      const grant = await this.api<{ id: string; revision: string }>(
        "authorizations",
        row.authorizationInput,
        undefined,
        row.abort.signal,
      );
      alive();
      row.grant = {
        ...root,
        id: grant.id,
        revision: grant.revision,
        cap_nano: row.session.budget_nano,
        spent_nano: "0",
        reserved_nano: "0",
        deadline_ms: String(deadlineMs),
        call_cap_micro: callCapMicro,
        active: true,
      };
      const invoke = async (call: ModelCall) => {
        alive();
        let local = row.calls.get(call.logicalCallId);
        if (!local) {
          local = {
            logicalId: call.logicalCallId,
            revision: "0",
            bidMultiplier: row.session.auction!.baseMultiplier,
            manual: false,
            losses: 0,
            state: "bidding",
            ordinal: row.calls.size + 1,
          };
          row.calls.set(call.logicalCallId, local);
        }
        const nativeSignal = AbortSignal.any([call.signal, row.abort!.signal]);
        const decide = () => {
          const g =
            this.data?.grants.find((g) => g.id === row.grant!.id) ?? row.grant!;
          const a =
            this.data?.grants.find(
              (g) => g.agent_id === row.session.agent_id,
            ) ?? root;
          return buyerBid({
            settings: row.session.auction!,
            losses: local!.losses,
            availableNano: minimum(
              BigInt(g.cap_nano) -
                BigInt(g.reserved_nano) -
                BigInt(g.spent_nano),
              BigInt(a.agent_cap_nano) -
                BigInt(a.agent_reserved_nano) -
                BigInt(a.agent_spent_nano),
            ),
            callCapMicro,
            futureCalls: Math.max(0, 2 - local!.ordinal),
            service: this.data!.service,
            pricing: this.data!.pricing,
            gasCapYocto: root.gas_cap_yocto ?? "1000000000000000000",
            deadlineMs,
          });
        };
        let choice = decide();
        while (choice.action === "wait") {
          this.progress(row, choice.reason);
          await sleep(1000, nativeSignal);
          await this.refresh();
          alive();
          choice = decide();
        }
        if (choice.action === "stop") throw Error(choice.reason);
        local.bidMultiplier = choice.multiplier;
        const { procurementTransport } = await import(
          "../../../services/mpp-near-direct/client/task.mjs"
        );
        alive();
        const transport = procurementTransport({
          url: this.data?.inferenceEndpoint ?? "/buyer-api/procure",
          nativeChat: this.data?.inferenceEndpoint !== undefined,
          paymentHeader: this.data?.paymentHeader,
          agentId: row.session.agent_id,
          authorizationId: row.grant!.id,
          bidMultiplier: local.bidMultiplier,
          maxTotalMicro: callCapMicro,
          expiryMs: deadlineMs,
          maxRetries: this.data?.paymentMethod === "nearintents" ? 36000 : 1800,
          retryDelayMs: 100,
          onWaiting: async (status: Waiting) => {
            alive();
            if (status.state && status.state !== "waiting")
              throw Error("The original bid is " + status.state + ".");
            local!.bidId = status.bidId ?? local!.bidId;
            local!.revision =
              status.revision ?? status.bidRevision ?? local!.revision;
            local!.reason = status.lastRound?.reason?.replaceAll("_", " ");
            if (
              status.lastRound?.outcome === "lost" &&
              status.lastRound.id !== local!.lastRound
            ) {
              local!.losses++;
              local!.lastRound = status.lastRound.id;
              if (!local!.manual) {
                const next = decide();
                if (
                  next.action === "bid" &&
                  BigInt(next.multiplier) > BigInt(local!.bidMultiplier)
                )
                  try {
                    const revision = await this.api<{ revision: string }>(
                      "bids/" + local!.bidId + "/revise",
                      {
                        action: "revise",
                        operation: crypto.randomUUID(),
                        expectedRevision: local!.revision,
                        bidMultiplier: next.multiplier,
                      },
                      undefined,
                      nativeSignal,
                    );
                    alive();
                    local!.revision = revision.revision;
                    local!.bidMultiplier = next.multiplier;
                  } catch (e) {
                    if (
                      !(e instanceof Error) ||
                      !("code" in e) ||
                      ![
                        "revision_conflict",
                        "bid_already_frozen",
                        "bid_revision_rate_limit",
                      ].includes(String(e.code))
                    )
                      throw e;
                  }
              }
            }
            local!.state = status.allocationId ? "executing" : "bidding";
            this.progress(
              row,
              status.allocationId
                ? `Model call ${local!.ordinal} · ${status.executionState ?? "executing"}`
                : `Model call ${local!.ordinal} · bid ${multiplier(local!.bidMultiplier)}× · waiting for allocation`,
            );
          },
          onPaymentChallenge: async (
            status: {
              allocationId: string;
              bidId?: string;
              bidRevision?: string;
              challenge: { id: string };
              contract: { contractHash: string };
            },
            signal?: AbortSignal,
          ) => {
            alive();
            local!.bidId = status.bidId ?? local!.bidId;
            local!.revision = status.bidRevision ?? local!.revision;
            local!.state = "paying";
            this.progress(
              row,
              `Model call ${local!.ordinal} · allocated · paying original order`,
            );
            try {
              return await this.api<{ paymentAuthorization?: string | null }>(
                "orders/" +
                  status.allocationId +
                  (this.data?.paymentMethod === "nearintents"
                    ? "/mpp-credential"
                    : "/pay"),
                {
                  challengeId: status.challenge.id,
                  contractHash: status.contract.contractHash,
                },
                undefined,
                signal,
              );
            } catch (e) {
              if (
                !(e instanceof Error) ||
                !("code" in e) ||
                !String(e.code).includes("unknown")
              )
                throw e;
            }
          },
        });
        this.progress(
          row,
          `Model call ${local.ordinal} · bid ${multiplier(local.bidMultiplier)}× · waiting for allocation`,
        );
        const response = await (
          transport as { invoke(call: ModelCall): Promise<Response> }
        ).invoke({ ...call, signal: nativeSignal });
        alive();
        local.state = response.ok ? "result_available" : "unknown";
        this.progress(
          row,
          response.ok
            ? "Model response received"
            : "Original order needs reconciliation",
        );
        return response;
      };
      const factory =
        this.options.factory ??
        (async (options: RuntimeOptions) => {
          const { createMemoryTask } = await import(
            "../../../services/mpp-near-direct/client/task.mjs"
          );
          return createMemoryTask(options);
        });
      const numbers = row.workspace["/workspace/numbers.txt"]
        .trim()
        .split("\n")
        .map(Number);
      const runtime = await factory({
        task: {
          version: "workspace-sum-json-v1",
          numbers,
          prompt: row.session.prompt,
          files: { ...row.workspace },
        },
        transport: { invoke },
        runId: id,
        model: this.data!.service.model,
        maxOutputTokens: this.data!.service.maxOutputTokens,
        deadlineMs,
        wasm: this.options.wasm,
        onEvent: (event) => {
          if (epoch !== this.epoch || row.stopping) return;
          if (event.type === "text_delta")
            row.transcript += String(event.text ?? event.delta ?? "");
          if (event.type === "local_tool") {
            const result = event.result as { stdout?: string; stderr?: string };
            row.transcript +=
              "\n[bash] " +
              String(event.command) +
              "\n" +
              (result.stdout ?? "") +
              (result.stderr ?? "");
            this.progress(row, "Running task tools");
            void this.readFiles(row, epoch).catch((error) => {
              if (epoch === this.epoch) {
                row.error = (error as Error).message;
                this.publish();
              }
            });
          }
          this.publish();
        },
      });
      row.runtime = runtime;
      try {
        alive();
      } catch (e) {
        await runtime.close();
        throw e;
      }
      row.evidence = await runtime.run();
      alive();
      await this.readFiles(row, epoch);
      alive();
      row.session.state =
        row.evidence.state === "complete" ? "complete" : "error";
      row.transcript += "\n[" + row.session.state + "]\n";
      this.progress(
        row,
        row.session.state === "complete"
          ? "Task complete · artifact verified"
          : "Task finished without a verified artifact",
      );
    } catch (e) {
      if (epoch === this.epoch && !row.stopping) {
        row.session.state = "interrupted";
        row.error = (e as Error).message;
        row.progress = "Task interrupted · check original orders";
      }
    } finally {
      row.running = false;
      if (epoch === this.epoch) {
        this.publish();
        await this.refresh().catch(() => {});
      }
    }
  }
  private async readFiles(row: Row, epoch: number) {
    if (!row.runtime?.readWorkspace) return;
    const files = await row.runtime.readWorkspace();
    if (epoch === this.epoch) {
      row.workspace = files;
      this.publish();
    }
  }
  async pause(id: string) {
    const row = this.row(id);
    const completed = row.session.state === "complete";
    row.stopping = true;
    row.abort?.abort();
    void row.runtime?.close().catch(() => {});
    try {
      if (!row.grant && row.authorizationInput) {
        const g = await this.api<{ id: string; revision: string }>(
          "authorizations",
          row.authorizationInput,
        );
        row.grant = {
          ...this.data!.grants.find(
            (g) => g.agent_id === row.session.agent_id,
          )!,
          ...g,
        };
      }
      if (row.grant) {
        await this.refresh();
        const g =
          this.data?.grants.find((g) => g.id === row.grant!.id) ?? row.grant;
        if (g.active)
          await this.api("authorizations/" + g.id + "/revoke", {
            expectedRevision: g.revision,
          });
      }
      row.session.state = completed ? "complete" : "paused";
      row.session.paused = true;
      row.progress = completed
        ? "Task complete · authorization revoked"
        : "Paused · authorization revoked";
      row.error = "";
      this.publish();
      await this.refresh();
      return true;
    } catch (e) {
      row.session.state = "interrupted";
      row.error =
        "Local execution stopped; authorization revocation is unconfirmed. " +
        (e as Error).message;
      this.publish();
      return false;
    }
  }
  async changeBid(
    id: string,
    call: Call,
    action: string,
    bidMultiplier?: string,
  ) {
    const row = this.row(id),
      local = [...row.calls.values()].find((c) => c.bidId === call.id);
    if (!local || call.historical)
      throw Error("This bid belongs to an earlier page run.");
    if (action === "resume_auto") {
      local.manual = false;
      this.publish();
      return;
    }
    if (
      action === "revise_bid" &&
      (!bidMultiplier ||
        BigInt(bidMultiplier) < 1000000n ||
        BigInt(bidMultiplier) > BigInt(row.session.auction!.maxMultiplier))
    )
      throw Error("Bid must be within the configured economic ceiling.");
    const result = await this.api<{ revision: string }>(
      "bids/" + call.id + "/revise",
      {
        action: action === "cancel" ? "withdraw" : "revise",
        operation: crypto.randomUUID(),
        expectedRevision: local.revision,
        ...(bidMultiplier ? { bidMultiplier } : {}),
      },
    );
    local.revision = result.revision;
    local.manual = true;
    if (bidMultiplier) local.bidMultiplier = bidMultiplier;
    if (action === "cancel") local.state = "withdrawn";
    this.publish();
  }
  evidence(id: string) {
    const row = this.row(id);
    return {
      scope: "controlled-client-memory",
      task: row.evidence ?? row.runtime?.evidence ?? null,
      workspace: row.workspace,
      financial: this.orders.filter((o) => o.agentId === row.session.agent_id),
      authorizationId: row.grant?.id ?? null,
    };
  }
}
