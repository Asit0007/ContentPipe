/**
 * The scene's image prompt for FLUX and for Midjourney, the two other tools the owner uses by hand (2026-09-27)
 * besides Nano Banana Pro (see nanoBananaPrompt.ts). Same art-direction layers in the same order: character (locked
 * promptAnchor, first and verbatim), background, composed scene, then the style anchor last and identical in every
 * scene.
 *
 * These stills are the first frame of an image-to-video clip, so both end with a clarity clause. Grain, noise, busy
 * micro-texture and hard shimmer in a still turn into flicker once a video model animates it; smooth tonal
 * gradients, a single clear subject and soft even light animate cleanly. It is worded as what to draw, not what to
 * avoid, because "no grain" tends to add grain. The style anchor still sets the look: the clause is about clarity, not
 * style, and it comes before the anchor so the anchor keeps the last word.
 *
 * FLUX (Cloudflare klein / schnell, or any FLUX app): plain sentences, no negative prompt, no weights.
 * Midjourney: no version flag is pinned, so it uses the account's current default; `--no` is a real field there, so the
 * unwanted things go in it, and `--style raw` keeps it from over-styling the anchor.
 *
 * Dependency-free: imported by both the server (the exported brief) and the UI (the copy buttons).
 */

const NO_CHARACTERS = /^no characters in frame\.?$/i;

const FRAME: Record<string, string> = {
  '16:9': '16:9 landscape',
  '9:16': '9:16 portrait',
  '1:1': '1:1 square',
  '4:3': '4:3 landscape',
  '3:4': '3:4 portrait',
};

export const VIDEO_READY_CLARITY =
  'Clean, sharp, high-clarity digital image with smooth tonal gradients, soft even lighting and one clear focal subject with uncluttered space around it.';

interface SceneLike {
  visualPrompt?: string;
  visual?: { character?: string; background?: string; scene?: string; styleAnchor?: string };
}

function sentence(s: string | undefined): string {
  const t = (s || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

/** Layers in order, with the clarity clause just before the style anchor (or at the end for a flat visualPrompt). */
function layered(scene: SceneLike): string {
  const v = scene.visual;
  if (!v) return [sentence(scene.visualPrompt), sentence(VIDEO_READY_CLARITY)].filter(Boolean).join(' ');
  const character = NO_CHARACTERS.test((v.character || '').trim()) ? '' : v.character;
  return [character, v.background, v.scene, VIDEO_READY_CLARITY, v.styleAnchor].map(sentence).filter(Boolean).join(' ');
}

/** True when the scene says anything about what to draw (the clarity clause alone is not a prompt). */
function hasContent(scene: SceneLike): boolean {
  const v = scene.visual;
  if (!v) return Boolean(sentence(scene.visualPrompt));
  return [v.character, v.background, v.scene].some((l) => l && l.trim() && !NO_CHARACTERS.test(l.trim()));
}

export function fluxPrompt(scene: SceneLike, aspectRatio = '16:9'): string {
  if (!hasContent(scene)) return '';
  const body = layered(scene);
  return `${FRAME[aspectRatio] || FRAME['16:9']} frame. ${body}`;
}

/** Things a still must not contain if it is going to be animated. `--no` is Midjourney's negative field. */
export const MIDJOURNEY_NEGATIVES = 'film grain, noise, banding, blurry, jpeg artifacts, text, watermark, extra fingers';

export function midjourneyPrompt(scene: SceneLike, aspectRatio = '16:9'): string {
  if (!hasContent(scene)) return '';
  const body = layered(scene);
  const ar = FRAME[aspectRatio] ? aspectRatio : '16:9';
  return `${body} --ar ${ar} --style raw --stylize 100 --no ${MIDJOURNEY_NEGATIVES}`;
}
