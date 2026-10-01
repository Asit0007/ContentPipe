/**
 * What an image or video prompt may carry (2026-10-01).
 *
 * Two OnePlus clips were refused by Gemini ("That request looks like it goes against our terms"): scene 5, whose
 * prompt named the real researcher (fixed in server/characterNames.ts), and scene 46, whose still and prompt carried
 * the words "LOCAL ATTACK VECTOR ONLY" and called it a "threat". Google's Generative AI Prohibited Use Policy forbids
 * "circumventing safety filters", so nothing here disguises a request: it removes what the picture does not need.
 * A video model only has to move what is already in the still; the story's meaning belongs to the narration and the
 * edit. Concretely, a picture prompt keeps to what a camera sees:
 *
 * - **No lettering.** Quoted words ('ROOT', 'LOCAL ATTACK VECTOR ONLY') leave the picture and become text overlays
 *   added in the edit (sceneOverlays). AI pictures garble lettering, video models make it crawl, a typo baked into a
 *   still cannot be fixed, and words such as "attack" or "malicious" read as harmful to a filter that sees no story.
 * - **No brand names.** "OnePlus 15" becomes "a smartphone": filters treat trademarks as third-party risk.
 * - **No story meaning.** A sentence in a clip direction that says what the shot *means* ("mirror the constrained
 *   nature of the threat") is dropped: a video model cannot film it, and its words are the ones filters react to.
 *
 * Dependency-free: imported by the server (the exported brief) and the UI (the copy buttons).
 */

/** A quoted span that is lettering: it holds a capital letter or a digit ('ROOT', 'April 18', 'doShell'). */
const QUOTED = /(^|[\s(:])(['"“‘])([^'"“”‘’]{1,60})(['"”’])(?=[\s.,;:!?)]|$)/g;
const isLettering = (inner: string) => /[A-Z0-9]/.test(inner);

/** Every piece of lettering a picture description asks for, in order, without duplicates. */
export function extractLettering(text: string): string[] {
  const out: string[] = [];
  for (const m of String(text ?? '').matchAll(QUOTED)) {
    const inner = m[3].trim();
    if (isLettering(inner) && !out.includes(inner)) out.push(inner);
  }
  return out;
}

/**
 * The description with its lettering taken out, worded so the surface is drawn plain:
 * "a block labeled 'USER'" → "a plain block"; "the text 'X' is projected" → "a plain, unmarked panel is projected";
 * "the date 'April 18'" → "the date"; any other quoted label is dropped.
 */
export function stripLettering(text: string): string {
  let t = String(text ?? '');
  // "the text / words / phrase / caption / headline 'X'" -> a plain panel (the thing the words were written on).
  t = t.replace(
    /\b(the|a|an)\s+(text|words|phrase|caption|headline|title|message|slogan)\s+(['"“‘])([^'"“”‘’]{1,60})(['"”’])/gi,
    (m, art: string, _n, _o, inner: string) => (isLettering(inner) ? `${/^[A-Z]/.test(art) ? 'A' : 'a'} plain, unmarked panel` : m)
  );
  // "labeled 'X'" / "titled 'X'" / "reading 'X'" / "marked 'X'" / "with the words 'X'" -> nothing.
  t = t.replace(
    /\s*,?\s*\b(labell?ed|titled|reading|that reads|which reads|marked|stamped|inscribed|with the (?:words|text|label|title))\s+(['"“‘])([^'"“”‘’]{1,60})(['"”’])/gi,
    (m, _v, _o, inner: string) => (isLettering(inner) ? '' : m)
  );
  // Any remaining quoted lettering ("a 'ROOT' block", "the date 'June 22'") -> dropped.
  t = t.replace(QUOTED, (m, lead: string, _o, inner: string) => (isLettering(inner) ? lead : m));
  return t
    .replace(/\(\s*\)/g, '')
    .replace(/\s+([,.;:])/g, '$1')
    .replace(/,\s*,/g, ',')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/** Trademarks that appear in these stories, and the plain words a camera would see instead. */
const ART = '(?:([Aa]n?|[Tt]he)\\s+)?';
const BRANDS: [RegExp, string][] = [
  [new RegExp(`\\b${ART}OnePlus(?:\\s+\\d+\\w*)?(?:\\s+(?:device|phone|smartphone|handset))?\\b`, 'g'), 'smartphone'],
  [new RegExp(`\\b${ART}(?:iPhone|Pixel|Galaxy)(?:\\s+\\d+\\w*)?(?:\\s+(?:device|phone|smartphone))?\\b`, 'g'), 'smartphone'],
  [new RegExp(`\\b${ART}(?:Android|OxygenOS|ColorOS|iOS)\\b`, 'g'), 'phone'],
  [new RegExp(`\\b${ART}(?:Google|Apple|Samsung|Microsoft|Qualcomm|MediaTek)\\b`, 'g'), 'tech company'],
];

export function genericBrands(text: string): string {
  let t = String(text ?? '');
  for (const [re, plain] of BRANDS) {
    t = t.replace(re, (_m, art?: string) => {
      if (!art) return plain;
      const a = /^the$/i.test(art) ? 'the' : 'a';
      return `${/^[A-Z]/.test(art) ? a.charAt(0).toUpperCase() + a.slice(1) : a} ${plain}`;
    });
  }
  return t;
}

/**
 * Words that name harm rather than show a picture. In a clip direction, a sentence carrying one is story meaning
 * (the scene's narration covers it), so it is dropped. Listed, not guessed: each is a word a video filter's
 * violence / dangerous-content categories plausibly react to, and none is needed to describe what the camera sees.
 */
export const HARM_WORDS =
  /\b(hack(?:s|ed|er|ers|ing)?|exploit(?:s|ed|ing)?|malicious|malware|attack(?:s|ed|er|ers|ing)?|breach(?:es|ed)?|threat(?:s|ening)?|weapon\w*|victims?|inject(?:s|ed|ion|ing)?|payload|virus|steal\w*|stolen|criminal\w*|explo(?:de|des|ded|sion|sive)\w*|destroy\w*|kill\w*|blood\w*|bomb\w*|vulnerab\w*|compromis\w*|intrud\w*|infect\w*)\b/i;

/**
 * A clip direction with its story meaning taken out; '' when nothing visual is left (the caller falls back to the
 * scene's motion, then to a generic line). Harm adjectives go word by word first ("the malicious app box" → "the
 * app box"), then a sentence still carrying a harm word is dropped. Sentences about text stay: only the quoted
 * words come out (stripLettering), because "text reflections shimmer on his glasses" is a picture (an audit of the
 * first version, which dropped them, emptied 33 clip lines).
 */
export function dropStoryMeaning(text: string): string {
  // The same smallest-unit trim as a picture description (trimHarm): a clause such as ", emphasizing their
  // vulnerability" goes, the pulsing highlights stay. Words inside quoted lettering are left to stripLettering.
  return trimHarm(text);
}

/** Adjectives that label a thing harmful without changing what it looks like: dropped, the noun kept. */
const HARM_ADJECTIVES = /\b(malicious|vulnerable|compromised|infected|stolen|hostile|rogue|fraudulent)\s+(?=['"\u2018\u201c]?[A-Za-z])/gi;

export function dropHarmAdjectives(text: string): string {
  return String(text ?? '')
    .replace(HARM_ADJECTIVES, '')
    .replace(/(['"\u2018\u201c])([a-z][a-z ]{0,30})(['"\u2019\u201d])/g, '$2') // a lower-case quote left behind: plain words
    .replace(/\b([Aa]) ([aeiou])/g, '$1n $2');
}

/**
 * A picture description with its harm words trimmed at the smallest unit that holds them, so the picture survives:
 * a parenthesis ("(vulnerable)"), a trailing ", indicating vulnerability" clause, one half of a ";" sentence, and only
 * then the whole sentence.
 */
export function trimHarm(text: string): string {
  const sentences = dropHarmAdjectives(String(text ?? '')).split(/(?<=[.!?])\s+/);
  // Words inside quoted lettering are the picture's text, not a description of harm: kept where lettering is kept.
  const harmful = (t: string) => HARM_WORDS.test(t.replace(QUOTED, (_m, lead: string) => `${lead}"…"`));
  const kept = sentences.map((sentence) => {
    if (!harmful(sentence)) return sentence;
    let t = sentence.replace(/\s*\([^)]*\)/g, (p) => (harmful(p) ? '' : p));
    t = t.replace(/,?\s+\b(indicating|emphasi[sz]ing|signifying|representing|suggesting|symboli[sz]ing|showing|marking|highlighting)\b[^.;]*/gi, (c) => (harmful(c) ? '' : c));
    if (harmful(t)) {
      const parts = t.replace(/[.!?]$/, '').split(/\s*;\s*/).filter((p) => !harmful(p));
      t = parts.length ? `${parts.join('; ')}.` : '';
    }
    t = t.trim();
    return t && !/[.!?]$/.test(t) ? `${t}.` : t;
  });
  return kept.filter(Boolean).join(' ').replace(/\s{2,}/g, ' ').trim();
}

/** Brands generic, harm words trimmed, lettering kept: for a shot whose subject is the words (textIsSubject). */
export function evidenceText(text: string): string {
  return trimHarm(genericBrands(text));
}

/** Lettering out, brands generic, harm words trimmed: the form every picture description takes in a prompt. */
export function pictureText(text: string): string {
  // No re-capitalising: a character's promptAnchor must reach the prompt byte for byte.
  return trimHarm(genericBrands(stripLettering(text)));
}

export interface PromptRisk {
  kind: 'lettering' | 'brand' | 'harm-word';
  match: string;
}

/** What is still risky in a finished prompt: shown beside it, so the owner knows before a refusal costs a try. */
export function promptRisks(prompt: string): PromptRisk[] {
  const out: PromptRisk[] = [];
  for (const l of extractLettering(prompt)) out.push({ kind: 'lettering', match: l });
  for (const [re] of BRANDS) for (const m of String(prompt).matchAll(new RegExp(re.source, 'g'))) out.push({ kind: 'brand', match: m[0].trim() });
  const h = String(prompt).match(new RegExp(HARM_WORDS.source, 'gi'));
  for (const w of new Set(h ?? [])) out.push({ kind: 'harm-word', match: w });
  return out;
}

export interface SceneOverlay {
  text: string;
  /** 'headline' = the scene's onScreenText card; 'label' = lettering the picture description had, to place on screen. */
  kind: 'headline' | 'label';
  /** For a label: the sentence it came from, so the editor knows where it belongs in the frame. */
  where?: string;
  /** The label stays drawn in the still (the words are the shot's subject), so it is not added again in the edit. */
  inPicture?: boolean;
}

interface OverlaySceneLike extends SubjectSceneLike {
  onScreenText?: string;
  visual?: { character?: string; background?: string; scene?: string };
  visualPrompt?: string;
}

/** The scene's text, to add in the edit: its headline card and every label taken out of the picture. */
export function sceneOverlays(scene: OverlaySceneLike): SceneOverlay[] {
  const out: SceneOverlay[] = [];
  const head = String(scene.onScreenText ?? '').trim();
  if (head) out.push({ text: head, kind: 'headline' });
  const v = scene.visual;
  const source = v ? [v.background, v.scene, v.character].filter(Boolean).join(' ') : scene.visualPrompt || '';
  const sentences = source.split(/(?<=[.!?])\s+/);
  const inPicture = textIsSubject(scene);
  for (const label of extractLettering(source)) {
    if (out.some((o) => o.text.toLowerCase() === label.toLowerCase())) continue;
    const where = sentences.find((s) => s.includes(label));
    out.push({ text: label, kind: 'label', ...(where ? { where: pictureText(where) } : {}), ...(inPicture ? { inPicture: true } : {}) });
  }
  return out;
}

/**
 * The same rules for a prompt that arrives whole at the media endpoints (ContentRender sends the flat `visualPrompt`
 * and `motionPrompt`, the UI's buttons too), so every caller gets clean plates and picture-only motion.
 */
export function safeImagePrompt(prompt: string): string {
  // An evidence shot (the words framed as the subject) keeps them, as in the brief's own image prompts.
  if (textIsSubject({ visual: { scene: prompt } })) return evidenceText(prompt);
  const cleaned = pictureText(prompt);
  return hadLettering(prompt) ? `${cleaned} ${PLAIN_SURFACES}` : cleaned;
}

export function safeVideoPrompt(prompt: string): string {
  return pictureText(dropStoryMeaning(prompt)) || 'Slow, subtle camera movement.';
}

/** Framing words that make lettering the subject of a shot rather than a detail in it. */
const SUBJECT_FRAMING = /\b(focus(?:es|ed|ing)?|focal|close-?up|macro|centered|centred|fills the frame|occupies the frame|dominant|zoom(?:s|ing)? in(?:to)?)\b/i;

interface SubjectSceneLike {
  visual?: { character?: string; background?: string; scene?: string };
  clips?: { action?: string; camera?: string; endFrame?: string }[];
}

/**
 * True when the words are what the shot is about — a close-up of a version number, a letter's "LEGAL ACTION", a
 * date on a report: documentary evidence. Lifting that lettering out would leave a close-up of blank paper, so such
 * a scene keeps its words in the picture (Nano Banana Pro writes them accurately) and moves with a zoom in the edit
 * rather than an AI clip, which a filter can refuse over the words and which makes letters crawl.
 */
export function textIsSubject(scene: SubjectSceneLike): boolean {
  const v = scene.visual || {};
  const texts = [v.scene, v.background, v.character, ...(scene.clips || []).flatMap((c) => [c.action, c.camera, c.endFrame])];
  return texts.some((t) => String(t ?? '').split(/(?<=[.!?])\s+/).some((sen) => extractLettering(sen).length > 0 && SUBJECT_FRAMING.test(sen)));
}

/** True when the words drawn in a text-subject shot themselves name harm ("LOCAL ATTACK VECTOR ONLY"). */
export function letteringNamesHarm(scene: SubjectSceneLike & { visualPrompt?: string }): boolean {
  const v = scene.visual || {};
  const source = scene.visual ? [v.scene, v.background, v.character].join(' ') : scene.visualPrompt || '';
  return extractLettering(source).some((l) => HARM_WORDS.test(l));
}

/** True when the description had lettering, so the image prompt says to draw those surfaces plain. */
export function hadLettering(text: string): boolean {
  return extractLettering(text).length > 0;
}

/** Added to an image prompt whose lettering was taken out: positive wording, as "no text" tends to add text. */
export const PLAIN_SURFACES = 'Boards, signs, labels, papers and panels are plain and unmarked.';

/**
 * The prompt that cleans an existing still made with lettering in it (Nano Banana Pro's image editing in the Gemini
 * app): the still is kept, only its writing goes, and the words come back as overlays in the edit.
 */
export const CLEAN_PLATE_EDIT_PROMPT =
  'Edit this image: remove all writing, letters and numbers from every surface, leaving those surfaces plain, lit and textured exactly as they are. Keep everything else identical: composition, people, objects, light and colours.';
