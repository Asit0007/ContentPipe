/**
 * story-start.ts — start one story BY HAND and leave a ContentRender-ready brief behind.
 *
 * Why this exists: the story cycle's orchestrator (CyberPipe) is not installed — it has no .env,
 * no database and no Telegram bot — so there was no way to start a story short of driving
 * /api/research -> /api/plan -> /api/script by hand. This script is the smallest thing that does:
 * it walks that same chain exactly as CyberPipe's pipeline.py does (same strict header, same
 * forwarding rules), writes the brief ContentRender reads, and stops. It does NOT touch images,
 * clips, narration or the bundle: those have human gates, and the gates live in CyberPipe.
 *
 * **Run it by hand — `npm run story:start`** — never on a schedule (2026-09-29: the pipeline starts
 * only when the owner starts it; the `com.asitminz.storycycle` LaunchAgent that used to fire this at
 * 08:00 was removed for that reason — resuming a *paused* story is CyberPipe's job, once installed,
 * not this script's). Every stage is still cached on disk under .runs/story-<key>/, so re-running it
 * resumes instead of respending the text quota, and a finished story exits immediately; to start a
 * NEW story, change `storySlug` in stories/next-story.json first.
 *
 *   npx tsx scripts/story-start.ts                       # the story in stories/next-story.json
 *   npx tsx scripts/story-start.ts --dry-run             # config + server check, spends nothing
 *   npx tsx scripts/story-start.ts --story path.json     # a different story file
 *   npx tsx scripts/story-start.ts --force               # ignore the cache and start over
 *
 * Env: CONTENTPIPE_BASE_URL (default http://127.0.0.1:3000), STORY_DEADLINE_SEC (default 21600),
 *      STORY_HEALTH_WAIT_SEC (default 180).
 */
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { DEFAULT_CHANNEL_BRAND } from '../shared/brand';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = (process.env.CONTENTPIPE_BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const DEADLINE_SEC = Number(process.env.STORY_DEADLINE_SEC || 21600);
// How long to wait for the server to answer. The server agent has KeepAlive, so this only covers a boot race.
const HEALTH_WAIT_SEC = Number(process.env.STORY_HEALTH_WAIT_SEC || 180);

// Matches CyberPipe: quota/overload arrive as 429/503 + Retry-After instead of canned content, and an
// interrupted /api/script resumes from its last finished chunk on the identical re-POST.
const STRICT = { 'Content-Type': 'application/json', 'X-ContentPipe-Strict': '1' };

// Per-request ceilings. /api/script makes many sequential LLM calls internally, so it gets far longer
// than research and plan (CyberPipe uses the same split for the same reason).
const TIMEOUT_SEC: Record<string, number> = { research: 900, plan: 900, script: 5400, export: 120 };

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const startedAt = Date.now();
const log = (msg: string) => {
  const t = new Date().toISOString();
  const mins = ((Date.now() - startedAt) / 60000).toFixed(1);
  console.log(`[${t}] [+${mins}m] ${msg}`);
};
const deadlineLeftSec = () => DEADLINE_SEC - (Date.now() - startedAt) / 1000;

class Fatal extends Error {}

async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf-8')) as T;
  } catch {
    return undefined;
  }
}

async function writeJson(file: string, value: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 2), 'utf-8');
}

function slug(text: string, max = 48) {
  return (
    String(text || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, max)
      .replace(/-+$/, '') || 'untitled'
  );
}

/** Seconds to wait from a Retry-After header, which is either a delta or an HTTP date. */
function retryAfterSec(header: string | null): number {
  if (!header) return 60;
  const delta = Number(header);
  if (Number.isFinite(delta)) return Math.max(5, delta);
  const when = Date.parse(header);
  if (!Number.isNaN(when)) return Math.max(5, (when - Date.now()) / 1000);
  return 60;
}

const sleep = (sec: number) => new Promise((r) => setTimeout(r, Math.max(0, sec) * 1000));

/**
 * One ContentPipe call, with the waits its failure contract asks for. 429 (quota) and 503 (every
 * provider overloaded) are not this story's fault, so they wait out Retry-After and do not count as
 * attempts. 409 means an identical run is still generating server-side after a client timeout —
 * waiting and re-POSTing picks up its journal rather than starting a second run.
 */
async function post(route: string, body: unknown, label: string): Promise<any> {
  let attempts = 0;
  for (;;) {
    if (deadlineLeftSec() <= 0) throw new Fatal(`ran out of time (${DEADLINE_SEC}s) waiting on /api/${label}`);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_SEC[label] * 1000);
    let res: Response;
    try {
      res = await fetch(`${BASE}${route}`, { method: 'POST', headers: STRICT, body: JSON.stringify(body), signal: ac.signal });
    } catch (err: any) {
      clearTimeout(timer);
      // A client timeout does not stop the server: re-POST and let the journal resume.
      if (++attempts > 4) throw new Fatal(`/api/${label} failed ${attempts}x: ${err?.message || err}`);
      const wait = Math.min(300, 30 * attempts);
      log(`/api/${label}: ${err?.name === 'AbortError' ? `no answer in ${TIMEOUT_SEC[label]}s` : err?.message}; retrying in ${wait}s`);
      await sleep(wait);
      continue;
    }
    clearTimeout(timer);

    if (res.status === 429 || res.status === 503) {
      const wait = Math.min(retryAfterSec(res.headers.get('retry-after')), Math.max(60, deadlineLeftSec() - 60));
      log(`/api/${label}: HTTP ${res.status} (${res.status === 429 ? 'quota' : 'all providers overloaded'}); waiting ${Math.round(wait)}s`);
      await sleep(wait);
      continue;
    }
    if (res.status === 409) {
      const wait = retryAfterSec(res.headers.get('retry-after'));
      log(`/api/${label}: an identical run is already generating; waiting ${Math.round(wait)}s and re-POSTing`);
      await sleep(wait);
      continue;
    }
    const text = await res.text();
    if (!res.ok) {
      let kind = '';
      try {
        kind = JSON.parse(text)?.kind || '';
      } catch {}
      // zero_quota means the key has no quota at all; no amount of waiting fixes it.
      throw new Fatal(`/api/${label} returned ${res.status}${kind ? ` (${kind})` : ''}: ${text.slice(0, 400)}`);
    }
    const data = JSON.parse(text);
    // Belt and braces: strict mode should never hand back the canned fallback story.
    if (data?.isQuotaFallback) throw new Fatal(`/api/${label} returned canned fallback content; refusing to treat it as real output`);
    return data;
  }
}

/** What /api/plan and /api/script are given. Mirrors CyberPipe: the infotainment-shaped fields would
 *  pull a long-form story toward listicle beats, so they are not forwarded. */
function forwardResearch(research: Record<string, any>) {
  const { hnCommunitySentiment, infotainmentAngles, modelUsage, ...rest } = research;
  return rest;
}

async function waitForServer(): Promise<void> {
  const until = Date.now() + HEALTH_WAIT_SEC * 1000;
  for (;;) {
    try {
      const res = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        log(`ContentPipe is up at ${BASE}`);
        return;
      }
    } catch {}
    if (Date.now() > until) throw new Fatal(`ContentPipe never answered at ${BASE}/api/health (is com.asitminz.contentpipe loaded?)`);
    await sleep(5);
  }
}

type Story = {
  storySlug?: string;
  messageText?: string;
  sourceUrls?: string[];
  channelName?: string;
  targetTone?: string;
  targetFormat?: string;
  targetDurationSec?: number;
  channelBrandName?: string;
  topicDomain?: string;
  fresh?: boolean;
};

async function main() {
  const storyPath = path.resolve(REPO, opt('story') || 'stories/next-story.json');
  const story = await readJson<Story>(storyPath);
  if (!story) throw new Fatal(`no story file at ${storyPath}`);
  if (!story.messageText?.trim()) throw new Fatal(`${storyPath} has no messageText`);

  const key = slug(story.storySlug || story.messageText.slice(0, 40));
  const runDir = path.join(REPO, '.runs', `story-${key}`);
  const statePath = path.join(runDir, 'state.json');
  const durationSec = Number(story.targetDurationSec) || 585;
  const brand = story.channelBrandName || DEFAULT_CHANNEL_BRAND;

  log(`story "${key}" — ${durationSec}s, tone "${story.targetTone || '(default)'}", ${story.sourceUrls?.length || 0} source(s)`);
  log(`run dir ${path.relative(REPO, runDir)}`);

  if (flag('force')) {
    await fs.rm(runDir, { recursive: true, force: true });
    log('--force: cleared the cached stages, starting over');
  }

  const state = (await readJson<any>(statePath)) || {};
  if (state.stage === 'done' && !flag('force')) {
    log(`already finished on ${state.finishedAt} -> ${state.brief}`);
    log('nothing to do. Change `storySlug` in the story file to start a different story, or pass --force.');
    return;
  }

  if (flag('dry-run')) {
    await waitForServer();
    log('--dry-run: config is valid and ContentPipe answers. Nothing was generated.');
    return;
  }

  await waitForServer();
  await fs.mkdir(runDir, { recursive: true });
  const save = async (stage: string, extra: Record<string, unknown> = {}) =>
    writeJson(statePath, { ...state, ...extra, key, stage, storyPath: path.relative(REPO, storyPath), updatedAt: new Date().toISOString() });

  // ---------------------------------------------------------------- 1. research
  let research = await readJson<any>(path.join(runDir, 'research.json'));
  if (research) {
    log('research: reusing the cached dossier');
  } else {
    await save('research');
    log('research: reading the sources...');
    const body: Record<string, unknown> = {
      messageText: story.messageText,
      sourceUrls: story.sourceUrls || [],
      targetDurationSec: durationSec,
    };
    // Where the story came from. Our own channel is never an origin, so it is only sent when named.
    if (story.channelName) body.channelName = story.channelName;
    if (story.topicDomain) body.topicDomain = story.topicDomain;
    research = await post('/api/research', body, 'research');
    await writeJson(path.join(runDir, 'research.json'), research);
    const got = (research.retrievedSources || []).filter((s: any) => s.ok).length;
    const total = (research.retrievedSources || []).length;
    log(`research: ${got}/${total} source(s) read; coverage ${JSON.stringify(research.researchCoverage ?? 'n/a')}`);
    for (const s of (research.retrievedSources || []).filter((x: any) => !x.ok)) log(`research: UNREAD ${s.url} -> ${s.error}`);
    for (const gap of research.researchGaps || []) log(`research: gap -> ${gap}`);
  }

  // ---------------------------------------------------------------- 2. plan
  let plan = await readJson<any>(path.join(runDir, 'plan.json'));
  if (plan) {
    log('plan: reusing the cached plan');
  } else {
    await save('plan');
    log('plan: shaping the acts...');
    const body: Record<string, unknown> = {
      researchData: forwardResearch(research),
      targetFormat: story.targetFormat || '16:9',
      targetDurationSec: durationSec,
    };
    if (story.targetTone) body.targetTone = story.targetTone;
    if (story.topicDomain) body.topicDomain = story.topicDomain;
    plan = await post('/api/plan', body, 'plan');
    await writeJson(path.join(runDir, 'plan.json'), plan);
    log(`plan: "${plan.title}" — ${(plan.narrativeBeats || []).length} beats, tone "${plan.tone}"`);
  }

  // ---------------------------------------------------------------- 3. script
  let script = await readJson<any>(path.join(runDir, 'script.json'));
  if (script) {
    log('script: reusing the cached script');
  } else {
    await save('script');
    log('script: writing the scenes (this is the long one)...');
    const body: Record<string, unknown> = {
      videoPlan: plan,
      researchData: forwardResearch(research),
      channelBrandName: brand,
      // A stable id so a client timeout re-POSTs into the same journal instead of starting a
      // second run and spending the quota twice.
      runId: `story-${key}`.slice(0, 64),
    };
    if (story.topicDomain) body.topicDomain = story.topicDomain;
    if (story.fresh) body.fresh = true;
    script = await post('/api/script', body, 'script');
    await writeJson(path.join(runDir, 'script.json'), script);
    const scenes = (script.scenes || []).length;
    log(`script: "${script.title}" — ${scenes} scenes, ~${script.estimatedTotalDuration}s (asked for ${durationSec}s)`);
    if (script.generation && script.generation.complete === false) log('script: WARNING generation.complete is false — the draft is partial');
    for (const d of script.degraded || []) log(`script: degraded -> ${d}`);
  }

  if (!Array.isArray(script.scenes) || script.scenes.length === 0) throw new Fatal('the script has no scenes, so there is nothing to render');

  // ------------------------------------------------- 4. the brief ContentRender reads
  // Verbatim the script, which is exactly what CyberPipe's _write_brief writes.
  const briefPath = path.join(runDir, 'brief.json');
  await fs.writeFile(briefPath, JSON.stringify(script), 'utf-8');
  const videoId = `${new Date().toISOString().slice(0, 10)}-${slug(script.title, 40)}`.slice(0, 64);
  log(`brief: ${path.relative(REPO, briefPath)}  (suggested --video-id ${videoId})`);

  // ------------------------------------------------- 5. the readable brief
  try {
    const exported = await post('/api/export/markdown', { script, research, plan, channelBrandName: brand }, 'export');
    log(`export: ${exported.relativePath} (${exported.bytes} bytes)`);
    await save('done', { finishedAt: new Date().toISOString(), brief: path.relative(REPO, briefPath), videoId, export: exported.relativePath, title: script.title });
  } catch (err: any) {
    // The markdown is a convenience; the brief is the deliverable. Never fail the run over it.
    log(`export: FAILED (${err?.message || err}) — the brief is still good`);
    await save('done', { finishedAt: new Date().toISOString(), brief: path.relative(REPO, briefPath), videoId, title: script.title });
  }

  log('--- story ready for review ---');
  log(`Read the brief, then take the media stages from here. Clips must not start before 08:00:`);
  log(`  cd ../ContentRender && npm run cli -- step --brief "${briefPath}" --video-id ${videoId}`);
}

main().catch((err) => {
  log(`FAILED: ${err instanceof Fatal ? err.message : err?.stack || err}`);
  process.exit(1);
});
