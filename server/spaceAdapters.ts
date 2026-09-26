import { SpaceError, classifySpaceFailure, type GradioFileData, type SpaceFile } from './hfSpace';

/**
 * How to call each Hugging Face Space the image and video chains use: which endpoint, what goes in each positional
 * slot, which output is the file. Signatures were read from each Space's /gradio_api/info and app.py on 2026-09-26.
 *
 * A Space with no entry here still works through `genericAdapter`, which reads the Space's API and fills parameters
 * by name. That is what makes "switch to the next Space" an .env edit (IMAGE_PROVIDER_ORDER / VIDEO_PROVIDER_ORDER)
 * rather than a code change — but a named adapter is the tested path; add one when a Space becomes a regular.
 */

export interface ImageJob {
  prompt: string;
  aspectRatio: string;
}

export interface VideoJob {
  prompt: string;
  image: SpaceFile;
  durationSec: number;
  aspectRatio: string;
}

export interface AdapterContext {
  upload(file: SpaceFile, name: string): Promise<GradioFileData>;
  apiInfo(): Promise<any>;
}

export interface SpaceCall {
  endpoint: string;
  data: unknown[];
  /** Which output holds the file. */
  outputIndex: number;
  /** What the clip will actually be after the Space's own limits, when it clamps. */
  durationSec?: number;
}

export interface SpaceAdapter<J> {
  /** Human name of the model behind the Space, for the provenance panel. */
  model: string;
  build(job: J, ctx: AdapterContext): Promise<SpaceCall>;
  /** The model's output carries its own soundtrack. */
  hasAudio?: boolean;
}

const randomSeed = () => Math.floor(Math.random() * 2_147_483_647);
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number.isFinite(n) ? n : lo));
const VIDEO_NEGATIVE = 'static frame, frozen, blurry, low quality, subtitles, captions, on-screen text, watermark, logo, deformed hands, distorted faces, flicker';

// ── Images ────────────────────────────────────────────────────────────────────────────────────────────────────────

export const IMAGE_ADAPTERS: Record<string, SpaceAdapter<ImageJob>> = {
  // Qwen-Image-2512, Apache 2.0 (commercial use allowed). The official Qwen Space, ZeroGPU.
  'Qwen/Qwen-Image-2512': {
    model: 'Qwen-Image-2512',
    async build(job) {
      const ratios = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'];
      return {
        endpoint: '/infer',
        // prompt, seed, randomize_seed, aspect_ratio, guidance_scale, num_inference_steps, prompt_enhance.
        // prompt_enhance off: our layered prompts are already specific, and a rewrite would drift from the
        // character/style anchors the script enforces.
        data: [job.prompt, 0, true, ratios.includes(job.aspectRatio) ? job.aspectRatio : '16:9', 4.0, 50, false],
        outputIndex: 0,
      };
    },
  },
  // HiDream-O1-Image, MIT. The Space runs on CPU and forwards to HiDream's own GPUs, so it spends no ZeroGPU quota.
  'HiDream-ai/HiDream-O1-Image': {
    model: 'HiDream-O1-Image',
    async build(job) {
      const ratios = ['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3', '21:9'];
      return {
        endpoint: '/_generate_wrapped',
        // prompt, ratio, negative prompt, prompt refine (off, same reason as above), seed (-1 = random), guidance.
        data: [job.prompt, ratios.includes(job.aspectRatio) ? job.aspectRatio : '16:9', 'text, watermark, logo, low quality, blurry', false, -1, 5.0],
        outputIndex: 0,
      };
    },
  },
};

// ── Video (image to video) ───────────────────────────────────────────────────────────────────────────────────────

/** MiniMax-H3's canvases ("fast" ones cost the least GPU); the label itself goes over the wire. */
const H3_CANVAS: Record<string, string> = {
  '16:9': '960x544 · 16:9 fast',
  '9:16': '544x960 · 9:16 fast',
  '1:1': '544x544 · 1:1 fast',
  '4:3': '768x576 · 4:3 fast',
  '3:4': '576x768 · 3:4 fast',
};

export const VIDEO_ADAPTERS: Record<string, SpaceAdapter<VideoJob>> = {
  // MiniMax-H3 with a 6-step turbo LoRA; video plus a synchronized soundtrack. MiniMax's official Space.
  // Licence: MiniMax H3 Community License — commercial use allowed under $20M/yr revenue, and "MiniMax H3" must be
  // displayed where the output is used (a credit in the video description).
  'MiniMaxAI/MiniMax-H3-Turbo-Lora': {
    model: 'MiniMax-H3 Turbo LoRA',
    hasAudio: true,
    async build(job, ctx) {
      const first = await ctx.upload(job.image, `first-frame.${extFor(job.image.contentType)}`);
      const durationSec = clamp(job.durationSec, 2, 14); // the Space's MIN/MAX_UI_DURATION
      return {
        endpoint: '/output_video',
        // prompt, first frame, last frame, canvas, duration, steps, seed, upsample (prompt rewrite: off), LoRA.
        data: [job.prompt, first, null, H3_CANVAS[job.aspectRatio] || H3_CANVAS['16:9'], durationSec, 6, randomSeed(), false, 'larry'],
        outputIndex: 0,
        durationSec,
      };
    },
  },
  // Wan 2.2 I2V A14B, Apache 2.0. Hugging Face's own ZeroGPU showcase Space (fp8, AoT-compiled, 16 fps).
  'zerogpu-aoti/wan2-2-fp8da-aoti-faster': {
    model: 'Wan 2.2 14B (I2V)',
    async build(job, ctx) {
      const image = await ctx.upload(job.image, `input.${extFor(job.image.contentType)}`);
      const durationSec = clamp(job.durationSec, 1, 5); // 80 frames at 16 fps
      return {
        endpoint: '/generate_video',
        // image, prompt, steps, negative, duration, guidance, guidance 2, seed, randomize seed.
        data: [image, job.prompt, 6, VIDEO_NEGATIVE, durationSec, 1, 1, 42, true],
        outputIndex: 0,
        durationSec,
      };
    },
  },
};

function extFor(contentType: string): string {
  if (/jpe?g/.test(contentType)) return 'jpg';
  if (/webp/.test(contentType)) return 'webp';
  return 'png';
}

// ── Any other Space ──────────────────────────────────────────────────────────────────────────────────────────────

interface InfoParam {
  parameter_name?: string;
  label?: string;
  parameter_has_default?: boolean;
  parameter_default?: unknown;
  python_type?: { type?: string };
  type?: any;
}

const isFileType = (t: string) => /filepath|dict\(path/i.test(t);
const PROMPT_NAME = /^(?:prompt|text|caption|positive|original_prompt|prompt_value|in_0)$|prompt/i;

/**
 * Reads the Space's API and fills its parameters by name: the prompt, the image (video only), aspect ratio,
 * duration, a random seed; every other parameter keeps the Space's own default. Refuses — rather than guessing — when
 * a parameter it cannot name has no default, so a mismatch surfaces as "needs an adapter" instead of a garbage call.
 */
export function genericAdapter<J extends ImageJob | VideoJob>(spaceId: string, kind: 'image' | 'video'): SpaceAdapter<J> {
  return {
    model: spaceId.split('/')[1],
    async build(job, ctx) {
      const info = await ctx.apiInfo();
      const endpoints = Object.entries<any>(info?.named_endpoints || {});
      const pick = endpoints.find(([, ep]) => {
        const params: InfoParam[] = ep?.parameters || [];
        const returnsFile = (ep?.returns || []).some((r: InfoParam) => isFileType(String(r?.python_type?.type || '')));
        const hasPrompt = params.some((p) => PROMPT_NAME.test(p.parameter_name || '') && /str/.test(String(p.python_type?.type)));
        const hasImage = params.some((p) => isFileType(String(p.python_type?.type || '')));
        return returnsFile && hasPrompt && (kind === 'image' || hasImage);
      });
      if (!pick) throw new SpaceError(`Space ${spaceId} has no endpoint that takes a prompt${kind === 'video' ? ' and an image' : ''} and returns a file; it needs an adapter in server/spaceAdapters.ts`, { kind: 'other' });
      const [endpoint, ep] = pick;
      let usedPrompt = false;
      let usedImage = false;
      const data: unknown[] = [];
      for (const p of ep.parameters as InfoParam[]) {
        const name = (p.parameter_name || p.label || '').toLowerCase();
        const type = String(p.python_type?.type || '');
        if (!usedPrompt && PROMPT_NAME.test(name) && /str/.test(type) && !/negative/.test(name)) {
          data.push(job.prompt);
          usedPrompt = true;
        } else if (kind === 'video' && !usedImage && isFileType(type) && !/last|end/.test(name)) {
          data.push(await ctx.upload((job as VideoJob).image, 'input.png'));
          usedImage = true;
        } else if (/aspect|ratio/.test(name) && type.includes(`'${job.aspectRatio}'`)) {
          data.push(job.aspectRatio);
        } else if (kind === 'video' && /duration|seconds/.test(name) && /float|int/.test(type)) {
          data.push((job as VideoJob).durationSec);
        } else if (/randomize/.test(name) && /bool/.test(type)) {
          data.push(true);
        } else if (p.parameter_has_default) {
          data.push(p.parameter_default ?? null);
        } else if (/None/.test(type)) {
          data.push(null);
        } else {
          throw new SpaceError(`Space ${spaceId}: cannot fill parameter "${p.parameter_name}" (${type.slice(0, 60)}); it needs an adapter in server/spaceAdapters.ts`, { kind: 'other' });
        }
      }
      if (!usedPrompt) throw new SpaceError(`Space ${spaceId}: found no prompt parameter`, { kind: 'other' });
      const outputIndex = Math.max(0, (ep.returns || []).findIndex((r: InfoParam) => isFileType(String(r?.python_type?.type || ''))));
      return { endpoint, data, outputIndex };
    },
  };
}

export function imageAdapter(spaceId: string): SpaceAdapter<ImageJob> {
  return IMAGE_ADAPTERS[spaceId] || genericAdapter<ImageJob>(spaceId, 'image');
}

export function videoAdapter(spaceId: string): SpaceAdapter<VideoJob> {
  return VIDEO_ADAPTERS[spaceId] || genericAdapter<VideoJob>(spaceId, 'video');
}

// ── Checking what came back ───────────────────────────────────────────────────────────────────────────────────────

/** The real image type by magic bytes, or undefined — a Space can hand back an HTML error page as "the file". */
export function sniffImage(bytes: Buffer): string | undefined {
  if (bytes.length < 1024) return undefined;
  if (bytes[0] === 0x89 && bytes.toString('latin1', 1, 4) === 'PNG') return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return undefined;
}

export function sniffVideo(bytes: Buffer): string | undefined {
  if (bytes.length < 4096) return undefined;
  if (bytes.toString('latin1', 4, 8) === 'ftyp') return 'video/mp4';
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return 'video/webm';
  return undefined;
}

/** A body that is not what it claims is the Space misbehaving, not our input: treat it as a transient failure. */
export function badOutput(what: string, bytes: Buffer, contentType: string): SpaceError {
  const msg = `The Space returned something that is not ${what} (${contentType || 'no content-type'}, ${bytes.length} bytes)`;
  return new SpaceError(msg, { ...classifySpaceFailure(''), kind: 'transient', retryAfterSec: 60 });
}
