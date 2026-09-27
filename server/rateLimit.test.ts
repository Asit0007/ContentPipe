import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { geminiRpmLimit, nextSlotMs, pacingEnabled, resetPacing, waitForSlot } from './rateLimit';

const ON = {}; // npm test sets GEMINI_RPM_PACING=off for every other suite; these pass an env of their own

function clock() {
  let t = 5_000_000;
  const sleeps: number[] = [];
  return {
    sleeps,
    advance: (ms: number) => {
      t += ms;
    },
    opts: (maxWaitMs: number, env: Record<string, string> = ON) => ({
      now: () => t,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        t += ms;
      },
      maxWaitMs,
      env,
    }),
  };
}

beforeEach(() => resetPacing());

test('free-tier limits by model family (AI Studio, 2026-09-27); unknown models are not paced', () => {
  assert.equal(geminiRpmLimit('gemini-3.8-flash'), 5);
  assert.equal(geminiRpmLimit('gemini-3.1-flash-lite'), 15);
  assert.equal(geminiRpmLimit('gemini-3.1-flash-tts-preview'), 3);
  assert.equal(geminiRpmLimit('gemini-3.8-flash-lite-tts'), 3, 'TTS wins over flash-lite');
  assert.equal(geminiRpmLimit('gemini-2.5-flash-preview-tts'), 3);
  assert.equal(geminiRpmLimit('gemma-4-31b-it'), 30);
  assert.equal(geminiRpmLimit('m1'), undefined);
});

test('five sends go at once; the sixth waits for the oldest to leave the 60 s window', async () => {
  const c = clock();
  for (let i = 0; i < 5; i++) assert.equal((await waitForSlot('gemini-3.8-flash', c.opts(90_000))).ok, true);
  assert.deepEqual(c.sleeps, []);
  const r = await waitForSlot('gemini-3.8-flash', c.opts(90_000));
  assert.equal(r.ok, true);
  assert.deepEqual(c.sleeps, [60_050]);
});

test('a slot further away than maxWaitMs is refused with when to come back, and nothing is recorded', async () => {
  const c = clock();
  for (let i = 0; i < 5; i++) await waitForSlot('gemini-3.8-flash', c.opts(15_000));
  c.advance(10_000);
  const r = await waitForSlot('gemini-3.8-flash', c.opts(15_000));
  assert.deepEqual(r, { ok: false, waitedMs: 0, retryAfterSec: 50 });
  assert.deepEqual(c.sleeps, []);
  c.advance(50_000);
  assert.equal(nextSlotMs('gemini-3.8-flash', 5_060_000, ON), 0, 'the refusal did not take a slot');
});

test('the window slides: sends older than 60 s no longer count', async () => {
  const c = clock();
  for (let i = 0; i < 3; i++) await waitForSlot('gemini-3.1-flash-tts-preview', c.opts(0));
  assert.equal((await waitForSlot('gemini-3.1-flash-tts-preview', c.opts(0))).ok, false);
  c.advance(60_001);
  assert.equal((await waitForSlot('gemini-3.1-flash-tts-preview', c.opts(0))).ok, true);
});

test('models are paced separately', async () => {
  const c = clock();
  for (let i = 0; i < 5; i++) await waitForSlot('gemini-3.8-flash', c.opts(0));
  assert.equal((await waitForSlot('gemini-3.7-flash', c.opts(0))).ok, true);
});

test('GEMINI_RPM_PACING=off (billing on) never waits; unknown models never wait', async () => {
  const c = clock();
  for (let i = 0; i < 20; i++) assert.equal((await waitForSlot('gemini-3.8-flash', c.opts(0, { GEMINI_RPM_PACING: 'off' }))).ok, true);
  for (let i = 0; i < 20; i++) assert.equal((await waitForSlot('m1', c.opts(0))).ok, true);
  assert.equal(pacingEnabled({}), true);
  assert.equal(pacingEnabled({ GEMINI_RPM_PACING: 'false' }), false);
  assert.equal(pacingEnabled({ GEMINI_RPM_PACING: 'on' }), true);
});
