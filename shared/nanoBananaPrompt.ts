/**
 * The scene's image prompt, written for Nano Banana Pro (Gemini 3 Pro Image) used by hand in the Gemini app or
 * AI Studio. Its API has no free quota on this key, so a person pastes this instead.
 *
 * The prompt comes from the art-direction layers: character (with the locked promptAnchor, first and verbatim),
 * background, composed scene, then the style anchor (last, identical in every scene). Nano Banana reads plain
 * sentences and has no negative-prompt field, and writing "no X" into the prompt tends to add X, so `negative` is left
 * out. On-screen text is left out too (captions and labels go on in the edit, where a typo can be fixed), and the
 * prompt does not ask for "no text", for the same reason.
 *
 * Dependency-free: imported by both the server (the exported brief) and the UI (the copy button).
 */

const NO_CHARACTERS = /^no characters in frame\.?$/i;

const ORIENTATION: Record<string, string> = {
  '16:9': '16:9 landscape',
  '9:16': '9:16 portrait',
  '1:1': '1:1 square',
  '4:3': '4:3 landscape',
  '3:4': '3:4 portrait',
};

interface SceneLike {
  visualPrompt?: string;
  visual?: { character?: string; background?: string; scene?: string; styleAnchor?: string };
}

function sentence(s: string | undefined): string {
  const t = (s || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

export function nanoBananaProPrompt(scene: SceneLike, aspectRatio = '16:9'): string {
  const v = scene.visual;
  const layers = v
    ? [NO_CHARACTERS.test((v.character || '').trim()) ? '' : v.character, v.background, v.scene, v.styleAnchor]
    : [scene.visualPrompt];
  const body = layers.map(sentence).filter(Boolean).join(' ');
  if (!body) return '';
  const frame = ORIENTATION[aspectRatio] || ORIENTATION['16:9'];
  // The style anchor already sets the look; nothing here may compete with it.
  return `Create a ${frame} image. ${body}`;
}
