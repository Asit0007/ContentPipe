/**
 * Replaces CVE ids in what a viewer sees or hears, in code, instead of only warning about them.
 *
 * The prompt asks for none (the "SHOW THE DAMAGE, DON'T RATE IT" block) and the audit flags any that get
 * through as `severity-rating-shown`, but a model that ignores the prompt still wrote "CVE-2014-0160 RESOLVED"
 * into a badge and "the lifecycle of CVE-2014-0160" into a summary, and a warning does not take them off the
 * screen. A CVE id has a clean neutral stand-in — "the flaw" — so it can be replaced rather than left for a person.
 *
 * Only ids are replaced. A label such as "CRITICAL RISK" has no grammar-preserving rewrite, so the audit flags
 * it (`severity-label-shown`) and a person rewords it. The research dossier keeps CVE ids: they are facts, and
 * the specifics check still needs them. Code snippets and the image/motion prompts are left alone, as the audit
 * leaves them.
 */

const DASH = String.raw`[-‐-―−]`;
const CVE_ID = String.raw`CVE${DASH}\d{4}${DASH}\d{4,7}(?!\d)`;
const HAS_ID = new RegExp(CVE_ID, 'i');
const ID = new RegExp(CVE_ID, 'gi');
const BRACKETED = new RegExp(String.raw`\s*[(\[]\s*${CVE_ID}(?:\s*[,;/&]\s*${CVE_ID})*\s*[)\]]`, 'gi');

const STAND_IN = 'the flaw';

function replaceIds(text: string): string {
  // An all-caps badge or on-screen line keeps its case; a sentence keeps its capital.
  const shouting = !/[a-z]/.test(text);
  const stripped = text.replace(BRACKETED, '');
  // Looked up once and through a short window: slicing the whole prefix for every match made this O(n²) (800 KB of
  // ids took 1.7 s). A whitespace run longer than the window before an id only costs a lower-case "the flaw".
  const firstText = stripped.search(/\S/);
  const out = stripped.replace(ID, (_match, offset: number, whole: string) => {
    const startsSentence = offset <= firstText || /[.!?]["')\]]*\s+$/.test(whole.slice(Math.max(0, offset - 16), offset));
    return shouting ? STAND_IN.toUpperCase() : startsSentence ? 'The flaw' : STAND_IN;
  });
  return out.replace(/\s{2,}/g, ' ').trim();
}

export type ScrubChange = { sceneNumber: number; fields: string[] };

function scrubScene(s: any): { scene: any; fields: string[] } {
  const fields: string[] = [];
  const fix = (target: any, key: string, label: string) => {
    const v = target?.[key];
    if (typeof v === 'string' && HAS_ID.test(v)) {
      target[key] = replaceIds(v);
      fields.push(label);
    }
  };

  const scene = { ...s };
  fix(scene, 'narration', 'narration');
  fix(scene, 'onScreenText', 'onScreenText');

  if (s?.infographic && typeof s.infographic === 'object') {
    const g = { ...s.infographic };
    for (const k of ['title', 'badge', 'summary']) fix(g, k, `infographic.${k}`);
    if (Array.isArray(g.steps)) {
      g.steps = g.steps.map((st: any) => {
        const c = { ...st };
        fix(c, 'label', 'infographic.steps');
        fix(c, 'detail', 'infographic.steps');
        return c;
      });
    }
    if (Array.isArray(g.metrics)) {
      g.metrics = g.metrics.map((m: any) => {
        const c = { ...m };
        for (const k of ['label', 'value', 'subtext']) fix(c, k, 'infographic.metrics');
        return c;
      });
    }
    scene.infographic = g;
  }
  return { scene, fields: [...new Set(fields)] };
}

/** Returns the scenes with CVE ids replaced (untouched scenes keep their identity) and what changed where. */
export function scrubCveIds(scenes: any[]): { scenes: any[]; changes: ScrubChange[] } {
  if (!Array.isArray(scenes)) return { scenes, changes: [] };
  const changes: ScrubChange[] = [];
  const out = scenes.map((s, i) => {
    const { scene, fields } = scrubScene(s);
    if (!fields.length) return s;
    changes.push({ sceneNumber: Number(s?.sceneNumber) || i + 1, fields });
    return scene;
  });
  return { scenes: out, changes };
}
