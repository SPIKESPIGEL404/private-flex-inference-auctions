import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectStream } from '../near-bridge.mjs';
import { MODEL, usageCostMicro } from '../core.mjs';
const frame = (usage, finish, content = '') => ({ id: 'original', model: MODEL,
  choices: finish === null ? [] : [{ index: 0, delta: { content }, finish_reason: finish }], usage });
const raw = frames => Buffer.from(frames.map(f => 'data: ' + JSON.stringify(f) + '\n\n').join('') + 'data: [DONE]\n\n');
const usage = n => ({ prompt_tokens: 20, completion_tokens: n, total_tokens: 20 + n });
test('cumulative and repeated terminal Cloud usage is charged once from the terminal snapshot', () => {
  const summary = inspectStream(raw([frame(usage(0), undefined), frame(usage(1), 'stop', '4'), frame(usage(1), null)]));
  assert.equal(summary.usage.completion_tokens, 1);
  assert.equal(usageCostMicro({ input: '40000', cache_input: '18000', output: '1350000' }, summary.usage), '3');
});
test('usage regression and pre-terminal-only metering cannot settle', () => {
  assert.throws(() => inspectStream(raw([frame(usage(2), 'stop', '4'), frame(usage(1), null)])), /usage_regressed/);
  const terminal = frame(undefined, 'stop', '4');
  assert.throws(() => inspectStream(raw([frame(usage(1), undefined), terminal])), /native_terminal_required/);
});
