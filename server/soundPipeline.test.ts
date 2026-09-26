import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resetModelCooldowns } from './gemini';
import { RunJournal } from './runJournal';
import { applySoundDirection, cleanSfxCue, normalizeScorePlan, SOUND_SCENES_PER_CHUNK } from './soundPipeline';
import { analyzeScript } from './timeline';
import { normalizeTransition } from '../shared/sound';

const perDay = () =>
  Object.assign(
    new Error(
      JSON.stringify({
        error: {
          code: 429,
          status: 'RESOURCE_EXHAUSTED',
          message: 'quota, limit: 20',
          details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }],
        },
      })
    ),
    { status: 429 }
  );

/**
 * A fake model that answers the two sound-pass prompts. `cues` is the music plan it returns; `perScene(n)` the raw
 * direction for scene n. `log` records each logical call ('score', 'sound@<first scene>'); `fail` makes one throw.
 */
function fakeSoundAi(opts: { cues?: any[]; perScene?: (n: number) => any; fail?: 'score' | number } = {}) {
  const log: string[] = [];
  const prompts: Record<string, string> = {};
  const ai: any = {
    models: {
      generateContent: async ({ contents }: { contents: string }) => {
        const prompt = String(contents);
        let tag: string;
        let body: any;
        if (prompt.includes('music supervisor')) {
          tag = 'score';
          body = { musicCues: opts.cues ?? [{ cueId: 'm1', startScene: 1, endScene: 2, role: 'cold-open', mood: 'urgent', instruments: 'pulse', intensity: 2, entry: 'sting', exit: 'button', searchTerms: ['suspense pulse'] }] };
        } else {
          const nums = [...prompt.matchAll(/"sceneNumber": (\d+)/g)].map((m) => Number(m[1]));
          tag = `sound@${nums[0]}`;
          body = { scenes: nums.map((n) => (opts.perScene ?? defaultDirection)(n)) };
        }
        prompts[tag] = prompt;
        if (log[log.length - 1] !== tag) log.push(tag);
        if ((opts.fail === 'score' && tag === 'score') || (typeof opts.fail === 'number' && tag === `sound@${opts.fail}`)) throw perDay();
        return { text: JSON.stringify(body), candidates: [{ finishReason: 'STOP' }], usageMetadata: {} };
      },
    },
  };
  return { ai, log, prompts };
}

const defaultDirection = (n: number) => ({
  sceneNumber: n,
  sfxCue: '',
  sfxOnWord: '',
  sfxSearchTerms: [],
  ambience: '',
  silenceBeforeSec: 0,
  transitionIn: 'cut',
  transitionReason: 'continuous',
  audioBridge: 'none',
});

function script(n: number, secs = 10, tone = 'Deep Dive Documentary') {
  return {
    title: 'T',
    tonePacing: tone,
    scenes: Array.from({ length: n }, (_, i) => ({
      sceneNumber: i + 1,
      actPhase: i < n / 2 ? 'Hook' : 'The Fix',
      narration: `Scene ${i + 1} narration: the door locked behind him.`,
      durationEst: secs,
      soundEffect: '',
      motion: { shotType: 's', cameraMove: 'm', transitionOut: 'Shatter transition' },
    })),
  };
}

let dir: string;
const dirs: string[] = [];
beforeEach(async () => {
  resetModelCooldowns();
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cp-sound-'));
  dirs.push(dir);
});
after(async () => {
  for (const d of dirs) await fs.rm(d, { recursive: true, force: true });
});

// Every name a live run (2026-09-26, 10 scenes) actually produced, before the closed list existed.
test('normalizeTransition: the stylised names models wrote map onto the closed list', () => {
  const cases: Record<string, string> = {
    'glitch-cut': 'cut', 'Hard Cut': 'cut', 'Smart Cut': 'cut', 'Impact Cut': 'cut', 'Shatter transition': 'cut',
    'Fast glitch warp': 'cut', 'Glitch impact': 'cut', 'cross-fade': 'dissolve', 'Fade to black': 'fade-to-black',
    'fade': 'fade-to-black', 'dip to black': 'dip-to-black', 'Smash cut': 'smash-cut', 'match cut on the padlock': 'match-cut',
    'whip pan': 'whip', '': 'cut', 'dissolve': 'dissolve',
  };
  for (const [raw, want] of Object.entries(cases)) assert.equal(normalizeTransition(raw), want, raw);
});

test('cleanSfxCue: one sound, no "[SFX: ...]" wrapper, and "none" means none', () => {
  assert.equal(cleanSfxCue('[SFX: Violent record scratch + glass shattering + low-frequency sub-bass]'), 'Violent record scratch');
  assert.equal(cleanSfxCue('deadbolt clunk; distant thunder'), 'deadbolt clunk');
  assert.equal(cleanSfxCue('single phone buzz'), 'single phone buzz');
  assert.equal(cleanSfxCue('none'), '');
  assert.equal(cleanSfxCue(undefined), '');
});

test('normalizeScorePlan: clamps and sorts ranges, trims overlaps, keeps silence gaps, falls back on bad enums', () => {
  const cues = normalizeScorePlan(
    {
      musicCues: [
        { cueId: 'b', startScene: 6, endScene: 4, role: 'tension', intensity: 9, entry: 'boom', exit: 'fade-out', searchTerms: ['a', 'b', 'c', 'd', 'e'] },
        { cueId: 'a', startScene: 0, endScene: 3, role: 'cold-open', intensity: 2, entry: 'sting', exit: 'button', tempoBpm: 400 },
        { cueId: 'c', startScene: 5, endScene: 99, role: 'nonsense', intensity: 1, entry: 'fade-in', exit: 'fade-out' },
        { cueId: 'x', startScene: 'no', endScene: 2 },
      ],
    },
    10
  );
  assert.deepEqual(cues.map((c) => [c.cueId, c.startScene, c.endScene]), [['a', 1, 3], ['b', 4, 6], ['c', 7, 10]]);
  assert.equal(cues[0].tempoBpm, undefined, 'an impossible tempo is dropped, not kept');
  assert.equal(cues[1].intensity, 3);
  assert.equal(cues[1].entry, 'fade-in');
  assert.equal(cues[1].searchTerms.length, 4);
  assert.equal(cues[2].role, 'tension');
  // A gap stays a gap: silence on purpose.
  const gappy = normalizeScorePlan({ musicCues: [{ cueId: 'a', startScene: 1, endScene: 3 }, { cueId: 'b', startScene: 6, endScene: 8 }] }, 8);
  assert.deepEqual(gappy.map((c) => [c.startScene, c.endScene]), [[1, 3], [6, 8]]);
});

test('normalizeScorePlan: a cue running across a mid-roll is split there, fading out into the break and back in after', () => {
  const cues = normalizeScorePlan({ musicCues: [{ cueId: 'm1', startScene: 1, endScene: 10, entry: 'sting', exit: 'button' }] }, 10, [4]);
  assert.deepEqual(cues.map((c) => [c.cueId, c.startScene, c.endScene, c.entry, c.exit]), [
    ['m1', 1, 4, 'sting', 'fade-out'],
    ['m1b', 5, 10, 'fade-in', 'button'],
  ]);
});

test('applySoundDirection: forces the opening cut and the mid-roll fade, syncs transitionOut, validates the SFX word', async () => {
  const { ai } = fakeSoundAi({
    perScene: (n) => ({
      ...defaultDirection(n),
      transitionIn: n === 1 ? 'dissolve' : n === 3 ? 'match-cut' : n === 5 ? 'cut' : 'Hard Cut',
      sfxCue: n === 2 ? '[SFX: deadbolt clunk + sub-bass drop]' : n === 4 ? 'phone buzz' : '',
      sfxOnWord: n === 2 ? 'locked' : n === 4 ? 'banana' : '',
      sfxSearchTerms: n === 2 ? ['deadbolt lock'] : [],
      silenceBeforeSec: n === 3 ? 7 : 0,
      audioBridge: n === 2 ? 'j-cut' : 'sideways',
    }),
  });
  const s: any = await applySoundDirection(ai, script(6), {}, { midrollAfterScenes: [4] });
  const sc = s.scenes;
  assert.equal(sc[0].sound.transitionIn, 'cut', 'nothing to transition from at the start');
  assert.equal(sc[4].sound.transitionIn, 'fade-to-black', 'the scene after a mid-roll fades in from the break');
  assert.equal(sc[2].sound.transitionIn, 'match-cut');
  assert.equal(sc[1].sound.transitionIn, 'cut');
  // transitionOut is always the next scene's transitionIn, and the last scene fades out.
  assert.deepEqual(sc.map((x: any) => x.motion.transitionOut), ['cut', 'match-cut', 'cut', 'fade-to-black', 'cut', 'fade-to-black']);
  assert.equal(sc[1].sound.sfxCue, 'deadbolt clunk');
  assert.equal(sc[1].soundEffect, 'deadbolt clunk', 'the legacy field carries the single cue');
  assert.equal(sc[1].sound.sfxOnWord, 'locked');
  assert.equal(sc[3].sound.sfxOnWord, '', 'a word not in the narration is dropped');
  assert.equal(sc[2].sound.silenceBeforeSec, 1.5, 'silence is capped');
  assert.equal(sc[1].sound.audioBridge, 'j-cut');
  assert.equal(sc[0].sound.audioBridge, 'none', 'an unknown bridge is none');
  assert.equal(sc[0].soundEffect, '');
  assert.equal(s.musicCues.length, 1);
});

test('applySoundDirection: whip is an infotainment move — a documentary gets a cut instead', async () => {
  const perScene = (n: number) => ({ ...defaultDirection(n), transitionIn: 'whip' });
  const doc: any = await applySoundDirection(fakeSoundAi({ perScene }).ai, script(3), {});
  assert.equal(doc.scenes[1].sound.transitionIn, 'cut');
  const info: any = await applySoundDirection(fakeSoundAi({ perScene }).ai, script(3, 10, 'Witty Tech & Sarcastic'), {});
  assert.equal(info.scenes[1].sound.transitionIn, 'whip');
});

test('applySoundDirection: the prompt carries the music under each scene, the mid-roll and the SFX budget', async () => {
  const n = SOUND_SCENES_PER_CHUNK + 2;
  const { ai, log, prompts } = fakeSoundAi({ perScene: (k) => ({ ...defaultDirection(k), sfxCue: k === 1 ? 'lock clunk' : '' }) });
  await applySoundDirection(ai, script(n), {}, { midrollAfterScenes: [4] });
  assert.deepEqual(log, ['score', 'sound@1', `sound@${SOUND_SCENES_PER_CHUNK + 1}`]);
  assert.match(prompts['sound@1'], /cue m1: cold-open/);
  assert.match(prompts['sound@1'], /no music: deliberate silence/);
  assert.match(prompts['sound@1'], /a mid-roll ad break comes right after this scene/);
  assert.match(prompts[`sound@${SOUND_SCENES_PER_CHUNK + 1}`], /Sound effects so far: 1 of 10 scenes \(#1\)/);
  assert.match(prompts.score, /Mid-roll ad breaks come after scene 4/);
  assert.doesNotMatch(prompts['sound@1'], /"whip"/, 'documentary prompts do not offer the whip');
});

test('applySoundDirection: a failed chunk degrades (non-strict) and throws on quota (strict); a resumed run skips finished calls', async () => {
  const degraded: string[] = [];
  const s: any = await applySoundDirection(fakeSoundAi({ fail: 1 }).ai, script(3), { degraded });
  assert.equal(s.scenes.filter((x: any) => x.sound).length, 0);
  assert.match(degraded.join(' '), /Sound & edit chunk 1\/1 failed/);

  resetModelCooldowns(); // the quota hit above benched the fake models; each phase starts like a fresh request
  const journal = await RunJournal.open('sound-run', 'h', { dir });
  await assert.rejects(applySoundDirection(fakeSoundAi({ fail: 1 }).ai, script(3), { strict: true, journal }));
  assert.ok(journal.getScorePlan(), 'the music plan finished before the quota hit and is kept');

  resetModelCooldowns();
  const again = fakeSoundAi();
  const reopened = await RunJournal.open('sound-run', 'h', { dir });
  const done: any = await applySoundDirection(again.ai, script(3), { strict: true, journal: reopened });
  assert.deepEqual(again.log, ['sound@1'], 'the music plan is not bought twice');
  assert.equal(done.scenes.filter((x: any) => x.sound).length, 3);
  assert.equal(reopened.progress().soundChunksDone, 1);
});

// 10 scenes x 60 s = 10:00, long enough for mid-rolls (timeline.ts MIDROLL_MIN_VIDEO_SEC).
function directed(opts: { sfx?: (n: number) => string; into?: (n: number) => string; out?: (n: number) => string; cues?: any[] }) {
  return {
    musicCues: opts.cues,
    scenes: Array.from({ length: 10 }, (_, i) => ({
      sceneNumber: i + 1,
      actPhase: i < 3 ? 'Hook' : i < 7 ? 'Impact' : 'The Fix',
      narration: 'word '.repeat(150).trim(),
      durationEst: 60,
      visualType: i % 2 ? 'diagram' : 'character',
      soundEffect: opts.sfx?.(i + 1) ?? '',
      sound: { transitionIn: opts.into?.(i + 1) ?? 'cut' },
      motion: { transitionOut: opts.out?.(i + 1) ?? 'cut' },
    })),
  };
}
const find = (s: any, id: string) => analyzeScript(s).qualityChecks.find((c) => c.id === id);

test('audit: sound effects on most scenes, or stacked, are flagged; a few single ones are not', () => {
  assert.ok(find(directed({ sfx: (n) => (n <= 6 ? 'lock clunk' : '') }), 'sfx-overused'));
  assert.deepEqual(find(directed({ sfx: (n) => (n === 2 ? 'scratch + glass' : '') }), 'sfx-overused')!.sceneNumbers, [2]);
  assert.equal(find(directed({ sfx: (n) => (n === 2 || n === 7 ? 'lock clunk' : '') }), 'sfx-overused'), undefined);
});

test('audit: music under the whole runtime is flagged; a plan with a silence is not', () => {
  const all = [{ startScene: 1, endScene: 10 }];
  const gap = [{ startScene: 1, endScene: 4 }, { startScene: 6, endScene: 10 }];
  assert.ok(find(directed({ cues: all }), 'music-wall-to-wall'));
  assert.equal(find(directed({ cues: gap }), 'music-wall-to-wall'), undefined);
});

test('audit: many non-cut transitions are flagged; the forced fade after a mid-roll does not count against the editor', () => {
  assert.ok(find(directed({ into: (n) => (n > 1 ? 'dissolve' : 'cut') }), 'transition-showy'));
  assert.equal(find(directed({ into: (n) => (n === 5 ? 'dissolve' : 'cut') }), 'transition-showy'), undefined);
});

test('audit: a mid-roll after a scene that does not fade out is flagged, once there is a music plan', () => {
  const cues = [{ startScene: 1, endScene: 4 }];
  const s = directed({ cues });
  const markers = analyzeScript(s).midrollMarkers;
  assert.ok(markers.length > 0);
  assert.ok(find(s, 'midroll-without-fade'));
  const faded = directed({ cues, out: (n) => (markers.some((m) => m.afterSceneNumber === n) ? 'fade-to-black' : 'cut') });
  assert.equal(find(faded, 'midroll-without-fade'), undefined);
  assert.equal(find(directed({}), 'midroll-without-fade'), undefined, 'scripts from before the sound pass are not flagged');
});
