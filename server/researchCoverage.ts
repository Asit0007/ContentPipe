import type { FetchedSource } from './sourceFetcher';

/**
 * How much of this dossier is actually backed by a document, counted rather than asserted.
 *
 * The depth target lives in the prompt, where a model can agree with it and still return four
 * facts. This is the measurement that makes that visible to everything downstream — and it is
 * computed here, not requested from the model, because a model's own account of its sourcing is
 * one more thing that would need checking.
 */
export function measureCoverage(dossier: any, fetched: FetchedSource[], sourceArchiveId?: string) {
  const keyFacts: string[] = Array.isArray(dossier?.keyFacts) ? dossier.keyFacts : [];
  const citations: any[] = Array.isArray(dossier?.factCitations) ? dossier.factCitations : [];
  // A citation counts only when it names at least one source id; an entry with an empty
  // sourceIds array is an uncited fact wearing a citation's clothes.
  const cited = new Set(
    citations
      .filter((c) => Array.isArray(c?.sourceIds) && c.sourceIds.length > 0 && typeof c?.fact === 'string')
      .map((c) => c.fact.trim())
  );
  const citedFacts = keyFacts.filter((f) => cited.has(String(f).trim())).length;
  const usable = fetched.filter((f) => f.ok);
  return {
    sourcesUsable: usable.length,
    sourcesTruncated: usable.filter((f) => f.truncated).length,
    sourcesUndated: usable.filter((f) => !f.publishedAt).length,
    keyFacts: keyFacts.length,
    citedFacts,
    uncitedFacts: keyFacts.length - citedFacts,
    ...(sourceArchiveId ? { sourceArchiveId } : {}),
  };
}
