import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderScriptMarkdown } from './markdownExporter';
import { analyzeScript } from './timeline';

const scene = (n: number, o: any = {}) => ({
  sceneNumber: n, title: `Scene ${n}`, actPhase: n <= 4 ? 'Hook' : n <= 18 ? 'Context' : n <= 41 ? 'Technical Breakdown' : 'The Fix',
  narration: 'word '.repeat(28).trim(), durationEst: 10, visualType: n % 2 ? 'terminal' : 'diagram', onScreenText: 'x', soundEffect: 'y', ...o,
});
const longScript = (over: any = {}) => {
  const scenes = Array.from({ length: 54 }, (_, i) => scene(i + 1));
  const script: any = { title: 'T', targetPlatform: 'YouTube Long-form (16:9)', aspectRatio: '16:9', estimatedTotalDuration: 540, scenes, signatureIntro: '', signatureOutro: 'Sources are linked in the description.', ...over };
  Object.assign(script, analyzeScript(script, { requestedDurationSec: 540 }));
  return script;
};
const render = (script: any, research?: any) => renderScriptMarkdown({ script, research, plan: { tone: 'Deep Dive Documentary' }, channelBrandName: 'Blast Radius' });

test('the fabricated "Virality score" row is gone, even when a legacy script still carries the field', () => {
  assert.doesNotMatch(render(longScript({ viralityScore: 96 })), /Virality/i);
});

test('documentary script: no "Welcome back" intro anywhere; the calm outro is present', () => {
  const md = render(longScript());
  assert.doesNotMatch(md, /Welcome back/i);
  assert.match(md, /_Sources are linked in the description\._/);
});

test('shot list has a Start column driven by the timeline', () => {
  const md = render(longScript());
  assert.match(md, /\| # \| Start \| Scene \| Dur \|/);
  assert.match(md, /\| 15 \| 2:20 \| Scene 15 \|/); // scene 15 starts at 14*10 = 140s
});

test('mid-rolls and chapters are exported, with the reason for each placement', () => {
  const md = render(longScript());
  assert.match(md, /## Timeline & monetization/);
  assert.match(md, /### Chapters[\s\S]*\| 0:00 \| Hook \|/);
  assert.match(md, /### Manual mid-roll placement/);
  assert.match(md, /midroll_1: "2:30"/);
  assert.match(md, /midroll_2: "6:00"/);
});

test('quality checks section lists errors, and the manual checklist is always present', () => {
  const md = render(longScript({ scenes: Array.from({ length: 54 }, (_, i) => scene(i + 1, { visualType: 'character' })) }));
  assert.match(md, /## Quality checks/);
  assert.match(md, /\| ERROR \| ai-slideshow-risk \|/);
  assert.match(md, /## Pre-publish checklist \(manual\)/);
  assert.match(md, /- \[ \] Narration rewritten by a human/);
  assert.match(md, /altered or synthetic content/);
});

test('an incomplete generation is announced at the top with every degraded note', () => {
  const md = render(longScript({ generation: { complete: false, requestedScenes: 47, producedScenes: 21, requestedDurationSec: 540, producedDurationSec: 210, degraded: ['Narrative chunk 8/16 failed: script stops at 21/47 scenes.'] } }));
  const banner = md.slice(0, md.indexOf('## Production summary'));
  assert.match(banner, /Incomplete generation:\*\* 21\/47 scenes/);
  assert.match(banner, /script stops at 21\/47 scenes/);
  assert.match(md, /INCOMPLETE — 21\/47 scenes/);
  assert.match(md, /generation_complete: false/);
});

test('canned fallback content is announced at the top', () => {
  const md = render(longScript({ isQuotaFallback: true }));
  assert.match(md.slice(0, md.indexOf('## Production summary')), /Canned fallback content/);
});

test('an HN quote without karma renders cleanly — never "undefined karma"', () => {
  const s = longScript();
  s.scenes[3].infographic = { type: 'sentiment_gauge', title: 't', commentQuote: { author: 'rwmj', comment: 'verbatim text', vibe: 'insightful' } };
  const md = render(s);
  assert.match(md, /> — \*\*rwmj\*\* \(insightful\)/);
  assert.doesNotMatch(md, /undefined|NaN/);
});

test('retrieval labels: HN API is disclosed and does not trigger the "not read live" rescue banner', () => {
  const research = { retrievedSources: [
    { id: 'S1', url: 'https://a.example', title: 'A', ok: true, wordCount: 100, via: 'direct' },
    { id: 'S2', url: 'https://news.ycombinator.com/item?id=1', title: 'HN', ok: true, wordCount: 100, via: 'hn-api' },
  ] };
  const md = render(longScript(), research);
  assert.match(md, /HN API \(discussion thread\)/);
  assert.doesNotMatch(md, /were not read live/);
});

test('a script from before the analysis existed still exports (every new field is optional)', () => {
  const legacy: any = { title: 'Old', scenes: [scene(1)], estimatedTotalDuration: 10 };
  assert.doesNotThrow(() => render(legacy));
  const md = render(legacy);
  assert.doesNotMatch(md, /## Quality checks/);
  assert.match(md, /## Pre-publish checklist \(manual\)/);
});

test('publishing package: recommended title, linted titles, thumbnail prompts, description and open todos are exported', () => {
  const s = longScript({
    publish: {
      titles: [{ title: 'xz Backdoor: How CVE-2024-3094 Reached SSH', structure: 'how_entity_verb_object', angle: 'a', bestThumbnail: 'A', chars: 44, passesLint: true, lint: [{ rule: 'length-outside-ideal', severity: 'info', message: 'x' }] }],
      thumbnails: [{ variant: 'A', concept: 'Breach Map', imagePrompt: 'a server rack, dark background', textOverlay: 'BREACH MAP', layout: 'left third', rationale: 'why', lint: [] }],
      recommendedTitle: 'xz Backdoor: How CVE-2024-3094 Reached SSH', recommendedThumbnail: 'A', description: 'Hook line.\n\nNewsletter: {{NEWSLETTER_URL}}', descriptionWordCount: 4,
      chapters: [], midrollTimestamps: ['2:30', '6:00'], tags: ['xz', 'infosec'], hashtags: ['cybersecurity'], todos: ['Fill in {{NEWSLETTER_URL}}'], generatedAt: '2026-09-19T00:00:00Z',
    },
  });
  const md = render(s);
  assert.match(md, /## Publishing package/);
  assert.match(md, /\*\*Recommended title:\*\* xz Backdoor: How CVE-2024-3094 Reached SSH — pair with thumbnail A/);
  assert.match(md, /### Thumbnail A — Breach Map/);
  assert.match(md, /a server rack, dark background/);
  assert.match(md, /\*\*Hashtags:\*\* #cybersecurity/);
  assert.match(md, /- \[ \] Fill in \{\{NEWSLETTER_URL\}\}/);
  assert.doesNotMatch(md, /length-outside-ideal/, 'info-level lint is noise in the table');
});

test('a deterministic-only package says loudly that no titles were produced', () => {
  const md = render(longScript({ publish: { titles: [], thumbnails: [], description: 'd', descriptionWordCount: 1, chapters: [], midrollTimestamps: [], tags: [], hashtags: [], todos: [], deterministicOnly: true, isQuotaFallback: true, generatedAt: 'x' } }));
  assert.match(md, /AI generation was unavailable\*\* — no titles, thumbnails or tags were produced/);
});
