import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ANALYST_EVERY, SPEAKERS, analystSceneNumbers, speakerFor } from '../shared/speakers';

const plan = (total: number) => Array.from({ length: total }, (_, i) => speakerFor(i + 1, total));

test('the analyst never opens or closes the video, whatever the length', () => {
  for (let total = 1; total <= 80; total++) {
    const p = plan(total);
    assert.equal(p[0], 'narrator', `total ${total}: scene 1`);
    assert.equal(p[total - 1], 'narrator', `total ${total}: last scene`);
  }
});

test('the analyst never speaks twice in a row, and stays a small share', () => {
  for (let total = 1; total <= 80; total++) {
    const p = plan(total);
    for (let i = 1; i < p.length; i++) assert.ok(!(p[i] === 'analyst' && p[i - 1] === 'analyst'), `total ${total}: scenes ${i}-${i + 1}`);
    assert.ok(p.filter((s) => s === 'analyst').length <= Math.ceil(total / ANALYST_EVERY), `total ${total}: share`);
  }
});

test('a script of ANALYST_EVERY scenes or fewer has no analyst (a 60 s short has 5 scenes)', () => {
  for (let total = 1; total <= ANALYST_EVERY; total++) assert.ok(plan(total).every((s) => s === 'narrator'), `total ${total}`);
  assert.ok(plan(ANALYST_EVERY + 1).includes('analyst'));
});

test('the 585 s default (51 scenes) gets a reaction about every minute, none on scene 51', () => {
  const p = plan(51);
  const at = p.map((s, i) => (s === 'analyst' ? i + 1 : 0)).filter(Boolean);
  assert.deepEqual(at, [6, 12, 18, 24, 30, 36, 42, 48]);
});

test('analystSceneNumbers reports only the analyst scenes inside a chunk', () => {
  assert.deepEqual(analystSceneNumbers(4, 3, 17), [6]);
  assert.deepEqual(analystSceneNumbers(1, 3, 17), []);
  assert.deepEqual(analystSceneNumbers(10, 3, 17), [12]);
  assert.deepEqual(analystSceneNumbers(16, 2, 17), [], 'scene 17 is the last one, and 18 does not exist');
  assert.deepEqual(analystSceneNumbers(4, 3, 6), [], 'scene 6 is the last of a 6-scene script');
});

test('bad scene numbers are the narrator, never a crash', () => {
  for (const n of [0, -6, 1.5, NaN]) assert.equal(speakerFor(n, 50), 'narrator');
  assert.deepEqual([...SPEAKERS], ['narrator', 'analyst']);
});
