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
  /** The narrative prompt each chunk received, keyed by the scene number it starts at. */
  const narrPrompts: Record<number, string> = {};
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
          narrPrompts[at] = prompt;
          body = {
            scenes: Array.from({ length: count }, (_, i) => ({
              sceneNumber: at + i,
              title: `S${at + i}`,
              // Scene 6 is an analyst scene in the longer plans: a model that invents its own label for it
              // must not split the chapter it interrupts.
              actPhase: at + i === 6 ? 'Made-up label' : 'Hook',
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
  return { ai, log, narrPrompts };
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

async function runAll(ai: any, opts: ScriptRunOptions, plan: typeof PLAN = PLAN) {
  const bible = await generateProductionBible(ai, plan, RESEARCH, 'Brand', opts);
  const scenes = await generateSceneChunks(ai, plan, RESEARCH, bible, 'Brand', opts);
  const script: any = { title: 'T', scenes: scenes.map((s, i) => ({ ...s, sceneNumber: i + 1 })), characterBible: bible.characterBible, styleGuide: bible.styleGuide };
  return applyVisualDirection(ai, script, RESEARCH, opts);
}

// 200s target → 17 scenes → narrative chunks of 3,3,3,3,3,2 (scenes 1-3, 4-6, ... 16-17). The analyst speaks
// scenes 6 and 12 (shared/speakers.ts); 17 is the last, so the narrator closes.
const LONG_PLAN = { ...PLAN, targetDurationSec: 200 };

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

test('two voices: the analyst is assigned in code at scenes 6 and 12; the narrator opens and closes', async () => {
  const { ai } = fakeAi();
  const script = await runAll(ai, {}, LONG_PLAN);
  assert.equal(script.scenes.length, 17);
  assert.ok(script.scenes.every((s: any) => s.speaker === 'narrator' || s.speaker === 'analyst'), 'every scene carries a speaker');
  assert.deepEqual(script.scenes.filter((s: any) => s.speaker === 'analyst').map((s: any) => s.sceneNumber), [6, 12]);
  assert.equal(script.scenes[0].speaker, 'narrator');
  assert.equal(script.scenes[16].speaker, 'narrator');
});

test('a 60 s short has no analyst scene, and its prompts say every scene is the narrator', async () => {
  const { ai, narrPrompts } = fakeAi();
  const script = await runAll(ai, {});
  assert.ok(script.scenes.every((s: any) => s.speaker === 'narrator'));
  for (const p of Object.values(narrPrompts)) {
    assert.match(p, /Every scene in this chunk is the narrator's/);
    assert.doesNotMatch(p, /is the ANALYST's/);
  }
});

test("the prompt names exactly the analyst scenes in its chunk, and explains why they must sound different", async () => {
  const { ai, narrPrompts } = fakeAi();
  await runAll(ai, {}, LONG_PLAN);
  assert.match(narrPrompts[4], /scene #6 is the ANALYST's\. Every other scene is the narrator's/);
  assert.match(narrPrompts[4], /A different voice reads it/);
  assert.match(narrPrompts[4], /5 to 9s for an analyst scene/);
  assert.match(narrPrompts[10], /scene #12 is the ANALYST's/);
  for (const at of [1, 7, 13, 16]) {
    assert.match(narrPrompts[at], /Every scene in this chunk is the narrator's/, `chunk at scene ${at}`);
    assert.doesNotMatch(narrPrompts[at], /analyst scenes follow VOICES|5 to 9s/, `chunk at scene ${at} must not mention analyst length rules`);
  }
});

test('later chunks are shown who spoke the scenes before them', async () => {
  const { ai, narrPrompts } = fakeAi();
  await runAll(ai, {}, LONG_PLAN);
  assert.match(narrPrompts[7], /#6 \[ANALYST\] "S6"/);
  assert.match(narrPrompts[7], /#5 \[NARRATOR\] "S5"/);
});

test('an analyst scene keeps the actPhase of the scene it interrupts, so it cannot split a chapter', async () => {
  const { ai } = fakeAi();
  const script = await runAll(ai, {}, LONG_PLAN);
  assert.equal(script.scenes[5].actPhase, 'Hook', "the model's own label ('Made-up label') is replaced by scene 5's");
  assert.equal(script.scenes[4].actPhase, 'Hook');
});

test('visualPrompt is built from character + background + scene + styleAnchor, not just scene + styleAnchor', async () => {
  const script: any = { scenes: [{ sceneNumber: 1, visualPrompt: 'fallback' }] };
  const ai: any = {
    models: {
      generateContent: async () => ({
        text: JSON.stringify({
          scenes: [
            {
              sceneNumber: 1,
              visual: { character: 'A hooded figure, ANCHOR', background: 'a dim server room', scene: 'the figure types at a terminal', styleAnchor: 'noir, high contrast', negative: 'no cartoons' },
              motion: { shotType: 's', cameraMove: 'm', subjectMotion: 'x', durationSec: 10, easing: 'e', transitionOut: 't', motionPrompt: 'p' },
              citations: [],
            },
          ],
        }),
        candidates: [{ finishReason: 'STOP' }],
        usageMetadata: {},
      }),
    },
  };
  const result = await applyVisualDirection(ai, script, RESEARCH, {});
  assert.equal(result.scenes[0].visualPrompt, 'A hooded figure, ANCHOR a dim server room the figure types at a terminal noir, high contrast');
  assert.doesNotMatch(result.scenes[0].visualPrompt, /no cartoons/, 'the negative prompt must not leak into the positive visualPrompt');
});

test('an empty-cast scene\'s "No characters in frame." sentinel is filtered out of visualPrompt', async () => {
  const script: any = { scenes: [{ sceneNumber: 1, visualPrompt: 'fallback' }] };
  const ai: any = {
    models: {
      generateContent: async () => ({
        text: JSON.stringify({
          scenes: [
            {
              sceneNumber: 1,
              visual: { character: 'No characters in frame.', background: 'an empty data center at night', scene: 'rows of blinking server racks', styleAnchor: 'noir, high contrast', negative: 'no people' },
              motion: { shotType: 's', cameraMove: 'm', subjectMotion: 'x', durationSec: 10, easing: 'e', transitionOut: 't', motionPrompt: 'p' },
              citations: [],
            },
          ],
        }),
        candidates: [{ finishReason: 'STOP' }],
        usageMetadata: {},
      }),
    },
  };
  const result = await applyVisualDirection(ai, script, RESEARCH, {});
  assert.equal(result.scenes[0].visualPrompt, 'an empty data center at night rows of blinking server racks noir, high contrast');
  assert.doesNotMatch(result.scenes[0].visualPrompt, /No characters in frame/);
});

test('a run resumed from the journal assigns the same speakers as the original', async () => {
  const first = await RunJournal.open('two-voice', 'h', { dir });
  const original = await runAll(fakeAi().ai, { journal: first }, LONG_PLAN);

  const second = await RunJournal.open('two-voice', 'h', { dir });
  const { ai, log } = fakeAi();
  const replayed = await runAll(ai, { journal: second }, LONG_PLAN);
  assert.ok(!log.some((l) => l.startsWith('narr')), 'every narrative chunk came from the journal');
  assert.deepEqual(replayed.scenes.map((s: any) => s.speaker), original.scenes.map((s: any) => s.speaker));
});

// shared/topicProfile.ts: a custom topicDomain must reach the prompt and replace the cybersecurity
// persona; omitting it must reproduce the historical wording exactly (the byte-identical-default guarantee).
test('a custom topicDomain replaces the cybersecurity persona in the narrative prompt', async () => {
  const journal = await RunJournal.open('topic-custom', 'h', { dir });
  const { ai, narrPrompts } = fakeAi();
  await runAll(ai, { journal, degraded: [], topicDomain: 'personal finance and markets' });
  const prompt = narrPrompts[1];
  assert.match(prompt, /personal finance and markets/);
  assert.doesNotMatch(prompt, /CVE|CVSS|hooded hacker|cybersecurity/i);
});

test('omitting topicDomain reproduces the historical cybersecurity persona exactly', async () => {
  const journal = await RunJournal.open('topic-default', 'h', { dir });
  const { ai, narrPrompts } = fakeAi();
  await runAll(ai, { journal, degraded: [] });
  assert.match(narrPrompts[1], /cybersecurity journalism/);
});
