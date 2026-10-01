/**
 * One tick of the daily video burn: spend each free Hugging Face ZeroGPU window on as much AI footage as it gives,
 * across the Wan / MiniMax / LTX Spaces in server/videoBurn.ts. Run hourly by the LaunchAgent
 * com.asitminz.videoburn until it was retired on 2026-09-27 (its plist was deleted from deploy/ on 2026-10-01).
 *
 *   npx tsx scripts/video-burn.ts             one tick (both pools)
 *   npx tsx scripts/video-burn.ts --status    print the summary so far
 *
 * Shots come from renders/video-burn/shots.json ([{id, still, prompt, aspectRatio?}], stills relative to that folder),
 * used round-robin. Clips, state.json, summary.md and log.jsonl live in renders/video-burn/ (gitignored).
 * A refused call costs no quota, so a tick with nothing to spend is harmless.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { generateSceneVideo } from '../server/videoProviders';
import { clearSpaceCooldowns } from '../server/mediaOrder';
import { DEFAULT_POOLS, clipsFor, currentWindow, endSweep, isSleeping, newState, pickShot, recordClip, recordRefusal, summarize, type Shot, type State } from '../server/videoBurn';

const DIR = path.join(process.cwd(), 'renders', 'video-burn');
const STATE = path.join(DIR, 'state.json');
const LOG = path.join(DIR, 'log.jsonl');
const MAX_CALLS_PER_TICK = 40;

const log = (o: object) => {
  fs.mkdirSync(DIR, { recursive: true });
  const line = JSON.stringify({ t: new Date().toISOString(), ...o });
  console.log(line);
  fs.appendFileSync(LOG, line + '\n');
};
const load = (): State => (fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : newState());
const save = (s: State) => {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(STATE, JSON.stringify(s, null, 2));
  fs.writeFileSync(path.join(DIR, 'summary.md'), summarize(s));
};

function probe(file: string) {
  try {
    const j = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,width,height,r_frame_rate,duration', '-of', 'json', file]).toString());
    const v = (j.streams || []).find((s: any) => s.codec_type === 'video') ?? {};
    return { width: v.width, height: v.height, fps: v.r_frame_rate, durationSec: Number(v.duration) || undefined, hasAudioTrack: (j.streams || []).some((s: any) => s.codec_type === 'audio') };
  } catch {
    return { hasAudioTrack: false };
  }
}

async function main() {
  if (process.argv.includes('--status')) return console.log(summarize(load()));
  if (!process.env.HF_TOKEN) return log({ event: 'error', message: 'HF_TOKEN is not set' });
  const shotsFile = path.join(DIR, 'shots.json');
  if (!fs.existsSync(shotsFile)) return log({ event: 'error', message: `missing ${shotsFile}` });
  const shots: Shot[] = JSON.parse(fs.readFileSync(shotsFile, 'utf8'));
  if (!shots.length) return log({ event: 'error', message: 'shots.json is empty' });

  const state = load();
  const now = () => new Date();
  let calls = 0;
  for (const cfg of DEFAULT_POOLS) {
    const pool = state.pools.find((p) => p.id === cfg.id)!;
    if (isSleeping(pool, now())) {
      log({ event: 'pool_sleeping', pool: pool.id, until: pool.sleepUntil });
      continue;
    }
    const win = currentWindow(pool, now());
    log({ event: 'sweep', pool: pool.id, window: pool.windows.length, opened: win.start ?? null, clipsSoFar: win.clips.length });
    let allDone = true;
    for (const entry of cfg.entries) {
      while (clipsFor(win, entry.space) < entry.maxPerWindow && calls < MAX_CALLS_PER_TICK) {
        const shot = pickShot(shots, state);
        const still = path.isAbsolute(shot.still) ? shot.still : path.join(DIR, shot.still);
        const imageUrl = `data:image/${/\.png$/i.test(still) ? 'png' : 'jpeg'};base64,${fs.readFileSync(still).toString('base64')}`;
        // The anonymous pool must not carry the account token at all; the account pool only reaches trusted owners.
        const env = { ...process.env, VIDEO_PROVIDER_ORDER: `hf:${entry.space}`, CONTENTPIPE_RENDERS_DIR: DIR, ...(cfg.id === 'anonymous' ? { HF_TOKEN: '' } : {}) } as Record<string, string | undefined>;
        // The Wan adapter reads its step count from the process environment.
        process.env.WAN_STEPS = String(entry.steps ?? 6);
        calls++;
        const t0 = Date.now();
        try {
          let r;
          try {
            r = await generateSceneVideo({ imageUrl, prompt: shot.prompt, durationSec: entry.clipSec, aspectRatio: shot.aspectRatio || '16:9' }, env);
          } catch (first: any) {
            // "The shared ZeroGPU pool is at capacity ... wait a minute" is HF's whole fleet being busy, not our quota
            // (seen on MiniMax-H3, 2026-09-27): wait once and try again instead of calling the window spent.
            if (!/at capacity/i.test(String(first?.message))) throw first;
            log({ event: 'capacity_wait', pool: cfg.id, model: entry.label, seconds: 70 });
            await new Promise((res) => setTimeout(res, 70_000));
            clearSpaceCooldowns(); // the failed call set a 2-minute in-process cooldown for this Space
            calls++;
            r = await generateSceneVideo({ imageUrl, prompt: shot.prompt, durationSec: entry.clipSec, aspectRatio: shot.aspectRatio || '16:9' }, env);
          }
          const wallSec = +((Date.now() - t0) / 1000).toFixed(1);
          const pr = probe(r.file);
          recordClip(win, { at: now().toISOString(), pool: cfg.id, space: entry.space, label: entry.label, steps: entry.steps, shot: shot.id, wallSec, bytes: r.bytes, width: pr.width, height: pr.height, fps: pr.fps, durationSec: pr.durationSec, hasAudio: pr.hasAudioTrack, file: path.basename(r.file) }, now());
          save(state);
          log({ event: 'clip', pool: cfg.id, model: entry.label, shot: shot.id, wallSec, seconds: pr.durationSec, size: `${pr.width}x${pr.height}`, fps: pr.fps, audio: pr.hasAudioTrack, file: path.basename(r.file) });
        } catch (e: any) {
          const message = String(e?.message || e).slice(0, 400);
          recordRefusal(win, entry.space, message, now());
          save(state);
          log({ event: 'refused', pool: cfg.id, model: entry.label, wallSec: +((Date.now() - t0) / 1000).toFixed(1), kind: e?.kind ?? e?.classified?.kind, message });
          break;
        }
      }
      // Capped is fine; anything else still has quota or a transient problem to retry.
      const capped = clipsFor(win, entry.space) >= entry.maxPerWindow;
      const refusedNow = win.refusals.length > 0 && win.refusals[win.refusals.length - 1].space === entry.space && !capped;
      if (!capped && !refusedNow) allDone = false; // stopped by the per-tick call cap, not by a refusal
    }
    endSweep(pool, win, allDone, now());
    save(state);
  }
  log({ event: 'tick_done', calls });
}

main().catch((e) => {
  log({ event: 'crash', message: String(e?.stack || e).slice(0, 600) });
  process.exit(1);
});
