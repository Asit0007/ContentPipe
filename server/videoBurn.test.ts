import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_POOLS, clipsFor, currentWindow, endSweep, isSleeping, newState, pickShot, recordClip, recordRefusal, summarize } from './videoBurn';
import { wanSteps, VIDEO_ADAPTERS } from './spaceAdapters';
import { tokenAllowedFor } from './mediaOrder';

const T = (d: number, h: number) => new Date(Date.UTC(2026, 8, d, h, 0, 0));
const clip = (space: string, over: object = {}) => ({ at: T(27, 5).toISOString(), pool: 'account' as const, space, label: space, shot: 's1', wallSec: 40, bytes: 1e6, durationSec: 4, file: 'a.mp4', ...over });

test('the account pool only names Spaces whose owners are trusted with the token; the anonymous pool only names ones that are not', () => {
  const [account, anon] = DEFAULT_POOLS;
  for (const e of account.entries) assert.ok(tokenAllowedFor(e.space, {}), `${e.space} should get the token`);
  for (const e of anon.entries) assert.equal(tokenAllowedFor(e.space, {}), false, `${e.space} must be called without the token`);
});

test('Balanced order: MiniMax hero (capped at one) first, LTX-2.3 next, Wan fills; the biggest reservation goes first', () => {
  const names = DEFAULT_POOLS[0].entries.map((e) => e.space);
  assert.deepEqual(names, ['MiniMaxAI/MiniMax-H3-Turbo-Lora', 'Lightricks/LTX-2-3', 'zerogpu-aoti/wan2-2-fp8da-aoti-faster']);
  assert.equal(DEFAULT_POOLS[0].entries[0].maxPerWindow, 1);
  assert.equal(DEFAULT_POOLS[0].entries[2].steps, 4);
});

test('a success opens the window and dates its reset 24 h later; refusals before any success open nothing', () => {
  const s = newState(T(27, 0));
  const pool = s.pools[0];
  const w = currentWindow(pool, T(27, 1));
  recordRefusal(w, 'a/b', 'no', T(27, 1));
  assert.equal(w.start, undefined);
  recordClip(w, clip('a/b'), T(27, 5));
  assert.equal(w.start, T(27, 5).toISOString());
  assert.equal(w.resetAt, T(28, 5).toISOString());
  assert.equal(clipsFor(w, 'a/b'), 1);
});

test('after an all-refused sweep with clips the pool sleeps (never past the reset); with no clips it stays awake', () => {
  const s = newState(T(27, 0));
  const pool = s.pools[0];
  const w = currentWindow(pool, T(27, 5));
  endSweep(pool, w, true, T(27, 5));
  assert.equal(isSleeping(pool, T(27, 6)), false, 'no clips yet: try again next hour');
  recordClip(w, clip('a/b'), T(27, 5));
  endSweep(pool, w, true, T(27, 6));
  assert.equal(pool.sleepUntil, T(27, 9).toISOString());
  assert.ok(isSleeping(pool, T(27, 8)));
  assert.equal(isSleeping(pool, T(27, 10)), false);
  endSweep(pool, w, true, T(28, 4));
  assert.equal(pool.sleepUntil, T(28, 5).toISOString(), 'capped at the reset');
  endSweep(pool, w, false, T(28, 4));
  assert.equal(pool.sleepUntil, undefined);
});

test('once the reset passes, a fresh window starts; the old one is kept', () => {
  const s = newState(T(27, 0));
  const pool = s.pools[0];
  recordClip(currentWindow(pool, T(27, 5)), clip('a/b'), T(27, 5));
  assert.equal(currentWindow(pool, T(28, 4)), pool.windows[0], 'still inside the first window');
  const fresh = currentWindow(pool, T(28, 6));
  assert.equal(pool.windows.length, 2);
  assert.equal(fresh.start, undefined);
  assert.equal(pool.windows[0].clips.length, 1);
});

test('shots are used round-robin by clips made so far, and the summary reports footage and wall time per model', () => {
  const s = newState(T(27, 0));
  const shots = [{ id: 'a', still: 'a.jpg', prompt: 'p' }, { id: 'b', still: 'b.jpg', prompt: 'q' }];
  assert.equal(pickShot(shots, s).id, 'a');
  const w = currentWindow(s.pools[0], T(27, 5));
  recordClip(w, clip('Lightricks/LTX-2-3', { durationSec: 5, wallSec: 30 }), T(27, 5));
  assert.equal(pickShot(shots, s).id, 'b');
  recordClip(w, clip('Lightricks/LTX-2-3', { durationSec: 5, wallSec: 50, width: 1536, height: 1024, fps: '24/1' }), T(27, 5));
  const text = summarize(s);
  assert.match(text, /2 clip\(s\), 10\.0 s of footage/);
  assert.match(text, /LTX-2\.3 distilled: 2 clip\(s\), 10\.0 s, avg 40\.0 s wall/);
});

test('the LTX-2.3 adapter sends the Space\'s own canvas, no prompt rewriting, and clamps to 1-10 s', async () => {
  const ad = VIDEO_ADAPTERS['Lightricks/LTX-2-3'];
  const ctx = { upload: async () => ({ path: 'x' }), apiInfo: async () => ({}) } as any;
  const job = { prompt: 'P', durationSec: 99, aspectRatio: '16:9', image: { bytes: Buffer.alloc(10), contentType: 'image/jpeg' } } as any;
  const call = await ad.build(job, ctx);
  assert.equal(call.endpoint, '/generate_video');
  assert.deepEqual(call.data.slice(1, 4), ['P', 10, false]);
  assert.deepEqual(call.data.slice(-2), [1024, 1536]);
  assert.equal((await ad.build({ ...job, aspectRatio: '9:16', durationSec: 0 }, ctx)).data.slice(-2).join('x'), '1536x1024');
});

test('WAN_STEPS is clamped to 4-8 and defaults to 6', () => {
  assert.equal(wanSteps({}), 6);
  assert.equal(wanSteps({ WAN_STEPS: '4' }), 4);
  assert.equal(wanSteps({ WAN_STEPS: '8' }), 8);
  for (const bad of ['3', '9', 'x', '']) assert.equal(wanSteps({ WAN_STEPS: bad }), 6, bad);
});
