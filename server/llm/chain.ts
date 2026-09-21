import type { GoogleGenAI } from '@google/genai';
import { generateGeminiJson, generateGeminiText, TEXT_MODELS } from '../gemini';
import {
  classifyGeminiError,
  isQuotaKind,
  QuotaExhaustedError,
  summarizeQuotaFailures,
  UpstreamUnavailableError,
  type ClassifiedError,
} from '../quota';
import { providerOrder, resolveProviders, type ResolvedProvider } from './providers';
import { toJsonSchema, validateAgainstSchema } from './schema';

/**
 * Multi-provider text generation. Walks the configured providers best-first (DeepSeek -> Grok ->
 * free tiers -> Gemini) and returns the first usable answer. The error contract is the one the rest
 * of the server already relies on — QuotaExhaustedError / UpstreamUnavailableError / a plain Error —
 * so strict mode (429 / 503 / 502 + Retry-After) keeps working with N providers instead of one.
 */

type Env = Record<string, string | undefined>;

export interface LlmOptions {
  /** Injected by tests. */
  fetch?: typeof fetch;
  env?: Env;
  sleep?: (ms: number) => Promise<unknown>;
  now?: () => number;
  timeoutMs?: number;
  /**
   * The caller's prompt asks for a JSON ARRAY. OpenAI-style json_object mode can only return an
   * object, so non-Gemini providers are asked for {"items": [...]} and the array is unwrapped here.
   */
  rootArray?: boolean;
}

/** A provider answered with an HTTP error. Carries what the classifier needs; never the request. */
export class ProviderHttpError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number,
    readonly body: string,
    readonly retryAfterSec?: number
  ) {
    super(`${provider} HTTP ${status}: ${body.slice(0, 300)}`);
    this.name = 'ProviderHttpError';
  }
}

/** The provider answered but not with something usable (truncated, unparseable, wrong shape). */
export class InvalidOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidOutputError';
  }
}

// --------------------------------------------------------------------------
// Error classification
// --------------------------------------------------------------------------

const PER_DAY = /per day|daily|tokens per day|\bTPD\b|\bRPD\b|day limit/i;
const NO_BALANCE = /insufficient[_ ](balance|credits?|funds|quota)|out of credits|no credits|exceeded your current quota|billing|credits? (have been )?(exhausted|used)/i;
const RETRY_IN = /(?:try again|retry) in ((?:[\d.]+\s*(?:ms|h|m|s)\s*)+)/i;
const MAX_COOLDOWN_SEC = 1800;
const TRANSIENT_COOLDOWN_SEC = 30;

/** "7m12.5s", "45s", "1h2m", "250ms" -> whole seconds, rounded up. */
export function parseDurationSec(text: string): number | undefined {
  const m = text.match(RETRY_IN);
  if (!m) return undefined;
  let sec = 0;
  for (const [, n, unit] of m[1].matchAll(/([\d.]+)\s*(ms|h|m|s)/g)) {
    sec += Number(n) * (unit === 'h' ? 3600 : unit === 'm' ? 60 : unit === 'ms' ? 0.001 : 1);
  }
  return Number.isFinite(sec) && sec > 0 ? Math.ceil(sec) : undefined;
}

export function classifyProviderError(err: unknown): ClassifiedError {
  if (err instanceof QuotaExhaustedError) return { kind: err.kind, retryAfterSec: err.retryAfterSec };
  if (err instanceof UpstreamUnavailableError) return { kind: 'transient' };
  if (err instanceof InvalidOutputError) return { kind: 'other' };

  if (err instanceof ProviderHttpError) {
    const { status, body } = err;
    if (status === 402 || ((status === 403 || status === 429) && NO_BALANCE.test(body))) return { kind: 'zero', status };
    if (status === 429) {
      const retryAfterSec = err.retryAfterSec ?? parseDurationSec(body) ?? 60;
      if (PER_DAY.test(body) || retryAfterSec > 300) return { kind: 'per_day', retryAfterSec, status };
      return { kind: 'per_minute', retryAfterSec, status };
    }
    if (status >= 500 || status === 408) return { kind: 'transient', status };
    return { kind: 'other', status }; // 400 bad request, 401/403 bad key, 404 unknown model
  }

  // fetch() itself failed: DNS, connection reset, or our own timeout.
  const e: any = err;
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError' || e instanceof TypeError) return { kind: 'transient' };
  return classifyGeminiError(err);
}

// --------------------------------------------------------------------------
// Cooldowns — a provider known to be out is skipped instead of costing a failed call per request
// --------------------------------------------------------------------------

const cooldowns = new Map<string, { until: number; c: ClassifiedError }>();

export function resetLlmCooldowns(): void {
  cooldowns.clear();
}

const isAuthStatus = (s?: number) => s === 401 || s === 402 || s === 403;

/** Key/billing problems are provider-wide; quota is per model (Groq and Gemini both meter models separately). */
function cooldownKey(providerId: string, model: string, c: ClassifiedError): string {
  return isAuthStatus(c.status) || c.kind === 'zero' ? `${providerId}:*` : `${providerId}:${model}`;
}

function coolDown(providerId: string, model: string, c: ClassifiedError, nowMs: number): void {
  let sec: number | undefined;
  if (c.kind === 'zero' || isAuthStatus(c.status)) sec = MAX_COOLDOWN_SEC;
  else if (c.kind === 'per_day' || c.kind === 'per_minute') sec = Math.min(c.retryAfterSec ?? 60, MAX_COOLDOWN_SEC);
  else if (c.kind === 'transient') sec = TRANSIENT_COOLDOWN_SEC;
  if (sec) cooldowns.set(cooldownKey(providerId, model, c), { until: nowMs + sec * 1000, c });
}

/** The remembered failure if this model is still cooling down, else undefined. */
function activeCooldown(providerId: string, model: string, nowMs: number): ClassifiedError | undefined {
  for (const key of [`${providerId}:*`, `${providerId}:${model}`]) {
    const cd = cooldowns.get(key);
    if (cd && cd.until > nowMs) {
      return { ...cd.c, retryAfterSec: cd.c.kind === 'zero' ? undefined : Math.ceil((cd.until - nowMs) / 1000) };
    }
  }
  return undefined;
}

// --------------------------------------------------------------------------
// One OpenAI-compatible chat call
// --------------------------------------------------------------------------

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface ChatResult {
  text: string;
  finishReason?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

function retryAfterHeader(res: Response): number | undefined {
  const raw = res.headers.get('retry-after');
  const n = raw === null ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.ceil(n) : undefined;
}

/** `<think>` blocks (open reasoning models) and fenced code are noise around the JSON we asked for. */
function cleanModelText(raw: string): string {
  return raw
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```(?:json)?/gi, '')
    .trim();
}

function contentToString(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p: any) => (typeof p === 'string' ? p : p?.text ?? '')).join('');
  return '';
}

/** Per-request ceiling. Generous: a 9-minute script is a long completion, and a reasoning model thinks first. */
function requestTimeoutMs(opts: LlmOptions): number {
  const fromEnv = Number((opts.env ?? process.env).LLM_TIMEOUT_MS);
  return opts.timeoutMs ?? (Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 120_000);
}

export async function callChat(
  p: ResolvedProvider,
  model: string,
  messages: ChatMessage[],
  json: boolean,
  opts: LlmOptions = {}
): Promise<ChatResult> {
  const doFetch = opts.fetch ?? fetch;
  const res = await doFetch(`${p.spec.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${p.apiKey}`,
      'Content-Type': 'application/json',
      ...(p.spec.headers ?? {}),
    },
    body: JSON.stringify({
      model,
      messages,
      [p.spec.maxTokensParam]: p.maxTokens,
      ...(json ? { response_format: { type: 'json_object' } } : {}),
    }),
    signal: AbortSignal.timeout(requestTimeoutMs(opts)),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new ProviderHttpError(p.spec.id, res.status, body, retryAfterHeader(res));
  }
  const data: any = await res.json();
  const choice = data?.choices?.[0];
  return {
    text: cleanModelText(contentToString(choice?.message?.content)),
    finishReason: choice?.finish_reason,
    usage: data?.usage,
  };
}

/** GET /models — what `npm run llm:check` uses to catch model-id drift and bad keys. */
export async function listModelIds(p: ResolvedProvider, opts: LlmOptions = {}): Promise<string[]> {
  const doFetch = opts.fetch ?? fetch;
  const res = await doFetch(`${p.spec.baseUrl}/models`, {
    headers: { Authorization: `Bearer ${p.apiKey}`, ...(p.spec.headers ?? {}) },
    signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
  });
  if (!res.ok) throw new ProviderHttpError(p.spec.id, res.status, await res.text().catch(() => ''), retryAfterHeader(res));
  const data: any = await res.json();
  return (data?.data ?? []).map((m: any) => String(m?.id)).filter(Boolean);
}

// --------------------------------------------------------------------------
// JSON with a local schema check and one repair round
// --------------------------------------------------------------------------

function parseJson(text: string): { value?: any; problem?: string } {
  const attempts = [text];
  const first = text.search(/[{[]/);
  const last = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
  if (first > 0 && last > first) attempts.push(text.slice(first, last + 1)); // prose around the JSON
  let lastErr = '';
  for (const a of attempts) {
    try {
      return { value: JSON.parse(a) };
    } catch (e: any) {
      lastErr = e?.message ?? String(e);
    }
  }
  return { problem: `response was not valid JSON (${lastErr})` };
}

/** A non-empty array from {"items": [...]}, a bare array, or an object whose only value is an array. */
function unwrapArray(v: any): any[] | undefined {
  const arr = Array.isArray(v) ? v : v && typeof v === 'object' ? (Array.isArray(v.items) ? v.items : Object.values(v).length === 1 && Array.isArray(Object.values(v)[0]) ? (Object.values(v)[0] as any[]) : undefined) : undefined;
  return arr && arr.length > 0 ? arr : undefined;
}

async function jsonFromProvider<T>(
  p: ResolvedProvider,
  model: string,
  prompt: string,
  systemInstruction: string,
  responseSchema: unknown,
  opts: LlmOptions
): Promise<T> {
  const schema = responseSchema ? toJsonSchema(responseSchema) : undefined;
  const shape = opts.rootArray
    ? 'Respond with ONE JSON object of the form {"items": [ ... ]} and nothing else, no markdown fences, no commentary. The array the task describes goes in "items"; do not return a bare array.'
    : 'Respond with ONE JSON object and nothing else: no markdown fences, no commentary.';
  const system =
    `${systemInstruction}\n\n${shape}` +
    (schema ? ` It must conform to this JSON Schema (keys, types, enums and array sizes are enforced):\n${JSON.stringify(schema)}` : '');
  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: prompt },
  ];

  for (let attempt = 0; attempt < 2; attempt++) {
    const t0 = Date.now();
    const r = await callChat(p, model, messages, true, opts);
    console.log(
      `[LLM Chain] ${p.spec.id}/${model} finish=${r.finishReason} in=${r.usage?.prompt_tokens} out=${r.usage?.completion_tokens} ${((Date.now() - t0) / 1000).toFixed(1)}s`
    );
    if (r.finishReason === 'length') throw new InvalidOutputError(`${p.spec.id}/${model} hit the ${p.maxTokens}-token output cap`);
    if (!r.text) throw new InvalidOutputError(`${p.spec.id}/${model} returned empty content`);

    const parsed = parseJson(r.text);
    let problems: string[];
    let value: any = parsed.value;
    if (parsed.problem) problems = [parsed.problem];
    else if (opts.rootArray) {
      value = unwrapArray(parsed.value);
      problems = value ? [] : ['expected {"items": [ ... ]} holding a non-empty array'];
    } else if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length === 0) {
      problems = ['response was not a non-empty JSON object'];
    } else {
      problems = schema ? validateAgainstSchema(value, schema) : [];
    }
    if (problems.length === 0) return value as T;

    if (attempt === 0) {
      console.warn(`[LLM Chain] ${p.spec.id}/${model} answer rejected, asking for a repair: ${problems.slice(0, 3).join('; ')}`);
      messages.push(
        { role: 'assistant', content: r.text },
        { role: 'user', content: `That JSON was rejected:\n- ${problems.join('\n- ')}\nReturn the complete corrected JSON object only.` }
      );
      continue;
    }
    throw new InvalidOutputError(`${p.spec.id}/${model} still invalid after a repair round: ${problems.slice(0, 3).join('; ')}`);
  }
  throw new InvalidOutputError('unreachable');
}

// --------------------------------------------------------------------------
// The chain
// --------------------------------------------------------------------------

type Tier = { kind: 'gemini' } | { kind: 'provider'; provider: ResolvedProvider };

/** Configured tiers in order. If nothing is configured, Gemini alone — the historical behaviour, fallbacks and all. */
export function buildTiers(env: Env = process.env): Tier[] {
  const providers = new Map(resolveProviders(env).map((p) => [p.spec.id, p]));
  const tiers: Tier[] = [];
  for (const id of providerOrder(env)) {
    if (id === 'gemini') {
      if (env.GEMINI_API_KEY || providers.size === 0) tiers.push({ kind: 'gemini' });
    } else if (providers.has(id)) {
      tiers.push({ kind: 'provider', provider: providers.get(id)! });
    }
  }
  return tiers.length ? tiers : [{ kind: 'gemini' }];
}

/** One line for the server log: what will actually be tried, in order. */
export function describeChain(env: Env = process.env): string {
  return buildTiers(env)
    .map((t) => (t.kind === 'gemini' ? `gemini(${TEXT_MODELS.join(',')})` : `${t.provider.spec.id}(${t.provider.models.join(',')})`))
    .join(' -> ');
}

/** Mirrors reduceModelErrors: quota dominates and says when to retry; overload is retryable; else surface a real error. */
function reduceFailures(failures: ClassifiedError[], firstOther: unknown): unknown {
  const retryable = failures.filter((f) => f.kind !== 'other');
  if (retryable.length === 0) return firstOther ?? new Error('No LLM provider produced a result');
  if (retryable.every((f) => isQuotaKind(f.kind))) return summarizeQuotaFailures(retryable);
  const perMinute = retryable.filter((f) => f.kind === 'per_minute').map((f) => f.retryAfterSec ?? 60);
  return new UpstreamUnavailableError(Math.min(30, ...perMinute), 'Every LLM provider was overloaded or rate-limited; retry shortly.');
}

export async function generateJson<T>(
  ai: GoogleGenAI,
  prompt: string,
  systemInstruction: string,
  geminiModels: string[] = TEXT_MODELS,
  responseSchema?: unknown,
  opts: LlmOptions & { sleep?: (ms: number) => Promise<unknown>; now?: () => number } = {}
): Promise<T> {
  const now = opts.now ?? Date.now;
  const tiers = buildTiers(opts.env ?? process.env);
  // Only Gemini configured: byte-for-byte the pre-chain behaviour.
  if (tiers.length === 1 && tiers[0].kind === 'gemini') {
    return generateGeminiJson<T>(ai, prompt, systemInstruction, geminiModels, responseSchema, opts);
  }

  const failures: ClassifiedError[] = [];
  let firstOther: unknown;
  const record = (err: unknown, c: ClassifiedError) => {
    failures.push(c);
    if (c.kind === 'other' && !firstOther) firstOther = err;
  };

  for (const tier of tiers) {
    if (tier.kind === 'gemini') {
      try {
        return await generateGeminiJson<T>(ai, prompt, systemInstruction, geminiModels, responseSchema, opts);
      } catch (err) {
        console.warn('[LLM Chain] gemini tier failed:', (err as any)?.message || err);
        record(err, classifyProviderError(err));
        continue;
      }
    }
    const p = tier.provider;
    for (const model of p.models) {
      const cd = activeCooldown(p.spec.id, model, now());
      if (cd) {
        failures.push(cd);
        continue;
      }
      try {
        return await jsonFromProvider<T>(p, model, prompt, systemInstruction, responseSchema, opts);
      } catch (err) {
        const c = classifyProviderError(err);
        coolDown(p.spec.id, model, c, now());
        record(err, c);
        console.warn(`[LLM Chain] ${p.spec.id}/${model} -> ${c.kind}${c.status ? ` (HTTP ${c.status})` : ''}:`, (err as any)?.message || err);
      }
    }
  }
  throw reduceFailures(failures, firstOther);
}

// --------------------------------------------------------------------------
// Chat (free text, multi-turn)
// --------------------------------------------------------------------------

/** Gemini `contents` (role user|model, parts[].text) -> OpenAI messages. */
export function toChatMessages(contents: any[], systemInstruction: string): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: 'system', content: systemInstruction }];
  for (const c of contents) {
    const text = (c?.parts ?? []).map((p: any) => p?.text ?? '').join('');
    if (text) messages.push({ role: c.role === 'model' ? 'assistant' : 'user', content: text });
  }
  return messages;
}

export async function generateText(
  ai: GoogleGenAI,
  contents: any[],
  systemInstruction: string,
  geminiModels: string[] = TEXT_MODELS,
  opts: LlmOptions = {}
): Promise<{ text: string; via: string }> {
  const now = opts.now ?? Date.now;
  let lastErr: unknown;
  for (const tier of buildTiers(opts.env ?? process.env)) {
    if (tier.kind === 'gemini') {
      try {
        return { text: await generateGeminiText(ai, contents, systemInstruction, geminiModels), via: `gemini/${geminiModels[0]}` };
      } catch (err) {
        lastErr = err;
        continue;
      }
    }
    const p = tier.provider;
    for (const model of p.models) {
      if (activeCooldown(p.spec.id, model, now())) continue;
      try {
        const r = await callChat(p, model, toChatMessages(contents, systemInstruction), false, opts);
        if (r.text) return { text: r.text, via: `${p.spec.id}/${model}` };
        lastErr = new InvalidOutputError(`${p.spec.id}/${model} returned empty content`);
      } catch (err) {
        lastErr = err;
        coolDown(p.spec.id, model, classifyProviderError(err), now());
        console.warn(`[LLM Chain] chat ${p.spec.id}/${model} failed:`, (err as any)?.message || err);
      }
    }
  }
  throw lastErr || new Error('All chat providers exhausted');
}
