import { Modality, type GoogleGenAI } from '@google/genai';
import { answered, attemptDetail, attemptOutcome, classifyGeminiAttempt, coolDown, gateGeminiModel, type GeminiFailure } from './gemini';
import { noteModelAttempt } from './llm/usage';
import { TTS_MODELS } from './modelLineup';
import { reduceClassifiedFailures } from './quota';
import { buildTtsPrompt } from './ttsPrompt';

/**
 * Narration through Gemini TTS, moved out of server.ts (2026-09-27) so it can be tested. What changed:
 *
 * - Cooldowns. /api/tts had none: once both TTS models were spent for the day every clip still hit both, two
 *   refused requests per scene (3.1 Flash TTS peaked at 20 against its 10/day). TTS models now share gemini.ts's
 *   cooldowns: quota until its reset (capped at 30 min), 503 30 s doubling, timeout 10 min, 404 30 min.
 * - Pacing. TTS is 3 requests/minute on the free tier. The 4th clip in a minute used to be refused and fall through
 *   to the next model, a different engine, so one video's analyst lines could come from two engines. A clip now
 *   waits (up to a minute, the window's length) for its model's slot instead.
 * - Pinning. `model` restricts the call to that one engine: a spent quota is a 429 to wait out, never a quiet
 *   switch. ContentRender's voices name the engine they were chosen on.
 * - A deadline for the WHOLE request (TTS_TOTAL_BUDGET_MS, 170 s), under ContentRender's 180 s client timeout: pacing
 *   waits and every model's call share it, and no model is started without time left for it. Per-step limits alone
 *   added up to ~300 s for an unpinned call (61 s pacing + 90 s call, twice); the client gave up and retried while the
 *   server finished, spending a second of the ~10 daily TTS requests on audio nobody received.
 */

/** A Gemini TTS model id, for validating a caller-supplied `model` ("gemini-3.1-flash-tts-preview", "gemini-3.8-flash-tts"). */
export const TTS_MODEL_ID = /^gemini-[a-z0-9.-]*tts[a-z0-9.-]*$/i;

/** Longest a clip waits for its model's per-minute slot. The window is 60 s, so this always finds one when alone. */
const TTS_PACE_MAX_WAIT_MS = 61_000;
const DEFAULT_TTS_TIMEOUT_MS = 90_000;
const DEFAULT_TTS_TOTAL_BUDGET_MS = 170_000;
/** Below this much time left, a model is not started: a TTS reply takes several seconds even when healthy. */
const MIN_CALL_MS = 15_000;

export function ttsTotalBudgetMs(env: Env = process.env): number {
  const n = Number(env.TTS_TOTAL_BUDGET_MS);
  return env.TTS_TOTAL_BUDGET_MS && Number.isFinite(n) && n > 0 ? n : DEFAULT_TTS_TOTAL_BUDGET_MS;
}

type Env = Record<string, string | undefined>;

export function ttsTimeoutMs(env: Env = process.env): number {
  const n = Number(env.TTS_TIMEOUT_MS);
  return env.TTS_TIMEOUT_MS && Number.isFinite(n) && n > 0 ? n : DEFAULT_TTS_TIMEOUT_MS;
}

export interface SpeechRequest {
  text: string;
  voice: string;
  direction?: string;
  /** Only this engine; no fall-through. Undefined: TTS_MODELS in order. */
  model?: string;
}

export interface SpeechOptions {
  now?: () => number;
  sleep?: (ms: number) => Promise<unknown>;
  env?: Env;
  timeoutMs?: number;
  /** The whole request's deadline; defaults to ttsTotalBudgetMs(). */
  totalBudgetMs?: number;
}

/**
 * Returns the audio (base64 s16le mono PCM, 24 kHz) and the model that spoke it. Throws what reduceModelErrors
 * would: QuotaExhaustedError, UpstreamUnavailableError, or the first request error when nothing is retryable.
 */
export async function synthesizeSpeech(ai: GoogleGenAI, req: SpeechRequest, opts: SpeechOptions = {}): Promise<{ audioBase64: string; model: string }> {
  const now = opts.now ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? ttsTimeoutMs(opts.env);
  const deadline = now() + (opts.totalBudgetMs ?? ttsTotalBudgetMs(opts.env));
  const models = req.model ? [req.model] : TTS_MODELS;
  const failures: GeminiFailure[] = [];
  let firstOther: unknown;

  for (const model of models) {
    const left = () => deadline - now();
    if (left() < MIN_CALL_MS) {
      // Out of time for this request: say "try again shortly", never start a call the client will abandon.
      noteModelAttempt({ provider: 'gemini', model, outcome: 'skipped', detail: 'no time left in this request' });
      failures.push({ kind: 'per_minute', retryAfterSec: 30 });
      continue;
    }
    const gate = await gateGeminiModel(model, { now, sleep: opts.sleep, env: opts.env, maxPaceWaitMs: Math.min(TTS_PACE_MAX_WAIT_MS, left() - MIN_CALL_MS) });
    if ('failure' in gate) {
      failures.push(gate.failure);
      if (gate.error) firstOther ??= gate.error;
      continue;
    }
    const t0 = now();
    try {
      const response = await ai.models.generateContent({
        model,
        contents: [{ parts: [{ text: buildTtsPrompt(req.text, req.direction) }] }],
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: req.voice } } },
          abortSignal: AbortSignal.timeout(Math.max(1000, Math.min(timeoutMs, left()))),
        },
      });
      const audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (audio) {
        noteModelAttempt({ provider: 'gemini', model, outcome: 'ok', ms: now() - t0 });
        answered(model);
        return { audioBase64: audio, model };
      }
      noteModelAttempt({ provider: 'gemini', model, outcome: 'invalid_output', detail: 'no audio in the response', ms: now() - t0 });
      failures.push({ kind: 'other' });
      firstOther ??= new Error(`${model} returned no audio`);
    } catch (err: any) {
      const c = classifyGeminiAttempt(err);
      noteModelAttempt({ provider: 'gemini', model, outcome: attemptOutcome(c.kind), detail: attemptDetail(c, err), ms: now() - t0 });
      coolDown(model, c, now(), err);
      failures.push(c);
      if (c.kind === 'other') firstOther ??= err;
      console.warn(`[TTS Agent] Model ${model} notice:`, err?.message || err);
    }
  }
  throw reduceClassifiedFailures(failures, firstOther, 'No audio returned by models');
}
