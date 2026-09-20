import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatTimestamp,
  buildTimeline,
  buildChapters,
  placeMidrolls,
  auditScript,
  analyzeScript,
  extractSpecifics,
  specificKey,
  MIDROLL_MIN_VIDEO_SEC,
} from './timeline';

const scene = (n: number, o: any = {}) => ({
  sceneNumber: n,
  title: `S${n}`,
  actPhase: 'Technical Breakdown',
  narration: 'word '.repeat(28).trim(), // 28 words in 10s = 168 wpm: inside the 110-190 band
  durationEst: 10,
  visualType: 'terminal',
  ...o,
});
const scenes = (count: number, fn: (i: number) => any = () => ({})) => Array.from({ length: count }, (_, i) => scene(i + 1, fn(i)));
const ids = (checks: Array<{ id: string }>) => checks.map((c) => c.id);
const find = (checks: any[], id: string) => checks.find((c) => c.id === id);

test('formatTimestamp', () => {
  assert.equal(formatTimestamp(0), '0:00');
  assert.equal(formatTimestamp(65), '1:05');
  assert.equal(formatTimestamp(150), '2:30');
  assert.equal(formatTimestamp(3725), '1:02:05');
});

test('buildTimeline accumulates durations and keeps scene numbers', () => {
  const t = buildTimeline([scene(1, { durationEst: 8 }), scene(2, { durationEst: 12 }), scene(3, { durationEst: 5 })]);
  assert.deepEqual(t.map((e) => [e.sceneNumber, e.startSec, e.endSec]), [[1, 0, 8], [2, 8, 20], [3, 20, 25]]);
});

// ------------------------------------------------------------------------------------------- chapters

test('chapters: none for short-form; grouped by actPhase with exact hand-computed starts for a 54x10s script', () => {
  assert.deepEqual(buildChapters(scenes(10), buildTimeline(scenes(10))), []);
  const phases = (i: number) => ({ actPhase: i < 4 ? 'Hook' : i < 18 ? 'Context' : i < 41 ? 'Technical Breakdown' : i < 48 ? 'The Fix' : 'Conclusion' });
  const s = scenes(54, phases);
  const ch = buildChapters(s, buildTimeline(s));
  assert.deepEqual(ch.map((c) => [c.timestamp, c.label]), [['0:00', 'Hook'], ['0:40', 'Context'], ['3:00', 'Technical Breakdown'], ['6:50', 'The Fix'], ['8:00', 'Conclusion']]);
  assert.equal(ch[0].startSec, 0);
});

test('chapters: a segment under 10s is folded into its neighbour (YouTube needs >=10s each)', () => {
  const s = [...scenes(6, () => ({ actPhase: 'Hook' })), scene(7, { actPhase: 'Aside', durationEst: 8 }), ...scenes(8, () => ({ actPhase: 'Context' })).map((x, i) => ({ ...x, sceneNumber: 8 + i })),
    ...scenes(8, () => ({ actPhase: 'Fix' })).map((x, i) => ({ ...x, sceneNumber: 16 + i }))];
  const ch = buildChapters(s, buildTimeline(s));
  assert.ok(!ch.some((c) => c.label === 'Aside'));
  assert.deepEqual(ch.map((c) => c.label), ['Hook', 'Context', 'Fix']);
});

test('chapters: fewer than 3 usable chapters → none; a script with a unique label per scene is folded to <=12', () => {
  const two = scenes(20, (i) => ({ actPhase: i < 10 ? 'A' : 'B' }));
  assert.deepEqual(buildChapters(two, buildTimeline(two)), []);
  const many = scenes(54, (i) => ({ actPhase: `Phase ${i}` }));
  const ch = buildChapters(many, buildTimeline(many));
  assert.equal(ch.length, 12);
  assert.equal(ch[0].startSec, 0);
});

// ------------------------------------------------------------------------------------------- mid-rolls

test('mid-roll: two markers land on real scene boundaries near 2:30 and 6:00, >=60s apart, never after the last scene', () => {
  const s = scenes(54);
  const t = buildTimeline(s);
  const { markers } = placeMidrolls(s, t);
  assert.equal(markers.length, 2);
  for (const m of markers) {
    assert.ok(t.some((e) => e.endSec === m.atSec), 'must snap to a scene boundary');
    assert.ok(Math.abs(m.atSec - m.targetSec) <= 25);
    assert.ok(m.afterSceneNumber < 54);
  }
  assert.deepEqual(markers.map((m) => [m.index, m.atSec, m.timestamp]), [[1, 150, '2:30'], [2, 360, '6:00']]);
  assert.ok(markers[1].atSec - markers[0].atSec >= 60);
});

test('mid-roll #1 prefers a boundary right after the problem is set up (semantic bonus beats a nearer cut)', () => {
  const s = scenes(54, (i) => (i === 13 ? { actPhase: 'Hook' } : {})); // scene 14 ends at 140s, 10s before the 150s target
  const { markers } = placeMidrolls(s, buildTimeline(s));
  assert.equal(markers[0].atSec, 140);
  assert.match(markers[0].reason, /the problem is set up just before this cut/);
});

test('mid-roll #2 prefers the boundary immediately BEFORE the fix is revealed', () => {
  const s = scenes(54, (i) => (i === 35 ? { actPhase: 'The Fix' } : {})); // scene 36 starts at 350s
  const { markers } = placeMidrolls(s, buildTimeline(s));
  assert.equal(markers[1].atSec, 350);
  assert.match(markers[1].reason, /delivers the fix\/conclusion/);
});

test('mid-roll: a video under the 8:00 eligibility floor gets NO markers and an explicit warning', () => {
  const s = scenes(42); // 420s
  const { markers, checks } = placeMidrolls(s, buildTimeline(s));
  assert.deepEqual(markers, []);
  assert.equal(find(checks, 'midroll-ineligible').severity, 'warn');
  assert.ok(420 < MIDROLL_MIN_VIDEO_SEC);
});

test('mid-roll: short-form (<3 min) is silent — no chapters advice, no mid-roll noise', () => {
  const s = scenes(6);
  assert.deepEqual(placeMidrolls(s, buildTimeline(s)), { markers: [], checks: [] });
});

test('mid-roll: with no boundary inside ±25s, the nearest allowed one is used and disclosed', () => {
  const s = scenes(5, () => ({ durationEst: 100 })); // boundaries at 100/200/300/400 only
  const { markers, checks } = placeMidrolls(s, buildTimeline(s));
  assert.equal(markers.length, 2);
  assert.ok(ids(checks).includes('midroll-1-off-target') && ids(checks).includes('midroll-2-off-target'));
  assert.ok(markers[1].atSec - markers[0].atSec >= 60);
});

// ------------------------------------------------------------------------------------------- audit

test('audit: an intro line ("Welcome back to…") is flagged against the no-intro rule', () => {
  const c = auditScript({ scenes: scenes(20), signatureIntro: 'Welcome back to The Orange Thread...' });
  assert.equal(find(c, 'intro-line-present').severity, 'warn');
  assert.equal(find(auditScript({ scenes: scenes(20), signatureIntro: '' }), 'intro-line-present'), undefined);
});

test('audit: duration shortfall is an error, overshoot a warning, within tolerance is silent', () => {
  const s = scenes(30); // 300s
  assert.equal(find(auditScript({ scenes: s }, { requestedDurationSec: 600 }), 'duration-shortfall').severity, 'error');
  assert.equal(find(auditScript({ scenes: s }, { requestedDurationSec: 220 }), 'duration-overshoot').severity, 'warn');
  assert.equal(find(auditScript({ scenes: s }, { requestedDurationSec: 320 }), 'duration-shortfall'), undefined);
});

test('audit: 30s+ of identical visuals with no infographic breaks the pattern-interrupt rule; alternating types do not', () => {
  const same = auditScript({ scenes: scenes(20) });
  assert.ok(find(same, 'no-pattern-interrupt'));
  const alt = auditScript({ scenes: scenes(20, (i) => ({ visualType: i % 2 ? 'diagram' : 'terminal' })) });
  assert.equal(find(alt, 'no-pattern-interrupt'), undefined);
  const withInfographics = auditScript({ scenes: scenes(20, (i) => (i % 2 ? { infographic: { type: 'architecture', title: 't' } } : {})) });
  assert.equal(find(withInfographics, 'no-pattern-interrupt'), undefined);
});

test('audit: all-AI-imagery long-form is an error; a thin evidence mix a warning; a healthy mix is silent', () => {
  const ai = auditScript({ scenes: scenes(20, () => ({ visualType: 'character' })) });
  assert.equal(find(ai, 'ai-slideshow-risk').severity, 'error');
  const thin = auditScript({ scenes: scenes(20, (i) => ({ visualType: i < 4 ? 'terminal' : i % 2 ? 'character' : 'cyberpunk' })) }); // 20%
  assert.equal(find(thin, 'thin-evidence-mix').severity, 'warn');
  const healthy = auditScript({ scenes: scenes(20, (i) => ({ visualType: i % 2 ? 'diagram' : 'character' })) });
  assert.equal(find(healthy, 'thin-evidence-mix'), undefined);
  assert.equal(find(healthy, 'ai-slideshow-risk'), undefined);
});

test('audit: narration that cannot fit its scene is flagged; under-filled scenes are informational', () => {
  const c = auditScript({ scenes: [scene(1, { narration: 'w '.repeat(60) }), scene(2, { narration: 'five words only here now' }), ...scenes(4).map((x, i) => ({ ...x, sceneNumber: 3 + i }))] });
  assert.deepEqual(find(c, 'narration-overruns-scene').sceneNumbers, [1]);
  assert.deepEqual(find(c, 'narration-underfills-scene').sceneNumbers, [2]);
  assert.equal(find(c, 'narration-underfills-scene').severity, 'info');
});

test('audit: specifics that are NOT in the dossier are flagged, ones that are supported are not', () => {
  const research = {
    topicTitle: 'xz backdoor', summary: 's', keyFacts: ['The flaw is tracked as CVE-2024-3094 and scored 10.0.', 'Affects 83% of sampled hosts.', 'Version 5.6.1 shipped it.'],
    timeline: [], retrievedSources: [{ id: 'S1', ok: true }],
  };
  const s = [scene(1, { narration: 'It is tracked as CVE-2024-3094 and hit 83% of hosts in v5.6.1.', citations: ['S1'] }),
             scene(2, { narration: 'The attacker earned $5 million and used CVE-2099-1234 too.' })];
  const c = auditScript({ scenes: s }, { research });
  const u = find(c, 'unsupported-specifics');
  assert.match(u.message, /CVE-2099-1234/);
  assert.match(u.message, /\$5 million/);
  assert.doesNotMatch(u.message, /CVE-2024-3094|83%|5\.6\.1/);
  assert.deepEqual(u.sceneNumbers, [2]);
  assert.deepEqual(find(c, 'uncited-specifics').sceneNumbers, [2]);
});

test('audit: no research supplied → no specifics/citation checks (nothing to compare against)', () => {
  const c = auditScript({ scenes: [scene(1, { narration: 'Costs $5 million, CVE-2099-1234.' })] });
  assert.equal(find(c, 'unsupported-specifics'), undefined);
});

test('audit: canned fallback and an incomplete generation are errors that carry the reason', () => {
  assert.equal(find(auditScript({ scenes: scenes(6), isQuotaFallback: true }), 'canned-content').severity, 'error');
  const c = auditScript({ scenes: scenes(6), generation: { complete: false, degraded: ['Narrative chunk 7/16 failed: script stops at 21/47 scenes.'] } });
  assert.match(find(c, 'generation-incomplete').message, /stops at 21\/47 scenes/);
});

test('extractSpecifics finds CVEs, percentages, money, comma-numbers, unit-numbers and versions', () => {
  const got = extractSpecifics('CVE-2024-3094 hit 83% of hosts, cost $1.5 billion, 1,200,000 users, 300 servers, in v5.6.1.');
  for (const want of ['CVE-2024-3094', '83%', '$1.5 billion', '1,200,000 users', '300 servers', 'v5.6.1']) assert.ok(got.includes(want), `${want} in ${JSON.stringify(got)}`);
  // Overlapping matches collapse to the longest form, and a number is never split at its own comma.
  assert.ok(!got.includes('1.5 billion'), '"$1.5 billion" must not also be reported as "1.5 billion"');
  assert.ok(!got.some((g) => g.startsWith('000')), `"1,200,000 users" must not yield a "000 users" fragment: ${JSON.stringify(got)}`);
});

// ---- the specifics matcher: exact tokens, not substrings -------------------------------------------------

const unsupportedIn = (research: any, ...sceneOverrides: any[]) => {
  const c = auditScript({ scenes: sceneOverrides.map((o, i) => scene(i + 1, o)) }, { research });
  return find(c, 'unsupported-specifics');
};
const dossier = (...keyFacts: string[]) => ({ topicTitle: 't', summary: 's', keyFacts, timeline: [] });

test('matcher: a figure is not "supported" because it is a substring of a different figure', () => {
  // These three each passed under the old substring match (2045, CVE-2024-30945, 5.6.10).
  const u = unsupportedIn(
    dossier('The campaign ran until 2045 by one estimate.', 'A different bug is CVE-2024-30945.', 'The fixed release is 5.6.10.'),
    { narration: 'It hit 45% of hosts, is tracked as CVE-2024-3094, and shipped in 5.6.1.' },
  );
  assert.ok(u, 'expected an unsupported-specifics check');
  for (const t of ['45%', 'CVE-2024-3094', '5.6.1']) assert.ok(u.message.includes(`"${t}"`), `${t} should be flagged: ${u.message}`);
});

test('matcher: 83% does not match 83.5%, and a unit is part of the claim (GB is not TB, % is not $)', () => {
  const u = unsupportedIn(dossier('It affected 83.5% of hosts.', 'The dump was 5 TB.', 'It cost $45.'), {
    narration: 'It hit 83% of hosts, the dump was 5 GB, and 45% of it was leaked.',
  });
  for (const t of ['83%', '5 GB', '45%']) assert.ok(u.message.includes(`"${t}"`), `${t} should be flagged: ${u.message}`);
});

test('matcher: the same figure written differently is still supported', () => {
  const u = unsupportedIn(
    dossier('It affected 83 percent of hosts, cost $1.5 billion, hit 1.2 million users, and shipped as version 5.6.1 (CVE-2024-3094).'),
    { narration: 'It hit 83% of hosts, cost $1.5B, hit 1,200,000 users, in v5.6.1 — cve-2024-3094.' },
  );
  assert.equal(u, undefined);
});

test('matcher: a figure the dossier states without a unit we know still supports the narration that adds one', () => {
  assert.equal(unsupportedIn(dossier('About 5 million were affected.'), { narration: 'It reached 5 million devices.' }), undefined);
  assert.equal(unsupportedIn(dossier('It reached 5 million devices.'), { narration: 'About 5 million were affected.' }), undefined);
  assert.ok(unsupportedIn(dossier('It reached 5 million devices.'), { narration: 'It reached 5 million servers.' }), 'a different named unit is a different claim');
});

test('matcher: a figure cannot be assembled across two dossier fields', () => {
  // The old blob joined every field with the spaces stripped, so "$5" and "million users" in two
  // unrelated facts read as "5million" and supported a "$5 million" claim.
  assert.ok(unsupportedIn(dossier('The fee was $5', 'million users were affected'), { narration: 'It cost $5 million.' }));
});

test('specificKey: spellings of one claim share a key; different claims never do', () => {
  const same = [
    ['v5.6.1', '5.6.1'], ['CVE-2024-3094', 'cve‑2024‑3094'], ['83%', '83 percent'], ['83%', '83.0%'],
    ['$1.5 billion', '$1.5B'], ['$1.5 billion', '1.5 billion dollars'], ['1,200,000', '1.2 million'], ['5 GB', '5gb'],
  ];
  for (const [a, b] of same) assert.equal(specificKey(a), specificKey(b), `${a} vs ${b}`);
  const different = [['45%', '$45'], ['5 GB', '5 TB'], ['5.6.1', '5.6.10'], ['CVE-2024-3094', 'CVE-2024-30945'], ['83%', '83.5%'], ['$5 million', '$5 thousand']];
  for (const [a, b] of different) assert.notEqual(specificKey(a), specificKey(b), `${a} vs ${b}`);
});

test('matcher: a sentence-final period is not part of the figure', () => {
  assert.equal(unsupportedIn(dossier('The fee was $5.'), { narration: 'It cost $5.' }), undefined);
  assert.deepEqual(extractSpecifics('It cost $5. Then 12%.'), ['$5', '12%']);
});

test('audit: on-screen text and infographic fields are held to the dossier too, and reported as on screen', () => {
  const research = dossier('Tracked as CVE-2024-3094.', 'Scored 10.0 by NVD.');
  const u = unsupportedIn(
    research,
    { narration: 'A calm sentence with no figures at all in it.', onScreenText: 'CVE-2099-0001' },
    {
      narration: 'Another calm sentence with no figures.',
      infographic: {
        type: 'threat_scorecard', title: 'Hit 61% of hosts', badge: 'CVE-2024-3094',
        steps: [{ label: 'Step', detail: 'affects 5.6.10', status: 'warning' }],
        metrics: [{ label: 'Hosts', value: '1,000,000', subtext: '$9 million loss' }],
      },
    },
  );
  assert.ok(u);
  for (const t of ['CVE-2099-0001', '61%', '5.6.10', '1,000,000', '$9 million']) assert.ok(u.message.includes(`"${t}"`), `${t} should be flagged: ${u.message}`);
  assert.doesNotMatch(u.message, /"CVE-2024-3094"/);
  assert.match(u.message, /"CVE-2099-0001" \(scene 1, on screen\)/);
  assert.deepEqual(u.sceneNumbers, [1, 2]);
});

test('audit: a supported figure on screen with no citation on the scene is reported as uncited', () => {
  const research = { ...dossier('Tracked as CVE-2024-3094.'), retrievedSources: [{ id: 'S1', ok: true }] };
  const c = auditScript({ scenes: [scene(1, { onScreenText: 'CVE-2024-3094' })] }, { research });
  assert.deepEqual(find(c, 'uncited-specifics').sceneNumbers, [1]);
});

test('analyzeScript: errors sort before warnings before info, and every part is present', () => {
  const s = scenes(54, () => ({ visualType: 'character' }));
  const a = analyzeScript({ scenes: s, signatureIntro: 'Welcome back', isQuotaFallback: true }, { requestedDurationSec: 540 });
  assert.equal(a.timeline.length, 54);
  assert.equal(a.midrollMarkers.length, 2);
  const order = a.qualityChecks.map((c) => c.severity);
  assert.deepEqual(order, [...order].sort((x, y) => ['error', 'warn', 'info'].indexOf(x) - ['error', 'warn', 'info'].indexOf(y)));
  assert.equal(order[0], 'error');
});

test('audit: one wrong figure repeated across many scenes is reported ONCE, with where it appears', () => {
  const research = { topicTitle: 't', summary: 's', keyFacts: ['Tracked as CVE-2024-3094.'], timeline: [] };
  const s = Array.from({ length: 30 }, (_, i) => scene(i + 1, { narration: 'The attacker earned CVE-2099-1234 trust over two long years of patient work today.' }));
  const u = find(auditScript({ scenes: s }, { research }), 'unsupported-specifics');
  assert.equal((u.message.match(/CVE-2099-1234/g) || []).length, 1);
  assert.match(u.message, /"CVE-2099-1234" \(scenes 1, 2, 3, \+27 more\)/);
  assert.equal(u.sceneNumbers.length, 30);
});
