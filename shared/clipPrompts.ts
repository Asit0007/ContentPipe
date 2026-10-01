/**
 * The scene's video clips (2026-10-01): every scene is cut into clips of at most CLIP_MAX_SEC (10 s, Kling's longest
 * clip), and each clip gets a detailed image-to-video prompt the owner pastes into Kling by hand — as detailed as the
 * scene's image prompt, which it is built from.
 *
 * Clip 1 animates the scene's still (the Nano Banana Pro or FLUX image). Clip 2+ starts from the last frame of the
 * clip before it, so a scene plays as one continuous shot even when it is longer than one clip. Narration, music and
 * sound effects are laid in the edit, so every clip is silent.
 *
 * Timing is always worked out here from the scene's current `durationEst`, never trusted from storage: a scene
 * retimed after its clips were written still splits correctly. The creative fields (action, camera, environment,
 * endFrame) come from the clip pass (server/clipPipeline.ts); where that pass failed or never ran (older scripts) they
 * are derived from the scene's `motion` direction instead.
 *
 * Every line goes through shared/promptSafety.ts (2026-10-01, after Gemini refused two clips): no lettering, no
 * brand names, and no clip-direction sentence that carries story meaning instead of a picture.
 *
 * Dependency-free: imported by both the server (the exported brief) and the UI (the copy buttons).
 */

import { pictureText, dropStoryMeaning } from './promptSafety';

export const CLIP_MAX_SEC = 10;

/** The creative half of a clip, as the clip pass writes it and the scene stores it. */
export interface ClipDirection {
  clipNumber: number;
  /** What visibly moves in this clip: who or what, and how. */
  action: string;
  /** Exactly one camera move, with its speed. */
  camera: string;
  /** Ambient motion in the place: haze, light, screens, rain. */
  environment: string;
  /** How the last frame looks; the next clip starts from it. */
  endFrame: string;
}

export interface SceneClip extends ClipDirection {
  /** Offset into the scene, in seconds. */
  startSec: number;
  durationSec: number;
  /** The words spoken over this clip, for the editor. Never part of the prompt (a video model would draw them). */
  narrationBeat: string;
  /** 'model' = written by the clip pass; 'derived' = built from the scene's motion fields. */
  source: 'model' | 'derived';
}

interface SceneLike {
  sceneNumber?: number;
  narration?: string;
  durationEst?: number;
  visualPrompt?: string;
  visual?: { character?: string; background?: string; scene?: string; styleAnchor?: string; negative?: string };
  motion?: { shotType?: string; cameraMove?: string; subjectMotion?: string; durationSec?: number; easing?: string; motionPrompt?: string };
  clips?: Partial<ClipDirection>[];
}

const NO_CHARACTERS = /^no characters in frame\.?$/i;

const FRAME: Record<string, string> = {
  '16:9': '16:9 landscape',
  '9:16': '9:16 portrait',
  '1:1': '1:1 square',
  '4:3': '4:3 landscape',
  '3:4': '3:4 portrait',
};

/**
 * What a video model gets wrong most often, for the tool's negative-prompt field (Kling has one). Speech is listed
 * because the narration is laid in the edit, and a model that adds lip movement makes the picture fight the voice.
 * Motion faults only: the style guide's "don't draw" list (hooded hackers, skulls...) belongs to the still, which is
 * already made, and in a video negative field its words were one more thing for a filter to read.
 */
export const CLIP_NEGATIVES =
  'morphing, warping, melting or changing faces, extra fingers, flicker, jitter, garbled or changing lettering, sudden cuts, camera shake, talking, lip movement, subtitles, watermark';

function clean(s: unknown): string {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

function sentence(s: unknown): string {
  const t = clean(s);
  if (!t) return '';
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** How many clips a scene of this length needs. */
export function clipCount(durationSec: number): number {
  const d = Number(durationSec) || 0;
  return Math.max(1, Math.ceil(d / CLIP_MAX_SEC - 1e-9));
}

/**
 * Splits a scene into equal clips of at most CLIP_MAX_SEC: 12 s is two 6 s clips, not 10 + 2, because a 2 s clip is
 * too short to show anything and costs as much to make as a 5 s one.
 */
export function clipTimings(durationSec: number): { clipNumber: number; startSec: number; durationSec: number }[] {
  const total = Math.max(0, Number(durationSec) || 0);
  const n = clipCount(total);
  const out: { clipNumber: number; startSec: number; durationSec: number }[] = [];
  let start = 0;
  for (let i = 0; i < n; i++) {
    // Rounded to 0.5 s, with the last clip taking whatever rounding left over, so the clips add up to the scene.
    const len = i === n - 1 ? round1(total - start) : Math.round((total / n) * 2) / 2;
    out.push({ clipNumber: i + 1, startSec: round1(start), durationSec: len });
    start += len;
  }
  return out;
}

/**
 * The narration spoken over each clip. Sentences stay whole where there are enough of them (a sentence goes to the
 * clip its middle word falls in); otherwise the words are split evenly. No clip is left without words unless the
 * scene has none.
 */
export function narrationBeats(narration: string, n: number): string[] {
  const text = clean(narration);
  if (n <= 1) return [text];
  const words = text ? text.split(' ') : [];
  if (words.length === 0) return Array(n).fill('');
  const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean);
  if (sentences.length >= n) {
    const beats: string[][] = Array.from({ length: n }, () => []);
    let before = 0;
    for (const s of sentences) {
      const len = s.split(' ').length;
      const at = Math.min(n - 1, Math.floor(((before + len / 2) / words.length) * n));
      beats[at].push(s);
      before += len;
    }
    if (beats.every((b) => b.length > 0)) return beats.map((b) => b.join(' '));
  }
  const per = words.length / n;
  return Array.from({ length: n }, (_, i) => words.slice(Math.round(i * per), Math.round((i + 1) * per)).join(' '));
}

/** A clip's creative fields from the scene's motion direction, for scenes the clip pass did not cover. */
function derivedDirection(scene: SceneLike, clipNumber: number, of: number): ClipDirection {
  const m = scene.motion || {};
  const camera = clean(m.cameraMove) || 'Slow push-in';
  const action = clean(m.subjectMotion) || clean(m.motionPrompt) || 'Subtle natural movement in the scene';
  return {
    clipNumber,
    action: clipNumber === 1 ? action : `${sentence(action)} The movement carries on from the previous clip.`,
    camera: clipNumber === 1 || of === 1 ? camera : `The same move continues: ${camera.charAt(0).toLowerCase()}${camera.slice(1)}`,
    environment: '',
    endFrame: '',
  };
}

/**
 * The scene's clips: timing and narration from its current duration, creative fields from the clip pass where it
 * wrote them for that clip number, derived from `motion` otherwise.
 */
export function sceneClips(scene: SceneLike): SceneClip[] {
  const timings = clipTimings(Number(scene.durationEst) || Number(scene.motion?.durationSec) || 0);
  const beats = narrationBeats(scene.narration || '', timings.length);
  const stored = Array.isArray(scene.clips) ? scene.clips : [];
  return timings.map((t, i) => {
    const s = stored.find((c) => Number(c?.clipNumber) === t.clipNumber) ?? stored[i];
    const fromModel = Boolean(s && clean(s.action) && clean(s.camera));
    const d = fromModel
      ? { clipNumber: t.clipNumber, action: clean(s!.action), camera: clean(s!.camera), environment: clean(s!.environment), endFrame: clean(s!.endFrame) }
      : derivedDirection(scene, t.clipNumber, timings.length);
    return { ...d, ...t, narrationBeat: beats[i] || '', source: fromModel ? 'model' : 'derived' };
  });
}

/** True when the scene has a picture to animate at all. */
function hasPicture(scene: SceneLike): boolean {
  const v = scene.visual;
  if (!v) return Boolean(clean(scene.visualPrompt));
  return [v.character, v.background, v.scene].some((l) => clean(l) && !NO_CHARACTERS.test(clean(l)));
}

/**
 * The clip's image-to-video prompt. One labelled line per layer, in the order a video model weighs them: where it
 * starts, who is in it, what moves, the one camera move, the place and its ambient motion, then the look (the style
 * anchor, identical in every scene, as in the image prompts) and how the clip ends. Labelled lines rather than one
 * paragraph so the owner can read and edit a line before pasting; Kling reads either.
 */
/** A clip direction as it goes into a prompt: story-meaning sentences dropped, lettering out, brands generic. */
function pictureLine(text: string, fallback = ''): string {
  return sentence(pictureText(dropStoryMeaning(text) || dropStoryMeaning(fallback) || fallback));
}

/** What moves when a clip's own action had nothing visual left: the scene's planned motion, then a generic line. */
function actionFallback(scene: SceneLike): string {
  return dropStoryMeaning(clean(scene.motion?.subjectMotion)) || 'Subtle, natural movement in the scene';
}

export function clipPrompt(scene: SceneLike, clip: SceneClip, aspectRatio = '16:9'): string {
  if (!hasPicture(scene)) return '';
  const v = scene.visual;
  const m = scene.motion || {};
  const character = v && !NO_CHARACTERS.test(clean(v.character)) ? sentence(pictureText(v.character || '')) : '';
  const frame = FRAME[aspectRatio] || FRAME['16:9'];
  const start =
    clip.clipNumber === 1
      ? 'Animate the attached still image: keep its composition, its people and its place exactly as they are.'
      : `Continue seamlessly from the last frame of clip ${clip.clipNumber - 1}: same people, same place, same light.`;
  const shot = clean(m.shotType);
  const pace = clean(m.easing);
  const lines = [
    `${frame}, ${clip.durationSec} s, one continuous shot. ${start}`,
    character && `Subject: ${character}`,
    `Action: ${pictureLine(clip.action, actionFallback(scene))}`,
    `Camera: ${[shot && `${shot.replace(/\s+shot$/i, '')} shot.`, pictureLine(clip.camera, 'Slow push-in'), pace && `Pacing: ${pace.toLowerCase()}.`].filter(Boolean).join(' ')}`,
    v?.background ? `Setting: ${sentence(pictureText(v.background))}` : !v && scene.visualPrompt ? `Setting: ${sentence(pictureText(scene.visualPrompt))}` : '',
    clip.environment && dropStoryMeaning(clip.environment) && `Atmosphere: ${pictureLine(clip.environment)}`,
    'Motion: real-time speed, physically plausible weight and inertia; faces, hands and any lettering stay stable and sharp from the first frame to the last. Silent clip.',
    v?.styleAnchor && `Look: ${sentence(v.styleAnchor)}`,
    clip.endFrame && dropStoryMeaning(clip.endFrame) && `Ends on: ${pictureLine(clip.endFrame)}`,
  ];
  return lines.filter(Boolean).join('\n');
}

/**
 * The fallback when a tool refuses the full prompt: only what moves and how the camera moves. The still already
 * carries the people, the place and the look, so an image-to-video tool needs nothing else, and every extra word is
 * one more thing a filter can misread.
 */
export function clipPromptShort(scene: SceneLike, clip: SceneClip, aspectRatio = '16:9'): string {
  if (!hasPicture(scene)) return '';
  const frame = FRAME[aspectRatio] || FRAME['16:9'];
  const start = clip.clipNumber === 1 ? 'Animate the attached image.' : `Continue from the last frame of clip ${clip.clipNumber - 1}.`;
  const env = clip.environment && dropStoryMeaning(clip.environment) ? ` ${pictureLine(clip.environment)}` : '';
  return `${frame}, ${clip.durationSec} s. ${start} ${pictureLine(clip.action, actionFallback(scene))} ${pictureLine(clip.camera, 'Slow push-in')}${env} Smooth, realistic motion. Silent.`;
}

/** The negative prompt for every clip: motion faults only (see CLIP_NEGATIVES). `scene` is kept for callers. */
export function clipNegative(_scene?: SceneLike): string {
  return CLIP_NEGATIVES;
}

/** Kling makes 5 s or 10 s clips: the length to ask for, and whether the editor trims it. */
export function klingLength(durationSec: number): { make: 5 | 10; trimTo?: number } {
  const make = durationSec <= 5 ? 5 : 10;
  return durationSec < make - 0.25 ? { make, trimTo: durationSec } : { make };
}

const mmss = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

/** A clip's one-line header: "Clip 2 of 2 · 0:06–0:12 (6 s) · make 10 s in Kling, trim to 6 s". */
export function clipHeader(clip: SceneClip, of: number): string {
  const k = klingLength(clip.durationSec);
  const make = k.trimTo ? `make ${k.make} s in Kling, trim to ${k.trimTo} s` : `make ${k.make} s in Kling`;
  return `Clip ${clip.clipNumber} of ${of} · ${mmss(clip.startSec)}–${mmss(clip.startSec + clip.durationSec)} (${clip.durationSec} s) · ${make}`;
}
