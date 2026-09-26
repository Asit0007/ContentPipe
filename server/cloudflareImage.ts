import { SpaceError } from './hfSpace';
import { sniffImage } from './spaceAdapters';

/**
 * FLUX on Cloudflare Workers AI, as an image provider (`cloudflare:<model>` in IMAGE_PROVIDER_ORDER).
 *
 * Why it exists (owner, 2026-09-27): the Hugging Face ZeroGPU quota is about 5 GPU-minutes a day and images and
 * video share it, so it is kept for video. Workers AI gives every account 10,000 Neurons a day free, with a hard stop
 * instead of a bill on the Free plan (developers.cloudflare.com/workers-ai/platform/pricing, 2026-09-27). At the listed
 * prices that is roughly 45 images a day at 1920x1088 or 75 at 1536x864 with flux-2-klein-4b — not measured yet.
 *
 * Only the two models whose weights are commercially usable are allowed (Blast Radius is meant to be monetised):
 *   flux-2-klein-4b  multipart form; width/height 256-1920; 4 fixed steps. BFL released the 4B weights under
 *                    Apache 2.0 — but Cloudflare's page states no licence, so confirm the hosted terms before money.
 *   flux-1-schnell   JSON; no size parameter (square); up to 8 steps. Apache 2.0 weights.
 * flux-2-klein-9b and flux-2-dev are left out on purpose: non-commercial weights, and klein-9b costs ~1,360 Neurons an
 * image (about 7 a day free). Adding a model here is a code change, not an env value, for that reason.
 *
 * Credentials: CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (a token with Workers AI read/run access only). They go
 * to api.cloudflare.com and nowhere else; redirects are refused.
 */

export const CLOUDFLARE_IMAGE_MODELS = ['flux-2-klein-4b', 'flux-1-schnell'] as const;
export type CloudflareImageModel = (typeof CLOUDFLARE_IMAGE_MODELS)[number];

export const isCloudflareImageModel = (m: string): m is CloudflareImageModel => (CLOUDFLARE_IMAGE_MODELS as readonly string[]).includes(m);

/** The documented prompt cap for flux-1-schnell; klein takes a longer one, but one cap keeps the behaviour uniform. */
export const CLOUDFLARE_MAX_PROMPT_CHARS = 2048;
const TIMEOUT_MS = 90_000;

type Env = Record<string, string | undefined>;

/**
 * Sizes for flux-2-klein-4b, all multiples of 16 and inside its 256-1920 range. About 1.3 MP: sharp enough to
 * upscale to 1080p in the edit, and cheaper on the daily Neuron allowance than 1920x1088 (override with
 * CLOUDFLARE_IMAGE_LONG_EDGE=1920 for the top of its range).
 */
export function cloudflareDimensions(aspectRatio: string, env: Env = process.env): { width: number; height: number } {
  const edge = Math.min(1920, Math.max(512, Math.round(Number(env.CLOUDFLARE_IMAGE_LONG_EDGE) / 16) * 16 || 1536));
  const short = (ratio: number) => Math.round((edge * ratio) / 16) * 16;
  if (aspectRatio === '9:16') return { width: short(9 / 16), height: edge };
  if (aspectRatio === '1:1') return { width: Math.min(edge, 1024), height: Math.min(edge, 1024) };
  if (aspectRatio === '4:3') return { width: edge, height: short(3 / 4) };
  if (aspectRatio === '3:4') return { width: short(3 / 4), height: edge };
  return { width: edge, height: short(9 / 16) };
}

/** Cut at a sentence end at or before the cap so the front (character anchor) survives and no sentence is chopped. */
export function fitPrompt(prompt: string, max = CLOUDFLARE_MAX_PROMPT_CHARS): string {
  const p = prompt.replace(/\s+/g, ' ').trim();
  if (p.length <= max) return p;
  const head = p.slice(0, max);
  const end = Math.max(head.lastIndexOf('. '), head.lastIndexOf('! '), head.lastIndexOf('? '));
  return end > max * 0.5 ? head.slice(0, end + 1) : head;
}

function secondsUntilUtcMidnight(now = Date.now()): number {
  const d = new Date(now);
  return Math.max(60, Math.ceil((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) - now) / 1000));
}

/** Map an HTTP failure to the classes the cooldown logic already understands. */
export function classifyCloudflareError(status: number, body: string, retryAfterHeader?: string | null): SpaceError {
  const text = body.slice(0, 400).replace(/\s+/g, ' ');
  const msg = `Cloudflare Workers AI HTTP ${status}: ${text}`;
  if (/daily free allocation|4006|neurons/i.test(text) && (status === 429 || status === 403 || status === 400)) {
    return new SpaceError(msg, { kind: 'per_day', retryAfterSec: secondsUntilUtcMidnight(), status });
  }
  if (status === 429) return new SpaceError(msg, { kind: 'per_minute', retryAfterSec: Number(retryAfterHeader) || 60, status });
  if (status === 401 || status === 403) return new SpaceError(`${msg} (check CLOUDFLARE_API_TOKEN and its Workers AI permission)`, { kind: 'other', status });
  if (status >= 500 || status === 408) return new SpaceError(msg, { kind: 'transient', status });
  return new SpaceError(msg, { kind: 'other', status });
}

export interface CloudflareImage {
  bytes: Buffer;
  contentType: string;
}

export async function runCloudflareImage(
  model: string,
  prompt: string,
  aspectRatio: string,
  env: Env = process.env,
  fetchImpl: typeof fetch = fetch
): Promise<CloudflareImage> {
  if (!isCloudflareImageModel(model)) throw new SpaceError(`cloudflare:${model} is not an allowed model (${CLOUDFLARE_IMAGE_MODELS.join(', ')})`, { kind: 'other' });
  const account = env.CLOUDFLARE_ACCOUNT_ID?.trim();
  const token = env.CLOUDFLARE_API_TOKEN?.trim();
  if (!account || !token) throw new SpaceError('CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are not both set', { kind: 'other' });
  if (!/^[0-9a-f]{32}$/i.test(account)) throw new SpaceError('CLOUDFLARE_ACCOUNT_ID must be the 32-character hex account id', { kind: 'other' });

  const text = fitPrompt(prompt);
  const url = `https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/@cf/black-forest-labs/${model}`;
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  let body: FormData | string;
  if (model === 'flux-2-klein-4b') {
    // Multipart even for a bare prompt (Cloudflare's docs). Leave Content-Type to fetch so it adds the boundary.
    const { width, height } = cloudflareDimensions(aspectRatio, env);
    const form = new FormData();
    form.append('prompt', text);
    form.append('width', String(width));
    form.append('height', String(height));
    body = form;
  } else {
    // flux-1-schnell draws a square whatever is asked. A 16:9 or 9:16 frame from it would be the wrong shape for video.
    if (aspectRatio !== '1:1') throw new SpaceError('flux-1-schnell on Workers AI only draws square images', { kind: 'other' });
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify({ prompt: text, steps: 8 });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { method: 'POST', headers, body, signal: controller.signal, redirect: 'error' });
    const contentType = res.headers.get('content-type') || '';
    if (!res.ok) throw classifyCloudflareError(res.status, await res.text(), res.headers.get('retry-after'));
    if (contentType.startsWith('image/')) return { bytes: Buffer.from(await res.arrayBuffer()), contentType };
    const json: any = await res.json();
    // REST wraps the payload as { success, result: { image }, errors }; some routes return { image } directly.
    if (json?.success === false) throw classifyCloudflareError(res.status, JSON.stringify(json.errors ?? json), null);
    const b64: unknown = json?.result?.image ?? json?.image;
    if (typeof b64 !== 'string' || b64.length < 100) throw new SpaceError('Cloudflare Workers AI answered without an image', { kind: 'other', status: res.status });
    const bytes = Buffer.from(b64, 'base64');
    const mime = sniffImage(bytes);
    if (!mime) throw new SpaceError(`Cloudflare Workers AI returned ${bytes.length} bytes that are not an image`, { kind: 'other' });
    return { bytes, contentType: mime };
  } catch (err: any) {
    if (err instanceof SpaceError) throw err;
    if (err?.name === 'AbortError') throw new SpaceError(`Cloudflare Workers AI timed out after ${TIMEOUT_MS / 1000}s`, { kind: 'transient' });
    throw new SpaceError(`Cloudflare Workers AI request failed: ${err?.message || err}`, { kind: 'transient' });
  } finally {
    clearTimeout(timer);
  }
}
