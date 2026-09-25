import { AsyncLocalStorage } from 'node:async_hooks';
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
}

const als = new AsyncLocalStorage<Store>();

/** Runs `fn`, collecting every model call made inside it. The array is live: it fills as calls finish. */
export async function recordModelUsage<T>(fn: () => Promise<T>, calls: ModelCall[] = []): Promise<{ result: T; calls: ModelCall[] }> {
  const result = await als.run({ calls }, fn);
  return { result, calls };
}

/** Runs `fn` (e.g. an Express `next`) with `calls` as the recording every model call inside it appends to. */
export function enterModelUsage<T>(calls: ModelCall[], fn: () => T): T {
  return als.run({ calls }, fn);
}

/** The calls recorded so far in this request, or undefined outside a recording. */
export function currentModelCalls(): ModelCall[] | undefined {
  return als.getStore()?.calls;
}

/** Labels the model calls made inside `fn` ("Narrative scenes 4-6"), so the UI can say which model wrote which part. */
export function withModelTask<T>(task: string, fn: () => Promise<T>): Promise<T> {
  const store = als.getStore();
  if (!store) return fn();
  return als.run({ calls: store.calls, task }, fn);
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

/** One model tried inside the current call. A no-op outside a recording. */
export function noteModelAttempt(attempt: ModelAttempt): void {
  const current = als.getStore()?.current;
  if (!current) return;
  // Error bodies can be whole JSON documents; the panel needs the gist, and they must never carry a request.
  if (attempt.detail) attempt.detail = attempt.detail.replace(/\s+/g, ' ').slice(0, 240);
  current.attempts.push(attempt);
}
