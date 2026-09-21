import { execFile } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { buildCaptions, renderSrt } from './captions';

const execFileAsync = promisify(execFile);

/**
 * Scene stills + narration audio -> one MP4, with ffmpeg as a local subprocess.
 *
 * Two rules shape everything here:
 *
 * 1. **Refuse, don't degrade.** /api/tts and /api/generate-image both degrade to canned
 *    output (a synthesized tone, an SVG placeholder) so the UI never dead-ends. That is right
 *    for a browser and wrong for a render: the tone would be published as narration. Every
 *    input is validated before any encoding starts, all problems are collected, and a single
 *    bad scene fails the whole render with the full list.
 *
 * 2. **Audio is assembled once, in Node, sample-accurately.** Encoding AAC per scene and
 *    concatenating adds encoder delay at every join, which accumulates into audible drift over
 *    a 9-minute video. Instead each scene's PCM is padded with silence to a whole number of
 *    video frames, all of it is joined into one PCM stream, and that is muxed against the
 *    concatenated (stream-copied) video segments with a single AAC encode. The durations in
 *    the result are therefore the real timeline, which is what chapters and mid-roll markers
 *    need — not the model's `durationEst`.
 *
 * ffmpeg is spawned with an argument array (no shell): image bytes and paths come from
 * generated content. This build has no `drawtext`/`subtitles` filter, so nothing here burns
 * text into the picture; English captions are written as a sidecar SRT instead (server/captions.ts).
 */

export type AssemblyAspect = '16:9' | '9:16';

export interface AssemblySceneInput {
  id: string;
  /** `data:image/(png|jpeg|webp);base64,...` — what /api/generate-image returns. */
  imageUrl: string;
  /** From the image response; a placeholder is never rendered. */
  imageIsPlaceholder?: boolean;
  /** Base64 audio from /api/tts: raw 16-bit little-endian mono PCM, or a 16-bit mono PCM WAV. */
  audioBase64: string;
  /** Sample rate of raw PCM. Ignored for WAV (the header wins). Gemini TTS is 24000. */
  audioSampleRate?: number;
  /**
   * What the narration says, verbatim, for the sidecar SRT. All scenes or none: a caption track with holes
   * is worse than none, so a partial set is refused.
   */
  captionText?: string;
  /** From the TTS response (`isQuotaFallback`); synthesized filler is never rendered. */
  audioIsFallback?: boolean;
}

export interface AssemblyOptions {
  aspectRatio?: AssemblyAspect;
  /** Override the frame size (tests render tiny). Default 1920x1080 / 1080x1920. */
  width?: number;
  height?: number;
  fps?: number;
  /** Silence after each scene's narration. */
  gapSec?: number;
  /** Extra hold on the last scene. */
  tailSec?: number;
  /** Slow push-in / pull-out on each still, alternating per scene. */
  zoom?: boolean;
  /** Input oversampling for the zoom; higher is smoother and slower. */
  zoomOversample?: number;
  normalizeLoudness?: boolean;
  outDir?: string;
  name?: string;
  ffmpegPath?: string;
  ffprobePath?: string;
  onProgress?: (done: number, total: number) => void;
}

export interface SceneTiming {
  id: string;
  /** Where this scene starts in the finished video. */
  startSec: number;
  /** Length of the narration itself. */
  audioSec: number;
  /** Narration plus the trailing gap, rounded up to whole frames. */
  durationSec: number;
  frames: number;
}

export interface AssemblyResult {
  file: string;
  bytes: number;
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  scenes: SceneTiming[];
  /** Wall-clock time spent encoding. */
  elapsedMs: number;
  /** Sidecar English captions, written next to the MP4 when the scenes carried `captionText`. */
  captions?: { file: string; cues: number };
}

export type AssemblyProblemCode =
  | 'missing_image'
  | 'placeholder_image'
  | 'unsupported_image'
  | 'missing_audio'
  | 'missing_caption'
  | 'fallback_audio'
  | 'unsupported_audio'
  | 'audio_too_short'
  | 'sample_rate_mismatch';

export interface AssemblyProblem {
  sceneId: string;
  code: AssemblyProblemCode;
  message: string;
}

export class AssemblyInputError extends Error {
  problems: AssemblyProblem[];
  constructor(problems: AssemblyProblem[]) {
    const head = problems.slice(0, 3).map((p) => `${p.sceneId}: ${p.message}`).join('; ');
    super(`Refusing to render: ${problems.length} problem${problems.length === 1 ? '' : 's'} in the inputs (${head}${problems.length > 3 ? '; ...' : ''})`);
    this.name = 'AssemblyInputError';
    this.problems = problems;
  }
}

export class AssemblyEncodeError extends Error {
  stderr: string;
  constructor(message: string, stderr = '') {
    super(message);
    this.name = 'AssemblyEncodeError';
    this.stderr = stderr;
  }
}

export const RENDERS_DIR = process.env.CONTENTPIPE_RENDERS_DIR
  ? path.resolve(process.env.CONTENTPIPE_RENDERS_DIR)
  : path.resolve(process.cwd(), 'renders');

const MIN_AUDIO_SEC = 0.5;
const DEFAULT_FPS = 30;
const DEFAULT_GAP_SEC = 0.35;
const DEFAULT_TAIL_SEC = 0.8;
const ZOOM_TOTAL = 0.06; // 6% over the scene: perceptible drift, not a lurch
const LOUDNESS_FILTER = 'loudnorm=I=-14:TP=-1.5:LRA=11';

// ---------------------------------------------------------------------------
// Decoding — pure, so the refusal rules are testable without ffmpeg.
// ---------------------------------------------------------------------------

// Plain result shape rather than a union: this repo runs with strictNullChecks off, under which
// TS does not narrow on a literal discriminant.
interface Decoded<T> {
  value?: T;
  problem?: { code: AssemblyProblemCode; message: string };
}

export function sniffImage(buf: Buffer): 'png' | 'jpg' | 'webp' | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}

export function decodeImageDataUrl(url: string): Decoded<{ bytes: Buffer; ext: 'png' | 'jpg' | 'webp' }> {
  const m = /^data:([^;,]*)(?:;[^,]*)?;base64,(.*)$/s.exec(url || '');
  if (!m) return { problem: { code: 'missing_image', message: 'no base64 data: URL image' } };
  const bytes = Buffer.from(m[2], 'base64');
  // Trust the bytes, not the label — Pollinations has answered 200 with an HTML error body before.
  const ext = sniffImage(bytes);
  if (!ext) {
    return { problem: { code: 'unsupported_image', message: `image is not PNG, JPEG or WebP (declared ${m[1] || 'no type'}, ${bytes.length} bytes)` } };
  }
  return { value: { bytes, ext } };
}

export interface DecodedAudio {
  pcm: Buffer;
  sampleRate: number;
}

/** Raw s16le mono PCM as-is, or a 16-bit mono PCM WAV with its header stripped. */
export function decodeAudioBase64(b64: string, fallbackRate = 24000): Decoded<DecodedAudio> {
  const buf = Buffer.from(b64 || '', 'base64');
  if (buf.length === 0) return { problem: { code: 'missing_audio', message: 'no audio data' } };

  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WAVE') {
    let offset = 12;
    let fmt: { tag: number; channels: number; rate: number; bits: number } | null = null;
    while (offset + 8 <= buf.length) {
      const id = buf.toString('latin1', offset, offset + 4);
      const size = buf.readUInt32LE(offset + 4);
      const body = offset + 8;
      if (id === 'fmt ' && body + 16 <= buf.length) {
        fmt = { tag: buf.readUInt16LE(body), channels: buf.readUInt16LE(body + 2), rate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
      } else if (id === 'data') {
        if (!fmt || fmt.tag !== 1 || fmt.channels !== 1 || fmt.bits !== 16) {
          return { problem: { code: 'unsupported_audio', message: 'WAV must be 16-bit mono PCM' } };
        }
        // A streamed WAV can declare a data size larger than what was written.
        const end = Math.min(body + size, buf.length);
        return { value: { pcm: buf.subarray(body, end - ((end - body) % 2)), sampleRate: fmt.rate } };
      }
      offset = body + size + (size % 2);
    }
    return { problem: { code: 'unsupported_audio', message: 'WAV has no data chunk' } };
  }

  if (buf.length % 2 !== 0) {
    return { problem: { code: 'unsupported_audio', message: `raw PCM has an odd byte count (${buf.length}); expected 16-bit samples` } };
  }
  return { value: { pcm: buf, sampleRate: fallbackRate } };
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

/**
 * Each scene lasts its narration plus a gap, rounded up to whole frames so every video segment is
 * an exact frame count and the padded audio can be cut to the same length.
 */
export function planTimeline(
  scenes: Array<{ id: string; audioSec: number }>,
  fps: number,
  gapSec: number,
  tailSec: number
): SceneTiming[] {
  let start = 0;
  return scenes.map((s, i) => {
    const hold = gapSec + (i === scenes.length - 1 ? tailSec : 0);
    const frames = Math.max(1, Math.ceil((s.audioSec + hold) * fps - 1e-9));
    const timing: SceneTiming = { id: s.id, startSec: start, audioSec: s.audioSec, durationSec: frames / fps, frames };
    start += timing.durationSec;
    return timing;
  });
}

/** PCM for one scene, silence-padded (or trimmed) to exactly its frame-aligned length. */
export function padPcm(pcm: Buffer, sampleRate: number, durationSec: number): Buffer {
  const samples = Math.round(durationSec * sampleRate);
  const out = Buffer.alloc(samples * 2); // zero-filled = silence
  pcm.copy(out, 0, 0, Math.min(pcm.length, out.length));
  return out;
}

// ---------------------------------------------------------------------------
// ffmpeg argument builders — no process spawned, so they are unit-testable.
// ---------------------------------------------------------------------------

export function buildSegmentArgs(o: {
  image: string;
  out: string;
  frames: number;
  fps: number;
  width: number;
  height: number;
  zoom: 'in' | 'out' | 'none';
  oversample?: number;
}): string[] {
  const { width: w, height: h, fps, frames } = o;
  const cover = (cw: number, ch: number) => `scale=${cw}:${ch}:force_original_aspect_ratio=increase,crop=${cw}:${ch}`;
  let vf: string;
  if (o.zoom === 'none') {
    vf = `${cover(w, h)},setsar=1`;
  } else {
    const k = o.oversample ?? 2;
    // `on` is the output frame index; the expression is linear so the move is constant-speed.
    const z = o.zoom === 'in' ? `1+${ZOOM_TOTAL}*on/${frames}` : `${1 + ZOOM_TOTAL}-${ZOOM_TOTAL}*on/${frames}`;
    vf = `${cover(w * k, h * k)},zoompan=z='${z}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${w}x${h}:fps=${fps},setsar=1`;
  }
  return [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-loop', '1', '-framerate', String(fps), '-i', o.image,
    '-vf', vf,
    '-frames:v', String(frames), '-r', String(fps), '-an',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-g', String(fps * 2),
    o.out,
  ];
}

export function buildMuxArgs(o: { concatList: string; pcm: string; sampleRate: number; out: string; normalizeLoudness: boolean }): string[] {
  return [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'concat', '-safe', '0', '-i', o.concatList,
    '-f', 's16le', '-ar', String(o.sampleRate), '-ac', '1', '-i', o.pcm,
    '-map', '0:v:0', '-map', '1:a:0',
    '-c:v', 'copy',
    ...(o.normalizeLoudness ? ['-af', LOUDNESS_FILTER] : []),
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
    '-movflags', '+faststart',
    o.out,
  ];
}

function concatListLine(file: string): string {
  return `file '${file.replace(/'/g, `'\\''`)}'`;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function dimsFor(opts: AssemblyOptions): { width: number; height: number } {
  if (opts.width && opts.height) return { width: opts.width, height: opts.height };
  return opts.aspectRatio === '9:16' ? { width: 1080, height: 1920 } : { width: 1920, height: 1080 };
}

function slugify(s: string): string {
  return (s || 'video').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'video';
}

async function run(bin: string, args: string[], what: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(bin, args, { maxBuffer: 32 * 1024 * 1024 });
    return stdout;
  } catch (err: any) {
    if (err?.code === 'ENOENT') throw new AssemblyEncodeError(`${bin} not found — install ffmpeg (brew install ffmpeg)`);
    const stderr = String(err?.stderr || '').trim();
    throw new AssemblyEncodeError(`${what} failed: ${stderr.split('\n').slice(-3).join(' | ') || err?.message}`, stderr.slice(-4000));
  }
}

export interface ProbeResult {
  durationSec: number;
  videoStreams: number;
  audioStreams: number;
  width: number;
  height: number;
}

export async function probeMedia(file: string, ffprobePath = 'ffprobe'): Promise<ProbeResult> {
  const out = await run(ffprobePath, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', file], 'ffprobe');
  const j = JSON.parse(out);
  const streams: any[] = j.streams || [];
  const video = streams.find((s) => s.codec_type === 'video');
  return {
    durationSec: Number(j.format?.duration) || 0,
    videoStreams: streams.filter((s) => s.codec_type === 'video').length,
    audioStreams: streams.filter((s) => s.codec_type === 'audio').length,
    width: Number(video?.width) || 0,
    height: Number(video?.height) || 0,
  };
}

/** Everything that can be refused is refused here, before a single frame is encoded. */
export function validateScenes(scenes: AssemblySceneInput[]): {
  problems: AssemblyProblem[];
  prepared: Array<{ input: AssemblySceneInput; image: { bytes: Buffer; ext: string }; audio: DecodedAudio }>;
} {
  const problems: AssemblyProblem[] = [];
  const prepared: Array<{ input: AssemblySceneInput; image: { bytes: Buffer; ext: string }; audio: DecodedAudio }> = [];
  let rate: number | null = null;
  const captioned = scenes.filter((s) => (s.captionText || '').trim()).length;

  scenes.forEach((s, i) => {
    const id = s.id || `scene-${i + 1}`;
    const fail = (code: AssemblyProblemCode, message: string) => problems.push({ sceneId: id, code, message });
    let ok = true;

    if (captioned > 0 && !(s.captionText || '').trim()) {
      fail('missing_caption', `no caption text, though ${captioned} of ${scenes.length} scenes have it`);
      ok = false;
    }

    if (s.imageIsPlaceholder) {
      fail('placeholder_image', 'the image is a generated placeholder, not artwork');
      ok = false;
    }
    const img = s.imageIsPlaceholder ? null : decodeImageDataUrl(s.imageUrl);
    if (img?.problem) {
      fail(img.problem.code, img.problem.message);
      ok = false;
    }

    if (s.audioIsFallback) {
      fail('fallback_audio', 'the audio is the synthesized quota-fallback tone, not narration');
      ok = false;
    }
    const aud = s.audioIsFallback ? null : decodeAudioBase64(s.audioBase64, s.audioSampleRate || 24000);
    if (aud?.problem) {
      fail(aud.problem.code, aud.problem.message);
      ok = false;
    } else if (aud?.value) {
      const sec = aud.value.pcm.length / 2 / aud.value.sampleRate;
      if (sec < MIN_AUDIO_SEC) {
        fail('audio_too_short', `narration is ${sec.toFixed(2)}s; under ${MIN_AUDIO_SEC}s means the TTS call returned almost nothing`);
        ok = false;
      }
      if (rate === null) rate = aud.value.sampleRate;
      else if (aud.value.sampleRate !== rate) {
        fail('sample_rate_mismatch', `sample rate ${aud.value.sampleRate} differs from the ${rate} used by earlier scenes`);
        ok = false;
      }
    }

    if (ok && img?.value && aud?.value) prepared.push({ input: { ...s, id }, image: img.value, audio: aud.value });
  });

  return { problems, prepared };
}

export async function assembleVideo(scenes: AssemblySceneInput[], opts: AssemblyOptions = {}): Promise<AssemblyResult> {
  if (!Array.isArray(scenes) || scenes.length === 0) {
    throw new AssemblyInputError([{ sceneId: '(none)', code: 'missing_image', message: 'no scenes to render' }]);
  }
  const { problems, prepared } = validateScenes(scenes);
  if (problems.length > 0) throw new AssemblyInputError(problems);

  const started = Date.now();
  const ffmpeg = opts.ffmpegPath || 'ffmpeg';
  const fps = opts.fps || DEFAULT_FPS;
  const { width, height } = dimsFor(opts);
  const rate = prepared[0].audio.sampleRate;
  const timeline = planTimeline(
    prepared.map((p) => ({ id: p.input.id, audioSec: p.audio.pcm.length / 2 / rate })),
    fps,
    opts.gapSec ?? DEFAULT_GAP_SEC,
    opts.tailSec ?? DEFAULT_TAIL_SEC
  );

  const outDir = opts.outDir ? path.resolve(opts.outDir) : RENDERS_DIR;
  await fs.mkdir(outDir, { recursive: true });
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'contentpipe-render-'));
  try {
    const segments: string[] = [];
    for (let i = 0; i < prepared.length; i++) {
      const image = path.join(work, `img-${i}.${prepared[i].image.ext}`);
      const segment = path.join(work, `seg-${i}.mp4`);
      await fs.writeFile(image, prepared[i].image.bytes);
      const zoom = opts.zoom === false ? 'none' : i % 2 === 0 ? 'in' : 'out';
      await run(ffmpeg, buildSegmentArgs({ image, out: segment, frames: timeline[i].frames, fps, width, height, zoom, oversample: opts.zoomOversample }), `encoding scene ${prepared[i].input.id}`);
      segments.push(segment);
      opts.onProgress?.(i + 1, prepared.length);
    }

    const pcmFile = path.join(work, 'narration.pcm');
    await fs.writeFile(pcmFile, Buffer.concat(prepared.map((p, i) => padPcm(p.audio.pcm, rate, timeline[i].durationSec))));
    const listFile = path.join(work, 'segments.txt');
    await fs.writeFile(listFile, segments.map(concatListLine).join('\n') + '\n');

    // Written under a temp name and renamed after it verifies, so a half-written file never has the final name.
    const partial = path.join(work, 'out.mp4');
    await run(ffmpeg, buildMuxArgs({ concatList: listFile, pcm: pcmFile, sampleRate: rate, out: partial, normalizeLoudness: opts.normalizeLoudness !== false }), 'muxing');

    const expected = timeline.reduce((n, t) => n + t.durationSec, 0);
    const probe = await probeMedia(partial, opts.ffprobePath);
    const problem =
      probe.videoStreams !== 1 || probe.audioStreams !== 1 ? `expected 1 video + 1 audio stream, got ${probe.videoStreams} + ${probe.audioStreams}`
      : probe.width !== width || probe.height !== height ? `expected ${width}x${height}, got ${probe.width}x${probe.height}`
      : Math.abs(probe.durationSec - expected) > 0.25 ? `expected ${expected.toFixed(2)}s, got ${probe.durationSec.toFixed(2)}s`
      : null;
    if (problem) throw new AssemblyEncodeError(`Rendered file failed verification: ${problem}`);

    const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
    const file = path.join(outDir, `${slugify(opts.name || 'video')}-${stamp}.mp4`);
    await fs.copyFile(partial, file);
    const { size } = await fs.stat(file);

    let captions: AssemblyResult['captions'];
    if (prepared[0].input.captionText?.trim()) {
      const cues = buildCaptions(
        timeline.map((t, i) => ({ text: prepared[i].input.captionText!, startSec: t.startSec, audioSec: t.audioSec, gapAfterSec: t.durationSec - t.audioSec }))
      );
      const srt = file.replace(/\.mp4$/, '.en.srt');
      await fs.writeFile(srt, renderSrt(cues), 'utf8');
      captions = { file: srt, cues: cues.length };
    }
    return { file, bytes: size, durationSec: probe.durationSec, width, height, fps, scenes: timeline, elapsedMs: Date.now() - started, ...(captions ? { captions } : {}) };
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}
