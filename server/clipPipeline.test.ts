import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resetModelCooldowns } from './gemini';
import { RunJournal } from './runJournal';
import { applyClipDirection, toClipDirections, CLIP_SCENES_PER_CHUNK } from './clipPipeline';

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

/** A fake model for the clip prompt: answers each scene in the chunk with the clip numbers it was given. */
function fakeClipAi(opts: { fail?: number; perClip?: (scene: number, clip: number) => any } = {}) {
  const log: string[] = [];
  const prompts: string[] = [];
  const ai: any = {
    models: {
      generateContent: async ({ contents }: { contents: string }) => {
        const prompt = String(contents);
        const scenes = JSON.parse(prompt.slice(prompt.indexOf('<scenes>') + '<scenes>'.length, prompt.indexOf('</scenes>')));
        const tag = `clips@${scenes[0].sceneNumber}`;
        prompts.push(prompt);
        if (log[log.length - 1] !== tag) log.push(tag);
        if (opts.fail === scenes[0].sceneNumber) throw perDay();
        const body = {
          scenes: scenes.map((s: any) => ({
            sceneNumber: s.sceneNumber,
            clips: s.clips.map((c: any) =>
              opts.perClip?.(s.sceneNumber, c.clipNumber) ?? {
                clipNumber: c.clipNumber,
                action: `Scene ${s.sceneNumber} clip ${c.clipNumber} action.`,
                camera: 'Static camera.',
                environment: 'Haze drifts.',
                endFrame: `End of ${s.sceneNumber}.${c.clipNumber}.`,
              }
            ),
          })),
        };
        return { text: JSON.stringify(body), candidates: [{ finishReason: 'STOP' }], usageMetadata: {} };
      },
    },
  };
  return { ai, log, prompts };
}

function script(n: number, secs = 12) {
  return {
    title: 'T',
    scenes: Array.from({ length: n }, (_, i) => ({
      sceneNumber: i + 1,
      title: `S${i + 1}`,
      narration: 'First sentence here. Second sentence here. Third one. Fourth one.',
      durationEst: secs,
      visual: { character: 'No characters in frame.', background: 'A dark server room.', scene: 'Wide shot.', styleAnchor: 'Noir.' },
      motion: { shotType: 'Wide', cameraMove: 'Slow push-in', subjectMotion: 'Fans spin' },
    })),
  };
}

let dir: string;
const dirs: string[] = [];
beforeEach(async () => {
  resetModelCooldowns();
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cp-clips-'));
  dirs.push(dir);
});
after(async () => {
  for (const d of dirs) await fs.rm(d, { recursive: true, force: true });
});

test('applyClipDirection: every scene gets its clips, timed by code, written by the model, chunked', async () => {
  const { ai, log, prompts } = fakeClipAi();
  const n = CLIP_SCENES_PER_CHUNK + 2;
  const s: any = await applyClipDirection(ai, script(n), {});
  assert.deepEqual(log, ['clips@1', `clips@${CLIP_SCENES_PER_CHUNK + 1}`]);
  assert.equal(s.scenes[0].clips.length, 2, '12 s is two clips');
  assert.deepEqual(s.scenes[0].clips.map((c: any) => [c.startSec, c.durationSec, c.source]), [[0, 6, 'model'], [6, 6, 'model']]);
  assert.equal(s.scenes[0].clips[1].action, 'Scene 1 clip 2 action.');
  assert.equal(s.scenes[0].clips[0].narrationBeat, 'First sentence here. Second sentence here.');
  // The model is told the clip split and the narration per clip, and the second chunk sees where the first ended.
  assert.match(prompts[0], /"narrationOverThisClip": "First sentence here. Second sentence here."/);
  assert.match(prompts[1], new RegExp(`ended on: End of ${CLIP_SCENES_PER_CHUNK}\\.2\\.`));
});

test('toClipDirections: keeps only the clip numbers the scene has, drops clips without action or camera', () => {
  const scene = script(1)[`scenes`][0];
  const got = toClipDirections(
    { clips: [{ clipNumber: 1, action: 'a', camera: '' }, { clipNumber: 2, action: ' b ', camera: 'c' }, { clipNumber: 3, action: 'x', camera: 'y' }] },
    scene
  );
  assert.deepEqual(got, [{ clipNumber: 2, action: 'b', camera: 'c', environment: '', endFrame: '' }]);
});

test('a failed chunk degrades to clips from motion; strict throws, and a resumed run does not rebuy a finished chunk', async () => {
  const degraded: string[] = [];
  const s: any = await applyClipDirection(fakeClipAi({ fail: 1 }).ai, script(3), { degraded });
  assert.ok(s.scenes.every((x: any) => x.clips.length === 2 && x.clips.every((c: any) => c.source === 'derived')));
  assert.equal(s.scenes[0].clips[0].camera, 'Slow push-in');
  assert.match(degraded.join(' '), /Clip prompts chunk 1\/1 failed/);

  resetModelCooldowns();
  const journal = await RunJournal.open('clip-run', 'h', { dir });
  await assert.rejects(applyClipDirection(fakeClipAi({ fail: CLIP_SCENES_PER_CHUNK + 1 }).ai, script(CLIP_SCENES_PER_CHUNK + 1), { strict: true, journal }));
  assert.equal(journal.progress().clipChunksDone, 1, 'the first chunk finished before the quota hit and is kept');

  resetModelCooldowns();
  const again = fakeClipAi();
  const reopened = await RunJournal.open('clip-run', 'h', { dir });
  const done: any = await applyClipDirection(again.ai, script(CLIP_SCENES_PER_CHUNK + 1), { strict: true, journal: reopened });
  assert.deepEqual(again.log, [`clips@${CLIP_SCENES_PER_CHUNK + 1}`]);
  assert.ok(done.scenes.every((x: any) => x.clips.every((c: any) => c.source === 'model')));
});
