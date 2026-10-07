/**
 * The shared provider catalog (`LLM_CATALOG`, a providers.json from the LLM-Catalog repo next to this one).
 *
 * ContentPipe and JobPipe read the same file, so a provider is added once, with its training policy and the date it
 * was checked, instead of in two languages. Each project keeps its own chain code and its own ranking: the catalog
 * says what exists, LLM_MODEL_ORDER says what ContentPipe tries. When LLM_CATALOG is unset the built-in list in
 * providers.ts is used unchanged (CI, tests, a fresh clone).
 *
 * A configured catalog that cannot be read or fails validation throws: a wrong path is a config error to see, not a
 * reason to fall back quietly to an older provider list.
 */
import fs from 'fs';
import type { ProviderSpec } from './providers';

const ID = /^[a-z][a-z0-9]*$/;
const ENV = /^[A-Z][A-Z0-9_]*$/;
const LOCAL = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/;

const cache = new Map<string, ProviderSpec[]>();

/** Provider specs from a catalog file, validated. Cached per path for the life of the process, like .env. */
export function loadCatalog(file: string): ProviderSpec[] {
  const hit = cache.get(file);
  if (hit) return hit;
  let doc: unknown;
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`LLM_CATALOG ${file}: ${(e as Error).message}`);
  }
  const specs = parseCatalog(doc, file);
  cache.set(file, specs);
  return specs;
}

export function parseCatalog(doc: unknown, where = 'catalog'): ProviderSpec[] {
  const fail = (msg: string): never => {
    throw new Error(`LLM_CATALOG ${where}: ${msg}`);
  };
  const d = doc as { version?: unknown; providers?: unknown };
  if (!d || typeof d !== 'object' || d.version !== 1) fail('top level must be an object with "version": 1');
  if (!Array.isArray(d.providers) || !d.providers.length) fail('"providers" must be a non-empty list');
  const seen = new Set<string>();
  return (d.providers as Record<string, unknown>[]).map((p, i) => {
    const at = `providers[${i}]`;
    const id = p?.id;
    if (typeof id !== 'string' || !ID.test(id) || id === 'gemini') fail(`${at}: bad id ${JSON.stringify(id)}`);
    if (seen.has(id as string)) fail(`${at}: duplicate id ${id}`);
    seen.add(id as string);
    const baseUrl = p.baseUrl;
    if (typeof baseUrl !== 'string' || !(baseUrl.startsWith('https://') || LOCAL.test(baseUrl)) || baseUrl.endsWith('/')) {
      fail(`${at} (${id}): baseUrl must be https:// (http only for 127.0.0.1/localhost), no trailing slash`);
    }
    const keyEnv = p.keyEnv;
    if (!Array.isArray(keyEnv) || !keyEnv.length || !keyEnv.every((k) => typeof k === 'string' && ENV.test(k))) {
      fail(`${at} (${id}): keyEnv must be a non-empty list of env var names`);
    }
    if (p.maxTokensParam !== 'max_tokens' && p.maxTokensParam !== 'max_completion_tokens') fail(`${at} (${id}): bad maxTokensParam`);
    if (!Number.isInteger(p.maxTokens) || (p.maxTokens as number) <= 0) fail(`${at} (${id}): maxTokens must be a positive integer`);
    const models = p.defaultModels;
    if (!Array.isArray(models) || !models.every((m) => typeof m === 'string' && m.trim())) fail(`${at} (${id}): defaultModels must be a list of ids`);
    const headers = p.headers ?? {};
    if (typeof headers !== 'object' || Array.isArray(headers) || !Object.values(headers).every((v) => typeof v === 'string')) {
      fail(`${at} (${id}): headers must map strings to strings`);
    }
    return {
      id: id as string,
      label: typeof p.label === 'string' && p.label.trim() ? p.label : (id as string),
      baseUrl: baseUrl as string,
      keyEnv: keyEnv as string[],
      modelsEnv: `${(id as string).toUpperCase()}_MODELS`,
      defaultModels: models as string[],
      ...(Object.keys(headers as object).length ? { headers: headers as Record<string, string> } : {}),
      maxTokensParam: p.maxTokensParam as ProviderSpec['maxTokensParam'],
      maxTokens: p.maxTokens as number,
    };
  });
}
