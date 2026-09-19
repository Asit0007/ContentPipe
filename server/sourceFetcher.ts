/**
 * Server-side source fetching.
 *
 * Google Search grounding (the `google_search` tool) has zero quota on the
 * Gemini free tier, so instead of asking the model to find sources we fetch the
 * URLs the user supplies and feed the extracted text into the prompt. The model
 * then works from documents we actually read, and every citation in the output
 * traces back to something in this list.
 *
 * A direct fetch is tried first. If it fails (paywall, JS-rendered page,
 * timeout) two rescue rungs are tried in order: a reader proxy (r.jina.ai),
 * then a Wayback Machine snapshot. Whichever rung succeeds is recorded on the
 * result as `via`, and the prompt this feeds discloses it — a rescued source
 * must never be presented as an ordinary live read.
 */

export type FetchVia = 'direct' | 'jina' | 'wayback';

export interface FetchedSource {
  url: string;
  title: string;
  text: string;
  wordCount: number;
  fetchedAt: string;
  ok: boolean;
  via: FetchVia;
  error?: string;
  /** The URL actually requested to obtain `text` — the reader-proxy or archive URL, not `url`. */
  retrievalUrl?: string;
  /** ISO timestamp of the archived capture. Only set when `via === 'wayback'`. */
  snapshotDate?: string;
  /** Failed rungs tried before the one that succeeded (or before giving up). */
  attempts?: Array<{ via: FetchVia; error: string }>;
}

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';
/** r.jina.ai's edge bot-checks browser-spoofing UAs; an honest tool identity passes. */
const READER_PROXY_USER_AGENT = 'ContentPipe-SourceFetcher/1.0';

const FETCH_TIMEOUT_MS = 15000;
const JINA_TIMEOUT_MS = 20000;
const WAYBACK_LOOKUP_TIMEOUT_MS = 5000;
const WAYBACK_FETCH_TIMEOUT_MS = 15000;
/** Total time budget for one source's ladder across all rungs. Prevents a slow
 * direct-timeout + slow-jina-timeout + slow-wayback-timeout stack from turning
 * one source into a ~50s tail latency with no UI feedback. */
const SOURCE_BUDGET_MS = 40000;
const MIN_TEXT_LENGTH = 120;
const MAX_CHARS_PER_SOURCE = 12000;
const MAX_SOURCES = 6;

/** Pull every http(s) URL out of a blob of text, de-duplicated, order preserved. */
export function extractUrls(text: string): string[] {
  if (!text) return [];
  const matches = text.match(/https?:\/\/[^\s<>"')\]]+/g) || [];
  const cleaned = matches.map((u) => u.replace(/[.,;:]+$/, ''));
  return Array.from(new Set(cleaned));
}

/** Strip HTML down to readable prose. Deliberately dependency-free. */
function htmlToText(html: string): { title: string; text: string } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeEntities(titleMatch[1]).trim() : '';

  let body = html;
  // Drop everything that never renders as prose.
  body = body.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  body = body.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  body = body.replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
  body = body.replace(/<svg[\s\S]*?<\/svg>/gi, ' ');
  body = body.replace(/<nav[\s\S]*?<\/nav>/gi, ' ');
  body = body.replace(/<header[\s\S]*?<\/header>/gi, ' ');
  body = body.replace(/<footer[\s\S]*?<\/footer>/gi, ' ');
  body = body.replace(/<aside[\s\S]*?<\/aside>/gi, ' ');
  body = body.replace(/<form[\s\S]*?<\/form>/gi, ' ');
  body = body.replace(/<!--[\s\S]*?-->/g, ' ');

  // Keep paragraph and heading boundaries as newlines so the model can see structure.
  body = body.replace(/<\/(p|div|section|article|li|h[1-6]|blockquote|tr)>/gi, '\n');
  body = body.replace(/<br\s*\/?>/gi, '\n');
  body = body.replace(/<[^>]+>/g, ' ');

  body = decodeEntities(body);
  body = body.replace(/[ \t ]+/g, ' ');
  body = body.replace(/\n\s*\n\s*\n+/g, '\n\n');
  body = body
    .split('\n')
    .map((l) => l.trim())
    // Drop nav crumbs and orphaned words that survive tag stripping.
    .filter((l) => l.length > 2)
    .join('\n')
    .trim();

  return { title, text: body };
}

function decodeEntities(s: string): string {
  const named: Record<string, string> = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
    mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘',
    ldquo: '“', rdquo: '”', eacute: 'é', egrave: 'è',
  };
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => named[name.toLowerCase()] ?? m);
}

interface RawFetchResult {
  ok: boolean;
  contentType?: string;
  raw?: string;
  error?: string;
}

/** One plain HTTP GET with a timeout. Never throws. */
async function fetchOnce(url: string, timeoutMs: number, opts?: { accept?: string; userAgent?: string }): Promise<RawFetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        // Browser UA by default: many news sites return a stub or 403 to an
        // unidentified client. r.jina.ai is the opposite — its own edge runs a
        // bot check that a browser-spoofing UA trips (verified: a Chrome UA
        // gets a Cloudflare challenge page, an honest tool UA gets a 200) — so
        // that rung passes its own, non-spoofing UA via `opts.userAgent`.
        'User-Agent': opts?.userAgent || USER_AGENT,
        Accept: opts?.accept || 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status} ${res.statusText}`.trim() };
    }
    const contentType = res.headers.get('content-type') || '';
    const raw = await res.text();
    return { ok: true, contentType, raw };
  } catch (err: any) {
    const msg = err?.name === 'AbortError' ? `Timed out after ${timeoutMs}ms` : err?.message || String(err);
    return { ok: false, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

// A plain (non-discriminated) shape rather than a union: this repo's tsconfig
// has strictNullChecks off, under which TS does not narrow `ok: true | false`
// literal unions, so `if (result.ok) result.text` would not typecheck.
interface RungResult {
  ok: boolean;
  title?: string;
  text?: string;
  retrievalUrl?: string;
  snapshotDate?: string;
  error?: string;
}

/** Rung 1: fetch the URL itself. */
async function tryDirect(url: string, parsed: URL): Promise<RungResult> {
  const r = await fetchOnce(url, FETCH_TIMEOUT_MS);
  if (!r.ok) return { ok: false, error: r.error! };

  let title = '';
  let text = '';
  if (r.contentType?.includes('application/json') || r.contentType?.includes('text/plain')) {
    text = r.raw || '';
  } else {
    ({ title, text } = htmlToText(r.raw || ''));
  }

  if (!text || text.length < MIN_TEXT_LENGTH) {
    return { ok: false, title, error: 'Fetched but no readable text extracted (JS-rendered page or paywall)' };
  }
  return { ok: true, title: title || parsed.hostname, text: text.slice(0, MAX_CHARS_PER_SOURCE), retrievalUrl: url };
}

/** Rung 2: r.jina.ai renders JS and strips boilerplate server-side. Takes the raw URL, not URL-encoded. */
async function tryJina(url: string, parsed: URL): Promise<RungResult> {
  const readerUrl = `https://r.jina.ai/${url}`;
  const r = await fetchOnce(readerUrl, JINA_TIMEOUT_MS, { userAgent: READER_PROXY_USER_AGENT });
  if (!r.ok) return { ok: false, error: `reader proxy: ${r.error}` };

  const raw = r.raw || '';
  const titleMatch = raw.match(/^Title:\s*(.*)$/m);
  const title = titleMatch ? titleMatch[1].trim() : '';
  const markerIdx = raw.indexOf('Markdown Content:');
  const text = (markerIdx >= 0 ? raw.slice(markerIdx + 'Markdown Content:'.length) : raw).trim();

  if (!text || text.length < MIN_TEXT_LENGTH) {
    return { ok: false, title, error: 'Reader proxy returned no readable text' };
  }
  return { ok: true, title: title || parsed.hostname, text: text.slice(0, MAX_CHARS_PER_SOURCE), retrievalUrl: readerUrl };
}

/** Rung 3: last resort. Wayback's own API is aggressively rate-limited (429s observed) —
 * one lookup, one fetch, no retry. Never depend on this rung succeeding. */
async function tryWayback(url: string, parsed: URL): Promise<RungResult> {
  const lookup = await fetchOnce(`https://archive.org/wayback/available?url=${encodeURIComponent(url)}`, WAYBACK_LOOKUP_TIMEOUT_MS);
  if (!lookup.ok) return { ok: false, error: `wayback lookup: ${lookup.error}` };

  let snapshot: { url: string; timestamp: string } | null = null;
  try {
    const data = JSON.parse(lookup.raw || '{}');
    const closest = data?.archived_snapshots?.closest;
    if (closest?.available && closest?.url && closest?.timestamp) {
      snapshot = { url: closest.url, timestamp: closest.timestamp };
    }
  } catch {
    return { ok: false, error: 'wayback lookup: malformed response' };
  }
  if (!snapshot) return { ok: false, error: 'No archived snapshot available' };

  // Request the raw capture without the injected toolbar: .../web/<ts>/... -> .../web/<ts>id_/...
  const snapshotUrl = snapshot.url.replace(/(\/web\/\d{14})([a-z_]*)(\/)/, '$1id_$3');
  const r = await fetchOnce(snapshotUrl, WAYBACK_FETCH_TIMEOUT_MS);
  if (!r.ok) return { ok: false, error: `wayback fetch: ${r.error}` };

  const { title, text } = htmlToText(r.raw || '');
  if (!text || text.length < MIN_TEXT_LENGTH) {
    return { ok: false, title, error: 'Archived snapshot had no readable text' };
  }

  const ts = snapshot.timestamp; // YYYYMMDDhhmmss
  const snapshotDate = `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}T${ts.slice(8, 10)}:${ts.slice(10, 12)}:${ts.slice(12, 14)}Z`;

  return { ok: true, title: title || parsed.hostname, text: text.slice(0, MAX_CHARS_PER_SOURCE), retrievalUrl: snapshotUrl, snapshotDate };
}

/** Fetch one URL, escalating through rescue rungs on failure. Never throws. */
export async function fetchSource(url: string): Promise<FetchedSource> {
  const base = {
    url,
    title: '',
    text: '',
    wordCount: 0,
    fetchedAt: new Date().toISOString(),
    ok: false as const,
    via: 'direct' as FetchVia,
  };

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ...base, error: 'Malformed URL' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ...base, error: `Unsupported protocol ${parsed.protocol}` };
  }

  // Each rung's own worst-case timeout, so the budget check below can refuse to
  // *start* a rung that would blow the budget on its own, not just react after
  // the fact — a rung already in flight is never aborted early.
  const rungs: Array<{ via: FetchVia; timeoutMs: number; run: () => Promise<RungResult> }> = [
    { via: 'direct', timeoutMs: FETCH_TIMEOUT_MS, run: () => tryDirect(url, parsed) },
    { via: 'jina', timeoutMs: JINA_TIMEOUT_MS, run: () => tryJina(url, parsed) },
    { via: 'wayback', timeoutMs: WAYBACK_LOOKUP_TIMEOUT_MS + WAYBACK_FETCH_TIMEOUT_MS, run: () => tryWayback(url, parsed) },
  ];

  const attempts: Array<{ via: FetchVia; error: string }> = [];
  const started = Date.now();
  let bestTitle = '';
  let lastAttemptedVia: FetchVia = 'direct';

  for (const rung of rungs) {
    // Only skip rescue rungs (never the first attempt), and only when this
    // rung's own worst case would blow the budget — not merely because time
    // already spent is close to it.
    if (attempts.length > 0 && Date.now() - started + rung.timeoutMs > SOURCE_BUDGET_MS) {
      attempts.push({ via: rung.via, error: 'Skipped — source retrieval budget exhausted' });
      continue;
    }
    lastAttemptedVia = rung.via;
    const result = await rung.run();
    if (result.title) bestTitle = result.title;
    if (result.ok) {
      const text = result.text || '';
      return {
        url,
        title: result.title || parsed.hostname,
        text,
        wordCount: text.split(/\s+/).filter(Boolean).length,
        fetchedAt: new Date().toISOString(),
        ok: true,
        via: rung.via,
        retrievalUrl: result.retrievalUrl || url,
        ...(result.snapshotDate ? { snapshotDate: result.snapshotDate } : {}),
        ...(attempts.length ? { attempts } : {}),
      };
    }
    attempts.push({ via: rung.via, error: result.error || 'Unknown error' });
  }

  const last = attempts[attempts.length - 1];
  return {
    ...base,
    // A page whose <title> we read but whose body was unreadable shouldn't
    // regress to showing the raw URL as its title.
    title: bestTitle,
    // Reflects the last rung actually fetched, not just the first one tried —
    // 'direct' alone would understate how much was attempted before giving up.
    via: lastAttemptedVia,
    error: last?.error || 'All retrieval methods failed',
    attempts,
  };
}

/** Fetch many URLs in parallel, capped. Failures come back as ok:false entries. */
export async function fetchSources(urls: string[]): Promise<FetchedSource[]> {
  const capped = urls.slice(0, MAX_SOURCES);
  if (capped.length === 0) return [];
  return Promise.all(capped.map(fetchSource));
}

/** Render fetched sources as a prompt block the model can quote and cite from. */
export function buildSourceContext(sources: FetchedSource[]): string {
  const usable = sources.filter((s) => s.ok);
  if (usable.length === 0) return '';

  const anyRescued = usable.some((s) => s.via !== 'direct');

  const blocks = usable.map((s, i) => {
    const provenance =
      s.via === 'direct'
        ? `Retrieved: ${s.fetchedAt} (direct read)`
        : s.via === 'jina'
        ? `Retrieved: ${s.fetchedAt} (via reader proxy — the direct fetch failed)`
        : `Retrieved: ${s.fetchedAt} (Wayback Machine snapshot dated ${s.snapshotDate || 'unknown'} — the direct fetch failed)`;
    return `[S${i + 1}] ${s.title}
URL: ${s.url}
${provenance}
---
${s.text}
---`;
  });

  const rescueNote = anyRescued
    ? '\n\nSome documents above are archived or proxied, not a live direct read of the URL. Attribute time-sensitive claims to the retrieval date given for that document, and never describe archived content as current.'
    : '';

  return `PRIMARY SOURCE DOCUMENTS (the only documents actually read):

${blocks.join('\n\n')}

Cite these by their [S#] tag. Do not invent facts that are absent from them.${rescueNote}`;
}
