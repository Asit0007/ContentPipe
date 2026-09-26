/**
 * One tick of the Wan 2.2 free-quota measurement. Run hourly by the LaunchAgent com.asitminz.wanmeasure
 * (deploy/com.asitminz.wanmeasure.plist); see server/wanMeasure.ts for the logic and ContentRender DESIGN.md
 * ("Measurement log") for why.
 *
 *   npx tsx scripts/wan-measure.ts          one tick: retry until let in, then run until the wall
 *   npx tsx scripts/wan-measure.ts --status print the summary so far
 *
 * State, clips and the log live in renders/wan-measure/ (gitignored). Needs HF_TOKEN in .env and a still at
 * renders/wan-measure/still.jpg. Only the Wan Space is called (MiniMax reserves ~146 s a clip and is not measured
 * here). When every phase is done the job unloads its own LaunchAgent.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { generateSceneVideo } from '../server/videoProviders';
import { allDone, currentPhase, newState, recordFailure, recordSuccess, summarize, waitUntil, type State } from '../server/wanMeasure';

const SPACE = 'zerogpu-aoti/wan2-2-fp8da-aoti-faster';
const DIR = path.join(process.cwd(), 'renders', 'wan-measure');
const STATE = path.join(DIR, 'state.json');
const LOG = path.join(DIR, 'log.jsonl');
const MAX_CALLS_PER_TICK = 12;
const CLIP_SECONDS = 4;
const PROMPT = 'The woman slowly turns her head toward the cracked monitor as red text scrolls on the screen. Cables sway slightly overhead. Static camera.';

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
    const j = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,r_frame_rate,duration', '-of', 'json', file]).toString());
    const v = j.streams?.[0] ?? {};
    return { width: v.width, height: v.height, fps: v.r_frame_rate, durationSec: Number(v.duration) || undefined };
  } catch {
    return {};
  }
}

async function main() {
  if (process.argv.includes('--status')) {
    console.log(summarize(load()));
    return;
  }
  const state = load();
  save(state);
  if (allDone(state)) return log({ event: 'all_done' });
  const wait = waitUntil(state);
  if (wait) return log({ event: 'waiting_for_reset', until: wait });
  const stillPath = path.join(DIR, 'still.jpg');
  if (!process.env.HF_TOKEN) return log({ event: 'error', message: 'HF_TOKEN is not set' });
  if (!fs.existsSync(stillPath)) return log({ event: 'error', message: `missing ${stillPath}` });
  const imageUrl = `data:image/jpeg;base64,${fs.readFileSync(stillPath).toString('base64')}`;

  const phase = currentPhase(state)!;
  const env = { ...process.env, VIDEO_PROVIDER_ORDER: `hf:${SPACE}`, CONTENTPIPE_RENDERS_DIR: DIR, WAN_STEPS: String(phase.steps) } as Record<string, string | undefined>;
  log({ event: 'tick', steps: phase.steps, phaseStatus: phase.status, clipsSoFar: phase.clips.length });

  for (let i = 1; i <= MAX_CALLS_PER_TICK; i++) {
    const t0 = Date.now();
    try {
      const r = await generateSceneVideo({ imageUrl, prompt: PROMPT, durationSec: CLIP_SECONDS, aspectRatio: '16:9' }, env);
      const wallSec = +((Date.now() - t0) / 1000).toFixed(1);
      recordSuccess(phase, { at: new Date().toISOString(), wallSec, bytes: r.bytes, ...probe(r.file) });
      save(state);
      log({ event: 'clip', steps: phase.steps, n: phase.clips.length, wallSec, bytes: r.bytes, file: path.basename(r.file), windowStart: phase.windowStart });
    } catch (e: any) {
      const message = String(e?.message || e).slice(0, 500);
      const outcome = recordFailure(phase, message);
      save(state);
      log({ event: outcome === 'wall' ? 'wall' : 'refused', steps: phase.steps, clips: phase.clips.length, kind: e?.kind ?? e?.classified?.kind, retryAfterSec: e?.retryAfterSec, message });
      break;
    }
  }

  if (allDone(state)) {
    log({ event: 'all_done', summary: path.join(DIR, 'summary.md') });
    try {
      execFileSync('launchctl', ['bootout', `gui/${process.getuid?.()}/com.asitminz.wanmeasure`]);
    } catch {
      /* not loaded, or already unloaded */
    }
  }
}

main().catch((e) => {
  log({ event: 'crash', message: String(e?.stack || e).slice(0, 600) });
  process.exit(1);
});
