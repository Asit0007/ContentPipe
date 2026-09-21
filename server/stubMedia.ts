import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/**
 * Stand-ins for /api/tts and /api/generate-image output, used by the assembler's tests and by
 * scripts/render-fixture.ts. They cost no quota and need no network — only a local ffmpeg for the
 * stills. Never wire these into an endpoint: they exist to prove the render path works.
 */

/** A soft-edged sine tone as raw 16-bit little-endian mono PCM — the shape /api/tts returns. */
export function stubPcm(seconds: number, freqHz = 220, sampleRate = 24000): Buffer {
  const n = Math.round(seconds * sampleRate);
  const buf = Buffer.alloc(n * 2);
  const edge = Math.min(n / 2, sampleRate * 0.05);
  for (let i = 0; i < n; i++) {
    const env = Math.min(1, i / edge, (n - 1 - i) / edge);
    buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freqHz * i) / sampleRate) * 0.25 * env * 32767), i * 2);
  }
  return buf;
}

export function pcmToWav(pcm: Buffer, sampleRate = 24000): Buffer {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'latin1');
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVEfmt ', 8, 'latin1');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36, 'latin1');
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/** One frame of ffmpeg's `testsrc2` pattern, hue-rotated so scenes are visibly different. */
export async function stubImageDataUrl(width: number, height: number, hueDeg: number, ffmpegPath = 'ffmpeg'): Promise<string> {
  const { stdout } = await execFileAsync(
    ffmpegPath,
    ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc2=s=${width}x${height}:d=1`, '-vf', `hue=h=${hueDeg}`, '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', '-'],
    { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }
  );
  return `data:image/png;base64,${stdout.toString('base64')}`;
}
