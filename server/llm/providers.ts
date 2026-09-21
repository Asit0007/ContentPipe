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
    defaultModels: ['openai/gpt-oss-120b', 'llama-3.3-70b-versatile'],
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
    defaultModels: ['openai/gpt-oss-120b:free', 'meta-llama/llama-3.3-70b-instruct:free'],
    maxTokensParam: 'max_tokens',
    maxTokens: 8000,
    headers: { 'X-Title': 'ContentPipe' },
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
export const DEFAULT_PROVIDER_ORDER = ['deepseek', 'xai', 'groq', 'cerebras', 'openrouter', 'mistral', 'gemini'];

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

/** OpenAI-compatible providers that have a key, in configured order. Gemini is handled by the chain itself. */
export function resolveProviders(env: Env = process.env): ResolvedProvider[] {
  const byId = new Map(OPENAI_COMPAT_PROVIDERS.map((p) => [p.id, p]));
  const resolved: ResolvedProvider[] = [];
  for (const id of providerOrder(env)) {
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
      models: override.length ? override : spec.defaultModels,
      maxTokens: Number.isInteger(cap) && cap > 0 ? cap : spec.maxTokens,
    });
  }
  return resolved;
}
