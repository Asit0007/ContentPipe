import type { GoogleGenAI } from '@google/genai';
import { TEXT_MODELS } from './gemini';
import { generateJson } from './llm/chain';
import { buildScriptScenesSchema, buildVisualDirectionSchema, productionBibleSchema } from './schemas';
import { isRetryableError } from './quota';
import type { RunJournal } from './runJournal';
import { DEFAULT_CHANNEL_BRAND } from '../shared/brand';
import { analystSceneNumbers, speakerFor } from '../shared/speakers';
import { isDocumentaryTone } from '../shared/tone';
import { resolveTopicProfile } from '../shared/topicProfile';

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
// What the art-direction prompt tells the model to write into visual.character when no one
// is in frame — filtered back out when building the flat visualPrompt (see applyVisualDirection),
// so an empty-cast scene's fallback image prompt doesn't literally ask for the words "No characters
// in frame." to appear in the picture.
const NO_CHARACTERS_SENTINEL = 'No characters in frame.';
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
  /** Free-text topic domain (shared/topicProfile.ts). Omitted or the default reproduces the historical cybersecurity prompts exactly. */
  topicDomain?: string;
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
  const isDocumentary = isDocumentaryTone(videoPlan?.tone);
  const profile = resolveTopicProfile(opts.topicDomain);
  const prompt = `You are the production designer for ${isDocumentary ? profile.bibleShowDocumentary : profile.bibleShowInfotainment}.
Show: "${channelBrandName || DEFAULT_CHANNEL_BRAND}"
Story: "${videoPlan?.title || researchData?.topicTitle || 'the story'}"
Tone: ${videoPlan?.tone || 'Witty Tech & Sarcastic'}
Summary: ${researchData?.summary || ''}
Core conflict: ${videoPlan?.coreConflict || ''}

Define the production's visual foundation.

A. "characterBible": 1 to 3 recurring characters who carry this story ${profile.bibleCharacterExampleNote}. For EACH:
   - "id": short slug, e.g. "analyst"
   - "name", "role": who they are and their narrative function
   - "appearance": IMMUTABLE physical description — apparent age, build, hair, facial structure, skin tone, distinguishing features. Be specific and unambiguous; vagueness is exactly what makes a character morph between shots.
   - "wardrobe": exact clothing, never varying between scenes
   - "palette": the 2-3 colours bound to this character
   - "expressionRange": their emotional register
   - "promptAnchor": ONE dense clause restating appearance + wardrobe + palette, written to be pasted verbatim into any image prompt featuring them. This exact string is the consistency mechanism — it will be reused unchanged in every scene.

B. "styleGuide": "artDirection", "colorPalette", "lighting", "lensAndFilm", "negativePrompt".${isDocumentary ? profile.bibleDocumentaryVisualDiscipline : ''}`;

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
  researchData: any,
  priorVisualContext: string
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

${priorVisualContext}

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
  - "character": ONLY the people in frame — pose, expression, framing — and the exact promptAnchor of every character present, copied word for word, unchanged. If nobody is in frame write "${NO_CHARACTERS_SENTINEL}"
  - "background": ONLY the environment — the place the camera is in: location, architecture, depth, atmosphere, time of day. Mention no people, and no composition, panel split, overlay or on-screen text (those belong in "scene"). If this scene returns to a place already established in PRIOR VISUAL CONTEXT above, match that wording as closely as you can (the code enforces it verbatim regardless — matching now avoids a jarring rewrite when it does).
  - "scene": the composed shot — how character and background combine, staging, focal point, foreground/midground/background layering, composition rule.
  - "styleAnchor": the style guide restated compactly. This string MUST be byte-identical across every scene.
  - "negative": what must not appear in this image.
- "motion": "shotType", "cameraMove", "subjectMotion", "durationSec" (match durationEst), "easing", "transitionOut", and "motionPrompt" — one ready-to-paste sentence for an image-to-video model. Vary "shotType" and "cameraMove" across this chunk and against PRIOR VISUAL CONTEXT's recent shots below — repeating the same combination scene after scene reads as one long take, not a cut cadence.
- "citations": source ids backing the factual claims in that scene's narration; [] for purely rhetorical scenes. Never invent an id that is not listed above.
- "charactersInFrame": the bible "id" of every character actually in frame in this scene (their promptAnchor is already folded into "character" above) — [] if nobody is in frame. Only use ids from CHARACTER BIBLE above; never invent one.
- "locationId": a short, lowercase, hyphenated slug for the PLACE this scene is set in (e.g. "server-room", "conference-hallway"), reused byte-for-byte only when the story genuinely goes back to that place. A diagram, timeline or data graph is not a place, so set it in one: a whiteboard in a briefing room, a wall display in a control room, a printed blueprint on a desk, a tablet in someone's hand, each with its own slug, never a generic void. Viewers watch this as a sequence of pictures, and one picture behind most of the video reads as a slideshow, so give each new beat a new environment: one place for at most 2 scenes in a row, and for no more than about a quarter of all the scenes. Even a one-off location that never recurs gets its own slug; never leave this blank.

Return exactly ${chunkScenes.length} entries, one per scene above, in order.`;

  const direction: any = await generateJson(
    ai,
    prompt,
    'You are a precise art director. Output strictly valid JSON matching the schema. Reuse character promptAnchor strings verbatim so characters stay identical between scenes, and reuse locationId/background wording verbatim for a place you have already visited.',
    TEXT_MODELS,
    buildVisualDirectionSchema(chunkScenes.length)
  );
  return Array.isArray(direction?.scenes) ? direction.scenes : [];
}

/** Empty/whitespace-only ids are treated as "not provided" so an old journaled chunk (before this
 *  field existed) or a model that skipped it degrades to pre-existing behavior instead of throwing. */
function normalizeLocationId(id: unknown): string | undefined {
  const t = String(id || '').trim().toLowerCase();
  return t || undefined;
}

/**
 * Gap "promptAnchor reuse" (CLAUDE.md "Visual consistency"), closed the same shape as styleAnchor's
 * existing enforcement below: don't trust the model to have pasted a character's promptAnchor
 * verbatim into `visual.character` — check, and splice it in if it didn't. Prepended rather than
 * appended: the anchor is the character's fixed identity, and the rest of `character` is this
 * scene's pose/expression on top of it, so leading with the anchor keeps that framing.
 */
function enforcePromptAnchors(characterText: string, characterIds: string[], bible: any[], sceneNumber: number): string {
  let result = characterText;
  for (const id of characterIds) {
    const entry = bible.find((c: any) => c?.id === id);
    const anchor = String(entry?.promptAnchor || '').trim();
    if (!anchor) {
      // The model listed an id that isn't in the bible it was given — nothing to enforce.
      console.warn(`[Art Director] scene ${sceneNumber}: charactersInFrame referenced unknown character id "${id}"`);
      continue;
    }
    // Compared in normalized form: a model that writes a plain hyphen for the bible's non-breaking one, or a straight
    // apostrophe for a curly one, has still copied the anchor — prepending it again put the same description into
    // the image prompt twice (live run, scene 6).
    if (!normalizeForAnchorMatch(result).includes(normalizeForAnchorMatch(anchor))) result = `${anchor} ${result}`.trim();
  }
  return result;
}

/**
 * The form in which a character description is compared with its anchor: Unicode-normalised, every dash and quote
 * variant folded to ASCII, whitespace collapsed, case ignored. Models routinely emit non-breaking hyphens (U+2011)
 * and curly apostrophes in the bible's anchor and plain ones when they copy it, so an exact substring test called
 * a faithful copy a miss. Case is ignored because a lower-cased copy is still the same description.
 */
export function normalizeForAnchorMatch(text: string): string {
  return String(text ?? '')
    .normalize('NFKC')
    .replace(/[‐-―−]/g, '-')
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

const PRIOR_SHOT_WINDOW = 6;
/** A place used in this many scenes is shown to later chunks as spent. */
const PLACE_USED_UP_AT = 3;

/**
 * Gaps "recurring backgrounds" and "cut/shot rhythm" (CLAUDE.md "Visual consistency"): gives each
 * chunk after the first visibility into every earlier chunk, the same shape as the narrative pass's
 * existing priorScenesContext (generateSceneChunk). Built from `processedScenes` (the original
 * scenes already sent to earlier chunks, which carry visualType) joined against `directionsSoFar`
 * (their art-direction results, which carry motion/visual/locationId) by sceneNumber.
 */
function buildPriorVisualContext(processedScenes: any[], directionsSoFar: any[], isDocTone: boolean): string {
  if (processedScenes.length === 0) {
    return '(This is the opening chunk of the art-direction pass — no locations or shot rhythm established yet.)';
  }
  const byNumber = new Map<number, any>();
  for (const d of directionsSoFar) byNumber.set(Number(d.sceneNumber), d);

  const visualTypeCounts: Record<string, number> = {};
  const locationsSeen = new Map<string, string>(); // locationId -> canonical background text
  const locationScenes = new Map<string, number[]>(); // locationId -> the scenes set there so far
  const recentShots: string[] = [];

  for (const s of processedScenes) {
    if (s.visualType) visualTypeCounts[s.visualType] = (visualTypeCounts[s.visualType] || 0) + 1;
    const d = byNumber.get(Number(s.sceneNumber));
    if (!d) continue;
    const loc = normalizeLocationId(d.locationId);
    if (loc) locationScenes.set(loc, [...(locationScenes.get(loc) || []), Number(s.sceneNumber)]);
    if (loc && d.visual?.background && !locationsSeen.has(loc)) locationsSeen.set(loc, d.visual.background);
    if (d.motion?.shotType || d.motion?.cameraMove) {
      recentShots.push(`#${s.sceneNumber} ${d.motion.shotType || '?'}/${d.motion.cameraMove || '?'}`);
    }
  }

  const tally = Object.entries(visualTypeCounts).map(([k, v]) => `${k}=${v}`).join(', ') || 'none yet';
  // How often each place has been used, so a later chunk can see that one is already spent. Without it a live run
  // set 7 of 10 scenes in the same "digital void" (chunk 2 saw the place and reused it, unaware it was the fourth time).
  const usage = (id: string) => {
    const at = locationScenes.get(id) ?? [];
    return at.length ? ` (used in ${at.length} scene${at.length === 1 ? '' : 's'} so far: ${at.map((n) => `#${n}`).join(', ')})` : '';
  };
  const locationsBlock = locationsSeen.size
    ? [...locationsSeen.entries()].map(([id, bg]) => `  - "${id}": ${bg}${usage(id)}`).join('\n')
    : '  (none established yet)';
  const usedUp = [...locationScenes.entries()].filter(([, at]) => at.length >= PLACE_USED_UP_AT).map(([id]) => `"${id}"`);
  const usedUpLine = usedUp.length
    ? `\n- Used in ${PLACE_USED_UP_AT} or more scenes already, so treat as used up unless the story truly goes back there: ${usedUp.join(', ')}. Set the next scenes somewhere new.`
    : '';
  const shotsBlock = recentShots.slice(-PRIOR_SHOT_WINDOW).join('; ') || '(none yet)';
  const docHint = isDocTone
    ? ` This is a documentary script: at least half of ALL scenes should end up "terminal", "diagram" or "headline" — lean into whichever the tally above is short on.`
    : '';

  return `PRIOR VISUAL CONTEXT (from earlier chunks of this same script — use it, don't repeat it):
- visualType tally so far: ${tally}.${docHint}
- Locations already established — if a scene below returns to one of these places, reuse its exact locationId:
${locationsBlock}${usedUpLine}
- Last ${PRIOR_SHOT_WINDOW} scenes' shot type / camera move, so you can vary rhythm rather than repeat it: ${shotsBlock}`;
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
  // script.tonePacing is set by server.ts from videoPlan.tone before this runs (both the real and
  // fallback-script paths) — applyVisualDirection doesn't take videoPlan directly, so this is the
  // one signal it has for the documentary shot-rhythm hint in buildPriorVisualContext.
  const isDocTone = isDocumentaryTone(script?.tonePacing);

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
    // Built AFTER the cache-check `continue`, so a resumed chunk contributes its state to the next
    // not-yet-generated chunk's context without needing to be regenerated itself.
    const priorVisualContext = buildPriorVisualContext(scenes.slice(0, i), allDirections, isDocTone);
    try {
      const chunkDirections = await generateVisualDirectionChunk(ai, chunk, bible, style, researchData, priorVisualContext);
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
  // Walk `scenes`' original order rather than allDirections' raw push order: chunks are processed
  // sequentially so chunk order is already correct, but nothing guarantees a chunk's own response
  // preserves the requested scene order within itself. This makes "first occurrence" unambiguous
  // for the canonical values below.
  const orderedDirections = scenes.map((s: any) => byNumber.get(Number(s.sceneNumber))).filter(Boolean);

  // A single styleAnchor wins across the whole script even if a chunk varied
  // it — the first one produced by any scene in script order, since an
  // earlier chunk's call may have failed entirely.
  const canonicalAnchor = orderedDirections.map((d: any) => d?.visual?.styleAnchor).find(Boolean);

  // Recurring backgrounds: first occurrence of a locationId sets the canonical background text;
  // every later scene claiming the same locationId is force-overwritten to match it, exactly like
  // styleAnchor above.
  const canonicalBackgroundByLocation = new Map<string, string>();
  for (const d of orderedDirections) {
    const loc = normalizeLocationId(d.locationId);
    const bg = d?.visual?.background;
    if (loc && bg && !canonicalBackgroundByLocation.has(loc)) canonicalBackgroundByLocation.set(loc, bg);
  }

  script.scenes = scenes.map((s: any) => {
    const d = byNumber.get(Number(s.sceneNumber));
    if (!d) return s;
    const loc = normalizeLocationId(d.locationId);
    const canonicalBackground = loc ? canonicalBackgroundByLocation.get(loc) : undefined;
    // promptAnchor reuse: force-include every listed character's anchor, regardless of what the model did.
    const character =
      d.visual?.character && d.visual.character !== NO_CHARACTERS_SENTINEL && Array.isArray(d.charactersInFrame) && d.charactersInFrame.length
        ? enforcePromptAnchors(d.visual.character, d.charactersInFrame, bible, s.sceneNumber)
        : d.visual?.character;
    const visual = d.visual
      ? { ...d.visual, character, background: canonicalBackground || d.visual.background, styleAnchor: canonicalAnchor || d.visual.styleAnchor }
      : undefined;
    return {
      ...s,
      ...(visual ? { visual } : {}),
      ...(d.motion ? { motion: d.motion } : {}),
      ...(Array.isArray(d.citations) ? { citations: d.citations } : {}),
      ...(loc ? { locationId: loc } : {}),
      ...(Array.isArray(d.charactersInFrame) ? { charactersInFrame: d.charactersInFrame } : {}),
      // Keep the flat prompt consistent with the layered one: subject, then setting, then
      // composition, then style — the same information the structured `visual` object carries,
      // just concatenated. Previously this dropped `character` and `background` entirely, which
      // is where a character's verbatim promptAnchor and the location description live — any
      // consumer reading only `visualPrompt` (CLAUDE.md calls it "the always-present fallback")
      // got none of the consistency the production bible and styleAnchor enforcement exist for.
      // `negative` stays out on purpose: it belongs in an image API's separate negative-prompt
      // field, not concatenated into the positive prompt.
      visualPrompt: visual
        ? [visual.character, visual.background, visual.scene, visual.styleAnchor]
            .filter((part) => part && part !== NO_CHARACTERS_SENTINEL)
            .join(' ')
        : s.visualPrompt,
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
  isLastChunk: boolean,
  totalScenes: number,
  topicDomain?: string
): Promise<any[]> {
  const isDocTone = isDocumentaryTone(videoPlan?.tone);
  const profile = resolveTopicProfile(topicDomain);
  const persona = isDocTone ? profile.writerPersonaDocumentary : profile.writerPersonaInfotainment;
  const narrationStyle = isDocTone ? profile.writerNarrationStyleDocumentary : profile.writerNarrationStyleInfotainment;
  const systemInstruction = isDocTone ? profile.writerSystemInstructionDocumentary : profile.writerSystemInstructionInfotainment;

  // Which scenes of THIS chunk the second voice reads is decided in code (shared/speakers.ts), not by the
  // model: it sees only 3 scenes at a time and cannot judge how often the analyst has spoken.
  const analystScenes = analystSceneNumbers(sceneNumberOffset + 1, sceneCount, totalScenes);
  const plural = analystScenes.length > 1;
  const voices = analystScenes.length
    ? `VOICES: two voices read this video aloud — the NARRATOR, who tells the story, and the ANALYST, a second voice who briefly reacts between narrator sections.
In this chunk, scene${plural ? 's' : ''} ${analystScenes.map((n) => `#${n}`).join(', ')} ${plural ? 'are' : 'is'} the ANALYST's. Every other scene is the narrator's.
An ANALYST scene is a reaction, not more narration: one or two short sentences (12-25 words), in the first person, from a practitioner who has just listened to the narrator. It says what the previous scene means in practice — what a defender should check or change, or the question a careful engineer would now ask — in plain, specific terms rather than alarm. A different voice reads it, so it must sound like a person answering the previous scene, not continuing it. It adds no new facts and no claim bigger than the evidence: any figure, name, date, id or scope it mentions must already be in the scene before it or in the dossier, and it is never a quotation. Use the narration style described below, and give it the same "actPhase" as the scene before it.`
    : `VOICES: two voices read this video aloud — the NARRATOR, who tells the story, and occasionally an ANALYST who reacts between narrator sections. Every scene in this chunk is the narrator's.`;

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

FACTUAL DISCIPLINE: every figure, date, version number and quoted comment in the narration must trace to the research dossier. The dossier lists what was actually retrieved under "retrievedSources" and per-fact attribution under "factCitations". Do not introduce specifics the dossier does not contain.

${profile.disclosureDiscipline}

CLAIMS THE DOSSIER CANNOT BACK: how big it was and what it did are claims too, not just figures. Say only what "keyFacts" state. The dossier's "researchGaps" lists what the sources never established — typically how many people or systems were affected, whether it was actually abused, and what it cost. Where a gap covers it, narrate what is known instead (what it made possible, what it exposed, for how long) and phrase it as what was possible, not what happened: "this made it possible to read private records", not "private records were taken". Leave a gap unfilled: no size (a number, or "millions", "countless", "the sheer scale") and no consequence the dossier does not report (a breach, a theft, a panic, every user affected). A gap that reports sources disagreeing means the point is unsettled, so say that or leave it out. This holds for every scene, the analyst's included, and for onScreenText and the infographic, because whatever is said or shown on camera is a claim the channel makes.

SCENE-TO-SCENE LOGIC: each scene must connect to the next by a stated causal or curiosity link — this fact causes that consequence, this question is what the next scene answers, this action creates the constraint the next scene has to resolve — never just the next fact in a list. If a scene doesn't cause, answer, or complicate what comes right after it, rewrite it so it does.

The production bible and style guide are already fixed (given above). Write to them.

${voices}

${priorScenesContext}

This is one chunk of a longer script. Write EXACTLY ${sceneCount} new scenes continuing directly on — do not repeat, re-hook, or re-introduce the topic if this isn't the opening chunk. ${
    isLastChunk
      ? isDocTone
        ? 'This IS the final chunk of the script — the last scene must land the conclusion and the remediation takeaway, then close with one calm line. No "like / subscribe / comment" calls to action.'
        : 'This IS the final chunk of the script — the last scene must land the conclusion, remediation takeaway, and call to action.'
      : 'This is NOT the final chunk — do not wrap up or deliver a call to action yet.'
  }

For EACH scene, you MUST craft:
1. "sceneNumber": integer index, starting at ${sceneNumberOffset + 1}
2. "title": Punchy scene title
3. "actPhase": a short label for this beat's narrative function. ${
    isDocTone ? profile.actPhaseLabelsDocumentary : profile.actPhaseLabelsInfotainmentHint
  }
4. "narration": Spoken-word voiceover script. ${narrationStyle} (approx 22-38 words per scene${analystScenes.length ? '; analyst scenes follow VOICES above' : ''}).
5. "durationEst": Realistic speaking duration in seconds (8 to 15s${analystScenes.length ? '; 5 to 9s for an analyst scene' : ''}).
6. "cinematography": Precise visual director cues (camera framing e.g., 'Slow dynamic push-in on macro CRT monitor with anamorphic lens flare and volumetric neon haze').
7. "visualPrompt": An exquisitely detailed single-string image prompt. Cinematic, atmospheric, stylish. This is the flat fallback prompt, used only if art direction fails for this scene — once art direction succeeds it is overwritten with the concatenation of visual.character + visual.background + visual.scene + visual.styleAnchor below, so write this as your own best single-string guess at that same thing.
8. "visualType": ${isDocTone ? profile.visualTypeGuidanceDocumentary : profile.visualTypeGuidanceInfotainment}
9. "onScreenText": 3 to 5 high-impact kinetic typography words for the viewer's eye.
10. "soundEffect": Specific audio/SFX cue (e.g. "[SFX: Deep sub-bass riser + rapid keyboard clatter]").
11. "retentionNote": Psychological reason why this beat prevents viewer dropoff.
12. "infographic": A structured infographic object ${profile.infographicPurposeClause}:
    {
      "type": "architecture" | "threat_scorecard" | "terminal_payload" | "benchmark_chart" | "sentiment_gauge",
      "title": "Clear uppercase headline for the diagram or scorecard",
      "badge": "Short badge tag naming the consequence (e.g. ${profile.infographicBadgeExample})",
      "badgeColor": "#f97316" or "#ef4444" or "#22c55e",
      "summary": "1 sentence plain-language summary of this visual infographic",
      "steps": [{"label": "Step 1", "detail": "...", "status": "active" | "vulnerable" | "secure"}],
      "metrics": [{"label": "What it measures", "value": "a figure or fact from the dossier", "subtext": "what that meant for the people affected", "color": "#ef4444"}]
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
            .map((s: any) => `  #${s.sceneNumber} [${String(s.speaker || 'narrator').toUpperCase()}] "${s.title}": ${s.narration}`)
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
          chunkIndex === numChunks - 1,
          totalScenesTarget,
          opts.topicDomain
        );
        await opts.journal?.setNarrativeChunk(chunkIndex, chunkScenes);
      }
      for (const s of chunkScenes) {
        const sceneNumber = allScenes.length + 1;
        const speaker = speakerFor(sceneNumber, totalScenesTarget);
        // A reaction belongs to the phase it interrupts: its own actPhase label would split that chapter in two.
        const actPhase = speaker === 'analyst' ? allScenes[allScenes.length - 1]?.actPhase ?? s.actPhase : s.actPhase;
        allScenes.push({ ...s, sceneNumber, speaker, actPhase });
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
