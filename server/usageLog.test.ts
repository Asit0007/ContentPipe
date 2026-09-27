import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { noteModelAttempt, recordModelUsage, trackModelCall, usageLogPath, withModelTask } from './llm/usage';

// npm test sets MODEL_USAGE_LOG=off for every other suite; these point it at a temp file and restore it.
function withLog(fn: (file: string) => Promise<void> | void) {
  return async () => {
    const before = process.env.MODEL_USAGE_LOG;
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'usage-')), 'model-usage.jsonl');
    process.env.MODEL_USAGE_LOG = file;
    try {
      await fn(file);
    } finally {
      if (before === undefined) delete process.env.MODEL_USAGE_LOG;
      else process.env.MODEL_USAGE_LOG = before;
    }
  };
}
const rows = (file: string) => readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('an attempt outside any request (the video burn, scripts) is still logged', withLog((file) => {
  noteModelAttempt({ provider: 'hf', model: 'linoyts/wan2-2-i2v-rCM', outcome: 'ok', ms: 58123.4 });
  const [r] = rows(file);
  assert.equal(r.app, 'contentpipe');
  assert.equal(r.model, 'linoyts/wan2-2-i2v-rCM');
  assert.equal(r.outcome, 'ok');
  assert.equal(r.ms, 58123);
  assert.match(r.t, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
}));

test('inside a request the task and kind are recorded; a skipped model is not a call', withLog(async (file) => {
  await recordModelUsage(() =>
    withModelTask('Narrative, scenes 1-3', () =>
      trackModelCall('json', async () => {
        noteModelAttempt({ provider: 'gemini', model: 'gemini-3.8-flash', outcome: 'overloaded', detail: 'HTTP 503\n  transient' });
        noteModelAttempt({ provider: 'ollama', model: 'nemotron-3-ultra', outcome: 'skipped', detail: 'cooling down' });
        noteModelAttempt({ provider: 'groq', model: 'qwen/qwen3.8-27b', outcome: 'ok' });
      })));
  const got = rows(file);
  assert.deepEqual(got.map((r) => [r.model, r.outcome]), [['gemini-3.8-flash', 'overloaded'], ['qwen/qwen3.8-27b', 'ok']]);
  assert.equal(got[0].task, 'Narrative, scenes 1-3');
  assert.equal(got[0].kind, 'json');
  assert.equal(got[0].detail, 'HTTP 503 transient');
}));

test('MODEL_USAGE_LOG=off writes nothing; the default sits beside the run journals', () => {
  assert.equal(usageLogPath({ MODEL_USAGE_LOG: 'off' }), undefined);
  assert.equal(usageLogPath({ CONTENTPIPE_RUNS_DIR: '/tmp/r' }), path.resolve('/tmp/r/model-usage.jsonl'));
  assert.equal(usageLogPath({}), path.resolve(process.cwd(), '.runs', 'model-usage.jsonl'));
  const off = path.join(tmpdir(), `never-${Date.now()}.jsonl`);
  const before = process.env.MODEL_USAGE_LOG;
  process.env.MODEL_USAGE_LOG = 'off';
  noteModelAttempt({ provider: 'x', model: 'y', outcome: 'ok' });
  if (before === undefined) delete process.env.MODEL_USAGE_LOG; else process.env.MODEL_USAGE_LOG = before;
  assert.equal(existsSync(off), false);
});

test('review #10: past 5 MB the log rotates to .1 and a fresh file starts', withLog((file) => {
  writeFileSync(file, Buffer.alloc(5 * 1024 * 1024, 'x'));
  noteModelAttempt({ provider: 'hf', model: 'x', outcome: 'ok' });
  assert.equal(statSync(`${file}.1`).size, 5 * 1024 * 1024);
  assert.equal(rows(file).length, 1);
}));
