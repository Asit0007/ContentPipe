import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  AssemblyInputError,
  assembleVideo,
  buildMuxArgs,
  buildSegmentArgs,
  decodeAudioBase64,
  decodeImageDataUrl,
  padPcm,
  planTimeline,
  probeMedia,
  sniffImage,
  validateScenes,
  type AssemblySceneInput,
} from './assemble';
import { pcmToWav, stubImageDataUrl, stubPcm } from './stubMedia';

const b64 = (b: Buffer) => b.toString('base64');
const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const pngUrl = `data:image/png;base64,${b64(PNG_HEAD)}`;

const hasFfmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

// --- decoding ---------------------------------------------------------------

test('image: bytes decide the type, not the data: URL label', () => {
  assert.equal(sniffImage(PNG_HEAD), 'png');
  const lying = decodeImageDataUrl(`data:image/png;base64,${b64(Buffer.from('<html>rate limited</html>'))}`);
  assert.equal(lying.value, undefined);
  assert.equal(lying.problem?.code, 'unsupported_image');
  assert.equal(decodeImageDataUrl('https://example.com/a.png').problem?.code, 'missing_image');
  assert.equal(decodeImageDataUrl(pngUrl).value?.ext, 'png');
});

test('image: SVG (what the placeholder generator emits) is unsupported', () => {
  const svg = `data:image/svg+xml;base64,${b64(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))}`;
  assert.equal(decodeImageDataUrl(svg).problem?.code, 'unsupported_image');
});

test('audio: raw PCM and WAV decode to the same samples and rate', () => {
  const pcm = stubPcm(1, 200);
  const raw = decodeAudioBase64(b64(pcm), 24000).value!;
  const wav = decodeAudioBase64(b64(pcmToWav(pcm, 24000))).value!;
  assert.equal(raw.pcm.length, 48000);
  assert.ok(raw.pcm.equals(wav.pcm));
  assert.equal(wav.sampleRate, 24000);
});

test('audio: empty, odd-length and non-mono/16-bit WAV are refused', () => {
  assert.equal(decodeAudioBase64('').problem?.code, 'missing_audio');
  assert.equal(decodeAudioBase64(b64(Buffer.alloc(5))).problem?.code, 'unsupported_audio');
  const stereo = pcmToWav(stubPcm(1));
  stereo.writeUInt16LE(2, 22); // channels
  assert.equal(decodeAudioBase64(b64(stereo)).problem?.code, 'unsupported_audio');
});

// --- refusal ----------------------------------------------------------------

const good = (id: string): AssemblySceneInput => ({ id, imageUrl: pngUrl, audioBase64: b64(stubPcm(1)) });

test('validateScenes collects every problem instead of stopping at the first', () => {
  const { problems, prepared } = validateScenes([
    good('a'),
    { ...good('b'), imageIsPlaceholder: true },
    { ...good('c'), audioIsFallback: true },
    { ...good('d'), audioBase64: b64(stubPcm(0.1)) },
    { ...good('e'), audioBase64: b64(stubPcm(1, 200, 16000)), audioSampleRate: 16000 },
  ]);
  assert.deepEqual(problems.map((p) => [p.sceneId, p.code]), [
    ['b', 'placeholder_image'],
    ['c', 'fallback_audio'],
    ['d', 'audio_too_short'],
    ['e', 'sample_rate_mismatch'],
  ]);
  assert.equal(prepared.length, 1);
});

test('assembleVideo refuses before touching ffmpeg, with the full problem list', async () => {
  await assert.rejects(
    assembleVideo([{ ...good('a'), audioIsFallback: true }, { ...good('b'), imageIsPlaceholder: true }], { ffmpegPath: '/nonexistent/ffmpeg' }),
    (err: any) => err instanceof AssemblyInputError && err.problems.length === 2
  );
  await assert.rejects(assembleVideo([], { ffmpegPath: '/nonexistent/ffmpeg' }), AssemblyInputError);
});

test('captions are all-or-none: a partial set is refused, naming the scenes that lack text', () => {
  const { problems } = validateScenes([{ ...good('a'), captionText: 'Spoken words.' }, good('b'), { ...good('c'), captionText: '   ' }]);
  assert.deepEqual(problems.map((p) => [p.sceneId, p.code]), [['b', 'missing_caption'], ['c', 'missing_caption']]);
  assert.equal(validateScenes([good('a'), good('b')]).problems.length, 0, 'no captions at all is fine');
  assert.equal(validateScenes([{ ...good('a'), captionText: 'x' }, { ...good('b'), captionText: 'y' }]).problems.length, 0);
});

// --- timeline ---------------------------------------------------------------

test('timeline: whole frames, contiguous starts, tail only on the last scene', () => {
  const t = planTimeline([{ id: 'a', audioSec: 2.0 }, { id: 'b', audioSec: 1.01 }, { id: 'c', audioSec: 3 }], 30, 0.35, 0.8);
  assert.deepEqual(t.map((s) => s.frames), [71, 41, 125]); // 2.35s, 1.36s (40.8 → 41), 3s + gap + tail = 4.15s (124.5 → 125)
  assert.equal(t[0].startSec, 0);
  assert.ok(Math.abs(t[1].startSec - 71 / 30) < 1e-9);
  assert.ok(Math.abs(t[2].startSec - (71 + 41) / 30) < 1e-9);
  for (const s of t) assert.ok(Math.abs(s.durationSec * 30 - s.frames) < 1e-9);
});

test('padPcm pads with silence and trims to exactly the frame-aligned length', () => {
  const pcm = stubPcm(1);
  const padded = padPcm(pcm, 24000, 1.5);
  assert.equal(padded.length, 36000 * 2);
  assert.ok(padded.subarray(0, pcm.length).equals(pcm));
  assert.ok(padded.subarray(pcm.length).every((v) => v === 0));
  assert.equal(padPcm(pcm, 24000, 0.5).length, 12000 * 2);
});

// --- ffmpeg arguments -------------------------------------------------------

test('segment args: exact frame count, no audio, zoom expression scales with frames', () => {
  const a = buildSegmentArgs({ image: '/i.png', out: '/o.mp4', frames: 90, fps: 30, width: 1920, height: 1080, zoom: 'in' });
  assert.equal(a[a.indexOf('-frames:v') + 1], '90');
  assert.ok(a.includes('-an'));
  assert.match(a[a.indexOf('-vf') + 1], /zoompan=z='1\+0\.06\*on\/90'.*s=1920x1080:fps=30/);
  assert.match(a[a.indexOf('-vf') + 1], /scale=3840:2160/); // 2x oversample
  const out = buildSegmentArgs({ image: '/i.png', out: '/o.mp4', frames: 90, fps: 30, width: 1920, height: 1080, zoom: 'out' });
  assert.match(out[out.indexOf('-vf') + 1], /z='1\.06-0\.06\*on\/90'/);
  const still = buildSegmentArgs({ image: '/i.png', out: '/o.mp4', frames: 90, fps: 30, width: 1920, height: 1080, zoom: 'none' });
  assert.doesNotMatch(still[still.indexOf('-vf') + 1], /zoompan/);
});

test('mux args: one AAC encode over stream-copied video, loudness optional', () => {
  const m = buildMuxArgs({ concatList: '/l.txt', pcm: '/n.pcm', sampleRate: 24000, out: '/o.mp4', normalizeLoudness: true });
  assert.equal(m[m.indexOf('-c:v') + 1], 'copy');
  assert.ok(m.includes('loudnorm=I=-14:TP=-1.5:LRA=11'));
  assert.equal(m.filter((x) => x === '-c:a').length, 1);
  assert.ok(!buildMuxArgs({ concatList: '/l.txt', pcm: '/n.pcm', sampleRate: 24000, out: '/o.mp4', normalizeLoudness: false }).includes('-af'));
});

// --- real ffmpeg ------------------------------------------------------------

test('renders a real MP4 whose duration is the sum of the frame-aligned scenes', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'assemble-test-'));
  try {
    const durs = [1.2, 2.0, 0.9];
    const scenes: AssemblySceneInput[] = [];
    for (let i = 0; i < durs.length; i++) {
      scenes.push({ id: `s${i + 1}`, imageUrl: await stubImageDataUrl(320, 180, i * 100), audioBase64: b64(stubPcm(durs[i], 180 + i * 60)) });
    }
    let progress = 0;
    const r = await assembleVideo(scenes, { width: 320, height: 180, fps: 30, outDir, name: 'Test Render', zoomOversample: 1, onProgress: (d) => (progress = d) });

    assert.equal(progress, 3);
    assert.match(path.basename(r.file), /^test-render-\d{8}T\d{6}\.mp4$/);
    const expected = r.scenes.reduce((n, s) => n + s.durationSec, 0);
    assert.ok(Math.abs(r.durationSec - expected) < 0.15, `${r.durationSec} vs ${expected}`);
    assert.deepEqual(r.scenes.map((s) => s.audioSec), durs);
    const p = await probeMedia(r.file);
    assert.equal(p.videoStreams, 1);
    assert.equal(p.audioStreams, 1);
    assert.equal(`${p.width}x${p.height}`, '320x180');
    assert.deepEqual((await fs.readdir(outDir)).filter((f) => f.endsWith('.mp4')).length, 1);
    assert.equal(r.captions, undefined, 'no captionText, no SRT');
  } finally {
    await fs.rm(outDir, { recursive: true, force: true });
  }
});

test('writes a sidecar .en.srt next to the MP4 that ffmpeg itself parses, with cues inside the real timeline', { skip: !hasFfmpeg && 'ffmpeg not installed' }, async () => {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'assemble-srt-'));
  try {
    const text = ['SentinelOne says the backdoors were already on disk on March 18. It cannot prove how they were delivered.', 'They stayed dormant until March 29.', 'Then the developer opened a workspace in Cursor, and both implants launched within seconds.'];
    const durs = [4.0, 1.6, 4.4];
    const scenes: AssemblySceneInput[] = [];
    for (let i = 0; i < durs.length; i++) {
      scenes.push({ id: `s${i + 1}`, imageUrl: await stubImageDataUrl(320, 180, i * 90), audioBase64: b64(stubPcm(durs[i], 200 + i * 50)), captionText: text[i] });
    }
    const r = await assembleVideo(scenes, { width: 320, height: 180, outDir, name: 'srt test', zoom: false });
    assert.ok(r.captions);
    assert.equal(r.captions!.file, r.file.replace(/\.mp4$/, '.en.srt'));
    const srt = await fs.readFile(r.captions!.file, 'utf8');
    assert.equal((srt.match(/-->/g) || []).length, r.captions!.cues);
    assert.ok(r.captions!.cues >= 3);
    // An independent parser has to read the same number of cues (ffmpeg errors out on a malformed SRT).
    const vtt = execFileSync('ffmpeg', ['-v', 'error', '-i', r.captions!.file, '-f', 'webvtt', '-']).toString();
    assert.equal((vtt.match(/-->/g) || []).length, r.captions!.cues);
    // Every scene's first cue starts exactly where that scene's audio starts in the video.
    const starts = [...srt.matchAll(/(\d\d):(\d\d):(\d\d),(\d\d\d) -->/g)].map((m) => Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000);
    for (const t of r.scenes) assert.ok(starts.some((s) => Math.abs(s - t.startSec) < 0.002), `a cue starts at scene ${t.id}'s start ${t.startSec}`);
    assert.ok(starts[starts.length - 1] < r.durationSec);
  } finally {
    await fs.rm(outDir, { recursive: true, force: true });
  }
});
