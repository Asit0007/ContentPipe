/**
 * Hook scorer: rates the first line of a video (a "hook") on five properties, 0-100 each, and
 * gives one verdict (60% the mean, 40% the weakest property), a band, and the closest of 21 hook
 * formulas.
 *
 * This is a TypeScript port of `hookscore.py` (scoring only, not its CLI) and `hooks.json` from
 * https://github.com/Jakeschincariol/youtube-agent-skill at commit a2feb21, under the MIT licence,
 * Copyright (c) 2026 Jake Schincariol. `hooks.json` here is a byte-for-byte copy.
 *
 * The author's caveat, which applies here unchanged: measured against 74 real short-form hooks it
 * separates deliberately bad hooks from real ones well, but it separates a creator's own hits from
 * their own misses barely at all. A low score is a reason to look again, never a promise, and a
 * high score is not one either.
 *
 * Parity: `hookScore.test.ts` pins this port to the numbers the Python prints. Differences from
 * Python that were handled on purpose: `round()` is half-to-even; `str.split()`/`strip()` use
 * Python's whitespace set; `str.isupper()` on one character. Regexes: every pattern in hooks.json
 * and every pattern in hookscore.py is valid JS syntax as written (`re.I` becomes the `i` flag),
 * so none was changed. Known gap: Python's `\b`, `\d`, `\w`, `\s` and `re.I` are Unicode-aware and
 * JS's (without the `u` flag) are ASCII-only, so text with non-ASCII digits, word characters or
 * case-folding oddities (for example a Kelvin sign) can score differently. Ordinary accented
 * Latin text matches the Python (tested).
 */
// A static import, not readFileSync + import.meta.url: `npm run build` bundles the server to CommonJS,
// where import.meta.url is empty; esbuild inlines the JSON instead.
import hooksData from './hooks.json';

export type HookProperty = 'SPECIFICITY' | 'ADDRESS' | 'STAKES' | 'CURIOSITY' | 'BREVITY';

export interface HookScore {
  hook: string;
  properties: Record<HookProperty, number>;
  verdict: number;
  band: 'STRONG' | 'WORKABLE' | 'WEAK';
  formula: string;
  matched: number;
  weakest: HookProperty;
  fix: string;
}

interface Formula {
  name: string;
  match: string[];
}

const FORMULAS: { name: string; match: RegExp[] }[] = (hooksData.hooks as Formula[]).map((f) => ({ name: f.name, match: f.match.map((p) => new RegExp(p, 'i')) }));

const FILLER = new Set(['basically', 'actually', 'literally', 'just', 'really', 'very', 'so', 'kind', 'sort', 'like',
  'guys', 'hey', 'welcome', 'today', 'video', 'subscribe', 'channel']);
const VAGUE = new Set(['amazing', 'incredible', 'insane', 'crazy', 'huge', 'massive', 'game', 'changer', 'secret',
  'powerful', 'ultimate', 'best', 'revolutionary', 'mind', 'blowing', 'unbelievable']);
const CONCRETE = /\b(\d[\d,.]*\s?(%|k|m|x|s|m|h)?|\$\d|\d+\s?(second|minute|hour|day|week|month|year)s?)\b/i;
const YOU = /\b(you|your|you're|youre|yourself)\b/i;
const STAKE = /\b(lose|lost|wasting|waste|quit|fail|broke|cost|risk|before|stop|never|die|dying|dead)\b/i;
const CURIOSITY = /\b(why|how|what|which|until|before|but|nobody|almost|except|reason|actually)\b/i;
const CLOSED = /\b(because|so that|which means)\b/i;

const FIX: Record<HookProperty, string> = {
  SPECIFICITY: 'swap one adjective for a number, a name or a date',
  ADDRESS: "say 'you' in the first six words",
  STAKES: 'name what it costs them to keep doing it the current way',
  CURIOSITY: 'cut the half of the sentence that answers itself',
  BREVITY: '9 to 24 words. Read it out loud and stop where you run out of breath',
};

// Python's str.isspace() set: JS's \s plus \x1c-\x1f and \x85, minus ﻿.
const PY_WS = '\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const PY_WS_RUN = new RegExp(`[${PY_WS}]+`);
const PY_STRIP = new RegExp(`^[${PY_WS}]+|[${PY_WS}]+$`, 'g');

/** Python's str.split() with no argument: split on whitespace runs, drop empties. */
const pySplit = (t: string): string[] => t.split(PY_WS_RUN).filter((x) => x !== '');
/** Python's str.strip() with no argument. */
const pyStrip = (t: string): string => t.replace(PY_STRIP, '');

/** Python's `x[:1].isupper()`: the first code point is a cased, uppercase character. */
function firstIsUpper(x: string): boolean {
  const c = String.fromCodePoint(x.codePointAt(0) ?? 0x20);
  return c !== c.toLowerCase() && c === c.toUpperCase();
}

/** Python 3's round(): half to even. */
function roundHalfEven(x: number): number {
  const f = Math.floor(x);
  const d = x - f;
  if (d < 0.5) return f;
  if (d > 0.5) return f + 1;
  return f % 2 === 0 ? f : f + 1;
}

const clamp = (n: number): number => Math.max(0, Math.min(100, n));
const count = (re: RegExp, t: string): number => (t.match(new RegExp(re.source, 'gi')) ?? []).length;
const words = (t: string): string[] => t.toLowerCase().match(/[a-z0-9'%$.]+/g) ?? [];

function specificity(t: string): number {
  const w = words(t);
  if (w.length === 0) return 0;
  const nums = count(CONCRETE, t);
  const vague = w.filter((x) => VAGUE.has(x)).length;
  const filler = w.filter((x) => FILLER.has(x)).length;
  let s = 34 + nums * 22 - vague * 16 - filler * 5;
  // proper nouns that are not sentence-initial read as named things
  s += Math.min(18, 6 * pySplit(t).slice(1).filter(firstIsUpper).length);
  return clamp(s);
}

function address(t: string): number {
  const n = count(YOU, t);
  const first = YOU.test(pySplit(t).slice(0, 6).join(' ')) ? 30 : 0;
  return clamp(26 + n * 20 + first);
}

function stakes(t: string): number {
  const n = count(STAKE, t);
  return clamp(22 + n * 26 + (CONCRETE.test(t) ? 14 : 0));
}

function curiosity(t: string): number {
  const n = count(CURIOSITY, t);
  const q = pyStrip(t).endsWith('?') ? 18 : 0;
  // a hook that resolves itself has no gap left
  const closed = CLOSED.test(t) ? -18 : 0;
  return clamp(24 + n * 17 + q + closed);
}

function brevity(t: string): number {
  const n = words(t).length;
  if (n === 0) return 0;
  // 9-24 words is the band a spoken hook lands in at ~150wpm inside 10 seconds
  if (n >= 9 && n <= 24) return 100;
  if (n < 9) return Math.max(30, 100 - (9 - n) * 11);
  return Math.max(10, 100 - (n - 24) * 7);
}

const PROPS: [HookProperty, (t: string) => number][] = [
  ['SPECIFICITY', specificity], ['ADDRESS', address], ['STAKES', stakes],
  ['CURIOSITY', curiosity], ['BREVITY', brevity],
];

function classify(t: string): { name: string; hits: number } {
  let best: string | null = null;
  let hits = 0;
  for (const f of FORMULAS) {
    const n = f.match.filter((p) => p.test(t)).length;
    if (n > hits) { best = f.name; hits = n; }
  }
  return { name: best ?? 'Unclassified', hits };
}

const band = (v: number): HookScore['band'] => (v >= 72 ? 'STRONG' : v >= 55 ? 'WORKABLE' : 'WEAK');

export function scoreHook(text: string): HookScore {
  const properties = {} as Record<HookProperty, number>;
  for (const [name, fn] of PROPS) properties[name] = fn(text);
  const vals = PROPS.map(([name]) => properties[name]);
  const verdict = roundHalfEven(0.6 * (vals.reduce((a, b) => a + b, 0) / vals.length) + 0.4 * Math.min(...vals));
  const { name, hits } = classify(text);
  // ties resolve to the first in PROPS order, like Python's min(parts, key=parts.get)
  const weakest = PROPS.reduce((lo, [n]) => (properties[n] < properties[lo] ? n : lo), PROPS[0][0]);
  return {
    hook: pyStrip(text),
    properties,
    verdict,
    band: band(verdict),
    formula: name,
    matched: hits,
    weakest,
    fix: FIX[weakest],
  };
}
