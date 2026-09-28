// Stub ContentPipe for scripts/story-start.ts — exercises the whole 08:00 orchestration with ZERO quota.
//
//   npm run story:check
//
// It asserts, by answering 500 when they are wrong, that story-start.ts:
//   - sends X-ContentPipe-Strict on every call (so quota comes back as 429, never canned content)
//   - forwards targetDurationSec to /api/research (a 9-minute script must not be researched like a short)
//   - strips hnCommunitySentiment / infotainmentAngles before /api/plan (as CyberPipe's pipeline.py does)
//   - sends a stable runId and fresh:true to /api/script
// and that it waits out a 429 and re-POSTs a 409 instead of starting a second run.
// First /api/research answers 429 + Retry-After 2 to prove the wait/retry path, then succeeds.
import http from 'http';
let researchCalls = 0, scriptCalls = 0;
const seen = [];
const json = (res, code, body, headers = {}) => {
  res.writeHead(code, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};
http.createServer((req, res) => {
  if (req.url === '/api/health') return json(res, 200, { status: 'ok' });
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : {};
    seen.push({ url: req.url, strict: req.headers['x-contentpipe-strict'], keys: Object.keys(body) });
    if (req.url === '/api/research') {
      if (++researchCalls === 1) return json(res, 429, { error: 'quota', kind: 'per_day' }, { 'Retry-After': '2' });
      if (!body.targetDurationSec) return json(res, 400, { error: 'targetDurationSec missing' });
      return json(res, 200, {
        topicTitle: 'OnePlus root', summary: 's', keyFacts: ['a'],
        retrievedSources: (body.sourceUrls || []).map((u, i) => ({ id: `S${i}`, url: u, ok: i !== 3, error: i === 3 ? 'timeout' : undefined })),
        researchCoverage: { cited: 3, total: 4 }, researchGaps: ['no vendor advisory'],
        hnCommunitySentiment: 'LEAK', infotainmentAngles: ['LEAK'],
      });
    }
    if (req.url === '/api/plan') {
      if ('hnCommunitySentiment' in body.researchData || 'infotainmentAngles' in body.researchData)
        return json(res, 500, { error: 'infotainment fields were forwarded — should have been stripped' });
      return json(res, 200, { title: 'The Debug Door', tone: body.targetTone, targetDurationSec: body.targetDurationSec, narrativeBeats: [{ act: 'Act 1' }, { act: 'Act 2' }] });
    }
    if (req.url === '/api/script') {
      // A 409 on the first call proves the re-POST-into-the-same-journal path.
      if (++scriptCalls === 1) return json(res, 409, { error: 'in progress', kind: 'in_progress' }, { 'Retry-After': '2' });
      if (!body.runId || !body.fresh) return json(res, 500, { error: `runId/fresh missing: ${JSON.stringify({ runId: body.runId, fresh: body.fresh })}` });
      return json(res, 200, {
        title: 'The Debug Door: How One Audio Service Rooted a Flagship',
        estimatedTotalDuration: 572, tonePacing: body.videoPlan.tone,
        scenes: [{ id: 1, narration: 'n', speaker: 'narrator', durationEst: 10, visual: {} }, { id: 2, narration: 'n2', durationEst: 12, visual: {} }],
        generation: { complete: true },
      });
    }
    if (req.url === '/api/export/markdown') return json(res, 200, { ok: true, relativePath: 'exports/stub.md', bytes: 4242 });
    return json(res, 404, { error: 'no' });
  });
}).listen(3199, '127.0.0.1', () => console.error('stub on 3199'));
process.on('SIGTERM', () => { console.log(JSON.stringify(seen, null, 1)); process.exit(0); });
