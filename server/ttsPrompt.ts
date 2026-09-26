/**
 * What /api/tts sends to the speech model. The default is the one-line "punchy infotainment" prompt the UI has always
 * used. A caller may pass its own `direction` instead — an Audio Profile / Scene / Director's Notes block, the format
 * that won the 2026-09-21 blind test for the analyst voice (scripts/tts-bakeoff/gemini_tts.py `directed`). The
 * direction is spoken *about*, not read: it ends with a `#### TRANSCRIPT` header and the text follows it.
 */
export const DEFAULT_TTS_PREFIX = 'Speak in a punchy, engaging infotainment documentary narrator voice:';
export const MAX_DIRECTION_CHARS = 4000;

export function normalizeDirection(direction: unknown): string | undefined {
  if (typeof direction !== 'string') return undefined;
  const d = direction.trim().slice(0, MAX_DIRECTION_CHARS);
  return d || undefined;
}

export function buildTtsPrompt(text: string, direction?: unknown): string {
  const d = normalizeDirection(direction);
  if (!d) return `${DEFAULT_TTS_PREFIX} ${text}`;
  return /#+\s*TRANSCRIPT\s*$/i.test(d) ? `${d}\n${text}` : `${d}\n\n#### TRANSCRIPT\n${text}`;
}
