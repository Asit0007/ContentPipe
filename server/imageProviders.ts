import { GoogleGenAI } from '@google/genai';
import { generateFallbackImage } from './fallbackGenerators';
import { classifyGeminiError } from './quota';
import { attemptOutcome } from './gemini';
import { noteModelAttempt, trackModelCall, withModelTask } from './llm/usage';

/**
 * Scene image generation, tried best-first.
 *
 * Gemini image models have zero free-tier quota (`limit: 0` on
 * generate_content_free_tier_requests — not a rate limit, no quota exists at
 * all), so on a free API key this chain always falls through to Pollinations,
 * a free hosted diffusion endpoint with no API key. If that also fails, a
 * generated SVG placeholder is the last resort.
 *
 * Every result names the provider that actually produced it (`provider`,
 * `isPlaceholder`) so the UI can stop presenting a placeholder as artwork.
 */

export type ImageProviderId = 'gemini' | 'pollinations' | 'placeholder';

export interface ImageResult {
  imageUrl: string;
  provider: ImageProviderId;
  providerLabel: string;
  /** The model that drew it: a Gemini image model id, Pollinations' default, or none for the placeholder. */
  model?: string;
  isPlaceholder: boolean;
  /** Back-compat with the pre-chain response shape; true whenever `provider !== 'gemini'`. */
  isQuotaFallback: boolean;
  width: number;
  height: number;
  attempts: Array<{ provider: ImageProviderId; error: string }>;
}

export const GEMINI_IMAGE_MODELS = ['gemini-3.1-flash-image', 'gemini-2.5-flash-image', 'gemini-3.1-flash-lite-image'];
// Overridable so the end-to-end test can stand in for the service instead of reaching the network.
/** Pollinations picks its own default model when the request names none, and this one names none. */
export const POLLINATIONS_MODEL_LABEL = 'Pollinations default model (not named in the request)';
const POLLINATIONS_BASE_URL = process.env.POLLINATIONS_BASE_URL || 'https://image.pollinations.ai';
const POLLINATIONS_TIMEOUT_MS = 25000;
const POLLINATIONS_MAX_PROMPT_CHARS = 1500; // layered visualPrompts can overflow URL path limits

/** Pollinations' actual cap, and the 1K baseline every other size scales from. */
function dimensionsFor(aspectRatio: string): { width: number; height: number } {
  if (aspectRatio === '9:16') return { width: 576, height: 1024 };
  if (aspectRatio === '1:1') return { width: 1024, height: 1024 };
  if (aspectRatio === '4:3') return { width: 1024, height: 768 };
  if (aspectRatio === '3:4') return { width: 768, height: 1024 };
  return { width: 1024, height: 576 }; // 16:9 default
}

/** Gemini actually renders at the requested imageSize, unlike Pollinations
 * (which is capped at the 1K baseline regardless of what's asked for) — so
 * only the Gemini result should report a scaled-up size. */
function geminiDimensionsFor(aspectRatio: string, imageSize: string): { width: number; height: number } {
  const base = dimensionsFor(aspectRatio);
  const factor = imageSize === '4K' ? 4 : imageSize === '2K' ? 2 : 1;
  return { width: base.width * factor, height: base.height * factor };
}

// Plain (non-discriminated) result shapes rather than unions: this repo's
// tsconfig has strictNullChecks off, under which TS does not narrow
// `ok: true | false` literal unions on `if (result.ok)`.
interface ProviderResult {
  ok: boolean;
  imageUrl?: string;
  model?: string;
  width?: number;
  height?: number;
  error?: string;
}

async function tryGemini(
  ai: GoogleGenAI,
  prompt: string,
  aspectRatio: string,
  imageSize: string
): Promise<ProviderResult> {
  for (const model of GEMINI_IMAGE_MODELS) {
    const t0 = Date.now();
    try {
      const response = await ai.models.generateContent({
        model,
        contents: { parts: [{ text: prompt }] },
        config: { imageConfig: { aspectRatio, imageSize } },
      });
      const parts = response?.candidates?.[0]?.content?.parts || [];
      for (const part of parts) {
        if (part.inlineData?.data) {
          const mime = part.inlineData.mimeType || 'image/png';
          noteModelAttempt({ provider: 'gemini', model, outcome: 'ok', ms: Date.now() - t0 });
          return { ok: true, model, imageUrl: `data:${mime};base64,${part.inlineData.data}` };
        }
      }
      noteModelAttempt({ provider: 'gemini', model, outcome: 'invalid_output', detail: 'no image in the response', ms: Date.now() - t0 });
    } catch (err: any) {
      const c = classifyGeminiError(err);
      // `limit: 0` is the normal free-tier answer here: no image quota exists without billing.
      noteModelAttempt({ provider: 'gemini', model, outcome: attemptOutcome(c.kind), detail: c.kind === 'zero' ? 'no free-tier quota (limit: 0)' : `${c.status ? `HTTP ${c.status} ` : ''}${c.kind.replace('_', '-')}`, ms: Date.now() - t0 });
      console.warn(`[Image Agent] Gemini model ${model} notice:`, err?.message || err);
    }
  }
  return { ok: false, error: 'No Gemini image model returned image data' };
}

async function tryPollinations(prompt: string, aspectRatio: string): Promise<ProviderResult> {
  const { width, height } = dimensionsFor(aspectRatio);
  const truncated = prompt.slice(0, POLLINATIONS_MAX_PROMPT_CHARS);
  const url = `${POLLINATIONS_BASE_URL}/prompt/${encodeURIComponent(truncated)}?width=${width}&height=${height}&nologo=true`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), POLLINATIONS_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status} ${res.statusText}`.trim() };
    }
    const contentType = res.headers.get('content-type') || '';
    const buf = Buffer.from(await res.arrayBuffer());
    // Pollinations returns 200 with an HTML/JSON error body on failure — verify it's really an image.
    if (!contentType.startsWith('image/') || buf.byteLength < 1024) {
      return { ok: false, error: `Unexpected response (${contentType || 'no content-type'}, ${buf.byteLength} bytes)` };
    }
    return { ok: true, imageUrl: `data:${contentType};base64,${buf.toString('base64')}`, width, height };
  } catch (err: any) {
    const msg = err?.name === 'AbortError' ? `Timed out after ${POLLINATIONS_TIMEOUT_MS}ms` : err?.message || String(err);
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

export function generateSceneImage(
  ai: GoogleGenAI,
  req: { prompt: string; aspectRatio: string; imageSize: string }
): Promise<ImageResult> {
  return withModelTask(`Scene image (${req.aspectRatio}, ${req.imageSize})`, () => trackModelCall('image', () => sceneImageChain(ai, req)));
}

async function sceneImageChain(
  ai: GoogleGenAI,
  req: { prompt: string; aspectRatio: string; imageSize: string }
): Promise<ImageResult> {
  const { prompt, aspectRatio, imageSize } = req;
  const attempts: Array<{ provider: ImageProviderId; error: string }> = [];
  const requested = dimensionsFor(aspectRatio);

  const gemini = await tryGemini(ai, prompt, aspectRatio, imageSize);
  if (gemini.ok && gemini.imageUrl) {
    const geminiDims = geminiDimensionsFor(aspectRatio, imageSize);
    return {
      imageUrl: gemini.imageUrl,
      provider: 'gemini',
      providerLabel: 'Gemini',
      model: gemini.model,
      isPlaceholder: false,
      isQuotaFallback: false,
      width: geminiDims.width,
      height: geminiDims.height,
      attempts,
    };
  }
  attempts.push({ provider: 'gemini', error: gemini.error || 'Unknown error' });

  const tp = Date.now();
  const pollinations = await tryPollinations(prompt, aspectRatio);
  noteModelAttempt({
    provider: 'pollinations',
    model: POLLINATIONS_MODEL_LABEL,
    outcome: pollinations.ok ? 'ok' : 'error',
    ...(pollinations.ok ? {} : { detail: pollinations.error }),
    ms: Date.now() - tp,
  });
  if (pollinations.ok && pollinations.imageUrl) {
    return {
      imageUrl: pollinations.imageUrl,
      provider: 'pollinations',
      providerLabel: 'Pollinations',
      model: POLLINATIONS_MODEL_LABEL,
      isPlaceholder: false,
      isQuotaFallback: true,
      width: pollinations.width || requested.width,
      height: pollinations.height || requested.height,
      attempts,
    };
  }
  attempts.push({ provider: 'pollinations', error: pollinations.error || 'Unknown error' });

  return {
    imageUrl: generateFallbackImage(prompt, aspectRatio),
    provider: 'placeholder',
    providerLabel: 'Placeholder',
    isPlaceholder: true,
    isQuotaFallback: true,
    width: requested.width,
    height: requested.height,
    attempts,
  };
}
