import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  SpaceError,
  callSpace,
  classifySpaceFailure,
  decodeDataUrl,
  downloadSpaceFile,
  fileRef,
  parseGradioEvents,
  parseSpaceRetrySec,
  reduceSpaceFailures,
  spaceHost,
} from './hfSpace';
import { QuotaExhaustedError, UpstreamUnavailableError } from './quota';
import { parseMediaOrder, coolSpace, spaceCooldown, clearSpaceCooldowns, tokenAllowedFor } from './mediaOrder';
import { genericAdapter, IMAGE_ADAPTERS, VIDEO_ADAPTERS, sniffImage, sniffVideo } from './spaceAdapters';
import { nanoBananaProPrompt } from '../shared/nanoBananaPrompt';

test('Gradio event stream: complete returns outputs; heartbeats and progress are skipped', () => {
  const body = 'event: heartbeat\ndata: null\n\nevent: generating\ndata: [null]\n\nevent: complete\ndata: [{"path": "/tmp/x.png", "url": "https://h/gradio_api/file=/tmp/x.png"}, 42]\n\n';
  const out = parseGradioEvents(body);
  assert.equal((out[0] as any).path, '/tmp/x.png');
  assert.equal(out[1], 42);
});

test('Gradio event stream: an error event becomes a classified SpaceError', () => {
  assert.throws(
    () => parseGradioEvents('event: error\ndata: "You have exceeded your GPU quota (60s requested vs. 12s left). Try again in 1:02:03"\n\n'),
    (e: any) => e instanceof SpaceError && e.classified.kind === 'per_day' && e.classified.retryAfterSec === 3723
  );
  // Captured live 2026-09-26 (MiniMax-H3 Space, no token): the message arrives wrapped and single-quoted.
  assert.throws(
    () => parseGradioEvents(`event: error\ndata: {"error":"'You have exceeded your ZeroGPU quota (146s requested vs. 62s left). Try again in 23:59:09. Authenticate with a Hugging Face token for more quota - https://huggingface.co/settings/tokens'","visible":true}\n\n`),
    (e: any) => e.classified.kind === 'per_day' && e.classified.retryAfterSec === 86349 && e.message.startsWith('You have exceeded your ZeroGPU quota (146s')
  );
  assert.throws(() => parseGradioEvents('event: error\ndata: null\n\n'), (e: any) => e instanceof SpaceError && e.classified.kind === 'transient' && /without saying why/.test(e.message));
  assert.throws(() => parseGradioEvents(''), /without a result/);
});

test('Space failures are classified like provider errors', () => {
  assert.equal(parseSpaceRetrySec('Try again in 0:02:15'), 135);
  assert.equal(parseSpaceRetrySec('please retry in 45s'), 45);
  assert.equal(parseSpaceRetrySec('try again in 3 minutes'), 180);
  assert.deepEqual(classifySpaceFailure('ZeroGPU quota exceeded. Try again in 0:05:00'), { kind: 'per_minute', retryAfterSec: 300, status: undefined });
  assert.equal(classifySpaceFailure('You have exceeded your free GPU quota').kind, 'per_day');
  assert.equal(classifySpaceFailure('No GPU was available after 60s. Retry later').kind, 'transient');
  assert.equal(classifySpaceFailure('The shared ZeroGPU pool is at capacity right now').kind, 'transient');
  assert.equal(classifySpaceFailure('', 503).kind, 'transient');
  assert.equal(classifySpaceFailure('', 429).kind, 'per_minute');
  assert.equal(classifySpaceFailure('This prompt was flagged by a content filter').kind, 'other');
});

test('a chain that failed on quota everywhere is a 429 with the earliest reset; busy anywhere is a 503; hard errors surface as themselves', () => {
  const q1 = new SpaceError('a', { kind: 'per_day', retryAfterSec: 7200 });
  const q2 = new SpaceError('b', { kind: 'per_minute', retryAfterSec: 300 });
  const busy = new SpaceError('c', { kind: 'transient', retryAfterSec: 60 });
  const hard = new SpaceError('d', { kind: 'other' });
  const r1: any = reduceSpaceFailures([q1, q2, hard], 'x');
  assert.ok(r1 instanceof QuotaExhaustedError);
  assert.equal(r1.retryAfterSec, 300);
  assert.ok(reduceSpaceFailures([q1, busy], 'x') instanceof UpstreamUnavailableError);
  assert.equal(reduceSpaceFailures([hard], 'x'), hard);
  assert.match((reduceSpaceFailures([], 'nothing configured') as Error).message, /nothing configured/);
});

test('provider orders: hf ids, gemini models and pollinations parse; junk and disallowed providers are rejected', () => {
  const { entries, rejected } = parseMediaOrder('hf:Qwen/Qwen-Image-2512, gemini:gemini-3-pro-image ,pollinations, hf:not-a-space, openai:gpt-image, ', ['hf', 'gemini', 'pollinations']);
  assert.deepEqual(entries.map((e) => `${e.provider}:${e.model}`), ['hf:Qwen/Qwen-Image-2512', 'gemini:gemini-3-pro-image', 'pollinations:default']);
  assert.deepEqual(rejected, ['hf:not-a-space', 'openai:gpt-image']);
  assert.deepEqual(parseMediaOrder('gemini:veo-3.1', ['hf']).rejected, ['gemini:veo-3.1'], 'video takes Spaces only');
});

test('HF_TOKEN goes only to Spaces of trusted owners; adult/uncensored Spaces are refused from the order', () => {
  assert.ok(tokenAllowedFor('MiniMaxAI/MiniMax-H3-Turbo-Lora', {}));
  assert.ok(tokenAllowedFor('zerogpu-aoti/wan2-2-fp8da-aoti-faster', {}));
  assert.equal(tokenAllowedFor('observantdistressed/wan2-2-i2v-v3', {}), false);
  assert.equal(tokenAllowedFor('Pepe104/MiniMax-H3-Turbo-Lora-UNCENSORED', {}), false);
  assert.ok(tokenAllowedFor('someone/space', { HF_TOKEN_SPACE_OWNERS: 'someone' }));
  const { entries, rejected } = parseMediaOrder('hf:Pepe104/MiniMax-H3-Turbo-Lora-UNCENSORED,hf:laruss5/z-image-nsfw,hf:MiniMaxAI/MiniMax-H3-Turbo-Lora', ['hf']);
  assert.deepEqual(entries.map((e) => e.model), ['MiniMaxAI/MiniMax-H3-Turbo-Lora']);
  assert.equal(rejected.length, 2);
});

test('a Space that failed is skipped for a while: quota until its reset, busy for 2 min, a hard error for 30 min', () => {
  clearSpaceCooldowns();
  const now = 1_000_000;
  coolSpace('a/q', new SpaceError('quota', { kind: 'per_minute', retryAfterSec: 300 }), now);
  coolSpace('a/b', new SpaceError('busy', { kind: 'transient', retryAfterSec: 60 }), now);
  coolSpace('a/h', new SpaceError('gone', { kind: 'other' }), now);
  assert.ok(spaceCooldown('a/q', now + 299_000));
  assert.equal(spaceCooldown('a/q', now + 301_000), undefined);
  assert.equal(spaceCooldown('a/b', now + 121_000), undefined);
  assert.ok(spaceCooldown('a/h', now + 29 * 60_000));
  clearSpaceCooldowns();
});

test('spaceHost refuses a malformed id and honours HF_SPACE_BASE_URL', async () => {
  await assert.rejects(spaceHost('../../etc', {}), /not a Hugging Face Space id/);
  assert.equal(await spaceHost('Qwen/Qwen-Image-2512', { HF_SPACE_BASE_URL: 'http://127.0.0.1:9/' }), 'http://127.0.0.1:9/Qwen/Qwen-Image-2512');
});

test('output files: FileData, gr.Video wrappers and gallery items all resolve; files on another host are refused', async () => {
  assert.equal(fileRef({ path: '/a.mp4' })?.path, '/a.mp4');
  assert.equal(fileRef({ video: { path: '/v.mp4', url: 'u' }, subtitles: null })?.url, 'u');
  assert.equal(fileRef([{ image: { path: '/g.png' } }])?.path, '/g.png');
  assert.equal(fileRef(null), undefined);
  await assert.rejects(downloadSpaceFile('http://127.0.0.1:9', { url: 'http://169.254.169.254/latest/meta-data' }, 1000, {}), /another host/);
});

test('callSpace speaks the two-step call protocol and sends the token as x-hf-authorization', async () => {
  const seen: Record<string, string | undefined> = {};
  const server = http.createServer((req, res) => {
    seen[req.method + ' ' + req.url] = req.headers['x-hf-authorization'] as string;
    if (req.method === 'POST' && req.url === '/o/s/gradio_api/call/infer') return void res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"event_id":"e1"}');
    if (req.url === '/o/s/gradio_api/call/infer/e1') return void res.writeHead(200, { 'Content-Type': 'text/event-stream' }).end('event: complete\ndata: ["ok"]\n\n');
    if (req.url === '/o/s/gradio_api/call/gone') return void res.writeHead(404).end('nope');
    if (req.url === '/o/s/gradio_api/call/bounce') return void res.writeHead(302, { Location: 'http://127.0.0.1:9/steal' }).end();
    res.writeHead(500).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const host = `http://127.0.0.1:${(server.address() as AddressInfo).port}/o/s`;
  try {
    assert.deepEqual(await callSpace(host, '/infer', ['p'], 5000, { HF_TOKEN: 'hf_x' }), ['ok']);
    assert.equal(seen['POST /o/s/gradio_api/call/infer'], 'Bearer hf_x');
    await assert.rejects(callSpace(host, '/gone', [], 5000, {}), (e: any) => e instanceof SpaceError && /API changed/.test(e.message));
    // A redirect is refused, never followed with the token attached.
    await assert.rejects(callSpace(host, '/bounce', [], 5000, { HF_TOKEN: 'hf_x' }), /Refused a redirect/);
  } finally {
    server.close();
  }
});

test('named adapters put inputs in the positions each Space expects and clamp duration to its limits', async () => {
  const upload = async (_f: any, name: string) => ({ path: `/up/${name}`, meta: { _type: 'gradio.FileData' as const } });
  const ctx = { upload, apiInfo: async () => ({}) };
  const q = await IMAGE_ADAPTERS['Qwen/Qwen-Image-2512'].build({ prompt: 'P', aspectRatio: '9:16' }, ctx);
  assert.deepEqual([q.endpoint, q.data[0], q.data[3], q.data[6]], ['/infer', 'P', '9:16', false]);
  const image = { bytes: Buffer.alloc(10), contentType: 'image/png' };
  const h3 = await VIDEO_ADAPTERS['MiniMaxAI/MiniMax-H3-Turbo-Lora'].build({ prompt: 'M', image, durationSec: 30, aspectRatio: '16:9' }, ctx);
  assert.equal(h3.endpoint, '/output_video');
  assert.equal(h3.data[0], 'M');
  assert.equal((h3.data[1] as any).path, '/up/first-frame.png');
  assert.equal(h3.data[3], '960x544 · 16:9 fast');
  assert.equal(h3.durationSec, 14);
  const wan = await VIDEO_ADAPTERS['zerogpu-aoti/wan2-2-fp8da-aoti-faster'].build({ prompt: 'M', image, durationSec: 8, aspectRatio: '16:9' }, ctx);
  assert.equal((wan.data[0] as any).path, '/up/input.png');
  assert.equal(wan.data[4], 5);
});

test('the generic adapter fills a new Space by parameter name, and refuses a parameter it cannot fill', async () => {
  const info = {
    named_endpoints: {
      '/predict': {
        parameters: [
          { parameter_name: 'prompt', python_type: { type: 'str' } },
          { parameter_name: 'negative_prompt', python_type: { type: 'str' }, parameter_has_default: true, parameter_default: 'bad' },
          { parameter_name: 'image', python_type: { type: 'dict(path: str | None ...)' } },
          { parameter_name: 'aspect_ratio', python_type: { type: "Literal['1:1', '16:9']" }, parameter_has_default: true, parameter_default: '1:1' },
          { parameter_name: 'duration', python_type: { type: 'float' }, parameter_has_default: true, parameter_default: 3 },
          { parameter_name: 'randomize_seed', python_type: { type: 'bool' }, parameter_has_default: true, parameter_default: false },
        ],
        returns: [{ python_type: { type: 'float' } }, { python_type: { type: 'filepath' } }],
      },
    },
  };
  const ctx = { upload: async () => ({ path: '/up/i.png', meta: { _type: 'gradio.FileData' as const } }), apiInfo: async () => info };
  const call = await genericAdapter<any>('x/y', 'video').build({ prompt: 'P', image: { bytes: Buffer.alloc(1), contentType: 'image/png' }, durationSec: 4, aspectRatio: '16:9' }, ctx);
  assert.deepEqual(call.data, ['P', 'bad', { path: '/up/i.png', meta: { _type: 'gradio.FileData' } }, '16:9', 4, true]);
  assert.equal(call.outputIndex, 1);
  info.named_endpoints['/predict'].parameters.push({ parameter_name: 'mystery', python_type: { type: 'int' } } as any);
  await assert.rejects(genericAdapter<any>('x/y', 'video').build({ prompt: 'P', image: { bytes: Buffer.alloc(1), contentType: 'image/png' }, durationSec: 4, aspectRatio: '16:9' }, ctx), /needs an adapter/);
});

test('outputs are sniffed by bytes, not by label', () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(2000)]);
  assert.equal(sniffImage(png), 'image/png');
  assert.equal(sniffImage(Buffer.from('<html>error</html>'.repeat(100))), undefined);
  const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypisom'), Buffer.alloc(5000)]);
  assert.equal(sniffVideo(mp4), 'video/mp4');
  assert.equal(sniffVideo(png), undefined);
  assert.equal(decodeDataUrl('data:image/png;base64,AAEC')?.bytes.length, 3);
  assert.equal(decodeDataUrl('https://x/y.png'), undefined);
});

test('the Nano Banana Pro prompt: character anchor first, style last, no negatives, no "no characters" line', () => {
  const p = nanoBananaProPrompt(
    { visualPrompt: 'flat', visual: { character: 'No characters in frame.', background: 'A dim server room', scene: 'Wide shot of racks', styleAnchor: 'cinematic 35mm, teal grade' } },
    '9:16'
  );
  assert.equal(p, 'Create a 9:16 portrait image. A dim server room. Wide shot of racks. cinematic 35mm, teal grade.');
  assert.equal(nanoBananaProPrompt({ visualPrompt: 'just this' }), 'Create a 16:9 landscape image. just this.');
  assert.equal(nanoBananaProPrompt({}), '');
});

test('image size is read from the real header: PNG, lossy WebP (what Qwen-Image-2512 returns), JPEG', async () => {
  const { imageSize } = await import('./imageProviders');
  const png = Buffer.alloc(32);
  png.write('\x89PNG', 0, 'latin1');
  png.writeUInt32BE(2560, 16);
  png.writeUInt32BE(1440, 20);
  assert.deepEqual(imageSize(png), { width: 2560, height: 1440 });
  const webp = Buffer.alloc(40);
  webp.write('RIFF', 0, 'latin1');
  webp.write('WEBPVP8 ', 8, 'latin1');
  webp.writeUInt16LE(1664, 26);
  webp.writeUInt16LE(928, 28);
  assert.deepEqual(imageSize(webp), { width: 1664, height: 928 });
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0, 0, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x40, 0x04, 0x00, 0, 0, 0]);
  assert.deepEqual(imageSize(jpg), { width: 1024, height: 576 });
  assert.equal(imageSize(Buffer.from('nope')), undefined);
});
