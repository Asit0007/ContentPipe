/**
 * Server-side source fetching.
 *
 * Google Search grounding (the `google_search` tool) has zero quota on the
 * Gemini free tier, so instead of asking the model to find sources we fetch the
 * URLs the user supplies and feed the extracted text into the prompt. The model
 * then works from documents we actually read, and every citation in the output
 * traces back to something in this list.
 */

export interface FetchedSource {
  url: string;
  title: string;
  text: string;
  wordCount: number;
  fetchedAt: string;
  ok: boolean;
  error?: string;
}

const FETCH_TIMEOUT_MS = 15000;
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

/** Fetch one URL and reduce it to readable text. Never throws. */
export async function fetchSource(url: string): Promise<FetchedSource> {
  const base: FetchedSource = {
    url,
    title: '',
    text: '',
    wordCount: 0,
    fetchedAt: new Date().toISOString(),
    ok: false,
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

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        // Plain UA: many news sites return a stub or 403 to an unidentified client.
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });

    if (!res.ok) {
      return { ...base, error: `HTTP ${res.status} ${res.statusText}`.trim() };
    }

    const contentType = res.headers.get('content-type') || '';
    const raw = await res.text();

    let title = '';
    let text = '';
    if (contentType.includes('application/json')) {
      text = raw;
    } else if (contentType.includes('text/plain')) {
      text = raw;
    } else {
      ({ title, text } = htmlToText(raw));
    }

    if (!text || text.length < 120) {
      return {
        ...base,
        title,
        error: 'Fetched but no readable text extracted (JS-rendered page or paywall)',
      };
    }

    const truncated = text.slice(0, MAX_CHARS_PER_SOURCE);
    return {
      url,
      title: title || parsed.hostname,
      text: truncated,
      wordCount: truncated.split(/\s+/).filter(Boolean).length,
      fetchedAt: new Date().toISOString(),
      ok: true,
    };
  } catch (err: any) {
    const msg = err?.name === 'AbortError' ? `Timed out after ${FETCH_TIMEOUT_MS}ms` : err?.message || String(err);
    return { ...base, error: msg };
  } finally {
    clearTimeout(timer);
  }
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

  const blocks = usable.map((s, i) => {
    return `[S${i + 1}] ${s.title}
URL: ${s.url}
Retrieved: ${s.fetchedAt}
---
${s.text}
---`;
  });

  return `PRIMARY SOURCE DOCUMENTS (retrieved live — these are the ground truth):

${blocks.join('\n\n')}

Cite these by their [S#] tag. Do not invent facts that are absent from them.`;
}
