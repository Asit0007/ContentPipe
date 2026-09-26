import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { attemptOutcome } from './gemini';
import { SpaceError, decodeDataUrl, reduceSpaceFailures } from './hfSpace';
import { noteModelAttempt, trackModelCall, withModelTask } from './llm/usage';
import { coolSpace, runSpace, spaceCooldown, videoProviderOrder } from './mediaOrder';
import { badOutput, sniffImage, sniffVideo, videoAdapter } from './spaceAdapters';

/**
 * Scene still + motion prompt -> a short AI video clip, through the Hugging Face Spaces in VIDEO_PROVIDER_ORDER
 * (default MiniMax-H3 Turbo, then Wan 2.2). There is no fallback clip of any kind: a video either came from a
 * listed model or the call fails — in the UI as an error message, for a strict caller as 429 / 503 / 502.
 *
 * Clips are written to `renders/clips/` (gitignored) and served from /clips/, because GPU time is the scarce thing
 * here (a free token gets a few ZeroGPU minutes a day) and a clip must never be lost to a page reload.
 */

export interface VideoRequest {
  /** The scene still, as the `data:` URL /api/generate-image returns. */
  imageUrl: string;
  /** What moves — the scene's motionPrompt. */
  prompt: string;
  durationSec: number;
  aspectRatio: string;
}

export interface VideoResult {
  videoUrl: string;
  file: string;
  provider: 'hf';
  providerLabel: string;
  model: string;
  /** What the model was actually asked for, after its own limits (Wan 2.2 stops at 5 s). */
  durationSec?: number;
  requestedDurationSec: number;
  hasAudio: boolean;
  bytes: number;
  attempts: Array<{ provider: 'hf'; model: string; error: string }>;
}

export class VideoInputError extends Error {}

const SPACE_VIDEO_TIMEOUT_MS = 10 * 60_000;

export function clipsDir(env: Record<string, string | undefined> = process.env): string {
  return path.join(env.CONTENTPIPE_RENDERS_DIR || path.join(process.cwd(), 'renders'), 'clips');
}

export function generateSceneVideo(req: VideoRequest, env: Record<string, string | undefined> = process.env): Promise<VideoResult> {
  return withModelTask(`Scene clip (${req.aspectRatio}, ${req.durationSec}s)`, () => trackModelCall('video', () => videoChain(req, env)));
}

async function videoChain(req: VideoRequest, env: Record<string, string | undefined>): Promise<VideoResult> {
  const image = decodeDataUrl(req.imageUrl);
  if (!image || !sniffImage(image.bytes)) {
    throw new VideoInputError('imageUrl must be a data: URL of a PNG, JPEG or WebP still (an SVG placeholder cannot be animated)');
  }
  image.contentType = sniffImage(image.bytes)!;

  const attempts: VideoResult['attempts'] = [];
  const causes: unknown[] = [];
  for (const { model: spaceId } of videoProviderOrder(env)) {
    const cool = spaceCooldown(spaceId);
    if (cool) {
      noteModelAttempt({ provider: 'hf', model: spaceId, outcome: 'skipped', detail: `cooling down after: ${cool.reason}` });
      attempts.push({ provider: 'hf', model: spaceId, error: `cooling down after: ${cool.reason}` });
      causes.push(new SpaceError(cool.reason, cool.classified));
      continue;
    }
    const t0 = Date.now();
    const adapter = videoAdapter(spaceId);
    try {
      const { file, call } = await runSpace(spaceId, adapter, { ...req, image }, SPACE_VIDEO_TIMEOUT_MS, env);
      const mime = sniffVideo(file.bytes);
      if (!mime) throw badOutput('a video', file.bytes, file.contentType);
      noteModelAttempt({ provider: 'hf', model: spaceId, outcome: 'ok', ms: Date.now() - t0 });
      const saved = await saveClip(file.bytes, mime, spaceId, env);
      return {
        videoUrl: `/clips/${saved}`,
        file: path.join(clipsDir(env), saved),
        provider: 'hf',
        providerLabel: 'Hugging Face',
        model: spaceId,
        durationSec: call.durationSec,
        requestedDurationSec: req.durationSec,
        hasAudio: !!adapter.hasAudio,
        bytes: file.bytes.length,
        attempts,
      };
    } catch (err: any) {
      const e = err instanceof SpaceError ? err : new SpaceError(String(err?.message || err), { kind: 'other' });
      coolSpace(spaceId, e);
      noteModelAttempt({ provider: 'hf', model: spaceId, outcome: attemptOutcome(e.classified.kind), detail: e.message, ms: Date.now() - t0 });
      console.warn(`[Video Agent] Space ${spaceId}: ${e.message}`);
      attempts.push({ provider: 'hf', model: spaceId, error: e.message });
      causes.push(e);
    }
  }
  const why = attempts.map((a) => `${a.model}: ${a.error}`).join('; ');
  const reduced: any = reduceSpaceFailures(causes, 'No video provider is configured');
  if (reduced && typeof reduced === 'object' && 'message' in reduced) reduced.message = `${reduced.message} (${why})`;
  throw reduced;
}

async function saveClip(bytes: Buffer, mime: string, spaceId: string, env: Record<string, string | undefined>): Promise<string> {
  const dir = clipsDir(env);
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const slug = spaceId.split('/')[1].toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30);
  const name = `${stamp}-${slug}-${createHash('sha256').update(bytes).digest('hex').slice(0, 8)}.${mime === 'video/webm' ? 'webm' : 'mp4'}`;
  await writeFile(path.join(dir, name), bytes);
  return name;
}
