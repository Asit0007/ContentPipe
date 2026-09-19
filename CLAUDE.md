# CLAUDE.md

Guidance for Claude Code when working in this repository.

Read `README.md` first for setup and the pipeline overview. This file covers what isn't obvious from the code and what has already been tried and rejected.

---

## What this is

A news story plus its source links go in; a production-ready video brief comes out — researched dossier, narrative plan, scene-by-scene script with layered image prompts, motion direction and citations, exported as Markdown to `exports/`.

The owner's stated goal: *feed in a news item and a link to its sources, have the app research it, and produce scripts for the images (character, background, scene) and for animating those images into video.* The animation output is **prompts and direction, not rendered video** — that was a deliberate decision, not an unfinished feature. Do not build video rendering unless asked.

---

## Architecture

Single Express app (`server.ts`) that also serves the Vite/React front end in middleware mode. One process, one port. No routing library, no database — state lives in the browser and in `exports/`.

```
/api/research  → fetches source URLs, extracts text, builds a cited dossier
/api/plan      → narrative beats
/api/script    → three passes: production bible → narrative → art direction
/api/tts       → narration audio
/api/generate-image → scene stills (Gemini -> Pollinations -> SVG placeholder, see below)
/api/export/markdown → writes the brief to exports/
/api/chat, /api/ip-names, /api/notebooklm-* → side features
```

---

## Things that will bite you

### Model IDs are account-specific

`gemini-2.5-flash` returns **404 "no longer available to new users"** on recently created accounts, *while still appearing in ListModels*. It used to lead every fallback chain in this repo, which meant every request burned a guaranteed-failed call before doing real work. It is now absent from `TEXT_MODELS` on purpose. Don't reintroduce it.

`imagen-3.0-generate-002` is shut down entirely, and Imagen models use `generateImages`, not `generateContent` — it could never have worked in the image endpoint even when it was alive.

Verify against the live API rather than memory; these names change faster than any model's training data:

```bash
curl -s "https://generativelanguage.googleapis.com/v1beta/models" \
  -H "x-goog-api-key: $GEMINI_API_KEY" | jq -r '.models[].name'
```

ListModels is necessary but not sufficient — confirm with an actual `generateContent` call.

### Large response schemas silently lose required fields

The most important thing in this repo. Given a big `responseSchema`, models return `finishReason: STOP` — no error, no truncation — with required fields simply **absent**. Confirmed on `gemini-3.6-flash`: `characterBible`, `styleGuide`, `visual` and `motion` all missing despite being in `required`. The same schema fragments work perfectly when requested on their own.

Hence three passes in `/api/script`, each with a small schema. **Do not consolidate them to save a round trip.** If you add fields, add them to whichever pass keeps its schema smallest, or add a fourth pass.

Related: arrays need explicit `minItems`. Without it the model returns one scene and stops.

A second, harder failure mode on the same root cause: it's not just about field *breadth*, array *length* has its own ceiling, and this one is a hard `400` rather than a silent omission. `scriptSceneItemSchema` (the narrative pass's per-scene shape, which includes `infographic` — three more nested arrays-of-objects on top of `visual`/`motion`) gets an immediate `400 INVALID_ARGUMENT` from every model in `TEXT_MODELS` the instant a wrapping array's `maxItems` reaches 4 — measured live 2026-09-19, reproducible regardless of `minItems` or whether `min === max`, confirmed even against the schema exactly as it shipped before long-form chunking existed (it was always there, just never exercised past 6 items). Removing just `infographic` let `maxItems: 6` succeed again. This is why `/api/script`'s narrative pass generates scenes 3 at a time (`NARRATIVE_SCENES_PER_CHUNK` in `server.ts`) while the art-direction pass, whose schema lacks `infographic`, stays at 6 (`VISUAL_DIRECTION_SCENES_PER_CHUNK`). Don't raise either without retesting live first.

### Grounding and structured output are mutually exclusive

`tools: [{google_search: {}}]` cannot be combined with `responseMimeType: 'application/json'` + `responseSchema`. If grounding is ever enabled it needs two calls: grounded free-form generation, then a structuring pass. Currently moot — see quota below.

### Free tier has hard zeroes, not just rate limits

| Capability | Status |
|---|---|
| Text | works (transient 503s on 3.x Flash; the chain absorbs them) |
| TTS | works |
| Gemini image generation | **`limit: 0`** — no quota exists at all |
| Google Search grounding | **429 immediately** |

A 429 saying `limit: 0` is not something to retry or work around on the Gemini side; it needs billing. Don't add backoff for it. But image generation itself is no longer blocked end-to-end — `server/imageProviders.ts` falls through to Pollinations (free, no key) before the SVG placeholder. Grounding stays genuinely unaddressed and is not planned even with billing: fetching real URLs and disclosing exactly what was read (see the rescue ladder below) already beats grounding's opaque citations, for free.

### The fetch rescue ladder, and its two live gotchas

`server/sourceFetcher.ts` doesn't give up after one failed fetch. It escalates: direct → [r.jina.ai](https://r.jina.ai) reader proxy → Wayback Machine snapshot, stopping at first success. Whichever rung wins is recorded as `via` and disclosed everywhere a source is shown (prompt, UI, exported brief) — a rescued source must never look like an ordinary live read.

Two things cost real debugging time building this and are worth knowing up front:

- **r.jina.ai bot-checks a browser-spoofing `User-Agent`.** The same Chrome UA this repo already uses for direct fetches (because *that* UA is needed to get past news sites) gets a Cloudflare "Just a moment…" 403 from r.jina.ai's own edge. An honest, non-browser UA (`ContentPipe-SourceFetcher/1.0`) passes with a plain 200. The two rungs need *opposite* UA strategies — don't unify them.
- **The Wayback Machine's own API (`archive.org/wayback/available`) rate-limits aggressively** — 429s were observed repeatedly in ordinary manual testing, not under load. Treat it as a last-resort rung that will often fail, never as a dependency, and never retry a 429 there.

**Rejected as a discovery source: Google News RSS.** `<link>` entries are opaque `news.google.com/rss/articles/CBMi…` tokens; the redirect target is a client-rendered Angular shell with zero publisher URLs recoverable from 598 KB of HTML (verified 2026-09-17). Don't re-attempt this path. HN Algolia and publisher RSS feeds both return direct fetchable URLs and are the better option if a discovery stage is ever built.

### Environment loading

`server.ts` imports `dotenv/config` at the top. Before that existed, `process.env.GEMINI_API_KEY` was always undefined locally and every request silently produced `fallbackGenerators` output — canned XZ-backdoor content that looks plausible. **`.env` is read once at startup; restart after editing.**

When output looks generic or off-topic, check `isQuotaFallback` before debugging prompts.

### zsh mangles model IDs in URLs

`"$m:generateContent"` is parsed as a history modifier and silently corrupts the name — `gemini-3.7-flash` becomes `7-flashnerateContent`, producing 404s that look like the model doesn't exist. Always `"${m}:generateContent"`. This cost a full misdiagnosis once.

---

## Conventions

**`src/types.ts` and `server/schemas.ts` are two descriptions of the same shapes.** Change both together. The schema constrains what the model emits; the types describe what the UI reads. Drift is silent.

**New optional scene fields must stay optional in `src/types.ts`** (`visual?`, `motion?`, `citations?`). Scenes generated before a pass existed, or when a pass fails, won't have them, and every consumer must tolerate that. `visualPrompt` is the always-present fallback.

**Prompts carry an inline JSON example alongside `responseSchema`.** When they disagree the model follows the inline example — this caused `visual`/`motion` to go missing even with a correct schema. Update both, or delete the example.

**Fallback generators are load-bearing.** Every AI endpoint degrades to `server/fallbackGenerators.ts` rather than erroring, so the UI always has something to render. Keep that property; make failures visible in the *output* (`isQuotaFallback`, source status tables) instead of throwing.

**Source honesty is a product requirement.** `/api/research` used to regex-scrape a URL out of the input — or hardcode `news.ycombinator.com` — and present it as a source it had consulted. It hadn't. Never present unread URLs as sources. `retrievedSources` records what was actually fetched, failures included, and the exported brief warns when nothing was read.

---

## Verifying changes

There are no automated tests. Run the pipeline end to end against the live API:

```bash
PORT=3100 npm run dev

curl -s -X POST localhost:3100/api/research -H 'Content-Type: application/json' \
  -d '{"messageText":"...","sourceUrls":["https://..."]}' > /tmp/r.json

# then /api/plan with {researchData, targetDurationSec}, /api/script with {videoPlan, researchData}
# targetDurationSec defaults to 60 if omitted (short-form) — pass e.g. 540 to exercise the
# chunked long-form path in /api/script instead of the single-chunk short-form one.
```

Check the server log for coverage lines — `[Production Bible] N character(s) defined`, `[Script Agent] generated N/M scenes across K chunk(s)`, and `[Art Director] visual direction applied to N/M scenes across K chunk(s)`. Partial coverage means a pass (or one chunk of it) is degrading.

Then confirm structure holds:

```bash
python3 -c "
import json; d=json.load(open('/tmp/s.json')); sc=d['scenes']
print('visual:', sum(1 for x in sc if x.get('visual')), '/', len(sc))
print('anchors identical:', len({(x.get('visual') or {}).get('styleAnchor') for x in sc})==1)
"
```

`npm run lint` is `tsc --noEmit`. Zero errors is the baseline.

---

## Security

`.env`, `exports/` and `firebase-applet-config.json` are gitignored. The repo is **public** — nothing with a real credential in it may be committed.

Firebase web config values are public by design (they ship in the browser bundle) but are kept out of the repo anyway; they load from `VITE_FIREBASE_*`. A Firebase API key was committed once and force-pushed out of history — treat that key as burned, and remember GitHub still serves orphaned commits by SHA after a force-push, so rotation matters more than history rewriting.
