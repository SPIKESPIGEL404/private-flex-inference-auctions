export interface TaskDefinition {
  version: string;
  numbers: number[];
  prompt: string;
  files: Record<string, string>;
}
export interface TaskEvidence {
  version: number;
  runId: string;
  taskVersion: string;
  state: string;
  startedAtMs: number | null;
  calls: Array<Record<string, unknown>>;
  tools: Array<Record<string, unknown>>;
  [key: string]: unknown;
}
export interface MemoryTask {
  runId: string;
  evidence: TaskEvidence;
  run(): Promise<TaskEvidence>;
  close(): Promise<void>;
  readWorkspace?(): Promise<Record<string, string>>;
}
export function sumTask(numbers: number[]): TaskDefinition;
export function verifyArtifact(
  task: TaskDefinition,
  text: string | null,
): { outcome: string; evaluator: string; reason?: string };
export function createMemoryTask(options: {
  task: TaskDefinition;
  transport: unknown;
  runId?: string;
  model?: string;
  maxOutputTokens?: number;
  maxCalls?: number;
  deadlineMs: number;
  wasm?: string;
  onEvent?: (event: Record<string, unknown>) => void;
}): Promise<MemoryTask>;
export function procurementTransport(options: {
  url: string;
  authorizationId: string;
  agentId?: string;
  bidMultiplier?: string;
  maxTotalMicro?: string;
  expiryMs?: number;
  fetcher?: typeof fetch;
  retryDelayMs?: number;
  maxRetries?: number;
  onWaiting?: (
    status: {
      bidId?: string;
      revision?: string;
      bidRevision?: string;
      state?: string;
      allocationId?: string;
      executionState?: string;
      lastRound?: { id: string; outcome: string; reason: string };
    },
    signal?: AbortSignal,
  ) => Promise<void>;
  onPaymentChallenge?: (
    status: {
      allocationId: string;
      bidId?: string;
      bidRevision?: string;
      orderId: string;
      challenge: { id: string };
      contract: { contractHash: string };
    },
    signal?: AbortSignal,
  ) => Promise<void>;
}): unknown;
