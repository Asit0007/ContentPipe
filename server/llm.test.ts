import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Type } from '@google/genai';
import { resetModelCooldowns } from './gemini';
import { QuotaExhaustedError, UpstreamUnavailableError } from './quota';
import { buildTiers, classifyProviderError, parseDurationSec, describeChain, generateJson, generateText, ProviderHttpError, resetLlmCooldowns, toChatMessages } from './llm/chain';
import { modelOrder, providerOrder, resolveProviders } from './llm/providers';
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

test('Ollama Cloud resolves from OLLAMA_API_KEY or from the misspelt OLAMA_API_KEY the key was first saved under', () => {
  for (const key of ['OLLAMA_API_KEY', 'OLAMA_API_KEY']) {
    const [p] = resolveProviders({ [key]: 'o' });
    assert.equal(p.spec.id, 'ollama');
    assert.equal(p.spec.baseUrl, 'https://ollama.com/v1');
    assert.deepEqual(p.models, ['nemotron-3-ultra', 'gemma4:31b', 'nemotron-3-super', 'gpt-oss:120b']);
  }
  assert.deepEqual(providerOrder({}).slice(-3), ['ollama', 'mistral', 'gemini'], 'in the default order, ahead of Mistral and Gemini');
});

// ---------- model-by-model order (LLM_MODEL_ORDER) ----------

const RANKED =
  'gemini:gemini-3.7-flash,groq:qwen/qwen3.8-27b,openrouter:z-ai/glm-5.2:free,gemini:gemini-3.6-flash,ollama:nemotron-3-ultra,ollama:gemma4:31b,groq:openai/gpt-oss-120b';
const allKeys = { GEMINI_API_KEY: 'g', GROQ_API_KEY: 'q', OPENROUTER_API_KEY: 'o', OLLAMA_API_KEY: 'l' };

test('LLM_MODEL_ORDER: the provider is what precedes the first colon, so model ids may contain slashes and colons', () => {
  assert.deepEqual(modelOrder({ LLM_MODEL_ORDER: RANKED }).map((e) => `${e.provider} | ${e.model}`), [
    'gemini | gemini-3.7-flash',
    'groq | qwen/qwen3.8-27b',
    'openrouter | z-ai/glm-5.2:free',
    'gemini | gemini-3.6-flash',
    'ollama | nemotron-3-ultra',
    'ollama | gemma4:31b',
    'groq | openai/gpt-oss-120b',
  ]);
});

test('LLM_MODEL_ORDER: malformed entries and repeats are dropped, providers are case-insensitive, unset means empty', () => {
  assert.deepEqual(
    modelOrder({ LLM_MODEL_ORDER: 'nocolon, :nomodel, noprovider:, Groq:a,groq:a, groq:b ' }).map((e) => `${e.provider}:${e.model}`),
    ['groq:a', 'groq:b']
  );
  assert.deepEqual(modelOrder({}), []);
  assert.deepEqual(modelOrder({ LLM_MODEL_ORDER: '  ' }), []);
});

test('LLM_MODEL_ORDER replaces the provider order and the model lists: only what it names, from providers that have a key', () => {
  const providers = resolveProviders({ ...allKeys, GROQ_MODELS: 'ignored', LLM_PROVIDER_ORDER: 'ollama', LLM_MODEL_ORDER: RANKED });
  assert.deepEqual(providers.map((p) => p.spec.id), ['groq', 'openrouter', 'ollama'], 'order of first mention; gemini is the chain\'s own tier');
  assert.deepEqual(providers.find((p) => p.spec.id === 'groq')!.models, ['qwen/qwen3.8-27b', 'openai/gpt-oss-120b']);
  assert.deepEqual(providers.find((p) => p.spec.id === 'ollama')!.models, ['nemotron-3-ultra', 'gemma4:31b']);
  const noGroq = resolveProviders({ OPENROUTER_API_KEY: 'o', LLM_MODEL_ORDER: RANKED });
  assert.deepEqual(noGroq.map((p) => p.spec.id), ['openrouter'], 'an entry for a provider without a key is skipped');
});

test('LLM_MODEL_ORDER builds one tier per run of consecutive models, so a provider can appear again further down', () => {
  const tiers = buildTiers({ ...allKeys, LLM_MODEL_ORDER: RANKED });
  assert.deepEqual(
    tiers.map((t) => (t.kind === 'gemini' ? `gemini[${t.models}]` : `${t.provider.spec.id}[${t.provider.models}]`)),
    [
      'gemini[gemini-3.7-flash]',
      'groq[qwen/qwen3.8-27b]',
      'openrouter[z-ai/glm-5.2:free]',
      'gemini[gemini-3.6-flash]',
      'ollama[nemotron-3-ultra,gemma4:31b]',
      'groq[openai/gpt-oss-120b]',
    ]
  );
  assert.equal(
    describeChain({ ...allKeys, LLM_MODEL_ORDER: RANKED }),
    'gemini(gemini-3.7-flash) -> groq(qwen/qwen3.8-27b) -> openrouter(z-ai/glm-5.2:free) -> gemini(gemini-3.6-flash) -> ollama(nemotron-3-ultra,gemma4:31b) -> groq(openai/gpt-oss-120b)'
  );
});

test('LLM_MODEL_ORDER: no usable entry (no keys) falls back to Gemini alone, and without the variable nothing changes', () => {
  assert.deepEqual(buildTiers({ LLM_MODEL_ORDER: RANKED }).map((t) => t.kind), ['gemini']);
  const plain = buildTiers({ DEEPSEEK_API_KEY: 'd', GEMINI_API_KEY: 'k' });
  assert.deepEqual(plain.map((t) => (t.kind === 'gemini' ? `gemini:${t.models ?? 'default'}` : t.provider.spec.id)), ['deepseek', 'gemini:default']);
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

// Live run: Groq's per-minute limit on Qwen3.8 27B ("try again in 3.48s") ends with an upgrade link containing
// "billing", which classified it as out of credits and benched the whole provider for 30 minutes.
test('a per-minute rate limit whose upgrade link mentions billing is still just per-minute', () => {
  const body =
    '{"error":{"message":"Rate limit reached for model `qwen/qwen3.8-27b` in organization `org_x` service tier `on_demand` on output tokens per minute (OTPM): Limit 1000, Used 771, Requested 287. Please try again in 3.48s. Need more tokens? Upgrade to Dev Tier today at https://console.groq.com/settings/billing","type":"tokens","code":"rate_limit_exceeded"}}';
  const c = classifyProviderError(http(429, body));
  assert.equal(c.kind, 'per_minute');
  assert.ok((c.retryAfterSec ?? 99) < 10, `waits seconds, not a provider-wide bench: ${c.retryAfterSec}`);
  // The genuine no-credit wordings still classify as zero.
  assert.equal(classifyProviderError(http(429, 'You exceeded your current quota, please check your plan and billing details')).kind, 'zero');
  assert.equal(classifyProviderError(http(429, 'Please check your billing details to continue')).kind, 'zero');
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

// Live run: Groq answered 413 to the 10k-token research prompt and the model was then skipped for the 4k-token plan
// prompt that fits, so the second-smartest model sat out exactly the stages it could serve.
test('a 413 benches the model only for requests as large as the one that failed; a smaller request still gets a try', async () => {
  const { f, calls } = fakeFetch({ [DS]: [{ status: 413, body: 'Request too large' }, { content: '{"answer":"ok"}' }] });
  const call = (prompt: string) => generateJson<any>(noGemini, prompt, 'sys', ['gm1'], simple, { fetch: f, env: { DEEPSEEK_API_KEY: 'k' }, sleep: async () => {}, now: () => 1_000_000 });
  const big = 'x'.repeat(5000);
  await call(big);
  await call(big);
  await call('short');
  assert.deepEqual(calls.map((c) => c.body.model), ['deepseek-v4-pro', 'deepseek-flash', 'deepseek-flash', 'deepseek-v4-pro']);
});

test('a smaller request that also gets a 413 lowers the bar, so the next one that size is skipped', async () => {
  const { f, calls } = fakeFetch({ [DS]: [{ status: 413, body: 'too large' }, { status: 413, body: 'too large' }, { content: '{"answer":"ok"}' }] });
  const call = (prompt: string) => generateJson<any>(noGemini, prompt, 'sys', ['gm1'], simple, { fetch: f, env: { DEEPSEEK_API_KEY: 'k', DEEPSEEK_MODELS: 'm' }, sleep: async () => {}, now: () => 1_000_000 });
  await assert.rejects(call('x'.repeat(5000)));
  await assert.rejects(call('x'.repeat(2000)), 'smaller than the failure, so it was tried — and failed too');
  await assert.rejects(call('x'.repeat(3000)), 'now skipped: 3000 is at least as big as the smallest failure');
  assert.deepEqual(calls.map((c) => c.body.model), ['m', 'm'], 'the third request never reached the model');
});

// Live run: Nemotron 3 Ultra timed out at 120 s on every real prompt and, with a 30 s cooldown, was waited on again
// for every request — two minutes lost per call.
test('a timeout benches the model for ten minutes, not the 30 s a 5xx earns', async () => {
  const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
  const { f, calls } = fakeFetch({ [DS]: [timeout], [XAI]: [{ content: '{"answer":"fast"}' }] });
  let t = 1_000_000;
  const e = { DEEPSEEK_API_KEY: 'k', DEEPSEEK_MODELS: 'slow', XAI_API_KEY: 'x', XAI_MODELS: 'fast' };
  const call = () => generateJson<any>(noGemini, 'p', 's', ['gm1'], simple, { fetch: f, env: e, sleep: async () => {}, now: () => t });
  assert.deepEqual(await call(), { answer: 'fast' });
  t += 60_000; // past a transient cooldown, well inside a timeout one
  await call();
  assert.deepEqual(calls.map((c) => c.body.model), ['slow', 'fast', 'fast'], 'the slow model was not waited on again a minute later');
  t += 600_000;
  await call();
  assert.deepEqual(calls.map((c) => c.body.model), ['slow', 'fast', 'fast', 'slow', 'fast'], 'after ten minutes it gets another chance');
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

// ---------- model-by-model order: behaviour ----------

const OPENROUTER = 'openrouter.ai';
const geminiOverloaded = () => Object.assign(new Error('{"error":{"code":503,"message":"This model is currently experiencing high demand.","status":"UNAVAILABLE"}}'), { status: 503 });
/** A fake Gemini client that records the model of every call. */
function geminiSpy(behave: (model: string) => string | Error) {
  const models: string[] = [];
  const ai: any = {
    models: {
      generateContent: async ({ model }: { model: string }) => {
        models.push(model);
        const r = behave(model);
        if (r instanceof Error) throw r;
        return { text: r, candidates: [{ finishReason: 'STOP' }], usageMetadata: {} };
      },
    },
  };
  return { ai, models };
}
const runOrdered = (ai: any, f: typeof fetch, e: Record<string, string>, sleeps: number[] = []) =>
  generateJson<any>(ai, 'the prompt', 'the system', ['unused'], simple, { fetch: f, env: e, sleep: async (ms: number) => void sleeps.push(ms), now: () => 1_000_000 });

test('a top model that fails hands over to the NEXT-RANKED model on another provider, not to a weaker one on the same provider', async () => {
  // Provider-level order would have tried groq/low right after groq/top. Model order goes to openrouter/mid.
  const { f, calls } = fakeFetch({
    [GROQ]: [{ status: 429, headers: { 'retry-after': '30' }, body: 'rate' }],
    [OPENROUTER]: [{ content: '{"answer":"from mid"}' }],
  });
  const e = { GROQ_API_KEY: 'q', OPENROUTER_API_KEY: 'o', LLM_MODEL_ORDER: 'groq:top,openrouter:mid,groq:low' };
  assert.deepEqual(await runOrdered(noGemini, f, e), { answer: 'from mid' });
  assert.deepEqual(calls.map((c) => c.body.model), ['top', 'mid']);
});

test('Gemini first and busy hands over at once: no 8 s wait-and-retry, and the next tier answers', async () => {
  const gem = geminiSpy(() => geminiOverloaded());
  const { f, calls } = fakeFetch({ [GROQ]: [{ content: '{"answer":"from groq"}' }] });
  const sleeps: number[] = [];
  const e = { GEMINI_API_KEY: 'g', GROQ_API_KEY: 'q', LLM_MODEL_ORDER: 'gemini:gm-a,groq:g-1,gemini:gm-b' };
  assert.deepEqual(await runOrdered(gem.ai, f, e, sleeps), { answer: 'from groq' });
  assert.deepEqual(gem.models, ['gm-a'], 'one attempt on the busy Gemini model, then on to Groq; gm-b is never reached');
  assert.equal(calls.length, 1);
  assert.ok(sleeps.every((ms) => ms < 1000), `no wait long enough to notice, got ${JSON.stringify(sleeps)}`);
});

test('a Gemini tier at the very end is the last resort and keeps its one bounded wait-and-retry', async () => {
  const gem = geminiSpy(() => geminiOverloaded());
  const { f } = fakeFetch({ [GROQ]: [{ status: 503, body: 'overloaded' }] });
  const sleeps: number[] = [];
  const e = { GEMINI_API_KEY: 'g', GROQ_API_KEY: 'q', LLM_MODEL_ORDER: 'groq:g-1,gemini:gm-a' };
  await assert.rejects(runOrdered(gem.ai, f, e, sleeps), UpstreamUnavailableError);
  assert.deepEqual(gem.models, ['gm-a', 'gm-a'], 'tried, waited, tried once more');
  assert.ok(sleeps.includes(8000), `the 8 s transient wait is kept, got ${JSON.stringify(sleeps)}`);
});

test('an interleaved Gemini tier answers with the model the order named, not the built-in list', async () => {
  const gem = geminiSpy(() => '{"answer":"from gemini"}');
  const { f, calls } = fakeFetch({ [GROQ]: [{ content: '{"answer":"unused"}' }] });
  const e = { GEMINI_API_KEY: 'g', GROQ_API_KEY: 'q', LLM_MODEL_ORDER: 'gemini:gemini-3.7-flash,groq:x' };
  assert.deepEqual(await runOrdered(gem.ai, f, e), { answer: 'from gemini' });
  assert.deepEqual(gem.models, ['gemini-3.7-flash']);
  assert.equal(calls.length, 0);
});

test('generateText follows the same model order and reports who answered', async () => {
  const gem = geminiSpy(() => geminiOverloaded());
  const { f } = fakeFetch({ [GROQ]: [{ content: 'a plain reply' }] });
  const e = { GEMINI_API_KEY: 'g', GROQ_API_KEY: 'q', LLM_MODEL_ORDER: 'gemini:gm-a,groq:qwen/qwen3.8-27b' };
  const r = await generateText(gem.ai, [{ role: 'user', parts: [{ text: 'hi' }] }], 'sys', ['unused'], { fetch: f, env: e, now: () => 1_000_000 });
  assert.deepEqual(r, { text: 'a plain reply', via: 'groq/qwen/qwen3.8-27b' });
  assert.deepEqual(gem.models, ['gm-a']);
});

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
