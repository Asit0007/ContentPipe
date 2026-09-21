/**
 * English captions (SRT) from the narration that is actually spoken.
 *
 * Timing comes from the render, not from the model: each scene's speech occupies
 * [startSec, startSec + audioSec] in the assembled video (server/assemble.ts), and the cues inside it are
 * spread across that window in proportion to how long each would take to say. That is an estimate — there
 * is no forced alignment, so a cue can start a few tenths of a second off inside a scene — but scene
 * boundaries are exact because they are the real audio boundaries.
 *
 * Captions must match the audio for accessibility, so this captions the narration verbatim: it cleans
 * whitespace and citation markers, and never paraphrases, shortens or drops words.
 */

export interface CaptionCue {
  index: number;
  startSec: number;
  endSec: number;
  text: string;
}

export interface CaptionScene {
  text: string;
  /** Where this scene's narration starts in the finished video. */
  startSec: number;
  /** How long the narration actually is (the speech, without the gap after it). */
  audioSec: number;
  /** Silence after the narration; a cue may linger into it, briefly. */
  gapAfterSec?: number;
}

export interface CaptionOptions {
  maxLineChars?: number;
  maxLines?: number;
}

const DEFAULT_MAX_LINE_CHARS = 42; // the broadcast convention; keeps two lines readable on a phone
const DEFAULT_MAX_LINES = 2;
const CUE_GAP_SEC = 0.02; // SRT cues must not overlap
const MAX_LINGER_SEC = 0.3;

const toMs = (n: number): number => Math.round(n * 1000) / 1000;

/** Whitespace, citation markers like [S1] or [S1, S2], and the one sequence that would end an SRT cue early. */
export function cleanCaptionText(text: string): string {
  return String(text ?? '')
    .replace(/\[\s*S\d+(?:\s*,\s*S\d+)*\s*\]/g, ' ')
    .replace(/-->/g, '->')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Splits at the clause boundary nearest the middle, else the space nearest it, until every piece fits. */
function splitLong(s: string, max: number): string[] {
  if (s.length <= max) return [s];
  const mid = s.length / 2;
  const nearest = (re: RegExp): number => {
    let best = -1;
    let bestD = Infinity;
    for (const m of s.matchAll(re)) {
      const pos = m.index! + m[0].length;
      const d = Math.abs(pos - mid);
      if (pos > 8 && pos < s.length - 8 && d < bestD) {
        best = pos;
        bestD = d;
      }
    }
    return best;
  };
  let cut = nearest(/[,;:—–]\s+/g);
  if (cut < 0 || Math.abs(cut - mid) > s.length * 0.3) {
    const space = nearest(/\s+/g);
    if (space >= 0) cut = space;
  }
  if (cut < 0) return [s];
  return [...splitLong(s.slice(0, cut).trim(), max), ...splitLong(s.slice(cut).trim(), max)];
}

/** Sentences first; short neighbours are merged so a cue is not two words long; long ones are split. */
export function chunkText(text: string, maxChars: number): string[] {
  if (!text) return [];
  const sentences = text.split(/(?<=[.!?]["')\]]?)\s+/).filter(Boolean);
  const pieces = sentences.flatMap((s) => splitLong(s, maxChars));
  const merged: string[] = [];
  for (const p of pieces) {
    const last = merged[merged.length - 1];
    if (last !== undefined && last.length + 1 + p.length <= maxChars) merged[merged.length - 1] = `${last} ${p}`;
    else merged.push(p);
  }
  return merged;
}

/** Roughly how long a chunk takes to say: its characters, plus the pauses a narrator takes at punctuation. */
function speechWeight(chunk: string): number {
  const stops = (chunk.match(/[.!?]/g) || []).length;
  const pauses = (chunk.match(/[,;:]/g) || []).length;
  return chunk.length + 4 * stops + 2 * pauses;
}

// A break right after punctuation reads better than a perfectly balanced one mid-phrase, so it is worth this
// many characters of imbalance.
const PUNCTUATION_BREAK_BONUS = 6;

/** Two balanced lines when it needs them, breaking after punctuation where that is nearly as balanced;
 *  falls back to greedy wrapping only for text too long for two. */
export function wrapLines(text: string, maxLine: number): string[] {
  if (text.length <= maxLine) return [text];
  let best = -1;
  let bestScore = Infinity;
  let bestLongest = Infinity;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== ' ') continue;
    const longest = Math.max(i, text.length - i - 1);
    const score = longest - (/[.,;:!?]/.test(text[i - 1] ?? '') ? PUNCTUATION_BREAK_BONUS : 0);
    if (longest <= maxLine && score < bestScore) {
      best = i;
      bestScore = score;
      bestLongest = longest;
    }
  }
  if (best >= 0 && bestLongest <= maxLine) return [text.slice(0, best), text.slice(best + 1)];
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line && line.length + 1 + word.length > maxLine) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines;
}

export function buildCaptions(scenes: CaptionScene[], opts: CaptionOptions = {}): CaptionCue[] {
  const maxLine = opts.maxLineChars ?? DEFAULT_MAX_LINE_CHARS;
  const maxChars = maxLine * (opts.maxLines ?? DEFAULT_MAX_LINES);
  const cues: CaptionCue[] = [];

  for (const sc of scenes) {
    const chunks = chunkText(cleanCaptionText(sc.text), maxChars);
    if (chunks.length === 0) continue;
    const weights = chunks.map(speechWeight);
    const total = weights.reduce((a, b) => a + b, 0);
    const starts: number[] = [];
    let cumulative = 0;
    for (const w of weights) {
      starts.push(sc.startSec + (sc.audioSec * cumulative) / total);
      cumulative += w;
    }
    const speechEnd = sc.startSec + sc.audioSec;
    const linger = Math.min(sc.gapAfterSec ?? 0, MAX_LINGER_SEC);
    chunks.forEach((chunk, i) => {
      const end = i + 1 < chunks.length ? starts[i + 1] - CUE_GAP_SEC : speechEnd + linger;
      cues.push({ index: 0, startSec: toMs(starts[i]), endSec: toMs(Math.max(end, starts[i] + CUE_GAP_SEC)), text: wrapLines(chunk, maxLine).join('\n') });
    });
  }
  return cues.map((c, i) => ({ ...c, index: i + 1 }));
}

const pad = (n: number, w: number) => String(n).padStart(w, '0');

export function formatSrtTime(sec: number): string {
  const ms = Math.max(0, Math.round(sec * 1000));
  return `${pad(Math.floor(ms / 3600000), 2)}:${pad(Math.floor((ms % 3600000) / 60000), 2)}:${pad(Math.floor((ms % 60000) / 1000), 2)},${pad(ms % 1000, 3)}`;
}

export function renderSrt(cues: CaptionCue[]): string {
  return cues.map((c) => `${c.index}\n${formatSrtTime(c.startSec)} --> ${formatSrtTime(c.endSec)}\n${c.text}\n`).join('\n');
}
