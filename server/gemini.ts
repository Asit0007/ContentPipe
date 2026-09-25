import { GoogleGenAI } from '@google/genai';
import {
  classifyGeminiError,
  isQuotaKind,
  summarizeQuotaFailures,
  UpstreamUnavailableError,
  type ClassifiedError,
} from './quota';
import { noteModelAttempt, trackModelCall } from './llm/usage';
import type { ModelAttempt } from '../shared/modelUsage';

/** How the provenance panel names a classified failure. */
export function attemptOutcome(kind: ClassifiedError['kind'] | undefined, invalidOutput = false): ModelAttempt['outcome'] {
  if (invalidOutput) return 'invalid_output';
  if (kind === 'zero' || kind === 'per_day' || kind === 'per_minute') return 'quota';
  if (kind === 'transient') return 'overloaded';
  return 'error';
}

/** "HTTP 429 per_day" — the gist of a failure for the panel, never the error body. */
function attemptDetail(c: ClassifiedError, err: any): string {
  const status = c.status ?? err?.status;
  const retry = c.retryAfterSec ? `, retry in ${c.retryAfterSec}s` : '';
  if (c.kind === 'other') return `${status ? `HTTP ${status}: ` : ''}${String(err?.message || err).slice(0, 160)}`;
  return `${status ? `HTTP ${status} ` : ''}${c.kind.replace('_', '-')}${retry}`;
}

// Text model fallback chain, best-first. gemini-2.5-flash is intentionally
// absent: Google returns 404 "no longer available to new users" for it, so
// leading with it burned a guaranteed-failed call on every request.
//
// Newer models checked on 2026-09-24 (Artificial Analysis score in brackets) and NOT added, on evidence:
//  - gemini-3.5-flash-lite (22) FAILED the real script pipeline: a 67k-character runaway JSON string, then only 3 of
//    10 scenes. gemini-3-flash-preview (26) failed once too (narrative pass: 0 of 10 scenes after 233 s, cause not
//    captured) and 503'd on the next run. Nothing here times out or benches a Gemini model after a non-retryable
//    failure, so one slow failure costs minutes on every reach.
//  - gemini-3.8-flash (41) and gemini-3.5-flash (33) answer tiny calls but 503 "high demand" on the pipeline's large
//    ones, so they are unverified on our schemas. Re-run a real script on each when Gemini has capacity, then add them.
//  - The Pro and Omni models answer 429 "limit: 0" on the free tier.
// The free quota is about 20 requests/day PER MODEL, so every verified model added is another ~20 free calls a day.
export const TEXT_MODELS = ['gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.1-flash-lite'];

// Lazy initialization of GoogleGenAI
let aiClient: GoogleGenAI | null = null;
export function getAIClient(): GoogleGenAI {
  if (!aiClient) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.log('[AI Server] GEMINI_API_KEY not found in environment, fallback pipeline primed.');
    }
    aiClient = new GoogleGenAI({
      apiKey: apiKey || '',
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
  }
  return aiClient;
}

// Helper: Sleep for jittered retry
export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Longest single wait we will sit through inside one request before giving up on the chain. */
const MAX_WAIT_SEC = 45;
/** Total waiting one generateGeminiJson call may spend across its retry pass. */
const MAX_TOTAL_WAIT_SEC = 90;
/** A 5xx/overload usually clears within seconds; one short pause beats an instant give-up. */
const TRANSIENT_RETRY_WAIT_SEC = 8;
/**
 * A known-exhausted model is skipped (saving a guaranteed-failed call per
 * request) for its retryAfter, but never longer than this: if the operator
 * enables billing while the server is up, the stale cooldown must expire.
 */
const MAX_COOLDOWN_SEC = 1800;

const cooldowns = new Map<string, { until: number; c: ClassifiedError }>();

/** Test hook: cooldowns are process-global state. */
export function resetModelCooldowns(): void {
  cooldowns.clear();
}

function coolDown(model: string, c: ClassifiedError, nowMs: number): void {
  if (!isQuotaKind(c.kind)) return;
  const sec = c.kind === 'zero' ? MAX_COOLDOWN_SEC : Math.min(c.retryAfterSec ?? 60, MAX_COOLDOWN_SEC);
  cooldowns.set(model, { until: nowMs + sec * 1000, c });
}

/** Seconds worth waiting before one more pass over the chain, or undefined if waiting can't help. */
function worthWaitingSec(failures: ClassifiedError[]): number | undefined {
  const waits: number[] = [];
  for (const f of failures) {
    if (f.kind === 'transient') waits.push(TRANSIENT_RETRY_WAIT_SEC);
    else if (f.kind === 'per_minute') waits.push(f.retryAfterSec ?? 60);
  }
  if (waits.length === 0) return undefined; // only per_day / zero: hours away or never
  const soonest = Math.min(...waits);
  return soonest <= MAX_WAIT_SEC ? soonest : undefined;
}

export interface GeminiJsonOptions {
  /** Injected by tests so waits don't take real seconds. */
  sleep?: (ms: number) => Promise<unknown>;
  now?: () => number;
  /**
   * false: skip the wait-and-retry pass and throw after one pass over `models`. The pass is right when Gemini is
   * the last resort; in a model-ordered chain (LLM_MODEL_ORDER) Gemini is one tier among several and a busy
   * model should hand over to the next tier at once instead of costing every request up to 8 s.
   */
  retryPass?: boolean;
}

// Helper: Multi-tier resilient JSON generation
//
// Throws, by design, one of:
//   QuotaExhaustedError      every tier failed on quota (kind + retryAfterSec say when it can work)
//   UpstreamUnavailableError every tier failed on 5xx/overload, none on a request bug
//   the first non-retryable error (bad key, schema 400, unparseable output) — waiting won't fix it
export async function generateGeminiJson<T>(
  ai: GoogleGenAI,
  prompt: string,
  systemInstruction: string,
  models: string[] = TEXT_MODELS,
  responseSchema?: unknown,
  opts: GeminiJsonOptions = {}
): Promise<T> {
  return trackModelCall('json', () => geminiJsonAttempts<T>(ai, prompt, systemInstruction, models, responseSchema, opts));
}

async function geminiJsonAttempts<T>(
  ai: GoogleGenAI,
  prompt: string,
  systemInstruction: string,
  models: string[],
  responseSchema: unknown,
  opts: GeminiJsonOptions
): Promise<T> {
  const wait = opts.sleep ?? sleep;
  const now = opts.now ?? Date.now;
  let waitedSec = 0;
  let firstOtherErr: any = null;

  for (let pass = 0; pass < 2; pass++) {
    const failures: ClassifiedError[] = [];

    for (const model of models) {
      const cd = cooldowns.get(model);
      if (cd && cd.until > now()) {
        noteModelAttempt({ provider: 'gemini', model, outcome: 'skipped', detail: `cooling down after ${cd.c.kind.replace('_', '-')}` });
        failures.push({
          ...cd.c,
          retryAfterSec: cd.c.kind === 'zero' ? undefined : Math.ceil((cd.until - now()) / 1000),
        });
        continue;
      }
      const t0 = now();
      try {
        const response = await ai.models.generateContent({
          model,
          contents: prompt,
          config: {
            responseMimeType: 'application/json',
            // Constrains decoding to the schema, so the model cannot return prose
            // or a truncated object. Falls back to free-form JSON if unset.
            ...(responseSchema ? { responseSchema } : {}),
            systemInstruction,
          },
        });
        const fr = response?.candidates?.[0]?.finishReason;
        const um: any = response?.usageMetadata;
        console.log(`[Gemini Pipeline] ${model} finish=${fr} out=${um?.candidatesTokenCount} total=${um?.totalTokenCount}`);
        const raw = response?.text || '{}';
        const clean = raw.replace(/```json/g, '').replace(/```/g, '').trim();
        const parsed = JSON.parse(clean);
        // An empty object satisfies JSON.parse but is a failed generation, not a result.
        if (!parsed || typeof parsed !== 'object' || Object.keys(parsed).length === 0) {
          throw new Error(`${model} returned an empty JSON object`);
        }
        noteModelAttempt({
          provider: 'gemini',
          model,
          outcome: 'ok',
          ms: now() - t0,
          inputTokens: um?.promptTokenCount,
          outputTokens: um?.candidatesTokenCount,
        });
        return parsed;
      } catch (err: any) {
        const c = classifyGeminiError(err);
        noteModelAttempt({ provider: 'gemini', model, outcome: attemptOutcome(c.kind, err instanceof SyntaxError || /empty JSON object/.test(err?.message)), detail: attemptDetail(c, err), ms: now() - t0 });
        failures.push(c);
        coolDown(model, c, now());
        if (c.kind === 'other' && !firstOtherErr) firstOtherErr = err;
        console.warn(`[Gemini Pipeline] Model ${model} encountered notice:`, err?.message || err?.status || err);
        await wait(c.kind === 'other' ? 200 : 300);
      }
    }

    // Failures every tier shares and waiting cannot fix (bad key, rejected schema)
    // surface as themselves. But one tier's junk output or 404 must not mask other
    // tiers' quota/overload errors: those are retryable and dominate the outcome.
    const retryable = failures.filter((f) => f.kind !== 'other');
    if (retryable.length === 0) {
      throw firstOtherErr || new Error('No Gemini model tiers configured');
    }

    const waitSec = worthWaitingSec(retryable);
    if (pass === 0 && opts.retryPass !== false && waitSec !== undefined && waitedSec + waitSec <= MAX_TOTAL_WAIT_SEC) {
      console.warn(`[Gemini Pipeline] every tier busy — waiting ${waitSec}s, then retrying the chain once`);
      await wait(waitSec * 1000);
      waitedSec += waitSec;
      continue;
    }

    if (retryable.every((f) => isQuotaKind(f.kind))) {
      throw summarizeQuotaFailures(retryable);
    }
    const perMinute = retryable.filter((f) => f.kind === 'per_minute').map((f) => f.retryAfterSec ?? 60);
    throw new UpstreamUnavailableError(
      Math.min(30, ...perMinute),
      'Every Gemini model tier was overloaded or rate-limited; retry shortly.'
    );
  }
  // Loop always returns or throws; satisfies the compiler.
  throw new UpstreamUnavailableError(30, 'All model tiers exhausted');
}

// Helper: Multi-tier resilient Text generation. Returns the model that answered, not just the text: the chat panel
// used to credit the first model in the list whichever one actually replied.
export async function generateGeminiText(
  ai: GoogleGenAI,
  contents: any[],
  systemInstruction: string,
  models: string[] = TEXT_MODELS
): Promise<{ text: string; model: string }> {
  let lastErr: any = null;
  for (const model of models) {
    const t0 = Date.now();
    try {
      const response = await ai.models.generateContent({
        model,
        contents,
        config: {
          systemInstruction,
        },
      });
      if (response?.text) {
        const um: any = response?.usageMetadata;
        noteModelAttempt({ provider: 'gemini', model, outcome: 'ok', ms: Date.now() - t0, inputTokens: um?.promptTokenCount, outputTokens: um?.candidatesTokenCount });
        return { text: response.text, model };
      }
      noteModelAttempt({ provider: 'gemini', model, outcome: 'invalid_output', detail: 'empty reply', ms: Date.now() - t0 });
    } catch (err: any) {
      lastErr = err;
      const c = classifyGeminiError(err);
      noteModelAttempt({ provider: 'gemini', model, outcome: attemptOutcome(c.kind), detail: attemptDetail(c, err), ms: Date.now() - t0 });
      console.warn(`[Gemini Chat Pipeline] Model ${model} error:`, err?.message || err?.status || err);
      await sleep(250);
    }
  }
  throw lastErr || new Error('All chat models exhausted');
}
