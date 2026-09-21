import type { GoogleGenAI } from '@google/genai';
import { TEXT_MODELS } from './gemini';
import { generateJson } from './llm/chain';
import { buildScriptScenesSchema, buildVisualDirectionSchema, productionBibleSchema } from './schemas';
import { isRetryableError } from './quota';
import type { RunJournal } from './runJournal';
import { DEFAULT_CHANNEL_BRAND } from '../shared/brand';

// The scriptwriting pass (generateSceneChunk) and the art-direction pass
// (generateVisualDirectionChunk) generate scenes in batches instead of the
// whole script in one call — see buildScriptScenesSchema's docstring for why
// a long-form script (40-60 scenes) can't just raise a single call's scene
// count instead.
//
// The two passes need DIFFERENT chunk sizes. Measured live 2026-09-19 against
// gemini-3.1-flash-lite/3.6-flash/3.7-flash: a request with this repo's full
// per-scene narrative schema (which includes `infographic` — 3 more nested
// arrays-of-objects on top of `visual`/`motion`) gets a hard 400
// INVALID_ARGUMENT the instant `maxItems` on the scenes array reaches 4,
// reproducible across every model and both min<max ranges and min===max.
// maxItems 3 succeeded every time; maxItems 4 failed every time. Dropping
// just `infographic` from the same schema let maxItems 6 succeed again, so
// it's specifically that field's nesting depth pushing the compiled schema
// over some internal limit, not the array bound alone. The visual-direction
// pass's item schema (sceneNumber/visual/motion/citations, no infographic)
// doesn't carry that field, so it isn't capped the same way — verified live
// at count 5 in production use.
const NARRATIVE_SCENES_PER_CHUNK = 3;
const VISUAL_DIRECTION_SCENES_PER_CHUNK = 6;
// Midpoint of the 8-15s narration guidance given to generateSceneChunk,
// used to translate a target duration into a target scene count.
const AVG_SCENE_DURATION_SEC = 11.5;

/** Translates a target runtime into a scene count. One definition, shared by generation and the coverage report. */
export function sceneTargetFor(targetDurationSec: number): number {
  return Math.max(5, Math.min(80, Math.round(targetDurationSec / AVG_SCENE_DURATION_SEC)));
}

/**
 * Cross-cutting behaviour for one script run.
 *
 * `strict` (opt-in per request, see server/strict.ts): a *retryable* failure — quota
 * or overload — is rethrown instead of being absorbed into a shorter or flatter
 * script, because the caller can simply come back and the journal keeps every
 * finished chunk. Non-retryable failures (a rejected schema, unparseable output)
 * still degrade, and are disclosed in `degraded`.
 *
 * `journal` checkpoints each finished chunk and replays them on resume.
 * `degraded` collects human-readable notes for the response's `generation` block.
 */
export interface ScriptRunOptions {
  strict?: boolean;
  journal?: RunJournal;
  degraded?: string[];
}

/** Mirrors ScriptGeneration in src/types.ts — change both together. */
export interface ScriptGeneration {
  runId?: string;
  resumed?: boolean;
  requestedDurationSec: number;
  requestedScenes: number;
  producedScenes: number;
  producedDurationSec: number;
  /** Every requested scene exists, every scene is art-directed, and the production bible exists. */
  complete: boolean;
  degraded: string[];
}

export function buildGenerationSummary(
  script: any,
  info: { runId?: string; resumed?: boolean; requestedDurationSec: number; degraded: string[] }
): ScriptGeneration {
  const scenes: any[] = Array.isArray(script?.scenes) ? script.scenes : [];
  const requestedScenes = sceneTargetFor(info.requestedDurationSec);
  const producedDurationSec = Math.round(scenes.reduce((n, sc) => n + (Number(sc.durationEst) || 0), 0));
  const artDirected = scenes.length > 0 && scenes.every((sc) => sc.visual && sc.motion);
  const hasBible = Array.isArray(script?.characterBible) && script.characterBible.length > 0 && !!script?.styleGuide && Object.keys(script.styleGuide).length > 0;
  const degraded = [...info.degraded];
  return {
    ...(info.runId ? { runId: info.runId } : {}),
    ...(info.resumed ? { resumed: true } : {}),
    requestedDurationSec: info.requestedDurationSec,
    requestedScenes,
    producedScenes: scenes.length,
    producedDurationSec,
    complete: scenes.length >= requestedScenes && artDirected && hasBible && degraded.length === 0,
    degraded,
  };
}

/**
 * First pass: lock the cast and the look before a single scene is written.
 * Its own call with a small schema, because on the combined script schema both
 * fields were routinely omitted despite being required.
 */
export async function generateProductionBible(
  ai: GoogleGenAI,
  videoPlan: any,
  researchData: any,
  channelBrandName?: string,
  opts: ScriptRunOptions = {}
): Promise<{ characterBible: any[]; styleGuide: any }> {
  const cached = opts.journal?.getBible();
  if (cached) {
    console.log('[Production Bible] resumed from journal');
    return cached;
  }
  const isDocumentary = videoPlan?.tone === 'Deep Dive Documentary';
  const prompt = `You are the production designer for ${isDocumentary ? 'an investigative cybersecurity documentary' : 'a short infotainment video'}.
Show: "${channelBrandName || DEFAULT_CHANNEL_BRAND}"
Story: "${videoPlan?.title || researchData?.topicTitle || 'the story'}"
Tone: ${videoPlan?.tone || 'Witty Tech & Sarcastic'}
Summary: ${researchData?.summary || ''}
Core conflict: ${videoPlan?.coreConflict || ''}

Define the production's visual foundation.

A. "characterBible": 1 to 3 recurring characters who carry this story (e.g. the Narrator-Analyst, the Attacker, the On-Call Engineer). For EACH:
   - "id": short slug, e.g. "analyst"
   - "name", "role": who they are and their narrative function
   - "appearance": IMMUTABLE physical description — apparent age, build, hair, facial structure, skin tone, distinguishing features. Be specific and unambiguous; vagueness is exactly what makes a character morph between shots.
   - "wardrobe": exact clothing, never varying between scenes
   - "palette": the 2-3 colours bound to this character
   - "expressionRange": their emotional register
   - "promptAnchor": ONE dense clause restating appearance + wardrobe + palette, written to be pasted verbatim into any image prompt featuring them. This exact string is the consistency mechanism — it will be reused unchanged in every scene.

B. "styleGuide": "artDirection", "colorPalette", "lighting", "lensAndFilm", "negativePrompt".${
    isDocumentary
      ? `

Documentary visual discipline: favour restrained, evidence-led imagery — real interfaces, terminals, architecture diagrams, source documents. The "negativePrompt" must always exclude: hooded hackers, green Matrix-style code rain, skulls, generic padlock icons, cartoon villains, stock-photo "hacker in a basement" scenes.`
      : ''
  }`;

  try {
    const bible: any = await generateJson(
      ai,
      prompt,
      'You are a precise production designer. Output strictly valid JSON matching the schema.',
      TEXT_MODELS,
      productionBibleSchema
    );
    console.log(`[Production Bible] ${bible?.characterBible?.length || 0} character(s) defined`);
    const result = { characterBible: bible?.characterBible || [], styleGuide: bible?.styleGuide || {} };
    // An empty bible is a degraded result, not progress worth replaying on resume.
    if (result.characterBible.length > 0) await opts.journal?.setBible(result);
    return result;
  } catch (err: any) {
    if (opts.strict && isRetryableError(err)) throw err;
    console.warn('[Production Bible] failed, continuing without a locked cast:', err?.message || err);
    opts.degraded?.push('Production bible failed: no locked cast or style guide, so character/style consistency is not enforced.');
    return { characterBible: [], styleGuide: {} };
  }
}

/**
 * One chunk of the art-direction pass — see applyVisualDirection for why
 * this is called per chunk instead of once over the whole scenes array.
 */
async function generateVisualDirectionChunk(
  ai: GoogleGenAI,
  chunkScenes: any[],
  bible: any[],
  style: any,
  researchData: any
): Promise<any[]> {
  const sourceIds = (researchData?.retrievedSources || [])
    .filter((r: any) => r.ok)
    .map((r: any) => {
      const provenance =
        r.via === 'wayback'
          ? ` [archive snapshot ${r.snapshotDate || 'unknown date'}]`
          : r.via === 'jina'
          ? ' [via reader proxy]'
          : '';
      return `${r.id} = ${r.title} (${r.url})${provenance}`;
    });

  const prompt = `You are the art director and cinematographer for this video. The script is written; your job is the visual layer only.

CHARACTER BIBLE (immutable — reuse promptAnchor strings VERBATIM):
${JSON.stringify(bible, null, 2)}

STYLE GUIDE (every scene inherits this):
${JSON.stringify(style, null, 2)}

AVAILABLE SOURCE IDS for citations:
${sourceIds.length ? sourceIds.join('\n') : '(none retrieved — return [] for every citations field)'}

SCENES (one chunk of a longer script — direct these ${chunkScenes.length} on their own terms; the shared style guide above is what keeps them visually unified with the rest):
${JSON.stringify(
  chunkScenes.map((s: any) => ({
    sceneNumber: s.sceneNumber,
    title: s.title,
    actPhase: s.actPhase,
    narration: s.narration,
    durationEst: s.durationEst,
    cinematography: s.cinematography,
    visualType: s.visualType,
    onScreenText: s.onScreenText,
  })),
  null,
  2
)}

For EVERY scene above return an object with:
- "sceneNumber": matching integer
- "visual":
  - "character": ONLY the people in frame — pose, expression, framing — and the exact promptAnchor of every character present, copied word for word, unchanged. If nobody is in frame write "No characters in frame."
  - "background": ONLY the environment — location, architecture, depth, atmosphere, time of day. Mention no people.
  - "scene": the composed shot — how character and background combine, staging, focal point, foreground/midground/background layering, composition rule.
  - "styleAnchor": the style guide restated compactly. This string MUST be byte-identical across every scene.
  - "negative": what must not appear in this image.
- "motion": "shotType", "cameraMove", "subjectMotion", "durationSec" (match durationEst), "easing", "transitionOut", and "motionPrompt" — one ready-to-paste sentence for an image-to-video model.
- "citations": source ids backing the factual claims in that scene's narration; [] for purely rhetorical scenes. Never invent an id that is not listed above.

Return exactly ${chunkScenes.length} entries, one per scene above, in order.`;

  const direction: any = await generateJson(
    ai,
    prompt,
    'You are a precise art director. Output strictly valid JSON matching the schema. Reuse character promptAnchor strings verbatim so characters stay identical between scenes.',
    TEXT_MODELS,
    buildVisualDirectionSchema(chunkScenes.length)
  );
  return Array.isArray(direction?.scenes) ? direction.scenes : [];
}

/**
 * Second pass over a finished script: produces the layered image prompts and
 * motion direction for every scene, then merges them in. Falls back to leaving
 * the scenes as-is (they still carry visualPrompt) if a chunk's call fails.
 *
 * Chunked over VISUAL_DIRECTION_SCENES_PER_CHUNK scenes at a time rather than
 * one call for the whole script. A long-form script can run 40-60 scenes;
 * asking for visual + motion direction on all of them in a single call is
 * exactly the large-output failure mode this function's schema was already
 * split out to avoid (see buildVisualDirectionSchema's docstring) — chunking
 * keeps each call the same size that was already proven reliable.
 */
export async function applyVisualDirection(ai: GoogleGenAI, script: any, researchData: any, opts: ScriptRunOptions = {}): Promise<any> {
  const scenes: any[] = Array.isArray(script?.scenes) ? script.scenes : [];
  if (scenes.length === 0) return script;

  const bible = script.characterBible || [];
  const style = script.styleGuide || {};

  const allDirections: any[] = [];
  const numChunks = Math.ceil(scenes.length / VISUAL_DIRECTION_SCENES_PER_CHUNK);
  for (let i = 0; i < scenes.length; i += VISUAL_DIRECTION_SCENES_PER_CHUNK) {
    const chunk = scenes.slice(i, i + VISUAL_DIRECTION_SCENES_PER_CHUNK);
    const chunkIndex = Math.floor(i / VISUAL_DIRECTION_SCENES_PER_CHUNK);
    const firstScene = Number(chunk[0]?.sceneNumber);
    const cached = opts.journal?.getArtChunk(chunkIndex, firstScene);
    if (cached) {
      console.log(`[Art Director] chunk ${chunkIndex + 1}/${numChunks} resumed from journal`);
      allDirections.push(...cached);
      continue;
    }
    try {
      const chunkDirections = await generateVisualDirectionChunk(ai, chunk, bible, style, researchData);
      allDirections.push(...chunkDirections);
      await opts.journal?.setArtChunk(chunkIndex, firstScene, chunkDirections);
    } catch (err: any) {
      if (opts.strict && isRetryableError(err)) throw err;
      console.warn(
        `[Art Director] chunk ${chunkIndex + 1}/${numChunks} failed, those scenes keep flat prompts:`,
        err?.message || err
      );
      opts.degraded?.push(
        `Art direction chunk ${chunkIndex + 1}/${numChunks} failed: scenes ${firstScene}-${firstScene + chunk.length - 1} have flat prompts only (no layered visual/motion).`
      );
    }
  }

  const byNumber = new Map<number, any>();
  for (const d of allDirections) byNumber.set(Number(d.sceneNumber), d);

  // A single styleAnchor wins across the whole script even if a chunk varied
  // it — the first one produced by any chunk, not just the first chunk,
  // since an earlier chunk's call may have failed entirely.
  const canonicalAnchor = allDirections.map((d: any) => d?.visual?.styleAnchor).find(Boolean);

  script.scenes = scenes.map((s: any) => {
    const d = byNumber.get(Number(s.sceneNumber));
    if (!d) return s;
    const visual = d.visual ? { ...d.visual, styleAnchor: canonicalAnchor || d.visual.styleAnchor } : undefined;
    return {
      ...s,
      ...(visual ? { visual } : {}),
      ...(d.motion ? { motion: d.motion } : {}),
      ...(Array.isArray(d.citations) ? { citations: d.citations } : {}),
      // Keep the flat prompt consistent with the layered one.
      visualPrompt: visual ? [visual.scene, visual.styleAnchor].filter(Boolean).join(' ') : s.visualPrompt,
    };
  });
  const covered = script.scenes.filter((s: any) => s.visual).length;
  console.log(`[Art Director] visual direction applied to ${covered}/${scenes.length} scenes across ${numChunks} chunk(s)`);
  return script;
}

/**
 * One chunk of the scriptwriting pass — see generateSceneChunks for why a
 * long-form script is written in batches instead of one call.
 *
 * `videoPlan.tone === 'Deep Dive Documentary'` gets a different writer
 * persona and narration-style instruction than everything else. This is the
 * fix for a gap CyberPipe's CLAUDE.md documented: passing a custom
 * targetTone string to /api/plan couldn't change actual prose, because the
 * persona/style instructions here were hardcoded to an "electrifying, witty,
 * infotainment" voice regardless of tone. Every other tone value keeps the
 * original behavior unchanged.
 */
async function generateSceneChunk(
  ai: GoogleGenAI,
  videoPlan: any,
  researchData: any,
  productionBible: { characterBible: any[]; styleGuide: any },
  channelBrandName: string | undefined,
  sceneCount: number,
  sceneNumberOffset: number,
  priorScenesContext: string,
  isLastChunk: boolean
): Promise<any[]> {
  const isDocumentaryTone = videoPlan?.tone === 'Deep Dive Documentary';
  const persona = isDocumentaryTone
    ? `You are an investigative documentary scriptwriter and creative director working in the style of authoritative long-form cybersecurity journalism (Bloomberg cyber docs, Darknet Diaries' narrative pacing, a Netflix true-crime breakdown) — not an infotainment creator.`
    : `You are an elite, award-winning infotainment video scriptwriter & creative director for top-tier YouTube Shorts, TikTok, and video essays (in the style of Veritasium, Fireship, and ColdFusion).`;
  const narrationStyle = isDocumentaryTone
    ? `Must sound authoritative, investigative, and slightly urgent — precise, measured, architecturally detailed. No fearmongering, no clickbait, no "your team is panicking" hype. Let the facts carry the weight.`
    : `Must sound natural, electrifying, conversational, witty, and incisive. Use rhetorical questions, crisp pacing, contrast, and clever technical humor directly about this story.`;
  const systemInstruction = isDocumentaryTone
    ? 'You write precise, authoritative cybersecurity investigative narration with cinematic visual cues. Output valid JSON strictly grounded in the topic. No hype, no fearmongering, no clickbait.'
    : 'You write the sharpest, most viral infotainment scripts on the internet with cinematic visual cues and brilliant narration. Output valid JSON strictly grounded in the topic.';

  const prompt = `${persona}
Brand Identity / Show Name: "${channelBrandName || DEFAULT_CHANNEL_BRAND}"

Video Blueprint Plan:
${JSON.stringify(videoPlan, null, 2)}

Original Research Dossier:
${JSON.stringify(researchData || {}, null, 2)}

Production Bible (cast and look are already locked — write scenes that fit them):
${JSON.stringify(productionBible, null, 2)}

CRITICAL REQUIREMENT:
The script narration, cinematography, visual prompts, and onScreenText for EVERY SINGLE SCENE must be 100% focused on this specific topic: "${videoPlan.title || researchData?.topicTitle || 'the story'}".
Do NOT output generic text about unrelated topics.

FACTUAL DISCIPLINE: every figure, date, CVE id, version number and quoted comment in the narration must trace to the research dossier. The dossier lists what was actually retrieved under "retrievedSources" and per-fact attribution under "factCitations". Do not introduce specifics the dossier does not contain.

The production bible and style guide are already fixed (given above). Write to them.

${priorScenesContext}

This is one chunk of a longer script. Write EXACTLY ${sceneCount} new scenes continuing directly on — do not repeat, re-hook, or re-introduce the topic if this isn't the opening chunk. ${
    isLastChunk
      ? isDocumentaryTone
        ? 'This IS the final chunk of the script — the last scene must land the conclusion and the remediation takeaway, then close with one calm line. No "like / subscribe / comment" calls to action.'
        : 'This IS the final chunk of the script — the last scene must land the conclusion, remediation takeaway, and call to action.'
      : 'This is NOT the final chunk — do not wrap up or deliver a call to action yet.'
  }

For EACH scene, you MUST craft:
1. "sceneNumber": integer index, starting at ${sceneNumberOffset + 1}
2. "title": Punchy scene title
3. "actPhase": a short label for this beat's narrative function. ${
    isDocumentaryTone
      ? 'Use plain labels from this set — "Hook", "Context", "Technical Breakdown", "Impact", "The Fix", "Conclusion" — and reuse the same label for every scene in a phase: they become the video\'s chapter titles and decide where the mid-roll ads can sit.'
      : '(e.g. "Hook", "Technical Breakdown", "Community Reaction", "The Fix", "Conclusion & CTA")'
  }
4. "narration": Spoken-word voiceover script. ${narrationStyle} (approx 22-38 words per scene).
5. "durationEst": Realistic speaking duration in seconds (8 to 15s).
6. "cinematography": Precise visual director cues (camera framing e.g., 'Slow dynamic push-in on macro CRT monitor with anamorphic lens flare and volumetric neon haze').
7. "visualPrompt": An exquisitely detailed single-string image prompt. Cinematic, atmospheric, stylish. This is the flat fallback prompt — it must equal the concatenation of visual.scene + visual.styleAnchor below.
8. "visualType": ${
    isDocumentaryTone
      ? 'One of "headline", "terminal", "diagram", "character". Use "terminal", "diagram" or "headline" (real interfaces, architecture, source captures) for at least half the scenes and "character" sparingly; never use "meme" or "cyberpunk".'
      : 'One of "headline", "terminal", "meme", "cyberpunk", "diagram", "character"'
  }
9. "onScreenText": 3 to 5 high-impact kinetic typography words for the viewer's eye.
10. "soundEffect": Specific audio/SFX cue (e.g. "[SFX: Deep sub-bass riser + rapid keyboard clatter]").
11. "retentionNote": Psychological reason why this beat prevents viewer dropoff.
12. "infographic": A structured high-tech infographic object detailing technical facts, architecture steps, CVSS scorecards, terminal commands, or benchmark metrics:
    {
      "type": "architecture" | "threat_scorecard" | "terminal_payload" | "benchmark_chart" | "sentiment_gauge",
      "title": "Clear uppercase headline for the diagram or scorecard",
      "badge": "Short badge tag (e.g. CVSS 9.8 or EXPLOIT CHAIN)",
      "badgeColor": "#f97316" or "#ef4444" or "#22c55e",
      "summary": "1 sentence technical summary of this visual infographic",
      "steps": [{"label": "Step 1", "detail": "...", "status": "active" | "vulnerable" | "secure"}],
      "metrics": [{"label": "Metric", "value": "9.8", "subtext": "Critical", "color": "#ef4444"}]
    }

Return strictly a JSON object: { "scenes": [ ...exactly ${sceneCount} scene objects as described above... ] }`;

  // Exact min===max, not a +1 buffer: this schema includes `infographic`,
  // and maxItems 4 hard-fails regardless of minItems (see
  // NARRATIVE_SCENES_PER_CHUNK's comment) — a "helpful" +1 here would have
  // silently turned a 3-scene chunk's maxItems into 4 and broken it.
  const result = await generateJson<{ scenes: any[] }>(
    ai,
    prompt,
    systemInstruction,
    TEXT_MODELS,
    buildScriptScenesSchema(sceneCount, sceneCount)
  );
  return Array.isArray(result?.scenes) ? result.scenes : [];
}

/**
 * Generates a full script's scenes in chunks of NARRATIVE_SCENES_PER_CHUNK
 * rather than one call for the whole target duration.
 *
 * videoPlan.targetDurationSec used to be decorative — /api/plan always
 * hardcoded 60, and even a caller-supplied value had nowhere to go, because
 * the old single-call scriptSchema capped scenes at minItems:5/maxItems:6
 * (~90s of narration, ever). That's fixed on the /api/plan side (targetDurationSec
 * is now a real request parameter), and fixed here: this translates a target
 * duration into a target scene count and writes it in batches the size
 * already proven reliable, carrying the last few scenes forward as context
 * each time so the narrative stays continuous across calls.
 *
 * Partial results are kept on a chunk failure (a 6-minute script beats none)
 * — the caller falls back to generateFallbackScript only if zero scenes come
 * back at all.
 */
export async function generateSceneChunks(
  ai: GoogleGenAI,
  videoPlan: any,
  researchData: any,
  productionBible: { characterBible: any[]; styleGuide: any },
  channelBrandName?: string,
  opts: ScriptRunOptions = {}
): Promise<any[]> {
  const targetDurationSec = Number(videoPlan?.targetDurationSec) || 60;
  const totalScenesTarget = sceneTargetFor(targetDurationSec);
  const numChunks = Math.max(1, Math.ceil(totalScenesTarget / NARRATIVE_SCENES_PER_CHUNK));

  const allScenes: any[] = [];
  let remaining = totalScenesTarget;

  for (let chunkIndex = 0; chunkIndex < numChunks; chunkIndex++) {
    const chunksLeft = numChunks - chunkIndex;
    const thisChunkCount = Math.max(1, Math.round(remaining / chunksLeft));
    remaining -= thisChunkCount;

    const priorScenesContext =
      allScenes.length === 0
        ? '(This is the opening chunk of the script — write the hook first.)'
        : 'SCENES ALREADY WRITTEN (the most recent ones — continue directly on from here, do not repeat or re-hook):\n' +
          allScenes
            .slice(-3)
            .map((s: any) => `  #${s.sceneNumber} "${s.title}": ${s.narration}`)
            .join('\n');

    try {
      let chunkScenes = opts.journal?.getNarrativeChunk(chunkIndex);
      if (chunkScenes) {
        console.log(`[Script Agent] scene chunk ${chunkIndex + 1}/${numChunks} resumed from journal`);
      } else {
        chunkScenes = await generateSceneChunk(
          ai,
          videoPlan,
          researchData,
          productionBible,
          channelBrandName,
          thisChunkCount,
          allScenes.length,
          priorScenesContext,
          chunkIndex === numChunks - 1
        );
        await opts.journal?.setNarrativeChunk(chunkIndex, chunkScenes);
      }
      for (const s of chunkScenes) {
        allScenes.push({ ...s, sceneNumber: allScenes.length + 1 });
      }
    } catch (err: any) {
      if (opts.strict && isRetryableError(err)) throw err;
      console.warn(
        `[Script Agent] scene chunk ${chunkIndex + 1}/${numChunks} failed, stopping with ${allScenes.length} scene(s) so far:`,
        err?.message || err
      );
      opts.degraded?.push(
        `Narrative chunk ${chunkIndex + 1}/${numChunks} failed: script stops at ${allScenes.length}/${totalScenesTarget} scenes.`
      );
      break;
    }
  }
  console.log(
    `[Script Agent] generated ${allScenes.length}/${totalScenesTarget} scenes across ${numChunks} chunk(s) for a ${targetDurationSec}s target`
  );
  return allScenes;
}
