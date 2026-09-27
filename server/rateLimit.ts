/**
 * Client-side pacing for Gemini's per-minute request limits.
 *
 * The free tier caps each model per minute (AI Studio's rate-limit page for this project, 2026-09-27): Flash 5,
 * Flash-Lite 15, TTS 3, Gemma 30. ContentPipe used to find each limit by being refused: peaks of 6/5 on
 * gemini-3.8-flash, 15/15 on 3.5 Flash-Lite and 5/3 on 3.1 Flash TTS, and every refusal is another counted request.
 * A refused TTS call also fell through to the next TTS model, a different engine, mid-video.
 *
 * `waitForSlot` holds a sliding 60 s window of the requests actually sent per model. When a model is at its limit
 * the caller waits for the oldest request to leave the window, up to `maxWaitMs`, else it is told when to come back
 * and moves on (text) or waits longer (TTS, where the engine must not change).
 *
 * Limits: the window only sees this process. Google counts per PROJECT, so another app on the same key (JobPipe
 * shared this one until 2026-09-27) or a second ContentPipe process still spends the same minute. With billing on
 * the limits are far higher: GEMINI_RPM_PACING=off turns this off.
 */

type Env = Record<string, string | undefined>;

const WINDOW_MS = 60_000;

/** Free-tier requests per minute by model family, or undefined for a model we have no figure for (not paced). */
export function geminiRpmLimit(model: string): number | undefined {
  if (/tts/i.test(model)) return 3;
  if (/^gemma-/i.test(model)) return 30;
  if (/flash-lite/i.test(model)) return 15;
  if (/flash/i.test(model)) return 5;
  return undefined;
}

export function pacingEnabled(env: Env = process.env): boolean {
  return !/^(off|0|false|no)$/i.test((env.GEMINI_RPM_PACING ?? '').trim());
}

const sent = new Map<string, number[]>();

/** Test hook: the window is process-global state. */
export function resetPacing(): void {
  sent.clear();
}

/** 0 if a request to `model` may go now, else milliseconds until the oldest one in the window expires. */
export function nextSlotMs(model: string, nowMs: number, env: Env = process.env): number {
  const limit = geminiRpmLimit(model);
  if (limit === undefined || !pacingEnabled(env)) return 0;
  const recent = (sent.get(model) ?? []).filter((t) => nowMs - t < WINDOW_MS);
  sent.set(model, recent);
  return recent.length < limit ? 0 : recent[0] + WINDOW_MS - nowMs;
}

/** Count a request that is being sent now. A refused request is counted by Google too, so every send is recorded. */
export function recordSend(model: string, nowMs: number): void {
  if (geminiRpmLimit(model) === undefined) return;
  const list = sent.get(model) ?? [];
  list.push(nowMs);
  sent.set(model, list);
}

export interface PaceOptions {
  now?: () => number;
  sleep?: (ms: number) => Promise<unknown>;
  /** Longest this call will wait for a slot. */
  maxWaitMs: number;
  env?: Env;
}

/** `ok`: the slot is taken. Otherwise `retryAfterSec` says when one frees up. (A flat shape: this repo has no strictNullChecks, so a union would not narrow.) */
export interface PaceResult {
  ok: boolean;
  waitedMs: number;
  retryAfterSec: number;
}

/**
 * Takes a slot for `model` (recording the send) once one is free within `maxWaitMs`. The check and the record run
 * with no await between them, so two concurrent requests cannot both take the last slot.
 */
export async function waitForSlot(model: string, opts: PaceOptions): Promise<PaceResult> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const start = now();
  for (;;) {
    const wait = nextSlotMs(model, now(), opts.env);
    if (wait <= 0) {
      recordSend(model, now());
      return { ok: true, waitedMs: now() - start, retryAfterSec: 0 };
    }
    if (now() - start + wait > opts.maxWaitMs) return { ok: false, waitedMs: now() - start, retryAfterSec: Math.max(1, Math.ceil(wait / 1000)) };
    await sleep(wait + 50); // just past the edge of the window
  }
}
