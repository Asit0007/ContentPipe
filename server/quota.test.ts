import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  classifyGeminiError,
  summarizeQuotaFailures,
  secondsUntilNextPacificMidnight,
  QuotaExhaustedError,
} from './quota';

// Real body captured live 2026-09-19 (gemini-3.1-flash-image, free tier).
const REAL_LIMIT0 = readFileSync(new URL('./__fixtures__/gemini-429-limit0.json', import.meta.url), 'utf8');
// Real body captured live 2026-09-19 when gemini-3.7-flash's daily free-tier quota (limit: 20) was spent.
const REAL_PERDAY = readFileSync(new URL('./__fixtures__/gemini-429-perday.json', import.meta.url), 'utf8');

/** Mimics @google/genai's ApiError: numeric `.status`, whole JSON body stringified on `.message`. */
function apiError(status: number, body: unknown) {
  return Object.assign(new Error(typeof body === 'string' ? body : JSON.stringify(body)), { status });
}

const NOW = new Date('2026-09-19T12:00:00Z'); // 05:00 PDT

test('real captured body: limit: 0 is classified zero and is never retryable', () => {
  const c = classifyGeminiError(apiError(429, REAL_LIMIT0), NOW);
  assert.equal(c.kind, 'zero');
  assert.equal(c.retryAfterSec, undefined);
});

test('real body shape: any PerDay violation beats the short retryDelay (limit>0 variant of the captured body)', () => {
  // Same structure as the real capture (all three violations + retryDelay "9s"), but the
  // message says limit: 20 — i.e. the daily quota is spent, not absent.
  const body = JSON.parse(REAL_LIMIT0);
  body.error.message = body.error.message.replace(/limit: 0/g, 'limit: 20');
  const c = classifyGeminiError(apiError(429, body), NOW);
  assert.equal(c.kind, 'per_day');
  assert.equal(c.retryAfterSec, secondsUntilNextPacificMidnight(NOW)); // 19h to 07:00Z next day
  assert.equal(c.retryAfterSec, 19 * 3600);
});

test('REAL captured per-day body: PerDay wins over its own misleading retryDelay of 4s', () => {
  const c = classifyGeminiError(apiError(429, REAL_PERDAY), NOW);
  assert.equal(c.kind, 'per_day');
  assert.equal(c.retryAfterSec, 19 * 3600, 'must wait for the midnight-Pacific reset, not the 4s the body suggests');
});

test('constructed body: per-minute-only violation honours retryDelay', () => {
  const body = {
    error: {
      code: 429,
      status: 'RESOURCE_EXHAUSTED',
      message: 'You exceeded your current quota.\n* Quota exceeded for metric: x, limit: 10, model: m\nPlease retry in 22.4s.',
      details: [
        {
          '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
          violations: [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier' }],
        },
        { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '23s' },
      ],
    },
  };
  const c = classifyGeminiError(apiError(429, body), NOW);
  assert.deepEqual({ kind: c.kind, retryAfterSec: c.retryAfterSec }, { kind: 'per_minute', retryAfterSec: 23 });
});

test('constructed body: retry delay falls back to the message text, then to 60s', () => {
  const textOnly = { error: { code: 429, message: 'quota. Please retry in 7.2s.' } };
  assert.equal(classifyGeminiError(apiError(429, textOnly), NOW).retryAfterSec, 8);
  const nothing = { error: { code: 429, message: 'quota' } };
  assert.equal(classifyGeminiError(apiError(429, nothing), NOW).retryAfterSec, 60);
});

test('a 429 whose body is not JSON is still a quota error (per-minute, 60s), not "other"', () => {
  const c = classifyGeminiError(Object.assign(new Error('got 429 from upstream'), { status: 429 }), NOW);
  assert.deepEqual({ kind: c.kind, retryAfterSec: c.retryAfterSec }, { kind: 'per_minute', retryAfterSec: 60 });
});

test('transient: 503 / "high demand" are transient; parse errors and 400s are other', () => {
  assert.equal(classifyGeminiError(apiError(503, { error: { code: 503, message: 'The model is overloaded. Please try again later.' } })).kind, 'transient');
  assert.equal(classifyGeminiError(new Error('This model is currently experiencing high demand.')).kind, 'transient');
  assert.equal(classifyGeminiError(new SyntaxError('Unexpected token < in JSON')).kind, 'other');
  assert.equal(classifyGeminiError(apiError(400, { error: { code: 400, message: 'API key not valid.' } })).kind, 'other');
});

test('secondsUntilNextPacificMidnight: ordinary day', () => {
  assert.equal(secondsUntilNextPacificMidnight(new Date('2026-09-19T12:00:00Z')), 19 * 3600);
});

test('secondsUntilNextPacificMidnight: fall-back day is 25h long (86400 - secondsIntoDay would be wrong)', () => {
  // 2026-11-01 00:30 PDT; DST ends at 02:00 → the day has 25 real hours.
  assert.equal(secondsUntilNextPacificMidnight(new Date('2026-11-01T07:30:00Z')), 24 * 3600 + 30 * 60);
});

test('secondsUntilNextPacificMidnight: spring-forward day is 23h long', () => {
  // 2026-03-08 00:30 PST; DST starts at 02:00 → the day has 23 real hours.
  assert.equal(secondsUntilNextPacificMidnight(new Date('2026-03-08T08:30:00Z')), 22 * 3600 + 30 * 60);
});

test('summarizeQuotaFailures: chain recovers when the EARLIEST model does; zero models are ignored', () => {
  const s = summarizeQuotaFailures([
    { kind: 'zero' },
    { kind: 'per_day', retryAfterSec: 40000 },
    { kind: 'per_minute', retryAfterSec: 20 },
  ]);
  assert.ok(s instanceof QuotaExhaustedError);
  assert.equal(s.kind, 'per_minute');
  assert.equal(s.retryAfterSec, 20);
});

test('summarizeQuotaFailures: per_day + zero → per_day; all zero → zero with no retryAfter', () => {
  const day = summarizeQuotaFailures([{ kind: 'zero' }, { kind: 'per_day', retryAfterSec: 40000 }]);
  assert.deepEqual({ k: day.kind, r: day.retryAfterSec }, { k: 'per_day', r: 40000 });
  const zero = summarizeQuotaFailures([{ kind: 'zero' }, { kind: 'zero' }]);
  assert.deepEqual({ k: zero.kind, r: zero.retryAfterSec }, { k: 'zero', r: undefined });
});
