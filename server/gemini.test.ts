import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generateGeminiJson, generateGeminiText, geminiTimeoutMs, resetModelCooldowns } from './gemini';
import { QuotaExhaustedError, UpstreamUnavailableError } from './quota';
import { resetPacing } from './rateLimit';

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

const timedOut = () => Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
const notFound = () => apiError(404, { error: { code: 404, status: 'NOT_FOUND', message: 'models/m1 is not found for API version v1beta' } });

/** handler returns the response text, or throws. `calls` records which model was hit, in order; `configs` what it was sent. */
function fakeAi(handler: (model: string, n: number) => string) {
  const calls: string[] = [];
  const configs: any[] = [];
  const ai: any = {
    models: {
      generateContent: async ({ model, config }: { model: string; config: any }) => {
        calls.push(model);
        configs.push(config);
        return { text: handler(model, calls.length), candidates: [{ finishReason: 'STOP' }], usageMetadata: {} };
      },
    },
  };
  return { ai, calls, configs };
}

function harness() {
  const waits: number[] = [];
  let clock = 1_000_000;
  return {
    waits,
    advance: (sec: number) => {
      clock += sec * 1000;
    },
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

beforeEach(() => {
  resetModelCooldowns();
  resetPacing();
});

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

// --- Cooldowns beyond quota (2026-09-27) -------------------------------------------------------

test('a 503 benches that model for the next request instead of costing a failed call on each one', async () => {
  const h = harness();
  const first = fakeAi((m) => {
    if (m === 'm1') throw overloaded();
    return '{"ok":1}';
  });
  await run(first.ai, h);
  assert.deepEqual(first.calls, ['m1', 'm2']);

  const second = fakeAi(() => '{"ok":2}');
  assert.deepEqual(await run(second.ai, h), { ok: 2 });
  assert.deepEqual(second.calls, ['m2'], 'm1 is skipped while it cools down');
});

test('consecutive 503s double the bench (30 s, then 60 s); a success resets it', async () => {
  const h = harness();
  const m1Busy = () =>
    fakeAi((m) => {
      if (m === 'm1') throw overloaded();
      return '{"ok":1}';
    });

  await run(m1Busy().ai, h); // streak 1: benched 30 s
  h.advance(31);
  const retried = m1Busy();
  await run(retried.ai, h); // tried again, 503 again: streak 2, benched 60 s
  assert.deepEqual(retried.calls, ['m1', 'm2']);

  h.advance(45);
  const stillBenched = fakeAi(() => '{"ok":1}');
  await run(stillBenched.ai, h);
  assert.deepEqual(stillBenched.calls, ['m2'], '45 s into a 60 s bench');

  h.advance(20);
  const recovered = fakeAi(() => '{"ok":1}');
  await run(recovered.ai, h);
  assert.deepEqual(recovered.calls, ['m1'], 'the bench expired and m1 answered');

  await run(m1Busy().ai, h); // after a success the streak starts over: 30 s again
  h.advance(31);
  const afterReset = fakeAi(() => '{"ok":1}');
  await run(afterReset.ai, h);
  assert.deepEqual(afterReset.calls, ['m1']);
});

test('the one deliberate retry pass still re-tries models it benched for a 503 moments earlier', async () => {
  const h = harness();
  const { ai, calls } = fakeAi((_m, n) => {
    if (n <= 3) throw overloaded();
    return '{"recovered":true}';
  });
  assert.deepEqual(await run(ai, h), { recovered: true });
  assert.deepEqual(calls, ['m1', 'm2', 'm3', 'm1']);
});

test('a timeout (the SDK aborts with a plain AbortError) is transient and benches that model for 10 min', async () => {
  const h = harness();
  const first = fakeAi((m) => {
    if (m === 'm1') throw timedOut();
    return '{"ok":1}';
  });
  assert.deepEqual(await run(first.ai, h), { ok: 1 }, 'not surfaced as a request bug');

  h.advance(9 * 60);
  const benched = fakeAi(() => '{"ok":1}');
  await run(benched.ai, h);
  assert.deepEqual(benched.calls, ['m2']);

  h.advance(61);
  const back = fakeAi(() => '{"ok":1}');
  await run(back.ai, h);
  assert.deepEqual(back.calls, ['m1']);
});

test('every model timing out: no 8 s retry pass (they are all benched), upstream-unavailable after 3 calls', async () => {
  const h = harness();
  const { ai, calls } = fakeAi(() => {
    throw timedOut();
  });
  await assert.rejects(run(ai, h), (e: any) => e instanceof UpstreamUnavailableError);
  assert.equal(calls.length, 3);
  assert.equal(h.longWaits().length, 0);
});

test('every call carries an abort signal (the per-call timeout)', async () => {
  const h = harness();
  const { ai, configs } = fakeAi(() => '{"ok":1}');
  await generateGeminiJson<any>(ai, 'p', 's', MODELS, undefined, { ...h.opts, timeoutMs: 5000 });
  assert.ok(configs[0].abortSignal instanceof AbortSignal);
  assert.equal(configs[0].abortSignal.aborted, false);
});

test('a 404 (model this key cannot call) benches that model; a chain of benched 404s still says why', async () => {
  const h = harness();
  const first = fakeAi(() => {
    throw notFound();
  });
  await assert.rejects(run(first.ai, h), /not found/);
  assert.equal(first.calls.length, 3);

  const second = fakeAi(() => '{"never":"reached"}');
  await assert.rejects(run(second.ai, h), /skipped while cooling down after: .*not found/);
  assert.equal(second.calls.length, 0);
});

test("a request bug (bad key) does not bench the model: it says nothing about the next request's fate", async () => {
  const h = harness();
  await assert.rejects(run(fakeAi(() => { throw badKey(); }).ai, h));
  const next = fakeAi(() => '{"ok":1}');
  assert.deepEqual(await run(next.ai, h), { ok: 1 });
  assert.deepEqual(next.calls, ['m1']);
});

test('chat shares the cooldowns: a model benched by the JSON path is skipped by generateGeminiText', async () => {
  // Real clock: generateGeminiText has no injectable one.
  const opts = { sleep: async () => {} };
  const json = fakeAi((m) => {
    if (m === 'm1') throw notFound();
    return '{"ok":1}';
  });
  await generateGeminiJson<any>(json.ai, 'p', 's', MODELS, undefined, opts);
  const chat = fakeAi(() => 'hello');
  const r = await generateGeminiText(chat.ai, [{ role: 'user', parts: [{ text: 'hi' }] }], 's', MODELS);
  assert.deepEqual(r, { text: 'hello', model: 'm2' });
  assert.deepEqual(chat.calls, ['m2']);
});

// --- Per-minute pacing (server/rateLimit.ts) ---------------------------------------------------

test('pacing: a Flash model at its 5/min moves the request to the next model instead of being refused', async () => {
  const h = harness();
  const paced = { ...h.opts, env: {} }; // npm test turns pacing off for every other test
  const models = ['gemini-a-flash', 'gemini-b-flash'];
  const { ai, calls } = fakeAi(() => '{"ok":1}');
  for (let i = 0; i < 6; i++) await generateGeminiJson<any>(ai, 'p', 's', models, undefined, paced);
  assert.deepEqual(calls, [...Array(5).fill('gemini-a-flash'), 'gemini-b-flash']);
  assert.equal(h.longWaits().length, 0, 'a 60 s wait is over the 15 s pacing limit: move on, do not stall');
});

test('pacing: a slot a few seconds away is worth waiting for, so the smarter model still answers', async () => {
  const h = harness();
  const paced = { ...h.opts, env: {} };
  const models = ['gemini-a-flash', 'gemini-b-flash'];
  const { ai, calls } = fakeAi(() => '{"ok":1}');
  for (let i = 0; i < 5; i++) await generateGeminiJson<any>(ai, 'p', 's', models, undefined, paced);
  h.advance(50);
  await generateGeminiJson<any>(ai, 'p', 's', models, undefined, paced);
  assert.equal(calls[5], 'gemini-a-flash');
  assert.deepEqual(h.longWaits(), [10_050]);
});

test('geminiTimeoutMs: GEMINI_TIMEOUT_MS, then LLM_TIMEOUT_MS, then 180 s; junk is ignored', () => {
  assert.equal(geminiTimeoutMs({}), 180_000);
  assert.equal(geminiTimeoutMs({ LLM_TIMEOUT_MS: '90000' }), 90_000);
  assert.equal(geminiTimeoutMs({ GEMINI_TIMEOUT_MS: '240000', LLM_TIMEOUT_MS: '90000' }), 240_000);
  assert.equal(geminiTimeoutMs({ GEMINI_TIMEOUT_MS: 'soon' }), 180_000);
});

// --- review findings, 2026-09-27 ------------------------------------------------------------

test('review #1: the retry pass does NOT re-try a model an EARLIER request benched, and does not wait 8 s for it', async () => {
  const h = harness();
  const busy = fakeAi(() => { throw overloaded(); });
  await assert.rejects(run(busy.ai, h));                 // request 1: every model 503s, retries once, all benched
  h.waits.length = 0;
  const later = fakeAi(() => '{"never":"reached"}');
  await assert.rejects(run(later.ai, h), (e: any) => e instanceof UpstreamUnavailableError);
  assert.deepEqual(later.calls, [], 'benched by request 1: request 2 sends nothing');
  assert.equal(h.longWaits().length, 0, 'and does not sleep 8 s hoping they recovered');
});

test('review #6: a model that answers is un-benched at once', async () => {
  const h = harness();
  await run(fakeAi((m) => { if (m === 'm1') throw overloaded(); return '{"ok":1}'; }).ai, h); // m1 benched 30 s
  // m1 answers in a later request's retry pass is covered elsewhere; here: a direct success clears the bench.
  const { answered } = await import('./gemini');
  answered('m1');
  const next = fakeAi(() => '{"ok":2}');
  await run(next.ai, h);
  assert.deepEqual(next.calls, ['m1']);
});

test('review #3: a daily-quota bench reports the real reset, not the 30-minute skip', async () => {
  const h = harness();
  await assert.rejects(run(fakeAi(() => { throw perDay(); }).ai, h));
  h.advance(10 * 60);                                     // still inside the 30-min skip; the reset is hours away
  const again = fakeAi(() => '{"never":"reached"}');
  await assert.rejects(run(again.ai, h), (e: any) => e instanceof QuotaExhaustedError && e.retryAfterSec > 1800);
  assert.deepEqual(again.calls, [], 'skipped, not re-asked');
});

test('review #1b: in a retry pass caused by fresh 503s, a model benched by an EARLIER request stays skipped', async () => {
  const h = harness();
  await run(fakeAi((m) => { if (m === 'm1') throw overloaded(); return '{"ok":1}'; }).ai, h); // request 1 benches m1
  const second = fakeAi(() => { throw overloaded(); });
  await assert.rejects(run(second.ai, h), (e: any) => e instanceof UpstreamUnavailableError);
  assert.deepEqual(second.calls, ['m2', 'm3', 'm2', 'm3'], 'm2/m3 retried after 8 s; m1 (benched by request 1) never called');
  assert.deepEqual(h.longWaits(), [8000]);
});
