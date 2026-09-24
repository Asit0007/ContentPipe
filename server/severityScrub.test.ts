import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scrubCveIds } from './severityScrub';

// The two leaks from the live run: an infographic badge and an infographic summary.
const scene = (over: any = {}) => ({ sceneNumber: 1, narration: 'Plain narration.', onScreenText: 'PLAIN TEXT', ...over });

test('a CVE id in an all-caps badge becomes THE FLAW, keeping the badge shouting', () => {
  const { scenes, changes } = scrubCveIds([scene({ infographic: { type: 'terminal_payload', title: 'SYSTEM PATCH VERIFICATION', badge: 'CVE-2014-0160 RESOLVED' } })]);
  assert.equal(scenes[0].infographic.badge, 'THE FLAW RESOLVED');
  assert.deepEqual(changes, [{ sceneNumber: 1, fields: ['infographic.badge'] }]);
});

test('a CVE id in a sentence becomes "the flaw", capitalised only at the start of a sentence', () => {
  const { scenes } = scrubCveIds([
    scene({ narration: 'The lifecycle of CVE-2014-0160 shows the gap. CVE-2014-0160 sat there for years.' }),
  ]);
  assert.equal(scenes[0].narration, 'The lifecycle of the flaw shows the gap. The flaw sat there for years.');
});

test('a bracketed id goes with its brackets, and a list of ids in brackets goes together', () => {
  const { scenes } = scrubCveIds([scene({ narration: 'Log4Shell (CVE-2021-44228, CVE-2021-45046) was everywhere.' })]);
  assert.equal(scenes[0].narration, 'Log4Shell was everywhere.');
});

test('every viewer-facing field is covered: on-screen text, infographic title/summary/steps/metrics', () => {
  const { scenes, changes } = scrubCveIds([
    scene({
      onScreenText: 'CVE-2024-3094',
      infographic: {
        title: 'TIMELINE OF CVE-2024-3094',
        summary: 'How CVE-2024-3094 was found.',
        steps: [{ label: 'Step', detail: 'Found as CVE-2024-3094' }],
        metrics: [{ label: 'Tracked as', value: 'CVE-2024-3094', subtext: 'later CVE-2024-3094 notes' }],
      },
    }),
  ]);
  const g = scenes[0].infographic;
  assert.equal(scenes[0].onScreenText, 'THE FLAW');
  assert.equal(g.title, 'TIMELINE OF THE FLAW');
  assert.equal(g.summary, 'How the flaw was found.');
  assert.equal(g.steps[0].detail, 'Found as the flaw');
  assert.equal(g.metrics[0].value, 'THE FLAW');
  assert.equal(g.metrics[0].subtext, 'later the flaw notes');
  assert.deepEqual(changes[0].fields.sort(), ['infographic.metrics', 'infographic.steps', 'infographic.summary', 'infographic.title', 'onScreenText']);
  assert.ok(!JSON.stringify(scenes).match(/CVE-\d{4}-\d+/));
});

test('non-breaking hyphens in an id are still caught', () => {
  const { scenes } = scrubCveIds([scene({ narration: 'Tracked as CVE‑2024‑3094 for a while.' })]);
  assert.equal(scenes[0].narration, 'Tracked as the flaw for a while.');
});

test('scenes without an id keep their identity, are not reworded, and the input is not mutated', () => {
  const clean = scene({ narration: 'A  sentence with  odd spacing and no id.' });
  const dirty = scene({ sceneNumber: 2, narration: 'See CVE-2024-3094.' });
  const before = JSON.stringify([clean, dirty]);
  const { scenes, changes } = scrubCveIds([clean, dirty]);
  assert.equal(scenes[0], clean);
  assert.equal(scenes[0].narration, 'A  sentence with  odd spacing and no id.');
  assert.deepEqual(changes, [{ sceneNumber: 2, fields: ['narration'] }]);
  assert.equal(JSON.stringify([clean, dirty]), before);
});

test('only ids are replaced: the bare word CVE, CVSS scores and code snippets are left for the audit', () => {
  const { scenes, changes } = scrubCveIds([
    scene({
      narration: 'Known CVEs and a CVSS score.',
      infographic: { codeSnippet: { lines: [{ text: 'grep CVE-2014-0160 advisory.txt', type: 'cmd' }] } },
    }),
  ]);
  assert.equal(scenes[0].narration, 'Known CVEs and a CVSS score.');
  assert.equal(scenes[0].infographic.codeSnippet.lines[0].text, 'grep CVE-2014-0160 advisory.txt');
  assert.deepEqual(changes, []);
});

// The prefix slice per match once made this quadratic: 200 KB took 88 ms, 400 KB 367 ms, 800 KB 1.7 s. Linear is ~50 ms.
test('a large field full of ids and unclosed brackets is scrubbed in linear time', () => {
  const text = '( CVE-2014-0160 '.repeat(50_000); // 800 KB
  const started = Date.now();
  const { scenes } = scrubCveIds([{ sceneNumber: 1, narration: text }]);
  const ms = Date.now() - started;
  assert.ok(ms < 800, `took ${ms} ms; the quadratic version needed about 1700`);
  assert.ok(!/CVE-\d{4}-\d+/.test(scenes[0].narration));
});

test('a sentence start is still recognised through the short window, including after closing quotes and brackets', () => {
  const { scenes } = scrubCveIds([scene({ narration: 'He said "it was bad." CVE-2024-3094 was the cause. (CVE-2024-3094 again.)' })]);
  // After a closing quote the next sentence gets its capital; one that opens inside a parenthesis does not (harmless).
  assert.equal(scenes[0].narration, 'He said "it was bad." The flaw was the cause. (the flaw again.)');
});

test('a non-array input is returned as it came', () => {
  assert.deepEqual(scrubCveIds(undefined as any), { scenes: undefined, changes: [] });
});
