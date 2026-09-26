import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { TEXT_MODELS } from '../server/gemini';

/**
 * End-to-end check of the failure contract over real HTTP.
 *
 * Runs the REAL server (tsx server.ts) against a stub Gemini upstream — the SDK honours
 * GOOGLE_GEMINI_BASE_URL — so 429s, overloads, kill -9 crash recovery and the in-flight lock
 * are exercised without spending any quota. `npm run test:e2e`; not part of `npm test`
 * because it spawns processes and one scenario waits out the real 8 s overload retry.
 */

const REPO = path.resolve(import.meta.dirname, '..');
const APP_PORT = 3192;
const APP = `http://127.0.0.1:${APP_PORT}`;
// The stub's per-day 429 is the body captured live from Gemini (limit: 20 on gemini-3.7-flash).
const PERDAY = JSON.parse(readFileSync(path.join(REPO, 'server/__fixtures__/gemini-429-perday.json'), 'utf8'));
// Captured live: the free tier has no quota at all for image models (limit: 0).
const LIMIT0 = JSON.parse(readFileSync(path.join(REPO, 'server/__fixtures__/gemini-429-limit0.json'), 'utf8'));

type SpaceMode = 'ok' | 'quota' | 'down';
const stub = { failNarrFrom: 0, overloaded: false, delayMs: 0, cveInScene1: false, log: [] as string[], tts: 'ok' as 'ok' | 'perday', pollinations: 'fail' as 'fail' | 'ok', hf: {} as Record<string, SpaceMode>, hfSeen: [] as Array<{ space: string; what: string; auth?: string; data?: any }> };
let rendersDir = '';

// Stands in for Hugging Face Spaces (HF_SPACE_BASE_URL): Gradio's upload / call / event-stream / file routes.
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(2048)]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypisom'), Buffer.alloc(8192)]);
function hfStub(req: http.IncomingMessage, raw: Buffer, res: http.ServerResponse) {
  const m = /^\/hf\/([^/]+\/[^/]+)\/gradio_api\/(.*)$/.exec(req.url || '');
  if (!m) return void res.writeHead(404).end();
  const [, space, rest] = m;
  const mode: SpaceMode = stub.hf[space] || 'down';
  const auth = req.headers['x-hf-authorization'] as string | undefined;
  if (rest === 'info') {
    // An API the generic adapter must read: prompt, optional image (video Spaces), duration, then a file output.
    const video = space.includes('video');
    const parameters = [
      { parameter_name: 'prompt', python_type: { type: 'str' } },
      ...(video ? [{ parameter_name: 'image', python_type: { type: 'dict(path: str | None (Path to a local file))' } }, { parameter_name: 'duration_seconds', python_type: { type: 'float' }, parameter_has_default: true, parameter_default: 3 }] : []),
      { parameter_name: 'seed', python_type: { type: 'float' }, parameter_has_default: true, parameter_default: 42 },
    ];
    return void res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ named_endpoints: { '/generate': { parameters, returns: [{ python_type: { type: 'filepath' } }, { python_type: { type: 'str' } }] } } }));
  }
  if (rest === 'upload') {
    stub.hfSeen.push({ space, what: 'upload', auth, data: raw.length });
    return void res.writeHead(200, { 'Content-Type': 'application/json' }).end('["/tmp/gradio/up/first.png"]');
  }
  const call = /^call\/([\w-]+)(?:\/(\w+))?$/.exec(rest);
  if (call && req.method === 'POST') {
    stub.hfSeen.push({ space, what: `call ${call[1]}`, auth, data: JSON.parse(raw.toString() || '{}').data });
    return void res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"event_id":"ev1"}');
  }
  if (call) {
    if (mode === 'down') return void res.writeHead(503, { 'Content-Type': 'text/html' }).end('<h1>Space is sleeping</h1>');
    if (mode === 'quota') return void res.writeHead(200, { 'Content-Type': 'text/event-stream' }).end('event: error\ndata: "You have exceeded your GPU quota (90s requested vs. 20s left). Try again in 0:10:00"\n\n');
    const ext = space.includes('video') ? 'mp4' : 'png';
    const url = `http://${req.headers.host}/hf/${space}/gradio_api/file=/tmp/gradio/out.${ext}`;
    return void res.writeHead(200, { 'Content-Type': 'text/event-stream' }).end(`event: heartbeat\ndata: null\n\nevent: complete\ndata: [{"path": "/tmp/gradio/out.${ext}", "url": "${url}"}, "report"]\n\n`);
  }
  if (rest.startsWith('file=')) {
    stub.hfSeen.push({ space, what: 'file', auth });
    return void res.writeHead(200, { 'Content-Type': rest.endsWith('.mp4') ? 'video/mp4' : 'image/png' }).end(rest.endsWith('.mp4') ? MP4 : PNG);
  }
  res.writeHead(404).end();
}
let stubServer: http.Server;
let stubPort = 0;
let app: ChildProcess | null = null;
let runsDir = '';

function stubAnswer(prompt: string, url = ''): { status: number; body: any } {
  if (prompt.startsWith('Speak in a punchy')) {
    stub.log.push('tts-call');
    if (stub.tts === 'perday') return { status: 429, body: PERDAY };
    const pcm = Buffer.alloc(24000 * 2); // one second of silence, raw 16-bit mono like the real endpoint
    return { status: 200, body: { candidates: [{ content: { role: 'model', parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: pcm.toString('base64') } }] }, finishReason: 'STOP' }], usageMetadata: {} } };
  }
  if (/image/.test(url)) {
    stub.log.push('gemini-image-call');
    return { status: 429, body: LIMIT0 };
  }
  if (stub.overloaded) {
    stub.log.push('overloaded-call');
    return { status: 503, body: { error: { code: 503, status: 'UNAVAILABLE', message: 'This model is currently experiencing high demand.' } } };
  }
  let out: any;
  let tag: string;
  if (prompt.includes('preparing a research dossier')) {
    tag = 'research';
    out = {
      topicTitle: 'T', oneLineHook: 'h', summary: 's', coreTechExplanation: 'c',
      hnCommunitySentiment: { consensus: 'none', contrarianView: 'none', topHnComments: [] },
      infotainmentAngles: [{ title: 'a', hook: 'h', whyItGoesViral: 'w' }], keyFacts: ['f'], timeline: [{ dateOrPhase: 'p', event: 'e' }], groundingSources: [],
    };
  } else if (prompt.includes('production designer')) {
    tag = 'bible';
    out = { characterBible: [{ id: 'a', name: 'A', role: 'analyst', appearance: 'x', wardrobe: 'w', palette: 'p', promptAnchor: 'ANCHOR' }], styleGuide: { artDirection: 'noir', colorPalette: 'c', lighting: 'l', lensAndFilm: 'f', negativePrompt: 'n' } };
  } else if (prompt.includes('music supervisor')) {
    tag = 'score';
    out = { musicCues: [{ cueId: 'm1', startScene: 1, endScene: 2, role: 'cold-open', mood: 'urgent', tempoBpm: 96, instruments: 'low pulse', intensity: 2, entry: 'sting', exit: 'cut-to-silence', searchTerms: ['suspense pulse'] }] };
  } else if (prompt.includes('sound designer and picture editor')) {
    const nums = [...prompt.matchAll(/"sceneNumber": (\d+)/g)].map((m) => Number(m[1]));
    tag = `sound@${nums[0]}`;
    out = { scenes: nums.map((n) => ({ sceneNumber: n, sfxCue: n === 2 ? '[SFX: lock clunk + sub-bass]' : '', sfxOnWord: n === 2 ? 'word' : '', sfxSearchTerms: n === 2 ? ['deadbolt lock'] : [], ambience: '', silenceBeforeSec: 0, transitionIn: n === 3 ? 'dissolve' : 'Hard Cut', transitionReason: n === 3 ? 'time passes' : 'continuous', audioBridge: 'none' })) };
  } else if (prompt.includes('art director and cinematographer')) {
    const nums = [...prompt.matchAll(/"sceneNumber": (\d+)/g)].map((m) => Number(m[1]));
    tag = `art@${nums[0]}`;
    out = { scenes: nums.map((n) => ({ sceneNumber: n, visual: { character: 'c', background: 'b', scene: `s${n}`, styleAnchor: 'STYLE', negative: 'n' }, motion: { shotType: 's', cameraMove: 'm', subjectMotion: 'x', durationSec: 10, easing: 'e', transitionOut: 't', motionPrompt: 'p' }, citations: [], charactersInFrame: [], locationId: `loc${n}` })) };
  } else if (!/Write EXACTLY (\d+) new scenes/.test(prompt)) {
    // Fail loudly rather than leave the request hanging if a new prompt kind appears.
    return { status: 400, body: { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'e2e stub does not recognise this prompt' } } };
  } else {
    const count = Number(prompt.match(/Write EXACTLY (\d+) new scenes/)![1]);
    const at = Number(prompt.match(/starting at (\d+)/)![1]);
    tag = `narr@${at}`;
    if (stub.failNarrFrom && at >= stub.failNarrFrom) {
      if (stub.log[stub.log.length - 1] !== tag) stub.log.push(tag);
      return { status: 429, body: PERDAY };
    }
    out = { scenes: Array.from({ length: count }, (_, i) => ({ sceneNumber: at + i, title: `S${at + i}`, actPhase: at + i === 1 ? 'Hook' : 'Technical Breakdown', narration: stub.cveInScene1 && at + i === 1 ? `It was tracked as CVE-2024-3094. ${'word '.repeat(26).trim()}` : 'word '.repeat(30).trim(), durationEst: 10, visualPrompt: 'vp', visualType: 'terminal', onScreenText: stub.cveInScene1 && at + i === 1 ? 'CVE-2024-3094' : 'x', soundEffect: 'y', ...(stub.cveInScene1 && at + i === 1 ? { infographic: { type: 'threat_scorecard', title: 'T', badge: 'CVE-2024-3094 RESOLVED', summary: 'The lifecycle of CVE-2024-3094 shows the gap.' } } : {}) })) };
  }
  if (stub.log[stub.log.length - 1] !== tag) stub.log.push(tag);
  return { status: 200, body: { candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify(out) }] }, finishReason: 'STOP' }], usageMetadata: {} } };
}

before(async () => {
  runsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cp-e2e-runs-'));
  rendersDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cp-e2e-renders-'));
  stubServer = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      if (req.url?.startsWith('/hf/')) return hfStub(req, Buffer.concat(chunks), res);
      const raw = Buffer.concat(chunks).toString();
      const body = JSON.parse(raw || '{}');
      const prompt = (body.contents || []).flatMap((c: any) => (c.parts || []).map((p: any) => p.text || '')).join('');
      if (stub.delayMs) await new Promise((r) => setTimeout(r, stub.delayMs));
      if (req.url?.startsWith('/prompt/')) {
        // Stands in for Pollinations (POLLINATIONS_BASE_URL): a PNG when up, an error page when down.
        stub.log.push('pollinations-call');
        if (stub.pollinations === 'ok') {
          const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(2048)]);
          return void res.writeHead(200, { 'Content-Type': 'image/png' }).end(png);
        }
        return void res.writeHead(500, { 'Content-Type': 'text/plain' }).end('down');
      }
      const { status, body: out } = stubAnswer(prompt, req.url);
      res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(out));
    });
  });
  await new Promise<void>((r) => stubServer.listen(0, '127.0.0.1', r));
  stubPort = (stubServer.address() as any).port;
});
after(async () => {
  await stopApp();
  stubServer.close();
  await fs.rm(runsDir, { recursive: true, force: true });
  await fs.rm(rendersDir, { recursive: true, force: true });
});

async function startApp() {
  app = spawn('npx', ['tsx', 'server.ts'], {
    cwd: REPO,
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, PORT: String(APP_PORT), GEMINI_API_KEY: 'stub-key', LLM_PROVIDER_ORDER: 'gemini', LLM_MODEL_ORDER: '', GOOGLE_GEMINI_BASE_URL: `http://127.0.0.1:${stubPort}`, POLLINATIONS_BASE_URL: `http://127.0.0.1:${stubPort}`, CONTENTPIPE_RUNS_DIR: runsDir,
      // Media: one stub Space, then Gemini's (limit 0) image model, then Pollinations — every rung the chain can take.
      HF_SPACE_BASE_URL: `http://127.0.0.1:${stubPort}/hf`, HF_TOKEN: 'hf_e2e', CONTENTPIPE_RENDERS_DIR: rendersDir,
      HF_TOKEN_SPACE_OWNERS: 'e2e', IMAGE_PROVIDER_ORDER: 'hf:e2e/image-space,gemini:gemini-3.1-flash-image,pollinations', VIDEO_PROVIDER_ORDER: 'hf:e2e/video-a,hf:e2e/video-b' },
  });
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`${APP}/api/health`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('app did not start');
}
async function stopApp() {
  if (!app?.pid) return;
  try { process.kill(-app.pid, 'SIGKILL'); } catch {}
  app = null;
  await new Promise((r) => setTimeout(r, 300));
}
async function restartApp() {
  await stopApp();
  await startApp();
}
async function post(pathname: string, body: unknown, strict = false) {
  const res = await fetch(APP + pathname, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(strict ? { 'X-ContentPipe-Strict': '1' } : {}) }, body: JSON.stringify(body) });
  return { status: res.status, headers: res.headers, body: (await res.json()) as any };
}
const SCRIPT_REQ = {
  videoPlan: { title: 'T', tone: 'Deep Dive Documentary', targetDurationSec: 60, format: '16:9' },
  researchData: { topicTitle: 'T', summary: 's', retrievedSources: [] },
  channelBrandName: 'Blast Radius',
};
const reset = (over: Partial<typeof stub> = {}) => Object.assign(stub, { failNarrFrom: 0, overloaded: false, delayMs: 0, cveInScene1: false, log: [], tts: 'ok', pollinations: 'fail', hf: {}, hfSeen: [] }, over);

/** Independent of server/quota.ts: seconds until the next 00:00 in America/Los_Angeles. */
function secondsToNextPacificMidnight(): number {
  const now = new Date();
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hourCycle: 'h23', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(now).filter((p) => p.type !== 'literal').map((p) => [p.type, Number(p.value)]));
  return 86400 - (parts.hour * 3600 + parts.minute * 60 + parts.second); // valid except on the two DST-transition days
}

test('STRICT: a daily-quota hit mid-script answers 429 + Retry-After with runId/progress — never a truncated or canned script', async () => {
  reset({ failNarrFrom: 4 });
  await startApp();
  const r = await post('/api/script', SCRIPT_REQ, true);
  assert.equal(r.status, 429);
  assert.ok(Math.abs(Number(r.headers.get('retry-after')) - secondsToNextPacificMidnight()) <= 10 || Math.abs(Number(r.headers.get('retry-after')) - secondsToNextPacificMidnight()) >= 3500, 'Retry-After ≈ next midnight Pacific (an hour off is tolerated only on DST days)');
  assert.equal(r.body.kind, 'per_day');
  assert.equal(r.body.retryable, true);
  assert.deepEqual(r.body.progress, { hasProductionBible: true, narrativeChunksDone: 1, artChunksDone: 0, soundChunksDone: 0, scenesSoFar: 3 });
  assert.ok(r.body.runId);
  assert.equal(r.body.scenes, undefined);
  assert.deepEqual(stub.log, ['bible', 'narr@1', 'narr@4']);
});

test('CRASH: kill -9, restart, quota reset → the identical request resumes and re-spends ONLY the unfinished calls', async () => {
  // Continues the previous scenario: the journal it left in runsDir must survive the crash.
  assert.ok((await fs.readdir(runsDir)).some((f) => f.endsWith('.json')), 'journal on disk before the crash');
  await stopApp(); // SIGKILL — no graceful shutdown
  reset();
  await startApp();
  const r = await post('/api/script', SCRIPT_REQ, true);
  assert.equal(r.status, 200);
  assert.deepEqual(stub.log, ['narr@4', 'art@1', 'score', 'sound@1'], 'bible and the first chunk must not be requested again');
  assert.equal(r.body.scenes.length, 5);
  assert.ok(r.body.scenes.every((s: any) => s.visual && s.motion));
  assert.equal(r.body.generation.complete, true);
  assert.equal(r.body.generation.resumed, true);
  assert.deepEqual(r.body.scenes.map((s: any) => s.sceneNumber), [1, 2, 3, 4, 5]);
  assert.equal(r.body.signatureIntro, '', 'documentary tone opens cold — no "Welcome back"');
  // MODEL PROVENANCE: the calls the crashed request made are kept in the journal and replayed, marked as such.
  const usage: any[] = r.body.modelUsage;
  assert.deepEqual(
    usage.map((c) => [c.task, !!c.fromCheckpoint, c.ok]),
    [
      ['Production bible (cast + style guide)', true, true],
      ['Narrative, scenes 1-3 (chunk 1/2)', true, true],
      ['Narrative, scenes 4-5 (chunk 2/2)', false, true],
      ['Art direction, scenes 1-5 (chunk 1/1)', false, true],
      ['Music plan (score)', false, true],
      ['Sound & edit, scenes 1-5 (chunk 1/1)', false, true],
    ]
  );
  assert.ok(usage.every((c) => c.provider === 'gemini' && c.model), 'each call names the model that answered');
});

test('REGENERATE after delivery starts a fresh run instead of replaying the delivered one', async () => {
  await new Promise((r) => setTimeout(r, 300)); // markDelivered runs on the response "finish" event
  reset();
  const r = await post('/api/script', SCRIPT_REQ, true);
  assert.equal(r.status, 200);
  assert.deepEqual(stub.log, ['bible', 'narr@1', 'narr@4', 'art@1', 'score', 'sound@1']);
  assert.ok(!r.body.generation.resumed);
});

test('UI path (no strict header): the same fault still returns 200 with a partial script, disclosed in generation', async () => {
  await stopApp();
  await fs.rm(runsDir, { recursive: true, force: true });
  reset({ failNarrFrom: 4 });
  await startApp();
  const r = await post('/api/script', SCRIPT_REQ, false);
  assert.equal(r.status, 200);
  assert.equal(r.body.scenes.length, 3);
  assert.equal(r.body.generation.complete, false);
  assert.ok(r.body.generation.degraded.some((d: string) => /stops at 3\/5/.test(d)));
  assert.ok(r.body.qualityChecks.some((c: any) => c.id === 'generation-incomplete' && c.severity === 'error'));
});

test('STRICT + overload: 503 + Retry-After after one bounded wait; the UI path gets its usual canned fallback', async () => {
  await stopApp();
  reset({ overloaded: true });
  await startApp();
  const t0 = Date.now();
  const strict = await post('/api/research', { messageText: 'no links here' }, true);
  assert.equal(strict.status, 503);
  assert.equal(strict.headers.get('retry-after'), '30');
  assert.ok(Date.now() - t0 >= 7000, 'waited the 8 s overload pause once before giving up');
  // Every model in TEXT_MODELS is tried once per pass, and there are two passes (the wait sits between them).
  assert.equal(stub.log.filter((l) => l === 'overloaded-call').length, TEXT_MODELS.length * 2, `${TEXT_MODELS.length} tiers x 2 passes`);
  const ui = await post('/api/research', { messageText: 'no links here' }, false);
  assert.equal(ui.status, 200);
  assert.equal(ui.body.isQuotaFallback, true);
});

test('CONCURRENCY: an identical request while the first run is in flight gets 409, not a second run', async () => {
  await stopApp();
  await fs.rm(runsDir, { recursive: true, force: true });
  reset({ delayMs: 800 });
  await startApp();
  const first = post('/api/script', SCRIPT_REQ, true);
  await new Promise((r) => setTimeout(r, 1200));
  const second = await post('/api/script', SCRIPT_REQ, true);
  assert.equal(second.status, 409);
  assert.equal(second.body.kind, 'in_progress');
  const done = await first;
  assert.equal(done.status, 200);
  assert.equal(done.body.generation.complete, true);
});

test('SSRF: internal URLs are refused and never fetched; a bad runId is rejected instead of becoming a filename', async () => {
  await stopApp();
  reset();
  await startApp();
  const r = await post('/api/research', { messageText: 'story', sourceUrls: ['http://169.254.169.254/latest/meta-data/', 'http://localhost:3192/api/health'] }, false);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.retrievedSources.map((s: any) => s.ok), [false, false]);
  assert.ok(r.body.retrievedSources.every((s: any) => /^Blocked:/.test(s.error)), JSON.stringify(r.body.retrievedSources));
  const bad = await post('/api/script', { ...SCRIPT_REQ, runId: '../../etc/passwd' }, false);
  assert.equal(bad.status, 400);
});

test('STRICT TTS: a spent daily quota answers 429 + Retry-After, never the synthesized tone; the UI path still gets the tone, flagged', async () => {
  await stopApp();
  reset({ tts: 'perday' });
  await startApp();
  const strict = await post('/api/tts', { text: 'hello there' }, true);
  assert.equal(strict.status, 429);
  assert.equal(strict.body.kind, 'per_day');
  assert.equal(strict.body.retryable, true);
  assert.ok(Number(strict.headers.get('retry-after')) > 0);
  assert.equal(strict.body.audioBase64, undefined);
  const ui = await post('/api/tts', { text: 'hello there' }, false);
  assert.equal(ui.status, 200);
  assert.equal(ui.body.isQuotaFallback, true);
  assert.ok(ui.body.audioBase64.length > 0);
});

test('STRICT TTS: healthy TTS returns real audio for both callers, unflagged', async () => {
  await stopApp();
  reset();
  await startApp();
  for (const strict of [true, false]) {
    const r = await post('/api/tts', { text: 'hello there' }, strict);
    assert.equal(r.status, 200);
    assert.equal(r.body.isQuotaFallback, undefined);
    assert.equal(Buffer.from(r.body.audioBase64, 'base64').length, 48000);
    assert.equal(r.body.sampleRate, 24000);
  }
});

test('STRICT image: Space asleep, no Gemini image quota and Pollinations down → 503 + Retry-After, not a placeholder; the UI path still gets the placeholder', async () => {
  await stopApp();
  reset({ pollinations: 'fail' });
  await startApp();
  const strict = await post('/api/generate-image', { prompt: 'a server room' }, true);
  assert.equal(strict.status, 503);
  assert.equal(strict.headers.get('retry-after'), '30');
  assert.equal(strict.body.kind, 'upstream_unavailable');
  assert.match(strict.body.error, /hf e2e\/image-space: .*gemini gemini-3\.1-flash-image: .*pollinations: /s);
  assert.equal(strict.body.imageUrl, undefined);
  const ui = await post('/api/generate-image', { prompt: 'a server room' }, false);
  assert.equal(ui.status, 200);
  assert.equal(ui.body.isPlaceholder, true);
});

test('STRICT image: Pollinations up → a real, labelled image; strict does not reject the fallback provider', async () => {
  await stopApp();
  reset({ pollinations: 'ok' });
  await startApp();
  const r = await post('/api/generate-image', { prompt: 'a server room' }, true);
  assert.equal(r.status, 200);
  assert.equal(r.body.provider, 'pollinations');
  assert.equal(r.body.isPlaceholder, false);
  assert.match(r.body.imageUrl, /^data:image\/png;base64,/);
});

test('IMAGE via a Hugging Face Space: first in IMAGE_PROVIDER_ORDER, labelled with the Space, token sent as x-hf-authorization', async () => {
  await stopApp();
  reset({ hf: { 'e2e/image-space': 'ok' } });
  await startApp();
  const r = await post('/api/generate-image', { prompt: 'a server room', aspectRatio: '9:16' }, true);
  assert.equal(r.status, 200);
  assert.equal(r.body.provider, 'hf');
  assert.equal(r.body.model, 'e2e/image-space');
  assert.match(r.body.imageUrl, /^data:image\/png;base64,/);
  assert.equal(r.body.strictError, undefined, 'the internal strict error never reaches the client');
  const call = stub.hfSeen.find((x) => x.what.startsWith('call'));
  assert.equal(call?.auth, 'Bearer hf_e2e');
  assert.equal(call?.data?.[0], 'a server room');
  assert.equal(r.body.modelUsage.at(-1).model, 'e2e/image-space');
});

test('VIDEO: the still is uploaded, the first Space answers, the clip is saved and served from /clips/', async () => {
  await stopApp();
  reset({ hf: { 'e2e/video-a': 'ok' } });
  await startApp();
  const imageUrl = `data:image/png;base64,${PNG.toString('base64')}`;
  const r = await post('/api/generate-video', { imageUrl, prompt: 'The analyst looks up. Static camera.', durationSec: 5 }, true);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.model, 'e2e/video-a');
  assert.match(r.body.videoUrl, /^\/clips\/.+\.mp4$/);
  assert.ok(stub.hfSeen.some((x) => x.space === 'e2e/video-a' && x.what === 'upload' && x.data > PNG.length));
  const clip = await fetch(APP + r.body.videoUrl);
  assert.equal(clip.status, 200);
  assert.equal(Buffer.from(await clip.arrayBuffer()).subarray(4, 8).toString(), 'ftyp');
  assert.equal(r.body.modelUsage.at(-1).kind, 'video');
});

test('VIDEO: the first Space out of GPU quota falls through to the next; every Space out → 429 with the quota reset', async () => {
  await stopApp();
  reset({ hf: { 'e2e/video-a': 'quota', 'e2e/video-b': 'ok' } });
  await startApp();
  const imageUrl = `data:image/png;base64,${PNG.toString('base64')}`;
  const fell = await post('/api/generate-video', { imageUrl, prompt: 'p' }, true);
  assert.equal(fell.status, 200);
  assert.equal(fell.body.model, 'e2e/video-b');
  assert.match(fell.body.attempts[0].error, /GPU quota/);
  await stopApp();
  reset({ hf: { 'e2e/video-a': 'quota', 'e2e/video-b': 'quota' } });
  await startApp();
  const out = await post('/api/generate-video', { imageUrl, prompt: 'p' }, true);
  assert.equal(out.status, 429);
  assert.equal(out.headers.get('retry-after'), '600');
  const ui = await post('/api/generate-video', { imageUrl, prompt: 'p' }, false);
  assert.equal(ui.status, 502, 'there is no fallback clip for the UI either');
  assert.match(ui.body.error, /cooling down/);
  const svg = await post('/api/generate-video', { imageUrl: 'data:image/svg+xml;base64,PHN2Zy8+', prompt: 'p' }, true);
  assert.equal(svg.status, 400, 'a placeholder still is refused before any GPU is spent');
});

test('TWO VOICES: /api/script keeps the pipeline-assigned speaker on every scene (server.ts rebuilds scenes from a fixed field list)', async () => {
  await stopApp();
  reset();
  await startApp();
  // 200 s → 17 scenes: the analyst speaks scenes 6 and 12 (shared/speakers.ts); the narrator opens and closes.
  const r = await post('/api/script', { ...SCRIPT_REQ, videoPlan: { ...SCRIPT_REQ.videoPlan, targetDurationSec: 200 } }, true);
  assert.equal(r.status, 200);
  assert.equal(r.body.scenes.length, 17);
  assert.ok(r.body.scenes.every((s: any) => s.speaker === 'narrator' || s.speaker === 'analyst'), 'every scene carries a speaker in the HTTP response');
  assert.deepEqual(r.body.scenes.filter((s: any) => s.speaker === 'analyst').map((s: any) => s.sceneNumber), [6, 12]);
  assert.equal(r.body.scenes[0].speaker, 'narrator');
  assert.equal(r.body.scenes[16].speaker, 'narrator');
  assert.equal((r.body.qualityChecks || []).find((c: any) => c.id === 'analyst-scene-too-long'), undefined);
});

test('SOUND: /api/script carries the music plan and each scene\'s sound & edit direction, enforced, and opens without an intro line', async () => {
  await stopApp();
  reset();
  await startApp();
  const r = await post('/api/script', { ...SCRIPT_REQ, runId: 'sound-contract', fresh: true }, true);
  assert.equal(r.status, 200);
  const sc: any[] = r.body.scenes;
  assert.equal(r.body.signatureIntro, '', 'every tone opens cold on the hook');
  assert.equal(r.body.musicCues.length, 1);
  assert.deepEqual([r.body.musicCues[0].startScene, r.body.musicCues[0].endScene], [1, 2]);
  assert.ok(sc.every((s) => s.sound), 'every scene carries sound & edit direction in the HTTP response');
  assert.equal(sc[1].sound.sfxCue, 'lock clunk', 'a stacked effect is cut to one sound');
  assert.equal(sc[1].soundEffect, 'lock clunk');
  assert.equal(sc[0].soundEffect, '', 'no effect is a valid answer, not a gap filled with a default');
  assert.equal(sc[2].sound.transitionIn, 'dissolve');
  assert.equal(sc[1].motion.transitionOut, 'dissolve', 'transitionOut is the next scene\'s transitionIn');
  assert.equal(sc[3].sound.transitionIn, 'cut', '"Hard Cut" is normalised onto the closed list');
  assert.equal(sc[sc.length - 1].motion.transitionOut, 'fade-to-black');
  assert.equal(r.body.generation.complete, true);
});

test('CVE SCRUB: a CVE id the model wrote into narration, on-screen text or an infographic never reaches the client — it is replaced and disclosed', async () => {
  await stopApp();
  reset({ cveInScene1: true });
  await startApp();
  // Its own run id, forced fresh: SCRIPT_REQ is shared with earlier tests, and a finished journal one of them left behind
  // (its server killed before the delivered journal was dropped) would be served here instead of generating this script.
  const r = await post('/api/script', { ...SCRIPT_REQ, runId: 'cve-scrub', fresh: true }, true);
  assert.equal(r.status, 200);
  assert.ok(!/CVE-\d{4}-\d+/.test(JSON.stringify(r.body.scenes)), 'no CVE id anywhere in the delivered scenes');
  const s1 = r.body.scenes[0];
  assert.match(s1.narration, /tracked as the flaw\./);
  assert.equal(s1.onScreenText, 'THE FLAW');
  assert.equal(s1.infographic.badge, 'THE FLAW RESOLVED');
  assert.equal(s1.infographic.summary, 'The lifecycle of the flaw shows the gap.');
  const checks: any[] = r.body.qualityChecks || [];
  assert.deepEqual(checks.find((c) => c.id === 'cve-ids-replaced')?.sceneNumbers, [1], 'the replacement is disclosed, not silent');
  assert.equal(checks.find((c) => c.id === 'severity-rating-shown'), undefined, 'nothing left for the audit to flag');
});
