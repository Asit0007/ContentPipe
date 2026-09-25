/**
 * What the UI says about each model beyond its id: who makes it, how it ranks, what it costs here, and what live
 * runs showed. Shared by the server (/api/models attaches it) and the UI (the provenance rows look it up).
 *
 * Every line is dated evidence, not a spec. Scores are the Artificial Analysis Intelligence Index as checked on
 * 2026-09-24 for free models (the same numbers that ranked LLM_MODEL_ORDER in .env); they are for specific reasoning
 * settings, not measured in this pipeline, and two are single-source. Re-rank when models change. A model missing
 * here still shows, just without details.
 */

export interface ModelInfo {
  name: string;
  maker: string;
  /** Artificial Analysis Intelligence Index, 2026-09-24. */
  intelligence?: number;
  notes?: string;
}

export interface ProviderInfo {
  label: string;
  cost: string;
}

export const INTELLIGENCE_SOURCE = 'Artificial Analysis Intelligence Index, checked 2026-09-24';

export const PROVIDER_INFO: Record<string, ProviderInfo> = {
  gemini: { label: 'Google Gemini API', cost: 'Free tier on this key (~20 text requests/day per model)' },
  deepseek: { label: 'DeepSeek', cost: 'Paid per token (API hosted in China)' },
  xai: { label: 'Grok (xAI)', cost: 'Paid per token' },
  groq: { label: 'Groq', cost: 'Free tier: 8,000 tokens/min' },
  cerebras: { label: 'Cerebras', cost: 'Free tier' },
  openrouter: { label: 'OpenRouter', cost: 'Free (":free" models, often rate-limited)' },
  ollama: { label: 'Ollama Cloud', cost: 'Free usage covers only a few models' },
  mistral: { label: 'Mistral', cost: 'Free tier (trains on prompts)' },
  pollinations: { label: 'Pollinations', cost: 'Free, no API key' },
  placeholder: { label: 'Built-in placeholder', cost: 'Free, no model' },
};

export const MODEL_INFO: Record<string, ModelInfo> = {
  // Text: the ranked chain in .env
  'gemini-3.7-flash': { name: 'Gemini 3.7 Flash', maker: 'Google', intelligence: 39, notes: 'Smartest free model in the chain; often answers 503 "high demand" on large requests.' },
  'gemini-3.6-flash': { name: 'Gemini 3.6 Flash', maker: 'Google', intelligence: 34 },
  'gemini-3.1-flash-lite': { name: 'Gemini 3.1 Flash-Lite', maker: 'Google', intelligence: 16, notes: 'The weakest Gemini text model. It has carried whole runs when the others were busy.' },
  'qwen/qwen3.8-27b': { name: 'Qwen 3.8 27B', maker: 'Alibaba (Qwen)', intelligence: 34, notes: 'On Groq: 1,000 output tokens/min, enough for a plan but not a script chunk.' },
  'qwen/qwen3.8-27b:free': { name: 'Qwen 3.8 27B (free)', maker: 'Alibaba (Qwen)', intelligence: 34, notes: 'Free OpenRouter route; often rate-limited.' },
  'z-ai/glm-5.2:free': { name: 'GLM-5.2 (free)', maker: 'Z.ai (Zhipu)', intelligence: 34, notes: 'Free OpenRouter route; often rate-limited.' },
  'nemotron-3-ultra': { name: 'Nemotron 3 Ultra', maker: 'NVIDIA', intelligence: 23, notes: 'Timed out (>120 s) on real research and plan prompts.' },
  'gemma4:31b': { name: 'Gemma 4 31B', maker: 'Google (open weights)', intelligence: 19, notes: 'Wrote 5 of 7 calls in a live script run when the stronger models were unavailable.' },
  'nemotron-3-super': { name: 'Nemotron 3 Super', maker: 'NVIDIA', intelligence: 13 },
  'nvidia/nemotron-3.5-lightning:free': { name: 'Nemotron 3.5 Lightning (free)', maker: 'NVIDIA', intelligence: 13 },
  'openai/gpt-oss-120b': { name: 'gpt-oss-120b', maker: 'OpenAI (open weights)', intelligence: 12 },
  'gpt-oss-120b': { name: 'gpt-oss-120b', maker: 'OpenAI (open weights)', intelligence: 12 },
  'mistral-small-latest': { name: 'Mistral Small', maker: 'Mistral AI', intelligence: 11 },
  // Speech
  'gemini-3.1-flash-tts-preview': { name: 'Gemini 3.1 Flash TTS (preview)', maker: 'Google', notes: 'Text-to-speech with a prebuilt voice (Puck, Charon, Kore, Fenrir or Zephyr).' },
  'gemini-2.5-flash-preview-tts': { name: 'Gemini 2.5 Flash TTS (preview)', maker: 'Google', notes: 'Fallback text-to-speech model.' },
  // Images
  'gemini-3.1-flash-image': { name: 'Gemini 3.1 Flash Image', maker: 'Google', notes: 'No free-tier quota ("limit: 0"): skipped until billing is on.' },
  'gemini-2.5-flash-image': { name: 'Gemini 2.5 Flash Image', maker: 'Google', notes: 'No free-tier quota ("limit: 0"): skipped until billing is on.' },
  'gemini-3.1-flash-lite-image': { name: 'Gemini 3.1 Flash-Lite Image', maker: 'Google', notes: 'No free-tier quota ("limit: 0"): skipped until billing is on.' },
};

export function modelInfo(model?: string): ModelInfo | undefined {
  return model ? MODEL_INFO[model] : undefined;
}

export function providerInfo(provider?: string): ProviderInfo | undefined {
  return provider ? PROVIDER_INFO[provider] : undefined;
}

/** One model in the order a page will try it, with what we know about it. */
export interface LineupEntry {
  rank: number;
  provider: string;
  model: string;
  info?: ModelInfo;
  providerInfo?: ProviderInfo;
}

/** GET /api/models: the configured lineup for every kind of generation, from the live .env. */
export interface ModelLineup {
  /** Text: research, plan, script, publish package, chat, podcast dialogue. Only models with a key are listed. */
  text: LineupEntry[];
  textOrderSource: string;
  speech: LineupEntry[];
  voices: string[];
  image: LineupEntry[];
  podcastSpeech: LineupEntry[];
  intelligenceSource: string;
}
