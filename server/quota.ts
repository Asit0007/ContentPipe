/**
 * Classifies Gemini API failures so callers can tell "wait a few seconds" from
 * "come back tomorrow" from "this will never work on this account".
 *
 * Shape verified live 2026-09-19 (server/__fixtures__/gemini-429-limit0.json):
 *   - the SDK's ApiError carries the numeric HTTP code on `.status` and the
 *     whole JSON error body, stringified, on `.message`;
 *   - `limit: 0` appears only in the human-readable `error.message` text
 *     ("* Quota exceeded for metric: …, limit: 0, model: …"), there is no
 *     structured `quotaValue`;
 *   - ONE 429 lists every violated quota at once — per-minute AND per-day
 *     `quotaId`s together — beside a short `RetryInfo.retryDelay` (9s, 48s
 *     observed). So a short retryDelay is NOT evidence that waiting helps: any
 *     PerDay violation wins, otherwise a caller would spin against a spent
 *     daily quota.
 *
 * A real per-day body was also captured (gemini-3.7-flash, `limit: 20`,
 * server/__fixtures__/gemini-429-perday.json): a single PerDay violation, a
 * structured `quotaValue`, and a `retryDelay` of only 4s — the short delay is
 * the per-minute window, not the daily reset.
 *
 * Still not reproduced live: a per-minute-only body. That branch follows the
 * quotaId naming seen in the captured bodies and is tested against a constructed
 * body (named "constructed" in quota.test.ts).
 */

export type QuotaKind = 'zero' | 'per_day' | 'per_minute';
export type ErrorKind = QuotaKind | 'transient' | 'other';

export interface ClassifiedError {
  kind: ErrorKind;
  /** Seconds until retrying can plausibly succeed. Absent for `zero`/`other`. */
  retryAfterSec?: number;
  status?: number;
}

/** Thrown when every model in a chain failed with quota-class errors. */
export class QuotaExhaustedError extends Error {
  readonly kind: QuotaKind;
  /** Undefined for `zero`: retrying can never help, the account has no quota. */
  readonly retryAfterSec?: number;
  /** Caller-attached context (e.g. script progress) surfaced in strict-mode bodies. */
  progress?: Record<string, unknown>;
  runId?: string;

  constructor(kind: QuotaKind, retryAfterSec: number | undefined, message: string) {
    super(message);
    this.name = 'QuotaExhaustedError';
    this.kind = kind;
    this.retryAfterSec = retryAfterSec;
  }
}

/** Thrown when every model failed for reasons that are expected to clear on their own (5xx / overload). */
export class UpstreamUnavailableError extends Error {
  readonly retryAfterSec: number;
  progress?: Record<string, unknown>;
  runId?: string;

  constructor(retryAfterSec: number, message: string) {
    super(message);
    this.name = 'UpstreamUnavailableError';
    this.retryAfterSec = retryAfterSec;
  }
}

/**
 * True when retrying later can plausibly succeed — i.e. the failure must not be
 * turned into a degraded artifact for a caller that asked for strict semantics.
 * `zero` is excluded: no quota exists, waiting changes nothing.
 */
export function isRetryableError(err: unknown): boolean {
  if (err instanceof UpstreamUnavailableError) return true;
  if (err instanceof QuotaExhaustedError) return err.kind !== 'zero';
  return false;
}

const TRANSIENT_STATUSES = new Set([500, 502, 503, 504]);
const TRANSIENT_PATTERNS = ['unavailable', 'high demand', 'overloaded', 'spikes in demand', 'temporary', 'rate-limits'];

/** Fallback wait when a 429 gives no usable retryDelay. Deliberately over the bounded-wait cap. */
const DEFAULT_PER_MINUTE_RETRY_SEC = 60;

function numericStatus(err: any): number | undefined {
  const raw = err?.status ?? err?.statusCode ?? err?.code;
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function parseErrorBody(err: any): any | null {
  const msg = err?.message;
  if (typeof msg !== 'string' || msg[0] !== '{') return null;
  try {
    const parsed = JSON.parse(msg);
    return parsed?.error ? parsed : null;
  } catch {
    return null;
  }
}

/** "9s" / "48s" / "0.5s" from RetryInfo, else "Please retry in 9.72s." from the message text. */
function parseRetryDelaySec(details: any[] | undefined, text: string): number | undefined {
  const info = Array.isArray(details) ? details.find((d) => typeof d?.retryDelay === 'string') : undefined;
  const m = info?.retryDelay?.match(/^(\d+(?:\.\d+)?)s$/);
  if (m) return Math.ceil(Number(m[1]));
  const t = text.match(/retry in ([\d.]+)\s*s/i);
  return t ? Math.ceil(Number(t[1])) : undefined;
}

export function classifyGeminiError(err: unknown, now: Date = new Date()): ClassifiedError {
  const e: any = err;
  const status = numericStatus(e);
  const body = parseErrorBody(e);
  const inner = body?.error;
  const text = String(inner?.message ?? e?.message ?? (typeof err === 'string' ? err : ''));
  const lower = text.toLowerCase();

  const isQuota =
    status === 429 ||
    inner?.status === 'RESOURCE_EXHAUSTED' ||
    e?.status === 'RESOURCE_EXHAUSTED' ||
    e?.code === 'RESOURCE_EXHAUSTED';

  if (isQuota) {
    // `limit: 0` = no quota exists (free-tier image models, grounding). Never retry it.
    if (/limit:\s*0\b/.test(text)) return { kind: 'zero', status };

    const quotaFailure = Array.isArray(inner?.details)
      ? inner.details.find((d: any) => String(d?.['@type'] || '').endsWith('QuotaFailure'))
      : undefined;
    const violations: any[] = quotaFailure?.violations || [];
    if (violations.some((v) => /PerDay/i.test(String(v?.quotaId || '')))) {
      return { kind: 'per_day', retryAfterSec: secondsUntilNextPacificMidnight(now), status };
    }
    return {
      kind: 'per_minute',
      retryAfterSec: parseRetryDelaySec(inner?.details, text) ?? DEFAULT_PER_MINUTE_RETRY_SEC,
      status,
    };
  }

  if (
    (status !== undefined && TRANSIENT_STATUSES.has(status)) ||
    e?.code === 'UNAVAILABLE' ||
    e?.status === 'UNAVAILABLE' ||
    TRANSIENT_PATTERNS.some((p) => lower.includes(p))
  ) {
    return { kind: 'transient', status };
  }
  return { kind: 'other', status };
}

export function isQuotaKind(kind: ErrorKind): kind is QuotaKind {
  return kind === 'zero' || kind === 'per_day' || kind === 'per_minute';
}

/**
 * Reduces the per-model outcomes of a failed chain to one error. Models have
 * separate quotas, so the chain recovers as soon as the *earliest* one does;
 * `zero` models never recover and are ignored unless every model is `zero`.
 */
export function summarizeQuotaFailures(failures: ClassifiedError[]): QuotaExhaustedError {
  const recoverable = failures.filter((f) => f.kind === 'per_day' || f.kind === 'per_minute');
  if (recoverable.length === 0) {
    return new QuotaExhaustedError(
      'zero',
      undefined,
      'Every model in the chain reports limit: 0 — this account has no quota for the capability (needs billing).'
    );
  }
  const soonest = recoverable.reduce((a, b) => ((a.retryAfterSec ?? Infinity) <= (b.retryAfterSec ?? Infinity) ? a : b));
  const kind = soonest.kind as QuotaKind;
  const retryAfterSec = soonest.retryAfterSec ?? DEFAULT_PER_MINUTE_RETRY_SEC;
  return new QuotaExhaustedError(
    kind,
    retryAfterSec,
    kind === 'per_day'
      ? `Daily Gemini quota exhausted on every model; earliest reset in ~${Math.round(retryAfterSec / 60)} min (midnight Pacific).`
      : `Per-minute Gemini quota exhausted on every model; retry in ~${retryAfterSec}s.`
  );
}

const PT_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  hourCycle: 'h23',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  minute: 'numeric',
  second: 'numeric',
});

function pacificParts(d: Date) {
  const p: Record<string, number> = {};
  for (const part of PT_FORMAT.formatToParts(d)) {
    if (part.type !== 'literal') p[part.type] = Number(part.value);
  }
  return p;
}

/**
 * Gemini's daily quota resets at midnight Pacific. Computed by locating the
 * actual UTC instant of the next 00:00 in America/Los_Angeles rather than
 * `86400 - secondsIntoDay`, which is off by an hour on the two DST-transition
 * days whenever "now" falls before the 2 AM jump.
 */
export function secondsUntilNextPacificMidnight(now: Date = new Date()): number {
  const p = pacificParts(now);
  // Civil-calendar arithmetic in UTC space is safe: it only picks the next date.
  const next = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
  const y = next.getUTCFullYear();
  const m = next.getUTCMonth();
  const d = next.getUTCDate();
  for (const utcHour of [7, 8]) {
    // PDT is UTC-7, PST is UTC-8; exactly one of them lands on 00:00 Pacific.
    const candidate = new Date(Date.UTC(y, m, d, utcHour, 0, 0));
    const c = pacificParts(candidate);
    if (c.year === y && c.month === m + 1 && c.day === d && c.hour === 0 && c.minute === 0) {
      return Math.max(1, Math.ceil((candidate.getTime() - now.getTime()) / 1000));
    }
  }
  return 86400; // unreachable for America/Los_Angeles; defensive
}
