import { useEffect, useState } from 'react';

export const liveMetricKeys = ['running', 'waiting', 'kvUsage', 'outputTokensPerSecond',
  'inputTokensPerSecond', 'cacheHitRate', 'ttftP95Ms', 'queueP95Ms',
  'newPrefillTokensPerRequest', 'preemptionsTotal', 'completedPerSecond'] as const;
export type LiveMetric = typeof liveMetricKeys[number];
export type EngineMetrics = Record<LiveMetric, number | null>;
export type FeedState = 'live' | 'starting' | 'disabled' | 'stale' | 'unavailable' | 'unauthorized' | 'disconnected';
export interface EnginePoint { at: number; epoch: string; metrics: EngineMetrics }
export interface EngineSnapshot {
  version: 1; source: 'vllm'; model: 'qwen3.8-27b'; state: FeedState;
  seq: number; observedAt: number; sampledAt: number | null; ageMs: number | null;
  staleAfterMs: number; epoch: string | null; metrics: EngineMetrics;
  history: EnginePoint[];
}
const emptyMetrics = (): EngineMetrics => Object.fromEntries(liveMetricKeys.map(key => [key, null])) as EngineMetrics;
const initial: EngineSnapshot = { version: 1, source: 'vllm', model: 'qwen3.8-27b', state: 'starting',
  seq: 0, observedAt: 0, sampledAt: null, ageMs: null, staleAfterMs: 20_000,
  epoch: null, metrics: emptyMetrics(), history: [] };
const states: FeedState[] = ['live', 'starting', 'disabled', 'stale', 'unavailable'];
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object'; }
function finite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value); }
function metrics(value: unknown): EngineMetrics {
  if (!record(value)) throw new Error('invalid_telemetry');
  return Object.fromEntries(liveMetricKeys.map(key => [key,
    finite(value[key]) && value[key] >= 0 ? value[key] : null])) as EngineMetrics;
}
export function decodeSnapshot(value: unknown): EngineSnapshot {
  if (!record(value) || value.version !== 1 || value.source !== 'vllm' || value.model !== 'qwen3.8-27b' ||
    !states.includes(value.state as FeedState) || !finite(value.seq) || !finite(value.observedAt) ||
    !finite(value.staleAfterMs) || value.staleAfterMs < 1000 || value.staleAfterMs > 60_000 ||
    !(value.sampledAt === null || finite(value.sampledAt)) || !(value.ageMs === null || finite(value.ageMs)) ||
    !(value.epoch === null || typeof value.epoch === 'string')) throw new Error('invalid_telemetry');
  const history: EnginePoint[] = [];
  if (value.history !== undefined) {
    if (!Array.isArray(value.history) || value.history.length > 180) throw new Error('invalid_telemetry');
    for (const point of value.history) {
      if (!record(point) || !finite(point.at) || typeof point.epoch !== 'string') throw new Error('invalid_telemetry');
      history.push({ at: point.at, epoch: point.epoch, metrics: metrics(point.metrics) });
    }
  }
  return { version: 1, source: 'vllm', model: 'qwen3.8-27b', state: value.state as FeedState,
    seq: value.seq, observedAt: value.observedAt, sampledAt: value.sampledAt, ageMs: value.ageMs,
    staleAfterMs: value.staleAfterMs, epoch: value.epoch, metrics: metrics(value.metrics), history };
}

export function useProviderTelemetry(accessScope = '') {
  const [data, setData] = useState(initial);
  const [receivedAt, setReceivedAt] = useState(0);
  const [clock, setClock] = useState(0);
  useEffect(() => {
    let active = true, stream: EventSource | null = null;
    const abort = new AbortController();
    setData(initial); setReceivedAt(0);
    const accept = (value: unknown) => {
      const next = decodeSnapshot(value);
      if (!active) return;
      const at = performance.now(); setReceivedAt(at); setClock(at);
      setData(previous => {
        let history = record(value) && Array.isArray(value.history) ? next.history
          : previous.epoch === next.epoch ? previous.history : [];
        if (next.state === 'live' && next.sampledAt !== null && next.epoch && history.at(-1)?.at !== next.sampledAt)
          history = [...history, { at: next.sampledAt, epoch: next.epoch, metrics: next.metrics }];
        history = history.filter(point => point.at >= next.observedAt - 300_000).slice(-180);
        return { ...next, history };
      });
    };
    void (async () => {
      try {
        const response = await fetch('/buyer-api/provider-telemetry', { credentials: 'same-origin', redirect: 'error', signal: abort.signal });
        if (response.status === 401) { if (active) setData({ ...initial, state: 'unauthorized' }); return; }
        if (!response.ok) throw new Error('telemetry_unavailable');
        const snapshot = await response.json(); accept(snapshot);
        if (!active || snapshot.state === 'disabled') return;
        stream = new EventSource('/buyer-api/provider-telemetry/events');
        stream.addEventListener('telemetry', event => {
          try { accept(JSON.parse((event as MessageEvent<string>).data)); }
          catch { if (active) setData(previous => ({ ...previous, state: 'unavailable', metrics: emptyMetrics() })); }
        });
        stream.onerror = () => { if (active) setData(previous => ({ ...previous, state: 'disconnected', metrics: emptyMetrics() })); };
      } catch { if (active) setData(previous => ({ ...previous, state: 'unavailable', metrics: emptyMetrics() })); }
    })();
    const timer = window.setInterval(() => setClock(performance.now()), 1000);
    return () => { active = false; abort.abort(); stream?.close(); window.clearInterval(timer); };
  }, [accessScope]);
  const elapsed = receivedAt ? Math.max(0, clock - receivedAt) : 0;
  const ageMs = data.ageMs === null ? null : data.ageMs + elapsed;
  const state = data.state === 'live' && (ageMs === null || ageMs > data.staleAfterMs) ? 'stale' : data.state;
  return { ...data, state, ageMs, metrics: state === 'live' ? data.metrics : emptyMetrics() };
}
