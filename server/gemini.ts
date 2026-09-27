import { GoogleGenAI } from '@google/genai';
import {
  classifyGeminiError,
  isQuotaKind,
  summarizeQuotaFailures,
  UpstreamUnavailableError,
  type ClassifiedError,
} from './quota';
import { noteModelAttempt, trackModelCall } from './llm/usage';
import { geminiRpmLimit, waitForSlot } from './rateLimit';
import type { ModelAttempt } from '../shared/modelUsage';

/** How the provenance panel names a classified failure. */
export function attemptOutcome(kind: ClassifiedError['kind'] | undefined, invalidOutput = false): ModelAttempt['outcome'] {
  if (invalidOutput) return 'invalid_output';
  if (kind === 'zero' || kind === 'per_day' || kind === 'per_minute') return 'quota';
  if (kind === 'transient') return 'overloaded';
  return 'error';
}

/** "HTTP 429 per_day" — the gist of a failure for the panel, never the error body. */
export function attemptDetail(c: GeminiFailure, err: any): string {
  const status = c.status ?? err?.status;
  const retry = c.retryAfterSec ? `, retry in ${c.retryAfterSec}s` : '';
  if (c.cause === 'timeout') return 'timed out (no answer within the Gemini timeout)';
  if (c.kind === 'other') return `${status ? `HTTP ${status}: ` : ''}${String(err?.message || err).slice(0, 160)}`;
  return `${status ? `HTTP ${status} ` : ''}${c.kind.replace('_', '-')}${retry}`;
}

/**
 * A classified Gemini failure plus why it will repeat on the same model. `timeout`: the SDK aborts with a plain
 * `AbortError` ("This operation was aborted") that classifyGeminiError would call `other`, a request bug; it is the
 * model being slow for our prompt. `model_missing`: generateContent answers 404 for a model this key cannot call.
 */
export type GeminiFailure = ClassifiedError & { cause?: 'timeout' | 'model_missing' };

export function classifyGeminiAttempt(err: unknown): GeminiFailure {
  const name = (err as any)?.name;
  if (name === 'AbortError' || name === 'TimeoutError') return { kind: 'transient', cause: 'timeout' };
  const c = classifyGeminiError(err);
  if (c.kind === 'other' && c.status === 404) return { ...c, cause: 'model_missing' };
  return c;
}

// Text model fallback chain, best-first. gemini-2.5-flash is intentionally
// absent: Google returns 404 "no longer available to new users" for it, so
// leading with it burned a guaranteed-failed call on every request.
//
// Newer models checked on 2026-09-24 (Artificial Analysis score in brackets) and NOT added, on evidence:
//  - gemini-3.5-flash-lite (22) FAILED the real script pipeline: a 67k-character runaway JSON string, then only 3 of
//    10 scenes. gemini-3-flash-preview (26) failed once too (narrative pass: 0 of 10 scenes after 233 s, cause not
//    captured) and 503'd on the next run. (Since 2026-09-27 a Gemini call times out and a slow, overloaded or missing
//    model is benched — see coolDown — so one slow failure no longer costs minutes on every reach.)
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
/**
 * A 503 ("high demand") benches the model for 30 s, doubling on each consecutive one up to 10 min, and a success
 * resets it. Before 2026-09-27 only quota errors were cooled, so with gemini-3.8-flash and 3.7-flash first in
 * LLM_MODEL_ORDER and both answering 503 on the pipeline's large prompts, each of a script's ~25 calls paid two
 * failed Gemini attempts before the model that answered — most of the 503s on the AI Studio error chart.
 */
const OVERLOAD_COOLDOWN_SEC = 30;
const MAX_OVERLOAD_COOLDOWN_SEC = 600;
/** Same as the chain's (server/llm/chain.ts): a model that timed out is slow for our prompts, not down. */
const TIMEOUT_COOLDOWN_SEC = 600;
/**
 * No timeout used to be set, so a stalled call held its request until undici's own 300 s header timeout. Above the
 * chain's 120 s default because Gemini is often the last resort, where a slow answer beats none.
 */
const DEFAULT_GEMINI_TIMEOUT_MS = 180_000;
/**
 * Longest a text call waits for a model's per-minute slot (server/rateLimit.ts) before moving on to the next model.
 * Short: the next model is usually a second away, and a strict caller's whole request should not stall on pacing.
 */
const TEXT_PACE_MAX_WAIT_MS = 15_000;

export function geminiTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  for (const raw of [env.GEMINI_TIMEOUT_MS, env.LLM_TIMEOUT_MS]) {
    const n = Number(raw);
    if (raw && Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_GEMINI_TIMEOUT_MS;
}

/**
 * `until`: when the model is tried again. `setAt`: when it was benched, so the retry pass can tell "benched by THIS
 * request moments ago" (worth one more try) from "benched by an earlier request" (not). `retryAt`: when the provider
 * said it recovers; for a daily cap that is midnight Pacific, later than `until` (capped at 30 min so billing takes
 * effect), and a caller must be told the real reset, not the shorter skip (chain.ts keeps the same pair).
 */
interface Cooldown {
  until: number;
  setAt: number;
  retryAt?: number;
  c: GeminiFailure;
  why: string;
}
const cooldowns = new Map<string, Cooldown>();
/** Consecutive 503s per model, for the doubling overload cooldown. */
const overloadStreak = new Map<string, number>();

/** Test hook: cooldowns are process-global state. */
export function resetModelCooldowns(): void {
  cooldowns.clear();
  overloadStreak.clear();
}

export function coolDown(model: string, c: GeminiFailure, nowMs: number, err?: unknown): void {
  let sec: number | undefined;
  if (isQuotaKind(c.kind)) sec = c.kind === 'zero' ? MAX_COOLDOWN_SEC : Math.min(c.retryAfterSec ?? 60, MAX_COOLDOWN_SEC);
  else if (c.cause === 'timeout') sec = TIMEOUT_COOLDOWN_SEC;
  else if (c.kind === 'transient') {
    const n = (overloadStreak.get(model) ?? 0) + 1;
    overloadStreak.set(model, n);
    sec = Math.min(OVERLOAD_COOLDOWN_SEC * 2 ** (n - 1), MAX_OVERLOAD_COOLDOWN_SEC);
  } else if (c.cause === 'model_missing') sec = MAX_COOLDOWN_SEC;
  if (!sec) return; // a request bug (bad key, rejected schema, junk output) says nothing about the next request
  cooldowns.set(model, {
    until: nowMs + sec * 1000,
    setAt: nowMs,
    retryAt: isQuotaKind(c.kind) && c.retryAfterSec ? nowMs + c.retryAfterSec * 1000 : undefined,
    c,
    why: String((err as any)?.message ?? c.cause ?? c.kind).slice(0, 200),
  });
}

/** A model that answered is healthy: its streak and any bench end now. */
export function answered(model: string): void {
  overloadStreak.delete(model);
  cooldowns.delete(model);
}

/**
 * The model's cooldown if it should be skipped now. `overloadBenchedSince`: the retry pass re-tries a model benched
 * for a plain 503 at or after this time (by the same request, moments ago) — that pass exists because overload clears
 * in seconds. A bench set by an earlier request still holds, or the doubling bench would never keep anyone off.
 */
export function activeCooldown(model: string, nowMs: number, overloadBenchedSince?: number): Cooldown | undefined {
  const cd = cooldowns.get(model);
  if (!cd || cd.until <= nowMs) return undefined;
  if (overloadBenchedSince !== undefined && cd.c.kind === 'transient' && !cd.c.cause && cd.setAt >= overloadBenchedSince) return undefined;
  return cd;
}

/** Seconds until a benched model can work: the provider's real reset for a quota, else the bench's end. */
export function cooldownRetryAfterSec(cd: Cooldown, nowMs: number): number | undefined {
  if (cd.c.kind === 'zero' || cd.c.kind === 'other') return undefined;
  return Math.max(1, Math.ceil(((cd.retryAt ?? cd.until) - nowMs) / 1000));
}

export interface GateOptions {
  now?: () => number;
  sleep?: (ms: number) => Promise<unknown>;
  env?: Record<string, string | undefined>;
  /** Longest to wait for a per-minute slot. */
  maxPaceWaitMs: number;
  overloadBenchedSince?: number;
}

/** Why a model was not called. `benched`: skipped for an earlier failure (no request was made). */
export interface GateRefusal {
  failure: GeminiFailure;
  benched: boolean;
  error?: Error;
}

/**
 * The one gate every Gemini call site passes (JSON, chat, TTS): skip a benched model, then wait for its per-minute
 * slot. Returns `{ waitedMs }` when the call may go. It used to be copied in three places and had already drifted.
 */
export async function gateGeminiModel(model: string, o: GateOptions): Promise<GateRefusal | { waitedMs: number }> {
  const now = o.now ?? Date.now;
  const cd = activeCooldown(model, now(), o.overloadBenchedSince);
  if (cd) {
    noteModelAttempt({ provider: 'gemini', model, outcome: 'skipped', detail: `cooling down after ${cooldownLabel(cd.c)}` });
    return {
      benched: true,
      failure: { ...cd.c, retryAfterSec: cooldownRetryAfterSec(cd, now()) },
      // A chain whose every model is benched for a missing model must still say why, not "no tiers configured".
      error: cd.c.kind === 'other' ? new Error(`${model} skipped while cooling down after: ${cd.why}`) : undefined,
    };
  }
  const slot = await waitForSlot(model, { now, sleep: o.sleep, maxWaitMs: o.maxPaceWaitMs, env: o.env });
  if (!slot.ok) {
    noteModelAttempt({ provider: 'gemini', model, outcome: 'skipped', detail: `at its ${geminiRpmLimit(model)}/min limit, free in ${slot.retryAfterSec}s` });
    return { benched: false, failure: { kind: 'per_minute', retryAfterSec: slot.retryAfterSec } };
  }
  return { waitedMs: slot.waitedMs };
}

export const cooldownLabel = (c: GeminiFailure) => (c.cause ?? c.kind).replace('_', '-');

/** Seconds worth waiting before one more pass over the chain, or undefined if waiting can't help. */
function worthWaitingSec(failures: GeminiFailure[]): number | undefined {
  const waits: number[] = [];
  for (const f of failures) {
    // A timed-out model is benched for 10 min, so a retry pass 8 s later would only skip it.
    if (f.kind === 'transient' && f.cause !== 'timeout') waits.push(TRANSIENT_RETRY_WAIT_SEC);
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
  /** Per-call deadline; defaults to geminiTimeoutMs(). */
  timeoutMs?: number;
  /**
   * Read for GEMINI_RPM_PACING and GEMINI_TIMEOUT_MS; the chain passes its own. Pacing waits (up to 15 s for a
   * model's per-minute slot) apply even when `retryPass` is false: a model-ordered chain puts the smartest model first
   * on purpose (owner, 2026-09-27), and a few seconds for it beats handing a script chunk to a weaker model at once.
   * In the retry pass they count against MAX_TOTAL_WAIT_SEC.
   */
  env?: Record<string, string | undefined>;
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
  const callStart = now();

  const timeoutMs = opts.timeoutMs ?? geminiTimeoutMs(opts.env);

  for (let pass = 0; pass < 2; pass++) {
    const failures: GeminiFailure[] = [];
    // Failures of models actually called (or refused a slot) in this pass. Only these say whether waiting helps: a model
    // benched by an earlier request will still be benched 8 s from now.
    const fresh: GeminiFailure[] = [];

    for (const model of models) {
      const paceBudgetMs = pass === 0 ? TEXT_PACE_MAX_WAIT_MS : Math.max(0, Math.min(TEXT_PACE_MAX_WAIT_MS, (MAX_TOTAL_WAIT_SEC - waitedSec) * 1000));
      const gate = await gateGeminiModel(model, { now, sleep: wait, env: opts.env, maxPaceWaitMs: paceBudgetMs, overloadBenchedSince: pass > 0 ? callStart : undefined });
      if ('failure' in gate) {
        failures.push(gate.failure);
        if (!gate.benched) fresh.push(gate.failure);
        if (gate.error && !firstOtherErr) firstOtherErr = gate.error;
        continue;
      }
      waitedSec += gate.waitedMs / 1000;
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
            abortSignal: AbortSignal.timeout(timeoutMs),
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
        answered(model);
        return parsed;
      } catch (err: any) {
        const c = classifyGeminiAttempt(err);
        noteModelAttempt({ provider: 'gemini', model, outcome: attemptOutcome(c.kind, err instanceof SyntaxError || /empty JSON object/.test(err?.message)), detail: attemptDetail(c, err), ms: now() - t0 });
        failures.push(c);
        fresh.push(c);
        coolDown(model, c, now(), err);
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

    const waitSec = worthWaitingSec(fresh.filter((f) => f.kind !== 'other'));
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
  models: string[] = TEXT_MODELS,
  opts: { env?: Record<string, string | undefined> } = {}
): Promise<{ text: string; model: string }> {
  let lastErr: any = null;
  for (const model of models) {
    // Same gate as the JSON path: a model benched there is just as unavailable to chat.
    const gate = await gateGeminiModel(model, { env: opts.env, maxPaceWaitMs: TEXT_PACE_MAX_WAIT_MS });
    if ('failure' in gate) {
      lastErr ??= gate.error ?? new Error(`${model} not called: ${cooldownLabel(gate.failure)}${gate.failure.retryAfterSec ? `, free in ${gate.failure.retryAfterSec}s` : ''}`);
      continue;
    }
    const t0 = Date.now();
    try {
      const response = await ai.models.generateContent({
        model,
        contents,
        config: {
          systemInstruction,
          abortSignal: AbortSignal.timeout(geminiTimeoutMs(opts.env)),
        },
      });
      if (response?.text) {
        const um: any = response?.usageMetadata;
        noteModelAttempt({ provider: 'gemini', model, outcome: 'ok', ms: Date.now() - t0, inputTokens: um?.promptTokenCount, outputTokens: um?.candidatesTokenCount });
        answered(model);
        return { text: response.text, model };
      }
      noteModelAttempt({ provider: 'gemini', model, outcome: 'invalid_output', detail: 'empty reply', ms: Date.now() - t0 });
    } catch (err: any) {
      lastErr = err;
      const c = classifyGeminiAttempt(err);
      coolDown(model, c, Date.now(), err);
      noteModelAttempt({ provider: 'gemini', model, outcome: attemptOutcome(c.kind), detail: attemptDetail(c, err), ms: Date.now() - t0 });
      console.warn(`[Gemini Chat Pipeline] Model ${model} error:`, err?.message || err?.status || err);
      await sleep(250);
    }
  }
  throw lastErr || new Error('All chat models exhausted');
}
