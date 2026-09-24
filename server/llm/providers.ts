/**
 * The provider chain: which LLMs ContentPipe tries, in what order.
 *
 * Every provider except Gemini speaks the OpenAI chat-completions dialect, so one client covers them
 * all (chain.ts). Gemini keeps its own SDK path and is deliberately LAST: it has the tightest free
 * quota (~20 requests/day/model) but is the only tier with schema-constrained decoding, so it is the
 * safety net rather than the workhorse.
 *
 * A provider is only in the chain if its API key is set. Model ids drift, so every list is
 * overridable from the environment and `npm run llm:check` verifies them against each provider's
 * live /models endpoint — trust that over the defaults below.
 *
 * Cost vs free: DeepSeek and Grok (xAI) are pay-per-token. Groq, Cerebras, OpenRouter (:free models)
 * and Mistral (Experiment tier) have permanent free tiers with rate limits. Mistral's free tier
 * requires opting into training on your prompts — fine for public-news scripts, which is why it sits
 * behind the providers that do not train on them.
 */

export interface ProviderSpec {
  id: string;
  label: string;
  baseUrl: string;
  /** Env var names checked in order for the API key. */
  keyEnv: string[];
  /** Env var holding a comma-separated model list; falls back to `defaultModels`. */
  modelsEnv: string;
  /** Best-first. Each is tried in turn within the provider before moving to the next provider. */
  defaultModels: string[];
  /** Extra request headers (OpenRouter attribution etc.). */
  headers?: Record<string, string>;
  /** The output-cap parameter this provider accepts: OpenAI moved to max_completion_tokens, others kept max_tokens. */
  maxTokensParam: 'max_tokens' | 'max_completion_tokens';
  /** Output cap sent with every request. Overridable via <ID>_MAX_TOKENS. Long enough for a 9-minute script. */
  maxTokens: number;
}

export const OPENAI_COMPAT_PROVIDERS: ProviderSpec[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    keyEnv: ['DEEPSEEK_API_KEY'],
    modelsEnv: 'DEEPSEEK_MODELS',
    defaultModels: ['deepseek-v4-pro', 'deepseek-flash'],
    maxTokensParam: 'max_tokens',
    maxTokens: 16000,
  },
  {
    id: 'xai',
    label: 'Grok (xAI)',
    baseUrl: 'https://api.x.ai/v1',
    keyEnv: ['XAI_API_KEY', 'GROK_API_KEY'],
    modelsEnv: 'XAI_MODELS',
    defaultModels: ['grok-4.6', 'grok-4.3'],
    maxTokensParam: 'max_completion_tokens',
    maxTokens: 16000,
  },
  {
    id: 'groq',
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    keyEnv: ['GROQ_API_KEY'],
    modelsEnv: 'GROQ_MODELS',
    // llama-3.3-70b-versatile is gone from Groq's live list (checked 2026-09-24); qwen3.8-27b replaced it.
    defaultModels: ['qwen/qwen3.8-27b', 'openai/gpt-oss-120b'],
    maxTokensParam: 'max_completion_tokens',
    maxTokens: 16000,
  },
  {
    id: 'cerebras',
    label: 'Cerebras',
    baseUrl: 'https://api.cerebras.ai/v1',
    keyEnv: ['CEREBRAS_API_KEY'],
    modelsEnv: 'CEREBRAS_MODELS',
    defaultModels: ['gpt-oss-120b', 'llama-3.3-70b'],
    maxTokensParam: 'max_completion_tokens',
    maxTokens: 8000,
  },
  {
    id: 'openrouter',
    label: 'OpenRouter (free)',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyEnv: ['OPENROUTER_API_KEY'],
    modelsEnv: 'OPENROUTER_MODELS',
    // The two original `:free` ids no longer exist (OpenRouter answers 404 "unavailable for free"). Free endpoints
    // are often rate-limited or overloaded upstream, so this is a fallback tier, not a workhorse. Left out on
    // purpose: inkling:free and inkling-small:free (both 403 "only available on agentic harnesses" — not callable
    // as a plain completion, only through OpenRouter's own agent-harness integrations) and ling-3.0-flash-fin:free
    // (no JSON mode).
    //
    // Added 2026-09-24 after live-testing (JSON mode, 3 attempts each, this repo's usual request shape):
    // nemotron-3-ultra-550b-a55b (550B total / 1M context) answered clean JSON 2/3 — the third attempt only hit
    // a deliberately tiny test max_tokens, not a real failure — so it now leads the list. nemotron-3-super-120b-a12b
    // (120B total) answered 1/3, the other two "Upstream error from Nvidia: Service temporarily overloaded"; kept
    // as a later rung anyway, since a miss here costs nothing and just moves on to the next model in this same list.
    defaultModels: [
      'nvidia/nemotron-3-ultra-550b-a55b:free',
      'nvidia/nemotron-3-super-120b-a12b:free',
      'z-ai/glm-5.2:free',
      'qwen/qwen3.8-27b:free',
      'nvidia/nemotron-3.5-lightning:free',
    ],
    maxTokensParam: 'max_tokens',
    maxTokens: 8000,
    headers: { 'X-Title': 'ContentPipe' },
  },
  {
    id: 'ollama',
    label: 'Ollama Cloud',
    baseUrl: 'https://ollama.com/v1',
    // OLAMA_API_KEY is accepted because that is how the key was first named in .env; OLLAMA_API_KEY is the right spelling.
    keyEnv: ['OLLAMA_API_KEY', 'OLAMA_API_KEY'],
    modelsEnv: 'OLLAMA_MODELS',
    // Only what the free usage covers (probed 2026-09-24): every DeepSeek, Kimi, GLM 5.x, Qwen 397B, MiniMax and
    // Mistral Large 3 model answers 402 "add usage credits". Add those to OLLAMA_MODELS once credits are bought.
    defaultModels: ['nemotron-3-ultra', 'gemma4:31b', 'nemotron-3-super', 'gpt-oss:120b'],
    maxTokensParam: 'max_tokens',
    maxTokens: 8000,
  },
  {
    id: 'mistral',
    label: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    keyEnv: ['MISTRAL_API_KEY'],
    modelsEnv: 'MISTRAL_MODELS',
    defaultModels: ['mistral-large-latest', 'mistral-small-latest'],
    maxTokensParam: 'max_tokens',
    maxTokens: 16000,
  },
];

/** Default order: strongest first, no-training free tiers before the training one, Gemini last. */
export const DEFAULT_PROVIDER_ORDER = ['deepseek', 'xai', 'groq', 'cerebras', 'openrouter', 'ollama', 'mistral', 'gemini'];

export interface ResolvedProvider {
  spec: ProviderSpec;
  apiKey: string;
  models: string[];
  maxTokens: number;
}

type Env = Record<string, string | undefined>;

function csv(v: string | undefined): string[] {
  return (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

/** Requested order from LLM_PROVIDER_ORDER; unknown ids are ignored, `gemini` is appended if omitted. */
export function providerOrder(env: Env = process.env): string[] {
  const requested = csv(env.LLM_PROVIDER_ORDER);
  const order = requested.length ? requested : DEFAULT_PROVIDER_ORDER;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of order) {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

export interface ModelOrderEntry {
  provider: string;
  model: string;
}

/**
 * LLM_MODEL_ORDER: one model-by-model ranking across providers, best first, for when the smartest models live on
 * different providers and a provider-level order would try a weak model on one before a strong model on another:
 *
 *   gemini:gemini-3.7-flash,groq:qwen/qwen3.8-27b,openrouter:z-ai/glm-5.2:free,gemini:gemini-3.6-flash
 *
 * Each entry is a provider id, then everything after the FIRST colon as the model id (ids contain slashes and
 * colons). When set it replaces LLM_PROVIDER_ORDER and the per-provider model lists: only what is named here is
 * tried. Unset or empty means the provider-level behaviour is unchanged. Malformed entries and repeats are dropped.
 */
export function modelOrder(env: Env = process.env): ModelOrderEntry[] {
  const seen = new Set<string>();
  const out: ModelOrderEntry[] = [];
  for (const raw of csv(env.LLM_MODEL_ORDER)) {
    const i = raw.indexOf(':');
    if (i <= 0 || i === raw.length - 1) continue;
    const provider = raw.slice(0, i).trim().toLowerCase();
    const model = raw.slice(i + 1).trim();
    if (!provider || !model || seen.has(`${provider}:${model}`)) continue;
    seen.add(`${provider}:${model}`);
    out.push({ provider, model });
  }
  return out;
}

/** OpenAI-compatible providers that have a key, in configured order. Gemini is handled by the chain itself. */
export function resolveProviders(env: Env = process.env): ResolvedProvider[] {
  const byId = new Map(OPENAI_COMPAT_PROVIDERS.map((p) => [p.id, p]));
  const resolved: ResolvedProvider[] = [];
  const ranked = modelOrder(env);
  // With an explicit model order, the providers (and their models) are exactly those it names, in order of first mention.
  const ids = ranked.length ? [...new Set(ranked.map((e) => e.provider))] : providerOrder(env);
  for (const id of ids) {
    const spec = byId.get(id);
    if (!spec) continue;
    const apiKey = spec.keyEnv.map((k) => env[k]?.trim()).find(Boolean);
    if (!apiKey) continue;
    const override = csv(env[spec.modelsEnv]);
    const cap = Number(env[`${id.toUpperCase()}_MAX_TOKENS`]);
    const baseUrl = env[`${id.toUpperCase()}_BASE_URL`]?.trim().replace(/\/+$/, '');
    resolved.push({
      spec: baseUrl ? { ...spec, baseUrl } : spec,
      apiKey,
      models: ranked.length ? ranked.filter((e) => e.provider === id).map((e) => e.model) : override.length ? override : spec.defaultModels,
      maxTokens: Number.isInteger(cap) && cap > 0 ? cap : spec.maxTokens,
    });
  }
  return resolved;
}
