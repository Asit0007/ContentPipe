import {
  QuotaExhaustedError,
  UpstreamUnavailableError,
  classifyGeminiError,
  isQuotaKind,
  summarizeQuotaFailures,
  type ClassifiedError,
} from './quota';

/**
 * A minimal client for Hugging Face Spaces that run Gradio (the image and video models, see
 * server/spaceAdapters.ts). It speaks Gradio's plain HTTP API instead of pulling in @gradio/client:
 *
 *   POST {host}/gradio_api/upload                 multipart "files" -> ["/tmp/gradio/.../x.png"]
 *   POST {host}/gradio_api/call/{endpoint}        {data: [...]}     -> {event_id}
 *   GET  {host}/gradio_api/call/{endpoint}/{id}   server-sent events: `complete` with the outputs, or `error`
 *   GET  {host}/gradio_api/info                   the named endpoints and their parameters (the generic adapter)
 *
 * The token goes in `x-hf-authorization`, as gradio_client sends it (checked against its source 2026-09-26), so a
 * ZeroGPU Space bills GPU time to the token's account (free: a few GPU-minutes a day) instead of the anonymous pool.
 *
 * Spaces change without notice: they sleep, get rebuilt, rename endpoints, or run out of GPU. Every failure is
 * classified like a provider error (quota / transient / other) so the image and video chains fall through to the next
 * Space and a strict caller gets 429 / 503 / 502 with a Retry-After.
 */

export const SPACE_ID_RE = /^[A-Za-z0-9][\w.-]*\/[\w.-]+$/;

type Env = Record<string, string | undefined>;

export class SpaceError extends Error {
  readonly classified: ClassifiedError;
  constructor(message: string, classified: ClassifiedError) {
    super(message);
    this.name = 'SpaceError';
    this.classified = classified;
  }
}

export interface GradioFileData {
  path: string;
  url?: string;
  orig_name?: string;
  mime_type?: string;
  meta: { _type: 'gradio.FileData' };
}

export interface SpaceFile {
  bytes: Buffer;
  contentType: string;
}

/** Waits like "Try again in 1:02:03", "retry in 45s", "in 3 minutes". Undefined when the message names none. */
export function parseSpaceRetrySec(message: string): number | undefined {
  const hms = message.match(/(?:try again|retry)[^0-9]{0,20}(\d+):(\d{2}):(\d{2})/i);
  if (hms) return Number(hms[1]) * 3600 + Number(hms[2]) * 60 + Number(hms[3]);
  const unit = message.match(/(?:try again|retry)[^0-9]{0,20}(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds?|m|mins?|minutes?|h|hours?)\b/i);
  if (!unit) return undefined;
  const n = Number(unit[1]);
  const u = unit[2].toLowerCase();
  return Math.ceil(u.startsWith('h') ? n * 3600 : u.startsWith('m') ? n * 60 : n);
}

const QUOTA_RE = /quota|exceeded your (?:free )?gpu|gpu limit|out of gpu/i;
const TRANSIENT_RE =
  /no gpu was available|at capacity|queue is full|too many|concurrent|busy|timed? ?out|sleeping|is starting|building|still loading|runtime error|restarting|paused|could not allocate|connection (?:reset|refused)|econnreset|socket hang up/i;
/** When a quota message names no reset. ZeroGPU's allowance refills over the day, not at a fixed minute. */
export const DEFAULT_SPACE_QUOTA_RETRY_SEC = 3600;
const DEFAULT_SPACE_TRANSIENT_RETRY_SEC = 60;

/** Classifies a Space's error message (and HTTP status, when there was one) like any provider error. */
export function classifySpaceFailure(message: string, status?: number): ClassifiedError {
  const text = message || '';
  if (status === 429 || QUOTA_RE.test(text)) {
    const retryAfterSec = parseSpaceRetrySec(text) ?? (status === 429 ? DEFAULT_SPACE_TRANSIENT_RETRY_SEC : DEFAULT_SPACE_QUOTA_RETRY_SEC);
    return { kind: retryAfterSec >= 3600 ? 'per_day' : 'per_minute', retryAfterSec, status };
  }
  if ((status && status >= 500) || TRANSIENT_RE.test(text)) {
    return { kind: 'transient', retryAfterSec: DEFAULT_SPACE_TRANSIENT_RETRY_SEC, status };
  }
  return { kind: 'other', status };
}

function fail(message: string, status?: number): never {
  throw new SpaceError(message, classifySpaceFailure(message, status));
}

/**
 * The one error a strict caller gets after every Space in a chain failed: quota dominates and reports the earliest
 * reset, overload is a 503, and only when nothing was retryable does the first hard error surface as itself.
 */
export function reduceSpaceFailures(errors: unknown[], emptyMessage: string): unknown {
  // Non-Space errors (a Gemini image model in the same chain) are classified the Gemini way.
  const classified = errors.map((e) => ({ e, c: e instanceof SpaceError ? e.classified : classifyGeminiError(e) }));
  const retryable = classified.filter((x) => x.c.kind !== 'other').map((x) => x.c);
  if (retryable.length === 0) return classified[0]?.e ?? new Error(emptyMessage);
  if (retryable.every((c) => isQuotaKind(c.kind))) {
    const q = summarizeQuotaFailures(retryable);
    return new QuotaExhaustedError(q.kind, q.retryAfterSec, q.kind === 'zero' ? 'No provider in the chain has any quota (Gemini image models need billing).' : `Every provider in the chain is out of quota (Hugging Face GPU time); retry in ~${Math.round((q.retryAfterSec ?? 0) / 60)} min.`);
  }
  const waits = retryable.map((c) => c.retryAfterSec ?? DEFAULT_SPACE_TRANSIENT_RETRY_SEC);
  return new UpstreamUnavailableError(Math.min(...waits), 'Every provider in the chain was busy, asleep or out of GPU; retry shortly.');
}

export function hfToken(env: Env = process.env): string | undefined {
  return (env.HF_TOKEN || env.HUGGINGFACE_TOKEN || env.HUGGING_FACE_HUB_TOKEN || '').trim() || undefined;
}

function spaceHeaders(env: Env): Record<string, string> {
  const token = hfToken(env);
  return { 'User-Agent': 'ContentPipe/1.0', ...(token ? { 'x-hf-authorization': `Bearer ${token}` } : {}) };
}

const hostCache = new Map<string, string>();

/** For tests: forget resolved hosts. */
export function clearSpaceHostCache(): void {
  hostCache.clear();
}

/**
 * The Space's own origin ("https://minimaxai-minimax-h3-turbo-lora.hf.space"), asked of the Hub rather than derived
 * from the id, because the subdomain rules have edge cases. `HF_SPACE_BASE_URL` replaces all of it with
 * `{base}/{owner}/{name}` so the e2e test can stand in for every Space without the network.
 */
export async function spaceHost(spaceId: string, env: Env = process.env): Promise<string> {
  if (!SPACE_ID_RE.test(spaceId)) fail(`"${spaceId}" is not a Hugging Face Space id (owner/name)`);
  const base = env.HF_SPACE_BASE_URL?.replace(/\/+$/, '');
  if (base) return `${base}/${spaceId}`;
  const cached = hostCache.get(spaceId);
  if (cached) return cached;
  const token = hfToken(env);
  const res = await fetchWithTimeout(`https://huggingface.co/api/spaces/${spaceId}/host`, { headers: token ? { Authorization: `Bearer ${token}` } : {} }, 15000);
  if (res.status === 404) fail(`Space ${spaceId} was not found (renamed, deleted or private)`, 404);
  if (!res.ok) fail(`Could not resolve Space ${spaceId}: HTTP ${res.status}`, res.status);
  const body: any = await res.json().catch(() => ({}));
  const host = typeof body?.host === 'string' && /^https:\/\/[a-z0-9-]+\.hf\.space$/.test(body.host) ? body.host : undefined;
  if (!host) fail(`Space ${spaceId} has no usable host (${JSON.stringify(body).slice(0, 120)})`);
  hostCache.set(spaceId, host);
  return host;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Never follow a redirect: fetch strips only `Authorization` on a cross-site hop, so `x-hf-authorization`
    // would travel with it to wherever a Space (or anything in between) pointed us.
    const res = await fetch(url, { ...init, redirect: 'manual', signal: controller.signal });
    if (res.status >= 300 && res.status < 400) fail(`Refused a redirect (HTTP ${res.status}) so the token is not forwarded`, res.status);
    return res;
  } catch (err: any) {
    if (err?.name === 'AbortError') fail(`Timed out after ${Math.round(timeoutMs / 1000)}s`);
    fail(`Network error: ${err?.cause?.code || err?.message || err}`);
  } finally {
    clearTimeout(timer);
  }
}

async function errorText(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  try {
    const j = JSON.parse(text);
    return String(j?.error || j?.detail || text).slice(0, 300);
  } catch {
    return text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
  }
}

/** Uploads one file to the Space so an input can reference it by `path`. */
export async function uploadToSpace(host: string, file: SpaceFile, name: string, env: Env = process.env): Promise<GradioFileData> {
  const form = new FormData();
  form.append('files', new Blob([new Uint8Array(file.bytes)], { type: file.contentType }), name);
  const res = await fetchWithTimeout(`${host}/gradio_api/upload`, { method: 'POST', headers: spaceHeaders(env), body: form }, 60000);
  if (!res.ok) fail(`Upload failed: HTTP ${res.status} ${await errorText(res)}`, res.status);
  const paths: any = await res.json().catch(() => null);
  if (!Array.isArray(paths) || typeof paths[0] !== 'string') fail(`Upload returned no path (${JSON.stringify(paths).slice(0, 120)})`);
  return { path: paths[0], orig_name: name, mime_type: file.contentType, meta: { _type: 'gradio.FileData' } };
}

/** Parses Gradio's event stream. Returns the `complete` outputs, or throws the Space's `error`. */
export function parseGradioEvents(body: string): unknown[] {
  let lastError: string | null | undefined;
  for (const block of body.replace(/\r\n/g, '\n').split(/\n\n+/)) {
    let event = '';
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    const raw = data.join('\n');
    if (event === 'complete') {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) fail(`Space returned a non-list result (${raw.slice(0, 120)})`);
      return parsed;
    }
    if (event === 'error') {
      let msg: unknown = raw;
      try {
        msg = JSON.parse(raw);
      } catch {
        /* a bare string */
      }
      // Newer Gradio wraps it: {"error": "...", "visible": true}.
      if (msg && typeof msg === 'object' && typeof (msg as any).error === 'string') msg = (msg as any).error;
      lastError = msg == null ? null : typeof msg === 'string' ? msg.replace(/^'(.*)'$/s, '$1') : JSON.stringify(msg);
      break;
    }
  }
  if (lastError === undefined) fail('The Space closed the stream without a result');
  if (lastError) fail(lastError);
  // A null error means the Space hides its messages (show_error off). The cause is unknowable — on ZeroGPU often the
  // GPU allowance, sometimes a crash — so it is classified explicitly as transient rather than by this wording.
  throw new SpaceError('The Space failed without saying why (it hides its errors; with no HF_TOKEN this is usually the anonymous GPU allowance)', {
    kind: 'transient',
    retryAfterSec: 60,
  });
}

/** Runs one named endpoint and waits for its outputs. */
export async function callSpace(host: string, endpoint: string, data: unknown[], timeoutMs: number, env: Env = process.env): Promise<unknown[]> {
  const name = endpoint.replace(/^\/+/, '');
  if (!/^[\w-]+$/.test(name)) fail(`Bad endpoint name "${endpoint}"`);
  const t0 = Date.now();
  const start = await fetchWithTimeout(
    `${host}/gradio_api/call/${name}`,
    { method: 'POST', headers: { ...spaceHeaders(env), 'Content-Type': 'application/json' }, body: JSON.stringify({ data }) },
    60000
  );
  if (start.status === 404) fail(`The Space has no endpoint /${name} any more (its API changed)`, 404);
  if (!start.ok) fail(`HTTP ${start.status}: ${await errorText(start)}`, start.status);
  const { event_id } = (await start.json().catch(() => ({}))) as any;
  if (typeof event_id !== 'string') fail('The Space did not return an event id');
  // The whole stream (queue wait + GPU run) shares one deadline; the timer stays armed while the body is read.
  const remaining = Math.max(5000, timeoutMs - (Date.now() - t0));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), remaining);
  try {
    const stream = await fetch(`${host}/gradio_api/call/${name}/${encodeURIComponent(event_id)}`, { headers: spaceHeaders(env), redirect: 'manual', signal: controller.signal });
    if (stream.status >= 300 && stream.status < 400) fail(`Refused a redirect (HTTP ${stream.status}) so the token is not forwarded`, stream.status);
    if (!stream.ok) fail(`HTTP ${stream.status}: ${await errorText(stream)}`, stream.status);
    return parseGradioEvents(await stream.text());
  } catch (err: any) {
    if (err instanceof SpaceError) throw err;
    if (err?.name === 'AbortError') fail(`Timed out after ${Math.round(timeoutMs / 1000)}s (queue + generation)`);
    fail(`Stream broke: ${err?.cause?.code || err?.message || err}`);
  } finally {
    clearTimeout(timer);
  }
}

/** The endpoint list, for the generic adapter. */
export async function spaceApiInfo(host: string, env: Env = process.env): Promise<any> {
  const res = await fetchWithTimeout(`${host}/gradio_api/info`, { headers: spaceHeaders(env) }, 30000);
  if (!res.ok) fail(`Could not read the Space's API: HTTP ${res.status}`, res.status);
  return res.json();
}

/**
 * Downloads an output file. Only from the Space's own origin: the URL comes from the Space's response, and this
 * server must not be steered into fetching anything else with the token attached.
 */
export async function downloadSpaceFile(host: string, output: unknown, timeoutMs: number, env: Env = process.env): Promise<SpaceFile> {
  const file = fileRef(output);
  if (!file) fail(`The Space returned no file (${JSON.stringify(output).slice(0, 160)})`);
  const url = file.url || `${host}/gradio_api/file=${file.path}`;
  let parsed: URL;
  try {
    parsed = new URL(url, host);
  } catch {
    fail(`Unusable file URL from the Space: ${url.slice(0, 120)}`);
  }
  if (parsed.origin !== new URL(host).origin) fail(`Refused a file URL on another host (${parsed.origin})`);
  const res = await fetchWithTimeout(parsed.toString(), { headers: spaceHeaders(env) }, timeoutMs);
  if (!res.ok) fail(`File download failed: HTTP ${res.status}`, res.status);
  return { bytes: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get('content-type') || '' };
}

/** A FileData, a {video: FileData} wrapper (gr.Video), or a gallery item {image: FileData}. */
export function fileRef(output: unknown): { path?: string; url?: string } | undefined {
  if (!output || typeof output !== 'object') return undefined;
  const o = output as any;
  if (typeof o.url === 'string' || typeof o.path === 'string') return { path: o.path, url: o.url };
  for (const key of ['video', 'image', 'value']) if (o[key]) return fileRef(o[key]);
  if (Array.isArray(o) && o.length) return fileRef(o[0]);
  return undefined;
}

/** Decodes a `data:` URL, the shape /api/generate-image returns. */
export function decodeDataUrl(dataUrl: string): SpaceFile | undefined {
  const m = /^data:([\w/+.-]+);base64,(.+)$/s.exec(dataUrl || '');
  if (!m) return undefined;
  return { contentType: m[1], bytes: Buffer.from(m[2], 'base64') };
}
