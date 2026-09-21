import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCaptions, chunkText, cleanCaptionText, formatSrtTime, renderSrt, wrapLines } from './captions';

const words = (s: string) => s.split(/\s+/).filter(Boolean);

const SCENE_TEXT =
  'SentinelOne says the backdoors were already on disk on March 18, so it cannot prove how they were delivered. ' +
  'They stayed dormant until March 29. Then the developer opened a workspace in Cursor, and both implants launched within seconds.';

test('formatSrtTime: zero-padded, comma milliseconds, rounding carries', () => {
  assert.equal(formatSrtTime(0), '00:00:00,000');
  assert.equal(formatSrtTime(3661.5), '01:01:01,500');
  assert.equal(formatSrtTime(59.9996), '00:01:00,000');
  assert.equal(formatSrtTime(-1), '00:00:00,000');
});

test('cleanCaptionText: collapses whitespace, drops [S#] markers, defuses an early cue terminator', () => {
  assert.equal(cleanCaptionText('  It   spread [S1] fast [S1, S2].\n\nThen stopped.  '), 'It spread fast . Then stopped.');
  assert.equal(cleanCaptionText('a --> b'), 'a -> b');
  assert.equal(cleanCaptionText(undefined as any), '');
});

test('chunkText never loses, reorders or invents a word — captions must match what is spoken', () => {
  for (const max of [84, 60, 30]) {
    const chunks = chunkText(cleanCaptionText(SCENE_TEXT), max);
    assert.deepEqual(words(chunks.join(' ')), words(SCENE_TEXT), `max ${max}`);
    assert.ok(chunks.every((c) => c.length <= max || !c.includes(' ')), `every chunk fits ${max}: ${JSON.stringify(chunks)}`);
  }
});

test('chunkText: a long sentence splits at a clause boundary; short sentences merge instead of making tiny cues', () => {
  const long = chunkText('Then the developer opened a workspace in Cursor, and both implants launched within seconds of that.', 60);
  assert.equal(long.length, 2);
  assert.ok(long[0].endsWith(','), long[0]);
  assert.deepEqual(chunkText('It ran. It hid. It left.', 84), ['It ran. It hid. It left.']);
  assert.deepEqual(chunkText('', 84), []);
});

test('wrapLines: balanced two lines when needed, one line when it fits, never a line over the limit for fitting text', () => {
  assert.deepEqual(wrapLines('short line', 42), ['short line']);
  const two = wrapLines('SentinelOne says the backdoors were already on disk on March 18', 42);
  assert.equal(two.length, 2);
  assert.ok(two.every((l) => l.length <= 42));
  assert.ok(Math.abs(two[0].length - two[1].length) <= 12, 'balanced, not 42 + 5');
  assert.ok(wrapLines('x '.repeat(80).trim(), 42).length > 2, 'falls back to more lines rather than overflowing');
  // Prefers a break after punctuation when it costs little balance; ignores it when it would cost a lot.
  assert.deepEqual(wrapLines('Fixture scene 1. This narration is a stand-in tone,', 42), ['Fixture scene 1.', 'This narration is a stand-in tone,']);
  assert.deepEqual(wrapLines('Hi. This narration goes on for quite a long time before it stops', 42), ['Hi. This narration goes on for', 'quite a long time before it stops'], 'a break after "Hi." would leave 60 chars on one line');
});

test('buildCaptions: cues stay inside the scene window, start at the scene start, never overlap, and are numbered from 1', () => {
  const scenes = [
    { text: SCENE_TEXT, startSec: 0, audioSec: 12, gapAfterSec: 0.35 },
    { text: 'The value of the target is whatever their laptop can reach.', startSec: 12.367, audioSec: 4, gapAfterSec: 0.8 },
  ];
  const cues = buildCaptions(scenes);
  assert.equal(cues[0].startSec, 0);
  assert.equal(cues[0].index, 1);
  assert.deepEqual(cues.map((c) => c.index), cues.map((_, i) => i + 1));
  cues.forEach((c, i) => {
    assert.ok(c.endSec > c.startSec, `cue ${c.index} has positive length`);
    if (i > 0) assert.ok(c.startSec >= cues[i - 1].endSec, `cue ${c.index} does not overlap the previous`);
  });
  const sceneOne = cues.filter((c) => c.startSec < 12.367);
  assert.ok(sceneOne.every((c) => c.startSec >= 0 && c.endSec <= 12 + 0.3 + 1e-9), 'scene one cues end by speech end + the short linger');
  assert.equal(cues.find((c) => c.startSec >= 12.367)!.startSec, 12.367, 'scene two starts on the real audio boundary');
  assert.ok(cues[cues.length - 1].endSec <= 12.367 + 4 + 0.3 + 1e-9);
});

test('buildCaptions: time inside a scene is spread by how long each cue takes to say, not evenly', () => {
  const cues = buildCaptions([{ text: 'Short one. This second sentence is a great deal longer than the first one was, so it needs more time.', startSec: 0, audioSec: 10 }], { maxLineChars: 20, maxLines: 1 });
  assert.ok(cues.length >= 3);
  const lengths = cues.map((c) => c.text.replace(/\n/g, ' ').length);
  const durations = cues.map((c) => c.endSec - c.startSec);
  const longest = lengths.indexOf(Math.max(...lengths));
  const shortest = lengths.indexOf(Math.min(...lengths));
  assert.ok(durations[longest] > durations[shortest]);
});

test('buildCaptions: empty or whitespace-only scenes produce no cue and do not break numbering', () => {
  const cues = buildCaptions([
    { text: '   ', startSec: 0, audioSec: 3 },
    { text: 'Only real text.', startSec: 3, audioSec: 2 },
  ]);
  assert.equal(cues.length, 1);
  assert.equal(cues[0].index, 1);
});

test('renderSrt: exact SRT layout, blank line between cues, multi-line text kept', () => {
  const srt = renderSrt([
    { index: 1, startSec: 0, endSec: 2.5, text: 'First line' },
    { index: 2, startSec: 2.52, endSec: 4.1, text: 'Second cue\nwith two lines' },
  ]);
  assert.equal(srt, '1\n00:00:00,000 --> 00:00:02,500\nFirst line\n\n2\n00:00:02,520 --> 00:00:04,100\nSecond cue\nwith two lines\n');
});
