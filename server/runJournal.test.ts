import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RunJournal, isValidRunId, hashRunInput, acquireRun, releaseRun, pruneOldRuns } from './runJournal';

let dir: string;
before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cp-journal-'));
});
after(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const open = (key: string, hash: string, fresh = false) => RunJournal.open(key, hash, { dir, fresh });

test('a new journal is in_progress and not "resumed"', async () => {
  const j = await open('r-new', 'h1');
  assert.equal(j.resumed, false);
  assert.equal(j.status, 'in_progress');
});

test('finished chunks survive a "crash" (reopen) and are reported as resumed', async () => {
  const a = await open('r-resume', 'h1');
  await a.setBible({ characterBible: [{ id: 'x' }], styleGuide: { artDirection: 'noir' } });
  await a.setNarrativeChunk(0, [{ sceneNumber: 1 }, { sceneNumber: 2 }, { sceneNumber: 3 }]);
  await a.setNarrativeChunk(1, [{ sceneNumber: 4 }]);

  const b = await open('r-resume', 'h1'); // new process, same inputs
  assert.equal(b.resumed, true);
  assert.deepEqual(b.getBible()?.styleGuide, { artDirection: 'noir' });
  assert.equal(b.getNarrativeChunk(0)?.length, 3);
  assert.equal(b.getNarrativeChunk(2), undefined);
  assert.deepEqual(b.progress(), { hasProductionBible: true, narrativeChunksDone: 2, artChunksDone: 0, scenesSoFar: 4 });
});

test('a DELIVERED run never resumes: "regenerate" starts fresh and the old payload is gone', async () => {
  const a = await open('r-delivered', 'h1');
  await a.setNarrativeChunk(0, [{ sceneNumber: 1 }]);
  await a.markComplete({ title: 'script' });
  await a.markDelivered();

  const b = await open('r-delivered', 'h1');
  assert.equal(b.resumed, false);
  assert.equal(b.getNarrativeChunk(0), undefined);
  assert.equal(b.getFinalScript(), undefined);
});

test('a completed-but-undelivered run (client timed out) serves the stored script without regenerating', async () => {
  const a = await open('r-undelivered', 'h1');
  await a.markComplete({ title: 'finished while client was gone' });
  const b = await open('r-undelivered', 'h1');
  assert.equal(b.resumed, true);
  assert.equal(b.status, 'complete');
  assert.deepEqual(b.getFinalScript(), { title: 'finished while client was gone' });
});

test('different inputs never reuse another input\'s chunks (same explicit run id)', async () => {
  const a = await open('r-hash', 'inputA');
  await a.setNarrativeChunk(0, [{ sceneNumber: 1 }]);
  const b = await open('r-hash', 'inputB');
  assert.equal(b.resumed, false);
  assert.equal(b.getNarrativeChunk(0), undefined);
});

test('fresh:true discards an in-progress journal', async () => {
  const a = await open('r-fresh', 'h1');
  await a.setNarrativeChunk(0, [{ sceneNumber: 1 }]);
  const b = await open('r-fresh', 'h1', true);
  assert.equal(b.resumed, false);
  assert.equal(b.getNarrativeChunk(0), undefined);
});

test('art chunks are only reused when their first scene number still matches', async () => {
  const a = await open('r-art', 'h1');
  await a.setArtChunk(2, 13, [{ sceneNumber: 13 }]);
  const b = await open('r-art', 'h1');
  assert.equal(b.getArtChunk(2, 13)?.length, 1);
  assert.equal(b.getArtChunk(2, 7), undefined);
});

test('a corrupt journal file starts clean instead of failing the request', async () => {
  await fs.writeFile(path.join(dir, 'r-corrupt.json'), '{"version":1,"runId":', 'utf8');
  const j = await open('r-corrupt', 'h1');
  assert.equal(j.resumed, false);
});

test('writes are atomic: no temp files are left behind', async () => {
  const j = await open('r-atomic', 'h1');
  for (let i = 0; i < 5; i++) await j.setNarrativeChunk(i, [{ sceneNumber: i }]);
  const leftovers = (await fs.readdir(dir)).filter((n) => n.includes('.tmp-'));
  assert.deepEqual(leftovers, []);
});

test('run ids become filenames, so path traversal is rejected', async () => {
  for (const bad of ['', '../x', 'a/b', 'a.b', 'x'.repeat(65), 42, null]) assert.equal(isValidRunId(bad), false, String(bad));
  assert.equal(isValidRunId('abc-123_DEF'), true);
  await assert.rejects(RunJournal.open('../escape', 'h', { dir }), /Invalid run id/);
});

test('hashRunInput is stable for equal inputs and differs when any input differs', () => {
  assert.equal(hashRunInput({ a: 1 }), hashRunInput({ a: 1 }));
  assert.notEqual(hashRunInput({ a: 1 }), hashRunInput({ a: 2 }));
});

test('acquireRun is mutually exclusive per key until released', () => {
  assert.equal(acquireRun('k1'), true);
  assert.equal(acquireRun('k1'), false);
  assert.equal(acquireRun('k2'), true);
  releaseRun('k1');
  assert.equal(acquireRun('k1'), true);
  releaseRun('k1');
  releaseRun('k2');
});

test('pruneOldRuns removes only journals older than the cutoff', async () => {
  const pruneDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cp-prune-'));
  await fs.writeFile(path.join(pruneDir, 'old.json'), '{}');
  await fs.writeFile(path.join(pruneDir, 'new.json'), '{}');
  const eightDaysAgo = new Date(Date.now() - 8 * 24 * 3600 * 1000);
  await fs.utimes(path.join(pruneDir, 'old.json'), eightDaysAgo, eightDaysAgo);
  assert.equal(await pruneOldRuns(pruneDir), 1);
  assert.deepEqual(await fs.readdir(pruneDir), ['new.json']);
  await fs.rm(pruneDir, { recursive: true, force: true });
});

test('discardIfEmpty removes a journal that stored nothing, but never one with progress', async () => {
  const empty = await open('r-empty', 'h1');
  assert.equal(await empty.discardIfEmpty(), true);
  assert.equal((await fs.readdir(dir)).includes('r-empty.json'), false);

  const worked = await open('r-worked', 'h1');
  await worked.setNarrativeChunk(0, [{ sceneNumber: 1 }]);
  assert.equal(await worked.discardIfEmpty(), false);
  assert.equal((await fs.readdir(dir)).includes('r-worked.json'), true);
});
