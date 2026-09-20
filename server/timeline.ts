/**
 * Deterministic timeline, mid-roll placement and retention/compliance audit.
 *
 * Pure functions over a finished script — no model call, so they cost no quota, can't
 * hallucinate, and are unit-tested. The spec (cyberpipeline-prompts.md) asks for
 * things a scene list alone doesn't state: chapter timestamps, two manually placed
 * mid-rolls at ~2:30 and ~6:00 ("right after the problem is set up" / "right before
 * the fix is revealed"), a visual pattern interrupt every 20-30 s, and a real mix of
 * evidence rather than a slideshow of AI stills. CyberPipe used to recompute mid-rolls
 * on its own with none of the eligibility or placement rules below.
 *
 * Every threshold is a named constant so it can be tuned in one place. They encode the
 * spec's targets, not measured truths.
 */

export type Severity = 'error' | 'warn' | 'info';

export interface QualityCheck {
  id: string;
  severity: Severity;
  message: string;
  sceneNumbers?: number[];
}
export interface TimelineEntry {
  sceneNumber: number;
  startSec: number;
  endSec: number;
}
export interface Chapter {
  startSec: number;
  timestamp: string;
  label: string;
}
export interface MidrollMarker {
  /** 1 = after the problem is set up, 2 = before the fix / conclusion. */
  index: 1 | 2;
  targetSec: number;
  afterSceneNumber: number;
  atSec: number;
  timestamp: string;
  reason: string;
}
export interface ScriptAnalysis {
  timeline: TimelineEntry[];
  chapters: Chapter[];
  midrollMarkers: MidrollMarker[];
  qualityChecks: QualityCheck[];
}

/** Below this, chapters and mid-roll advice are noise (Shorts, teasers). */
export const LONG_FORM_MIN_SEC = 180;
/** YouTube offers manual mid-roll placement only on videos of at least 8 minutes — verify against current policy. */
export const MIDROLL_MIN_VIDEO_SEC = 480;
export const MIDROLL_TARGETS_SEC = [150, 360] as const;
const MIDROLL_WINDOW_SEC = 25;
const MIDROLL_MIN_GAP_SEC = 60;
const MIDROLL_MIN_FROM_START_SEC = 30;
const MIDROLL_MIN_FROM_END_SEC = 60;
/** A semantically right boundary beats a nearer one by up to this many seconds of distance. */
const MIDROLL_SEMANTIC_BONUS_SEC = 12;
const MIN_CHAPTER_SEC = 10;
const MIN_CHAPTERS = 3;
const MAX_CHAPTERS = 12;
/** The spec's "pattern interrupt every 20-30 s". */
const MAX_UNCHANGED_RUN_SEC = 30;
const MIN_SCENE_WPM = 110;
const MAX_SCENE_WPM = 190;
const MIN_EVIDENCE_SCENE_SHARE = 0.4;
const DURATION_SHORTFALL_ERROR_RATIO = 0.85;
const DURATION_OVERSHOOT_WARN_RATIO = 1.25;
const EVIDENCE_VISUAL_TYPES = new Set(['terminal', 'diagram', 'headline']);

const PROBLEM_SETUP_PHASE = /\b(hook|context|background|set-?up|incident|what happened|the problem|discovery)\b/i;
const FIX_PHASE = /\b(fix|remediat\w*|mitigat\w*|defen[cs]e|prevent\w*|resolution|conclusion|takeaway|what to do)\b/i;

const pad = (n: number) => String(n).padStart(2, '0');

export function formatTimestamp(totalSec: number): string {
  const s = Math.max(0, Math.round(totalSec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

const dur = (scene: any): number => Number(scene?.durationEst) || 0;
const wordsOf = (scene: any): number => String(scene?.narration || '').split(/\s+/).filter(Boolean).length;

export function buildTimeline(scenes: any[]): TimelineEntry[] {
  let t = 0;
  return scenes.map((s, i) => {
    const entry = { sceneNumber: Number(s?.sceneNumber) || i + 1, startSec: t, endSec: t + dur(s) };
    t += dur(s);
    return entry;
  });
}

export function buildChapters(scenes: any[], timeline: TimelineEntry[]): Chapter[] {
  const total = timeline.length ? timeline[timeline.length - 1].endSec : 0;
  if (total < LONG_FORM_MIN_SEC) return [];

  interface Group {
    label: string;
    key: string;
    start: number;
    end: number;
  }
  const groups: Group[] = [];
  scenes.forEach((s, i) => {
    const label = String(s?.actPhase || '').trim() || (i === 0 ? 'Hook' : 'Development');
    const key = label.toLowerCase();
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.end = timeline[i].endSec;
    else groups.push({ label, key, start: timeline[i].startSec, end: timeline[i].endSec });
  });

  // Merge `groups[i]` into a neighbour; the first group is absorbed forward so chapter 1 still starts at 0:00.
  const absorb = (i: number) => {
    if (i > 0) {
      groups[i - 1].end = groups[i].end;
      groups.splice(i, 1);
    } else {
      groups[1].start = groups[0].start;
      groups.splice(0, 1);
    }
  };
  // YouTube needs each chapter ≥10 s…
  for (let i = 0; i < groups.length && groups.length > 1; ) {
    if (groups[i].end - groups[i].start < MIN_CHAPTER_SEC) absorb(i);
    else i++;
  }
  // …and a viewer-usable list is short: fold the shortest chapter away until it fits.
  while (groups.length > MAX_CHAPTERS) {
    let shortest = 0;
    groups.forEach((g, i) => {
      if (g.end - g.start < groups[shortest].end - groups[shortest].start) shortest = i;
    });
    absorb(shortest);
  }

  if (groups.length < MIN_CHAPTERS) return [];
  return groups.map((g) => ({ startSec: g.start, timestamp: formatTimestamp(g.start), label: g.label }));
}

export function placeMidrolls(scenes: any[], timeline: TimelineEntry[]): { markers: MidrollMarker[]; checks: QualityCheck[] } {
  const checks: QualityCheck[] = [];
  const total = timeline.length ? timeline[timeline.length - 1].endSec : 0;
  if (total < LONG_FORM_MIN_SEC) return { markers: [], checks };

  if (total < MIDROLL_MIN_VIDEO_SEC) {
    checks.push({
      id: 'midroll-ineligible',
      severity: 'warn',
      message: `Runtime is ${formatTimestamp(total)}, under ${formatTimestamp(MIDROLL_MIN_VIDEO_SEC)}: manual mid-roll ads are not available on videos this short (verify against YouTube's current rule). Extend the script or plan for pre/post-roll only.`,
    });
    return { markers: [], checks };
  }

  // A boundary is "after scene i". Never after the last scene, never in the opening or closing stretch.
  const boundaries = timeline
    .map((e, i) => ({ i, atSec: e.endSec }))
    .filter((b) => b.i < scenes.length - 1 && b.atSec >= MIDROLL_MIN_FROM_START_SEC && b.atSec <= total - MIDROLL_MIN_FROM_END_SEC);

  const markers: MidrollMarker[] = [];
  MIDROLL_TARGETS_SEC.forEach((target, k) => {
    const index = (k + 1) as 1 | 2;
    const taken = markers.map((m) => m.atSec);
    const isSemantic = (i: number) =>
      index === 1 ? PROBLEM_SETUP_PHASE.test(String(scenes[i]?.actPhase || '')) : FIX_PHASE.test(String(scenes[i + 1]?.actPhase || ''));
    const eligible = boundaries.filter((b) => taken.every((t) => Math.abs(b.atSec - t) >= MIDROLL_MIN_GAP_SEC));
    const score = (b: { i: number; atSec: number }) => Math.abs(b.atSec - target) - (isSemantic(b.i) ? MIDROLL_SEMANTIC_BONUS_SEC : 0);

    const inWindow = eligible.filter((b) => Math.abs(b.atSec - target) <= MIDROLL_WINDOW_SEC);
    const pool = inWindow.length ? inWindow : eligible;
    if (pool.length === 0) {
      checks.push({ id: `midroll-${index}-unplaceable`, severity: 'warn', message: `No usable scene boundary exists for mid-roll #${index} (target ${formatTimestamp(target)}).` });
      return;
    }
    const best = pool.reduce((a, b) => (score(b) < score(a) ? b : a));
    const scene = scenes[best.i];
    const semantic = isSemantic(best.i);
    markers.push({
      index,
      targetSec: target,
      afterSceneNumber: timeline[best.i].sceneNumber,
      atSec: best.atSec,
      timestamp: formatTimestamp(best.atSec),
      reason:
        `After scene ${timeline[best.i].sceneNumber} "${scene?.title || ''}"${scene?.actPhase ? ` (${scene.actPhase})` : ''}, ` +
        `${Math.abs(best.atSec - target)}s from the ${formatTimestamp(target)} target` +
        (semantic
          ? index === 1
            ? '; the problem is set up just before this cut.'
            : `; the next scene "${scenes[best.i + 1]?.actPhase}" delivers the fix/conclusion.`
          : '.'),
    });
    if (!inWindow.length) {
      checks.push({
        id: `midroll-${index}-off-target`,
        severity: 'info',
        message: `No scene boundary within ±${MIDROLL_WINDOW_SEC}s of ${formatTimestamp(target)}; mid-roll #${index} uses the nearest allowed one (${formatTimestamp(best.atSec)}).`,
      });
    }
  });
  return { markers, checks };
}

// ---- specifics that must trace to the dossier ---------------------------------------------------------

// A "specific" is a figure a viewer would repeat: a CVE id, a percentage, a dollar amount, a count or size,
// a version. Each is parsed into a canonical key (`pct:83.5`, `usd:1500000000`, `ver:5.6.1`, ...) and compared
// as a whole token. The first version squashed the dossier to `[a-z0-9.]` and used `includes()`, so "45%" was
// "supported" by 2045, CVE-2024-3094 by CVE-2024-30945 and 5.6.1 by 5.6.10, and "$5" + "million users" in two
// unrelated facts read as "5million".

const DASHES = '\\u2010-\\u2015\\u2212'; // hyphen, non-breaking hyphen, en/em dash, minus: models emit all of them in CVE ids
const NUM = String.raw`(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?`;
const SCALE = 'trillion|billion|million|thousand';
const UNIT = 'users|devices|servers|records|customers|gb|tb|mb';
const NOT_INSIDE_A_NUMBER = String.raw`(?<![\d,.])`;

// One pass, first alternative wins at a given position, so "$5 million" is one token rather than also
// yielding "5 million", and "1,200,000" is never split at its own comma.
const SPECIFIC_RE = new RegExp(
  [
    String.raw`\bCVE[-${DASHES}]\d{4}[-${DASHES}]\d{4,7}(?!\d)`,
    String.raw`\$\s?${NUM}(?:\s?(?:${SCALE}|[kmb]n?)\b)?`,
    String.raw`${NOT_INSIDE_A_NUMBER}${NUM}(?:\s?(?:${SCALE}))?\s?(?:dollars|usd)\b`,
    String.raw`${NOT_INSIDE_A_NUMBER}${NUM}\s?(?:%|percent\b|per cent\b)`,
    String.raw`(?<![\w.])v?\d+\.\d+(?:\.\d+)+\b`,
    String.raw`${NOT_INSIDE_A_NUMBER}(?:\d{1,3}(?:,\d{3})+(?:\.\d+)?(?:\s?(?:${SCALE}))?(?:\s?(?:${UNIT}))?` +
      String.raw`|\d+(?:\.\d+)?\s?(?:${SCALE})(?:\s?(?:${UNIT}))?` +
      String.raw`|\d+(?:\.\d+)?\s?(?:${UNIT}))\b`,
  ].join('|'),
  'gi',
);

export function extractSpecifics(text: string): string[] {
  const found = new Set<string>();
  for (const m of String(text || '').matchAll(SPECIFIC_RE)) found.add(m[0].trim());
  return [...found];
}

const SCALE_MULTIPLIER: Record<string, number> = { thousand: 1e3, k: 1e3, million: 1e6, m: 1e6, mn: 1e6, billion: 1e9, b: 1e9, bn: 1e9, trillion: 1e12 };
// toPrecision first: 1.1 * 1e3 is 1100.0000000000002 in floating point.
const value = (n: string, scale?: string) => String(Number((parseFloat(n.replace(/,/g, '')) * (SCALE_MULTIPLIER[scale || ''] ?? 1)).toPrecision(15)));

const KEY_USD_SYMBOL = new RegExp(String.raw`^\$\s?(${NUM})(?:\s?(${SCALE}|[kmb]n?))?$`);
const KEY_USD_WORD = new RegExp(String.raw`^(${NUM})(?:\s?(${SCALE}))?\s?(?:dollars|usd)$`);
const KEY_PERCENT = new RegExp(String.raw`^(${NUM})\s?(?:%|percent|per cent)$`);
const KEY_COUNT = new RegExp(String.raw`^(${NUM})(?:\s?(${SCALE}))?(?:\s?(${UNIT}))?$`);

/**
 * The claim a token makes, independent of how it is written: "v5.6.1" = "5.6.1", "83 percent" = "83%",
 * "$1.5B" = "$1.5 billion", "1,200,000" = "1.2 million". The kind is part of the key (a % is not a $) and so is
 * a named unit (5 GB is not 5 TB).
 */
export function specificKey(token: string): string {
  const t = token.trim().toLowerCase().replace(new RegExp(`[${DASHES}]`, 'g'), '-');
  if (t.startsWith('cve-')) return t;
  const ver = /^v?(\d+(?:\.\d+){2,})$/.exec(t);
  if (ver) return `ver:${ver[1]}`;
  let m: RegExpExecArray | null;
  if ((m = KEY_USD_SYMBOL.exec(t)) || (m = KEY_USD_WORD.exec(t))) return `usd:${value(m[1], m[2])}`;
  if ((m = KEY_PERCENT.exec(t))) return `pct:${value(m[1])}`;
  if ((m = KEY_COUNT.exec(t))) return `num:${value(m[1], m[2])}${m[3] ? `:${m[3]}` : ''}`;
  return `raw:${t}`;
}

/** Every specific the dossier states, as keys. Extracted field by field so a figure can't be assembled across two facts. */
export function dossierSpecifics(research: any): Set<string> {
  const fields: unknown[] = [
    research?.topicTitle,
    research?.oneLineHook,
    research?.summary,
    research?.coreTechExplanation,
    ...(research?.keyFacts || []),
    ...(research?.timeline || []).flatMap((t: any) => [t?.dateOrPhase, t?.event]),
    ...(research?.factCitations || []).map((f: any) => f?.fact),
  ];
  const keys = new Set<string>();
  for (const field of fields) {
    for (const token of extractSpecifics(typeof field === 'string' ? field : '')) {
      const key = specificKey(token);
      keys.add(key);
      const unit = /^num:([^:]+):/.exec(key);
      if (unit) keys.add(`numv:${unit[1]}`); // the same figure with its unit dropped, for narration that omits the unit
    }
  }
  return keys;
}

/**
 * Whether the dossier states this token. The unit vocabulary is small, so a dossier that says "5 million" and
 * narration that says "5 million devices" is not a contradiction; a dossier that says "5 million devices" and
 * narration that says "5 million servers" is.
 */
export function isSupportedSpecific(token: string, dossier: Set<string>): boolean {
  const key = specificKey(token);
  if (dossier.has(key)) return true;
  const named = /^num:([^:]+):/.exec(key);
  if (named) return dossier.has(`num:${named[1]}`);
  return key.startsWith('num:') && dossier.has(`numv:${key.slice(4)}`);
}

/**
 * Text a viewer reads on screen, one string per field so a figure can't straddle two of them. Code snippets are
 * left out on purpose: terminal lines are illustrative and full of addresses and flags that look like versions.
 */
export function onScreenTexts(scene: any): string[] {
  const g = scene?.infographic;
  return [
    scene?.onScreenText,
    g?.title,
    g?.badge,
    g?.summary,
    ...(g?.steps || []).flatMap((s: any) => [s?.label, s?.detail]),
    ...(g?.metrics || []).flatMap((m: any) => [m?.label, m?.value, m?.subtext]),
  ]
    .filter((x) => x !== undefined && x !== null && x !== '')
    .map(String);
}

// ---- audit ---------------------------------------------------------------------------------------------------

export function auditScript(script: any, opts: { requestedDurationSec?: number; research?: any } = {}): QualityCheck[] {
  const scenes: any[] = Array.isArray(script?.scenes) ? script.scenes : [];
  const checks: QualityCheck[] = [];
  if (scenes.length === 0) return checks;
  const timeline = buildTimeline(scenes);
  const total = timeline[timeline.length - 1].endSec;
  const sn = (i: number) => timeline[i].sceneNumber;
  const longForm = total >= LONG_FORM_MIN_SEC;

  if (script?.isQuotaFallback) {
    checks.push({ id: 'canned-content', severity: 'error', message: 'This script is canned fallback content, not a real draft — AI generation was unavailable.' });
  }
  const degraded: string[] = script?.generation?.degraded || [];
  if (script?.generation && script.generation.complete === false && !script?.isQuotaFallback) {
    checks.push({ id: 'generation-incomplete', severity: 'error', message: `Script generation was incomplete: ${degraded.join(' ') || 'fewer scenes than requested.'}` });
  }

  if (opts.requestedDurationSec && opts.requestedDurationSec > 0) {
    const ratio = total / opts.requestedDurationSec;
    if (ratio < DURATION_SHORTFALL_ERROR_RATIO) {
      checks.push({ id: 'duration-shortfall', severity: 'error', message: `Runtime is ${formatTimestamp(total)} against a ${formatTimestamp(opts.requestedDurationSec)} target (${Math.round(ratio * 100)}%).` });
    } else if (ratio > DURATION_OVERSHOOT_WARN_RATIO) {
      checks.push({ id: 'duration-overshoot', severity: 'warn', message: `Runtime is ${formatTimestamp(total)} against a ${formatTimestamp(opts.requestedDurationSec)} target (${Math.round(ratio * 100)}%).` });
    }
  }

  // Opening: the spec wants a hook immediately — no logo intro, no long title card.
  if (String(script?.signatureIntro || '').trim()) {
    checks.push({ id: 'intro-line-present', severity: 'warn', message: `The script carries an intro line ("${String(script.signatureIntro).slice(0, 60)}"). The spec wants no logo/intro: open on the hook.` });
  }
  if (wordsOf(scenes[0]) < 8) {
    checks.push({ id: 'weak-opening', severity: 'warn', message: 'The first scene has almost no narration; the first seconds must carry the hook.', sceneNumbers: [sn(0)] });
  }

  // Pattern interrupts: a scene "interrupts" if it changes visualType from the previous scene or carries an infographic.
  if (longForm) {
    let runStart = 0;
    const flagged: number[] = [];
    for (let i = 1; i <= scenes.length; i++) {
      const interrupts = i < scenes.length && (scenes[i].infographic || scenes[i].visualType !== scenes[i - 1].visualType);
      if (i === scenes.length || interrupts) {
        const runSec = timeline[i - 1].endSec - timeline[runStart].startSec;
        if (runSec > MAX_UNCHANGED_RUN_SEC && i - runStart >= 2) for (let k = runStart; k < i; k++) flagged.push(sn(k));
        runStart = i;
      }
    }
    if (flagged.length) {
      checks.push({
        id: 'no-pattern-interrupt',
        severity: 'warn',
        message: `Stretches longer than ${MAX_UNCHANGED_RUN_SEC}s repeat the same visual type with no infographic, which is the retention risk the 20-30s pattern-interrupt rule targets.`,
        sceneNumbers: flagged,
      });
    }
  }

  const tooFast: number[] = [];
  const tooSlow: number[] = [];
  scenes.forEach((s, i) => {
    const d = dur(s);
    if (!d) return;
    const wpm = (wordsOf(s) / d) * 60;
    if (wpm > MAX_SCENE_WPM) tooFast.push(sn(i));
    else if (wpm < MIN_SCENE_WPM) tooSlow.push(sn(i));
  });
  if (tooFast.length) checks.push({ id: 'narration-overruns-scene', severity: 'warn', message: `Narration exceeds ${MAX_SCENE_WPM} wpm for its scene duration; the read will overrun the cut.`, sceneNumbers: tooFast });
  if (tooSlow.length) checks.push({ id: 'narration-underfills-scene', severity: 'info', message: `Narration is under ${MIN_SCENE_WPM} wpm for its scene duration; expect dead air.`, sceneNumbers: tooSlow });

  // Evidence mix: the spec bans a slideshow of AI stills.
  if (longForm) {
    const evidence = scenes.filter((s) => s.infographic || EVIDENCE_VISUAL_TYPES.has(s.visualType));
    const share = evidence.length / scenes.length;
    if (evidence.length === 0) {
      checks.push({ id: 'ai-slideshow-risk', severity: 'error', message: 'No scene is planned as terminal/diagram/headline/infographic evidence. A run of AI stills is the pattern flagged as low-effort; plan real screenshots, repo b-roll and data graphs.' });
    } else if (share < MIN_EVIDENCE_SCENE_SHARE) {
      checks.push({ id: 'thin-evidence-mix', severity: 'warn', message: `Only ${Math.round(share * 100)}% of scenes are evidence-type (terminal/diagram/headline/infographic); the spec's mix is a floor of ${Math.round(MIN_EVIDENCE_SCENE_SHARE * 100)}%.` });
    }
  }

  // Specifics must trace to the dossier; anything else is the model's own addition. Narration and on-screen
  // text are both checked: a figure in an infographic badge is read as a claim just like a spoken one.
  const research = opts.research;
  const hasSources = (research?.retrievedSources || []).some((r: any) => r.ok);
  if (research && Object.keys(research).length > 0) {
    const known = dossierSpecifics(research);
    // One entry per distinct figure — a wrong CVE repeated across 47 scenes is one problem, not 47.
    const unsupported = new Map<string, { token: string; scenes: number[]; spoken: boolean; shown: boolean }>();
    const uncited: number[] = [];
    scenes.forEach((s, i) => {
      const spoken = extractSpecifics(String(s.narration || ''));
      const shown = onScreenTexts(s).flatMap(extractSpecifics);
      for (const [tokens, isSpoken] of [[spoken, true], [shown, false]] as const) {
        for (const token of tokens) {
          if (isSupportedSpecific(token, known)) continue;
          const key = specificKey(token);
          const entry = unsupported.get(key) || { token, scenes: [], spoken: false, shown: false };
          if (!entry.scenes.includes(sn(i))) entry.scenes.push(sn(i));
          if (isSpoken) entry.spoken = true;
          else entry.shown = true;
          unsupported.set(key, entry);
        }
      }
      if (hasSources && (spoken.length || shown.length) && !(s.citations || []).length) uncited.push(sn(i));
    });
    if (unsupported.size) {
      const where = (e: { scenes: number[]; spoken: boolean; shown: boolean }) => {
        const n = e.scenes;
        const scenesText = n.length === 1 ? `scene ${n[0]}` : `scenes ${n.slice(0, 3).join(', ')}${n.length > 3 ? `, +${n.length - 3} more` : ''}`;
        return e.shown ? `${scenesText}, ${e.spoken ? 'narration and ' : ''}on screen` : scenesText;
      };
      const entries = [...unsupported.values()].map((e) => `"${e.token}" (${where(e)})`);
      checks.push({
        id: 'unsupported-specifics',
        severity: 'warn',
        message: `Narration or on-screen text states specifics that do not appear in the research dossier — verify each against a source before publishing: ${entries.slice(0, 8).join(', ')}${entries.length > 8 ? `, +${entries.length - 8} more` : ''}.`,
        sceneNumbers: [...new Set([...unsupported.values()].flatMap((e) => e.scenes))].sort((a, b) => a - b),
      });
    }
    if (uncited.length) {
      checks.push({ id: 'uncited-specifics', severity: 'info', message: 'These scenes state figures/ids but carry no source citation.', sceneNumbers: uncited });
    }
  }
  return checks;
}

const SEVERITY_ORDER: Record<Severity, number> = { error: 0, warn: 1, info: 2 };

export function analyzeScript(script: any, opts: { requestedDurationSec?: number; research?: any } = {}): ScriptAnalysis {
  const scenes: any[] = Array.isArray(script?.scenes) ? script.scenes : [];
  const timeline = buildTimeline(scenes);
  const chapters = buildChapters(scenes, timeline);
  const { markers, checks: midrollChecks } = placeMidrolls(scenes, timeline);
  const qualityChecks = [...auditScript(script, opts), ...midrollChecks].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  return { timeline, chapters, midrollMarkers: markers, qualityChecks };
}
