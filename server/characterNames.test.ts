import { test } from 'node:test';
import assert from 'node:assert/strict';
import { characterReference, scrubNames, scrubCharacterNames } from './characterNames';

const bible = [
  { id: 'researcher', name: 'Rasmus', promptAnchor: 'man in late 30s, lean build, rimless glasses' },
  { id: 'corporate', name: 'The Representative', promptAnchor: 'man in early 50s, navy suit' },
  { id: 'exec', name: 'Dana Whitfield', promptAnchor: 'woman in her 40s, grey blazer' },
];

test('a character is referred to by what the description says they are', () => {
  assert.equal(characterReference(bible[0]), 'the man');
  assert.equal(characterReference(bible[2]), 'the woman');
  assert.equal(characterReference({ promptAnchor: 'silhouette in a hoodie' }), 'the person');
  assert.equal(characterReference({ promptAnchor: 'German engineer, 40s' }), 'the person', '"man" inside "German" is not a word match');
});

test('names become references: possessives kept, capitalised at a sentence start, longest name first', () => {
  const names = [{ name: 'Dana Whitfield', ref: 'the woman' }, { name: 'Dana', ref: 'the woman' }, { name: 'Rasmus', ref: 'the man' }];
  assert.equal(scrubNames('Rasmus breathes slowly. A push-in on Rasmus\'s profile.', names), "The man breathes slowly. A push-in on the man's profile.");
  assert.equal(scrubNames('Dana Whitfield turns; Dana nods.', names), 'The woman turns; the woman nods.');
  assert.equal(scrubNames('Action: Rasmus blinks.', names), 'Action: The man blinks.');
  assert.equal(scrubNames('Erasmus Hall stays; Rasmussen too.', names), 'Erasmus Hall stays; Rasmussen too.', 'only whole words');
});

test('picture fields lose the name; narration, on-screen text and infographics keep it (that is reporting)', () => {
  const scenes = [{
    sceneNumber: 5,
    narration: 'Rasmus Moorats found it. Rasmus reported it.',
    onScreenText: 'RASMUS',
    visualPrompt: 'Rasmus at a desk.',
    cinematography: 'Slow push-in on Rasmus.',
    visual: { character: 'Rasmus, man in late 30s', background: 'A dark room.', scene: 'Rasmus left of frame.', styleAnchor: 'Noir.' },
    motion: { cameraMove: 'Push-in on Rasmus', subjectMotion: 'Rasmus types', motionPrompt: 'Rasmus looks up.' },
    clips: [{ clipNumber: 1, action: 'Rasmus breathes slowly.', camera: 'Slow push-in on Rasmus\'s profile.', environment: 'Haze.', endFrame: 'Rasmus in profile.', narrationBeat: 'Rasmus Moorats found it.' }],
    infographic: { steps: [{ detail: 'Rasmus reports the flaw' }] },
  }];
  const [s] = scrubCharacterNames(scenes, bible);
  const picture = JSON.stringify([s.visualPrompt, s.cinematography, s.visual, s.motion, s.clips.map((c: any) => [c.action, c.camera, c.environment, c.endFrame])]);
  assert.doesNotMatch(picture, /Rasmus/);
  assert.equal(s.clips[0].action, 'The man breathes slowly.');
  assert.equal(s.visual.character, 'The man, man in late 30s');
  assert.equal(s.narration, scenes[0].narration);
  assert.equal(s.onScreenText, 'RASMUS');
  assert.equal(s.clips[0].narrationBeat, 'Rasmus Moorats found it.');
  assert.equal(s.infographic.steps[0].detail, 'Rasmus reports the flaw');
  assert.equal(scenes[0].visualPrompt, 'Rasmus at a desk.', 'the input is not mutated');
});

test('role labels and one-letter names are left alone; no bible is a no-op', () => {
  const scenes = [{ visualPrompt: 'The Representative at a podium. A dim room.' }];
  assert.equal(scrubCharacterNames(scenes, [{ name: 'The Representative', promptAnchor: 'man' }, { name: 'A', promptAnchor: 'man' }])[0].visualPrompt, scenes[0].visualPrompt);
  assert.equal(scrubCharacterNames(scenes, undefined), scenes);
});
