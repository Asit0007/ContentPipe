import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fluxPrompt, recommendImageTool, VIDEO_READY_CLARITY } from '../shared/imagePrompts';
import * as imagePrompts from '../shared/imagePrompts';

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

test('Midjourney is gone (owner, 2026-10-01): FLUX and Nano Banana Pro only', () => {
  assert.equal((imagePrompts as any).midjourneyPrompt, undefined);
  assert.equal((imagePrompts as any).MIDJOURNEY_NEGATIVES, undefined);
});

test('a scene with no characters, or only a flat visualPrompt, still works; an empty scene gives an empty prompt', () => {
  const noChar = fluxPrompt({ visual: { ...scene.visual, character: 'No characters in frame.' } });
  assert.doesNotMatch(noChar, /No characters/i);
  const flat = fluxPrompt({ visualPrompt: 'A lone lighthouse in fog' });
  assert.ok(flat.includes('A lone lighthouse in fog.') && flat.includes(VIDEO_READY_CLARITY));
  assert.equal(fluxPrompt({}), '');
});

test('image tool: Nano Banana Pro for lettering or two characters, FLUX for a plain picture', () => {
  assert.deepEqual(recommendImageTool(scene), { tool: 'flux', reason: 'no lettering, a plain picture' });
  // The live OnePlus scene 4: a whiteboard with quoted labels.
  const board = { visual: { ...scene.visual, background: "A whiteboard shows a small block labeled 'USER' and an arrow to 'ROOT'." } };
  assert.equal(recommendImageTool(board).tool, 'nano-banana-pro');
  assert.equal(recommendImageTool({ visual: { ...scene.visual, scene: 'A printout reads "ACCESS DENIED" under the lamp' } }).tool, 'nano-banana-pro');
  assert.equal(recommendImageTool({ ...scene, visualType: 'terminal' }).tool, 'nano-banana-pro');
  assert.equal(recommendImageTool({ ...scene, charactersInFrame: ['a', 'b'] }).reason, 'two or more characters to keep consistent');
  // A possessive apostrophe is not a quoted label.
  assert.equal(recommendImageTool({ visual: { ...scene.visual, character: "Mara's hands rest on the desk; the analyst's mug steams" } }).tool, 'flux');
});
