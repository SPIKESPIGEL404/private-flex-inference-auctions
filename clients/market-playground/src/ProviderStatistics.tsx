import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { dollars, experimentModes, percent, relativeChange, sampleGpuCost, statisticsWindow } from './statistics';
import type { ExperimentMode, StatisticsMetric, StatisticsSample, StatisticsView } from './statistics';

const views: StatisticsView[] = ['earnings', 'cache', 'latency', 'trust'];
const metricLabels: Record<StatisticsMetric, string> = {
  revenue: 'seller revenue / GPU·h', margin: 'estimated margin / GPU·h', goodput: 'SLO goodput / GPU',
  cacheHit: 'prefix cache hit rate', ttft: 'p95 time to first token',
};
function formatMetric(metric: StatisticsMetric, value: number): string {
  if (metric === 'revenue' || metric === 'margin') return dollars(value);
  if (metric === 'cacheHit') return percent(value);
  if (metric === 'ttft') return `${Math.round(value)} ms`;
  return `${value.toFixed(2)} req/s`;
}

function ComparisonChart({ metric, current, baseline, mode }: {
  metric: StatisticsMetric; current: StatisticsSample[]; baseline: StatisticsSample[]; mode: ExperimentMode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(700);
  const id = useId();
  useEffect(() => {
    if (!ref.current) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(240, entry.contentRect.width)));
    observer.observe(ref.current); return () => observer.disconnect();
  }, []);
  const height = 104, left = 65, right = width - 12, top = 10, bottom = 77;
  const all = [...current, ...baseline].map(point => point[metric]);
  const max = Math.max(...all) * 1.15 || 1;
  const min = metric === 'margin' ? Math.min(0, ...all) : 0;
  const y = (value: number) => bottom - (value - min) / (max - min) * (bottom - top);
  const points = (data: StatisticsSample[]) => data.map((point, index) =>
    `${(left + index / (data.length - 1) * (right - left)).toFixed(1)},${y(point[metric]).toFixed(1)}`).join(' ');
  const currentValue = current.at(-1)![metric], baselineValue = baseline.at(-1)![metric];
  return <div ref={ref} className="stats-plot">
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby={`${id}-title ${id}-description`}>
      <title id={`${id}-title`}>{metricLabels[metric]} · simulated comparison</title>
      <desc id={`${id}-description`}>{mode}: {formatMetric(metric, currentValue)}. Baseline: {formatMetric(metric, baselineValue)}. Scripted sample data over sixty seconds; not a measured experiment.</desc>
      {[0, .5, 1].map(fraction => {
        const value = min + (max - min) * fraction;
        return <g key={fraction}><line className="stats-gridline" x1={left} x2={right} y1={y(value)} y2={y(value)} />
          <text className="stats-axis" x={left - 9} y={y(value) + 4} textAnchor="end">{metric === 'ttft' ? Math.round(value) : metric === 'cacheHit' ? `${Math.round(value * 100)}%` : value.toFixed(1)}</text></g>;
      })}
      <polyline className="stats-baseline-line" points={points(baseline)} />
      <polyline className="stats-current-line" points={points(current)} />
      <circle className="stats-endpoint" cx={right} cy={y(currentValue)} r={2.5} />
      <text className="stats-axis" x={left} y={98}>−60s</text>
      <text className="stats-axis" x={(left + right) / 2} y={98} textAnchor="middle">−30s</text>
      <text className="stats-axis" x={right} y={98} textAnchor="end">now</text>
    </svg>
  </div>;
}

export function ProviderStatistics({ open, mode, view, onOpenChange, onModeChange, onViewChange }: {
  open: boolean; mode: ExperimentMode; view: StatisticsView;
  onOpenChange: (open: boolean) => void; onModeChange: (mode: ExperimentMode) => void;
  onViewChange: (view: StatisticsView) => void;
}) {
  const [playing, setPlaying] = useState(true);
  const [tick, setTick] = useState(60);
  const [earningsMetric, setEarningsMetric] = useState<StatisticsMetric>('revenue');
  const panelId = useId();
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  useEffect(() => {
    if (!playing || !open) return;
    const timer = window.setInterval(() => setTick(value => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [playing, open]);
  const current = useMemo(() => statisticsWindow(mode, tick), [mode, tick]);
  const baseline = useMemo(() => statisticsWindow('baseline', tick), [tick]);
  const latest = current.at(-1)!, baselineLatest = baseline.at(-1)!;
  const metric = view === 'cache' ? 'cacheHit' : view === 'latency' ? 'ttft' : earningsMetric;
  const details: Array<[string, string]> = view === 'cache'
    ? [['new prefill / request', `${Math.round(latest.newPrefillTokens)} tok`], ['eligible engine idle', percent(latest.eligibleIdle)], ['preemptions / window', String(latest.preemptions)]]
    : view === 'latency'
      ? [['p95 TTFT', `${Math.round(latest.ttft)} ms`], ['regular p95 queue', `${Math.round(latest.regularWait)} ms`], ['priority SLO met', latest.priorityFulfilled === null ? 'n/a' : percent(latest.priorityFulfilled)]]
      : [['base service / GPU·h', dollars(latest.baseRevenue)], ['priority fees / GPU·h', dollars(latest.priorityRevenue)], ['refunds / GPU·h', `−${dollars(latest.refunds)}`]];
  const chartLabel = view === 'trust' ? 'source & coverage' : metricLabels[metric];
  return <section className={`provider-stats ${open ? 'stats-expanded' : 'stats-collapsed'}`} aria-label="Provider statistics">
    <div className="stats-heading">
      <button className="stats-heading-toggle" aria-expanded={open} aria-controls={panelId} onClick={() => onOpenChange(!open)}>
        <span className="stats-pane-label">[stats]</span><span className="stats-heading-name">provider</span><span className="stats-chevron">{open ? '⌄' : '⌃'}</span>
      </button>
      <span className="stats-provider-name">Qwen3.8-27B <span>/ RTX PRO 6000</span></span>
      <span className="stats-source" title="Scripted browser-local data. No provider, wallet, or hardware telemetry is connected.">simulated</span>
      {open ? <div className="stats-controls">
        <label>mode <select aria-label="Statistics experiment mode" value={mode} onChange={e => onModeChange(e.target.value as ExperimentMode)}>
          {experimentModes.map(value => <option key={value} value={value}>{value}</option>)}
        </select></label>
        <button aria-label={playing ? 'Pause sample statistics' : 'Resume sample statistics'} onClick={() => setPlaying(value => !value)}>{playing ? 'pause feed' : 'resume feed'}</button>
      </div> : <span className="stats-collapsed-hint">sample feed · {mode}</span>}
    </div>
    <div id={panelId} className="stats-expanded-content" hidden={!open}>
      <div className="stats-kpis" aria-label="Simulated provider metrics">
        {(['revenue', 'margin', 'goodput'] as const).map(key => <button key={key} className={`stats-kpi ${metric === key && view === 'earnings' ? 'stats-kpi-selected' : ''}`}
          aria-pressed={metric === key && view === 'earnings'} onClick={() => { setEarningsMetric(key); onViewChange('earnings'); }}>
          <span className="stats-kpi-label">{metricLabels[key]}</span>
          <span className="stats-kpi-value">{formatMetric(key, latest[key])}</span>
          <span className="stats-kpi-delta">{relativeChange(latest[key], baselineLatest[key])} <span>vs baseline · sample</span></span>
        </button>)}
      </div>
      <div className="stats-chart-heading">
        <div className="stats-tabs" role="tablist" aria-label="Statistics views">{views.map((item, index) => <button key={item}
          ref={element => { tabRefs.current[index] = element; }} role="tab" id={`${panelId}-${item}`} aria-selected={view === item}
          aria-controls={`${panelId}-view`} tabIndex={view === item ? 0 : -1} onClick={() => onViewChange(item)}
          onKeyDown={e => {
            let next = index;
            if (e.key === 'ArrowRight') next = (index + 1) % views.length;
            else if (e.key === 'ArrowLeft') next = (index - 1 + views.length) % views.length;
            else if (e.key === 'Home') next = 0;
            else if (e.key === 'End') next = views.length - 1;
            else return;
            e.preventDefault(); onViewChange(views[next]); tabRefs.current[next]?.focus();
          }}>{item}</button>)}</div>
        {view !== 'trust' && <div className="stats-legend"><span><i className="legend-current" />{mode}</span><span><i className="legend-baseline" />baseline</span></div>}
      </div>
      <div id={`${panelId}-view`} className="stats-view" role="tabpanel" aria-labelledby={`${panelId}-${view}`}>
        <span className="sr-only">{chartLabel}</span>
        {view === 'trust' ? <dl className="stats-trust">
          <div><dt>telemetry source</dt><dd>browser fixture</dd></div>
          <div><dt>serving target</dt><dd>vLLM · 1 GPU</dd></div>
          <div><dt>hardware attestation</dt><dd>not connected</dd></div>
          <div><dt>model / config revision</dt><dd>—</dd></div>
          <div><dt>signed sample coverage</dt><dd>—</dd></div>
          <div><dt>hardware counters</dt><dd>unavailable</dd></div>
        </dl> : <div className="stats-chart-layout">
          {open && <ComparisonChart metric={metric} current={current} baseline={baseline} mode={mode} />}
          <dl className="stats-details">{details.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
        </div>}
      </div>
      <div className="stats-footer"><span><span className="stats-feed-indicator">{playing ? '●' : 'Ⅱ'}</span> {playing ? 'sample feed · 1s' : 'sample feed paused'} <span className="stats-window-note">/ 60s window</span></span>
        <span className="stats-footer-disclosure">scripted comparison · assumed cost {dollars(sampleGpuCost)}/GPU·h</span></div>
    </div>
  </section>;
}
