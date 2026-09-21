import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Type } from '@google/genai';
import { resetModelCooldowns } from './gemini';
import { QuotaExhaustedError, UpstreamUnavailableError } from './quota';
import { buildTiers, classifyProviderError, parseDurationSec, describeChain, generateJson, generateText, ProviderHttpError, resetLlmCooldowns, toChatMessages } from './llm/chain';
import { providerOrder, resolveProviders } from './llm/providers';
import { toJsonSchema, validateAgainstSchema } from './llm/schema';

beforeEach(() => {
  resetLlmCooldowns();
  resetModelCooldowns();
});

// ---------- schema ----------

const schema = {
  type: Type.OBJECT,
  properties: {
    title: { type: Type.STRING },
    count: { type: Type.INTEGER },
    vibe: { type: Type.STRING, enum: ['a', 'b'] },
    tags: { type: Type.ARRAY, minItems: 2, maxItems: 3, items: { type: Type.STRING } },
    nested: { type: Type.OBJECT, properties: { ok: { type: Type.BOOLEAN } }, required: ['ok'] },
  },
  required: ['title', 'tags'],
  propertyOrdering: ['title', 'count'],
};

test('toJsonSchema lowercases types, keeps constraints, drops Gemini-only keys', () => {
  const j: any = toJsonSchema(schema);
  assert.equal(j.type, 'object');
  assert.equal(j.properties.count.type, 'integer');
  assert.deepEqual(j.properties.vibe.enum, ['a', 'b']);
  assert.equal(j.properties.tags.minItems, 2);
  assert.equal(j.properties.tags.items.type, 'string');
  assert.equal('propertyOrdering' in j, false);
});

test('validateAgainstSchema accepts a conforming value', () => {
  assert.deepEqual(validateAgainstSchema({ title: 't', tags: ['x', 'y'], count: 3, vibe: 'a', nested: { ok: true } }, toJsonSchema(schema)), []);
});

test('validateAgainstSchema names every kind of violation', () => {
  const problems = validateAgainstSchema(
    { tags: ['only-one'], count: 1.5, vibe: 'zzz', nested: {} },
    toJsonSchema(schema)
  ).join('\n');
  assert.match(problems, /\$\.title: required but missing/);
  assert.match(problems, /\$\.tags: needs at least 2 items/);
  assert.match(problems, /\$\.count: expected integer/);
  assert.match(problems, /\$\.vibe: "zzz" is not one of/);
  assert.match(problems, /\$\.nested\.ok: required but missing/);
});

test('validateAgainstSchema flags too many items and a wrong root type', () => {
  assert.match(validateAgainstSchema({ title: 't', tags: ['1', '2', '3', '4'] }, toJsonSchema(schema)).join(), /allows at most 3 items/);
  assert.match(validateAgainstSchema([], toJsonSchema(schema)).join(), /expected object, got array/);
});

// ---------- providers ----------

test('providers resolve only when a key is present, in the configured order, with the Grok alias', () => {
  const env = { DEEPSEEK_API_KEY: 'd', GROK_API_KEY: 'g', GROQ_API_KEY: 'q' };
  assert.deepEqual(resolveProviders(env).map((p) => p.spec.id), ['deepseek', 'xai', 'groq']);
  assert.deepEqual(resolveProviders({ ...env, LLM_PROVIDER_ORDER: 'groq,deepseek' }).map((p) => p.spec.id), ['groq', 'deepseek']);
  assert.deepEqual(resolveProviders({}).length, 0);
});

test('model lists and token caps are overridable; unknown ids and duplicates are ignored', () => {
  const [p] = resolveProviders({ DEEPSEEK_API_KEY: 'd', DEEPSEEK_MODELS: 'x, y', DEEPSEEK_MAX_TOKENS: '999' });
  assert.deepEqual(p.models, ['x', 'y']);
  assert.equal(p.maxTokens, 999);
  assert.deepEqual(providerOrder({ LLM_PROVIDER_ORDER: 'groq,nope,groq,gemini' }), ['groq', 'nope', 'gemini']);
});

test('<ID>_BASE_URL redirects a provider (proxy, self-hosted, or a test stub)', () => {
  const [p] = resolveProviders({ DEEPSEEK_API_KEY: 'd', DEEPSEEK_BASE_URL: 'http://127.0.0.1:9/v1/' });
  assert.equal(p.spec.baseUrl, 'http://127.0.0.1:9/v1');
});

test('Gemini is last by default and is the only tier when nothing else is configured', () => {
  const tiers = buildTiers({ DEEPSEEK_API_KEY: 'd', GEMINI_API_KEY: 'k' });
  assert.deepEqual(tiers.map((t) => (t.kind === 'gemini' ? 'gemini' : t.provider.spec.id)), ['deepseek', 'gemini']);
  assert.deepEqual(buildTiers({}).map((t) => t.kind), ['gemini']);
  assert.match(describeChain({ DEEPSEEK_API_KEY: 'd', GEMINI_API_KEY: 'k' }), /^deepseek\(deepseek-v4-pro,deepseek-flash\) -> gemini\(/);
});

// ---------- error classification ----------

const http = (status: number, body: string, retryAfterSec?: number) => new ProviderHttpError('p', status, body, retryAfterSec);

test('classifyProviderError separates billing, per-minute, per-day, overload and bad-key', () => {
  assert.deepEqual(classifyProviderError(http(402, 'Insufficient Balance')), { kind: 'zero', status: 402 });
  assert.equal(classifyProviderError(http(429, 'You exceeded your current quota, please check your plan and billing')).kind, 'zero');
  assert.deepEqual(classifyProviderError(http(429, 'slow down', 12)), { kind: 'per_minute', retryAfterSec: 12, status: 429 });
  assert.equal(classifyProviderError(http(429, 'Rate limit reached: tokens per day (TPD): Limit 200000')).kind, 'per_day');
  assert.deepEqual(classifyProviderError(http(429, 'Please try again in 7m12s')), { kind: 'per_day', retryAfterSec: 432, status: 429 });
  assert.equal(classifyProviderError(http(503, 'overloaded')).kind, 'transient');
  assert.equal(classifyProviderError(http(401, 'bad key')).kind, 'other');
  assert.equal(classifyProviderError(Object.assign(new Error('t'), { name: 'TimeoutError' })).kind, 'transient');
  assert.equal(classifyProviderError(new TypeError('fetch failed')).kind, 'transient');
});

test('parseDurationSec reads the compound durations providers put in 429 bodies', () => {
  assert.equal(parseDurationSec('Please try again in 7m12.5s.'), 433);
  assert.equal(parseDurationSec('try again in 45s'), 45);
  assert.equal(parseDurationSec('retry in 1h2m'), 3720);
  assert.equal(parseDurationSec('try again in 250ms'), 1);
  assert.equal(parseDurationSec('no hint here'), undefined);
});

test('a daily cap with no reset time waits for the UTC day to roll over, never 60 s', () => {
  const at = Date.UTC(2026, 8, 21, 8, 0, 0); // 08:00 UTC -> 16 h to midnight
  // OpenRouter's free daily cap: no Retry-After, no "try again in" — this used to come back as 60 s.
  const openRouter = http(429, '{"error":{"message":"Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day","code":429}}');
  assert.deepEqual(classifyProviderError(openRouter, at), { kind: 'per_day', retryAfterSec: 16 * 3600, status: 429 });
  // Late in the UTC day the floor keeps it from turning into a fast re-poll.
  const lateAt = Date.UTC(2026, 8, 21, 23, 59, 0);
  assert.equal(classifyProviderError(http(429, 'daily limit reached'), lateAt).retryAfterSec, 3600);
  // The reset OpenRouter puts in its error metadata (epoch ms) wins over the guess.
  const resetMs = at + 5 * 3600 * 1000;
  const withReset = http(429, `{"error":{"message":"Rate limit exceeded: free-models-per-day","metadata":{"headers":{"X-RateLimit-Reset":"${resetMs}"}}}}`);
  assert.equal(classifyProviderError(withReset, at).retryAfterSec, 5 * 3600);
  // An explicit hint is still trusted as given.
  assert.equal(classifyProviderError(http(429, 'tokens per day (TPD). Please try again in 7m12s'), at).retryAfterSec, 432);
});

test('a missing model or an oversized request is named, so the chain can stop re-asking', () => {
  assert.deepEqual(classifyProviderError(http(404, 'not found')), { kind: 'other', status: 404, cause: 'model_missing' });
  assert.equal(classifyProviderError(http(400, '{"error":{"message":"Model Not Exist","type":"invalid_request_error"}}')).cause, 'model_missing');
  assert.equal(classifyProviderError(http(400, 'The model `grok-9` does not exist or you do not have access to it.')).cause, 'model_missing');
  assert.equal(classifyProviderError(http(400, '{"object":"error","message":"Invalid model: foo","type":"invalid_model"}')).cause, 'model_missing');
  assert.equal(classifyProviderError(http(413, 'Request too large for model on tokens per minute (TPM): Limit 8000, Requested 18000')).cause, 'too_large');
  // A 400 about this request's content is not a property of the model: no cause, no cooldown.
  assert.deepEqual(classifyProviderError(http(400, "'messages' must contain the word 'json'")), { kind: 'other', status: 400 });
});

// ---------- the chain ----------

interface Call { url: string; headers: Record<string, string>; body: any }
type Reply = { status?: number; headers?: Record<string, string>; content?: string; finish?: string; body?: string } | Error;

/** Routes by host: each provider gets a queue of replies; the last one repeats. */
function fakeFetch(byHost: Record<string, Reply[]>) {
  const calls: Call[] = [];
  const f = (async (url: string, init: any) => {
    const host = new URL(url).host;
    const queue = byHost[host];
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    if (!queue) throw new Error(`unexpected host ${host}`);
    const r = queue.length > 1 ? queue.shift()! : queue[0];
    if (r instanceof Error) throw r;
    const status = r.status ?? 200;
    if (status !== 200) return new Response(r.body ?? 'error', { status, headers: r.headers });
    return new Response(
      JSON.stringify({ choices: [{ message: { content: r.content ?? '{}' }, finish_reason: r.finish ?? 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
      { status: 200 }
    );
  }) as unknown as typeof fetch;
  return { f, calls };
}

const geminiAi = (text: string, spy?: { n: number }) =>
  ({ models: { generateContent: async () => { if (spy) spy.n++; return { text, candidates: [{ finishReason: 'STOP' }], usageMetadata: {} }; } } }) as any;
const noGemini = geminiAi('', undefined);
noGemini.models.generateContent = async () => { throw new Error('Gemini must not be called'); };

const DS = 'api.deepseek.com';
const XAI = 'api.x.ai';
const GROQ = 'api.groq.com';
const env = { DEEPSEEK_API_KEY: 'ds-key', XAI_API_KEY: 'xai-key', GROQ_API_KEY: 'groq-key', GEMINI_API_KEY: 'g-key' };
const simple = { type: Type.OBJECT, properties: { answer: { type: Type.STRING } }, required: ['answer'] };
const run = (ai: any, f: typeof fetch, e: Record<string, string> = env) =>
  generateJson<any>(ai, 'the prompt', 'the system', ['gm1'], simple, { fetch: f, env: e, sleep: async () => {}, now: () => 1_000_000 });

test('DeepSeek answers first: right URL, auth, JSON mode, schema in the prompt, Gemini never touched', async () => {
  const { f, calls } = fakeFetch({ [DS]: [{ content: '{"answer":"hi"}' }] });
  assert.deepEqual(await run(noGemini, f), { answer: 'hi' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.deepseek.com/chat/completions');
  assert.equal(calls[0].headers.Authorization, 'Bearer ds-key');
  assert.equal(calls[0].body.model, 'deepseek-v4-pro');
  assert.deepEqual(calls[0].body.response_format, { type: 'json_object' });
  assert.equal(calls[0].body.max_tokens, 16000);
  assert.match(calls[0].body.messages[0].content, /the system[\s\S]*JSON[\s\S]*"answer"/);
  assert.deepEqual(calls[0].body.messages[1], { role: 'user', content: 'the prompt' });
});

test('each provider gets its own token-cap parameter name', async () => {
  const { f, calls } = fakeFetch({ [DS]: [{ status: 402, body: 'Insufficient Balance' }], [XAI]: [{ content: '{"answer":"x"}' }] });
  await run(noGemini, f);
  assert.equal(calls[1].url, 'https://api.x.ai/v1/chat/completions');
  assert.equal(calls[1].body.max_completion_tokens, 16000);
  assert.equal('max_tokens' in calls[1].body, false);
});

test('falls through DeepSeek -> Grok -> Groq -> Gemini and cools the dead ones down', async () => {
  const { f, calls } = fakeFetch({
    [DS]: [{ status: 402, body: 'Insufficient Balance' }],
    [XAI]: [{ status: 429, headers: { 'retry-after': '30' }, body: 'rate' }],
    [GROQ]: [{ status: 503, body: 'overloaded' }],
  });
  const spy = { n: 0 };
  assert.deepEqual(await run(geminiAi('{"answer":"from gemini"}', spy), f), { answer: 'from gemini' });
  assert.equal(spy.n, 1);
  const first = calls.length; // ds v4-pro, xai grok-4.6, xai grok-4.3, groq x2 models
  assert.deepEqual(calls.map((c) => new URL(c.url).host), [DS, XAI, XAI, GROQ, GROQ]);
  // Second request: billing-dead DeepSeek is skipped provider-wide; cooled xAI and Groq models are skipped too.
  await run(geminiAi('{"answer":"again"}', spy), f);
  assert.equal(calls.length, first, 'no provider was retried while cooling down');
  assert.equal(spy.n, 2);
});

test('a truncated answer moves on to the next provider instead of returning half a document', async () => {
  const { f } = fakeFetch({ [DS]: [{ content: '{"answer":"cut off', finish: 'length' }], [XAI]: [{ content: '{"answer":"whole"}' }] });
  assert.deepEqual(await run(noGemini, f), { answer: 'whole' });
});

test('output that breaks the schema gets one repair round on the same model', async () => {
  const { f, calls } = fakeFetch({ [DS]: [{ content: '{"wrong":1}' }, { content: '{"answer":"fixed"}' }] });
  assert.deepEqual(await run(noGemini, f), { answer: 'fixed' });
  assert.equal(calls.length, 2);
  const repair = calls[1].body.messages;
  assert.equal(repair.at(-2).role, 'assistant');
  assert.match(repair.at(-1).content, /rejected[\s\S]*\$\.answer: required but missing/);
});

test('fences, <think> blocks and prose around the JSON are tolerated', async () => {
  const wrapped = '<think>hmm</think>Sure!\n```json\n{"answer":"ok"}\n```\nHope that helps.';
  const { f } = fakeFetch({ [DS]: [{ content: wrapped }] });
  assert.deepEqual(await run(noGemini, f), { answer: 'ok' });
});

test('every provider out on quota -> QuotaExhaustedError with the EARLIEST retry, not Gemini\'s', async () => {
  const { f } = fakeFetch({
    [DS]: [{ status: 429, headers: { 'retry-after': '20' }, body: 'rate' }],
    [XAI]: [{ status: 429, headers: { 'retry-after': '45' }, body: 'rate' }],
    [GROQ]: [{ status: 429, headers: { 'retry-after': '90' }, body: 'rate' }],
  });
  const gemDay = Object.assign(new Error('{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","message":"q","details":[{"@type":"type.googleapis.com/google.rpc.QuotaFailure","violations":[{"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier"}]}]}}'), { status: 429 });
  const ai = { models: { generateContent: async () => { throw gemDay; } } } as any;
  const err: any = await run(ai, f).catch((e) => e);
  assert.ok(err instanceof QuotaExhaustedError, String(err));
  assert.equal(err.kind, 'per_minute');
  assert.equal(err.retryAfterSec, 20);
});

test('all providers overloaded -> UpstreamUnavailableError (strict callers get 503, not 502)', async () => {
  const { f } = fakeFetch({ [DS]: [{ status: 503, body: 'x' }], [XAI]: [{ status: 500, body: 'x' }], [GROQ]: [{ status: 502, body: 'x' }] });
  const ai = { models: { generateContent: async () => { throw Object.assign(new Error('UNAVAILABLE'), { status: 503 }); } } } as any;
  assert.ok((await run(ai, f).catch((e) => e)) instanceof UpstreamUnavailableError);
});

test('bad keys everywhere surface as a real error, not a retryable one', async () => {
  const { f } = fakeFetch({ [DS]: [{ status: 401, body: 'bad key' }], [XAI]: [{ status: 401, body: 'bad key' }], [GROQ]: [{ status: 401, body: 'bad key' }] });
  const ai = { models: { generateContent: async () => { throw Object.assign(new Error('API key not valid'), { status: 400 }); } } } as any;
  const err: any = await run(ai, f).catch((e) => e);
  assert.ok(!(err instanceof QuotaExhaustedError) && !(err instanceof UpstreamUnavailableError));
  assert.match(String(err.message), /HTTP 401|API key/);
});

test('with no other provider configured the call is exactly the old Gemini path', async () => {
  const spy = { n: 0 };
  const boom = (async () => { throw new Error('no network for the chain'); }) as unknown as typeof fetch;
  assert.deepEqual(await run(geminiAi('{"answer":"legacy"}', spy), boom, { GEMINI_API_KEY: 'k' }), { answer: 'legacy' });
  assert.equal(spy.n, 1);
});

test('a model id that does not exist is skipped on the next request, not paid for again', async () => {
  const { f, calls } = fakeFetch({ [DS]: [{ status: 404, body: 'model not found' }, { content: '{"answer":"flash"}' }, { content: '{"answer":"flash again"}' }] });
  assert.deepEqual(await run(noGemini, f), { answer: 'flash' });
  assert.deepEqual(calls.map((c) => c.body.model), ['deepseek-v4-pro', 'deepseek-flash']);
  assert.deepEqual(await run(noGemini, f), { answer: 'flash again' });
  assert.deepEqual(calls.map((c) => c.body.model), ['deepseek-v4-pro', 'deepseek-flash', 'deepseek-flash'], 'the missing model was not asked again');
});

test('a 413 (request too large for this model) is skipped on the next request too', async () => {
  const { f, calls } = fakeFetch({ [DS]: [{ status: 413, body: 'Request too large' }, { content: '{"answer":"ok"}' }, { content: '{"answer":"ok"}' }] });
  await run(noGemini, f);
  await run(noGemini, f);
  assert.deepEqual(calls.map((c) => c.body.model), ['deepseek-v4-pro', 'deepseek-flash', 'deepseek-flash']);
});

test('every provider on a daily cap with no reset time -> a long Retry-After, not a one-minute re-poll', async () => {
  const daily = { status: 429, body: '{"error":{"message":"Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day"}}' };
  const { f } = fakeFetch({ [DS]: [daily], [XAI]: [daily], [GROQ]: [daily] });
  const gemDay = Object.assign(new Error('{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","message":"q","details":[{"@type":"type.googleapis.com/google.rpc.QuotaFailure","violations":[{"quotaId":"GenerateRequestsPerDayPerProjectPerModel-FreeTier"}]}]}}'), { status: 429 });
  const ai = { models: { generateContent: async () => { throw gemDay; } } } as any;
  const err: any = await run(ai, f).catch((e) => e);
  assert.ok(err instanceof QuotaExhaustedError, String(err));
  assert.equal(err.kind, 'per_day');
  assert.ok(err.retryAfterSec >= 3600, `retryAfterSec was ${err.retryAfterSec}`);
});

test('a request that finds a daily cap cooling down reports the real reset, not the shorter skip', async () => {
  const { f, calls } = fakeFetch({ [DS]: [{ status: 429, body: 'daily limit reached', headers: { 'retry-after': '20000' } }] });
  const e = { DEEPSEEK_API_KEY: 'k' };
  let t = 1_000_000;
  const go = () => generateJson<any>(noGemini, 'p', 's', ['gm1'], simple, { fetch: f, env: e, sleep: async () => {}, now: () => t }).catch((x) => x);
  assert.equal((await go()).retryAfterSec, 20000);
  const called = calls.length;
  t += 100_000; // 100 s later: still inside the 30-min skip window
  const again: any = await go();
  assert.equal(calls.length, called, 'the cooled model was skipped');
  assert.ok(again instanceof QuotaExhaustedError);
  assert.equal(again.retryAfterSec, 19900);
});

test('when every model is skipped for a non-retryable reason, the error still says what went wrong', async () => {
  const { f } = fakeFetch({ [DS]: [{ status: 404, body: 'model not found' }] });
  const e = { DEEPSEEK_API_KEY: 'k' };
  const go = () => generateJson<any>(noGemini, 'p', 's', ['gm1'], simple, { fetch: f, env: e, sleep: async () => {}, now: () => 1_000_000 }).catch((x) => x);
  await go();
  const err: any = await go(); // both models now cooling down
  assert.ok(!(err instanceof QuotaExhaustedError) && !(err instanceof UpstreamUnavailableError));
  assert.match(String(err.message), /cooling down after: deepseek HTTP 404: model not found/);
});

// ---------- chat ----------

test('toChatMessages maps Gemini contents to OpenAI messages', () => {
  assert.deepEqual(
    toChatMessages([{ role: 'user', parts: [{ text: 'hi' }] }, { role: 'model', parts: [{ text: 'yo' }] }], 'sys'),
    [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }]
  );
});

test('generateText reports who answered', async () => {
  const { f } = fakeFetch({ [DS]: [{ status: 503, body: 'x' }], [XAI]: [{ content: 'plain reply' }] });
  const r = await generateText(noGemini, [{ role: 'user', parts: [{ text: 'q' }] }], 'sys', ['gm1'], { fetch: f, env });
  assert.deepEqual(r, { text: 'plain reply', via: 'xai/grok-4.6' });
});

// ---------- array roots (/api/ip-names asks for a JSON array) ----------

const runArray = (f: typeof fetch) =>
  generateJson<any[]>(noGemini, 'the prompt', 'the system', ['gm1'], undefined, { fetch: f, env, rootArray: true });

test('rootArray asks json_object providers for {"items": [...]} and returns the bare array', async () => {
  const { f, calls } = fakeFetch({ [DS]: [{ content: '{"items":[{"id":"ip-1"},{"id":"ip-2"}]}' }] });
  assert.deepEqual(await runArray(f), [{ id: 'ip-1' }, { id: 'ip-2' }]);
  assert.match(calls[0].body.messages[0].content, /\{"items": \[ \.\.\. \]\}/);
  assert.deepEqual(calls[0].body.response_format, { type: 'json_object' });
});

test('rootArray also accepts a bare array or a single-key wrapper, and rejects empty', async () => {
  assert.deepEqual(await runArray(fakeFetch({ [DS]: [{ content: '```json\n[{"id":"a"}]\n```' }] }).f), [{ id: 'a' }]);
  assert.deepEqual(await runArray(fakeFetch({ [DS]: [{ content: '{"brands":[{"id":"b"}]}' }] }).f), [{ id: 'b' }]);
  resetLlmCooldowns();
  const { f } = fakeFetch({ [DS]: [{ content: '{"items":[]}' }], [XAI]: [{ content: '{"items":[{"id":"c"}]}' }] });
  assert.deepEqual(await runArray(f), [{ id: 'c' }], 'an empty array is a failed answer: repaired once, then next provider');
});
