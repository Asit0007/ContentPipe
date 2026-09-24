/**
 * Removes CVE ids from a title, so a plan or script title stays something a non-technical viewer can
 * read. The research dossier keeps CVE ids as facts (its own `topicTitle` is often "Name (CVE-…)"), and
 * the plan prompt echoes that title into its inline example, which the model then copies. Titles are
 * cleaned in code rather than asked for in prose — see CLAUDE.md, "No severity ratings on screen".
 *
 * Only ids are removed, with the brackets and separators that carried them; the word "CVE" alone and
 * CVSS scores are left to the audit (`severity-rating-shown`). A title that is nothing but an id is
 * returned unchanged: an empty title is worse than an ugly one.
 *
 * Dependency-free, so both `server/` and `src/` can import it (same rule as `shared/brand.ts`).
 */
const CVE_ID = String.raw`CVE-\d{4}-\d{4,7}`;
const CVE_LIST = String.raw`${CVE_ID}(?:\s*[,;/&]\s*${CVE_ID})*`;

const BRACKETED = new RegExp(String.raw`\s*[(\[]\s*${CVE_LIST}\s*[)\]]`, 'gi');
const LEADING = new RegExp(String.raw`^\s*${CVE_LIST}\s*[:\-–—]?\s*`, 'i');
const TRAILING = new RegExp(String.raw`\s*[:\-–—,]?\s*${CVE_LIST}\s*$`, 'i');
const ANYWHERE = new RegExp(CVE_LIST, 'gi');

export function stripCveIds(title: string): string {
  const original = String(title ?? '').trim();
  let out = original.replace(BRACKETED, '').replace(LEADING, '').replace(TRAILING, '').replace(ANYWHERE, '');
  out = out.replace(/\(\s*\)|\[\s*\]/g, '').replace(/\s{2,}/g, ' ').trim();
  if (!/[\p{L}\p{N}]/u.test(out)) return original;
  if (out !== original && /^\p{Ll}/u.test(out)) out = out.charAt(0).toUpperCase() + out.slice(1);
  return out;
}
