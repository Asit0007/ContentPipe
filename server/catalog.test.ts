import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadCatalog, parseCatalog } from './llm/catalog';
import { OPENAI_COMPAT_PROVIDERS, providerOrder, providerSpecs, resolveProviders } from './llm/providers';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-catalog-'));
let n = 0;
function catalogFile(providers: unknown[]): string {
  const file = path.join(tmp, `providers-${n++}.json`);
  fs.writeFileSync(file, JSON.stringify({ version: 1, providers }));
  return file;
}
const entry = (over: Record<string, unknown>) => ({
  id: 'x', label: 'X', baseUrl: 'https://x.example/v1', keyEnv: ['X_API_KEY'], maxTokensParam: 'max_tokens', maxTokens: 7000,
  defaultModels: ['m1'], cost: 'free', trainsOnPrompts: false, policy: 'no training (test)', ...over,
});

test('without LLM_CATALOG the built-in provider list is used unchanged', () => {
  assert.equal(providerSpecs({}), OPENAI_COMPAT_PROVIDERS);
  assert.equal(providerSpecs({ LLM_CATALOG: '  ' }), OPENAI_COMPAT_PROVIDERS);
});

test('a catalog entry replaces the built-in one with the same id and adds new providers after the built-ins', () => {
  const file = catalogFile([
    entry({ id: 'groq', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', keyEnv: ['GROQ_API_KEY'], defaultModels: ['new-groq-model'] }),
    entry({ id: 'sambanova', label: 'SambaNova', baseUrl: 'https://api.sambanova.ai/v1', keyEnv: ['SAMBANOVA_API_KEY'], defaultModels: ['DeepSeek-V3.2', 'gpt-oss-120b'] }),
  ]);
  const specs = providerSpecs({ LLM_CATALOG: file });
  assert.deepEqual(specs.map((s) => s.id), [...OPENAI_COMPAT_PROVIDERS.map((s) => s.id), 'sambanova']);
  assert.deepEqual(specs.find((s) => s.id === 'groq')!.defaultModels, ['new-groq-model']);
  const samba = specs.find((s) => s.id === 'sambanova')!;
  assert.equal(samba.modelsEnv, 'SAMBANOVA_MODELS', 'derived from the id, like every built-in');
  assert.equal(samba.maxTokens, 7000);

  assert.deepEqual(resolveProviders({ LLM_CATALOG: file, SAMBANOVA_API_KEY: 's' }).map((p) => [p.spec.id, p.models]), [['sambanova', ['DeepSeek-V3.2', 'gpt-oss-120b']]]);
  const ranked = resolveProviders({ LLM_CATALOG: file, SAMBANOVA_API_KEY: 's', GROQ_API_KEY: 'q', LLM_MODEL_ORDER: 'sambanova:DeepSeek-V3.1,groq:qwen/qwen3.8-27b' });
  assert.deepEqual(ranked.map((p) => [p.spec.id, p.models]), [['sambanova', ['DeepSeek-V3.1']], ['groq', ['qwen/qwen3.8-27b']]]);
  assert.deepEqual(resolveProviders({ SAMBANOVA_API_KEY: 's' }), [], 'without the catalog SambaNova is an unknown id');
});

test('OmniRoute: local http allowed, no default models, so only an LLM_MODEL_ORDER entry ever reaches it', () => {
  const file = catalogFile([entry({ id: 'omniroute', baseUrl: 'http://127.0.0.1:20128/v1', keyEnv: ['OMNIROUTE_API_KEY'], defaultModels: [], trainsOnPrompts: 'depends', policy: 'depends' })]);
  assert.ok(!providerOrder({}).includes('omniroute'), 'not in the default provider order');
  const ranked = resolveProviders({ LLM_CATALOG: file, OMNIROUTE_API_KEY: 'k', LLM_MODEL_ORDER: 'omniroute:zai/glm-4.7-flash' });
  assert.deepEqual(ranked.map((p) => [p.spec.id, p.spec.baseUrl, p.models]), [['omniroute', 'http://127.0.0.1:20128/v1', ['zai/glm-4.7-flash']]]);
  assert.deepEqual(resolveProviders({ LLM_CATALOG: file, LLM_MODEL_ORDER: 'omniroute:zai/glm-4.7-flash' }), [], 'no key, never called (OmniRoute answers keyless by default)');
});

test('a configured catalog that is missing or invalid throws, naming the problem, instead of falling back quietly', () => {
  assert.throws(() => loadCatalog(path.join(tmp, 'nope.json')), /LLM_CATALOG .*nope\.json/);
  const bad: [unknown, RegExp][] = [
    [{ version: 2, providers: [entry({})] }, /"version": 1/],
    [{ version: 1, providers: [] }, /non-empty/],
    [{ version: 1, providers: [entry({ id: 'gemini' })] }, /bad id/],
    [{ version: 1, providers: [entry({}), entry({})] }, /duplicate id x/],
    [{ version: 1, providers: [entry({ baseUrl: 'http://evil.example/v1' })] }, /baseUrl/],
    [{ version: 1, providers: [entry({ baseUrl: 'https://x.example/v1/' })] }, /trailing slash/],
    [{ version: 1, providers: [entry({ keyEnv: [] })] }, /keyEnv/],
    [{ version: 1, providers: [entry({ maxTokensParam: 'tokens' })] }, /maxTokensParam/],
    [{ version: 1, providers: [entry({ maxTokens: 0 })] }, /maxTokens/],
    [{ version: 1, providers: [entry({ defaultModels: [''] })] }, /defaultModels/],
  ];
  for (const [doc, re] of bad) assert.throws(() => parseCatalog(doc), re);
});

test('the real shared catalog next to this repo parses, when it is there', (t) => {
  const real = path.resolve(here, '../../../LLM-Catalog/providers.json');
  if (!fs.existsSync(real)) return t.skip('LLM-Catalog not checked out beside ContentPipe');
  const ids = parseCatalog(JSON.parse(fs.readFileSync(real, 'utf8')), real).map((p) => p.id);
  for (const id of OPENAI_COMPAT_PROVIDERS.map((p) => p.id)) assert.ok(ids.includes(id), `catalog lacks built-in provider ${id}`);
});

test('env loading: shell beats .env beats the shared keys file, and LLM_SHARED_ENV=off skips it', () => {
  const dir = fs.mkdtempSync(path.join(tmp, 'env-'));
  fs.writeFileSync(path.join(dir, '.env'), 'A_KEY=project\nB_KEY=project\n');
  const shared = path.join(dir, 'llm.env');
  fs.writeFileSync(shared, 'A_KEY=shared\nB_KEY=shared\nC_KEY=shared\n');
  const envModule = path.resolve(here, 'env.ts');
  const run = (extra: Record<string, string>) => JSON.parse(execFileSync(process.execPath, [
    '--import', import.meta.resolve('tsx'), '--input-type=module', '-e',
    `await import(${JSON.stringify(envModule)}); console.log(JSON.stringify({ a: process.env.A_KEY, b: process.env.B_KEY, c: process.env.C_KEY ?? null }))`,
  ], { cwd: dir, env: { PATH: process.env.PATH ?? '', HOME: dir, B_KEY: 'shell', ...extra }, encoding: 'utf8' }).trim().split('\n').pop()!);
  assert.deepEqual(run({ LLM_SHARED_ENV: shared }), { a: 'project', b: 'shell', c: 'shared' });
  assert.deepEqual(run({ LLM_SHARED_ENV: 'off' }), { a: 'project', b: 'shell', c: null });
  fs.mkdirSync(path.join(dir, '.config', 'asitminz'), { recursive: true });
  fs.copyFileSync(shared, path.join(dir, '.config', 'asitminz', 'llm.env'));
  assert.deepEqual(run({}), { a: 'project', b: 'shell', c: 'shared' }, 'default path is ~/.config/asitminz/llm.env');
});
