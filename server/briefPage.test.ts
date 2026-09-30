import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { inlineMd, mdToHtml, parseFrontMatter, renderBriefIndex, renderBriefPage, summarizeBrief } from './briefPage';
import { writeBriefIndex, writeBriefPage } from './briefPageFiles';
import { renderScriptMarkdown } from './markdownExporter';

const BRIEF = `---
title: "A \\"quoted\\" title"
duration_sec: 609.5
scene_count: 2
channel: "Blast Radius"
generation_complete: true
midroll_1: "2:26"
midroll_2: "6:03"
---

# A "quoted" title

> The hook line.

## Quality checks

| Severity | Check | Detail | Scenes |
| --- | --- | --- | --- |
| WARN | narration-overruns-scene | Too fast. | 6, 36 |
| ERROR | duration-shortfall | Short. | — |
| INFO | narration-underfills-scene | Slow. | 51 |

## Pre-publish checklist (manual)

- [ ] Narration rewritten by a human
- [x] Disclosure set

## Scenes

### Scene 1 — The Impossible Access

| Field | Value |
| --- | --- |
| Act phase | Hook |
| Duration | 12s |
| Voice | Narrator |

**Narration**

> Apps live in locked rooms.

#### Image prompts

**FLUX prompt**
\`\`\`text
A dim loft. ## not a heading
### Scene 99 — not a scene
\`\`\`

---

### Scene 2 — The Analyst's View

| Field | Value |
| --- | --- |
| Act phase | Hook |
| Duration | 7s |
| Voice | Analyst |

**Narration**

> That is the part that worries me.
`;

test('front matter is read, with quoted values unescaped', () => {
  const { meta, body } = parseFrontMatter(BRIEF);
  assert.equal(meta.title, 'A "quoted" title');
  assert.equal(meta.duration_sec, '609.5');
  assert.ok(body.startsWith('\n# A'));
});

test('the summary counts scenes and checks by severity', () => {
  const s = summarizeBrief(BRIEF);
  assert.equal(s.title, 'A "quoted" title');
  assert.equal(s.hook, 'The hook line.');
  assert.equal(s.sceneCount, 2);
  assert.deepEqual(s.checks, { error: 1, warn: 1, info: 1 });
});

test('headings inside a code fence never split a section or a scene', () => {
  const html = renderBriefPage(BRIEF, 'x.md');
  assert.equal((html.match(/<details class="scene"/g) || []).length, 2);
  assert.ok(html.includes('A dim loft. ## not a heading\n### Scene 99 — not a scene'));
});

test('a scene row carries its number, title, narration and voice', () => {
  const html = renderBriefPage(BRIEF, 'x.md');
  assert.match(html, /id="scene-1" data-voice="narrator"/);
  assert.match(html, /id="scene-2" data-voice="analyst"/);
  assert.ok(html.includes('<span class="line">Apps live in locked rooms.</span>'));
  assert.ok(html.includes('<summary>Image prompts</summary>'));
});

test('every code block gets a copy button and task items become checkboxes', () => {
  const html = renderBriefPage(BRIEF, 'x.md');
  assert.equal((html.match(/class="copy"/g) || []).length, 1);
  assert.equal((html.match(/type="checkbox"/g) || []).length, 2);
  assert.equal((html.match(/type="checkbox" checked/g) || []).length, 1);
});

test('text from a brief can never become markup', () => {
  const hostile = [
    '## Sources',
    '',
    '| ID | Title | URL |',
    '| --- | --- | --- |',
    '| S1 | <script>alert(1)</script> \\| <img src=x onerror=alert(2)> | javascript:alert(3) |',
    '',
    '[click](javascript:alert(4)) and [ok](https://example.com/a?b="><script>x</script>)',
    '',
    '<details><summary><b onclick="x">sum</b></summary>',
    '',
    '```text',
    '</pre></div><script>alert(5)</script>',
    '```',
    '',
    '</details>',
  ].join('\n');
  const html = renderBriefPage(`# T "><script>alert(0)</script>\n\n${hostile}`, 'x"><script>.md');
  // The only <script> is the page's own, static one.
  assert.equal((html.match(/<script/g) || []).length, 1);
  // No injected tag, no event-handler attribute inside any real tag, no script: link.
  assert.ok(!/<img|<b[ >]|<[^>]*\son\w+=|href="javascript:/i.test(html));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt; | &lt;img'));
});

test('inline: identifiers keep their underscores, bare URLs link, escaped pipes are restored', () => {
  assert.equal(inlineMd('the untrusted_app domain and oplus_log_core'), 'the untrusted_app domain and oplus_log_core');
  assert.equal(inlineMd('_Computed from the script._'), '<em>Computed from the script.</em>');
  assert.match(inlineMd('see https://blog.nns.ee/2026/09/24/oneplus-root/.'), /href="https:\/\/blog\.nns\.ee\/2026\/09\/24\/oneplus-root\/"[^>]*>[^<]+<\/a>\.$/);
  assert.equal(inlineMd('a \\| b `x < y`'), 'a | b <code>x &lt; y</code>');
});

test('a table with an escaped pipe in a cell keeps its columns', () => {
  const html = mdToHtml(['| A | B |', '| --- | --- |', '| one \\| two | three |']);
  assert.equal((html.match(/<td>/g) || []).length, 2);
  assert.ok(html.includes('<td>one | two</td>'));
});

test('the page allows no network access and the index links each brief', () => {
  const html = renderBriefPage(BRIEF, 'x.md');
  assert.ok(html.includes(`default-src 'none'`));
  assert.ok(!/(src|href)="https?:\/\/(?!blog)/.test(html.replace(/<a [^>]+>/g, '')));
  const index = renderBriefIndex([{ href: 'x.html', fileName: 'x.md', modified: '2026-09-30T00:00:00Z', bytes: 2048, summary: summarizeBrief(BRIEF) }]);
  assert.ok(index.includes('href="x.html"') && index.includes('10:10') && index.includes('1 errors'));
});

test('a brief written by the real exporter renders every scene', () => {
  const scene = (n: number, speaker?: string) => ({
    id: `s${n}`, sceneNumber: n, title: `Scene title ${n}`, narration: `Narration ${n}.`, durationEst: 10, actPhase: 'Hook',
    visualPrompt: 'flat prompt', onScreenText: 'TEXT', speaker,
  });
  const md = renderScriptMarkdown({ script: { title: 'Real exporter', scenes: [scene(1), scene(2, 'analyst'), scene(3)] } });
  const html = renderBriefPage(md, 'real.md');
  assert.equal((html.match(/<details class="scene"/g) || []).length, 3);
  assert.equal(summarizeBrief(md).sceneCount, 3);
  assert.ok(html.includes('Narration 2.'));
});

test('writeBriefIndex writes a page per brief and an index, into the folder it is given', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'brief-page-'));
  try {
    await fs.writeFile(path.join(dir, '2026-09-30-a.md'), BRIEF);
    await fs.writeFile(path.join(dir, 'notes.txt'), 'ignored');
    const { indexPath, pages } = await writeBriefIndex({ dir });
    assert.equal(pages, 1);
    assert.ok((await fs.readFile(path.join(dir, '2026-09-30-a.html'), 'utf8')).includes('The Impossible Access'));
    assert.ok((await fs.readFile(indexPath, 'utf8')).includes('href="2026-09-30-a.html"'));
    assert.equal(await writeBriefPage(path.join(dir, '2026-09-30-a.md')), path.join(dir, '2026-09-30-a.html'));
    assert.deepEqual((await fs.readdir(dir)).filter((n) => n.endsWith('.tmp')), []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
