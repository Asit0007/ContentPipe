import { buildTiers } from './llm/chain';
import { modelOrder } from './llm/providers';
import { TEXT_MODELS } from './gemini';
import { POLLINATIONS_MODEL_LABEL } from './imageProviders';
import { imageProviderOrder, videoProviderOrder } from './mediaOrder';
import { NOTEBOOKLM_TTS_MODEL } from './notebooklmService';
import { INTELLIGENCE_SOURCE, modelInfo, providerInfo, type LineupEntry, type ModelLineup } from '../shared/modelCatalog';

type Env = Record<string, string | undefined>;

/** Tried in this order by /api/tts. */
export const TTS_MODELS = ['gemini-3.1-flash-tts-preview', 'gemini-2.5-flash-preview-tts'];
export const TTS_VOICES = ['Puck', 'Charon', 'Kore', 'Fenrir', 'Zephyr'];

function lineup(pairs: Array<{ provider: string; model: string }>): LineupEntry[] {
  return pairs.map((p, i) => ({ rank: i + 1, ...p, info: modelInfo(p.model), providerInfo: providerInfo(p.provider) }));
}

/**
 * What each kind of generation will try, in order, built from the same functions the chain uses — so it can't drift
 * from what actually runs. It is the plan, not the outcome: which model answered a given call is in that response's
 * `modelUsage`.
 */
export function describeModelLineup(env: Env = process.env): ModelLineup {
  const text = buildTiers(env).flatMap((t) =>
    t.kind === 'gemini' ? (t.models ?? TEXT_MODELS).map((model) => ({ provider: 'gemini', model })) : t.provider.models.map((model) => ({ provider: t.provider.spec.id, model }))
  );
  const onlyGemini = text.every((e) => e.provider === 'gemini');
  const textOrderSource = modelOrder(env).length
    ? 'LLM_MODEL_ORDER in .env (one ranking across providers, smartest first)'
    : onlyGemini
      ? 'Gemini only: no other provider has an API key in .env'
      : 'LLM_PROVIDER_ORDER (whole providers in order, each with its own model list)';
  return {
    text: lineup(text),
    textOrderSource,
    speech: lineup(TTS_MODELS.map((model) => ({ provider: 'gemini', model }))),
    voices: TTS_VOICES,
    image: lineup([
      ...imageProviderOrder(env).map((e) => ({ provider: e.provider, model: e.provider === 'pollinations' ? POLLINATIONS_MODEL_LABEL : e.model })),
      { provider: 'placeholder', model: 'SVG placeholder (no model; refused in strict mode)' },
    ]),
    video: lineup(videoProviderOrder(env).map((e) => ({ provider: e.provider, model: e.model }))),
    podcastSpeech: lineup([{ provider: 'gemini', model: NOTEBOOKLM_TTS_MODEL }]),
    intelligenceSource: INTELLIGENCE_SOURCE,
  };
}
