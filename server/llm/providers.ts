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
 * behind the providers that do not train on them. Requesty's strong free models train on prompts too (its
 * "Training Permitted Models"), so it sits beside Mistral.
 *
 * The shared catalog (`LLM_CATALOG`, see catalog.ts) is the source of truth when it is set: its entries replace the
 * built-in ones with the same id and add new providers (SambaNova, Z.AI and a local OmniRoute since 2026-10-07). The
 * list below is the fallback for a machine without the catalog and is not extended with new providers.
 */
import { loadCatalog } from './catalog';

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
    // Live model list checked 2026-09-27 with the owner's key: it names only these two (llama-3.3-70b is gone, as on
    // Groq). NOTE: with that key both answered HTTP 402 "Payment required" on 2026-09-27, so Cerebras is not usable
    // until its billing tab is sorted. qwen-3.8-27b is the same model Groq serves, on separate rate limits.
    defaultModels: ['qwen-3.8-27b', 'gpt-oss-120b'],
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
    id: 'huggingface',
    label: 'Hugging Face (routed)',
    baseUrl: 'https://router.huggingface.co/v1',
    // Its own token, not HF_TOKEN: HF_TOKEN is the read-only token that goes to trusted Spaces (`tokenAllowedFor`),
    // and routed calls need a token with the "Make calls to Inference Providers" permission. Least privilege.
    keyEnv: ['HF_INFERENCE_TOKEN'],
    modelsEnv: 'HUGGINGFACE_MODELS',
    // HF bills routed calls at the provider's price with no markup; a free account gets $0.10 of credit a month
    // (huggingface.co/docs/inference-providers/pricing, 2026-09-27) and answers 402 after that unless credits are
    // bought, which the chain treats as "no balance" and skips. `:cheapest` lets HF pick the cheapest live provider
    // (DeepInfra listed DeepSeek-V4-Flash at $0.09/$0.18 per million tokens on 2026-09-27) to stretch the credit.
    // Unverified on our schemas: JSON-mode support varies by provider. Run `npm run llm:check` once the token exists.
    defaultModels: ['deepseek-ai/DeepSeek-V4-Flash:cheapest'],
    maxTokensParam: 'max_tokens',
    maxTokens: 8000,
  },
  {
    id: 'requesty',
    label: 'Requesty',
    baseUrl: 'https://router.requesty.ai/v1',
    keyEnv: ['REQUESTY_API_KEY'],
    modelsEnv: 'REQUESTY_MODELS',
    // A router, not a model host: its free plan is 200 requests/day across 12 free models (terms §4.6, updated
    // 2026-08-14; public model list at router.requesty.ai/v1/models, read 2026-09-27). What it adds here is a second
    // free pool for models Ollama Cloud and OpenRouter already serve, both of which are capped (monthly credits; 50/day).
    // TRAINING: the strong free models (Nemotron 3 Ultra and Super) are "Training Permitted Models" — on the free plan
    // the model provider keeps prompts and outputs to train on, and Requesty may use them to train its routing (§5.9,
    // §6.2(a); the API's `data_used_for_training` flag says which). Fine for public-news scripts, never for résumé data,
    // and ordered behind the providers that do not train, like Mistral. Gemma 4 31B does not train. Most free models do
    // not advertise JSON mode; the chain retries once without response_format when a model rejects it (chain.ts).
    defaultModels: ['nvidia/nemotron-3-ultra-550b-a55b', 'nvidia/nemotron-3-super-120b-a12b', 'google/gemma-4-31b-it'],
    maxTokensParam: 'max_tokens',
    maxTokens: 8000,
  },
  {
    id: 'mistral',
    label: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    keyEnv: ['MISTRAL_API_KEY'],
    modelsEnv: 'MISTRAL_MODELS',
    // A free key (checked 2026-09-27) does not list mistral-large-latest, and answers Small, Medium and Magistral with
    // a 0 requests/min limit; Ministral 14B (30/min) and 8B (188/min) answer, JSON mode included.
    defaultModels: ['ministral-14b-latest', 'ministral-8b-latest'],
    maxTokensParam: 'max_tokens',
    maxTokens: 16000,
  },
];

/**
 * Default order: strongest first, no-training free tiers before the training one, Gemini last. `sambanova` and `zai`
 * exist only in the catalog; without it they are unknown ids and skipped. OmniRoute is deliberately absent: it is
 * tried only where LLM_MODEL_ORDER names an `omniroute:` model.
 */
export const DEFAULT_PROVIDER_ORDER = ['deepseek', 'xai', 'groq', 'cerebras', 'sambanova', 'zai', 'openrouter', 'ollama', 'huggingface', 'requesty', 'mistral', 'gemini'];

/** Every OpenAI-compatible provider ContentPipe knows: the built-in list, overlaid by the catalog when LLM_CATALOG is set. */
export function providerSpecs(env: Env = process.env): ProviderSpec[] {
  const file = env.LLM_CATALOG?.trim();
  if (!file) return OPENAI_COMPAT_PROVIDERS;
  const fromCatalog = new Map(loadCatalog(file).map((p) => [p.id, p]));
  const merged = OPENAI_COMPAT_PROVIDERS.map((p) => fromCatalog.get(p.id) ?? p);
  for (const p of fromCatalog.values()) if (!OPENAI_COMPAT_PROVIDERS.some((b) => b.id === p.id)) merged.push(p);
  return merged;
}

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
 *   gemini:gemini-3.7-flash,groq:qwen/qwen3.8-27b,ollama:nemotron-3-ultra,gemini:gemini-3.6-flash
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

/**
 * LLM_RESERVED_FOR: models only some requests may use, e.g. `gemini:gemini-3.8-flash=script` keeps the smartest Gemini
 * model's ~20 free requests a day for /api/script instead of letting research, plan or chat spend them first.
 * Entries are `provider:model=purpose` with purposes separated by `|` (`=script|plan`), comma-separated. The model part
 * runs to the LAST `=`. A purpose is the /api route's name (server.ts middleware); calls outside a request have none,
 * so they never use a reserved model. Unset: nothing is reserved.
 */
export function reservedModels(env: Env = process.env): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const raw of csv(env.LLM_RESERVED_FOR)) {
    const eq = raw.lastIndexOf('=');
    const colon = raw.indexOf(':');
    if (eq <= 0 || colon <= 0 || colon > eq) continue;
    const key = `${raw.slice(0, colon).trim().toLowerCase()}:${raw.slice(colon + 1, eq).trim()}`;
    const purposes = raw.slice(eq + 1).split('|').map((s) => s.trim().toLowerCase()).filter(Boolean);
    if (purposes.length) out.set(key, new Set(purposes));
  }
  return out;
}

/** Whether a request with this purpose may call this model. Unreserved models: always. */
export function modelAllowedFor(provider: string, model: string, purpose: string | undefined, env: Env = process.env): boolean {
  const allowed = reservedModels(env).get(`${provider}:${model}`);
  return !allowed || (purpose !== undefined && allowed.has(purpose.toLowerCase()));
}

/** OpenAI-compatible providers that have a key, in configured order. Gemini is handled by the chain itself. */
export function resolveProviders(env: Env = process.env): ResolvedProvider[] {
  const byId = new Map(providerSpecs(env).map((p) => [p.id, p]));
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
