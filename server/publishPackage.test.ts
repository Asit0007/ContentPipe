import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetModelCooldowns } from './gemini';
import { QuotaExhaustedError } from './quota';
import { analyzeScript } from './timeline';
import { lintTitle, lintThumbnail, normalizeHashtags, fitTags, assembleDescription, buildPublishPackage } from './publishPackage';

const RESEARCH = {
  topicTitle: 'Backdoor in upstream xz/liblzma',
  oneLineHook: 'A maintainer-level backdoor nearly reached every SSH server.',
  summary: 's',
  keyFacts: ['Tracked as CVE-2024-3094.', 'Affects xz 5.6.0 and 5.6.1.'],
  timeline: [],
  retrievedSources: [
    { id: 'S1', ok: true, title: 'oss-security thread', url: 'https://www.openwall.com/lists/oss-security/2024/03/29/4' },
    { id: 'S2', ok: false, title: 'dead', url: 'https://dead.example/x', error: 'HTTP 404' },
    { id: 'S3', ok: true, title: 'HN thread', url: 'https://news.ycombinator.com/item?id=39865810' },
  ],
};
const rules = (issues: Array<{ rule: string }>) => issues.map((i) => i.rule);
const errorsOf = <T extends { severity: string }>(issues: T[]) => issues.filter((i) => i.severity === 'error');

// ------------------------------------------------------------------------------------------ title lint

test('a clean, front-loaded, in-band title has no errors or warnings', () => {
  const t = 'xz Backdoor: How One Account Nearly Reached SSH Servers';
  assert.ok(t.length >= 45 && t.length <= 60, String(t.length));
  assert.deepEqual(lintTitle(t, { research: RESEARCH }).filter((i) => i.severity !== 'info'), []);
});

test('hard length limit is an error; outside the ideal band is only info', () => {
  assert.ok(rules(errorsOf(lintTitle('x'.repeat(71)))).includes('too-long'));
  const mid = lintTitle('How xz Reached SSH Servers Through a Trusted Maintainer Account'); // 62 chars
  assert.ok(!errorsOf(mid).length);
  assert.ok(rules(mid).includes('length-outside-ideal'));
});

test('banned clickbait phrases, emoji and exclamation marks are caught', () => {
  assert.ok(rules(errorsOf(lintTitle("You won't believe what xz did"))).includes('banned-phrase'));
  assert.ok(rules(errorsOf(lintTitle('The SHOCKING xz backdoor explained'))).includes('banned-phrase'));
  assert.ok(rules(errorsOf(lintTitle('The xz backdoor explained 🔥'))).includes('emoji'));
  assert.ok(rules(lintTitle('The xz backdoor explained!')).includes('exclamation'));
});

test('ALL-CAPS: acronyms up to 5 letters pass; longer shouting words are flagged', () => {
  assert.ok(!rules(lintTitle('How the XZ Backdoor Hit SSH and TLS Stacks Worldwide')).includes('all-caps-word'));
  assert.ok(rules(lintTitle('Inside the CATASTROPHIC xz Breach and Its Fallout')).includes('all-caps-word'));
});

test('titles carry no brackets', () => {
  assert.ok(rules(lintTitle('The xz Backdoor [EXPLAINED] Step by Step in Detail')).includes('brackets'));
  assert.ok(!rules(lintTitle('The xz Backdoor, Explained Step by Step in Detail')).includes('brackets'));
});

test('a CVE id or CVSS score in a title is an ERROR even when the dossier has it: the audience is not technical', () => {
  for (const t of [
    'CVE-2024-3094: What the xz Backdoor Actually Did',
    '[CVE-2024-3094] The xz Backdoor, Explained Step by Step',
    'The xz Backdoor Scored a Perfect 10 on CVSS',
    'Why Two CVEs in xz Nearly Reached Every SSH Server',
  ]) assert.ok(rules(errorsOf(lintTitle(t, { research: RESEARCH }))).includes('severity-rating'), t);
  assert.ok(!rules(lintTitle('How Cvent-Style Phishing Hit the xz Maintainers Hard')).includes('severity-rating'));
});

test('figures in a title must come from the dossier — an invented number is an ERROR', () => {
  const bad = lintTitle('5 Million Servers at Risk From the xz Backdoor', { research: RESEARCH });
  assert.ok(rules(errorsOf(bad)).includes('unsupported-specific'));
  const ok = lintTitle('What the xz Backdoor in 5.6.1 Actually Did to SSH', { research: RESEARCH });
  assert.ok(!rules(ok).includes('unsupported-specific'));
});

test('a title figure that is only a substring of a dossier figure is still unsupported', () => {
  // The dossier has CVE-2024-3094 and 5.6.1; "CVE-2024-309" / "5.6" style prefixes and "94%" must not ride along.
  const research = { ...RESEARCH, keyFacts: ['Tracked as CVE-2024-30945.', 'Affects xz 5.6.10.', 'Cost 2094 hours.'] };
  const bad = lintTitle('CVE-2024-3094 in xz 5.6.1 Hit 94% of Builds Overnight', { research });
  const flagged = bad.filter((i) => i.rule === 'unsupported-specific').map((i) => i.message);
  for (const t of ['CVE-2024-3094', '5.6.1', '94%']) assert.ok(flagged.some((m) => m.includes(`"${t}"`)), `${t}: ${JSON.stringify(flagged)}`);
});

test('front-loading is only advisory (info): a title that buries the keyword is noted, not rejected', () => {
  const buried = lintTitle('A Quiet Threat Nobody Noticed for Years, and Why', { research: RESEARCH });
  assert.equal(buried.find((i) => i.rule === 'keyword-not-front-loaded')?.severity, 'info');
  assert.ok(!errorsOf(buried).length);
});

// ------------------------------------------------------------------------------------------ thumbnail lint

test('thumbnail overlay: 2-4 words, readable length, no generic HACKED', () => {
  assert.deepEqual(lintThumbnail({ textOverlay: 'BREACH MAP', imagePrompt: 'a server rack' }), []);
  assert.ok(rules(lintThumbnail({ textOverlay: 'HACKED', imagePrompt: 'x' })).includes('generic-hacked-text'));
  const long = lintThumbnail({ textOverlay: 'THE ENTIRE INTERNET IS ON FIRE', imagePrompt: 'x' });
  assert.ok(rules(long).includes('overlay-word-count') && rules(long).includes('overlay-too-long'));
  assert.ok(rules(errorsOf(lintThumbnail({ textOverlay: 'CVSS 9.8', imagePrompt: 'x' }))).includes('severity-rating'));
  assert.ok(rules(errorsOf(lintThumbnail({ textOverlay: 'CVE-2024-3094', imagePrompt: 'x' }))).includes('severity-rating'));
});

test('thumbnail prompt: banned motifs are flagged, but naming them in a NEGATIVE clause is fine', () => {
  assert.ok(rules(lintThumbnail({ textOverlay: 'BREACH MAP', imagePrompt: 'a glowing skull over a server rack' })).includes('forbidden-motif'));
  assert.ok(rules(lintThumbnail({ textOverlay: 'BREACH MAP', imagePrompt: 'hooded hacker at a laptop' })).includes('forbidden-motif'));
  assert.deepEqual(lintThumbnail({ textOverlay: 'BREACH MAP', imagePrompt: 'a server rack, no skulls, no hoodies, without matrix rain' }), []);
});

// ------------------------------------------------------------------------------------------ tags / hashtags / description

test('hashtags: lowercase alphanumerics, no #, deduped, max 5', () => {
  assert.deepEqual(normalizeHashtags(['#CyberSecurity', 'Cyber Security', 'infosec', '#InfoSec', 'xz-utils!', 'a', 'b', 'c']), ['cybersecurity', 'infosec', 'xzutils', 'a', 'b']);
});

test('tags: deduped case-insensitively, # stripped, trimmed to the 500-char budget', () => {
  assert.deepEqual(fitTags(['#Cybersecurity', 'cybersecurity', ' infosec ', 'xz backdoor']), ['Cybersecurity', 'infosec', 'xz backdoor']);
  const many = Array.from({ length: 200 }, (_, i) => `tag-number-${i}`);
  const fitted = fitTags(many);
  assert.ok(fitted.join(',').length <= 500);
  assert.ok(fitted.length > 10 && fitted.length < 200);
});

test('description: hook, bullets, chapters and ONLY retrieved URLs; contact links are explicit placeholders, never invented', () => {
  const chapters = [{ startSec: 0, timestamp: '0:00', label: 'Hook' }, { startSec: 40, timestamp: '0:40', label: 'Context' }, { startSec: 180, timestamp: '3:00', label: 'The Fix' }];
  const { description, todos } = assembleDescription({ hook: 'Hook line one.', bullets: ['Point A', 'Point B'], chapters, research: RESEARCH, brand: 'Blast Radius', hashtags: ['cybersecurity'] });
  assert.match(description, /^Hook line one\./);
  assert.match(description, /• Point A/);
  assert.match(description, /0:00 Hook\n0:40 Context\n3:00 The Fix/);
  assert.match(description, /Subscribe to Blast Radius/);
  assert.match(description, /#cybersecurity$/);
  const urls = description.match(/https?:\/\/\S+/g) || [];
  const allowed = RESEARCH.retrievedSources.filter((s) => s.ok).map((s) => s.url);
  assert.deepEqual(urls.sort(), [...allowed].sort(), 'no URL may appear that was not retrieved (and the failed source must not)');
  assert.doesNotMatch(description, /dead\.example/);
  for (const ph of ['{{NEWSLETTER_URL}}', '{{X_HANDLE}}', '{{LINKEDIN_URL}}']) {
    assert.ok(description.includes(ph));
    assert.ok(todos.some((t) => t.includes(ph)), `todo for ${ph}`);
  }
});

test('description: too few chapters and no sources become explicit todos instead of fabricated sections', () => {
  const { description, todos } = assembleDescription({ hook: 'h', bullets: [], chapters: [], research: { retrievedSources: [] }, hashtags: [] });
  assert.doesNotMatch(description, /Chapters:|Sources & further reading:/);
  assert.ok(todos.some((t) => /No chapters/.test(t)) && todos.some((t) => /No sources were retrieved/.test(t)));
});

// ------------------------------------------------------------------------------------------ orchestration (fake model)

const perDay = () =>
  Object.assign(new Error(JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'quota, limit: 20', details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }] } })), { status: 429 });

const goodTitles = [
  { title: 'xz Backdoor: How One Account Nearly Reached SSH Servers', structure: 'how_entity_verb_object', angle: 'a', bestThumbnail: 'A' },
  { title: 'The Quiet Truth About the xz Backdoor and Open-Source Trust', structure: 'truth_about', angle: 'b', bestThumbnail: 'B' },
  { title: 'Inside the xz Backdoor: The ifunc Hook That Hid in Plain Sight', structure: 'inside_event', angle: 'c', bestThumbnail: 'C' },
  { title: 'Why the xz Backdoor Is a Warning About Maintainer Burnout', structure: 'why_concept_is_stakes', angle: 'd', bestThumbnail: 'B' },
  { title: 'Things xz Maintainers and Distros Got Wrong About Trust', structure: 'number_things_got_wrong', angle: 'e', bestThumbnail: 'C' },
];
const thumbs = ['A', 'B', 'C'].map((v) => ({ variant: v, concept: `Concept ${v}`, imagePrompt: 'a server rack, dark background', textOverlay: 'BREACH MAP', layout: 'left third', rationale: 'r' }));
const rawResponse = (titles = goodTitles) => ({
  titles, thumbnails: thumbs, descriptionHook: 'A hook that says something concrete about the xz backdoor.',
  learnBullets: ['How it got in', 'Why it was caught', 'What to audit'], tags: Array.from({ length: 16 }, (_, i) => `tag ${i}`), hashtags: ['#CyberSecurity', '#infosec', '#xz'],
});

function fakeAi(handler: (n: number, prompt: string) => any) {
  const prompts: string[] = [];
  const ai: any = {
    models: {
      generateContent: async ({ contents }: { contents: string }) => {
        prompts.push(String(contents));
        return { text: JSON.stringify(handler(prompts.length, String(contents))), candidates: [{ finishReason: 'STOP' }], usageMetadata: {} };
      },
    },
  };
  return { ai, prompts };
}

const script = () => {
  const scenes = Array.from({ length: 54 }, (_, i) => ({
    sceneNumber: i + 1, title: `Scene ${i + 1}`, actPhase: i < 4 ? 'Hook' : i < 18 ? 'Context' : i < 41 ? 'Technical Breakdown' : 'The Fix',
    narration: 'word '.repeat(28).trim(), durationEst: 10, visualType: i % 2 ? 'diagram' : 'terminal', onScreenText: 'x', soundEffect: 'y',
  }));
  const s: any = { title: 'The xz Backdoor', estimatedTotalDuration: 540, scenes };
  Object.assign(s, analyzeScript(s, { requestedDurationSec: 540, research: RESEARCH }));
  return s;
};

beforeEach(() => resetModelCooldowns());

test('happy path: linted titles, the LINTER recommends, description carries real chapters/sources, one model call', async () => {
  const { ai, prompts } = fakeAi(() => rawResponse());
  const pkg = await buildPublishPackage(ai, { script: script(), research: RESEARCH, channelBrandName: 'Blast Radius' });
  assert.equal(prompts.length, 1);
  assert.equal(pkg.titles.length, 5);
  assert.ok(pkg.titles.every((t) => t.passesLint), JSON.stringify(pkg.titles.map((t) => t.lint)));
  assert.ok(pkg.recommendedTitle && pkg.titles.some((t) => t.title === pkg.recommendedTitle));
  assert.equal(pkg.recommendedThumbnail, pkg.titles.find((t) => t.title === pkg.recommendedTitle)!.bestThumbnail);
  assert.deepEqual(pkg.midrollTimestamps, ['2:30', '6:00']);
  assert.ok(pkg.chapters.length >= 3);
  assert.deepEqual(pkg.hashtags, ['cybersecurity', 'infosec', 'xz']);
  assert.match(pkg.description, /0:00 Hook/);
  assert.match(pkg.description, /openwall\.com/);
  assert.ok(pkg.todos.some((t) => t.includes('{{NEWSLETTER_URL}}')));
  assert.equal(pkg.deterministicOnly, undefined);
});

test('lint failure triggers exactly ONE retry carrying the specific violations; the better attempt wins', async () => {
  const bad = goodTitles.map((t) => ({ ...t, title: `${t.title} and a very long tail that pushes it well past seventy characters` }));
  const { ai, prompts } = fakeAi((n) => (n === 1 ? rawResponse(bad) : rawResponse()));
  const pkg = await buildPublishPackage(ai, { script: script(), research: RESEARCH });
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /A previous attempt failed these checks/);
  assert.match(prompts[1], /the hard maximum is 70/);
  assert.ok(pkg.titles.every((t) => t.passesLint));
});

test('if the retry is no better, the result is returned FLAGGED with no recommendation (never silently "fixed")', async () => {
  const bad = goodTitles.map((t) => ({ ...t, title: `${t.title} and a very long tail that pushes it well past seventy characters` }));
  const { ai, prompts } = fakeAi(() => rawResponse(bad));
  const pkg = await buildPublishPackage(ai, { script: script(), research: RESEARCH });
  assert.equal(prompts.length, 2, 'one retry, never a loop');
  assert.equal(pkg.recommendedTitle, undefined);
  assert.ok(pkg.titles.every((t) => !t.passesLint));
  assert.ok(pkg.todos.some((t) => /No title passed the lint rules/.test(t)));
});

test('an invented figure in a title is rejected by the linter even though the model wrote it', async () => {
  const sneaky = [{ ...goodTitles[0], title: '5 Million Servers Hit: The xz Backdoor Explained Fully' }, ...goodTitles.slice(1)];
  const { ai } = fakeAi(() => rawResponse(sneaky));
  const pkg = await buildPublishPackage(ai, { script: script(), research: RESEARCH });
  assert.equal(pkg.titles[0].passesLint, false);
  assert.ok(pkg.titles[0].lint.some((i) => i.rule === 'unsupported-specific'));
  assert.notEqual(pkg.recommendedTitle, pkg.titles[0].title);
});

test('STRICT: a quota failure throws so the endpoint can answer 429; nothing canned is returned', async () => {
  const ai: any = { models: { generateContent: async () => { throw perDay(); } } };
  await assert.rejects(buildPublishPackage(ai, { script: script(), research: RESEARCH }, { strict: true }), (e: any) => e instanceof QuotaExhaustedError && e.kind === 'per_day');
});

test('NON-strict: the model being unavailable still yields the deterministic parts, honestly flagged — no invented titles', async () => {
  resetModelCooldowns();
  const ai: any = { models: { generateContent: async () => { throw perDay(); } } };
  const pkg = await buildPublishPackage(ai, { script: script(), research: RESEARCH, channelBrandName: 'Blast Radius' }, { strict: false });
  assert.equal(pkg.deterministicOnly, true);
  assert.equal(pkg.isQuotaFallback, true);
  assert.deepEqual(pkg.titles, []);
  assert.deepEqual(pkg.thumbnails, []);
  assert.deepEqual(pkg.midrollTimestamps, ['2:30', '6:00']);
  assert.ok(pkg.chapters.length >= 3);
  assert.ok(pkg.todos[0].startsWith('AI generation was unavailable'));
});
