import type { GoogleGenAI } from '@google/genai';
import { TEXT_MODELS } from './gemini';
import { generateJson } from './llm/chain';
import { withModelTask } from './llm/usage';
import { isRetryableError } from './quota';
import { buildClipDirectionSchema } from './schemas';
import type { ScriptRunOptions } from './scriptPipeline';
import { CLIP_MAX_SEC, sceneClips, type ClipDirection } from '../shared/clipPrompts';

/**
 * The clip pass (2026-10-01): after art direction and sound, it cuts every scene into clips of at most 10 s and writes
 * what happens in each one — the action, the one camera move, the ambient motion and the frame it ends on. The owner
 * makes most of the picture by hand in Kling (image-to-video, 5 or 10 s clips), and one sentence of `motionPrompt` per
 * 12-15 s scene was not enough to direct two clips. shared/clipPrompts.ts turns these fields plus the scene's visual
 * layers into the paste-ready prompt; this pass only writes the parts that need judgment.
 *
 * Built like the sound pass: small flat schema, chunks, checkpointed in the run journal, and a failed chunk degrades
 * to clips derived from `motion` (still usable, less specific) instead of failing the script.
 */

/** Two nested arrays per scene, so a smaller chunk than the sound pass's 10. */
export const CLIP_SCENES_PER_CHUNK = 6;

const clean = (v: unknown) => String(v ?? '').replace(/\s+/g, ' ').trim();

/** What the model sees per scene: the picture it must keep, the motion already chosen, and the clips to fill. */
function sceneForPrompt(s: any) {
  const clips = sceneClips({ ...s, clips: undefined });
  const v = s.visual || {};
  return {
    sceneNumber: s.sceneNumber,
    title: s.title,
    durationSec: s.durationEst,
    character: clean(v.character) || 'No characters in frame.',
    background: clean(v.background) || clean(s.visualPrompt),
    composedShot: clean(v.scene),
    shotType: clean(s.motion?.shotType),
    plannedCameraMove: clean(s.motion?.cameraMove),
    plannedSubjectMotion: clean(s.motion?.subjectMotion),
    clips: clips.map((c) => ({ clipNumber: c.clipNumber, seconds: `${c.startSec}-${c.startSec + c.durationSec}`, narrationOverThisClip: c.narrationBeat })),
  };
}

export async function generateClipChunk(ai: GoogleGenAI, chunk: any[], lastEndFrame: string): Promise<any[]> {
  const scenes = chunk.map(sceneForPrompt);
  const prompt = `You are the director of photography on a cinematic documentary for a YouTube channel about hacking and cyber-security stories. The audience is anyone curious, including people who know nothing about technology, so every clip must be easy to read on screen and visually gripping.

<context>
Each scene below already has a finished still image, described by its character, background and composed shot. That still is turned into video clips with an image-to-video model (Kling). A clip is at most ${CLIP_MAX_SEC} seconds, so longer scenes are split into several clips; the split is already done and given to you.
- Clip 1 of a scene starts from the scene's still image.
- Clip 2 and later start from the LAST FRAME of the clip before, so the scene plays as one continuous shot.
- Narration, music and sound effects are added later in the edit. The clips are silent, and nobody on screen speaks.
</context>

<task>
For every clip of every scene, write what happens in it:
- "action": what visibly moves, in 1-2 concrete sentences: who or what, the physical movement, and how fast. Tie it to "narrationOverThisClip" so the picture shows what the voice is saying at that moment (a hand hovers over a key while the narration says "one command"). Only things already in the still, or things that can enter from off frame. Describe movement a camera could film: a person turning, fingers typing, a printout sliding off a desk, a screen flickering on. Never a word or letter that appears or changes, because video models garble lettering.
- "camera": exactly ONE camera move with its speed and direction ("slow push-in toward the monitor", "static locked-off camera", "gentle orbit left around the desk"). Two moves in one clip make the picture warp. For clip 2+, either continue clip 1's move or change it for contrast, so the scene does not feel like one long zoom. Start from "plannedCameraMove" for clip 1.
- "environment": the ambient motion of the place in one sentence: haze drifting through a light beam, rain on a window, cables swaying, a CRT's scanlines rolling. "" only if the place is truly still.
- "endFrame": one sentence describing the final frame: where the subject is and what fills the frame. The next clip starts from this picture, so make it a clean, steady composition.
</task>

<rules>
- Keep the people, the place and the light of the still. Never add a new character, change clothing or move to another location.
- Call people by what they look like ("the man", "the woman in the navy suit"), never by a name. The video model sees only the picture, and a name can make it refuse the clip as a request to depict a real person.
- Keep motion restrained and physically plausible: this is a documentary, not an action film. One clear movement per clip beats several small ones.
- Write for the model, not the viewer: plain, visual, present tense. No camera jargon the model cannot film ("establishing", "B-roll"), no emotions it cannot see.
- Return exactly the clip numbers given for each scene, in order.
</rules>

<example>
Scene with two clips, a researcher at a desk, narration "He typed one line. ... The phone in his hand rebooted.":
{"sceneNumber": 7, "clips": [
 {"clipNumber": 1, "action": "The researcher leans toward the glowing monitor and types a short burst on the keyboard, then lifts his hands away.", "camera": "Slow push-in toward his face and the screen.", "environment": "Haze drifts through the cone of the desk lamp; the monitor's light flickers on his glasses.", "endFrame": "Close on the researcher's face lit by the monitor, the keyboard soft in the foreground."},
 {"clipNumber": 2, "action": "He picks up the phone from the desk and watches its screen go dark, then light up again as it restarts.", "camera": "Static, locked-off camera.", "environment": "Haze keeps drifting; the monitor's glow pulses faintly behind him.", "endFrame": "The lit phone held at chest height in the center of frame, his face above it in shallow focus."}
]}
</example>
${lastEndFrame ? `\nThe previous scene's last clip ended on: ${lastEndFrame}\nThis chunk's first scene is a new shot (a cut), so it does not have to continue from it — use it only to avoid repeating the same framing.\n` : ''}
<scenes>
${JSON.stringify(scenes, null, 2)}
</scenes>

Return {"scenes": [...]} with exactly ${chunk.length} entries, one per scene above, in order.`;

  const result: any = await generateJson(
    ai,
    prompt,
    'You are a precise, restrained director of photography. Output strictly valid JSON matching the schema.',
    TEXT_MODELS,
    buildClipDirectionSchema(chunk.length)
  );
  return Array.isArray(result?.scenes) ? result.scenes : [];
}

/** The model's clips for one scene, cleaned and limited to the clip numbers that scene actually has. */
export function toClipDirections(d: any, scene: any): ClipDirection[] {
  const wanted = sceneClips({ ...scene, clips: undefined }).length;
  const raw: any[] = Array.isArray(d?.clips) ? d.clips : [];
  const out: ClipDirection[] = [];
  for (let n = 1; n <= wanted; n++) {
    const c = raw.find((x) => Number(x?.clipNumber) === n) ?? raw[n - 1];
    if (!c || !clean(c.action) || !clean(c.camera)) continue;
    out.push({ clipNumber: n, action: clean(c.action), camera: clean(c.camera), environment: clean(c.environment), endFrame: clean(c.endFrame) });
  }
  return out;
}

/**
 * Runs the clip pass and stores each scene's `clips` (the full SceneClip list, timing included, so brief.json readers
 * need no code). Scenes the pass did not cover get clips derived from `motion`. Strict callers get retryable failures
 * thrown, as in the other passes.
 */
export async function applyClipDirection(ai: GoogleGenAI, script: any, opts: ScriptRunOptions = {}): Promise<any> {
  const scenes: any[] = Array.isArray(script?.scenes) ? script.scenes : [];
  if (scenes.length === 0) return script;

  const directions = new Map<number, ClipDirection[]>();
  const numChunks = Math.ceil(scenes.length / CLIP_SCENES_PER_CHUNK);
  for (let i = 0; i < scenes.length; i += CLIP_SCENES_PER_CHUNK) {
    const chunk = scenes.slice(i, i + CLIP_SCENES_PER_CHUNK);
    const chunkIndex = i / CLIP_SCENES_PER_CHUNK;
    const firstScene = Number(chunk[0].sceneNumber);
    const label = `scenes ${firstScene}-${firstScene + chunk.length - 1} (chunk ${chunkIndex + 1}/${numChunks})`;
    let got = opts.journal?.getClipChunk(chunkIndex, firstScene);
    if (got) console.log(`[Clip Director] chunk ${chunkIndex + 1}/${numChunks} resumed from journal`);
    else {
      const prev = scenes[i - 1] ? directions.get(Number(scenes[i - 1].sceneNumber)) : undefined;
      try {
        got = await withModelTask(`Clip prompts, ${label}`, () => generateClipChunk(ai, chunk, prev?.[prev.length - 1]?.endFrame || ''));
        await opts.journal?.setClipChunk(chunkIndex, firstScene, got);
      } catch (err: any) {
        if (opts.strict && isRetryableError(err)) throw err;
        console.warn(`[Clip Director] chunk ${chunkIndex + 1}/${numChunks} failed:`, err?.message || err);
        opts.degraded?.push(`Clip prompts chunk ${chunkIndex + 1}/${numChunks} failed: ${label} have clip prompts built from their motion direction only.`);
        continue;
      }
    }
    for (const d of got || []) {
      const scene = chunk.find((s) => Number(s.sceneNumber) === Number(d?.sceneNumber));
      if (scene) directions.set(Number(scene.sceneNumber), toClipDirections(d, scene));
    }
  }

  script.scenes = scenes.map((s) => ({ ...s, clips: sceneClips({ ...s, clips: directions.get(Number(s.sceneNumber)) }) }));
  const all = script.scenes.flatMap((s: any) => s.clips);
  const fromModel = all.filter((c: any) => c.source === 'model').length;
  console.log(`[Clip Director] ${all.length} clip(s) across ${scenes.length} scenes; ${fromModel} written by the model, ${all.length - fromModel} derived from motion`);
  return script;
}
