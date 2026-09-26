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
  retimeFromAudio,
  RetimeError,
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
  const c = auditScript({ scenes: scenes(20), signatureIntro: 'Welcome back to Blast Radius...' });
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

// ------------------------------------------------------------------------------------ shortfall tolerance

test('audit: a 500 s script against the 585 s default target is now an error (the old 0.85 tolerance let it through)', () => {
  const s = scenes(50); // 500 s = 85.5% of 585: silent at 0.85, an error at 0.92
  assert.equal(find(auditScript({ scenes: s }, { requestedDurationSec: 585 }), 'duration-shortfall').severity, 'error');
  // The floor is 0.92 x 585 = 538.2 s, which clears the 480 s mid-roll minimum; the old floor (459 s) did not.
  const atFloor = scenes(54, (i) => (i === 0 ? { durationEst: 9 } : {})); // 539 s
  assert.equal(find(auditScript({ scenes: atFloor }, { requestedDurationSec: 585 }), 'duration-shortfall'), undefined);
  assert.ok(0.92 * 585 > MIDROLL_MIN_VIDEO_SEC);
});

// ------------------------------------------------------------------------------------------- re-timing

const withIds = (count: number, fn: (i: number) => any = () => ({})) => scenes(count, (i) => ({ id: `s${i + 1}`, ...fn(i) }));
const timingsOf = (list: any[], sec: (i: number) => number) => list.map((sc, i) => ({ id: sc.id, durationSec: sec(i) }));

test('retime: real audio shorter than the estimates flips a script from mid-roll eligible to ineligible', () => {
  const s: any = { scenes: withIds(50, () => ({ motion: { durationSec: 10 } })), publish: { titles: ['stale'] } };
  Object.assign(s, analyzeScript(s, { requestedDurationSec: 585 })); // 500 s on the model's numbers
  assert.equal(s.midrollMarkers.length, 2);
  assert.equal(find(s.qualityChecks, 'midroll-ineligible'), undefined);

  const r = retimeFromAudio(s, timingsOf(s.scenes, () => 8.6), { requestedDurationSec: 585 }); // 430 s of real audio
  assert.equal(r.timingSource, 'audio');
  assert.equal(r.estimatedTotalDuration, 430);
  assert.equal(r.timeline[r.timeline.length - 1].endSec, 430);
  assert.deepEqual(r.midrollMarkers, []);
  assert.equal(find(r.qualityChecks, 'midroll-ineligible').severity, 'warn');
  assert.equal(find(r.qualityChecks, 'duration-shortfall').severity, 'error');
  assert.ok(r.scenes.every((sc: any) => sc.durationEst === 8.6 && sc.motion.durationSec === 8.6));
});

test('retime: never mutates its input, and drops the publish package whose description embeds old chapter times', () => {
  const s: any = { scenes: withIds(50), publish: { description: 'Chapters: 0:00 ...' }, viralityScore: 3 };
  const before = JSON.stringify(s);
  const r = retimeFromAudio(s, timingsOf(s.scenes, () => 12));
  assert.equal(JSON.stringify(s), before);
  assert.equal(r.publish, undefined);
  assert.equal(r.viralityScore, 3); // unrelated fields survive
});

test('retime: mid-roll and chapter times land on the real scene boundaries, not the estimated ones', () => {
  // The first ten scenes really run 20 s instead of the estimated 10 s; the rest are as estimated.
  const s: any = { scenes: withIds(60) }; // 600 s estimated
  Object.assign(s, analyzeScript(s));
  const r = retimeFromAudio(s, timingsOf(s.scenes, (i) => (i < 10 ? 20 : 10)));
  assert.equal(r.estimatedTotalDuration, 700);
  for (const m of r.midrollMarkers) {
    const entry = r.timeline.find((e: any) => e.sceneNumber === m.afterSceneNumber);
    assert.equal(m.atSec, entry.endSec, 'a mid-roll sits exactly at the end of a scene in the REAL timeline');
  }
  assert.notDeepEqual(r.midrollMarkers.map((m: any) => m.atSec), s.midrollMarkers.map((m: any) => m.atSec));
  assert.ok(r.chapters.every((c: any) => r.timeline.some((e: any) => e.startSec === c.startSec)));
});

test('retime: refuses timings that do not match the scenes one-to-one, listing every problem', () => {
  const s: any = { scenes: withIds(3) };
  const bad = (timings: any[], pattern: RegExp) =>
    assert.throws(() => retimeFromAudio(s, timings), (e: any) => e instanceof RetimeError && e.problems.some((p: string) => pattern.test(p)));
  bad([{ id: 's1', durationSec: 5 }, { id: 's2', durationSec: 5 }], /no timing for scene s3/);
  bad([...timingsOf(s.scenes, () => 5), { id: 'zz', durationSec: 5 }], /unknown scene zz/);
  bad([...timingsOf(s.scenes, () => 5), { id: 's1', durationSec: 5 }], /duplicate timing for scene s1/);
  bad(timingsOf(s.scenes, (i) => (i === 1 ? 0 : 5)), /invalid duration/);
  bad(timingsOf(s.scenes, (i) => (i === 1 ? NaN : 5)), /invalid duration/);
  assert.throws(() => retimeFromAudio({ scenes: [{ sceneNumber: 1, narration: 'x' }] }, []), (e: any) => e.problems.some((p: string) => /has no id/.test(p)));
  assert.throws(() => retimeFromAudio({ scenes: [] }, []), RetimeError);
});

test('buildTimeline: fractional durations do not accumulate float noise into the reported times', () => {
  const t = buildTimeline(Array.from({ length: 50 }, (_, i) => scene(i + 1, { durationEst: 8.6 })));
  assert.equal(t[49].endSec, 430);
  assert.equal(t[3].startSec, 25.8);
});

test('audit: an analyst scene that reads like narration is flagged; short reactions and narrator scenes of any length are not', () => {
  const c = auditScript({
    scenes: [
      scene(1, { narration: 'w '.repeat(28).trim() }),
      scene(2, { speaker: 'analyst', narration: 'w '.repeat(45).trim(), durationEst: 15 }),
      scene(3, { speaker: 'analyst', narration: 'w '.repeat(20).trim(), durationEst: 7 }),
      scene(4, { speaker: 'narrator', narration: 'w '.repeat(28).trim() }),
    ],
  });
  assert.deepEqual(find(c, 'analyst-scene-too-long').sceneNumbers, [2]);
  assert.equal(find(c, 'analyst-scene-too-long').severity, 'warn');
  assert.equal(find(auditScript({ scenes: scenes(4) }), 'analyst-scene-too-long'), undefined, 'a script with no speakers (older scripts) is unaffected');
});

test('audit: a CVE id or CVSS score spoken or shown is flagged — the audience is not technical; plain narration is not', () => {
  const c = auditScript({
    scenes: [
      scene(1, { narration: 'It was tracked as CVE-2024-3094 and nobody outside the project noticed.' }),
      scene(2, { narration: 'Anyone on the internet could log in as the administrator, no password needed.' }),
      scene(3, { onScreenText: 'CVSS 10.0' }),
      scene(4, { infographic: { type: 'threat_scorecard', title: 'WHO WAS EXPOSED', badge: 'NO LOGIN NEEDED', metrics: [{ label: 'Known CVEs', value: '2' }] } }),
      scene(5, { narration: 'The advisory went out on a Friday — the cvent of the season, some joked.' }),
    ],
  });
  const flagged = find(c, 'severity-rating-shown');
  assert.deepEqual(flagged.sceneNumbers, [1, 3]);
  assert.equal(flagged.severity, 'warn');
  // "Known CVEs" is the word, not a rating: jargon, reported on its own with different advice.
  assert.deepEqual(find(c, 'cve-jargon').sceneNumbers, [4]);
  assert.equal(find(auditScript({ scenes: scenes(4) }), 'severity-rating-shown'), undefined);
});

// Live run 2026-09-25: "No patch. No CVE." in 14 scenes, reported as "a CVE id or CVSS score" — wrong, and wrong advice.
test('audit: the bare word CVE is jargon (cve-jargon), not a rating; a scene with an id is reported only as a rating', () => {
  const c = auditScript({
    scenes: [
      scene(1, { narration: 'September 17th came and went. No patch. No CVE. No reply.' }),
      scene(2, { infographic: { type: 'threat_scorecard', title: 'STATUS', metrics: [{ label: 'CVE Registered', value: 'No' }] } }),
      scene(3, { narration: 'It became CVE-2024-3094, the CVE everyone remembers.' }),
      scene(4, { narration: 'A plain scene about the fix.' }),
    ],
  });
  assert.deepEqual(find(c, 'cve-jargon').sceneNumbers, [1, 2]);
  assert.deepEqual(find(c, 'severity-rating-shown').sceneNumbers, [3]);
  assert.match(find(c, 'cve-jargon').message, /no official public warning/);
});

// Live run: one "split-screen terminal | void" background behind 7 of 10 scenes, and the audit had nothing to say.
test('audit: one environment behind more than 40% of the scenes is flagged with the scenes it fills; a spread of places is not', () => {
  const crowded = auditScript({ scenes: scenes(10, (i) => ({ locationId: i < 7 ? 'digital-void' : `place-${i}` })) });
  const flagged = find(crowded, 'background-monotony');
  assert.deepEqual(flagged.sceneNumbers, [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(flagged.severity, 'warn');
  assert.match(flagged.message, /\("digital-void"\) fills 7 of 10 scenes/);
  // Exactly 40% (4 of 10) is allowed: a story can go back to a place.
  assert.equal(find(auditScript({ scenes: scenes(10, (i) => ({ locationId: i < 4 ? 'server-room' : `place-${i}` })) }), 'background-monotony'), undefined);
  assert.equal(find(auditScript({ scenes: scenes(10, (i) => ({ locationId: `place-${i}` })) }), 'background-monotony'), undefined);
});

test('audit: the place check falls back to the background text, needs at least 4 scenes, and ignores scripts with no visuals', () => {
  const same = { visual: { background: 'A dim data center.' } };
  assert.deepEqual(find(auditScript({ scenes: scenes(6, () => same) }), 'background-monotony').sceneNumbers, [1, 2, 3, 4, 5, 6]);
  assert.equal(find(auditScript({ scenes: scenes(3, () => same) }), 'background-monotony'), undefined, '3 of 3 is too short a video to call a slideshow');
  assert.equal(find(auditScript({ scenes: scenes(10) }), 'background-monotony'), undefined, 'older scripts carry no place at all');
});

// The live run that put "CRITICAL RISK" on screen: SEVERITY_RATING_RE only knew ids and CVSS, so nothing was flagged.
test('audit: a severity label — a "CRITICAL RISK" badge, "high severity", a score out of 10 — is flagged; ordinary prose is not', () => {
  const c = auditScript({
    scenes: [
      scene(1, { infographic: { type: 'threat_scorecard', title: 'THREAT VECTOR: PRIVATE KEYS', badge: 'CRITICAL RISK' } }),
      scene(2, { narration: 'Vendors rated it high severity within hours.' }),
      scene(3, { onScreenText: 'CRITICAL' }),
      scene(4, { infographic: { type: 'benchmark_chart', title: 'SCORE', metrics: [{ label: 'Rating', value: '9.8/10' }] } }),
      scene(5, { narration: 'It sat inside critical infrastructure. The primary risk was silence, and 8 out of 10 servers ran it.' }),
      scene(6, { onScreenText: 'NO LOGIN NEEDED', infographic: { type: 'architecture', title: 'WHO WAS EXPOSED', badge: 'ZERO LOGS RECORDED' } }),
    ],
  });
  const flagged = find(c, 'severity-label-shown');
  assert.deepEqual(flagged.sceneNumbers, [1, 2, 3, 4]);
  assert.equal(flagged.severity, 'warn');
  assert.equal(find(c, 'severity-rating-shown'), undefined, 'no CVE id or CVSS score here, so the id check stays quiet');
  assert.equal(find(auditScript({ scenes: scenes(4) }), 'severity-label-shown'), undefined);
});
