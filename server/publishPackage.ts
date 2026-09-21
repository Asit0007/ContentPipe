import type { GoogleGenAI } from '@google/genai';
import { TEXT_MODELS } from './gemini';
import { generateJson } from './llm/chain';
import { publishPackageSchema } from './schemas';
import { orFallback } from './strict';
import { analyzeScript, dossierSpecifics, extractSpecifics, isSupportedSpecific, formatTimestamp, type Chapter } from './timeline';

/**
 * Publish package (spec Prompt 6): titles, thumbnail concepts, description, tags.
 *
 * The model writes the creative text. Everything that can be *checked* is computed here
 * instead, so it can't be hallucinated and costs no quota: chapters and mid-roll
 * timestamps come from the script's timeline, the sources list is built only from URLs
 * that were actually retrieved, titles and thumbnail copy are linted against the spec's
 * rules, and the recommendation is chosen by the linter rather than by the model.
 */

export interface LintIssue {
  rule: string;
  severity: 'error' | 'warn' | 'info';
  message: string;
}

const TITLE_HARD_MAX = 70;
const TITLE_IDEAL_MIN = 45;
const TITLE_IDEAL_MAX = 60;
const TITLE_MIN = 20;
const TITLE_KEYWORD_WINDOW = 30;
/** Words the spec bans outright in titles. */
const BANNED_TITLE_PHRASES = [
  "you won't believe", 'you wont believe', 'shocking', 'gone wrong', 'insane', 'you need to see', 'must watch', 'this changes everything',
  'hackers hate', 'destroyed', 'will blow your mind',
];
/** Uppercase runs up to this long read as acronyms (CVE, DNS, SSH, XZ, NGINX); longer ones read as shouting. */
const MAX_ACRONYM_LETTERS = 5;
const TITLE_STOPWORDS = new Set(['the', 'and', 'for', 'with', 'into', 'from', 'that', 'this', 'how', 'why', 'inside', 'about', 'what']);

const EMOJI = /\p{Extended_Pictographic}/u;

export function lintTitle(title: string, opts: { topicTitle?: string; research?: any } = {}): LintIssue[] {
  const issues: LintIssue[] = [];
  const t = String(title || '').trim();
  const add = (rule: string, severity: LintIssue['severity'], message: string) => issues.push({ rule, severity, message });

  if (t.length > TITLE_HARD_MAX) add('too-long', 'error', `${t.length} characters; the hard maximum is ${TITLE_HARD_MAX}.`);
  else if (t.length < TITLE_MIN) add('too-short', 'warn', `${t.length} characters is too short to carry a keyword and a hook.`);
  else if (t.length < TITLE_IDEAL_MIN || t.length > TITLE_IDEAL_MAX) add('length-outside-ideal', 'info', `${t.length} characters; ${TITLE_IDEAL_MIN}-${TITLE_IDEAL_MAX} is ideal.`);

  const lower = t.toLowerCase();
  for (const phrase of BANNED_TITLE_PHRASES) if (lower.includes(phrase)) add('banned-phrase', 'error', `Contains "${phrase}" — the brief bans clickbait phrasing.`);
  if (EMOJI.test(t)) add('emoji', 'error', 'Titles carry no emoji.');
  if (t.includes('!')) add('exclamation', 'warn', 'Avoid exclamation marks; the tone is authoritative, not urgent-for-its-own-sake.');

  const shouting = (t.match(/[A-Za-z][A-Za-z0-9]*/g) || []).filter((w) => /[A-Z]{2}/.test(w) && w === w.toUpperCase() && /[A-Z]/.test(w) && w.replace(/[^A-Z]/g, '').length > MAX_ACRONYM_LETTERS);
  if (shouting.length) add('all-caps-word', 'warn', `All-caps word(s) ${shouting.map((w) => `"${w}"`).join(', ')}; fine only if it is a proper noun or acronym.`);

  const stray = (t.match(/\[[^\]]*\]/g) || []).filter((b) => !/^\[CVE-\d{4}-\d{4,7}\]$/.test(b));
  if (stray.length) add('brackets', 'warn', `Brackets are reserved for [CVE-XXXX-XXXX]; found ${stray.join(' ')}.`);

  // Numbers, ids and versions in a title are claims: they must come from the dossier.
  if (opts.research && Object.keys(opts.research).length) {
    const known = dossierSpecifics(opts.research);
    for (const token of extractSpecifics(t)) {
      if (!isSupportedSpecific(token, known)) add('unsupported-specific', 'error', `"${token}" does not appear in the research dossier; titles may not state figures the sources don't.`);
    }
  }

  const topic = (opts.topicTitle || opts.research?.topicTitle || '') as string;
  if (topic) {
    const hints = [...new Set((topic.toLowerCase().match(/[a-z0-9][a-z0-9/-]{2,}/g) || []).filter((w) => !TITLE_STOPWORDS.has(w)))].sort((a, b) => b.length - a.length).slice(0, 4);
    if (hints.length && !hints.some((h) => lower.slice(0, TITLE_KEYWORD_WINDOW).includes(h))) {
      add('keyword-not-front-loaded', 'info', `None of the story's key terms (${hints.join(', ')}) appear in the first ${TITLE_KEYWORD_WINDOW} characters.`);
    }
  }
  return issues;
}

const FORBIDDEN_THUMB_MOTIFS = ['skull', 'hoodie', 'hooded', 'matrix', 'code rain', 'red arrow', 'shocked face', 'padlock', 'hacker in a basement'];
const NEGATION = /\b(no|without|avoid|never|not|exclude)\b[^.]{0,20}$/i;
const MAX_OVERLAY_CHARS = 24; // readable at 320x180

export function lintThumbnail(t: { textOverlay: string; imagePrompt: string }): LintIssue[] {
  const issues: LintIssue[] = [];
  const overlay = String(t.textOverlay || '').trim();
  const words = overlay.split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 4) issues.push({ rule: 'overlay-word-count', severity: 'warn', message: `Overlay has ${words.length} word(s); the brief wants 2-4.` });
  if (overlay.length > MAX_OVERLAY_CHARS) issues.push({ rule: 'overlay-too-long', severity: 'warn', message: `${overlay.length} characters will not read at 320x180 (max ~${MAX_OVERLAY_CHARS}).` });
  if (/\bhacked\b/i.test(overlay)) issues.push({ rule: 'generic-hacked-text', severity: 'error', message: 'Generic "HACKED" overlay text is on the brief\'s avoid list.' });

  const prompt = String(t.imagePrompt || '');
  const lower = prompt.toLowerCase();
  for (const motif of FORBIDDEN_THUMB_MOTIFS) {
    let from = 0;
    for (let idx = lower.indexOf(motif, from); idx !== -1; idx = lower.indexOf(motif, from)) {
      from = idx + motif.length;
      if (!NEGATION.test(lower.slice(Math.max(0, idx - 24), idx))) {
        issues.push({ rule: 'forbidden-motif', severity: 'error', message: `Image prompt asks for "${motif}", which the brief bans (put it in a negative clause if needed).` });
        break;
      }
    }
  }
  return issues;
}

/** Hashtags: lowercase alphanumerics only, no leading '#', deduped, at most 5. */
export function normalizeHashtags(raw: string[]): string[] {
  const out: string[] = [];
  for (const h of raw || []) {
    const clean = String(h).toLowerCase().replace(/^#+/, '').replace(/[^a-z0-9]/g, '');
    if (clean && !out.includes(clean)) out.push(clean);
  }
  return out.slice(0, 5);
}

/** YouTube caps the combined length of tags (~500 chars); trim from the end, deduping case-insensitively. */
export function fitTags(raw: string[], maxChars = 500): string[] {
  const out: string[] = [];
  let used = 0;
  for (const tag of raw || []) {
    const t = String(tag).trim().replace(/^#+/, '');
    if (!t || out.some((o) => o.toLowerCase() === t.toLowerCase())) continue;
    const cost = t.length + (t.includes(' ') ? 2 : 0) + 1;
    if (used + cost > maxChars) break;
    out.push(t);
    used += cost;
  }
  return out;
}

export interface TitleCandidate {
  title: string;
  structure: string;
  angle: string;
  bestThumbnail: 'A' | 'B' | 'C';
  chars: number;
  lint: LintIssue[];
  /** No lint errors. Warnings and info do not disqualify a title. */
  passesLint: boolean;
}
export interface ThumbnailConcept {
  variant: 'A' | 'B' | 'C';
  concept: string;
  imagePrompt: string;
  textOverlay: string;
  layout: string;
  rationale: string;
  lint: LintIssue[];
}
/** Mirrors PublishPackage in src/types.ts — change both together. */
export interface PublishPackage {
  titles: TitleCandidate[];
  thumbnails: ThumbnailConcept[];
  recommendedTitle?: string;
  recommendedThumbnail?: 'A' | 'B' | 'C';
  description: string;
  descriptionWordCount: number;
  chapters: Chapter[];
  midrollTimestamps: string[];
  tags: string[];
  hashtags: string[];
  /** Things a human still has to do (unfilled placeholders, ineligible mid-roll, …). */
  todos: string[];
  /** True when the model was unavailable and only the deterministic parts were produced. */
  deterministicOnly?: boolean;
  isQuotaFallback?: boolean;
  generatedAt: string;
}

export interface PublishInput {
  script: any;
  research?: any;
  plan?: any;
  channelBrandName?: string;
}

function buildPrompt(input: PublishInput, feedback?: string): string {
  const { script, research, plan } = input;
  const facts = {
    topicTitle: research?.topicTitle,
    summary: research?.summary,
    keyFacts: research?.keyFacts,
    timeline: research?.timeline,
    sources: (research?.retrievedSources || []).filter((r: any) => r.ok).map((r: any) => ({ id: r.id, title: r.title })),
  };
  const outline = (script.chapters?.length ? script.chapters : []).map((c: Chapter) => `${c.timestamp} ${c.label}`);
  const beats = (script.scenes || []).slice(0, 60).map((s: any) => `${s.sceneNumber}. [${s.actPhase || ''}] ${s.title}${s.onScreenText ? ` — on-screen: ${s.onScreenText}` : ''}`);
  const style = script.styleGuide ? `Visual style to inherit: ${script.styleGuide.artDirection || ''} Palette: ${script.styleGuide.colorPalette || ''}` : '';

  return `You are a YouTube title and thumbnail strategist for an authoritative, investigative cybersecurity documentary channel${input.channelBrandName ? ` ("${input.channelBrandName}")` : ''}. Tone: measured and precise — no fearmongering, no clickbait. Optimise click-through honestly: never promise something the video does not deliver.

<facts>
${JSON.stringify(facts, null, 2)}
</facts>

<video>
Title of the script: ${script.title}
Tone: ${plan?.tone || script.tonePacing || ''}
Runtime: ${formatTimestamp(script.estimatedTotalDuration || 0)}
${outline.length ? `Chapters:\n${outline.join('\n')}\n` : ''}Scene outline:
${beats.join('\n')}
${style}
</video>

FACT DISCIPLINE: every figure, date, CVE id, version and entity name in any title, thumbnail text or description copy must appear in <facts>. If a detail is not there, leave it out.

Produce:
1. "titles": exactly 5, one per structure, each at most 70 characters (45-60 ideal), keyword first, no ALL-CAPS words except acronyms and proper nouns, no emoji, no exclamation marks, no "You won't believe" / "SHOCKING" / "GONE WRONG"; brackets only as [CVE-XXXX-XXXX].
   Structures: "how_entity_verb_object" = "How [Entity] [Verb] [Object] — [Consequence]"; "truth_about" = "The [Adjective] Truth About [Topic]"; "inside_event" = "Inside [Entity]'s [Event]: [Technical Detail]"; "why_concept_is_stakes" = "Why [Technical Concept] Is [Stakes]"; "number_things_got_wrong" = "[Number] [Things] [Entity] Got Wrong About [Topic]" (only if the number is in <facts>; otherwise still use this structure without a specific number). For each: "angle" (one sentence on the CTR angle) and "bestThumbnail" (A, B or C).
2. "thumbnails": exactly 3 concepts. A = Technical (the attack chain or architecture), B = Consequence (what broke, who was affected), C = Curiosity gap (an unresolved tension or counter-intuitive fact). For each: "variant", "concept" (2-3 word name), "imagePrompt" (ready to paste into an image model; include the visual style above; a single subject; dark background with a rim light), "textOverlay" (2-4 words, all caps, readable at 320x180), "layout" (subject on one third, text on the opposite third), "rationale" (one sentence). Never use red arrows, shocked faces, skulls, hoodies, Matrix code rain, generic "HACKED" text, padlock clichés, or cluttered collages.
3. "descriptionHook": the opening of the description — 3-4 sentences, about 60-90 words. The first two lines appear in search results, so they must state the concrete claim; no hype.
4. "learnBullets": 4-5 bullets, each a full sentence of about 12-20 words, on what the viewer will understand by the end.
5. "tags": 15-25 (broad, specific to this story, long-tail how-to-prevent phrases).
6. "hashtags": 3-5, lowercase, no spaces.${feedback ? `\n\nA previous attempt failed these checks; fix them:\n${feedback}` : ''}`;
}

/** Description built from the model's hook/bullets plus only things that are true: real chapters, real URLs. */
export function assembleDescription(parts: {
  hook: string;
  bullets: string[];
  chapters: Chapter[];
  research?: any;
  brand?: string;
  hashtags: string[];
}): { description: string; todos: string[] } {
  const todos: string[] = [];
  const lines: string[] = [parts.hook.trim(), ''];
  if (parts.bullets.length) {
    lines.push('In this video:', ...parts.bullets.map((b) => `• ${b.trim()}`), '');
  }
  if (parts.chapters.length >= 3) {
    lines.push('Chapters:', ...parts.chapters.map((c) => `${c.timestamp} ${c.label}`), '');
  } else {
    todos.push('No chapters were generated (need at least 3 chapters of 10s+ on a 3+ minute video); add timestamps by hand if wanted.');
  }
  const sources = (parts.research?.retrievedSources || []).filter((r: any) => r.ok).slice(0, 5);
  if (sources.length) {
    lines.push('Sources & further reading:', ...sources.map((r: any) => `• ${r.title || r.url} — ${r.url}`), '');
  } else {
    todos.push('No sources were retrieved, so the description has no sources list. Add real links before publishing.');
  }
  lines.push(
    `${parts.brand ? `Subscribe to ${parts.brand} for the next breakdown.` : 'Subscribe for the next breakdown.'}`,
    'Newsletter: {{NEWSLETTER_URL}}',
    'X / Twitter: {{X_HANDLE}}',
    'LinkedIn: {{LINKEDIN_URL}}',
    ''
  );
  if (parts.hashtags.length) lines.push(parts.hashtags.map((h) => `#${h}`).join(' '));
  const description = lines.join('\n').trim();
  for (const ph of new Set(description.match(/\{\{[A-Z_]+\}\}/g) || [])) todos.push(`Fill in ${ph} — the pipeline does not know your links and will not invent them.`);
  return { description, todos };
}

function deterministicParts(input: PublishInput) {
  const analysis = input.script.chapters && input.script.midrollMarkers ? { chapters: input.script.chapters, midrollMarkers: input.script.midrollMarkers, qualityChecks: input.script.qualityChecks || [] } : analyzeScript(input.script, { research: input.research });
  const todos: string[] = [];
  const ineligible = (analysis.qualityChecks as any[]).find((c) => c.id === 'midroll-ineligible');
  if (ineligible) todos.push(ineligible.message);
  return { chapters: analysis.chapters as Chapter[], midrollTimestamps: (analysis.midrollMarkers as any[]).map((m) => m.timestamp as string), todos };
}

function lintAll(raw: any, input: PublishInput) {
  const titles: TitleCandidate[] = (Array.isArray(raw?.titles) ? raw.titles : []).map((t: any) => {
    const lint = lintTitle(t.title, { research: input.research });
    return { title: String(t.title || '').trim(), structure: t.structure, angle: t.angle, bestThumbnail: t.bestThumbnail, chars: String(t.title || '').trim().length, lint, passesLint: !lint.some((i) => i.severity === 'error') };
  });
  const thumbnails: ThumbnailConcept[] = (Array.isArray(raw?.thumbnails) ? raw.thumbnails : []).map((t: any) => ({ ...t, lint: lintThumbnail(t) }));
  return { titles, thumbnails };
}

const MIN_PASSING_TITLES = 3;

function feedbackFor(titles: TitleCandidate[], thumbnails: ThumbnailConcept[]): string {
  const lines: string[] = [];
  for (const t of titles) for (const i of t.lint.filter((x) => x.severity === 'error')) lines.push(`- Title "${t.title}": ${i.message}`);
  for (const t of thumbnails) for (const i of t.lint.filter((x) => x.severity === 'error')) lines.push(`- Thumbnail ${t.variant}: ${i.message}`);
  return lines.join('\n');
}

/** Recommendation is the linter's, not the model's: the passing title nearest the ideal length band. */
function recommend(titles: TitleCandidate[]): TitleCandidate | undefined {
  const passing = titles.filter((t) => t.passesLint);
  const distance = (t: TitleCandidate) => (t.chars < TITLE_IDEAL_MIN ? TITLE_IDEAL_MIN - t.chars : t.chars > TITLE_IDEAL_MAX ? t.chars - TITLE_IDEAL_MAX : 0);
  const warnCount = (t: TitleCandidate) => t.lint.filter((i) => i.severity === 'warn').length;
  return [...passing].sort((a, b) => warnCount(a) - warnCount(b) || distance(a) - distance(b))[0];
}

/**
 * Builds the package. With `strict`, a model failure throws (the endpoint turns it into
 * 429/503/502); otherwise the caller still gets the deterministic parts, clearly flagged.
 */
export async function buildPublishPackage(ai: GoogleGenAI, input: PublishInput, opts: { strict?: boolean } = {}): Promise<PublishPackage> {
  const det = deterministicParts(input);
  const generatedAt = new Date().toISOString();

  const generated = await orFallback<any | null>(
    !!opts.strict,
    async () => {
      let raw: any = await generateJson(ai, buildPrompt(input), 'You write precise, honest YouTube packaging for a cybersecurity documentary channel. Output strictly valid JSON matching the schema.', TEXT_MODELS, publishPackageSchema);
      let linted = lintAll(raw, input);
      if (linted.titles.filter((t) => t.passesLint).length < MIN_PASSING_TITLES) {
        // One retry, telling the model exactly which rules it broke.
        try {
          const retry: any = await generateJson(ai, buildPrompt(input, feedbackFor(linted.titles, linted.thumbnails)), 'You write precise, honest YouTube packaging for a cybersecurity documentary channel. Output strictly valid JSON matching the schema.', TEXT_MODELS, publishPackageSchema);
          const relinted = lintAll(retry, input);
          if (relinted.titles.filter((t) => t.passesLint).length >= linted.titles.filter((t) => t.passesLint).length) {
            raw = retry;
            linted = relinted;
          }
        } catch (err) {
          if (opts.strict) throw err; // retryable failures still surface to strict callers
        }
      }
      return { raw, ...linted };
    },
    () => null
  );

  if (!generated) {
    const { description, todos } = assembleDescription({ hook: String(input.research?.oneLineHook || input.script.title || ''), bullets: [], chapters: det.chapters, research: input.research, brand: input.channelBrandName, hashtags: [] });
    return {
      titles: [], thumbnails: [], description, descriptionWordCount: description.split(/\s+/).filter(Boolean).length, chapters: det.chapters, midrollTimestamps: det.midrollTimestamps,
      tags: [], hashtags: [], todos: ['AI generation was unavailable: no titles, thumbnails or tags were produced — only the deterministic parts below.', ...det.todos, ...todos],
      deterministicOnly: true, isQuotaFallback: true, generatedAt,
    };
  }

  const { raw, titles, thumbnails } = generated;
  const hashtags = normalizeHashtags(raw.hashtags);
  const { description, todos } = assembleDescription({ hook: String(raw.descriptionHook || ''), bullets: (raw.learnBullets || []).map(String), chapters: det.chapters, research: input.research, brand: input.channelBrandName, hashtags });
  const best = recommend(titles);
  const extra: string[] = [];
  if (!best) extra.push('No title passed the lint rules; write one by hand or regenerate.');
  const words = description.split(/\s+/).filter(Boolean).length;
  if (words < 200 || words > 400) extra.push(`Description is ${words} words; the brief targets 200-400.`);

  return {
    titles, thumbnails,
    ...(best ? { recommendedTitle: best.title, recommendedThumbnail: best.bestThumbnail } : {}),
    description, descriptionWordCount: words, chapters: det.chapters, midrollTimestamps: det.midrollTimestamps,
    tags: fitTags((raw.tags || []).map(String)), hashtags, todos: [...det.todos, ...todos, ...extra], generatedAt,
  };
}
