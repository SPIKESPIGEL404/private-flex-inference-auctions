// Read-only engine telemetry. No provider credential or caller-defined PromQL.
const publicModel = 'qwen3.8-27b';
const nativeModel = 'Qwen/Qwen3.8-27B-FP8';
export const metricKeys = ['running', 'waiting', 'kvUsage', 'outputTokensPerSecond',
  'inputTokensPerSecond', 'cacheHitRate', 'ttftP95Ms', 'queueP95Ms',
  'newPrefillTokensPerRequest', 'preemptionsTotal', 'completedPerSecond'];
const derivedKeys = metricKeys.filter(key => !['running', 'waiting', 'kvUsage', 'preemptionsTotal'].includes(key));
const queryKeys = new Set([...metricKeys, 'up', 'targets', 'sampledAt', 'epoch', 'series', 'epochChanges', 'counterResets']);
const emptyMetrics = () => Object.fromEntries(metricKeys.map(key => [key, null]));

export function telemetryConfig(env = process.env) {
  if (!env.PROVIDER_PROMETHEUS_URL) return null;
  const url = new URL(env.PROVIDER_PROMETHEUS_URL);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/')
    throw new Error('invalid_provider_prometheus_url');
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]', 'prometheus'].includes(url.hostname))
    throw new Error('provider_prometheus_requires_https_or_local_network');
  const job = env.PROVIDER_PROMETHEUS_JOB ?? 'chutes-qwen3.8-27b';
  if (!/^[a-zA-Z0-9_.-]{1,80}$/.test(job)) throw new Error('invalid_provider_prometheus_job');
  return { url: url.origin, job, public: env.PROVIDER_TELEMETRY_PUBLIC === '1' };
}

export function telemetryQuery(job) {
  if (!/^[a-zA-Z0-9_.-]{1,80}$/.test(job)) throw new Error('invalid_provider_prometheus_job');
  const target = `job="${job}"`, model = `${target},model_name="${nativeModel}"`;
  const rate = name => `sum(rate(${name}{${model}}[60s]))`;
  const increase = name => `sum(increase(${name}{${model}}[60s]))`;
  const resets = name => `(sum(resets(${name}{${model}}[60s])) or vector(0))`;
  const percentile = name => `1000 * histogram_quantile(0.95, sum by (le) (rate(${name}_bucket{${model}}[60s])))`;
  const queries = {
    up: `min(up{${target}})`, targets: `count(up{${target}})`,
    sampledAt: `min(timestamp(vllm:num_requests_running{${model}}))`,
    epoch: `max(process_start_time_seconds{${target}})`,
    series: `count(vllm:num_requests_running{${model}})`,
    epochChanges: `max(changes(process_start_time_seconds{${target}}[60s]))`,
    counterResets: `${resets('vllm:generation_tokens_total')} + ${resets('vllm:time_to_first_token_seconds_count')} + ${resets('vllm:prefix_cache_queries_total')}`,
    running: `sum(vllm:num_requests_running{${model}})`,
    waiting: `sum(vllm:num_requests_waiting{${model}})`,
    kvUsage: `max(vllm:kv_cache_usage_perc{${model}})`,
    outputTokensPerSecond: rate('vllm:generation_tokens_total'),
    inputTokensPerSecond: rate('vllm:prompt_tokens_total'),
    cacheHitRate: `${increase('vllm:prefix_cache_hits_total')} / ${increase('vllm:prefix_cache_queries_total')}`,
    ttftP95Ms: percentile('vllm:time_to_first_token_seconds'),
    queueP95Ms: percentile('vllm:request_queue_time_seconds'),
    newPrefillTokensPerRequest: `${increase('vllm:request_prefill_kv_computed_tokens_sum')} / ${increase('vllm:request_prefill_kv_computed_tokens_count')}`,
    preemptionsTotal: `sum(vllm:num_preemptions_total{${model}})`,
    completedPerSecond: rate('vllm:request_success_total'),
  };
  // One vector query gives every viewer a consistent observation time.
  return Object.entries(queries).map(([key, query]) =>
    `label_replace((${query}), "dashboard_metric", "${key}", "", "")`).join(' or ');
}

export function decodeTelemetry(body, now, staleAfterMs = 20_000) {
  if (body?.status !== 'success' || body.data?.resultType !== 'vector' ||
    !Array.isArray(body.data.result) || body.data.result.length > 32 || body.warnings?.length)
    throw new Error('invalid_provider_query_result');
  const values = {};
  for (const row of body.data.result) {
    const key = row.metric?.dashboard_metric;
    if (!queryKeys.has(key) || Object.hasOwn(values, key) || !Array.isArray(row.value) ||
      row.value.length !== 2 || typeof row.value[1] !== 'string' || !row.value[1].length)
      throw new Error('invalid_provider_query_result');
    const value = Number(row.value[1]);
    values[key] = Number.isFinite(value) && value >= 0 ? value : null;
  }
  const sampledAt = values.sampledAt == null ? null : values.sampledAt * 1000;
  const epoch = values.epoch == null ? null : String(values.epoch);
  let state = 'live', reason = null;
  if (values.targets !== 1) { state = 'unavailable'; reason = 'single_target_required'; }
  else if (values.up !== 1) { state = 'unavailable'; reason = 'scrape_failed'; }
  else if (sampledAt == null || now - sampledAt > staleAfterMs || sampledAt > now + 5000) {
    state = 'stale'; reason = 'sample_not_fresh';
  } else if (values.series !== 1 || epoch == null || values.running == null || values.waiting == null) {
    state = 'unavailable'; reason = 'single_engine_required';
  }
  const metrics = emptyMetrics();
  if (state === 'live') {
    for (const key of metricKeys) metrics[key] = values[key] ?? null;
    for (const key of ['cacheHitRate', 'kvUsage']) if (metrics[key] > 1) metrics[key] = null;
    // Do not join a window spanning a boot, even though rate() handles resets.
    if (values.epochChanges > 0 || values.counterResets > 0 || now / 1000 - values.epoch < 60)
      for (const key of derivedKeys) metrics[key] = null;
  }
  return { state, reason, sampledAt, epoch, metrics };
}

export class ProviderTelemetry {
  constructor(config, { fetchImpl = fetch, now = Date.now, intervalMs = 2500 } = {}) {
    this.config = config; this.fetch = fetchImpl; this.now = now; this.intervalMs = intervalMs;
    this.history = []; this.listeners = new Set(); this.last = null; this.seq = 0;
    this.staleAfterMs = 20_000; this.running = false; this.pending = null;
    this.state = config ? 'starting' : 'disabled'; this.reason = null;
  }
  snapshot(includeHistory = true) {
    const now = this.now(), last = this.last;
    const expired = last?.sampledAt != null && now - last.sampledAt > this.staleAfterMs;
    const state = this.state === 'live' && expired ? 'stale' : this.state;
    return { version: 1, source: 'vllm', model: publicModel, scope: 'engine',
      state, reason: expired ? 'sample_not_fresh' : this.reason,
      seq: this.seq, observedAt: now, sampledAt: last?.sampledAt ?? null,
      ageMs: last?.sampledAt == null ? null : Math.max(0, now - last.sampledAt),
      staleAfterMs: this.staleAfterMs, windowSeconds: 60, historySeconds: 300,
      epoch: last?.epoch ?? null, metrics: state === 'live' ? last.metrics : emptyMetrics(),
      ...(includeHistory ? { history: this.history } : {}) };
  }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  start() {
    if (!this.config || this.running) return;
    this.running = true;
    const tick = async () => {
      await this.refresh();
      if (this.running) { this.timer = setTimeout(tick, this.intervalMs); this.timer.unref?.(); }
    };
    void tick();
  }
  stop() {
    this.running = false; clearTimeout(this.timer); this.abort?.abort();
    for (const listener of this.listeners) listener(null);
    this.listeners.clear();
  }
  async refresh() {
    if (!this.config) return;
    if (this.pending) return this.pending;
    this.pending = this.collect().finally(() => { this.pending = null; });
    return this.pending;
  }
  async collect() {
    this.abort = new AbortController();
    const timeout = setTimeout(() => this.abort.abort(), 4000); timeout.unref?.();
    try {
      const url = new URL('/api/v1/query', this.config.url);
      url.searchParams.set('query', telemetryQuery(this.config.job));
      url.searchParams.set('time', String(this.now() / 1000)); url.searchParams.set('timeout', '3s');
      const response = await this.fetch(url, { redirect: 'error', signal: this.abort.signal });
      if (!response.ok) throw new Error('provider_query_failed');
      const chunks = []; let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 128 * 1024) { this.abort.abort(); throw new Error('provider_query_too_large'); }
        chunks.push(chunk);
      }
      const next = decodeTelemetry(JSON.parse(Buffer.concat(chunks).toString()), this.now(), this.staleAfterMs);
      this.state = next.state; this.reason = next.reason;
      if (next.state === 'live') {
        if (this.last && this.last.epoch !== next.epoch) {
          this.history = []; this.epochChangedAt = this.now();
        }
        if (this.epochChangedAt && this.now() - this.epochChangedAt < 60_000)
          for (const key of derivedKeys) next.metrics[key] = null;
        if (this.last?.sampledAt !== next.sampledAt || this.last?.epoch !== next.epoch) {
          this.seq++;
          this.history.push({ at: next.sampledAt, epoch: next.epoch, metrics: next.metrics });
        }
        this.last = next;
      }
    } catch {
      this.state = this.last ? 'stale' : 'unavailable'; this.reason = 'telemetry_unavailable';
    } finally {
      clearTimeout(timeout);
      const cutoff = this.now() - 300_000;
      this.history = this.history.filter(point => point.at >= cutoff).slice(-180);
      for (const listener of this.listeners) {
        try { listener(this.snapshot(false)); } catch { /* A disconnected viewer cannot stop collection. */ }
      }
    }
  }
}
