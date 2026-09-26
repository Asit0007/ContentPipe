import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTtsPrompt, MAX_DIRECTION_CHARS, normalizeDirection } from './ttsPrompt';

test('without a direction the prompt is exactly what the UI has always sent', () => {
  assert.equal(buildTtsPrompt('Hello there.'), 'Speak in a punchy, engaging infotainment documentary narrator voice: Hello there.');
  assert.equal(buildTtsPrompt('Hello there.', '   '), buildTtsPrompt('Hello there.'), 'a blank direction is no direction');
  assert.equal(buildTtsPrompt('Hello there.', 42), buildTtsPrompt('Hello there.'), 'a non-string is ignored');
});

test('a direction replaces the default prefix and the text follows a TRANSCRIPT header', () => {
  const p = buildTtsPrompt('Half a second.', '# AUDIO PROFILE: The Analyst\nStyle: dry.');
  assert.ok(p.startsWith('# AUDIO PROFILE: The Analyst'));
  assert.ok(p.endsWith('#### TRANSCRIPT\nHalf a second.'));
  assert.ok(!p.includes('punchy'));
});

test('a direction that already ends with the header is not given a second one', () => {
  const p = buildTtsPrompt('Text.', 'Notes.\n\n#### TRANSCRIPT\n');
  assert.equal(p.match(/TRANSCRIPT/g)?.length, 1);
  assert.ok(p.endsWith('#### TRANSCRIPT\nText.'));
});

test('a very long direction is capped', () => {
  assert.equal(normalizeDirection('x'.repeat(MAX_DIRECTION_CHARS + 500))?.length, MAX_DIRECTION_CHARS);
});
