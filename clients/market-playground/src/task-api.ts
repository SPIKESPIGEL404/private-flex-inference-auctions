export type Preference = 'save' | 'balanced' | 'fast';
export interface Capabilities { version: 1; nativeWallets?: boolean; ownerAuth?: 'nep413'|'code'; mode: 'controlled' | 'wallet-setup'; tasks: boolean; walletSetup: boolean; realInferencePayments: false; maxTasksPerAgent?: number; taskWindowMs?: number }
export interface AgentSession {
  id: string; agent_id: string; payer: string; state: string; phase?: string; started?: boolean; paused: boolean;
  task_id: string; revision: string; generation: string; preference: Preference;
  budget_nano: string; reserved_nano: string; spent_nano: string; prompt: string; deadline_ms: string;
}
export interface AgentLimit { agent_id: string; budget_nano: string; spent_nano: string; reserved_nano: string }
export interface Call { id: string; state: string; revision: string; bid_nano: string; manual: boolean; decision?: { result: { reason?: string } } }
export interface TaskStatus {
  id: string; state: string; phase?: string; started?: boolean; transcript: string; workspace: Record<string, string>;
  result?: {stopReason: string} | null;
  task: { budget_nano: string; hard_bid_nano: string; preference: Preference; revision: string };
  calls: Call[]; orders: Array<{ state: string; principal: { P: string; C: string; H: string; W: string; R: string } }>;
}
export class TaskApiError extends Error {
  constructor(readonly code: string) { super(code.replaceAll('_', ' ')); }
}
export async function taskApi<T>(path: string, body?: unknown, method?: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch('/buyer-api/' + path, { method: method ?? (body === undefined ? 'GET' : 'POST'),
    credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal,
    headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json();
  if (!response.ok) throw new TaskApiError(value.error?.code ?? 'workspace_unavailable');
  return value as T;
}
export function nanoUsd(value: string): string {
  const n = BigInt(value), negative = n < 0n, v = negative ? -n : n;
  return `${negative ? '-' : ''}$${v / 1_000_000_000n}.${String(v % 1_000_000_000n).padStart(9, '0').replace(/0+$/, '').padEnd(2, '0')}`;
}
export function parseNanoUsd(value: string): string | null {
  if (!/^(?:0|[1-9]\d{0,3})(?:\.\d{1,9})?$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  const n = BigInt(whole) * 1_000_000_000n + BigInt(fraction.padEnd(9, '0'));
  return n > 0n ? String(n) : null;
}
export const editableUsd = (value: string) => nanoUsd(value).slice(1);
