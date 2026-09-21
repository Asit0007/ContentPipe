import { assembleVideo, type AssemblySceneInput } from '../server/assemble';
import { stubImageDataUrl, stubPcm } from '../server/stubMedia';

/**
 * Renders a stub MP4 (test-pattern stills + sine-tone "narration") through the real assembler.
 * Proves the ffmpeg path end to end with no Gemini quota and no network.
 *
 *   npm run render:fixture                # 1080p, 16:9
 *   npm run render:fixture -- --720       # faster
 *   npm run render:fixture -- --vertical  # 1080x1920 (Shorts)
 */
const args = new Set(process.argv.slice(2));
const vertical = args.has('--vertical');
const small = args.has('--720');
const [w, h] = vertical ? (small ? [720, 1280] : [1080, 1920]) : small ? [1280, 720] : [1920, 1080];

const narrationSec = [6.2, 9.8, 11.4, 8.0, 12.6, 5.5];

const scenes: AssemblySceneInput[] = [];
for (let i = 0; i < narrationSec.length; i++) {
  scenes.push({
    id: `fixture-${i + 1}`,
    imageUrl: await stubImageDataUrl(w, h, i * 55),
    audioBase64: stubPcm(narrationSec[i], 160 + i * 40).toString('base64'),
    captionText: `Fixture scene ${i + 1}. This narration is a stand-in tone, and this caption exists to prove the subtitle file lines up with the audio it belongs to.`,
  });
}

const r = await assembleVideo(scenes, {
  aspectRatio: vertical ? '9:16' : '16:9',
  width: w,
  height: h,
  name: 'fixture-stub',
  onProgress: (done, total) => process.stdout.write(`\rencoding scene ${done}/${total}`),
});

const ratio = r.elapsedMs / 1000 / r.durationSec;
console.log(`\n${r.file}`);
if (r.captions) console.log(`${r.captions.file}  (${r.captions.cues} cues)`);
console.log(`${r.width}x${r.height} @ ${r.fps}fps, ${r.durationSec.toFixed(2)}s, ${(r.bytes / 1e6).toFixed(2)} MB`);
console.log(`rendered in ${(r.elapsedMs / 1000).toFixed(1)}s = ${ratio.toFixed(2)}x video length  (a 9-minute video ≈ ${((ratio * 540) / 60).toFixed(1)} min)`);
for (const s of r.scenes) console.log(`  ${s.id}  start ${s.startSec.toFixed(2)}s  audio ${s.audioSec.toFixed(2)}s  held ${s.durationSec.toFixed(3)}s  (${s.frames} frames)`);
