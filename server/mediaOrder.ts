import { SPACE_ID_RE, SpaceError, callSpace, downloadSpaceFile, spaceApiInfo, spaceHost, uploadToSpace, type SpaceFile } from './hfSpace';
import type { ClassifiedError } from './quota';
import type { SpaceAdapter, SpaceCall } from './spaceAdapters';

/**
 * Which providers make images and video, in order — the owner's choice, set in .env:
 *
 *   IMAGE_PROVIDER_ORDER=hf:Qwen/Qwen-Image-2512,hf:HiDream-ai/HiDream-O1-Image
 *   VIDEO_PROVIDER_ORDER=hf:MiniMaxAI/MiniMax-H3-Turbo-Lora,hf:zerogpu-aoti/wan2-2-fp8da-aoti-faster
 *
 * Entries: `hf:<owner>/<space>` (a Hugging Face Space), and for images only `gemini:<model>` (e.g.
 * gemini-3-pro-image, Nano Banana Pro, once billing is on) and `pollinations`. Nothing outside the list is tried:
 * the defaults are Hugging Face only, so an image never silently comes from a model nobody chose. The SVG placeholder
 * is not a provider; the UI still gets it when every entry fails, flagged, and strict callers never do.
 *
 * Defaults ranked 2026-09-26 on Artificial Analysis arenas, commercially usable licences only (Blast Radius is meant
 * to be monetised): images — Qwen-Image-2512 (Apache 2.0) then HiDream-O1-Image (MIT); Qwen-Image-2.1, Ideogram 4
 * and FLUX.2 [dev] rank higher but are non-commercial. Video — MiniMax-H3 (image-to-video Elo 1357) then Wan 2.2
 * (not on the current board; Wan 2.6 is 889).
 */

export const DEFAULT_IMAGE_PROVIDER_ORDER = 'hf:Qwen/Qwen-Image-2512,hf:HiDream-ai/HiDream-O1-Image';
export const DEFAULT_VIDEO_PROVIDER_ORDER = 'hf:MiniMaxAI/MiniMax-H3-Turbo-Lora,hf:zerogpu-aoti/wan2-2-fp8da-aoti-faster';

/**
 * Who may receive HF_TOKEN. A Space is someone else's code: with the token attached, a hostile owner could read it
 * from the request and act as the owner of this account. So the token goes only to Spaces owned by these official
 * organisations; any other Space in the order is called anonymously (the small anonymous GPU allowance). Override
 * with HF_TOKEN_SPACE_OWNERS (comma-separated) — add an owner only after reading who runs it.
 */
export const DEFAULT_TOKEN_SPACE_OWNERS = ['Qwen', 'HiDream-ai', 'MiniMaxAI', 'zerogpu-aoti', 'Wan-AI', 'black-forest-labs', 'Lightricks', 'Tongyi-MAI'];

export function tokenAllowedFor(spaceId: string, env: Env = process.env): boolean {
  const owners = (env.HF_TOKEN_SPACE_OWNERS?.split(',').map((o) => o.trim()).filter(Boolean)) || DEFAULT_TOKEN_SPACE_OWNERS;
  return owners.includes(spaceId.split('/')[0]);
}

/** Spaces whose name says what they are for. Refused outright: a brand channel's pipeline never calls them. */
const REFUSED_SPACE_RE = /nsfw|uncensored|porn|hentai|nude|explicit|\bcum\b|18\+/i;

export type MediaEntry = { provider: 'hf'; model: string } | { provider: 'gemini'; model: string } | { provider: 'pollinations'; model: string };

type Env = Record<string, string | undefined>;

export function parseMediaOrder(raw: string, allowed: Array<MediaEntry['provider']>): { entries: MediaEntry[]; rejected: string[] } {
  const entries: MediaEntry[] = [];
  const rejected: string[] = [];
  for (const item of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    const colon = item.indexOf(':');
    const provider = (colon === -1 ? item : item.slice(0, colon)).toLowerCase();
    const model = colon === -1 ? '' : item.slice(colon + 1).trim();
    if (provider === 'hf' && allowed.includes('hf') && SPACE_ID_RE.test(model) && !REFUSED_SPACE_RE.test(model)) entries.push({ provider: 'hf', model });
    else if (provider === 'gemini' && allowed.includes('gemini') && /^[\w.-]+$/.test(model)) entries.push({ provider: 'gemini', model });
    else if (provider === 'pollinations' && allowed.includes('pollinations')) entries.push({ provider: 'pollinations', model: 'default' });
    else rejected.push(item);
  }
  return { entries, rejected };
}

const warned = new Set<string>();
function orderFrom(env: Env, key: string, fallback: string, allowed: Array<MediaEntry['provider']>): MediaEntry[] {
  const raw = env[key]?.trim() || fallback;
  const { entries, rejected } = parseMediaOrder(raw, allowed);
  for (const r of rejected) {
    if (!warned.has(`${key}:${r}`)) console.warn(`[Media] ${key}: ignoring "${r}" (expected ${allowed.map((a) => (a === 'pollinations' ? a : `${a}:<id>`)).join(' | ')})`);
    warned.add(`${key}:${r}`);
  }
  return entries.length ? entries : parseMediaOrder(fallback, allowed).entries;
}

export function imageProviderOrder(env: Env = process.env): MediaEntry[] {
  return orderFrom(env, 'IMAGE_PROVIDER_ORDER', DEFAULT_IMAGE_PROVIDER_ORDER, ['hf', 'gemini', 'pollinations']);
}

export function videoProviderOrder(env: Env = process.env): MediaEntry[] {
  return orderFrom(env, 'VIDEO_PROVIDER_ORDER', DEFAULT_VIDEO_PROVIDER_ORDER, ['hf']);
}

// ── Cooldowns ─────────────────────────────────────────────────────────────────────────────────────────────────────
// In-process, like the text chain's: a Space out of GPU quota is not asked again for every scene of a script.

const COOLDOWN_CAP_SEC = 30 * 60;
const cooling = new Map<string, { until: number; reason: string; classified: ClassifiedError }>();

export function spaceCooldown(spaceId: string, now = Date.now()) {
  const c = cooling.get(spaceId);
  if (!c) return undefined;
  if (c.until <= now) {
    cooling.delete(spaceId);
    return undefined;
  }
  return c;
}

export function coolSpace(spaceId: string, err: SpaceError, now = Date.now()): void {
  const c = err.classified;
  // quota: its reset; busy/asleep: 2 min (a Space waking up takes that long); API changed / refused: 30 min.
  const sec = c.kind === 'other' ? COOLDOWN_CAP_SEC : c.kind === 'transient' ? 120 : Math.min(COOLDOWN_CAP_SEC, c.retryAfterSec ?? 600);
  cooling.set(spaceId, { until: now + sec * 1000, reason: err.message, classified: c });
}

export function clearSpaceCooldowns(): void {
  cooling.clear();
}

/** One Space call end to end: resolve, build the inputs (uploading any), run, download the output file. */
export async function runSpace<J>(
  spaceId: string,
  adapter: SpaceAdapter<J>,
  job: J,
  timeoutMs: number,
  env: Env = process.env
): Promise<{ file: SpaceFile; call: SpaceCall; extra: unknown[] }> {
  const host = await spaceHost(spaceId, env);
  // Everything sent to the Space itself carries the token only if its owner is trusted (see DEFAULT_TOKEN_SPACE_OWNERS).
  const spaceEnv: Env = tokenAllowedFor(spaceId, env) ? env : { ...env, HF_TOKEN: '', HUGGINGFACE_TOKEN: '', HUGGING_FACE_HUB_TOKEN: '' };
  const call = await adapter.build(job, {
    upload: (file, name) => uploadToSpace(host, file, name, spaceEnv),
    apiInfo: () => spaceApiInfo(host, spaceEnv),
  });
  const outputs = await callSpace(host, call.endpoint, call.data, timeoutMs, spaceEnv);
  const file = await downloadSpaceFile(host, outputs[call.outputIndex], 120000, spaceEnv);
  return { file, call, extra: outputs.filter((_, i) => i !== call.outputIndex) };
}
