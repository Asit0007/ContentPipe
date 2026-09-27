import { AsyncLocalStorage } from 'node:async_hooks';
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';
import type { ModelAttempt, ModelCall } from '../../shared/modelUsage';

/**
 * Which model actually wrote each part of a response.
 *
 * The chain walks up to a dozen models and returns the first usable answer, so "which model wrote this?" is not
 * knowable from the configuration: it depends on who was rate-limited, overloaded or cooling down at that moment.
 * This records it as it happens. A route wraps its work in `recordModelUsage`, each model call in it is labelled with
 * `withModelTask`, and the chain reports every attempt with `noteModelAttempt` — the winner and every model that
 * failed or was skipped before it. Calls made outside a recording (tests, scripts) cost nothing and go nowhere.
 *
 * AsyncLocalStorage rather than a parameter: the chain sits under four call layers (route -> scriptPipeline ->
 * generateJson -> generateGeminiJson), and threading a logger through every signature would touch each of them.
 */

interface Store {
  calls: ModelCall[];
  task?: string;
  current?: ModelCall;
  /** What the request is for ("script", "research", ...): decides which reserved models it may use (LLM_RESERVED_FOR). */
  purpose?: string;
}

const als = new AsyncLocalStorage<Store>();

/** Runs `fn`, collecting every model call made inside it. The array is live: it fills as calls finish. */
export async function recordModelUsage<T>(fn: () => Promise<T>, calls: ModelCall[] = []): Promise<{ result: T; calls: ModelCall[] }> {
  const result = await als.run({ calls }, fn);
  return { result, calls };
}

/** Runs `fn` (e.g. an Express `next`) with `calls` as the recording every model call inside it appends to. */
export function enterModelUsage<T>(calls: ModelCall[], fn: () => T, purpose?: string): T {
  return als.run({ calls, purpose }, fn);
}

/**
 * A request's purpose from its path: the route name. Express strips the mount point, so under `app.use('/api', ...)`
 * `req.path` is `/script`, not `/api/script`; both forms give "script".
 */
export function purposeForPath(p: string): string | undefined {
  return p.replace(/^\/+/, '').replace(/^api\//, '').split('/')[0] || undefined;
}

/** The current request's purpose, or undefined outside a request (video burn, scripts, tests). */
export function currentModelPurpose(): string | undefined {
  return als.getStore()?.purpose;
}

/** The calls recorded so far in this request, or undefined outside a recording. */
export function currentModelCalls(): ModelCall[] | undefined {
  return als.getStore()?.calls;
}

/** Labels the model calls made inside `fn` ("Narrative scenes 4-6"), so the UI can say which model wrote which part. */
export function withModelTask<T>(task: string, fn: () => Promise<T>): Promise<T> {
  const store = als.getStore();
  if (!store) return fn();
  return als.run({ calls: store.calls, task, purpose: store.purpose }, fn);
}

/**
 * Opens one logical call (one generateJson / generateText): attempts are appended to it until `finish`.
 * Nested opens are ignored — the outer call owns the attempts — so generateJson's Gemini-only shortcut into
 * generateGeminiJson records one call, not two.
 */
export async function trackModelCall<T>(kind: ModelCall['kind'], fn: () => Promise<T>): Promise<T> {
  const store = als.getStore();
  if (!store || store.current) return fn();
  const call: ModelCall = { task: store.task || 'Text generation', kind, ok: false, attempts: [], startedAt: new Date().toISOString(), ms: 0 };
  const t0 = Date.now();
  // A child store so concurrent calls in one request (none today, but Promise.all is one edit away) never share `current`.
  return als.run({ ...store, current: call }, async () => {
    try {
      const r = await fn();
      call.ok = true;
      return r;
    } finally {
      call.ms = Date.now() - t0;
      const winner = call.attempts.find((a) => a.outcome === 'ok');
      // Returning is not the same as a model answering: the image chain returns an SVG placeholder when none did.
      if (call.attempts.length > 0 && !winner) call.ok = false;
      if (winner) {
        call.provider = winner.provider;
        call.model = winner.model;
      }
      store.calls.push(call);
    }
  });
}

/**
 * Where every model call is appended, one JSON line each, for JobPipe's review dashboard ("AI models used, last 48 h",
 * JobPipe `src/jobpipe/usage.py`, which reads this file). `MODEL_USAGE_LOG=off` disables it (npm test sets that); any
 * other value is a path. Default `.runs/model-usage.jsonl`, beside the journals (`CONTENTPIPE_RUNS_DIR` moves both;
 * `pruneOldRuns` only deletes `.json`, so this file survives it).
 */
export function usageLogPath(env: Record<string, string | undefined> = process.env): string | undefined {
  const v = env.MODEL_USAGE_LOG?.trim();
  if (v && /^(off|0|false|no)$/i.test(v)) return undefined;
  if (v) return path.resolve(v);
  const runs = env.CONTENTPIPE_RUNS_DIR ? path.resolve(env.CONTENTPIPE_RUNS_DIR) : path.resolve(process.cwd(), '.runs');
  return path.join(runs, 'model-usage.jsonl');
}

/** Past this size the log moves to `<file>.1` (replacing the previous one): ~25k calls, weeks of use. JobPipe reads both. */
export const USAGE_LOG_MAX_BYTES = 5 * 1024 * 1024;

function rotateIfLarge(file: string): void {
  try {
    if (statSync(file).size >= USAGE_LOG_MAX_BYTES) renameSync(file, `${file}.1`);
  } catch {
    // No file yet, or a race with another process's rotation: nothing to do.
  }
}

/** Appends one attempt. Never throws: a full disk must not fail a generation. */
function appendUsage(attempt: ModelAttempt, store: Store | undefined): void {
  const file = usageLogPath();
  if (!file || attempt.outcome === 'skipped') return; // a skipped model received no request
  const row: Record<string, unknown> = {
    t: new Date().toISOString().slice(0, 19) + 'Z', app: 'contentpipe',
    provider: attempt.provider, model: attempt.model, outcome: attempt.outcome,
  };
  if (attempt.ms !== undefined) row.ms = Math.round(attempt.ms);
  if (attempt.detail) row.detail = attempt.detail.slice(0, 200);
  const task = store?.current?.task ?? store?.task;
  if (task) row.task = task;
  if (store?.current?.kind) row.kind = store.current.kind;
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    rotateIfLarge(file);
    // Synchronous on purpose: one short line per model attempt (seconds apart, each attempt itself taking seconds),
    // written whole, so concurrent requests and the video burn's process never interleave half-lines.
    appendFileSync(file, JSON.stringify(row) + '\n');
  } catch {
    // Logging is a convenience; the call itself already happened.
  }
}

/**
 * One model tried inside the current call: recorded for the response's provenance panel (inside a recording only)
 * and appended to the usage log (always, so the video burn and scripts, which run outside any request, count too).
 */
export function noteModelAttempt(attempt: ModelAttempt): void {
  // Error bodies can be whole JSON documents; the panel needs the gist, and they must never carry a request.
  if (attempt.detail) attempt.detail = attempt.detail.replace(/\s+/g, ' ').slice(0, 240);
  const store = als.getStore();
  appendUsage(attempt, store);
  const current = store?.current;
  if (!current) return;
  current.attempts.push(attempt);
}
