/**
 * Keeps the text of every document a dossier was built from.
 *
 * Until now the fetched text existed only inside one prompt string and was gone the moment the
 * research call returned: the response carried source *metadata* (url, title, word count) but not a
 * word of what was read. That makes the central question unanswerable after the fact — "is this
 * sentence in the script actually supported by a source, or did the model produce it?" — because
 * there is nothing left to check the sentence against.
 *
 * The text is written to disk rather than returned in the API response on purpose: six sources at
 * the per-source cap is ~240 KB, which would ride along in every research response, through
 * CyberPipe's SQLite job row, and into the plan and script request bodies that echo the dossier back.
 *
 * Archives live alongside the run journals in RUNS_DIR and are named `sources-<id>.json`, so the
 * existing `pruneOldRuns` sweep expires them on the same 7-day clock — no second retention policy.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { RUNS_DIR } from './runJournal';
import type { FetchedSource } from './sourceFetcher';

export interface ArchivedSource {
  id: string;
  url: string;
  title: string;
  via: string;
  fetchedAt: string;
  publishedAt?: string;
  truncated?: boolean;
  retrievedChars?: number;
  /** Exactly the text that was put in front of the model — post-truncation, so a later check
   *  compares against what it actually saw, not against the fuller document on the web. */
  text: string;
}

export interface SourceArchive {
  archiveId: string;
  createdAt: string;
  sources: ArchivedSource[];
}

/** Derived from the URLs read, so the same source set reuses one archive instead of piling up. */
export function archiveIdFor(urls: string[]): string {
  return createHash('sha256').update(JSON.stringify(urls)).digest('hex').slice(0, 16);
}

const fileFor = (archiveId: string, dir: string): string => path.join(dir, `sources-${archiveId}.json`);

/**
 * Write the usable sources' text. Returns the archive id, or undefined if nothing was written —
 * never throws: failing to keep a copy must not fail the research request that produced it.
 */
export async function writeSourceArchive(
  sources: FetchedSource[],
  dir: string = RUNS_DIR
): Promise<string | undefined> {
  const usable = sources.filter((s) => s.ok && s.text);
  if (usable.length === 0) return undefined;

  const archiveId = archiveIdFor(usable.map((s) => s.url));
  const payload: SourceArchive = {
    archiveId,
    createdAt: new Date().toISOString(),
    sources: usable.map((s, i) => ({
      // Position among the USABLE sources is not the [S#] the prompt used — that is the position in
      // the full fetched list — so the caller's ids are preserved via `sourceIdOf` below.
      id: s.sourceId || `S${i + 1}`,
      url: s.url,
      title: s.title,
      via: s.via,
      fetchedAt: s.fetchedAt,
      ...(s.publishedAt ? { publishedAt: s.publishedAt } : {}),
      ...(s.truncated ? { truncated: true, retrievedChars: s.retrievedChars } : {}),
      text: s.text,
    })),
  };

  try {
    await fs.mkdir(dir, { recursive: true });
    const file = fileFor(archiveId, dir);
    const tmp = `${file}.tmp-${process.pid}`;
    await fs.writeFile(tmp, JSON.stringify(payload), 'utf8');
    await fs.rename(tmp, file);
    return archiveId;
  } catch (err: any) {
    console.warn(`[Source Archive] could not keep source text (${err?.message || err}) — a later fact check will have nothing to read`);
    return undefined;
  }
}

/** Read an archive back. Returns null when it is missing or unreadable (e.g. already pruned). */
export async function readSourceArchive(archiveId: string, dir: string = RUNS_DIR): Promise<SourceArchive | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(fileFor(archiveId, dir), 'utf8'));
    return parsed && Array.isArray(parsed.sources) ? (parsed as SourceArchive) : null;
  } catch {
    return null;
  }
}
