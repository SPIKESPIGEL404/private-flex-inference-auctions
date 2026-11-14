import { useEffect, useId, useRef, useState } from 'react';
import { useProviderTelemetry } from './provider-telemetry';
import type { EngineSnapshot, LiveMetric } from './provider-telemetry';

const labels: Record<LiveMetric, string> = {
  running: 'Running requests', waiting: 'Waiting requests', outputTokensPerSecond: 'Output tokens / s',
  kvUsage: 'KV cache used', cacheHitRate: 'Prefix cache hits', ttftP95Ms: 'p95 time to first token',
  queueP95Ms: 'p95 queue time', inputTokensPerSecond: 'Input tokens / s',
  newPrefillTokensPerRequest: 'New KV tokens / request', preemptionsTotal: 'Preemptions since boot',
  completedPerSecond: 'Completed requests / s',
};
const primary: LiveMetric[] = ['running', 'waiting', 'outputTokensPerSecond', 'kvUsage', 'cacheHitRate', 'ttftP95Ms'];
const secondary: LiveMetric[] = ['inputTokensPerSecond', 'queueP95Ms', 'newPrefillTokensPerRequest', 'completedPerSecond', 'preemptionsTotal'];
function format(metric: LiveMetric, value: number | null): string {
  if (value === null) return '—';
  if (metric === 'kvUsage' || metric === 'cacheHitRate') return `${(value * 100).toFixed(1)}%`;
  if (metric === 'ttftP95Ms' || metric === 'queueP95Ms') return `${Math.round(value)} ms`;
  return ['running', 'waiting', 'preemptionsTotal', 'newPrefillTokensPerRequest'].includes(metric)
    ? Math.round(value).toLocaleString() : value.toFixed(1);
}
function EngineChart({ snapshot, metric }: { snapshot: EngineSnapshot; metric: LiveMetric }) {
  const id = useId(), ref = useRef<HTMLDivElement>(null);
  const [{ width, height }, setSize] = useState({ width: 900, height: 160 });
  useEffect(() => {
    if (!ref.current) return;
    const observer = new ResizeObserver(([entry]) => {
      const next = { width: Math.max(240, entry.contentRect.width), height: Math.max(100, entry.contentRect.height) };
      setSize(previous => previous.width === next.width && previous.height === next.height ? previous : next);
    });
    observer.observe(ref.current); return () => observer.disconnect();
  }, []);
  const left = 65, right = width - 15, top = 12, bottom = height - 30;
  const points = snapshot.history;
  const end = snapshot.observedAt || Date.now(), start = end - 300_000;
  const max = Math.max(1, ...points.map(point => point.metrics[metric] ?? 0)) * 1.1;
  const x = (at: number) => left + (at - start) / 300_000 * (right - left);
  const y = (value: number) => bottom - value / max * (bottom - top);
  let path = '', last = 0;
  for (const point of points) {
    const value = point.metrics[metric];
    if (value === null) { last = 0; continue; }
    path += `${last && point.at - last <= 15_000 ? 'L' : 'M'}${x(point.at).toFixed(1)},${y(value).toFixed(1)} `;
    last = point.at;
  }
  return <div ref={ref} className="engine-plot"><svg viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby={`${id}-title ${id}-description`}>
    <title id={`${id}-title`}>{labels[metric]} · engine samples</title>
    <desc id={`${id}-description`}>Five minutes of actual engine samples. Missing observations leave gaps; no simulated baseline.</desc>
    {[0, .5, 1].map(fraction => <g key={fraction}>
      <line className="stats-gridline" x1={left} x2={right} y1={y(max * fraction)} y2={y(max * fraction)} />
      {path ? <text className="stats-axis" x={left - 12} y={y(max * fraction) + 4} textAnchor="end">{format(metric, max * fraction)}</text> : null}
    </g>)}
    {path ? <path className="stats-current-line" d={path} /> : <text className="stats-axis" x={width / 2} y={height / 2} textAnchor="middle">Waiting for observations</text>}
    <text className="stats-axis" x={left} y={height - 6}>−5m</text>
    <text className="stats-axis" x={(left + right) / 2} y={height - 6} textAnchor="middle">−2m 30s</text>
    <text className="stats-axis" x={right} y={height - 6} textAnchor="end">now</text>
  </svg></div>;
}

export function LiveProviderStatistics({ open = true, onOpenChange, accessScope = '', standalone = false, compact = false, onSizeChange }: {
  open?: boolean; onOpenChange?: (open: boolean) => void; accessScope?: string; standalone?: boolean;
  compact?: boolean; onSizeChange?: () => void;
}) {
  const live = useProviderTelemetry(accessScope);
  const [frozen, setFrozen] = useState<EngineSnapshot | null>(null);
  const [metric, setMetric] = useState<LiveMetric>('outputTokensPerSecond');
  const data = frozen ?? live, panelId = useId();
  const stateLabel = frozen ? 'view paused' : live.state;
  const note = live.state === 'disabled' ? 'The host has not connected Prometheus yet.'
    : live.state === 'unauthorized' ? 'Sign in from the playground to view engine telemetry.'
    : ['unavailable', 'disconnected', 'stale'].includes(live.state)
      ? 'No fresh sample. The Chute may be cold, restarting, or unreachable.'
      : live.state === 'starting' ? 'Connecting to the engine feed…' : null;
  const age = frozen && data.sampledAt !== null ? `snapshot at ${new Date(data.sampledAt).toLocaleTimeString()}`
    : data.ageMs === null ? 'no sample yet' : `${Math.floor(data.ageMs / 1000)}s since sample`;
  return <section className={`provider-stats live-stats ${open ? 'stats-expanded' : 'stats-collapsed'} ${standalone ? 'standalone-stats' : ''} ${compact ? 'compact-engine' : ''}`} aria-label="Live engine statistics">
    <div className="stats-heading">
      <button className="stats-heading-toggle" aria-expanded={open} aria-controls={panelId} onClick={() => onOpenChange?.(!open)} disabled={!onOpenChange}>
        <span className="stats-pane-label">[gpu]</span><span>qwen3.8-27b</span>
      </button>
      <span className={`stats-source engine-state engine-state-${live.state}`} role="status">{stateLabel}</span>
      <span className="engine-age">{age}</span>
      {!open ? <span className="engine-collapsed-summary">run {format('running', data.metrics.running)} · wait {format('waiting', data.metrics.waiting)} · output {format('outputTokensPerSecond', data.metrics.outputTokensPerSecond)} tok/s</span> : null}
      {open ? <div className="stats-controls">{onSizeChange ? <button onClick={onSizeChange}>{compact ? 'expand panel' : 'compact panel'}</button> : null}<button onClick={() => setFrozen(frozen ? null : live)}>{frozen ? 'resume live view' : 'pause view'}</button></div> : null}
    </div>
    <div id={panelId} className="stats-expanded-content" hidden={!open}>
      {note && !frozen ? <div className="engine-notice">{note}</div> : null}
      <div className="stats-kpis engine-kpis" aria-label="Measured engine metrics">{primary.map(key =>
        <button key={key} className={`stats-kpi ${metric === key ? 'stats-kpi-selected' : ''}`} aria-pressed={metric === key} onClick={() => setMetric(key)}>
          <span className="stats-kpi-label">{labels[key]}</span><span className="stats-kpi-value">{format(key, data.metrics[key])}</span>
          <span className="engine-kpi-scope">{['running', 'waiting', 'kvUsage'].includes(key) ? 'latest sample' : '60s window'}</span>
        </button>)}</div>
      <div className="engine-chart-header"><label>chart <select value={metric} onChange={event => setMetric(event.target.value as LiveMetric)} aria-label="Live chart metric">
        {[...primary, ...secondary].map(key => <option key={key} value={key}>{labels[key]}</option>)}
      </select></label><span>measured · 5m history</span></div>
      <div className="engine-chart-area"><EngineChart snapshot={data} metric={metric} />
        <dl className="stats-details engine-details">{secondary.map(key => <div key={key}><dt>{labels[key]}</dt><dd>{format(key, data.metrics[key])}</dd></div>)}</dl>
      </div>
      {standalone ? <div className="engine-provenance">
        <span>source: authenticated vLLM metrics</span>
        <span>engine started: {data.epoch ? new Date(Number(data.epoch) * 1000).toLocaleString() : '—'}</span>
        <span>samples are unsigned · hardware attestation is separate</span>
      </div> : null}
      <div className="stats-footer"><span>{frozen ? 'view paused · collection continues' : '5s scrape · 60s window · — awaiting observations'}</span>
        <span className="stats-footer-disclosure">All engine traffic · KV cache ≠ GPU compute utilization</span></div>
    </div>
  </section>;
}

export function GpuDashboard() {
  return <main className="gpu-dashboard"><header className="gpu-topbar"><a href="/">← playground</a><h1>GPU / live</h1><span>qwen3.8-27b</span></header>
    <LiveProviderStatistics standalone />
  </main>;
}
