import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generateGeminiJson, resetModelCooldowns } from './gemini';
import { QuotaExhaustedError, UpstreamUnavailableError } from './quota';

const REAL_LIMIT0 = readFileSync(new URL('./__fixtures__/gemini-429-limit0.json', import.meta.url), 'utf8');
const MODELS = ['m1', 'm2', 'm3'];

const apiError = (status: number, body: unknown) =>
  Object.assign(new Error(typeof body === 'string' ? body : JSON.stringify(body)), { status });

const overloaded = () => apiError(503, { error: { code: 503, status: 'UNAVAILABLE', message: 'This model is currently experiencing high demand.' } });
const perMinute = (sec: number) =>
  apiError(429, {
    error: {
      code: 429,
      status: 'RESOURCE_EXHAUSTED',
      message: `quota. Please retry in ${sec}s.`,
      details: [
        { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier' }] },
        { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: `${sec}s` },
      ],
    },
  });
const perDay = () =>
  apiError(429, {
    error: {
      code: 429,
      status: 'RESOURCE_EXHAUSTED',
      message: 'quota, limit: 20',
      details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }],
    },
  });
const badKey = () => apiError(400, { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'API key not valid. Please pass a valid API key.' } });

/** handler returns the response text, or throws. `calls` records which model was hit, in order. */
function fakeAi(handler: (model: string, n: number) => string) {
  const calls: string[] = [];
  const ai: any = {
    models: {
      generateContent: async ({ model }: { model: string }) => {
        calls.push(model);
        return { text: handler(model, calls.length), candidates: [{ finishReason: 'STOP' }], usageMetadata: {} };
      },
    },
  };
  return { ai, calls };
}

function harness() {
  const waits: number[] = [];
  let clock = 1_000_000;
  return {
    waits,
    opts: {
      sleep: async (ms: number) => {
        waits.push(ms);
        clock += ms;
      },
      now: () => clock,
    },
    /** Waits long enough to be a deliberate retry pause, not the 200/300 ms inter-model gap. */
    longWaits: () => waits.filter((w) => w >= 1000),
  };
}

const run = (ai: any, h: ReturnType<typeof harness>) => generateGeminiJson<any>(ai, 'p', 's', MODELS, undefined, h.opts);

beforeEach(() => resetModelCooldowns());

test('first model succeeds: one call, no waiting', async () => {
  const h = harness();
  const { ai, calls } = fakeAi(() => '{"ok":1}');
  assert.deepEqual(await run(ai, h), { ok: 1 });
  assert.deepEqual(calls, ['m1']);
  assert.equal(h.longWaits().length, 0);
});

test('a 503 falls through to the next model', async () => {
  const h = harness();
  const { ai, calls } = fakeAi((m) => {
    if (m === 'm1') throw overloaded();
    return '{"from":"' + m + '"}';
  });
  assert.deepEqual(await run(ai, h), { from: 'm2' });
  assert.deepEqual(calls, ['m1', 'm2']);
});

test('all tiers 503: waits once (8s), retries the whole chain, and recovers', async () => {
  const h = harness();
  const { ai, calls } = fakeAi((_m, n) => {
    if (n <= 3) throw overloaded();
    return '{"recovered":true}';
  });
  assert.deepEqual(await run(ai, h), { recovered: true });
  assert.deepEqual(h.longWaits(), [8000]);
  assert.equal(calls.length, 4);
});

test('all tiers 503 twice: UpstreamUnavailableError after exactly one retry pass (6 calls)', async () => {
  const h = harness();
  const { ai, calls } = fakeAi(() => {
    throw overloaded();
  });
  await assert.rejects(run(ai, h), (e: any) => e instanceof UpstreamUnavailableError && e.retryAfterSec === 30);
  assert.equal(calls.length, 6);
});

test('per-minute 429 on every tier: waits the server-provided retryDelay, then retries', async () => {
  const h = harness();
  const { ai } = fakeAi((_m, n) => {
    if (n <= 3) throw perMinute(20);
    return '{"ok":true}';
  });
  assert.deepEqual(await run(ai, h), { ok: true });
  assert.deepEqual(h.longWaits(), [20000]);
});

test('per-day 429 on every tier: no wait, QuotaExhaustedError(per_day), and the exhausted models are then skipped', async () => {
  const h = harness();
  const first = fakeAi(() => {
    throw perDay();
  });
  await assert.rejects(run(first.ai, h), (e: any) => e instanceof QuotaExhaustedError && e.kind === 'per_day' && e.retryAfterSec > 0);
  assert.equal(h.longWaits().length, 0);
  assert.equal(first.calls.length, 3);

  // Cooldown: the next request must not spend three more doomed calls.
  const second = fakeAi(() => '{"never":"reached"}');
  await assert.rejects(run(second.ai, h), (e: any) => e instanceof QuotaExhaustedError && e.kind === 'per_day');
  assert.equal(second.calls.length, 0);
});

test('REAL captured limit: 0 body on every tier: kind zero, no retryAfter, never waits', async () => {
  const h = harness();
  const { ai, calls } = fakeAi(() => {
    throw apiError(429, REAL_LIMIT0);
  });
  await assert.rejects(run(ai, h), (e: any) => e instanceof QuotaExhaustedError && e.kind === 'zero' && e.retryAfterSec === undefined);
  assert.equal(h.longWaits().length, 0, 'CLAUDE.md: no backoff for limit: 0');
  assert.equal(calls.length, 3);
});

test('a request bug shared by every tier (bad key) surfaces as itself, unretried', async () => {
  const h = harness();
  const { ai, calls } = fakeAi(() => {
    throw badKey();
  });
  await assert.rejects(run(ai, h), /API key not valid/);
  assert.equal(calls.length, 3);
  assert.equal(h.longWaits().length, 0);
});

test("one tier's 400 must not mask the other tiers' daily-quota errors", async () => {
  const h = harness();
  const { ai } = fakeAi((m) => {
    if (m === 'm1') throw badKey();
    throw perDay();
  });
  await assert.rejects(run(ai, h), (e: any) => e instanceof QuotaExhaustedError && e.kind === 'per_day');
});

test('an empty {} response is a failed generation: the next tier is tried', async () => {
  const h = harness();
  const { ai, calls } = fakeAi((m) => (m === 'm1' ? '{}' : '{"real":1}'));
  assert.deepEqual(await run(ai, h), { real: 1 });
  assert.deepEqual(calls, ['m1', 'm2']);
});
