import { decodeEntities } from './htmlText';

/**
 * Hacker News discussion as a retrievable source.
 *
 * The research prompt used to ask the model for "authentic-sounding" HN comments,
 * with a handle and karma — and no HN data was ever fetched, so every quoted
 * commenter was invented. This turns a real thread (via the key-free HN Algolia
 * API) into a [S#] document so any community reaction the dossier reports can be
 * traced to text that was actually read.
 *
 * Shape verified live 2026-09-19 against hn.algolia.com/api/v1/items/8863:
 *   story  → { id, title, url, author, points, type, children: [...] }
 *   comment→ { id, author, text (HTML), points: null, children: [...] }
 * Two consequences baked in below: individual comments carry NO points/karma (so none
 * is ever shown), and `children` arrive in chronological order, NOT ranked by votes —
 * so they are presented as the first comments, never as "top comments".
 */

export interface HnItem {
  id?: number;
  type?: string;
  author?: string | null;
  title?: string | null;
  url?: string | null;
  text?: string | null;
  points?: number | null;
  children?: HnItem[];
}

const MAX_COMMENTS = 25;
const MAX_CHARS_PER_COMMENT = 700;
const MAX_TOTAL_CHARS = 12000;

/** `news.ycombinator.com/item?id=N` → N, else null. */
export function parseHnItemId(rawUrl: string): number | null {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  if (u.hostname !== 'news.ycombinator.com' || u.pathname !== '/item') return null;
  const id = u.searchParams.get('id');
  return id && /^\d+$/.test(id) ? Number(id) : null;
}

export function algoliaItemUrl(id: number): string {
  return `https://hn.algolia.com/api/v1/items/${id}`;
}

/** HN comment HTML (`<p>`, `<a>`, `<i>`, `<pre><code>`) → plain text with paragraph breaks kept. */
export function hnHtmlToText(html: string): string {
  return decodeEntities(
    (html || '')
      .replace(/<p>/gi, '\n\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/?(pre|code)[^>]*>/gi, '')
      .replace(/<a\s[^>]*href="([^"]*)"[^>]*>[\s\S]*?<\/a>/gi, (_m, href) => decodeEntities(href))
      .replace(/<[^>]+>/g, '')
  )
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function countDescendants(item: HnItem): number {
  return (item.children || []).reduce((n, c) => n + 1 + countDescendants(c), 0);
}

export function renderHnThread(item: HnItem): { title: string; text: string; commentCount: number; included: number } {
  const title = item.title || `Hacker News item ${item.id ?? ''}`.trim();
  const commentCount = countDescendants(item);

  // Deleted / dead comments arrive with null text or author.
  const usable = (item.children || []).filter((c) => c.author && c.text);
  const picked = usable.slice(0, MAX_COMMENTS);

  const header = [
    `Hacker News discussion: "${title}"${item.points != null ? ` (${item.points} points)` : ''}`,
    ...(item.url ? [`Story link: ${item.url}`] : []),
    `Thread size: ${commentCount} comment(s) in total. Below: the first ${picked.length} top-level comment(s) in chronological order.`,
    'These are NOT ranked by votes — the HN API exposes no per-comment points. Author handles and wording are verbatim from the API.',
    '',
  ].join('\n');

  let text = header;
  let included = 0;
  for (const c of picked) {
    let body = hnHtmlToText(c.text || '');
    if (body.length > MAX_CHARS_PER_COMMENT) body = body.slice(0, MAX_CHARS_PER_COMMENT).trimEnd() + '…';
    const line = `[c${included + 1}] ${c.author}: ${body}\n\n`;
    if (text.length + line.length > MAX_TOTAL_CHARS) break;
    text += line;
    included++;
  }
  return { title, text: text.trimEnd(), commentCount, included };
}
