// Scripted presentation data only. No provider, wallet, or hardware is queried.
export const experimentModes = ['baseline', 'matching', 'priority', 'combined'] as const;
export type ExperimentMode = typeof experimentModes[number];
export type StatisticsView = 'earnings' | 'cache' | 'latency' | 'trust';
export type StatisticsMetric = 'revenue' | 'margin' | 'goodput' | 'cacheHit' | 'ttft';
export interface StatisticsSample {
  second: number;
  baseRevenue: number;
  priorityRevenue: number;
  refunds: number;
  revenue: number;
  margin: number;
  goodput: number;
  cacheHit: number;
  newPrefillTokens: number;
  eligibleIdle: number;
  preemptions: number;
  ttft: number;
  regularWait: number;
  priorityFulfilled: number | null;
}
export const sampleGpuCost = 2.4;
export const statisticsStorageKey = 'private-market.statistics-preview.v1';
export interface StatisticsPreferences { open: boolean; mode: ExperimentMode; view: StatisticsView }
export function loadStatisticsPreferences(): StatisticsPreferences {
  try {
    const value = JSON.parse(sessionStorage.getItem(statisticsStorageKey) ?? 'null');
    if (value && typeof value.open === 'boolean' && experimentModes.includes(value.mode)
      && ['earnings', 'cache', 'latency', 'trust'].includes(value.view)) return value;
  } catch { /* The preview also works without browser storage. */ }
  return { open: true, mode: 'combined', view: 'earnings' };
}

const profiles: Record<ExperimentMode, {
  base: number; premium: number; refunds: number; goodput: number; hit: number;
  prefill: number; idle: number; preemptions: number; ttft: number; regularWait: number; fulfilled: number | null;
}> = {
  baseline: { base: 4.80, premium: 0, refunds: .08, goodput: .42, hit: .63, prefill: 780, idle: .22, preemptions: 2, ttft: 920, regularWait: 610, fulfilled: null },
  matching: { base: 6.00, premium: 0, refunds: .10, goodput: .54, hit: .65, prefill: 738, idle: .11, preemptions: 2, ttft: 810, regularWait: 520, fulfilled: null },
  priority: { base: 4.55, premium: 1.35, refunds: .12, goodput: .40, hit: .58, prefill: 886, idle: .19, preemptions: 4, ttft: 1020, regularWait: 760, fulfilled: .94 },
  combined: { base: 5.88, premium: 1.45, refunds: .14, goodput: .52, hit: .64, prefill: 759, idle: .10, preemptions: 2, ttft: 850, regularWait: 570, fulfilled: .97 },
};

// Each point is a scripted rolling-window snapshot, including its quantiles.
// All modes share the same workload variation. These are not benchmark results
// or extrapolations from buyer terminals. The UI never averages percentiles.
export function sampleStatistics(mode: ExperimentMode, second: number): StatisticsSample {
  const p = profiles[mode];
  const wave = 1 + .065 * Math.sin(second / 8) + .025 * Math.cos(second / 3.4);
  const load = 1 + .045 * Math.sin(second / 10 + .8);
  const baseRevenue = p.base * wave, priorityRevenue = p.premium * wave, refunds = p.refunds * wave;
  const revenue = baseRevenue + priorityRevenue - refunds;
  return { second, baseRevenue, priorityRevenue, refunds, revenue, margin: revenue - sampleGpuCost,
    goodput: p.goodput * wave, cacheHit: Math.min(1, Math.max(0, p.hit + .012 * Math.sin(second / 9))),
    newPrefillTokens: Math.round(p.prefill * (2 - load)), eligibleIdle: Math.max(0, p.idle + .012 * Math.cos(second / 11)),
    preemptions: p.preemptions, ttft: p.ttft * load, regularWait: p.regularWait * load,
    priorityFulfilled: p.fulfilled === null ? null : Math.min(1, p.fulfilled + .004 * Math.sin(second / 7)) };
}
export function statisticsWindow(mode: ExperimentMode, tick: number): StatisticsSample[] {
  return Array.from({ length: 61 }, (_, index) => sampleStatistics(mode, tick - 60 + index));
}
export function relativeChange(value: number, baseline: number): string {
  if (baseline <= 0) return '—';
  const percent = (value / baseline - 1) * 100;
  return `${percent > 0 ? '+' : ''}${percent.toFixed(1)}%`;
}
export const dollars = (value: number) => `${value < 0 ? '−' : ''}$${Math.abs(value).toFixed(2)}`;
export const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
