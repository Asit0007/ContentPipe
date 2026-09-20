import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resetModelCooldowns } from './gemini';
import { QuotaExhaustedError } from './quota';
import { RunJournal } from './runJournal';
import {
  generateProductionBible,
  generateSceneChunks,
  applyVisualDirection,
  buildGenerationSummary,
  sceneTargetFor,
  type ScriptRunOptions,
} from './scriptPipeline';

// 60s target → sceneTargetFor = 5 scenes → narrative chunks of 3 + 2, art direction in 1 chunk.
const PLAN = { title: 'T', tone: 'Deep Dive Documentary', targetDurationSec: 60 };
const RESEARCH = { topicTitle: 'T', summary: 's', retrievedSources: [] };

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
const badRequest = () => Object.assign(new Error('{"error":{"code":400,"message":"schema rejected"}}'), { status: 400 });

type Fault = { kind: 'bible' | 'narr' | 'art'; at?: number; err: () => Error };

/**
 * A fake Gemini client that answers by recognising which pass the prompt belongs to.
 * `log` records each *logical* pass once (the chain retries the same pass on 3 models).
 */
function fakeAi(faults: Fault[] = []) {
  const log: string[] = [];
  const ai: any = {
    models: {
      generateContent: async ({ contents }: { model: string; contents: string }) => {
        const prompt = String(contents);
        let kind: 'bible' | 'narr' | 'art';
        let at = 0;
        let body: any;
        if (prompt.includes('production designer')) {
          kind = 'bible';
          body = {
            characterBible: [{ id: 'a', name: 'A', role: 'analyst', appearance: 'x', wardrobe: 'w', palette: 'p', promptAnchor: 'ANCHOR' }],
            styleGuide: { artDirection: 'noir', colorPalette: 'c', lighting: 'l', lensAndFilm: 'f', negativePrompt: 'n' },
          };
        } else if (prompt.includes('art director and cinematographer')) {
          kind = 'art';
          const nums = [...prompt.matchAll(/"sceneNumber": (\d+)/g)].map((m) => Number(m[1]));
          at = nums[0];
          body = {
            scenes: nums.map((n) => ({
              sceneNumber: n,
              visual: { character: 'c', background: 'b', scene: `scene ${n}`, styleAnchor: 'STYLE', negative: 'n' },
              motion: { shotType: 's', cameraMove: 'm', subjectMotion: 'x', durationSec: 10, easing: 'e', transitionOut: 't', motionPrompt: 'p' },
              citations: [],
            })),
          };
        } else {
          kind = 'narr';
          const count = Number(prompt.match(/Write EXACTLY (\d+) new scenes/)?.[1]);
          at = Number(prompt.match(/starting at (\d+)/)?.[1]);
          body = {
            scenes: Array.from({ length: count }, (_, i) => ({
              sceneNumber: at + i,
              title: `S${at + i}`,
              actPhase: 'Hook',
              narration: 'word '.repeat(30).trim(),
              durationEst: 10,
              visualPrompt: 'vp',
              visualType: 'terminal',
              onScreenText: 'x',
              soundEffect: 'y',
            })),
          };
        }
        const tag = `${kind}${kind === 'bible' ? '' : '@' + at}`;
        if (log[log.length - 1] !== tag) log.push(tag);
        const fault = faults.find((f) => f.kind === kind && (f.at === undefined || f.at === at));
        if (fault) throw fault.err();
        return { text: JSON.stringify(body), candidates: [{ finishReason: 'STOP' }], usageMetadata: {} };
      },
    },
  };
  return { ai, log };
}

let dir: string;
const dirs: string[] = [];
beforeEach(async () => {
  resetModelCooldowns();
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cp-pipeline-'));
  dirs.push(dir);
});
after(async () => {
  for (const d of dirs) await fs.rm(d, { recursive: true, force: true });
});

async function runAll(ai: any, opts: ScriptRunOptions) {
  const bible = await generateProductionBible(ai, PLAN, RESEARCH, 'Brand', opts);
  const scenes = await generateSceneChunks(ai, PLAN, RESEARCH, bible, 'Brand', opts);
  const script: any = { title: 'T', scenes: scenes.map((s, i) => ({ ...s, sceneNumber: i + 1 })), characterBible: bible.characterBible, styleGuide: bible.styleGuide };
  return applyVisualDirection(ai, script, RESEARCH, opts);
}

test('sceneTargetFor: 60s → 5 scenes, 540s → 47, clamped to [5, 80]', () => {
  assert.equal(sceneTargetFor(60), 5);
  assert.equal(sceneTargetFor(540), 47);
  assert.equal(sceneTargetFor(10), 5);
  assert.equal(sceneTargetFor(99999), 80);
});

test('happy path: bible + 2 narrative chunks + 1 art chunk, journal fully populated, generation.complete', async () => {
  const journal = await RunJournal.open('happy', 'h', { dir });
  const degraded: string[] = [];
  const { ai, log } = fakeAi();
  const script = await runAll(ai, { journal, degraded });
  assert.deepEqual(log, ['bible', 'narr@1', 'narr@4', 'art@1']);
  assert.equal(script.scenes.length, 5);
  assert.deepEqual(journal.progress(), { hasProductionBible: true, narrativeChunksDone: 2, artChunksDone: 1, scenesSoFar: 5 });
  const g = buildGenerationSummary(script, { runId: 'happy', requestedDurationSec: 60, degraded });
  assert.equal(g.complete, true);
  assert.equal(g.producedScenes, 5);
  assert.equal(g.producedDurationSec, 50);
});

test('STRICT: a daily-quota hit mid-script throws (no truncated script), and the journal keeps the finished work', async () => {
  const journal = await RunJournal.open('cut', 'h', { dir });
  const { ai } = fakeAi([{ kind: 'narr', at: 4, err: perDay }]);
  await assert.rejects(runAll(ai, { strict: true, journal, degraded: [] }), (e: any) => e instanceof QuotaExhaustedError && e.kind === 'per_day');
  assert.deepEqual(journal.progress(), { hasProductionBible: true, narrativeChunksDone: 1, artChunksDone: 0, scenesSoFar: 3 });
});

test('RESUME after the quota reset re-spends ONLY the unfinished calls — no bible, no finished chunk', async () => {
  const first = await RunJournal.open('resume', 'h', { dir });
  await assert.rejects(runAll(fakeAi([{ kind: 'narr', at: 4, err: perDay }]).ai, { strict: true, journal: first, degraded: [] }));

  resetModelCooldowns(); // the quota reset
  const second = await RunJournal.open('resume', 'h', { dir }); // fresh process, same inputs
  assert.equal(second.resumed, true);
  const { ai, log } = fakeAi();
  const script = await runAll(ai, { strict: true, journal: second, degraded: [] });

  assert.deepEqual(log, ['narr@4', 'art@1'], 'only the remaining 2 of 4 calls should have been made');
  assert.equal(script.scenes.length, 5);
  assert.equal(script.scenes.filter((s: any) => s.visual).length, 5);
});

test('NON-STRICT (the UI path) keeps the old behaviour: a failed chunk yields a partial script, disclosed in degraded[]', async () => {
  const degraded: string[] = [];
  const { ai } = fakeAi([{ kind: 'narr', at: 4, err: perDay }]);
  const bible = await generateProductionBible(ai, PLAN, RESEARCH, 'Brand', { degraded });
  const scenes = await generateSceneChunks(ai, PLAN, RESEARCH, bible, 'Brand', { degraded });
  assert.equal(scenes.length, 3);
  assert.match(degraded[0], /Narrative chunk 2\/2 failed: script stops at 3\/5 scenes/);
  const g = buildGenerationSummary({ scenes, characterBible: bible.characterBible, styleGuide: bible.styleGuide }, { requestedDurationSec: 60, degraded });
  assert.equal(g.complete, false);
});

test('STRICT still degrades on NON-retryable failures (a rejected schema) — and says so', async () => {
  const journal = await RunJournal.open('nonretry', 'h', { dir });
  const degraded: string[] = [];
  const { ai } = fakeAi([{ kind: 'art', err: badRequest }]);
  const script = await runAll(ai, { strict: true, journal, degraded });
  assert.equal(script.scenes.length, 5);
  assert.equal(script.scenes.filter((s: any) => s.visual).length, 0);
  assert.match(degraded.join('\n'), /Art direction chunk 1\/1 failed: scenes 1-5 have flat prompts only/);
  assert.equal(buildGenerationSummary(script, { requestedDurationSec: 60, degraded }).complete, false);
});

test('a failed production bible in strict mode with quota → throws; with a bad request → degrades and is disclosed', async () => {
  await assert.rejects(
    generateProductionBible(fakeAi([{ kind: 'bible', err: perDay }]).ai, PLAN, RESEARCH, 'B', { strict: true }),
    QuotaExhaustedError
  );
  resetModelCooldowns();
  const degraded: string[] = [];
  const b = await generateProductionBible(fakeAi([{ kind: 'bible', err: badRequest }]).ai, PLAN, RESEARCH, 'B', { strict: true, degraded });
  assert.deepEqual(b, { characterBible: [], styleGuide: {} });
  assert.match(degraded[0], /Production bible failed/);
});
