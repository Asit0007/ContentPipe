/**
 * The tone axis (documentary vs. infotainment) — orthogonal to topic domain (shared/topicProfile.ts).
 *
 * Was independently re-derived in four places (server.ts twice, server/scriptPipeline.ts twice) with
 * two different comparison strategies: /api/plan matched /documentary/i against the free-text request
 * field, the other three did an exact match against the literal 'Deep Dive Documentary'. Since
 * planSchema.tone is a closed enum, any real /api/plan output is that exact literal string, which the
 * regex already matches too — so unifying on the regex is a strict superset, not a behavior change, for
 * every zero-config caller. It only changes behavior for a hand-crafted videoPlan.tone string that skips
 * /api/plan, which is not a case any test or the UI currently exercises.
 */
export function isDocumentaryTone(tone: unknown): boolean {
  return /documentary/i.test(String(tone || ''));
}
