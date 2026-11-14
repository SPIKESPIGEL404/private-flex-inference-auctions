// Check the actual query with the pinned Prometheus evaluator; no GPU/network.
import { mkdtempSync, chmodSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { telemetryQuery } from '../src/provider-telemetry.mjs';
const directory = mkdtempSync(join(tmpdir(), 'provider-promql-'));
chmodSync(directory, 0o755);
const target = 'job="fixture",instance="one"', model = `${target},model_name="Qwen/Qwen3.8-27B-FP8",engine="0"`;
const input = [];
const add = (name, values, labels = model) => input.push({ series: `${name}{${labels}}`, values });
add('up', '1+0x24', target); add('process_start_time_seconds', '0+0x24', target);
add('vllm:num_requests_running', '2+0x24'); add('vllm:num_requests_waiting', '3+0x24');
add('vllm:kv_cache_usage_perc', '0.4+0x24');
add('vllm:generation_tokens_total', '0+50x24'); add('vllm:prompt_tokens_total', '0+100x24');
add('vllm:prefix_cache_hits_total', '0+60x24'); add('vllm:prefix_cache_queries_total', '0+100x24');
add('vllm:request_prefill_kv_computed_tokens_sum', '0+96x24');
add('vllm:request_prefill_kv_computed_tokens_count', '0+4x24');
add('vllm:num_preemptions_total', '1+0x24'); add('vllm:request_success_total', '0+4x24');
for (const [bound, count] of [['0.1', 1], ['0.5', 3], ['1.0', 4], ['+Inf', 4]])
  add('vllm:time_to_first_token_seconds_bucket', `0+${count}x24`, `${model},le="${bound}"`);
for (const [bound, count] of [['0.1', 3], ['0.5', 4], ['+Inf', 4]])
  add('vllm:request_queue_time_seconds_bucket', `0+${count}x24`, `${model},le="${bound}"`);
const expected = { up: 1, targets: 1, sampledAt: 60, epoch: 0, series: 1, epochChanges: 0, counterResets: 0,
  running: 2, waiting: 3, kvUsage: .4, outputTokensPerSecond: 10, inputTokensPerSecond: 20,
  cacheHitRate: .6, ttftP95Ms: 900, queueP95Ms: 420, newPrefillTokensPerRequest: 24,
  preemptionsTotal: 1, completedPerSecond: .8 };
const resetInput = input.map(series => series.series.startsWith('vllm:generation_tokens_total{')
  ? { ...series, values: '0+50x6 0+50x17' } : series);
const suite = { evaluation_interval: '5s', fuzzy_compare: true, tests: [{ name: 'nonzero live dashboard query',
  interval: '5s', input_series: input, promql_expr_test: [{ expr: telemetryQuery('fixture'), eval_time: '60s',
    exp_samples: Object.entries(expected).map(([key, value]) => ({ labels: `{dashboard_metric="${key}"}`, value })) }] },
  { name: 'worker counter reset without an API-process restart', interval: '5s', input_series: resetInput,
    promql_expr_test: [{ expr: telemetryQuery('fixture'), eval_time: '60s',
      exp_samples: Object.entries({ ...expected, counterResets: 1, outputTokensPerSecond: 500 / 55 })
        .map(([key, value]) => ({ labels: `{dashboard_metric="${key}"}`, value })) }] }] };
writeFileSync(join(directory, 'rules.yml'), JSON.stringify(suite), { mode: 0o644 });
try {
  process.stdout.write(execFileSync('docker', ['run', '--rm', '--pull=never', '--network', 'none', '--read-only',
    '--cap-drop=ALL', '--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=32m', '-v', directory + ':/cases:ro', '--entrypoint', '/bin/promtool',
    'prom/prometheus:v3.16.0@sha256:e04987641b57704f408e31f6373ba4138ecf27cb4a165d24aabb6c38fddd0f06',
    'test', 'rules', '/cases/rules.yml'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
} catch (error) {
  process.stderr.write(error.stdout?.toString() ?? ''); process.stderr.write(error.stderr?.toString() ?? ''); process.exitCode = 1;
} finally { rmSync(directory, { recursive: true, force: true }); }
