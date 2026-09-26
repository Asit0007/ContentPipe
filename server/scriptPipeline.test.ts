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
  normalizeForAnchorMatch,
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
              charactersInFrame: [],
              locationId: `loc-${n}`,
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

/**
 * A fake Gemini client for art-direction-only tests (applyVisualDirection called directly, bypassing
 * the bible/narrative passes). Calls `perScene(n)` for every requested scene number and returns
 * `{ scenes: [...] }`; captures each call's full prompt keyed by the chunk's first scene number
 * (mirrors fakeAi's narrPrompts). `faultOnFirstScene`, if given, throws a per-day quota error instead
 * of answering when a chunk starting at that scene number is requested — for resume tests.
 */
function fakeArtAi(perScene: (n: number) => any, faultOnFirstScene?: number) {
  const artPrompts: Record<number, string> = {};
  const ai: any = {
    models: {
      generateContent: async ({ contents }: { model: string; contents: string }) => {
        const prompt = String(contents);
        const nums = [...prompt.matchAll(/"sceneNumber": (\d+)/g)].map((m) => Number(m[1]));
        artPrompts[nums[0]] = prompt;
        if (faultOnFirstScene === nums[0]) throw perDay();
        return { text: JSON.stringify({ scenes: nums.map((n) => perScene(n)) }), candidates: [{ finishReason: 'STOP' }], usageMetadata: {} };
      },
    },
  };
  return { ai, artPrompts };
}

/** A minimal script for applyVisualDirection-only tests: `n` scenes, one bible character ('a'). */
function scriptWithScenes(n: number, opts: { tonePacing?: string; visualType?: (sceneNumber: number) => string } = {}) {
  return {
    title: 'T',
    tonePacing: opts.tonePacing ?? 'Deep Dive Documentary',
    characterBible: [{ id: 'a', name: 'A', role: 'analyst', appearance: 'x', wardrobe: 'w', palette: 'p', promptAnchor: 'ANCHOR CLAUSE' }],
    styleGuide: {},
    scenes: Array.from({ length: n }, (_, i) => ({
      sceneNumber: i + 1,
      title: `S${i + 1}`,
      visualType: (opts.visualType ?? (() => 'character'))(i + 1),
      visualPrompt: 'fallback',
    })),
  };
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
  // tonePacing mirrors what server.ts sets on `script` before calling applyVisualDirection in
  // production (both the real and fallback-script paths) — applyVisualDirection reads it to decide
  // the documentary shot-rhythm hint in buildPriorVisualContext.
  const script: any = { title: 'T', tonePacing: plan.tone, scenes: scenes.map((s, i) => ({ ...s, sceneNumber: i + 1 })), characterBible: bible.characterBible, styleGuide: bible.styleGuide };
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
  assert.deepEqual(journal.progress(), { hasProductionBible: true, narrativeChunksDone: 2, artChunksDone: 1, soundChunksDone: 0, scenesSoFar: 5 });
  const g = buildGenerationSummary(script, { runId: 'happy', requestedDurationSec: 60, degraded });
  assert.equal(g.complete, true);
  assert.equal(g.producedScenes, 5);
  assert.equal(g.producedDurationSec, 50);
});

test('STRICT: a daily-quota hit mid-script throws (no truncated script), and the journal keeps the finished work', async () => {
  const journal = await RunJournal.open('cut', 'h', { dir });
  const { ai } = fakeAi([{ kind: 'narr', at: 4, err: perDay }]);
  await assert.rejects(runAll(ai, { strict: true, journal, degraded: [] }), (e: any) => e instanceof QuotaExhaustedError && e.kind === 'per_day');
  assert.deepEqual(journal.progress(), { hasProductionBible: true, narrativeChunksDone: 1, artChunksDone: 0, soundChunksDone: 0, scenesSoFar: 3 });
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

// A live run wrote "Millions of websites…", then, once numbers were ruled out, "the data stolen" and "the sheer
// scale of the exposure" — claims, not figures, and against a dossier whose researchGaps said the reach and any
// abuse in the wild were unknown. FACTUAL DISCIPLINE only covered specifics, and disclosureDiscipline asks for
// "who and how many were exposed", so the rule about gaps has to sit after it and cover claims.
test('the narrative prompt says what researchGaps means, and that a gap is narrated around, not filled', async () => {
  const { ai, narrPrompts } = fakeAi();
  await runAll(ai, {}, LONG_PLAN);
  assert.ok(Object.keys(narrPrompts).length > 1);
  for (const [at, p] of Object.entries(narrPrompts)) {
    assert.match(p, /CLAIMS THE DOSSIER CANNOT BACK/, `chunk at scene ${at}`);
    assert.match(p, /"researchGaps" lists what the sources never established/, `chunk at scene ${at}`);
    assert.match(p, /what was possible, not what happened/, `chunk at scene ${at}`);
    assert.match(p, /the analyst's included/, `chunk at scene ${at}`);
    // It qualifies the disclosure discipline, so it has to come after it.
    assert.ok(p.indexOf('SHOW THE DAMAGE') < p.indexOf('CLAIMS THE DOSSIER CANNOT BACK'), `chunk at scene ${at}: rule must follow disclosureDiscipline`);
  }
});

test('the claims rule is not domain-specific: a custom topicDomain gets it too, with no cyber vocabulary', async () => {
  const journal = await RunJournal.open('claims-custom', 'h', { dir });
  const { ai, narrPrompts } = fakeAi();
  await runAll(ai, { journal, degraded: [], topicDomain: 'personal finance and markets' });
  assert.match(narrPrompts[1], /CLAIMS THE DOSSIER CANNOT BACK/);
  assert.doesNotMatch(narrPrompts[1], /CVE|CVSS|hooded hacker|cybersecurity/i);
});

// CLAUDE.md "Visual consistency: what's enforced, what isn't" — promptAnchor reuse, recurring
// backgrounds and cut/shot rhythm, closed in applyVisualDirection the same way styleAnchor already is:
// ask the model, then verify or force it in code.

test("recurring backgrounds are force-matched to the first chunk's wording, even when a later chunk drifts", async () => {
  const script = scriptWithScenes(17); // 3 art-direction chunks: 1-6, 7-12, 13-17
  const perScene = (n: number) => ({
    sceneNumber: n,
    visual: {
      character: 'No characters in frame.',
      background: n === 1 ? 'Row A, humming racks' : n === 13 ? 'Row Z, dim lighting' : `bg-${n}`,
      scene: `scene ${n}`,
      styleAnchor: 'STYLE',
      negative: 'n',
    },
    motion: { shotType: 's', cameraMove: 'm', subjectMotion: 'x', durationSec: 10, easing: 'e', transitionOut: 't', motionPrompt: 'p' },
    citations: [],
    charactersInFrame: [],
    locationId: n === 1 || n === 13 ? 'server-room' : `loc-${n}`,
  });
  const { ai } = fakeArtAi(perScene);
  const result = await applyVisualDirection(ai, script, RESEARCH, {});
  assert.equal(result.scenes[0].visual.background, 'Row A, humming racks');
  assert.equal(result.scenes[12].visual.background, 'Row A, humming racks', "scene 13 must match scene 1's wording, not its own drifted text");
  assert.match(result.scenes[12].visualPrompt, /Row A, humming racks/);
  assert.doesNotMatch(result.scenes[12].visualPrompt, /Row Z/);
});

test('promptAnchor is force-spliced into visual.character when missing, and not duplicated when already present', async () => {
  const script = scriptWithScenes(2);
  const perScene = (n: number) => ({
    sceneNumber: n,
    visual: {
      character: n === 1 ? 'A tired analyst leans forward' : 'ANCHOR CLAUSE, leaning forward thoughtfully',
      background: 'a dim office',
      scene: 'the analyst studies a monitor',
      styleAnchor: 'STYLE',
      negative: 'n',
    },
    motion: { shotType: 's', cameraMove: 'm', subjectMotion: 'x', durationSec: 10, easing: 'e', transitionOut: 't', motionPrompt: 'p' },
    citations: [],
    charactersInFrame: ['a'],
    locationId: 'office',
  });
  const { ai } = fakeArtAi(perScene);
  const result = await applyVisualDirection(ai, script, RESEARCH, {});
  assert.match(result.scenes[0].visual.character, /^ANCHOR CLAUSE/, 'a missing anchor is prepended');
  const occurrences = (result.scenes[1].visual.character.match(/ANCHOR CLAUSE/g) || []).length;
  assert.equal(occurrences, 1, 'an anchor already present must not be duplicated');
});

// Live run, scene 6: the bible's anchor had non-breaking hyphens (U+2011) and a curly apostrophe; the art model
// copied it with plain ones, the exact-substring check called that a miss, and the anchor was prepended a second time.
test('an anchor the model copied with plain hyphens and apostrophes is recognised, not prepended a second time', async () => {
  const script = scriptWithScenes(2);
  script.characterBible[0].promptAnchor = 'mid‑30s woman, 5’6", medium‑brown skin, charcoal blazer';
  const perScene = (n: number) => ({
    sceneNumber: n,
    visual: {
      character: n === 1 ? 'Dr. A: mid-30s woman, 5\'6", medium-brown skin, charcoal blazer, speaking to camera' : 'A tired analyst leans forward',
      background: 'a dim office',
      scene: 'the analyst studies a monitor',
      styleAnchor: 'STYLE',
      negative: 'n',
    },
    motion: { shotType: 's', cameraMove: 'm', subjectMotion: 'x', durationSec: 10, easing: 'e', transitionOut: 't', motionPrompt: 'p' },
    citations: [],
    charactersInFrame: ['a'],
    locationId: 'office',
  });
  const { ai } = fakeArtAi(perScene);
  const result = await applyVisualDirection(ai, script, RESEARCH, {});
  assert.equal(
    result.scenes[0].visual.character,
    'Dr. A: mid-30s woman, 5\'6", medium-brown skin, charcoal blazer, speaking to camera',
    'a faithful copy in plain characters is left exactly as the model wrote it'
  );
  assert.equal((result.scenes[0].visualPrompt.match(/charcoal blazer/g) || []).length, 1, 'the description reaches the flat prompt once');
  assert.match(result.scenes[1].visual.character, /^mid‑30s woman, 5’6", medium‑brown skin, charcoal blazer /, 'a genuinely missing anchor is still prepended, as the bible wrote it');
});

test('normalizeForAnchorMatch folds dash, quote, space and case variants, and only those', () => {
  assert.equal(normalizeForAnchorMatch('Mid‑30s,  5’6" tall'), normalizeForAnchorMatch("mid-30s, 5'6\" tall"));
  assert.equal(normalizeForAnchorMatch('a–b — c'), 'a-b - c');
  assert.notEqual(normalizeForAnchorMatch('mid-30s woman'), normalizeForAnchorMatch('mid-40s woman'), 'a different description is still different');
  assert.equal(normalizeForAnchorMatch(undefined as any), '');
});

test('an unknown charactersInFrame id is skipped without throwing', async () => {
  const script = scriptWithScenes(1);
  const perScene = (n: number) => ({
    sceneNumber: n,
    visual: { character: 'A mysterious figure', background: 'a dark alley', scene: 'the figure waits', styleAnchor: 'STYLE', negative: 'n' },
    motion: { shotType: 's', cameraMove: 'm', subjectMotion: 'x', durationSec: 10, easing: 'e', transitionOut: 't', motionPrompt: 'p' },
    citations: [],
    charactersInFrame: ['ghost'],
    locationId: 'alley',
  });
  const { ai } = fakeArtAi(perScene);
  const result = await applyVisualDirection(ai, script, RESEARCH, {});
  assert.equal(result.scenes[0].visual.character, 'A mysterious figure');
});

test('priorVisualContext is empty for the opening chunk and carries the tally, locations and shots from chunk 2 onward', async () => {
  const script = scriptWithScenes(12, { visualType: (n) => (n <= 6 ? 'terminal' : 'diagram') }); // 2 art chunks: 1-6, 7-12
  const perScene = (n: number) => ({
    sceneNumber: n,
    visual: { character: 'No characters in frame.', background: n === 1 ? 'a server room' : `bg-${n}`, scene: `scene ${n}`, styleAnchor: 'STYLE', negative: 'n' },
    motion: { shotType: 's', cameraMove: 'm', subjectMotion: 'x', durationSec: 10, easing: 'e', transitionOut: 't', motionPrompt: 'p' },
    citations: [],
    charactersInFrame: [],
    locationId: n === 1 ? 'server-room' : `loc-${n}`,
  });
  const { ai, artPrompts } = fakeArtAi(perScene);
  await applyVisualDirection(ai, script, RESEARCH, {});
  assert.match(artPrompts[1], /opening chunk of the art-direction pass/);
  // The instructional text names "PRIOR VISUAL CONTEXT" on every chunk (telling the model where to
  // look for it); only the dynamic block itself — this exact heading — is chunk-2-onward.
  assert.doesNotMatch(artPrompts[1], /PRIOR VISUAL CONTEXT \(from earlier chunks/);
  assert.match(artPrompts[7], /PRIOR VISUAL CONTEXT \(from earlier chunks/);
  assert.match(artPrompts[7], /terminal=6/);
  assert.match(artPrompts[7], /"server-room": a server room/);
});

// Live run: 7 of 10 scenes were set in one "split-screen terminal | void" canvas. The prompt never said a diagram is not a
// place, never limited reuse, and later chunks were not told how often a place had been used.
const monotonyPerScene = (usedIn: number[]) => (n: number) => ({
  sceneNumber: n,
  visual: { character: 'No characters in frame.', background: usedIn.includes(n) ? 'a digital void' : `bg-${n}`, scene: `scene ${n}`, styleAnchor: 'STYLE', negative: 'n' },
  motion: { shotType: 's', cameraMove: 'm', subjectMotion: 'x', durationSec: 10, easing: 'e', transitionOut: 't', motionPrompt: 'p' },
  citations: [],
  charactersInFrame: [],
  locationId: usedIn.includes(n) ? 'digital-void' : `loc-${n}`,
});

test('the art prompt keeps composition out of "background", says a diagram is not a place, and limits how often one place recurs', async () => {
  const { ai, artPrompts } = fakeArtAi(monotonyPerScene([]));
  await applyVisualDirection(ai, scriptWithScenes(6), RESEARCH, {});
  const p = artPrompts[1];
  assert.match(p, /no composition, panel split, overlay or on-screen text \(those belong in "scene"\)/);
  assert.match(p, /A diagram, timeline or data graph is not a place, so set it in one/);
  assert.match(p, /never a generic void/);
  assert.match(p, /one place for at most 2 scenes in a row, and for no more than about a quarter of all the scenes/);
});

test('a later chunk is shown how often each place has been used, and which ones are spent', async () => {
  const script = scriptWithScenes(12); // 2 art chunks: 1-6, 7-12
  const { ai, artPrompts } = fakeArtAi(monotonyPerScene([1, 2, 3, 4]));
  await applyVisualDirection(ai, script, RESEARCH, {});
  assert.doesNotMatch(artPrompts[1], /used in \d+ scene/, 'the opening chunk has no history to show');
  assert.match(artPrompts[7], /"digital-void": a digital void \(used in 4 scenes so far: #1, #2, #3, #4\)/);
  assert.match(artPrompts[7], /"loc-5": bg-5 \(used in 1 scene so far: #5\)/, 'singular for one scene');
  assert.match(artPrompts[7], /Used in 3 or more scenes already, so treat as used up unless the story truly goes back there: "digital-void"\. Set the next scenes somewhere new\./);
  assert.doesNotMatch(artPrompts[7], /used up unless[^\n]*"loc-5"/, 'a place used once is not spent');
});

test('no place is called spent until it has been used three times', async () => {
  const { ai, artPrompts } = fakeArtAi(monotonyPerScene([1, 2]));
  await applyVisualDirection(ai, scriptWithScenes(12), RESEARCH, {});
  assert.match(artPrompts[7], /"digital-void": a digital void \(used in 2 scenes so far: #1, #2\)/);
  assert.doesNotMatch(artPrompts[7], /treat as used up/);
});

test('the documentary shot-rhythm hint only appears under Deep Dive Documentary tone', async () => {
  const perScene = (n: number) => ({
    sceneNumber: n,
    visual: { character: 'No characters in frame.', background: `bg-${n}`, scene: `scene ${n}`, styleAnchor: 'STYLE', negative: 'n' },
    motion: { shotType: 's', cameraMove: 'm', subjectMotion: 'x', durationSec: 10, easing: 'e', transitionOut: 't', motionPrompt: 'p' },
    citations: [],
    charactersInFrame: [],
    locationId: `loc-${n}`,
  });

  const doc = fakeArtAi(perScene);
  await applyVisualDirection(doc.ai, scriptWithScenes(12, { tonePacing: 'Deep Dive Documentary' }), RESEARCH, {});
  assert.match(doc.artPrompts[7], /at least half of ALL scenes should end up "terminal", "diagram" or "headline"/);

  const fun = fakeArtAi(perScene);
  await applyVisualDirection(fun.ai, scriptWithScenes(12, { tonePacing: 'Witty Tech & Sarcastic' }), RESEARCH, {});
  assert.doesNotMatch(fun.artPrompts[7], /at least half of ALL scenes/);
});

test("a journaled chunk still informs the next chunk's priorVisualContext after resume", async () => {
  const script = scriptWithScenes(12);
  const perScene = (n: number) => ({
    sceneNumber: n,
    visual: { character: 'No characters in frame.', background: n === 1 ? 'a server room' : `bg-${n}`, scene: `scene ${n}`, styleAnchor: 'STYLE', negative: 'n' },
    motion: { shotType: 's', cameraMove: 'm', subjectMotion: 'x', durationSec: 10, easing: 'e', transitionOut: 't', motionPrompt: 'p' },
    citations: [],
    charactersInFrame: [],
    locationId: n === 1 ? 'server-room' : `loc-${n}`,
  });

  const journal1 = await RunJournal.open('art-resume', 'h', { dir });
  const run1 = fakeArtAi(perScene, 7);
  await assert.rejects(applyVisualDirection(run1.ai, { ...script }, RESEARCH, { strict: true, journal: journal1 }));
  assert.equal(journal1.progress().artChunksDone, 1);

  resetModelCooldowns();
  const journal2 = await RunJournal.open('art-resume', 'h', { dir });
  const run2 = fakeArtAi(perScene);
  await applyVisualDirection(run2.ai, { ...script }, RESEARCH, { strict: true, journal: journal2 });

  assert.ok(!(1 in run2.artPrompts), 'chunk 1 should be served from the journal, not regenerated');
  assert.match(
    run2.artPrompts[7],
    /"server-room": a server room/,
    "chunk 2's context must still know about chunk 1's location even though chunk 1 itself was replayed from the journal"
  );
});

test("canonical anchor and background resolve by scene number, not the order scenes appear in a chunk's response", async () => {
  const script = scriptWithScenes(2);
  const ai: any = {
    models: {
      generateContent: async () => ({
        // Scene 2 returned FIRST in the response array, before scene 1 — the code must still treat
        // scene 1 (the lower scene number) as "first occurrence" for canonical values.
        text: JSON.stringify({
          scenes: [
            {
              sceneNumber: 2,
              visual: { character: 'c', background: 'bg-2', scene: 's2', styleAnchor: 'ANCHOR-2', negative: 'n' },
              motion: { shotType: 's', cameraMove: 'm', subjectMotion: 'x', durationSec: 10, easing: 'e', transitionOut: 't', motionPrompt: 'p' },
              citations: [],
              charactersInFrame: [],
              locationId: 'loc2',
            },
            {
              sceneNumber: 1,
              visual: { character: 'c', background: 'bg-1', scene: 's1', styleAnchor: 'ANCHOR-1', negative: 'n' },
              motion: { shotType: 's', cameraMove: 'm', subjectMotion: 'x', durationSec: 10, easing: 'e', transitionOut: 't', motionPrompt: 'p' },
              citations: [],
              charactersInFrame: [],
              locationId: 'loc1',
            },
          ],
        }),
        candidates: [{ finishReason: 'STOP' }],
        usageMetadata: {},
      }),
    },
  };
  const result = await applyVisualDirection(ai, script, RESEARCH, {});
  assert.equal(result.scenes[0].visual.styleAnchor, 'ANCHOR-1', "scene 1's own styleAnchor wins the canonical slot, since it is first by scene number");
  assert.equal(result.scenes[1].visual.styleAnchor, 'ANCHOR-1', 'scene 2 is force-overwritten to match');
});
