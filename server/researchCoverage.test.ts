import { test } from 'node:test';
import assert from 'node:assert/strict';
import { measureCoverage } from './researchCoverage';
import type { FetchedSource } from './sourceFetcher';

const src = (over: Partial<FetchedSource> = {}): FetchedSource => ({
  url: 'https://a.example/x', title: 'A', text: 'body', wordCount: 1,
  fetchedAt: '2026-09-19T00:00:00Z', ok: true, via: 'direct', ...over,
});

test('cited and uncited key facts are counted separately', () => {
  const c = measureCoverage(
    {
      keyFacts: ['CVSS 9.8', 'affects 1.2.0 to 1.4.3', 'nobody knows who found it'],
      factCitations: [
        { fact: 'CVSS 9.8', sourceIds: ['S1'] },
        { fact: 'affects 1.2.0 to 1.4.3', sourceIds: ['S1', 'S2'] },
      ],
    },
    [src(), src()]
  );
  assert.equal(c.keyFacts, 3);
  assert.equal(c.citedFacts, 2);
  assert.equal(c.uncitedFacts, 1);
});

test('a citation with no source ids is not a citation', () => {
  const c = measureCoverage({ keyFacts: ['a', 'b'], factCitations: [{ fact: 'a', sourceIds: [] }, { fact: 'b' }] }, [src()]);
  assert.equal(c.citedFacts, 0);
  assert.equal(c.uncitedFacts, 2);
});

test('a citation for a fact that is not in keyFacts does not credit anything', () => {
  const c = measureCoverage({ keyFacts: ['a'], factCitations: [{ fact: 'something else entirely', sourceIds: ['S1'] }] }, [src()]);
  assert.equal(c.citedFacts, 0);
});

test('surrounding whitespace does not break the match between a fact and its citation', () => {
  const c = measureCoverage({ keyFacts: ['  CVSS 9.8 '], factCitations: [{ fact: 'CVSS 9.8', sourceIds: ['S1'] }] }, [src()]);
  assert.equal(c.citedFacts, 1);
});

test('truncated and undated sources are counted, and only among the usable ones', () => {
  const c = measureCoverage({ keyFacts: [] }, [
    src({ publishedAt: '2026-03-29T00:00:00.000Z' }),
    src({ truncated: true, retrievedChars: 90000 }),
    src({ ok: false, text: '', error: 'HTTP 404' }),
  ]);
  assert.equal(c.sourcesUsable, 2);
  assert.equal(c.sourcesTruncated, 1);
  assert.equal(c.sourcesUndated, 1, 'the failed source is not counted as an undated one');
});

test('a dossier with no facts and no sources reports zeroes rather than throwing', () => {
  const c = measureCoverage({}, []);
  assert.deepEqual(c, { sourcesUsable: 0, sourcesTruncated: 0, sourcesUndated: 0, keyFacts: 0, citedFacts: 0, uncitedFacts: 0 });
  assert.equal(measureCoverage(null, []).keyFacts, 0);
  assert.equal(measureCoverage({ keyFacts: 'not an array', factCitations: 7 }, []).keyFacts, 0);
});

test('the archive id rides along only when one was written', () => {
  assert.equal(measureCoverage({}, [], 'abc123').sourceArchiveId, 'abc123');
  assert.equal('sourceArchiveId' in measureCoverage({}, []), false);
});
