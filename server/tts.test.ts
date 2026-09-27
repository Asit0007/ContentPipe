import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetModelCooldowns } from './gemini';
import { TTS_MODELS } from './modelLineup';
import { QuotaExhaustedError } from './quota';
import { resetPacing } from './rateLimit';
import { synthesizeSpeech, TTS_MODEL_ID } from './tts';

const [FIRST, SECOND] = TTS_MODELS;

const apiError = (status: number, body: unknown) => Object.assign(new Error(JSON.stringify(body)), { status });
const perDay = () =>
  apiError(429, {
    error: {
      code: 429,
      status: 'RESOURCE_EXHAUSTED',
      message: 'quota, limit: 10',
      details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }],
    },
  });
const notFound = () => apiError(404, { error: { code: 404, status: 'NOT_FOUND', message: 'model not found' } });

/** handler returns base64 audio, or throws. */
function fakeAi(handler: (model: string) => string) {
  const calls: string[] = [];
  const configs: any[] = [];
  const ai: any = {
    models: {
      generateContent: async ({ model, config }: any) => {
        calls.push(model);
        configs.push(config);
        return { candidates: [{ content: { parts: [{ inlineData: { data: handler(model) } }] } }] };
      },
    },
  };
  return { ai, calls, configs };
}

function harness(env: Record<string, string> = { GEMINI_RPM_PACING: 'off' }) {
  let t = 7_000_000;
  const sleeps: number[] = [];
  return { sleeps, opts: { now: () => t, sleep: async (ms: number) => { sleeps.push(ms); t += ms; }, env } };
}

const say = (ai: any, h: ReturnType<typeof harness>, model?: string) => synthesizeSpeech(ai, { text: 'hi', voice: 'Charon', model }, h.opts);

beforeEach(() => {
  resetModelCooldowns();
  resetPacing();
});

test('default order: the first engine answers', async () => {
  const { ai, calls, configs } = fakeAi(() => 'QUFB');
  assert.deepEqual(await say(ai, harness()), { audioBase64: 'QUFB', model: FIRST });
  assert.deepEqual(calls, [FIRST]);
  assert.ok(configs[0].abortSignal instanceof AbortSignal, 'every call has a deadline');
  assert.equal(configs[0].speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Charon');
});

test('a pinned engine is the only one tried: its daily quota is a 429 to wait out, never a switch', async () => {
  const { ai, calls } = fakeAi(() => {
    throw perDay();
  });
  await assert.rejects(say(ai, harness(), FIRST), (e: any) => e instanceof QuotaExhaustedError && e.kind === 'per_day');
  assert.deepEqual(calls, [FIRST]);
});

test('a spent engine is skipped on the next clip instead of costing a refused request per scene', async () => {
  const h = harness();
  const first = fakeAi((m) => {
    if (m === FIRST) throw perDay();
    return 'QUFB';
  });
  assert.equal((await say(first.ai, h)).model, SECOND);

  const second = fakeAi(() => 'QUFB');
  assert.equal((await say(second.ai, h)).model, SECOND);
  assert.deepEqual(second.calls, [SECOND]);
});

test('both engines spent: the next clip spends no request at all and still reports the daily reset', async () => {
  const h = harness();
  await assert.rejects(say(fakeAi(() => { throw perDay(); }).ai, h), QuotaExhaustedError);
  const next = fakeAi(() => 'QUFB');
  await assert.rejects(say(next.ai, h), (e: any) => e instanceof QuotaExhaustedError && e.kind === 'per_day' && e.retryAfterSec > 0);
  assert.deepEqual(next.calls, []);
});

test('a 404 on one engine still falls through to the next (unpinned)', async () => {
  const { ai, calls } = fakeAi((m) => {
    if (m === FIRST) throw notFound();
    return 'QUFB';
  });
  assert.equal((await say(ai, harness())).model, SECOND);
  assert.deepEqual(calls, [FIRST, SECOND]);
});

test('pacing: the 4th clip in a minute waits for its engine (3/min) instead of switching engines', async () => {
  const h = harness({}); // pacing on
  const { ai, calls } = fakeAi(() => 'QUFB');
  for (let i = 0; i < 4; i++) await say(ai, h);
  assert.deepEqual(calls, [FIRST, FIRST, FIRST, FIRST]);
  assert.deepEqual(h.sleeps, [60_050]);
});

test('TTS_MODEL_ID accepts Gemini TTS ids and nothing else', () => {
  for (const ok of ['gemini-3.1-flash-tts-preview', 'gemini-2.5-flash-preview-tts', 'gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts']) assert.ok(TTS_MODEL_ID.test(ok), ok);
  for (const bad of ['gemini-3.8-flash', 'tts', 'gemini-3.1-flash-tts-preview; rm -rf', '']) assert.ok(!TTS_MODEL_ID.test(bad), bad);
});

test('review #2: the whole request has one deadline; a second model is not started without time left for it', async () => {
  let t = 7_000_000;
  const { ai, calls } = fakeAi(() => {
    t += 160_000;                                          // the first engine spends 160 s and fails: 10 s left
    throw Object.assign(new Error(JSON.stringify({ error: { code: 503, status: 'UNAVAILABLE', message: 'high demand' } })), { status: 503 });
  });
  await assert.rejects(synthesizeSpeech(ai, { text: 'hi', voice: 'Charon' }, { now: () => t, sleep: async () => {}, env: { GEMINI_RPM_PACING: 'off' }, totalBudgetMs: 170_000 }));
  assert.deepEqual(calls, [FIRST], 'under 15 s left: the second engine is not started (it would outlive the client)');
});

test('review #3: a pinned engine out for the day keeps reporting the real reset on later clips', async () => {
  const h = harness();
  await assert.rejects(say(fakeAi(() => { throw perDay(); }).ai, h, FIRST));
  const later = fakeAi(() => 'QUFB');
  await assert.rejects(say(later.ai, h, FIRST), (e: any) => e instanceof QuotaExhaustedError && e.kind === 'per_day' && e.retryAfterSec > 1800);
  assert.deepEqual(later.calls, [], 'benched, so no refused request is spent');
});
