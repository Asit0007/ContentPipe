---
name: contentpipe
description: Run or extend the ContentPipe video-brief pipeline — research a news story from its source links, generate a plan and a scene-by-scene script with layered image prompts and motion direction, and export a Markdown brief to exports/. Use when asked to produce a brief or script from a news item, to run the pipeline end to end, to debug a stage returning canned or incomplete output, or to add fields to the script schema.
---

# ContentPipe

News story + source links → researched dossier → narrative plan → scene-by-scene script with layered image prompts, motion direction and citations → Markdown brief in `exports/`.

Read `CLAUDE.md` in the repo root before changing anything. It records failure modes that are expensive to rediscover.

## Running the pipeline

Start the server (3000 is often taken by Grafana):

```bash
PORT=3100 npm run dev
```

Then walk the stages. Each feeds the next:

```bash
# 1. Research — pass the source links explicitly
curl -s -m 240 -X POST localhost:3100/api/research \
  -H 'Content-Type: application/json' \
  -d '{"messageText":"<the story>","channelName":"<source>","sourceUrls":["https://..."]}' \
  -o /tmp/r.json

# 2. Plan
python3 -c "import json;r=json.load(open('/tmp/r.json'));json.dump({'researchData':r,'targetFormat':'9:16','targetTone':'Cyberpunk Drama'},open('/tmp/pq.json','w'))"
curl -s -m 240 -X POST localhost:3100/api/plan -H 'Content-Type: application/json' -d @/tmp/pq.json -o /tmp/p.json

# 3. Script — three passes server-side, slowest stage
python3 -c "import json;r=json.load(open('/tmp/r.json'));p=json.load(open('/tmp/p.json'));json.dump({'videoPlan':p,'researchData':r,'channelBrandName':'The Orange Thread'},open('/tmp/sq.json','w'))"
curl -s -m 600 -X POST localhost:3100/api/script -H 'Content-Type: application/json' -d @/tmp/sq.json -o /tmp/s.json

# 4. Export
python3 -c "import json;json.dump({'script':json.load(open('/tmp/s.json')),'research':json.load(open('/tmp/r.json')),'plan':json.load(open('/tmp/p.json'))},open('/tmp/eq.json','w'))"
curl -s -X POST localhost:3100/api/export/markdown -H 'Content-Type: application/json' -d @/tmp/eq.json
```

## Verifying a run

Server log should show both coverage lines. Partial coverage means a pass degraded:

```
[Production Bible] N character(s) defined
[Art Director] visual direction applied to N/M scenes
```

Structural check:

```bash
python3 -c "
import json; d=json.load(open('/tmp/s.json')); sc=d['scenes']
print('scenes:', len(sc), '| visual:', sum(1 for x in sc if x.get('visual')), '| motion:', sum(1 for x in sc if x.get('motion')))
print('bible:', len(d.get('characterBible') or []), '| styleGuide:', bool(d.get('styleGuide')))
print('anchors identical:', len({(x.get('visual') or {}).get('styleAnchor') for x in sc}) == 1)
"
```

Also check `retrievedSources` in `/tmp/r.json`: every entry with `ok: false` is a claim the brief could not verify.

## Diagnosing bad output

Work down this list before touching prompts.

1. **Output looks generic or off-topic** — check `isQuotaFallback` in the response. `true` means the AI call never succeeded and you're reading `server/fallbackGenerators.ts` canned content. Usually a missing `GEMINI_API_KEY`, or `.env` edited without restarting the server.
2. **Fields missing from scenes** — a pass returned incomplete output. Never fix this by merging schemas; see `CLAUDE.md`. Check whether a stale inline JSON example in the prompt contradicts the `responseSchema`.
3. **Only one scene** — the array lost its `minItems` constraint.
4. **404 on a model** — verify against ListModels *and* a real `generateContent` call. Use `"${m}:generateContent"`, never `"$m:generateContent"`, or zsh corrupts the name.
5. **429 with `limit: 0`** — no quota exists on the free tier for that capability (images, search grounding). Not retryable; needs billing.

## Extending the script

Adding a field means touching three places, in this order:

1. `server/schemas.ts` — add to the pass whose schema stays smallest
2. `src/types.ts` — mirror it, **optional** (`field?:`), since older scripts and failed passes won't have it
3. the prompt in `server.ts` — spec *and* inline JSON example, which must agree
4. `server/markdownExporter.ts` — render it, tolerating absence

Then run the pipeline end to end and confirm coverage before assuming it worked.
