/**
 * "How far did it reach?" is the first thing a general viewer asks about an incident, and the thing a
 * dossier most often cannot answer: a write-up of a flaw's mechanism rarely says how many people or
 * systems were hit. When the dossier is silent, the script fills the silence with an estimate — a live
 * run wrote "Millions of websites and users were exposed" from sources that contained no such figure.
 *
 * The research prompt asks the model to report this gap, and a model that has met its fact count will
 * still return `researchGaps: []`. So the check is also made here, in code (same shape as
 * `measureCoverage`): if nothing in the dossier's own text states a reach figure, the gap is added.
 *
 * Deliberately loose. A false "figure found" only leaves things as they were; a false "no figure" adds
 * one wrong line to the gaps. Bare years never count, and neither does an attack-effort number such as
 * "2.5 million requests" — reach is about who or what was affected, so the number has to sit next to
 * such a noun.
 */

const NOUN = String.raw`(?:users?|customers?|people|persons?|victims?|sites?|websites?|servers?|hosts?|domains?|devices?|machines?|systems?|endpoints?|accounts?|records?|organi[sz]ations?|compan(?:y|ies)|businesses|installations?|instances?|downloads?|installs?|patients?|passwords|credentials|dollars?)`;
const MODIFIERS = String.raw`(?:[a-z-]+\s+){0,2}`;
const SCALE_WORD = String.raw`(?:thousand|million|billion|[kmb])\b`;
// A bare number counts unless it is a year (1900-2099).
const NUMBER = String.raw`(?:\d[\d,.]*\s*${SCALE_WORD}|(?!(?:19|20)\d{2}\b)\d[\d,.]*)`;

const REACH_FIGURES: RegExp[] = [
  // 500,000 servers · 3.2 million users · 12 organisations
  new RegExp(String.raw`\b${NUMBER}\s+${MODIFIERS}${NOUN}\b`, 'i'),
  // 17% of secure web servers
  new RegExp(String.raw`\b\d[\d.]*\s*%\s+of\s+${MODIFIERS}${NOUN}\b`, 'i'),
  // millions of users · hundreds of thousands of sites · dozens of companies
  new RegExp(String.raw`\b(?:(?:tens|hundreds) of )?(?:thousands|millions|billions)\s+of\s+${MODIFIERS}${NOUN}\b|\b(?:hundreds|dozens) of\s+${MODIFIERS}${NOUN}\b`, 'i'),
  // a cost in money
  /(?:\$|US\$|USD\s?)\s?\d/i,
];

/** An existing gap that already speaks to reach. "no affected version range" must not count as one. */
const REACH_GAP_ALREADY = /\b(?:how (?:many|far|widely)|scale|reach(?:ed)?|number of (?:users|systems|sites|people|victims|servers|devices|customers|organi[sz]ations)|victims|affected (?:users|systems|sites|people|customers)|cost)\b/i;

export const REACH_GAP_TEXT =
  'How far it reached is not stated in any retrieved document: no figure for how many people, systems or dollars were affected, whether it was abused in the wild, or what it cost. The script must not state a scale (including words like "millions") without one; an incident report or vendor write-up with numbers would answer it.';

/** The text of the dossier that comes from the sources, not the model's own hooks and angles. */
function dossierText(dossier: any): string {
  const parts: string[] = [];
  const add = (v: unknown) => {
    if (typeof v === 'string') parts.push(v);
  };
  (Array.isArray(dossier?.keyFacts) ? dossier.keyFacts : []).forEach(add);
  (Array.isArray(dossier?.timeline) ? dossier.timeline : []).forEach((t: any) => add(t?.event));
  add(dossier?.summary);
  add(dossier?.oneLineHook);
  add(dossier?.coreTechExplanation);
  // A separator no pattern can span, so a number ending one fact never pairs with a noun starting the next.
  return parts.join(' ¶ ');
}

/** The gap to add, or null when the dossier already states a reach figure or already reports the gap. */
export function reachGapFor(dossier: any): string | null {
  const gaps: string[] = Array.isArray(dossier?.researchGaps) ? dossier.researchGaps.filter((g: unknown) => typeof g === 'string') : [];
  if (gaps.some((g) => REACH_GAP_ALREADY.test(g))) return null;
  const text = dossierText(dossier);
  if (REACH_FIGURES.some((re) => re.test(text))) return null;
  return REACH_GAP_TEXT;
}
