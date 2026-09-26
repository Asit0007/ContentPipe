import { GoogleGenAI } from '@google/genai';
import { generateFallbackImage } from './fallbackGenerators';
import { classifyGeminiError } from './quota';
import { attemptOutcome } from './gemini';
import { noteModelAttempt, trackModelCall, withModelTask } from './llm/usage';
import { SpaceError, reduceSpaceFailures } from './hfSpace';
import { coolSpace, imageProviderOrder, runSpace, spaceCooldown } from './mediaOrder';
import { badOutput, imageAdapter, sniffImage } from './spaceAdapters';

/**
 * Scene image generation, in the order the owner set (IMAGE_PROVIDER_ORDER, see server/mediaOrder.ts). The default
 * is Hugging Face Spaces only — Qwen-Image-2512, then HiDream-O1-Image — and nothing outside the list is tried.
 * Gemini image models (Nano Banana Pro is `gemini:gemini-3-pro-image`) and Pollinations are opt-in entries: Gemini's
 * have no free-tier quota on this key (`limit: 0`), and Pollinations does not say which model drew the picture.
 *
 * When every entry fails the UI still gets a generated SVG placeholder, flagged `isPlaceholder`; a strict caller gets
 * `strictError` instead (429 on quota, 503 on busy/asleep Spaces), never the placeholder.
 */

export type ImageProviderId = 'hf' | 'gemini' | 'pollinations' | 'placeholder';

export interface ImageResult {
  imageUrl: string;
  provider: ImageProviderId;
  providerLabel: string;
  /** What drew it: a Space id (hf), a Gemini image model id, Pollinations' default, or none for the placeholder. */
  model?: string;
  isPlaceholder: boolean;
  /** Back-compat with the pre-chain response shape: true for the placeholder and for Pollinations. */
  isQuotaFallback: boolean;
  width: number;
  height: number;
  attempts: Array<{ provider: ImageProviderId; model?: string; error: string }>;
  /** Placeholder results only: the error a strict caller should get. Never serialised (the route drops it). */
  strictError?: unknown;
}

/**
 * Gemini image models this key can see — every one `limit: 0` until billing is on (re-probed 2026-09-26 for Nano
 * Banana Pro). Not in the default order; name one as `gemini:<id>` in IMAGE_PROVIDER_ORDER to use it.
 */
export const GEMINI_IMAGE_MODELS = ['gemini-3-pro-image', 'gemini-3.1-flash-image', 'gemini-2.5-flash-image', 'gemini-3.1-flash-lite-image'];
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
  cause?: unknown;
}

async function tryGemini(
  ai: GoogleGenAI,
  models: string[],
  prompt: string,
  aspectRatio: string,
  imageSize: string
): Promise<ProviderResult> {
  let lastErr: unknown;
  for (const model of models) {
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
      lastErr = new Error(`${model}: no image in the response`);
    } catch (err: any) {
      lastErr = err;
      const c = classifyGeminiError(err);
      // `limit: 0` is the normal free-tier answer here: no image quota exists without billing.
      noteModelAttempt({ provider: 'gemini', model, outcome: attemptOutcome(c.kind), detail: c.kind === 'zero' ? 'no free-tier quota (limit: 0)' : `${c.status ? `HTTP ${c.status} ` : ''}${c.kind.replace('_', '-')}`, ms: Date.now() - t0 });
      console.warn(`[Image Agent] Gemini model ${model} notice:`, err?.message || err);
    }
  }
  return { ok: false, error: 'No Gemini image model returned image data', cause: lastErr };
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
  req: { prompt: string; aspectRatio: string; imageSize: string },
  env: Record<string, string | undefined> = process.env
): Promise<ImageResult> {
  return withModelTask(`Scene image (${req.aspectRatio}, ${req.imageSize})`, () => trackModelCall('image', () => sceneImageChain(ai, req, env)));
}

/**
 * Real pixel size from the image header (PNG, WebP, JPEG), so the response reports what the model drew rather than
 * what was asked: Qwen-Image-2512 answers a 16:9 request with a 1664x928 WebP (live, 2026-09-26).
 */
export function imageSize(b: Buffer): { width: number; height: number } | undefined {
  if (b.length >= 24 && b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG') return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (b.length >= 30 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
    const chunk = b.toString('latin1', 12, 16);
    if (chunk === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    if (chunk === 'VP8L') {
      const bits = b.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (chunk === 'VP8X') return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
  }
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    for (let i = 2; i + 9 < b.length; ) {
      if (b[i] !== 0xff) return undefined;
      const marker = b[i + 1];
      const len = b.readUInt16BE(i + 2);
      // SOF0-SOF15 carry the size; C4 (DHT), C8 (JPG) and CC (DAC) share the range but are not frames.
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
      i += 2 + len;
    }
  }
  return undefined;
}

const SPACE_IMAGE_TIMEOUT_MS = 180_000;

async function trySpace(spaceId: string, prompt: string, aspectRatio: string, env: Record<string, string | undefined>): Promise<ProviderResult> {
  const cool = spaceCooldown(spaceId);
  if (cool) {
    noteModelAttempt({ provider: 'hf', model: spaceId, outcome: 'skipped', detail: `cooling down after: ${cool.reason}` });
    return { ok: false, error: `cooling down after: ${cool.reason}`, cause: new SpaceError(cool.reason, cool.classified) };
  }
  const t0 = Date.now();
  try {
    const { file } = await runSpace(spaceId, imageAdapter(spaceId), { prompt, aspectRatio }, SPACE_IMAGE_TIMEOUT_MS, env);
    const mime = sniffImage(file.bytes);
    if (!mime) throw badOutput('an image', file.bytes, file.contentType);
    noteModelAttempt({ provider: 'hf', model: spaceId, outcome: 'ok', ms: Date.now() - t0 });
    return { ok: true, model: spaceId, imageUrl: `data:${mime};base64,${file.bytes.toString('base64')}`, ...imageSize(file.bytes) };
  } catch (err: any) {
    const e = err instanceof SpaceError ? err : new SpaceError(String(err?.message || err), { kind: 'other' });
    coolSpace(spaceId, e);
    noteModelAttempt({ provider: 'hf', model: spaceId, outcome: attemptOutcome(e.classified.kind), detail: e.message, ms: Date.now() - t0 });
    console.warn(`[Image Agent] Space ${spaceId}: ${e.message}`);
    return { ok: false, error: e.message, cause: e };
  }
}

async function sceneImageChain(
  ai: GoogleGenAI,
  req: { prompt: string; aspectRatio: string; imageSize: string },
  env: Record<string, string | undefined>
): Promise<ImageResult> {
  const { prompt, aspectRatio, imageSize } = req;
  const attempts: ImageResult['attempts'] = [];
  const causes: unknown[] = [];
  const requested = dimensionsFor(aspectRatio);

  for (const entry of imageProviderOrder(env)) {
    if (entry.provider === 'hf') {
      const r = await trySpace(entry.model, prompt, aspectRatio, env);
      if (r.ok && r.imageUrl) {
        return {
          imageUrl: r.imageUrl,
          provider: 'hf',
          providerLabel: 'Hugging Face',
          model: entry.model,
          isPlaceholder: false,
          isQuotaFallback: false,
          width: r.width || requested.width,
          height: r.height || requested.height,
          attempts,
        };
      }
      attempts.push({ provider: 'hf', model: entry.model, error: r.error || 'Unknown error' });
      causes.push(r.cause);
    } else if (entry.provider === 'gemini') {
      const gemini = await tryGemini(ai, [entry.model], prompt, aspectRatio, imageSize);
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
      attempts.push({ provider: 'gemini', model: entry.model, error: gemini.error || 'Unknown error' });
      causes.push(gemini.cause);
    } else {
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
      // Pollinations' failures are an outage, never a quota.
      causes.push(new SpaceError(`pollinations: ${pollinations.error}`, { kind: 'transient', retryAfterSec: 30 }));
    }
  }

  const why = attempts.map((a) => `${a.provider}${a.model ? ` ${a.model}` : ''}: ${a.error}`).join('; ');
  const reduced: any = reduceSpaceFailures(causes.filter(Boolean), 'No image provider is configured');
  // Keep every provider's reason in the message the strict caller sees.
  if (reduced && typeof reduced === 'object' && 'message' in reduced) reduced.message = `${reduced.message} (${why})`;
  return {
    imageUrl: generateFallbackImage(prompt, aspectRatio),
    provider: 'placeholder',
    providerLabel: 'Placeholder',
    isPlaceholder: true,
    isQuotaFallback: true,
    width: requested.width,
    height: requested.height,
    attempts,
    strictError: reduced,
  };
}
