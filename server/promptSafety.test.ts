import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractLettering, stripLettering, genericBrands, dropStoryMeaning, trimHarm, pictureText, promptRisks, sceneOverlays, PLAIN_SURFACES,
} from '../shared/promptSafety';
import { sceneClips, clipPrompt, clipPromptShort } from '../shared/clipPrompts';
import { nanoBananaProPrompt } from '../shared/nanoBananaPrompt';

// Every case below is a sentence from the live OnePlus brief (2026-10-01), whose scenes 5 and 46 Gemini refused.

test('lettering is found and lifted out; ordinary quotes and possessives are not lettering', () => {
  assert.deepEqual(extractLettering("A block labeled 'USER' and a block labeled 'ROOT'; 'USER' again."), ['USER', 'ROOT']);
  assert.deepEqual(extractLettering("the 'constrained' nature, the man's glasses"), [], 'lower-case quotes and apostrophes stay');
  assert.equal(stripLettering("The diagram shows a small block labeled 'USER' with an arrow to a large, dominant block labeled 'ROOT'."), 'The diagram shows a small block with an arrow to a large, dominant block.');
  assert.equal(stripLettering("In the center gap, the text 'LOCAL ATTACK VECTOR ONLY' is projected in a sharp, ember-orange hue."), 'In the center gap, a plain, unmarked panel is projected in a sharp, ember-orange hue.');
  assert.equal(stripLettering("The focus is sharp on the date 'April 18', with the man's face"), "The focus is sharp on the date, with the man's face");
  assert.equal(stripLettering("Right side shows a 'ROOT' block."), 'Right side shows a block.');
});

test('brands become what a camera sees; ordinary words that look like brands are left alone', () => {
  assert.equal(genericBrands('center-staged on a OnePlus 15 device. The OnePlus 15 sits'), 'center-staged on a smartphone. The smartphone sits');
  assert.equal(genericBrands('A projection of an Android architecture diagram'), 'A projection of a phone architecture diagram');
  assert.equal(genericBrands('an apple on the desk, a galaxy of stars'), 'an apple on the desk, a galaxy of stars');
});

test('story meaning leaves a clip direction; picture descriptions are trimmed at the smallest unit', () => {
  assert.equal(dropStoryMeaning('The slabs hold still, mirroring the constrained nature of the threat. Haze drifts.'), 'Haze drifts.');
  assert.equal(dropStoryMeaning('The ember-orange projected text stays sharp. Haze drifts.'), 'Haze drifts.', 'a clip never asks for text');
  assert.equal(trimHarm('A grid of blocks; most glow cyan (patched), but 18 glow ember orange (vulnerable).'), 'A grid of blocks; most glow cyan (patched), but 18 glow ember orange.');
  assert.equal(trimHarm('Most are cyan, but 18 pulse in ember orange, indicating vulnerability.'), 'Most are cyan, but 18 pulse in ember orange.');
  assert.equal(trimHarm("Left side shows a smartphone; right side shows a malicious app icon."), 'Left side shows a smartphone.');
  assert.equal(trimHarm('The composition emphasizes the attack. A desk lamp glows.'), 'A desk lamp glows.');
});

test('risks: what a finished prompt still carries', () => {
  assert.deepEqual(promptRisks('A smartphone on a desk. Haze drifts.'), []);
  const r = promptRisks("A OnePlus 15 under the words 'ROOT', a malicious app.");
  assert.deepEqual(r.map((x) => x.kind).sort(), ['brand', 'harm-word', 'lettering']);
});

test('overlays: the headline card and each label, with where it goes', () => {
  const o = sceneOverlays({ onScreenText: 'USER TO ROOT', visual: { background: "A whiteboard. A small block labeled 'USER'. A big block labeled 'ROOT'.", scene: 'Wide.' } });
  assert.deepEqual(o.map((x) => [x.kind, x.text]), [['headline', 'USER TO ROOT'], ['label', 'USER'], ['label', 'ROOT']]);
  assert.equal(o[1].where, 'A small block.');
  assert.deepEqual(sceneOverlays({ onScreenText: '', visual: { background: 'A dark room.' } }), []);
});

const scene46 = {
  sceneNumber: 46, durationEst: 12, onScreenText: 'LOCAL ATTACK VECTOR ONLY',
  narration: 'Despite the power of this chain, the danger was constrained. It required a malicious app to be installed on the device.',
  visual: {
    character: 'No characters in frame.',
    background: 'A dark, brutalist interior. Two slabs of black obsidian are separated by a thin, glowing cyan gap.',
    scene: "In the center gap, the text 'LOCAL ATTACK VECTOR ONLY' is projected in a sharp, ember-orange hue.",
    styleAnchor: 'Cyberpunk noir.',
    negative: 'hooded hackers, skulls',
  },
  motion: { shotType: 'Wide Shot', cameraMove: 'Anamorphic Zoom', subjectMotion: 'Static', easing: 'Ease-out' },
  clips: [
    { clipNumber: 1, action: 'The ember-orange projected text in the gap remains static and sharp, casting a glow on the slabs.', camera: 'Anamorphic Zoom.', environment: 'The installation remains still.', endFrame: "The 'LOCAL ATTACK VECTOR ONLY' text is the focal point." },
    { clipNumber: 2, action: "The environment holds its rigid state, mirroring the 'constrained' nature of the threat described.", camera: 'Anamorphic Zoom continuing.', environment: 'Thin haze lingers.', endFrame: 'A tight view of the projected text.' },
  ],
};

test('the refused scene 46: no prompt for it carries the attack wording any more, and the words become an overlay', () => {
  for (const c of sceneClips(scene46)) {
    for (const p of [clipPrompt(scene46, c), clipPromptShort(scene46, c)]) {
      assert.doesNotMatch(p, /attack|threat|malicious|LOCAL|hacker|skull/i, p);
      assert.deepEqual(promptRisks(p), []);
    }
  }
  assert.match(clipPrompt(scene46, sceneClips(scene46)[1]), /Action: Static\./, 'a clip with nothing visual left falls back to the scene\'s motion');
  assert.match(clipPrompt(scene46, sceneClips(scene46)[0]), /Camera: Wide shot\. /, '"Wide Shot shot" is not doubled');
  const nbp = nanoBananaProPrompt(scene46);
  assert.doesNotMatch(nbp, /ATTACK|LOCAL/);
  assert.ok(nbp.includes(PLAIN_SURFACES));
  assert.deepEqual(sceneOverlays(scene46).map((o) => o.text), ['LOCAL ATTACK VECTOR ONLY']);
  assert.equal(pictureText('man in late 30s, rimless glasses'), 'man in late 30s, rimless glasses', 'a character anchor passes through byte for byte');
});

test('whole prompts at the media endpoints get the same rules (ContentRender sends the flat visualPrompt and motionPrompt)', async () => {
  const { safeImagePrompt, safeVideoPrompt } = await import('../shared/promptSafety');
  const img = safeImagePrompt("A OnePlus 15 on a desk. In the gap, the text 'LOCAL ATTACK VECTOR ONLY' glows. Cyberpunk noir.");
  assert.doesNotMatch(img, /OnePlus|ATTACK|LOCAL/);
  assert.ok(img.endsWith(PLAIN_SURFACES));
  assert.equal(safeImagePrompt('A dark room. Noir.'), 'A dark room. Noir.', 'a prompt with nothing to remove is unchanged');
  assert.equal(safeVideoPrompt('The slabs mirror the threat. Haze drifts slowly.'), 'Haze drifts slowly.');
  assert.equal(safeVideoPrompt('The malicious app attacks.'), 'Slow, subtle camera movement.');
});
