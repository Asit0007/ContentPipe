import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateJson, resetLlmCooldowns } from './llm/chain';
import { modelAllowedFor, reservedModels } from './llm/providers';
import { enterModelUsage, purposeForPath } from './llm/usage';
import { resetModelCooldowns } from './gemini';
import type { ModelCall } from '../shared/modelUsage';

beforeEach(() => {
  resetLlmCooldowns();
  resetModelCooldowns();
});

const ENV = {
  GEMINI_API_KEY: 'g', GROQ_API_KEY: 'q', GEMINI_RPM_PACING: 'off',
  LLM_MODEL_ORDER: 'gemini:gemini-3.8-flash,groq:qwen/qwen3.8-27b',
  LLM_RESERVED_FOR: 'gemini:gemini-3.8-flash=script',
};

function fakes() {
  const gemini: string[] = [];
  const groq: string[] = [];
  const ai: any = { models: { generateContent: async ({ model }: any) => { gemini.push(model); return { text: '{"from":"gemini"}', candidates: [{ finishReason: 'STOP' }], usageMetadata: {} }; } } };
  const f = (async (_url: string, init: any) => {
    groq.push(JSON.parse(init.body).model);
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"from":"groq"}' }, finish_reason: 'stop' }] }), { status: 200 });
  }) as unknown as typeof fetch;
  return { ai, f, gemini, groq };
}

const call = (purpose: string | undefined, x: ReturnType<typeof fakes>, calls: ModelCall[] = []) =>
  enterModelUsage(calls, () => generateJson<any>(x.ai, 'p', 's', undefined, undefined, { fetch: x.f, env: ENV, sleep: async () => {} }), purpose);

test('purposeForPath: the route name, whether or not Express stripped the /api mount', () => {
  assert.equal(purposeForPath('/script'), 'script');
  assert.equal(purposeForPath('/api/script'), 'script');
  assert.equal(purposeForPath('/export/markdown'), 'export');
  assert.equal(purposeForPath('/'), undefined);
});

test('LLM_RESERVED_FOR parses provider:model=purpose|purpose; model ids keep their colons', () => {
  const r = reservedModels({ LLM_RESERVED_FOR: 'gemini:gemini-3.8-flash=script, openrouter:qwen/qwen3.8-27b:free=Script|plan, junk, =x, gemini:m=' });
  assert.deepEqual([...r.keys()], ['gemini:gemini-3.8-flash', 'openrouter:qwen/qwen3.8-27b:free']);
  assert.deepEqual([...r.get('openrouter:qwen/qwen3.8-27b:free')!], ['script', 'plan']);
  assert.equal(modelAllowedFor('gemini', 'gemini-3.8-flash', 'script', { LLM_RESERVED_FOR: 'gemini:gemini-3.8-flash=script' }), true);
  assert.equal(modelAllowedFor('gemini', 'gemini-3.8-flash', 'plan', { LLM_RESERVED_FOR: 'gemini:gemini-3.8-flash=script' }), false);
  assert.equal(modelAllowedFor('gemini', 'gemini-3.6-flash', 'plan', { LLM_RESERVED_FOR: 'gemini:gemini-3.8-flash=script' }), true, 'unreserved: always');
  assert.equal(modelAllowedFor('gemini', 'gemini-3.8-flash', 'plan', {}), true, 'unset: nothing reserved');
});

test('/api/script gets the reserved model first', async () => {
  const x = fakes();
  assert.deepEqual(await call('script', x), { from: 'gemini' });
  assert.deepEqual(x.gemini, ['gemini-3.8-flash']);
  assert.deepEqual(x.groq, []);
});

test('any other request skips it, says why in the provenance, and the next model answers', async () => {
  const x = fakes();
  const calls: ModelCall[] = [];
  assert.deepEqual(await call('research', x, calls), { from: 'groq' });
  assert.deepEqual(x.gemini, [], 'the reserved model received no request');
  const skipped = calls[0].attempts.find((a) => a.model === 'gemini-3.8-flash')!;
  assert.equal(skipped.outcome, 'skipped');
  assert.match(skipped.detail!, /reserved.*research/);
});

test('a call outside any request (video burn, scripts) never uses a reserved model', async () => {
  const x = fakes();
  await generateJson<any>(x.ai, 'p', 's', undefined, undefined, { fetch: x.f, env: ENV, sleep: async () => {} });
  assert.deepEqual(x.gemini, []);
  assert.deepEqual(x.groq, ['qwen/qwen3.8-27b']);
});

test('review #7: a route whose every model is reserved gets an error that says so', async () => {
  const x = fakes();
  const env = { GEMINI_API_KEY: 'g', GEMINI_RPM_PACING: 'off', LLM_MODEL_ORDER: 'gemini:gemini-3.8-flash', LLM_RESERVED_FOR: 'gemini:gemini-3.8-flash=script' };
  await assert.rejects(
    enterModelUsage([], () => generateJson<any>(x.ai, 'p', 's', undefined, undefined, { fetch: x.f, env, sleep: async () => {} }), 'research'),
    /reserved for other requests.*research/
  );
  assert.deepEqual(x.gemini, []);
});
