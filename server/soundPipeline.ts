import type { GoogleGenAI } from '@google/genai';
import { TEXT_MODELS } from './gemini';
import { generateJson } from './llm/chain';
import { withModelTask } from './llm/usage';
import { isRetryableError } from './quota';
import { buildScorePlanSchema, buildSoundDirectionSchema } from './schemas';
import { normalizeForAnchorMatch, type ScriptRunOptions } from './scriptPipeline';
import { DEFAULT_CHANNEL_BRAND } from '../shared/brand';
import { isDocumentaryTone } from '../shared/tone';
import {
  AUDIO_BRIDGES,
  MUSIC_ENTRIES,
  MUSIC_EXITS,
  MUSIC_ROLES,
  normalizeTransition,
  type AudioBridge,
  type MusicCue,
  type SceneSound,
  type Transition,
} from '../shared/sound';

/**
 * The sound & edit pass (2026-09-26): a fourth pass after art direction that writes the music plan, the sound
 * effects, the silences and the cuts — what a sound designer and an editor decide. Built like applyVisualDirection:
 * small flat schemas, chunks, a summary of earlier chunks passed forward, and then code verifies or forces what
 * matters instead of trusting the prose.
 *
 * Why it exists: before it, the narrative pass wrote one `soundEffect` per scene as an afterthought (a live 10-scene
 * run stacked 2-3 effects on every scene) and the art pass wrote a free-text `transitionOut` (nine different names in
 * ten scenes, no reason behind any). There was no music at all.
 *
 * Output is direction for a person editing in DaVinci Resolve with free library audio; nothing here renders sound.
 */

/** Flat schema, so a bigger chunk than art direction's 6 is expected to fit — verify live before raising it. */
export const SOUND_SCENES_PER_CHUNK = 10;
/** Share of scenes the prompt aims to give a sound effect; the audit warns above SFX_MAX_SCENE_SHARE (timeline.ts). */
const SFX_TARGET_SHARE = 0.25;
const MAX_SILENCE_BEFORE_SEC = 1.5;
const PRIOR_TRANSITION_WINDOW = 6;

const dur = (s: any) => Math.max(0, Number(s?.durationEst) || 0);
const mmss = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`;
const strList = (v: unknown, max: number) =>
  (Array.isArray(v) ? v : []).map((x) => String(x ?? '').trim()).filter(Boolean).slice(0, max);
const oneOf = <T extends string>(list: readonly T[], v: unknown, fallback: T): T =>
  (list as readonly string[]).includes(String(v)) ? (v as T) : fallback;

/** Runs of consecutive equal `actPhase`, the same grouping chapters use (timeline.ts buildChapters). */
function actRuns(scenes: any[]): { label: string; from: number; to: number; sec: number }[] {
  const runs: { label: string; from: number; to: number; sec: number }[] = [];
  for (const s of scenes) {
    const label = String(s.actPhase || '').trim() || 'Development';
    const last = runs[runs.length - 1];
    if (last && last.label.toLowerCase() === label.toLowerCase()) {
      last.to = s.sceneNumber;
      last.sec += dur(s);
    } else runs.push({ label, from: s.sceneNumber, to: s.sceneNumber, sec: dur(s) });
  }
  return runs;
}

// ---- music plan ---------------------------------------------------------------------------------------------

/**
 * Makes the model's cue list safe to hand to an editor: ranges clamped to real scenes, sorted, overlaps trimmed away,
 * and any cue running across a mid-roll split there with a fade, so the ad break falls in a natural pause. Scenes no
 * cue covers are left uncovered on purpose — that is the silence the prompt asked for, never a gap to fill.
 */
export function normalizeScorePlan(raw: any, sceneCount: number, midrollAfterScenes: number[] = []): MusicCue[] {
  const cues: MusicCue[] = [];
  const input = Array.isArray(raw) ? raw : Array.isArray(raw?.musicCues) ? raw.musicCues : [];
  const cleaned = input
    .map((c: any, i: number) => {
      let start = Math.round(Number(c?.startScene));
      let end = Math.round(Number(c?.endScene));
      if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
      if (start > end) [start, end] = [end, start];
      start = Math.max(1, start);
      end = Math.min(sceneCount, end);
      if (start > end) return null;
      const bpm = Math.round(Number(c?.tempoBpm));
      return {
        cueId: String(c?.cueId || '').trim() || `m${i + 1}`,
        startScene: start,
        endScene: end,
        role: oneOf(MUSIC_ROLES, c?.role, 'tension'),
        mood: String(c?.mood || '').trim(),
        ...(Number.isFinite(bpm) && bpm >= 40 && bpm <= 200 ? { tempoBpm: bpm } : {}),
        instruments: String(c?.instruments || '').trim(),
        intensity: Math.min(3, Math.max(1, Math.round(Number(c?.intensity) || 1))) as 1 | 2 | 3,
        entry: oneOf(MUSIC_ENTRIES, c?.entry, 'fade-in'),
        exit: oneOf(MUSIC_EXITS, c?.exit, 'fade-out'),
        searchTerms: strList(c?.searchTerms, 4),
      } as MusicCue;
    })
    .filter(Boolean) as MusicCue[];
  cleaned.sort((a, b) => a.startScene - b.startScene);

  for (const c of cleaned) {
    const prev = cues[cues.length - 1];
    if (prev && c.startScene <= prev.endScene) c.startScene = prev.endScene + 1;
    if (c.startScene > c.endScene) continue;
    cues.push(c);
  }

  const out: MusicCue[] = [];
  for (const c of cues) {
    let cur = c;
    for (const after of [...midrollAfterScenes].sort((a, b) => a - b)) {
      if (after >= cur.startScene && after < cur.endScene) {
        out.push({ ...cur, endScene: after, exit: 'fade-out' });
        cur = { ...cur, cueId: `${cur.cueId}b`, startScene: after + 1, entry: 'fade-in' };
      }
    }
    out.push(cur);
  }
  return out;
}

/** Which cue plays under a scene, or undefined for a deliberate silence. */
export function cueForScene(cues: MusicCue[], sceneNumber: number): MusicCue | undefined {
  return cues.find((c) => sceneNumber >= c.startScene && sceneNumber <= c.endScene);
}

async function generateScorePlan(ai: GoogleGenAI, script: any, isDoc: boolean, midrollAfterScenes: number[], brand: string): Promise<any> {
  const scenes: any[] = script.scenes;
  const total = scenes.reduce((n, s) => n + dur(s), 0);
  const maxCues = Math.min(12, Math.max(2, Math.ceil(total / 60)));
  const acts = actRuns(scenes)
    .map((a) => `- scenes ${a.from}-${a.to}: ${a.label} (${Math.round(a.sec)} s)`)
    .join('\n');
  const sceneLines = scenes
    .map((s) => {
      const words = String(s.narration || '').split(/\s+/).filter(Boolean);
      const gist = words.slice(0, 22).join(' ') + (words.length > 22 ? '…' : '');
      return `#${s.sceneNumber} [${s.actPhase || '—'}] ${s.speaker === 'analyst' ? '(analyst) ' : ''}${Math.round(dur(s))}s: ${gist}`;
    })
    .join('\n');
  const midrollRule = midrollAfterScenes.length
    ? `\n8. Mid-roll ad breaks come after scene${midrollAfterScenes.length > 1 ? 's' : ''} ${midrollAfterScenes.join(' and ')}. End a cue on that scene ("fade-out" or "button") so the break falls in a natural pause.`
    : '';

  const prompt = `You are the music supervisor for "${script.title || 'this video'}", a ${isDoc ? 'documentary' : 'story-driven explainer'} on ${brand}, a channel that tells hacking and security stories to curious people who are not experts.
Runtime ${mmss(total)}, ${scenes.length} scenes.

Your job is a music plan an editor can follow in DaVinci Resolve using free library tracks. Music here is a bed under a narrator, never the main event.

How a professional scores this kind of video. Each rule has a reason; follow the reason when a case isn't covered:
1. Change the music only when the story's emotional state changes (the acts below show where). A new cue every scene sounds like channel-surfing: about one cue per 45-90 seconds is normal, and at most ${maxCues} for this runtime.
2. Leave at least one deliberate silence: scenes no cue covers play with the narration alone. Silence right before or during the biggest reveal makes it land; wall-to-wall music makes every moment feel equally important. Aim for music under roughly 70-85% of the runtime.
3. The opening needs energy at once: scene 1's cue enters with a "sting" or "hard-in", never a slow "fade-in" over the hook.
4. Instrumental only. Lyrics fight the narrator for the viewer's attention.
5. ${isDoc ? 'Documentary register: restrained. Ambient pads, sparse piano, low strings, soft pulses. No drops, no EDM, nothing that sounds like a trailer.' : 'Explainer register: rhythmic and modern is fine (pulses, light percussion, synths), but it still sits under a voice. No drops that would bury a line.'}
6. End each cue on purpose: "fade-out" drifts away, "button" is a clean musical ending on a line, "cut-to-silence" makes the next moment land in silence.
7. "searchTerms": 2-4 short phrases that find a fitting track in the YouTube Audio Library (free, cleared for monetised YouTube) and on Pixabay Music, e.g. "dark ambient tension", "suspense pulse", "minimal sad piano". Never name a song, artist, film or game: the channel can only use library music.${midrollRule}

Roles: "cold-open" (the hook), "tension" (danger building), "explainer" (how it works: lighter, steady, low), "reveal" (the turn), "aftermath" (consequences), "resolve" (the fix and the close).
"intensity": 1 barely there, 2 present, 3 carries the moment (use 3 rarely).

ACTS:
${acts}

SCENES (number, act, length, opening words):
${sceneLines}

Return {"musicCues": [...]} in scene order. startScene and endScene are inclusive scene numbers; cues must not overlap, and a gap between two cues is silence on purpose.

Example for a different, 12-scene script. It shows the shape and the restraint; do not copy its content:
{"musicCues":[
 {"cueId":"m1","startScene":1,"endScene":3,"role":"cold-open","mood":"uneasy, urgent","tempoBpm":96,"instruments":"low synth pulse, ticking hi-hat","intensity":2,"entry":"sting","exit":"button","searchTerms":["suspense pulse","dark cinematic tension"]},
 {"cueId":"m2","startScene":4,"endScene":7,"role":"explainer","mood":"curious, steady","tempoBpm":84,"instruments":"soft plucked synth, light percussion","intensity":1,"entry":"fade-in","exit":"cut-to-silence","searchTerms":["minimal technology ambient","curious documentary"]},
 {"cueId":"m3","startScene":9,"endScene":12,"role":"resolve","mood":"calm, settled","tempoBpm":70,"instruments":"warm pads, sparse piano","intensity":1,"entry":"fade-in","exit":"fade-out","searchTerms":["calm reflective piano","hopeful ambient"]}
]}
Scene 8 has no cue there: the reveal plays in silence.`;

  return generateJson(
    ai,
    prompt,
    'You are a precise music supervisor for documentary video. Output strictly valid JSON matching the schema.',
    TEXT_MODELS,
    buildScorePlanSchema(maxCues)
  );
}

// ---- per-scene sound & edit ---------------------------------------------------------------------------------

/** "[SFX: lock clunk + sub-bass drop]" -> "lock clunk". One sound per scene: a stack under a voice is noise. */
export function cleanSfxCue(raw: unknown): string {
  let t = String(raw ?? '').trim();
  t = t.replace(/^\[?\s*sfx\s*:\s*/i, '').replace(/\]\s*$/, '').trim();
  t = t.split(/\s+\+\s+|\s*;\s*|\s+&\s+/)[0].trim();
  if (/^(none|no sfx|n\/a|-|—)$/i.test(t)) return '';
  return t.slice(0, 120);
}

function buildPriorSoundContext(done: any[], directionsSoFar: Map<number, any>, total: number): string {
  if (done.length === 0) {
    return `PRIOR SOUND CONTEXT: this is the first chunk. The whole script has ${total} scenes, so about ${Math.max(1, Math.round(total * SFX_TARGET_SHARE))} sound effects in total.`;
  }
  const withSfx = done.filter((s) => cleanSfxCue(directionsSoFar.get(s.sceneNumber)?.sfxCue)).map((s) => `#${s.sceneNumber}`);
  const silences = done.filter((s) => Number(directionsSoFar.get(s.sceneNumber)?.silenceBeforeSec) > 0).map((s) => `#${s.sceneNumber}`);
  const recent = done
    .slice(-PRIOR_TRANSITION_WINDOW)
    .map((s) => `#${s.sceneNumber} ${normalizeTransition(directionsSoFar.get(s.sceneNumber)?.transitionIn)}`)
    .join(', ');
  return `PRIOR SOUND CONTEXT (earlier chunks of this script; don't repeat them):
- Sound effects so far: ${withSfx.length} of ${done.length} scenes (${withSfx.join(', ') || 'none'}). The whole script has ${total} scenes, so about ${Math.max(1, Math.round(total * SFX_TARGET_SHARE))} in total.
- Silences so far: ${silences.join(', ') || 'none'}.
- Last transitions: ${recent || 'none'}.`;
}

async function generateSoundChunk(
  ai: GoogleGenAI,
  chunk: any[],
  cues: MusicCue[],
  lastSceneNumber: number,
  midrollAfterScenes: number[],
  isDoc: boolean,
  priorContext: string
): Promise<any[]> {
  const scenesForPrompt = chunk.map((s) => {
    const cue = cueForScene(cues, s.sceneNumber);
    const notes = [
      s.sceneNumber === 1 ? 'first scene of the video' : '',
      midrollAfterScenes.includes(s.sceneNumber) ? 'a mid-roll ad break comes right after this scene' : '',
      s.sceneNumber === lastSceneNumber ? 'last scene of the video' : '',
    ].filter(Boolean);
    return {
      sceneNumber: s.sceneNumber,
      actPhase: s.actPhase,
      speaker: s.speaker || 'narrator',
      narration: s.narration,
      durationEst: s.durationEst,
      shot: [s.motion?.shotType, s.motion?.cameraMove].filter(Boolean).join(', ') || s.cinematography || '',
      onScreenText: s.onScreenText,
      music: cues.length
        ? cue
          ? `cue ${cue.cueId}: ${cue.role}, ${cue.mood}, intensity ${cue.intensity}`
          : 'no music: deliberate silence'
        : 'no music plan available',
      ...(notes.length ? { notes } : {}),
    };
  });

  const prompt = `You are the sound designer and picture editor for this video. The script, the images and the music plan are done. You decide the sound effects, the silences and the cuts for the scenes below. An editor builds exactly what you write in DaVinci Resolve with free library sounds, so be specific, and be restrained: the viewers are curious people, not experts, and the narrator's voice is what they follow.

SOUND EFFECTS: an effect marks a moment. It is not wallpaper.
- Most scenes get none: return "" for sfxCue and sfxOnWord, and [] for sfxSearchTerms. Across the whole script about 1 scene in 4 gets one.
- Give a scene an effect only when something in its narration or picture happens at an instant: a lock, a phone buzzing, a stamp, a click, a door, a date landing, a reveal.
- One sound per scene, never a stack. Write "single heavy deadbolt clunk", not "sub-bass drop + glitch + keyboard clatter": stacked effects under a voice are noise, and the viewer hears none of them.
- Stay away from the sounds that make AI videos all sound alike (sub-bass drops, glitch stutters, whooshes, record scratches) unless a moment truly needs one, and then once.
- "sfxOnWord": the exact word from that scene's narration where the effect lands, copied as written.
- "sfxSearchTerms": 1-3 plain phrases that find it in the YouTube Audio Library or Pixabay sound effects, e.g. "deadbolt lock", "phone vibrate on table".

AMBIENCE: a quiet bed of the place (rain on a window, office air conditioning, a server room's hum). Use it where there is no music, or where the place itself matters; "" otherwise.

SILENCE: "silenceBeforeSec" is a pause with no music and no effects before the narration starts. 0 for almost every scene; 0.5-1.0 before the single biggest reveal of an act, so it lands. At most one per act.

TRANSITIONS: "transitionIn" is how the picture gets INTO this scene from the one before. Professional editors cut. Every other transition means something, and using one without that meaning looks amateur:
- "cut": the default and the right answer most of the time.
- "smash-cut": a jarring jump from calm to shock or back; the contrast is the point.
- "match-cut": the new shot rhymes with the last one's shape or movement (a padlock, then a phone's lock icon).
- "dissolve": time passes, or a memory.
- "dip-to-black": a beat of weight after a heavy line.
- "fade-to-black": a chapter or the video ends, or an ad break comes. Only there.${isDoc ? '' : '\n- "whip": a fast, energetic move between two related beats. Rare.'}
"transitionReason": one short clause, e.g. "continuous action", "time jumps to June", "contrast: calm lab to legal threat".

AUDIO BRIDGES: "audioBridge" links sound across the cut into the NEXT scene. "j-cut": the next scene's sound starts under this picture (we hear the phone buzz before we see the phone). "l-cut": this scene's sound or line runs on over the next picture. "none" most of the time.

${priorContext}

SCENES (with the music under each, from the music plan):
${JSON.stringify(scenesForPrompt, null, 2)}

Return {"scenes": [...]} with exactly ${chunk.length} entries, one per scene above, in order.`;

  const result: any = await generateJson(
    ai,
    prompt,
    'You are a restrained, precise sound designer and film editor. Output strictly valid JSON matching the schema.',
    TEXT_MODELS,
    buildSoundDirectionSchema(chunk.length)
  );
  return Array.isArray(result?.scenes) ? result.scenes : [];
}

/** Turns one scene's raw direction into what the editor gets. `forcedIn` overrides the model's transition. */
export function toSceneSound(d: any, scene: any, isDoc: boolean, forcedIn?: { transition: Transition; reason: string }): SceneSound {
  const sfxCue = cleanSfxCue(d?.sfxCue);
  const word = String(d?.sfxOnWord ?? '').trim();
  const wordOk = sfxCue && word && normalizeForAnchorMatch(String(scene?.narration || '')).includes(normalizeForAnchorMatch(word));
  let transitionIn = normalizeTransition(d?.transitionIn);
  if (isDoc && transitionIn === 'whip') transitionIn = 'cut';
  const silence = Math.round(Math.min(MAX_SILENCE_BEFORE_SEC, Math.max(0, Number(d?.silenceBeforeSec) || 0)) * 10) / 10;
  return {
    sfxCue,
    sfxOnWord: wordOk ? word : '',
    sfxSearchTerms: sfxCue ? strList(d?.sfxSearchTerms, 3) : [],
    ambience: String(d?.ambience ?? '').trim(),
    silenceBeforeSec: silence,
    transitionIn: forcedIn?.transition ?? transitionIn,
    transitionReason: forcedIn?.reason ?? String(d?.transitionReason ?? '').trim(),
    audioBridge: oneOf<AudioBridge>(AUDIO_BRIDGES, d?.audioBridge, 'none'),
  };
}

/**
 * Runs the sound pass and merges it into the script: `script.musicCues`, and on each scene `sound`, `soundEffect`
 * (the legacy one-line field, now the single cue or "") and `motion.transitionOut` (set from the next scene's
 * `transitionIn`, so the two can never disagree). A failed chunk leaves its scenes without `sound` and is reported in
 * `opts.degraded`; strict callers get retryable failures thrown, as in the other passes.
 */
export async function applySoundDirection(
  ai: GoogleGenAI,
  script: any,
  opts: ScriptRunOptions = {},
  ctx: { midrollAfterScenes?: number[]; channelBrandName?: string } = {}
): Promise<any> {
  const scenes: any[] = Array.isArray(script?.scenes) ? script.scenes : [];
  if (scenes.length === 0) return script;
  const isDoc = isDocumentaryTone(script?.tonePacing);
  const midrolls = ctx.midrollAfterScenes ?? [];
  const lastSceneNumber = scenes[scenes.length - 1].sceneNumber;

  let cues: MusicCue[] | undefined = opts.journal?.getScorePlan();
  if (cues) console.log('[Sound Director] music plan resumed from journal');
  else {
    try {
      const raw = await withModelTask('Music plan (score)', () =>
        generateScorePlan(ai, script, isDoc, midrolls, ctx.channelBrandName || DEFAULT_CHANNEL_BRAND)
      );
      cues = normalizeScorePlan(raw, scenes.length, midrolls);
      if (cues.length) await opts.journal?.setScorePlan(cues);
    } catch (err: any) {
      if (opts.strict && isRetryableError(err)) throw err;
      console.warn('[Sound Director] music plan failed:', err?.message || err);
      opts.degraded?.push('Music plan failed: the brief has no music cue sheet.');
      cues = [];
    }
  }

  const directions = new Map<number, any>();
  const numChunks = Math.ceil(scenes.length / SOUND_SCENES_PER_CHUNK);
  for (let i = 0; i < scenes.length; i += SOUND_SCENES_PER_CHUNK) {
    const chunk = scenes.slice(i, i + SOUND_SCENES_PER_CHUNK);
    const chunkIndex = i / SOUND_SCENES_PER_CHUNK;
    const firstScene = Number(chunk[0].sceneNumber);
    const label = `scenes ${firstScene}-${firstScene + chunk.length - 1} (chunk ${chunkIndex + 1}/${numChunks})`;
    const cached = opts.journal?.getSoundChunk(chunkIndex, firstScene);
    if (cached) {
      console.log(`[Sound Director] chunk ${chunkIndex + 1}/${numChunks} resumed from journal`);
      for (const d of cached) directions.set(Number(d.sceneNumber), d);
      continue;
    }
    const prior = buildPriorSoundContext(scenes.slice(0, i), directions, scenes.length);
    try {
      const got = await withModelTask(`Sound & edit, ${label}`, () =>
        generateSoundChunk(ai, chunk, cues!, lastSceneNumber, midrolls, isDoc, prior)
      );
      for (const d of got) directions.set(Number(d.sceneNumber), d);
      await opts.journal?.setSoundChunk(chunkIndex, firstScene, got);
    } catch (err: any) {
      if (opts.strict && isRetryableError(err)) throw err;
      console.warn(`[Sound Director] chunk ${chunkIndex + 1}/${numChunks} failed:`, err?.message || err);
      opts.degraded?.push(`Sound & edit chunk ${chunkIndex + 1}/${numChunks} failed: ${label} have no sound or edit direction.`);
    }
  }

  const withSound = scenes.map((s, i) => {
    const d = directions.get(Number(s.sceneNumber));
    if (!d) return s;
    const prev = scenes[i - 1];
    // Scene 1 opens the video: nothing to transition from. After a mid-roll the ad break needs a fade into it,
    // which is the transition INTO the scene that follows the break.
    const forced =
      i === 0
        ? { transition: 'cut' as Transition, reason: 'opens the video' }
        : prev && midrolls.includes(prev.sceneNumber)
        ? { transition: 'fade-to-black' as Transition, reason: 'mid-roll ad break before this scene' }
        : undefined;
    const sound = toSceneSound(d, s, isDoc, forced);
    return { ...s, sound, soundEffect: sound.sfxCue };
  });

  script.scenes = withSound.map((s, i) => {
    if (!s.motion) return s;
    const next = withSound[i + 1];
    const out: Transition = next ? (next.sound ? next.sound.transitionIn : normalizeTransition(s.motion.transitionOut)) : 'fade-to-black';
    return { ...s, motion: { ...s.motion, transitionOut: out } };
  });
  script.musicCues = cues;

  const total = scenes.reduce((n, s) => n + dur(s), 0);
  const musicSec = scenes.filter((s) => cueForScene(cues!, s.sceneNumber)).reduce((n, s) => n + dur(s), 0);
  const covered = script.scenes.filter((s: any) => s.sound).length;
  const sfx = script.scenes.filter((s: any) => s.sound?.sfxCue).length;
  const fades = script.scenes.filter((s: any) => s.sound && s.sound.transitionIn !== 'cut').length;
  console.log(
    `[Sound Director] ${cues.length} music cue(s) under ${total ? Math.round((musicSec / total) * 100) : 0}% of the runtime; ` +
      `sound & edit on ${covered}/${scenes.length} scenes (${sfx} with an effect, ${fades} non-cut transitions) across ${numChunks} chunk(s)`
  );
  return script;
}

