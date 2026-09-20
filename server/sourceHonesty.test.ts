/**
 * The retrieval layer's honesty guarantees: what it refuses to call readable, what it says about
 * when a document was published, and what it admits to having cut off.
 */
import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  fetchSource,
  fetchSources,
  buildSourceContext,
  unreadableAs,
  extractPublishedAt,
  normalizeDate,
  setUrlGuardForTests,
  type FetchedSource,
} from './sourceFetcher';
import { writeSourceArchive, readSourceArchive, archiveIdFor } from './sourceArchive';
import { assertPublicUrl } from './netGuard';

const LONG = 'The maintainer disclosed the flaw and shipped a patch. '.repeat(20);
const res = (body: string | Uint8Array, contentType: string, status = 200) =>
  new Response(body as any, { status, headers: { 'content-type': contentType } });

function mockFetch(handler: (url: string) => Response | Promise<Response>) {
  mock.method(globalThis, 'fetch', async (input: any) => handler(String(input)));
}

beforeEach(() => setUrlGuardForTests((url) => assertPublicUrl(url, async () => [{ address: '93.184.216.34' }])));
afterEach(() => {
  mock.restoreAll();
  setUrlGuardForTests(null);
});

// ------------------------------------------------------------------- binary is not text

test('unreadableAs: PDFs are caught by magic bytes, by content-type, and by neither', () => {
  assert.equal(unreadableAs('%PDF-1.7\n1 0 obj', 'text/html'), 'a PDF', 'magic bytes beat a lying content-type');
  assert.equal(unreadableAs('anything at all', 'application/pdf; charset=binary'), 'a PDF');
  assert.equal(unreadableAs('anything at all', 'application/x-pdf'), 'a PDF');
  assert.equal(unreadableAs(`<html><body>${LONG}</body></html>`, 'text/html'), null, 'real HTML is readable');
  assert.equal(unreadableAs('{"a":1}', 'application/json'), null, 'JSON is readable');
});

test('unreadableAs: decoded binary is caught even with no content-type at all', () => {
  const decodedBinary = Array.from({ length: 500 }, (_, i) => String.fromCodePoint(i % 2 ? 0xfffd : 0x01)).join('');
  assert.equal(unreadableAs(decodedBinary, ''), 'binary data');
  assert.equal(unreadableAs(decodedBinary, 'image/png'), 'image data', 'content-type is preferred when present');
});

test('unreadableAs: a page with a stray control character is still prose', () => {
  assert.equal(unreadableAs(`${LONG}\u0001${LONG}`, 'text/html'), null);
});

test('a PDF is NOT reported as a successful read — it escalates to the proxy that can extract it', async () => {
  mockFetch(async (url) => {
    if (url.startsWith('https://r.jina.ai/')) return res(`Title: Advisory\nMarkdown Content:\n${LONG}`, 'text/plain');
    return res('%PDF-1.7\n%âãÏÓ\n1 0 obj <</Type/Catalog>>', 'application/pdf');
  });
  const r = await fetchSource('https://vendor.example/advisory.pdf');
  assert.equal(r.ok, true);
  assert.equal(r.via, 'jina', 'the reader proxy extracts the PDF the direct rung refused');
  assert.match(r.attempts![0].error, /is a PDF/);
  assert.doesNotMatch(r.text, /%PDF/);
});

test('when nothing can read the PDF, it fails honestly instead of returning mojibake', async () => {
  mockFetch(async () => res('%PDF-1.7\n1 0 obj <</Type/Catalog>>', 'application/pdf'));
  const r = await fetchSource('https://vendor.example/advisory.pdf');
  assert.equal(r.ok, false);
  assert.equal(r.text, '', 'no mojibake is passed off as the document body');
  // Every rung refused it, and the reason the first one refused is on the record.
  assert.match(r.attempts!.find((a) => a.via === 'direct')!.error, /is a PDF/);
  assert.equal(r.attempts!.length, 3);
});

// ------------------------------------------------------------------- publication dates

test('extractPublishedAt reads the metadata a page states, in either attribute order', () => {
  const iso = '2026-03-29T10:15:00.000Z';
  for (const head of [
    `<meta property="article:published_time" content="2026-03-29T10:15:00Z">`,
    `<meta content="2026-03-29T10:15:00Z" property="article:published_time">`,
    `<meta name="pubdate" content="2026-03-29T10:15:00Z">`,
    `<meta itemprop="datePublished" content="2026-03-29T10:15:00Z">`,
    `<script type="application/ld+json">{"datePublished":"2026-03-29T10:15:00Z"}</script>`,
    `<time pubdate datetime="2026-03-29T10:15:00Z">March 29</time>`,
  ]) {
    assert.equal(extractPublishedAt(`<html><head>${head}</head></html>`), iso, head);
  }
});

test('a bare <time> is not read as the publication date — on an article page it is usually a comment', () => {
  assert.equal(extractPublishedAt('<html><body><time datetime="2026-03-29T10:15:00Z">reply</time></body></html>'), undefined);
});

test('an implausible or unparseable date is dropped rather than passed on', () => {
  assert.equal(normalizeDate('not a date'), undefined);
  assert.equal(normalizeDate('1066-10-14T00:00:00Z'), undefined, 'older than the web');
  assert.equal(normalizeDate(new Date(Date.now() + 90 * 86400_000).toISOString()), undefined, 'in the future');
  assert.equal(normalizeDate('2026-03-29'), '2026-03-29T00:00:00.000Z');
});

test('a page that states no date says so, and never inherits the fetch time', async () => {
  mockFetch(async () => res(`<html><head><title>T</title></head><body><p>${LONG}</p></body></html>`, 'text/html'));
  const r = await fetchSource('https://a.example/x');
  assert.equal(r.ok, true);
  assert.equal(r.publishedAt, undefined);
  const ctx = buildSourceContext([r]);
  assert.match(ctx, /published="not stated by the page"/);
  assert.match(ctx, /Do not infer it from `retrieved`/);
});

test('the prompt separates when the page was published from when we read it', async () => {
  mockFetch(async () =>
    res(`<html><head><meta property="article:published_time" content="2026-03-29T10:15:00Z"><title>T</title></head><body><p>${LONG}</p></body></html>`, 'text/html')
  );
  const r = await fetchSource('https://a.example/x');
  assert.equal(r.publishedAt, '2026-03-29T10:15:00.000Z');
  const ctx = buildSourceContext([r]);
  assert.match(ctx, /published="2026-03-29T10:15:00\.000Z"/);
  assert.match(ctx, /`retrieved` is merely when this tool read the page/);
});

// ------------------------------------------------------------------- truncation

test('a document longer than the cap is cut, and the cut is disclosed rather than hidden', async () => {
  const huge = 'x'.repeat(60000);
  mockFetch(async () => res(`<html><head><title>T</title></head><body><p>${huge}</p></body></html>`, 'text/html'));
  const r = await fetchSource('https://a.example/x');
  assert.equal(r.ok, true);
  assert.equal(r.truncated, true);
  assert.equal(r.text.length, 40000);
  assert.ok(r.retrievedChars! > 40000);
  const ctx = buildSourceContext([r]);
  assert.match(ctx, /truncated="first 40000 of \d+ characters"/);
  assert.match(ctx, /you are reading its opening only/);
});

test('a document within the cap is not marked truncated and the prompt stays quiet about it', async () => {
  mockFetch(async () => res(`<html><head><title>T</title></head><body><p>${LONG}</p></body></html>`, 'text/html'));
  const r = await fetchSource('https://a.example/x');
  assert.equal(r.truncated, undefined);
  assert.doesNotMatch(buildSourceContext([r]), /truncated=/);
});

// ------------------------------------------------------------------- the archive

const source = (over: Partial<FetchedSource>): FetchedSource => ({
  url: 'https://a.example/x', title: 'A', text: 'the body text', wordCount: 3,
  fetchedAt: '2026-09-19T00:00:00Z', ok: true, via: 'direct', ...over,
});

test('the archive keeps exactly the text the model saw, under the id the citations use', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cp-archive-'));
  const fetched = [
    source({ url: 'https://a.example/1', sourceId: 'S1', text: 'first body', publishedAt: '2026-03-29T00:00:00.000Z' }),
    source({ url: 'https://b.example/2', sourceId: 'S2', ok: false, text: '', error: 'HTTP 404' }),
    source({ url: 'https://c.example/3', sourceId: 'S3', text: 'third body', truncated: true, retrievedChars: 99000 }),
  ];
  const id = await writeSourceArchive(fetched, dir);
  assert.equal(id, archiveIdFor(['https://a.example/1', 'https://c.example/3']));

  const back = await readSourceArchive(id!, dir);
  assert.equal(back!.sources.length, 2, 'a source that failed has no text to keep');
  assert.deepEqual(back!.sources.map((s) => s.id), ['S1', 'S3'], 'ids survive the gap left by the failed S2');
  assert.equal(back!.sources[0].text, 'first body');
  assert.equal(back!.sources[0].publishedAt, '2026-03-29T00:00:00.000Z');
  assert.equal(back!.sources[1].truncated, true);
  await fs.rm(dir, { recursive: true, force: true });
});

test('nothing usable means no archive, and an unwritable directory never fails the request', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cp-archive-'));
  assert.equal(await writeSourceArchive([source({ ok: false, text: '' })], dir), undefined);
  assert.equal(await readSourceArchive('deadbeefdeadbeef', dir), null, 'a missing archive reads back as null, not a throw');
  await fs.rm(dir, { recursive: true, force: true });
  assert.equal(await writeSourceArchive([source({})], path.join(dir, 'gone', '\0bad')), undefined);
});

// ------------------------------------------------------------------- ids

test('fetchSources stamps each source with the [S#] the prompt and the citations share', async () => {
  mockFetch(async (url) =>
    url.includes('bad.example')
      ? res('nope', 'text/html', 500)
      : res(`<html><head><title>T</title></head><body><p>${LONG}</p></body></html>`, 'text/html')
  );
  const out = await fetchSources(['https://a.example/1', 'https://bad.example/2', 'https://c.example/3']);
  assert.deepEqual(out.map((s) => s.sourceId), ['S1', 'S2', 'S3']);
  const ctx = buildSourceContext(out);
  assert.match(ctx, /<source id="S1"/);
  assert.match(ctx, /<source id="S3"/, 'the failed S2 keeps its number reserved');
  assert.doesNotMatch(ctx, /<source id="S2"/);
});
