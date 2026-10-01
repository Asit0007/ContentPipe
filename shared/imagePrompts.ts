/**
 * The scene's image prompt for FLUX, the owner's tool for simple stills, and the pick between FLUX and Nano Banana
 * Pro (see nanoBananaPrompt.ts) for each scene. Midjourney was dropped 2026-10-01 (owner): two image tools, FLUX for
 * plain pictures, Nano Banana Pro for complex ones and any lettering, which FLUX draws badly. Same art-direction
 * layers in the same order: character (locked promptAnchor, first and verbatim), background, composed scene, then
 * the style anchor last and identical in every scene.
 *
 * These stills are the first frame of an image-to-video clip, so the prompt ends with a clarity clause. Grain, noise, busy
 * micro-texture and hard shimmer in a still turn into flicker once a video model animates it; smooth tonal
 * gradients, a single clear subject and soft even light animate cleanly. It is worded as what to draw, not what to
 * avoid, because "no grain" tends to add grain. The style anchor still sets the look: the clause is about clarity, not
 * style, and it comes before the anchor so the anchor keeps the last word.
 *
 * FLUX (Cloudflare klein / schnell, or any FLUX app): plain sentences, no negative prompt, no weights.
 *
 * Dependency-free: imported by both the server (the exported brief) and the UI (the copy buttons).
 */

import { pictureText, evidenceText, hadLettering, textIsSubject, PLAIN_SURFACES } from './promptSafety';

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

/**
 * Layers in order, with the clarity clause just before the style anchor (or at the end for a flat visualPrompt).
 * A clean plate since 2026-10-01: lettering and brand names come out of the description (shared/promptSafety.ts),
 * the words go on in the edit as overlays, and a description that had lettering says its surfaces are plain.
 */
function layered(scene: SceneLike): string {
  const v = scene.visual;
  // A shot whose subject is the words keeps them (evidence: a version number, a letter); every other shot is a clean plate.
  const keep = textIsSubject(scene);
  const clean = keep ? evidenceText : pictureText;
  if (!v) {
    const plain = !keep && hadLettering(scene.visualPrompt || '') ? PLAIN_SURFACES : '';
    return [clean(scene.visualPrompt || ''), plain, VIDEO_READY_CLARITY].map(sentence).filter(Boolean).join(' ');
  }
  const character = NO_CHARACTERS.test((v.character || '').trim()) ? '' : v.character || '';
  const plain = !keep && hadLettering([character, v.background, v.scene].join(' ')) ? PLAIN_SURFACES : '';
  return [clean(character), clean(v.background || ''), clean(v.scene || ''), plain, VIDEO_READY_CLARITY, v.styleAnchor].map(sentence).filter(Boolean).join(' ');
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

export type ImageTool = 'flux' | 'nano-banana-pro';

interface ToolSceneLike extends SceneLike {
  visualType?: string;
  charactersInFrame?: string[];
}

/** A quoted label inside the picture description ('ROOT', "ACCESS DENIED"); the opening quote follows a space, so a possessive is not one. */
const QUOTED_LABEL = /(^|[\s(:])['"\u201c\u2018][A-Za-z0-9][^'"\u201c\u201d\u2018\u2019]{0,48}['"\u201d\u2019](?=[\s.,;:!?)]|$)/;
/** Words that put lettering in the picture: a sign, a headline, a labelled diagram, a screen that reads something. */
const LETTERING = /\b(label(?:l)?ed|labels?|reads|reading|headlines?|captions?|signs?|signage|logos?|lettering|text|written|printed words|typed|inscribed|stamped|banner|list of|model numbers|numbers|calendar|newspaper|document|report|printout|spreadsheet)\b/i;

/**
 * Which tool should draw this scene's still, and why. Nano Banana Pro when the picture holds lettering (FLUX garbles
 * it) or two or more characters who must stay recognisable; FLUX otherwise, as it is free in code and good at plain
 * pictures. A heuristic over the description: the reason says what it matched, so the owner can overrule it.
 */
export function recommendImageTool(scene: ToolSceneLike): { tool: ImageTool; reason: string } {
  const v = scene.visual;
  // Judged on the clean plate: quoted lettering is now an overlay, so only lettering the description still asks for
  // in words ("a page of text", "a sign") counts.
  if (textIsSubject(scene)) return { tool: 'nano-banana-pro', reason: 'the words are the subject of the shot' };
  const text = pictureText(v ? [v.character, v.background, v.scene].join(' ') : scene.visualPrompt || '');
  if (QUOTED_LABEL.test(text) || LETTERING.test(text)) return { tool: 'nano-banana-pro', reason: 'lettering in the picture' };
  if ((scene.charactersInFrame?.length ?? 0) >= 2) return { tool: 'nano-banana-pro', reason: 'two or more characters to keep consistent' };
  return { tool: 'flux', reason: 'no lettering, a plain picture' };
}

export const IMAGE_TOOL_LABEL: Record<ImageTool, string> = { flux: 'FLUX', 'nano-banana-pro': 'Nano Banana Pro' };
