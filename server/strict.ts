import type { Response } from 'express';
import { classifyGeminiError, QuotaExhaustedError, UpstreamUnavailableError } from './quota';

/**
 * Strict mode is how an automated caller (CyberPipe) opts out of the UI's
 * "always render something" behaviour.
 *
 * The default contract is deliberate and stays: every AI endpoint degrades to
 * server/fallbackGenerators.ts so the browser UI never dead-ends. But that
 * contract is wrong for an orchestrator — canned XZ-backdoor content returned
 * with HTTP 200 is indistinguishable from a real draft unless the caller knows
 * to read `isQuotaFallback`, and its rate-limit machinery only reacts to 429.
 * A request carrying `X-ContentPipe-Strict: 1` therefore never receives
 * fallback content: it gets a status code that says what happened.
 *
 *   429 + Retry-After   quota exhausted, retry at the given time  (per_minute | per_day)
 *   503 + Retry-After   upstream overloaded/unavailable, retry shortly
 *   502                 non-retryable: no quota exists (billing), bad key, rejected request
 */
export const STRICT_HEADER = 'x-contentpipe-strict';

export function isStrict(req: { get(name: string): string | undefined }): boolean {
  return req.get(STRICT_HEADER) === '1';
}

export interface StrictFailure {
  status: number;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

export function toStrictFailure(err: unknown): StrictFailure {
  if (err instanceof QuotaExhaustedError) {
    if (err.kind === 'zero') {
      return {
        status: 502,
        headers: {},
        body: { error: err.message, kind: 'zero_quota', retryable: false, ...context(err) },
      };
    }
    const retryAfterSec = err.retryAfterSec ?? 60;
    return {
      status: 429,
      headers: { 'Retry-After': String(retryAfterSec) },
      body: { error: err.message, kind: err.kind, retryable: true, retryAfterSec, ...context(err) },
    };
  }
  if (err instanceof UpstreamUnavailableError) {
    return {
      status: 503,
      headers: { 'Retry-After': String(err.retryAfterSec) },
      body: { error: err.message, kind: 'upstream_unavailable', retryable: true, retryAfterSec: err.retryAfterSec, ...context(err) },
    };
  }

  // Anything else: classify defensively so a raw ApiError that escaped a code path
  // still maps to the right status instead of a generic 500.
  const c = classifyGeminiError(err);
  const message = String((err as any)?.message ?? err ?? 'Upstream failure').slice(0, 500);
  if (c.kind === 'per_day' || c.kind === 'per_minute') {
    const retryAfterSec = c.retryAfterSec ?? 60;
    return { status: 429, headers: { 'Retry-After': String(retryAfterSec) }, body: { error: message, kind: c.kind, retryable: true, retryAfterSec } };
  }
  if (c.kind === 'transient') {
    return { status: 503, headers: { 'Retry-After': '30' }, body: { error: message, kind: 'upstream_unavailable', retryable: true, retryAfterSec: 30 } };
  }
  return { status: 502, headers: {}, body: { error: message, kind: 'upstream_error', retryable: false } };
}

function context(err: { runId?: string; progress?: Record<string, unknown> }): Record<string, unknown> {
  return { ...(err.runId ? { runId: err.runId } : {}), ...(err.progress ? { progress: err.progress } : {}) };
}

export function sendStrictFailure(res: Response, err: unknown): void {
  const f = toStrictFailure(err);
  for (const [k, v] of Object.entries(f.headers)) res.setHeader(k, v);
  res.status(f.status).json(f.body);
}

/**
 * Runs `work`; on failure returns the fallback for the UI path, or rethrows for
 * strict callers so the endpoint can answer with a real status code.
 */
export async function orFallback<T>(
  strict: boolean,
  work: () => Promise<T>,
  fallback: (err: unknown) => T | Promise<T>
): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (strict) throw err;
    return fallback(err);
  }
}
