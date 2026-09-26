import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fluxPrompt, midjourneyPrompt, VIDEO_READY_CLARITY, MIDJOURNEY_NEGATIVES } from '../shared/imagePrompts';

const scene = {
  visual: {
    character: 'Mara, 30s, short black hair, grey hoodie',
    background: 'A dim server room with blue status lights',
    scene: 'Mara stares at a cracked monitor',
    styleAnchor: 'Cinematic teal-and-orange grade, shallow depth of field',
  },
};

test('FLUX prompt: layers in order, clarity clause before the style anchor, anchor last, no negatives in prose', () => {
  const p = fluxPrompt(scene, '16:9');
  assert.ok(p.startsWith('16:9 landscape frame. Mara, 30s'));
  assert.ok(p.indexOf('server room') < p.indexOf('cracked monitor') && p.indexOf('cracked monitor') < p.indexOf(VIDEO_READY_CLARITY));
  assert.ok(p.endsWith('Cinematic teal-and-orange grade, shallow depth of field.'), 'the anchor keeps the last word');
  assert.ok(p.indexOf(VIDEO_READY_CLARITY) < p.indexOf('Cinematic teal'));
  assert.doesNotMatch(p, /\bno (grain|noise|text)\b|--no/i);
});

test('Midjourney prompt: same layers, then --ar / --style raw / --no as real parameters', () => {
  const p = midjourneyPrompt(scene, '9:16');
  assert.match(p, /--ar 9:16 --style raw --stylize 100 --no /);
  assert.ok(p.endsWith(MIDJOURNEY_NEGATIVES));
  assert.doesNotMatch(p, /--v \d/, 'no version pinned');
  assert.match(midjourneyPrompt(scene, 'weird'), /--ar 16:9/);
});

test('a scene with no characters, or only a flat visualPrompt, still works; an empty scene gives an empty prompt', () => {
  const noChar = fluxPrompt({ visual: { ...scene.visual, character: 'No characters in frame.' } });
  assert.doesNotMatch(noChar, /No characters/i);
  const flat = fluxPrompt({ visualPrompt: 'A lone lighthouse in fog' });
  assert.ok(flat.includes('A lone lighthouse in fog.') && flat.includes(VIDEO_READY_CLARITY));
  assert.equal(fluxPrompt({}), '');
  assert.equal(midjourneyPrompt({ visual: { character: 'No characters in frame.' } }), '');
});
