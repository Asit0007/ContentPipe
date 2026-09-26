import { test, beforeEach, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Type } from '@google/genai';
import { resetModelCooldowns } from './gemini';
import { generateJson, generateText, resetLlmCooldowns } from './llm/chain';
import { recordModelUsage, withModelTask } from './llm/usage';
import { RunJournal } from './runJournal';
import { describeModelLineup } from './modelLineup';
import { withoutModelUsage, type ModelCall } from '../shared/modelUsage';

beforeEach(() => {
  resetLlmCooldowns();
  resetModelCooldowns();
});

let dir: string;
before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cp-usage-'));
});
after(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const simple = { type: Type.OBJECT, properties: { answer: { type: Type.STRING } }, required: ['answer'] };
const overloaded = () => Object.assign(new Error('{"error":{"code":503,"message":"high demand","status":"UNAVAILABLE"}}'), { status: 503 });

/** Gemini fake: `behave` decides per model; usage metadata is reported like the real SDK. */
function gemini(behave: (model: string) => string | Error) {
  return {
    models: {
      generateContent: async ({ model }: { model: string }) => {
        const r = behave(model);
        if (r instanceof Error) throw r;
        return { text: r, candidates: [{ finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 30 } };
      },
    },
  } as any;
}

/** OpenAI-style provider fake: one reply for every request. */
const provider = (status: number, content = '{"answer":"from groq"}') =>
  (async () =>
    status === 200
      ? new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 7 } }), { status: 200 })
      : new Response('rate', { status, headers: { 'retry-after': '30' } })) as unknown as typeof fetch;

const opts = (env: Record<string, string>, f?: typeof fetch) => ({ env, fetch: f, sleep: async () => {}, now: () => 1_000_000 });

test('records the model that answered, the ones that failed before it, and the task label', async () => {
  const env = { GEMINI_API_KEY: 'g', GROQ_API_KEY: 'q', LLM_MODEL_ORDER: 'gemini:gm-top,groq:qwen' };
  const { calls } = await recordModelUsage(() =>
    withModelTask('Video blueprint', () => generateJson(gemini(() => overloaded()), 'p', 's', ['x'], simple, opts(env, provider(200))))
  );
  assert.equal(calls.length, 1);
  const [c] = calls;
  assert.equal(c.task, 'Video blueprint');
  assert.equal(c.ok, true);
  assert.equal(c.provider, 'groq');
  assert.equal(c.model, 'qwen');
  assert.deepEqual(
    c.attempts.map((a) => [a.provider, a.model, a.outcome]),
    [
      ['gemini', 'gm-top', 'overloaded'],
      ['groq', 'qwen', 'ok'],
    ]
  );
  assert.equal(c.attempts[1].inputTokens, 50);
  assert.equal(c.attempts[1].outputTokens, 7);
  assert.match(c.attempts[0].detail!, /503/);
});

test('the Gemini-only path records one call (not one per layer) with the answering model and its tokens', async () => {
  const { calls } = await recordModelUsage(() =>
    generateJson(gemini((m) => (m === 'b' ? '{"answer":"ok"}' : overloaded())), 'p', 's', ['a', 'b'], simple, opts({ GEMINI_API_KEY: 'g' }))
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, 'b');
  assert.equal(calls[0].task, 'Text generation', 'an unlabelled call still shows up');
  assert.deepEqual(calls[0].attempts.map((a) => a.outcome), ['overloaded', 'ok']);
  assert.equal(calls[0].attempts[1].outputTokens, 30);
});

test('a call no model answered is recorded as failed, with every attempt', async () => {
  const env = { GROQ_API_KEY: 'q', LLM_MODEL_ORDER: 'groq:qwen' };
  const calls: ModelCall[] = [];
  await assert.rejects(recordModelUsage(() => generateJson(gemini(() => overloaded()), 'p', 's', ['x'], simple, opts(env, provider(429))), calls));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].ok, false);
  assert.equal(calls[0].model, undefined);
  assert.equal(calls[0].attempts[0].outcome, 'quota');
});

test('chat credits the Gemini model that actually replied, not the first in its list', async () => {
  const { result, calls } = await recordModelUsage(() =>
    generateText(gemini((m) => (m === 'second' ? 'hello' : overloaded())), [{ role: 'user', parts: [{ text: 'hi' }] }], 's', ['first', 'second'], opts({ GEMINI_API_KEY: 'g', LLM_MODEL_ORDER: '' }))
  );
  assert.equal(result.via, 'gemini/second');
  assert.equal(calls[0].model, 'second');
});

test('outside a recording nothing is collected and nothing breaks', async () => {
  assert.deepEqual(await generateJson(gemini(() => '{"answer":"ok"}'), 'p', 's', ['a'], simple, opts({ GEMINI_API_KEY: 'g' })), { answer: 'ok' });
});

test('a resumed script run still reports the calls of its interrupted first request, marked as replayed', async () => {
  const first = await RunJournal.open('usage-run', 'h1', { dir });
  const live: ModelCall[] = [];
  first.trackModelCalls(live);
  live.push({ task: 'Production bible (cast + style guide)', kind: 'json', ok: true, provider: 'groq', model: 'qwen', attempts: [], startedAt: 't', ms: 5 });
  await first.setBible({ characterBible: [{ id: 'x' }], styleGuide: {} });

  const second = await RunJournal.open('usage-run', 'h1', { dir }); // the re-POST after a 429
  const prior = second.priorModelCalls();
  assert.equal(prior.length, 1);
  assert.equal(prior[0].fromCheckpoint, true);
  assert.equal(prior[0].model, 'qwen');

  // The route puts replayed calls first, then this request's; saving must not duplicate the replayed ones.
  const next: ModelCall[] = [...prior];
  second.trackModelCalls(next);
  next.push({ task: 'Narrative, scenes 1-3 (chunk 1/2)', kind: 'json', ok: true, provider: 'gemini', model: 'gm', attempts: [], startedAt: 't', ms: 5 });
  await second.setNarrativeChunk(0, [{ sceneNumber: 1 }]);
  const third = await RunJournal.open('usage-run', 'h1', { dir });
  assert.deepEqual(third.priorModelCalls().map((c) => c.task), ['Production bible (cast + style guide)', 'Narrative, scenes 1-3 (chunk 1/2)']);
});

test('modelUsage echoed back in a request body is removed before it can reach a prompt or a resume hash', () => {
  const research = { topicTitle: 't', modelUsage: [{ task: 'x' }] };
  assert.deepEqual(withoutModelUsage(research), { topicTitle: 't' });
  assert.equal(withoutModelUsage('text'), 'text');
  const plain = { a: 1 };
  assert.equal(withoutModelUsage(plain), plain, 'untouched objects are returned as they are');
});

test('the lineup lists exactly the models the chain will try, in order, with details', () => {
  const l = describeModelLineup({ GEMINI_API_KEY: 'g', GROQ_API_KEY: 'q', LLM_MODEL_ORDER: 'gemini:gemini-3.7-flash,groq:qwen/qwen3.8-27b,mistral:mistral-small-latest' });
  // Mistral has no key, so the chain skips it and so does the list.
  assert.deepEqual(l.text.map((e) => `${e.rank}:${e.provider}:${e.model}`), ['1:gemini:gemini-3.7-flash', '2:groq:qwen/qwen3.8-27b']);
  assert.equal(l.text[0].info?.name, 'Gemini 3.7 Flash');
  assert.equal(l.text[1].info?.intelligence, 34);
  assert.match(l.textOrderSource, /LLM_MODEL_ORDER/);
  assert.ok(l.speech.length > 0);
  // Images and video default to Hugging Face Spaces only, in the owner's order; nothing unlisted is tried.
  assert.deepEqual(l.image.map((e) => `${e.provider}:${e.model}`).slice(0, 2), ['hf:Qwen/Qwen-Image-2512', 'hf:HiDream-ai/HiDream-O1-Image']);
  assert.ok(!l.image.some((e) => e.provider === 'pollinations' || e.provider === 'gemini'));
  assert.deepEqual(l.video.map((e) => e.model), ['MiniMaxAI/MiniMax-H3-Turbo-Lora', 'zerogpu-aoti/wan2-2-fp8da-aoti-faster']);
  assert.equal(l.video[0].info?.name, 'MiniMax-H3 Turbo LoRA');
});

test('IMAGE_PROVIDER_ORDER / VIDEO_PROVIDER_ORDER replace the defaults, in the order given', () => {
  const l = describeModelLineup({ GEMINI_API_KEY: 'g', IMAGE_PROVIDER_ORDER: 'gemini:gemini-3-pro-image, hf:Some/Space, pollinations', VIDEO_PROVIDER_ORDER: 'hf:zerogpu-aoti/wan2-2-fp8da-aoti-faster' });
  assert.deepEqual(l.image.map((e) => e.provider), ['gemini', 'hf', 'pollinations', 'placeholder']);
  assert.equal(l.image[0].info?.name, 'Nano Banana Pro (Gemini 3 Pro Image)');
  assert.deepEqual(l.video.map((e) => e.model), ['zerogpu-aoti/wan2-2-fp8da-aoti-faster']);
});

test('with no other provider key the lineup is Gemini alone and says so', () => {
  const l = describeModelLineup({ GEMINI_API_KEY: 'g' });
  assert.ok(l.text.length > 0 && l.text.every((e) => e.provider === 'gemini'));
  assert.match(l.textOrderSource, /Gemini only/);
});
