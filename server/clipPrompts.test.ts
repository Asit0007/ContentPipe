import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLIP_MAX_SEC, clipCount, clipTimings, narrationBeats, sceneClips, clipPrompt, clipNegative, clipHeader, klingLength, CLIP_NEGATIVES } from '../shared/clipPrompts';

const scene = {
  sceneNumber: 4,
  narration: 'He typed one line. The service ran it as root. Nothing asked for permission. The phone was his.',
  durationEst: 12,
  visual: {
    character: 'man in late 30s, salt-and-pepper hair, rimless glasses, charcoal turtleneck, leaning toward a CRT',
    background: 'A dark briefing room with a concrete wall and hanging cables.',
    scene: 'Medium shot, the man left of frame, the CRT glowing right.',
    styleAnchor: 'Cyberpunk noir, ember orange and cyan, volumetric haze.',
    negative: 'cartoon villains, skulls.',
  },
  motion: { shotType: 'Medium', cameraMove: 'Slow push-in toward the CRT', subjectMotion: 'He types, then sits back', easing: 'Ease-in-out', motionPrompt: 'x' },
};

test('clips are at most 10 s, split evenly, and add up to the scene', () => {
  assert.equal(CLIP_MAX_SEC, 10);
  assert.deepEqual([7, 10, 10.5, 12, 15, 20, 21, 0].map(clipCount), [1, 1, 2, 2, 2, 2, 3, 1]);
  assert.deepEqual(clipTimings(12), [{ clipNumber: 1, startSec: 0, durationSec: 6 }, { clipNumber: 2, startSec: 6, durationSec: 6 }]);
  for (const d of [7, 13.5, 14, 15, 21, 29]) {
    const t = clipTimings(d);
    assert.ok(t.every((c) => c.durationSec <= CLIP_MAX_SEC && c.durationSec > 0), `${d}: ${JSON.stringify(t)}`);
    assert.equal(Math.round(t.reduce((n, c) => n + c.durationSec, 0) * 10) / 10, d);
  }
});

test('narration beats keep sentences whole where they can, and never leave a clip empty', () => {
  assert.deepEqual(narrationBeats(scene.narration, 2), ['He typed one line. The service ran it as root.', 'Nothing asked for permission. The phone was his.']);
  const oneSentence = narrationBeats('one two three four five six', 3);
  assert.deepEqual(oneSentence, ['one two', 'three four', 'five six']);
  assert.deepEqual(narrationBeats('', 2), ['', '']);
  assert.deepEqual(narrationBeats('Just this.', 1), ['Just this.']);
});

test('sceneClips: model fields where written, derived from motion otherwise, timing always from the current duration', () => {
  const derived = sceneClips(scene);
  assert.equal(derived.length, 2);
  assert.ok(derived.every((c) => c.source === 'derived'));
  assert.equal(derived[0].camera, 'Slow push-in toward the CRT');
  assert.match(derived[1].camera, /^The same move continues: slow push-in/);

  const stored = [{ clipNumber: 1, action: 'He types a short burst.', camera: 'Static camera.', environment: 'Haze drifts.', endFrame: 'Close on his face.' }];
  const mixed = sceneClips({ ...scene, clips: stored });
  assert.equal(mixed[0].source, 'model');
  assert.equal(mixed[0].action, 'He types a short burst.');
  assert.equal(mixed[1].source, 'derived', 'a clip the model did not write falls back');

  // Retimed to 8 s after the clips were written: one clip, still the model's.
  const retimed = sceneClips({ ...scene, durationEst: 8, clips: stored });
  assert.equal(retimed.length, 1);
  assert.equal(retimed[0].durationSec, 8);
  assert.equal(retimed[0].narrationBeat, scene.narration);
});

test('clip prompt: start, subject (anchor), action, one camera move, setting, look last but the end frame; no narration in it', () => {
  const clips = sceneClips({ ...scene, clips: [
    { clipNumber: 1, action: 'He types a short burst.', camera: 'Static camera', environment: 'Haze drifts', endFrame: 'Close on his face' },
    { clipNumber: 2, action: 'He sits back.', camera: 'Slow pull-out', environment: '', endFrame: '' },
  ] });
  const p1 = clipPrompt(scene, clips[0]);
  const lines = p1.split('\n');
  assert.match(lines[0], /^16:9 landscape, 6 s, one continuous shot\. Animate the attached still image/);
  assert.ok(lines[1].startsWith('Subject: man in late 30s'), 'the locked anchor is carried into the clip');
  assert.equal(lines[2], 'Action: He types a short burst.');
  assert.equal(lines[3], 'Camera: Medium shot. Static camera. Pacing: ease-in-out.');
  assert.ok(lines.some((l) => l.startsWith('Setting: A dark briefing room')));
  assert.ok(lines.some((l) => l === 'Atmosphere: Haze drifts.'));
  assert.ok(lines.indexOf('Look: Cyberpunk noir, ember orange and cyan, volumetric haze.') === lines.length - 2);
  assert.equal(lines[lines.length - 1], 'Ends on: Close on his face.');
  assert.doesNotMatch(p1, /typed one line|permission/, 'the narration is for the editor, not the video model');

  const p2 = clipPrompt(scene, clips[1], '9:16');
  assert.match(p2, /^9:16 portrait, 6 s, one continuous shot\. Continue seamlessly from the last frame of clip 1/);
  assert.doesNotMatch(p2, /Atmosphere:|Ends on:/, 'empty layers are left out');

  const empty = { visual: { character: 'No characters in frame.', background: '', scene: '' }, durationEst: 5 };
  assert.equal(clipPrompt(empty, sceneClips(empty)[0]), '');
  const noOne = { ...scene, visual: { ...scene.visual, character: 'No characters in frame.' } };
  assert.doesNotMatch(clipPrompt(noOne, sceneClips(noOne)[0]), /Subject:/);
});

test('negative prompt, Kling length and header', () => {
  assert.equal(clipNegative(scene), `${CLIP_NEGATIVES}, cartoon villains, skulls`);
  assert.equal(clipNegative({}), CLIP_NEGATIVES);
  assert.deepEqual(klingLength(5), { make: 5 });
  assert.deepEqual(klingLength(4), { make: 5, trimTo: 4 });
  assert.deepEqual(klingLength(6), { make: 10, trimTo: 6 });
  assert.deepEqual(klingLength(10), { make: 10 });
  const c = sceneClips(scene)[1];
  assert.equal(clipHeader(c, 2), 'Clip 2 of 2 · 0:06–0:12 (6 s) · make 10 s in Kling, trim to 6 s');
});
