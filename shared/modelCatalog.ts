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
  groq: { label: 'Groq', cost: 'Free tier, per model: 30 requests/min, 1,000/day, 8,000 tokens/min, 200,000 tokens/day' },
  cerebras: { label: 'Cerebras', cost: 'Free tier' },
  huggingface: { label: 'Hugging Face (routed)', cost: 'Free $0.10 of credit a month, then pay-as-you-go (credits must be bought)' },
  openrouter: { label: 'OpenRouter', cost: 'Free (":free" models): 50 requests/day across all of them, 20/min; often rate-limited upstream' },
  ollama: { label: 'Ollama Cloud', cost: 'Free plan: monthly starter credits, starter models only, 1 request at a time' },
  mistral: { label: 'Mistral', cost: 'Free tier (trains on prompts). On this key Small, Medium and Magistral have a 0 requests/min limit; Ministral and Codestral work' },
  pollinations: { label: 'Pollinations', cost: 'Free, no API key' },
  cloudflare: { label: 'Cloudflare Workers AI', cost: 'Free: 10,000 Neurons a day, hard stop on the Free plan (about 45-75 stills a day)' },
  hf: { label: 'Hugging Face Spaces', cost: 'Free ZeroGPU minutes on your HF_TOKEN (a few per day); a Space can change or vanish' },
  placeholder: { label: 'Built-in placeholder', cost: 'Free, no model' },
};

export const MODEL_INFO: Record<string, ModelInfo> = {
  // Text: the ranked chain in .env
  'gemini-3.8-flash': { name: 'Gemini 3.8 Flash', maker: 'Google', intelligence: 41, notes: 'Smartest free model in the chain; first since 2026-09-27. Unverified on our schemas: on 2026-09-24 it answered tiny calls but 503 "high demand" on the pipeline\'s large ones (the chain then moves on at once). Score from the 2026-09-27 table, not the 2026-09-24 one the others use.' },
  'gemini-3.7-flash': { name: 'Gemini 3.7 Flash', maker: 'Google', intelligence: 39, notes: 'Second, behind 3.8 Flash. Often answers 503 "high demand" on large requests.' },
  'gemini-3.6-flash': { name: 'Gemini 3.6 Flash', maker: 'Google', intelligence: 34 },
  'gemini-3.1-flash-lite': { name: 'Gemini 3.1 Flash-Lite', maker: 'Google', intelligence: 16, notes: 'The weakest Gemini text model. It has carried whole runs when the others were busy.' },
  'qwen/qwen3.8-27b': { name: 'Qwen 3.8 27B', maker: 'Alibaba (Qwen)', intelligence: 34, notes: 'On Groq: 1,000 output tokens/min, enough for a plan but not a script chunk.' },
  'qwen/qwen3.8-27b:free': { name: 'Qwen 3.8 27B (free)', maker: 'Alibaba (Qwen)', intelligence: 34, notes: 'Free OpenRouter route; often rate-limited.' },
  'nemotron-3-ultra': { name: 'Nemotron 3 Ultra', maker: 'NVIDIA', intelligence: 23, notes: 'Timed out (>120 s) on real research and plan prompts.' },
  'gemma4:31b': { name: 'Gemma 4 31B', maker: 'Google (open weights)', intelligence: 19, notes: 'Wrote 5 of 7 calls in a live script run when the stronger models were unavailable.' },
  'nemotron-3-super': { name: 'Nemotron 3 Super', maker: 'NVIDIA', intelligence: 13 },
  'openai/gpt-oss-120b': { name: 'gpt-oss-120b', maker: 'OpenAI (open weights)', intelligence: 12 },
  'qwen-3.8-27b': { name: 'Qwen 3.8 27B', maker: 'Alibaba (Qwen)', intelligence: 34, notes: 'On Cerebras: the same model as Groq\'s, on separate rate limits. HTTP 402 with the owner\'s key on 2026-09-27.' },
  'deepseek-ai/DeepSeek-V4-Flash:cheapest': { name: 'DeepSeek V4 Flash (via Hugging Face)', maker: 'DeepSeek', notes: 'Routed by Hugging Face to the cheapest provider. Paid per token; the free $0.10 a month lasts roughly a dozen script calls. Unverified on our schemas.' },
  'gpt-oss-120b': { name: 'gpt-oss-120b', maker: 'OpenAI (open weights)', intelligence: 12 },
  'mistral-small-latest': { name: 'Mistral Small', maker: 'Mistral AI', intelligence: 11, notes: 'Never answers on this key: 429 with a 0 requests/min limit (2026-09-27), so it was replaced by Ministral 14B.' },
  'ministral-14b-latest': { name: 'Ministral 14B', maker: 'Mistral AI', notes: 'Last in the chain since 2026-09-27, replacing Mistral Small (blocked on this key). 30 requests/min on the free tier; JSON mode works (4 s). Not scored here. Mistral\'s free tier trains on prompts.' },
  'nvidia/nemotron-3.5-lightning:free': { name: 'Nemotron 3.5 Lightning (free)', maker: 'NVIDIA', intelligence: 13, notes: 'Took 57 s for a one-word reply on 2026-09-27.' },
  // Images: Cloudflare Workers AI (IMAGE_PROVIDER_ORDER=cloudflare:<model>), added 2026-09-27 to keep the Hugging Face GPU quota for video.
  'flux-2-klein-4b': { name: 'FLUX.2 [klein] 4B', maker: 'Black Forest Labs', notes: 'On Workers AI: multipart, 256-1920 px, 4 fixed steps. Weights are Apache 2.0, but Cloudflare states no licence: confirm before monetised use.' },
  'flux-1-schnell': { name: 'FLUX.1 [schnell]', maker: 'Black Forest Labs', notes: 'On Workers AI: square only, up to 8 steps. Apache 2.0 weights.' },
  // Speech
  'gemini-3.1-flash-tts-preview': { name: 'Gemini 3.1 Flash TTS (preview)', maker: 'Google', notes: 'Text-to-speech with a prebuilt voice (Puck, Charon, Kore, Fenrir or Zephyr).' },
  'gemini-2.5-flash-preview-tts': { name: 'Gemini 2.5 Flash TTS (preview)', maker: 'Google', notes: 'Fallback text-to-speech model.' },
  // Images: Hugging Face Spaces (IMAGE_PROVIDER_ORDER). Ranked on the Artificial Analysis open-weights text-to-image
  // arena, 2026-09-26, among commercially licensed models only.
  'Qwen/Qwen-Image-2512': { name: 'Qwen-Image-2512', maker: 'Alibaba (Qwen), open weights', notes: 'Apache 2.0, commercial use allowed. Official Qwen Space on ZeroGPU, 50 steps: uses your GPU minutes. Qwen-Image-2.1 ranks higher but is non-commercial.' },
  'HiDream-ai/HiDream-O1-Image': { name: 'HiDream-O1-Image', maker: 'HiDream.ai, open weights', notes: 'MIT licence. The Space forwards to HiDream\'s own GPUs, so it spends no ZeroGPU minutes.' },
  // Video: Hugging Face Spaces (VIDEO_PROVIDER_ORDER), Artificial Analysis image-to-video arena, 2026-09-26.
  'MiniMaxAI/MiniMax-H3-Turbo-Lora': { name: 'MiniMax-H3 Turbo LoRA', maker: 'MiniMax, open weights', notes: 'MiniMax-H3 scores Elo 1357 (no audio) / 1181 (with audio); this Space runs a 6-step turbo LoRA, so expect less. Clip comes with its own soundtrack, which was poor on the first live clip (owner, 2026-09-26): mute it and use the cue sheet. 2-14 s. Licence: commercial use allowed under $20M/yr revenue; credit "MiniMax H3" in the video description.' },
  'zerogpu-aoti/wan2-2-fp8da-aoti-faster': { name: 'Wan 2.2 14B (image to video)', maker: 'Alibaba (Wan), open weights', notes: 'Apache 2.0. Hugging Face\'s own ZeroGPU Space. Silent, 16 fps, at most 5 s.' },
  // Images: Gemini
  'gemini-3-pro-image': { name: 'Nano Banana Pro (Gemini 3 Pro Image)', maker: 'Google', notes: 'No free-tier quota on this key ("limit: 0", re-checked 2026-09-26). Use it by hand in the Gemini app with the scene\'s Nano Banana Pro prompt, or add gemini:gemini-3-pro-image to IMAGE_PROVIDER_ORDER once billing is on.' },
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
  /** Image to video: scene clips. */
  video: LineupEntry[];
  podcastSpeech: LineupEntry[];
  intelligenceSource: string;
}
