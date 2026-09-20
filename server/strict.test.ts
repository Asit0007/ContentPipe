import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toStrictFailure, orFallback, isStrict } from './strict';
import { QuotaExhaustedError, UpstreamUnavailableError } from './quota';

test('isStrict only honours the exact opt-in header value', () => {
  const req = (v?: string) => ({ get: (h: string) => (h.toLowerCase() === 'x-contentpipe-strict' ? v : undefined) });
  assert.equal(isStrict(req('1')), true);
  assert.equal(isStrict(req('true')), false);
  assert.equal(isStrict(req(undefined)), false);
});

test('per-day quota → 429 with Retry-After and progress/runId context', () => {
  const e = new QuotaExhaustedError('per_day', 68400, 'Daily quota exhausted');
  e.runId = 'abc';
  e.progress = { scenesSoFar: 21 };
  const f = toStrictFailure(e);
  assert.equal(f.status, 429);
  assert.equal(f.headers['Retry-After'], '68400');
  assert.deepEqual(f.body, {
    error: 'Daily quota exhausted',
    kind: 'per_day',
    retryable: true,
    retryAfterSec: 68400,
    runId: 'abc',
    progress: { scenesSoFar: 21 },
  });
});

test('limit: 0 (no quota exists) is NOT a 429 — retrying is futile, so 502 non-retryable', () => {
  const f = toStrictFailure(new QuotaExhaustedError('zero', undefined, 'no quota'));
  assert.equal(f.status, 502);
  assert.equal(f.headers['Retry-After'], undefined);
  assert.equal((f.body as any).kind, 'zero_quota');
  assert.equal((f.body as any).retryable, false);
});

test('overload → 503 with Retry-After', () => {
  const f = toStrictFailure(new UpstreamUnavailableError(30, 'busy'));
  assert.equal(f.status, 503);
  assert.equal(f.headers['Retry-After'], '30');
});

test('an untyped error is classified rather than blindly 500: raw 429 → 429, bad key → 502', () => {
  const raw429 = Object.assign(new Error('quota'), { status: 429 });
  assert.equal(toStrictFailure(raw429).status, 429);
  const bad = Object.assign(new Error('{"error":{"code":400,"message":"API key not valid."}}'), { status: 400 });
  const f = toStrictFailure(bad);
  assert.equal(f.status, 502);
  assert.equal((f.body as any).retryable, false);
});

test('orFallback: UI path swallows into the fallback, strict path rethrows', async () => {
  const boom = async () => {
    throw new Error('x');
  };
  assert.equal(await orFallback(false, boom, () => 'canned'), 'canned');
  await assert.rejects(orFallback(true, boom, () => 'canned'), /x/);
  assert.equal(await orFallback(true, async () => 'real', () => 'canned'), 'real');
});
