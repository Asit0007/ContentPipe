import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allDone, currentPhase, newState, recordFailure, recordSuccess, summarize, waitUntil } from './wanMeasure';
import { wanSteps } from './spaceAdapters';

const T = (h: number) => new Date(Date.UTC(2026, 8, 27, h, 0, 0));
const clip = (wallSec: number) => ({ at: T(0).toISOString(), wallSec, bytes: 500000 });

test('a refusal before any success is retried later and starts no window', () => {
  const s = newState(T(0));
  const p = currentPhase(s)!;
  assert.equal(p.steps, 6);
  assert.equal(recordFailure(p, 'Space failed without saying why', T(1)), 'retry_later');
  assert.equal(recordFailure(p, 'again', T(2)), 'retry_later');
  assert.equal(p.status, 'pending');
  assert.equal(p.windowStart, undefined);
  assert.equal(p.attempts.length, 2);
});

test('the first success opens the window; a later failure is the wall and dates the reset 24 h after the first success', () => {
  const s = newState(T(0));
  const p = currentPhase(s)!;
  recordSuccess(p, clip(46), T(5));
  recordSuccess(p, clip(48), T(5));
  assert.equal(p.status, 'open');
  assert.equal(p.windowStart, T(5).toISOString());
  assert.equal(recordFailure(p, 'quota', T(6)), 'wall');
  assert.equal(p.status, 'done');
  assert.equal(p.resetAt, new Date(Date.UTC(2026, 8, 28, 5)).toISOString());
  assert.equal(p.clips.length, 2);
});

test('the next phase waits for the previous window to reset, then is worked on; all done ends the job', () => {
  const s = newState(T(0));
  const a = currentPhase(s)!;
  recordSuccess(a, clip(46), T(5));
  recordFailure(a, 'quota', T(6));
  assert.equal(currentPhase(s)!.steps, 4);
  assert.equal(waitUntil(s, T(10)), a.resetAt, 'still inside the first window');
  assert.equal(waitUntil(s, new Date(Date.UTC(2026, 8, 28, 5, 1))), undefined, 'reset has passed');
  const b = currentPhase(s)!;
  recordSuccess(b, clip(35), new Date(Date.UTC(2026, 8, 28, 6)));
  recordFailure(b, 'quota', new Date(Date.UTC(2026, 8, 28, 7)));
  assert.ok(allDone(s));
  const text = summarize(s);
  assert.match(text, /## 6 steps — done/);
  assert.match(text, /## 4 steps — done/);
  assert.match(text, /1 clip\(s\)/);
});

test('WAN_STEPS is clamped to 4-8 and defaults to 6', () => {
  assert.equal(wanSteps({}), 6);
  assert.equal(wanSteps({ WAN_STEPS: '4' }), 4);
  assert.equal(wanSteps({ WAN_STEPS: '8' }), 8);
  for (const bad of ['3', '9', 'x', '']) assert.equal(wanSteps({ WAN_STEPS: bad }), 6, bad);
});
