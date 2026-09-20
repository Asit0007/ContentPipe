import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHnItemId, hnHtmlToText, renderHnThread, algoliaItemUrl, type HnItem } from './hnThread';

// Shaped like the real Algolia response (verified live against item 8863): comments have points: null.
const story = (children: HnItem[]): HnItem => ({
  id: 1,
  type: 'story',
  title: 'Backdoor in xz',
  url: 'https://example.com/post',
  author: 'op',
  points: 812,
  children,
});
const comment = (author: string | null, text: string | null, children: HnItem[] = []): HnItem => ({ type: 'comment', author, text, points: null, children });

test('parseHnItemId accepts real HN item URLs and rejects everything else', () => {
  assert.equal(parseHnItemId('https://news.ycombinator.com/item?id=8863'), 8863);
  assert.equal(parseHnItemId('https://news.ycombinator.com/item?id=8863&p=2'), 8863);
  assert.equal(parseHnItemId('https://news.ycombinator.com/item?id=abc'), null);
  assert.equal(parseHnItemId('https://news.ycombinator.com/news'), null);
  assert.equal(parseHnItemId('https://evil.example/item?id=8863'), null);
  assert.equal(parseHnItemId('not a url'), null);
  assert.equal(algoliaItemUrl(8863), 'https://hn.algolia.com/api/v1/items/8863');
});

test('hnHtmlToText: paragraphs, entities, links and code survive as readable text', () => {
  const html = 'first &amp; foremost<p>it&#x27;s &quot;fine&quot;<p><a href="https:&#x2F;&#x2F;example.com&#x2F;x" rel="nofollow">https:&#x2F;&#x2F;example.co...</a><p><pre><code>sudo rm -rf</code></pre>';
  assert.equal(hnHtmlToText(html), `first & foremost\n\nit's "fine"\n\nhttps://example.com/x\n\nsudo rm -rf`);
});

test('renderHnThread: real authors + verbatim text, honest header, no invented karma, chronological order kept', () => {
  const r = renderHnThread(
    story([comment('alice', 'First!<p>second para'), comment('bob', 'A reply', [comment('carol', 'nested')])])
  );
  assert.equal(r.commentCount, 3);
  assert.equal(r.included, 2);
  assert.match(r.text, /Hacker News discussion: "Backdoor in xz" \(812 points\)/);
  assert.match(r.text, /NOT ranked by votes/);
  assert.match(r.text, /\[c1\] alice: First!\n\nsecond para/);
  assert.match(r.text, /\[c2\] bob: A reply/);
  assert.ok(r.text.indexOf('alice') < r.text.indexOf('bob'));
  assert.doesNotMatch(r.text, /karma/i);
  assert.doesNotMatch(r.text, /carol/, 'only top-level comments are presented');
});

test('renderHnThread: deleted/dead comments (null author or text) are skipped, not rendered as blanks', () => {
  const r = renderHnThread(story([comment(null, 'ghost'), comment('dave', null), comment('erin', 'real')]));
  assert.equal(r.included, 1);
  assert.match(r.text, /\[c1\] erin: real/);
  assert.doesNotMatch(r.text, /ghost/);
});

test('renderHnThread: bounded — at most 25 comments, each truncated, total capped', () => {
  const many = Array.from({ length: 60 }, (_, i) => comment(`u${i}`, 'x'.repeat(2000)));
  const r = renderHnThread(story(many));
  assert.ok(r.included <= 25);
  assert.ok(r.text.length <= 12000);
  assert.match(r.text, /x{100}…/);
});

test('renderHnThread: an empty thread still yields an honest document', () => {
  const r = renderHnThread(story([]));
  assert.equal(r.included, 0);
  assert.match(r.text, /0 comment\(s\) in total/);
});
