import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLOUDFLARE_MAX_PROMPT_CHARS, classifyCloudflareError, cloudflareDimensions, fitPrompt, isCloudflareImageModel, runCloudflareImage } from './cloudflareImage';
import { parseMediaOrder } from './mediaOrder';
import { SpaceError } from './hfSpace';

const ACCOUNT = 'a'.repeat(32);
const ENV = { CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: 'tok' };
// A tiny valid-looking PNG header padded past the 1 KB the sniffer requires.
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(2000)]);

test('only the commercially usable FLUX models are allowed, and they parse as image entries', () => {
  assert.ok(isCloudflareImageModel('flux-2-klein-4b') && isCloudflareImageModel('flux-1-schnell'));
  for (const bad of ['flux-2-klein-9b', 'flux-2-dev', '../x', '']) assert.equal(isCloudflareImageModel(bad), false, bad);
  const { entries, rejected } = parseMediaOrder('cloudflare:flux-2-klein-4b,cloudflare:flux-2-dev,hf:Qwen/Qwen-Image-2512', ['hf', 'cloudflare']);
  assert.deepEqual(entries.map((e) => `${e.provider}:${e.model}`), ['cloudflare:flux-2-klein-4b', 'hf:Qwen/Qwen-Image-2512']);
  assert.deepEqual(rejected, ['cloudflare:flux-2-dev']);
  assert.deepEqual(parseMediaOrder('cloudflare:flux-2-klein-4b', ['hf']).rejected, ['cloudflare:flux-2-klein-4b'], 'video takes Spaces only');
});

test('dimensions are multiples of 16 inside klein\'s 256-1920 range, and follow the aspect ratio', () => {
  for (const ratio of ['16:9', '9:16', '1:1', '4:3', '3:4']) {
    for (const edge of [undefined, '1920', '1024', 'junk']) {
      const { width, height } = cloudflareDimensions(ratio, edge ? { CLOUDFLARE_IMAGE_LONG_EDGE: edge } : {});
      assert.ok(width % 16 === 0 && height % 16 === 0 && width >= 256 && height >= 256 && width <= 1920 && height <= 1920, `${ratio} ${edge}: ${width}x${height}`);
    }
  }
  assert.deepEqual(cloudflareDimensions('16:9', {}), { width: 1536, height: 864 });
  assert.deepEqual(cloudflareDimensions('9:16', {}), { width: 864, height: 1536 });
  assert.deepEqual(cloudflareDimensions('16:9', { CLOUDFLARE_IMAGE_LONG_EDGE: '1920' }), { width: 1920, height: 1088 });
});

test('an over-long prompt is cut at a sentence end so the character anchor at the front survives', () => {
  const long = `Front anchor sentence. ${'A filler sentence that repeats. '.repeat(120)}`;
  const cut = fitPrompt(long);
  assert.ok(cut.length <= CLOUDFLARE_MAX_PROMPT_CHARS && cut.startsWith('Front anchor sentence.') && cut.endsWith('.'));
  assert.equal(fitPrompt('short prompt'), 'short prompt');
});

test('errors map to the cooldown classes: daily allowance, per-minute, auth, server, other', () => {
  const daily = classifyCloudflareError(429, '{"errors":[{"code":4006,"message":"you have used up your daily free allocation of 10,000 neurons"}]}');
  assert.equal(daily.classified.kind, 'per_day');
  assert.ok((daily.classified.retryAfterSec ?? 0) >= 60 && (daily.classified.retryAfterSec ?? 0) <= 86400);
  assert.deepEqual(classifyCloudflareError(429, 'slow down', '7').classified, { kind: 'per_minute', retryAfterSec: 7, status: 429 });
  assert.equal(classifyCloudflareError(401, 'bad token').classified.kind, 'other');
  assert.match(classifyCloudflareError(403, 'nope').message, /Workers AI permission/);
  assert.equal(classifyCloudflareError(503, 'busy').classified.kind, 'transient');
  assert.equal(classifyCloudflareError(400, 'bad request').classified.kind, 'other');
});

test('klein: multipart POST with the size, bearer token to api.cloudflare.com only, redirects refused; reads result.image', async () => {
  let seen: any;
  const fake = (async (url: string, init: any) => {
    seen = { url, init };
    return new Response(JSON.stringify({ success: true, result: { image: PNG.toString('base64') } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as any;
  const r = await runCloudflareImage('flux-2-klein-4b', 'a lighthouse at dusk', '16:9', ENV, fake);
  assert.equal(r.contentType, 'image/png');
  assert.ok(r.bytes.equals(PNG));
  assert.equal(seen.url, `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/ai/run/@cf/black-forest-labs/flux-2-klein-4b`);
  assert.equal(seen.init.headers.Authorization, 'Bearer tok');
  assert.equal(seen.init.headers['Content-Type'], undefined, 'fetch sets the multipart boundary');
  assert.equal(seen.init.redirect, 'error');
  assert.ok(seen.init.body instanceof FormData);
  assert.equal(seen.init.body.get('prompt'), 'a lighthouse at dusk');
  assert.equal(seen.init.body.get('width'), '1536');
  assert.equal(seen.init.body.get('height'), '864');
});

test('schnell: JSON with 8 steps, square only, and a bare { image } response is accepted', async () => {
  let seen: any;
  const fake = (async (_u: string, init: any) => {
    seen = init;
    return new Response(JSON.stringify({ image: PNG.toString('base64') }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as any;
  await runCloudflareImage('flux-1-schnell', 'p', '1:1', ENV, fake);
  assert.deepEqual(JSON.parse(seen.body), { prompt: 'p', steps: 8 });
  assert.equal(seen.headers['Content-Type'], 'application/json');
  await assert.rejects(() => runCloudflareImage('flux-1-schnell', 'p', '16:9', ENV, fake), /only draws square/);
});

test('missing or malformed credentials fail before any request; a raw image body is accepted; junk is refused', async () => {
  const never = (async () => { throw new Error('must not be called'); }) as any;
  await assert.rejects(() => runCloudflareImage('flux-2-klein-4b', 'p', '16:9', {}, never), /not both set/);
  await assert.rejects(() => runCloudflareImage('flux-2-klein-4b', 'p', '16:9', { ...ENV, CLOUDFLARE_ACCOUNT_ID: 'short' }, never), /32-character/);
  await assert.rejects(() => runCloudflareImage('flux-2-dev', 'p', '16:9', ENV, never), /not an allowed model/);
  const raw = (async () => new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } })) as any;
  assert.ok((await runCloudflareImage('flux-2-klein-4b', 'p', '16:9', ENV, raw)).bytes.equals(PNG));
  const junk = (async () => new Response(JSON.stringify({ result: { image: Buffer.alloc(3000, 1).toString('base64') } }), { status: 200, headers: { 'content-type': 'application/json' } })) as any;
  await assert.rejects(() => runCloudflareImage('flux-2-klein-4b', 'p', '16:9', ENV, junk), (e: any) => e instanceof SpaceError && /not an image/.test(e.message));
  const limited = (async () => new Response('{"errors":[{"code":4006,"message":"daily free allocation"}]}', { status: 429 })) as any;
  await assert.rejects(() => runCloudflareImage('flux-2-klein-4b', 'p', '16:9', ENV, limited), (e: any) => e instanceof SpaceError && e.classified.kind === 'per_day');
});
