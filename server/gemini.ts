import { GoogleGenAI } from '@google/genai';
import {
  classifyGeminiError,
  isQuotaKind,
  summarizeQuotaFailures,
  UpstreamUnavailableError,
  type ClassifiedError,
} from './quota';

// Text model fallback chain, best-first. gemini-2.5-flash is intentionally
// absent: Google returns 404 "no longer available to new users" for it, so
// leading with it burned a guaranteed-failed call on every request.
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
  const wait = opts.sleep ?? sleep;
  const now = opts.now ?? Date.now;
  let waitedSec = 0;
  let firstOtherErr: any = null;

  for (let pass = 0; pass < 2; pass++) {
    const failures: ClassifiedError[] = [];

    for (const model of models) {
      const cd = cooldowns.get(model);
      if (cd && cd.until > now()) {
        failures.push({
          ...cd.c,
          retryAfterSec: cd.c.kind === 'zero' ? undefined : Math.ceil((cd.until - now()) / 1000),
        });
        continue;
      }
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
        return parsed;
      } catch (err: any) {
        const c = classifyGeminiError(err);
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

// Helper: Multi-tier resilient Text generation
export async function generateGeminiText(
  ai: GoogleGenAI,
  contents: any[],
  systemInstruction: string,
  models: string[] = TEXT_MODELS
): Promise<string> {
  let lastErr: any = null;
  for (const model of models) {
    try {
      const response = await ai.models.generateContent({
        model,
        contents,
        config: {
          systemInstruction,
        },
      });
      if (response?.text) {
        return response.text;
      }
    } catch (err: any) {
      lastErr = err;
      console.warn(`[Gemini Chat Pipeline] Model ${model} error:`, err?.message || err?.status || err);
      await sleep(250);
    }
  }
  throw lastErr || new Error('All chat models exhausted');
}
