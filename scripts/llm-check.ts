/**
 * npm run llm:check — verifies the provider chain against the real APIs.
 *
 * For every provider that has a key: lists its live /models, flags any configured model id that is
 * not there (ids drift; the defaults in server/llm/providers.ts are best guesses), then sends one
 * tiny JSON request to the first model that exists so a bad key, no balance, or a rejected
 * parameter shows up here instead of mid-run. Costs a fraction of a cent. Gemini is probed too.
 */
import 'dotenv/config';
import { callChat, describeChain, listModelIds, classifyProviderError } from '../server/llm/chain';
import { providerOrder, resolveProviders, OPENAI_COMPAT_PROVIDERS } from '../server/llm/providers';

const ok = (s: string) => `\x1b[32m${s}\x1b[0m`;
const bad = (s: string) => `\x1b[31m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

async function main() {
  console.log(`chain: ${describeChain()}\n`);
  const resolved = resolveProviders();
  const have = new Set(resolved.map((p) => p.spec.id));
  let failures = 0;

  for (const spec of OPENAI_COMPAT_PROVIDERS) {
    if (!have.has(spec.id) && providerOrder().includes(spec.id)) {
      console.log(`${dim('-')} ${spec.label.padEnd(18)} ${dim(`no key (${spec.keyEnv.join(' / ')})`)}`);
    }
  }

  for (const p of resolved) {
    process.stdout.write(`\n${p.spec.label} ${dim(p.spec.baseUrl)}\n`);
    let live: string[] | undefined;
    try {
      live = await listModelIds(p);
      console.log(`  ${ok('key ok')}, ${live.length} models listed`);
    } catch (e) {
      const c = classifyProviderError(e);
      console.log(`  ${bad('models list failed')} [${c.kind}] ${(e as Error).message}`);
      failures++;
      continue;
    }
    const usable: string[] = [];
    for (const m of p.models) {
      if (live.includes(m)) usable.push(m);
      else console.log(`  ${bad('missing')} ${m} ${dim('— set ' + p.spec.modelsEnv + ' to one of the live ids')}`);
    }
    if (usable.length === 0) {
      const hint = live.filter((m) => !/embed|whisper|tts|guard|moderation|image/i.test(m)).slice(0, 12);
      console.log(`  ${dim('some live text-model ids: ' + hint.join(', '))}`);
      failures++;
      continue;
    }
    try {
      const t0 = Date.now();
      const r = await callChat(
        { ...p, maxTokens: Math.min(p.maxTokens, 200) },
        usable[0],
        [
          { role: 'system', content: 'Reply with one JSON object only.' },
          { role: 'user', content: 'Return {"ok": true, "word": "ping"}' },
        ],
        true
      );
      const parsed = JSON.parse(r.text || '{}');
      console.log(`  ${parsed.ok ? ok('json call ok') : bad('unexpected reply')} ${usable[0]} ${dim(`${Date.now() - t0}ms finish=${r.finishReason}`)}`);
      if (!parsed.ok) failures++;
    } catch (e) {
      const c = classifyProviderError(e);
      console.log(`  ${bad('json call failed')} [${c.kind}] ${(e as Error).message}`);
      failures++;
    }
  }

  if (process.env.GEMINI_API_KEY) {
    const { GoogleGenAI } = await import('@google/genai');
    const { TEXT_MODELS } = await import('../server/gemini');
    const { modelOrder } = await import('../server/llm/providers');
    // With LLM_MODEL_ORDER the Gemini models are the ones it names, in its order; otherwise the built-in list.
    const ranked = modelOrder().filter((e) => e.provider === 'gemini').map((e) => e.model);
    const geminiModels = ranked.length ? ranked : TEXT_MODELS;
    console.log(`\nGemini ${dim(geminiModels.join(', '))}`);
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      await ai.models.generateContent({ model: geminiModels[0], contents: 'Return {"ok":true}', config: { responseMimeType: 'application/json' } });
      console.log(`  ${ok('json call ok')} ${geminiModels[0]}`);
    } catch (e: any) {
      console.log(`  ${bad('failed')} ${String(e?.message ?? e).slice(0, 200)}`);
      failures++;
    }
  }

  const probed = resolved.length + (process.env.GEMINI_API_KEY ? 1 : 0);
  if (probed === 0) console.log(`\n${bad('nothing to check')} — no provider has an API key. Add keys to .env (see .env.example).`);
  else console.log(failures ? `\n${bad(`${failures} problem(s)`)} — fix these before relying on the chain.` : `\n${ok(`all ${probed} configured provider(s) respond`)}`);
  if (probed === 0) process.exit(1);
  process.exit(failures ? 1 : 0);
}

main();
