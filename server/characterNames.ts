/**
 * Character names never reach an image or video model (2026-10-01).
 *
 * The production bible gives each character a name, and the bible for a news story may name a character after the
 * real person in it (the OnePlus story's researcher was "Rasmus", after the real researcher). The art-direction and
 * clip passes then wrote that name into the picture prompts — "Rasmus breathes slowly" — and Gemini refused the clip
 * ("That request looks like it goes against our terms"): a photorealistic face plus a real person's name reads as a
 * request to depict that person. The face is invented, so presenting it as him would also mislead the viewer.
 *
 * So every field a picture is made from calls a character by description ("the man"), never by name. Narration,
 * on-screen text and infographics are left alone: naming the people in a story there is reporting.
 */

interface BibleEntry {
  id?: string;
  name?: string;
  promptAnchor?: string;
  appearance?: string;
}

/** "the man" / "the woman" / "the person", read from the character's own description. */
export function characterReference(entry: BibleEntry): string {
  const text = `${entry.promptAnchor || ''} ${entry.appearance || ''}`.toLowerCase();
  const m = /\b(woman|man|girl|boy)\b/.exec(text);
  return m ? `the ${m[1]}` : 'the person';
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Names worth replacing: real first names, not role labels such as "The Representative" (those are descriptions already). */
function replaceableNames(bible: BibleEntry[]): { name: string; ref: string }[] {
  return bible
    .map((e) => ({ name: String(e?.name || '').trim(), ref: characterReference(e) }))
    .filter((n) => n.name.length >= 2 && !/^the\s/i.test(n.name))
    .sort((a, b) => b.name.length - a.name.length); // longest first, so "Rasmus Moorats" goes before "Rasmus"
}

/** Replaces each name (whole word, possessive kept) with its reference, capitalised at the start of a sentence. */
export function scrubNames(text: string, names: { name: string; ref: string }[]): string {
  let out = String(text ?? '');
  for (const { name, ref } of names) {
    const re = new RegExp(`(^|[^\\p{L}])(${escapeRe(name)})(?![\\p{L}])`, 'gu');
    out = out.replace(re, (_m, before: string, _n: string, offset: number) => {
      const start = offset + before.length;
      const lead = out.slice(0, start).trimEnd();
      const sentenceStart = lead === '' || /[.!?:]$/.test(lead) || /\n$/.test(out.slice(0, start));
      return before + (sentenceStart ? ref.charAt(0).toUpperCase() + ref.slice(1) : ref);
    });
  }
  return out;
}

const VISUAL_FIELDS = ['character', 'background', 'scene', 'negative'] as const;
const MOTION_FIELDS = ['shotType', 'cameraMove', 'subjectMotion', 'motionPrompt'] as const;
const CLIP_FIELDS = ['action', 'camera', 'environment', 'endFrame'] as const;

/** The scenes with every picture field cleared of character names. Narration and on-screen text are untouched. */
export function scrubCharacterNames(scenes: any[], bible: BibleEntry[] | undefined): any[] {
  const names = replaceableNames(Array.isArray(bible) ? bible : []);
  if (names.length === 0) return scenes;
  const fix = (v: unknown) => (typeof v === 'string' ? scrubNames(v, names) : v);
  return scenes.map((s) => {
    const out = { ...s };
    if (typeof s.visualPrompt === 'string') out.visualPrompt = fix(s.visualPrompt);
    if (typeof s.cinematography === 'string') out.cinematography = fix(s.cinematography);
    if (s.visual) {
      out.visual = { ...s.visual };
      for (const k of VISUAL_FIELDS) if (k in out.visual) out.visual[k] = fix(out.visual[k]);
    }
    if (s.motion) {
      out.motion = { ...s.motion };
      for (const k of MOTION_FIELDS) if (k in out.motion) out.motion[k] = fix(out.motion[k]);
    }
    if (Array.isArray(s.clips)) {
      out.clips = s.clips.map((c: any) => {
        const cc = { ...c };
        for (const k of CLIP_FIELDS) if (k in cc) cc[k] = fix(cc[k]);
        return cc;
      });
    }
    return out;
  });
}
