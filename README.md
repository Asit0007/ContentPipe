# ContentPipe

Turns a news story and its source links into a production-ready video brief: researched dossier, narrative plan, scene-by-scene script, layered image prompts, motion direction and source citations — exported as Markdown.

Built on the Gemini API. Node + Express serving a Vite/React front end from one process.

---

## Quick start

```bash
npm install
cp .env.example .env      # then add your GEMINI_API_KEY
npm run dev               # http://localhost:3000
```

Port 3000 in use? `PORT=3100 npm run dev`.

---

## Environment

| Variable | Required | Purpose |
|---|---|---|
| `GEMINI_API_KEY` | **Yes** | Every AI call. Get one at [aistudio.google.com/apikey](https://aistudio.google.com/apikey). |
| `NOTEBOOKLM_API_KEY` | No | Falls back to `GEMINI_API_KEY`. |
| `APP_URL` | No | Self-referential links. |
| `PORT` | No | Defaults to 3000. |
| `HOST` | No | Interface to bind. Defaults to `127.0.0.1` (this machine only) — the endpoints are unauthenticated and spend your Gemini quota. `HOST=0.0.0.0` to expose it, only behind something that authenticates callers. |
| `VITE_FIREBASE_*` | Only for Google Docs export | Client-side Firebase Auth config. See [Google Workspace export](#google-workspace-export-optional). |

`.env` is gitignored. `.env.example` holds placeholders only — never commit real values.

> The server reads `.env` at startup via `dotenv/config`. **Restart after changing it**; there is no hot-reload for environment variables.

---

## The pipeline

Five stages, each its own endpoint. The UI walks them in order.

```
Telegram / news input
        │
        ▼
  /api/research ──── fetches your source URLs, extracts article text,
        │            builds a dossier with per-fact citations, and reports
        │            how much of it is actually sourced
        ▼
  /api/plan ─────── narrative beats, hook strategy, pacing, target duration
        │
        ▼
  /api/script ───── three passes, scenes generated in duration-sized chunks
        │            (see below)
        │
        ▼
  /api/export/markdown ── writes the brief to exports/

  /api/publish-package ─ titles, thumbnails, description, tags (on demand, after the script)
```

### Research is real, within limits

`/api/research` fetches every URL you supply (or any URL found in the pasted text), strips the HTML to prose, and feeds that into the prompt. Facts come back with `factCitations` mapping each claim to the source that supports it, and `retrievedSources` records exactly what was read — including what failed and why.

If a direct fetch fails (paywall, JS-rendered page, timeout) `server/sourceFetcher.ts` escalates through two rescue rungs before giving up: [r.jina.ai](https://r.jina.ai) (a free reader proxy that renders JS server-side) and then a Wayback Machine snapshot. Whichever rung succeeds is recorded as `via: 'direct' | 'jina' | 'wayback'` and disclosed everywhere the source is shown — the model prompt, the UI, and the exported brief's Retrieval column — because a rescued source must never be presented as an ordinary live read. Wayback's own API is aggressively rate-limited (429s observed in normal use), so it's a last resort, never a dependency.

If every rung fails, the source is reported as `ok: false` rather than silently ignored, and the exported brief carries a warning banner. **A brief with no retrieved sources is unverified model output** and says so at the top.

#### What it refuses to claim it read

The failure mode worth guarding against here is not a crash — it is a dossier that looks fine and isn't. Four rules, each closing a way that used to happen:

- **Binary is never text.** `res.text()` will happily UTF-8-decode a PDF, and the mojibake that comes back has no tags, survives HTML stripping, clears the minimum-length check, and gets reported as a clean direct read. `unreadableAs()` refuses it — by magic bytes, then content-type, then the density of replacement and control characters in the decoded text, because content-type is often wrong or missing. A refused PDF isn't lost: the direct rung fails and r.jina.ai extracts its text properly on the next rung.
- **Two dates, never merged.** `published` is what the page states about itself and is the only basis for *when* something happened; `retrieved` is just when this tool read the page. A page that states no date is marked `not stated by the page`, and the prompt is told not to infer one from the retrieval time or from today's date. A bare `<time datetime>` is deliberately ignored — on an article page it's as likely to be a comment's timestamp, and a wrong date is worse than none.
- **Truncation is disclosed.** The cap is 40,000 characters per source (max 6 sources), applied in one place so every rung is capped alike. Anything longer is marked `truncated` in the prompt and in the brief, because the model must not report an absence in a document it only half read.
- **The source text is kept.** Exactly what the model saw is written to `.runs/sources-<id>.json`, so "is this line in the script actually supported?" is answerable afterwards. It's on disk rather than in the response because six sources at the cap is ~240 KB that would otherwise ride in every research response and every request body that echoes the dossier back.

#### Depth, and what happens when there isn't any

A 9-minute script is ~1,350 words of narration; four facts can't carry it, which is how a long-form draft ends up restating one point five ways. The obvious fix — a high `minItems` on `keyFacts` — is the wrong one: `minItems` is a hard constraint, so on a thin story it doesn't produce research, it produces invention.

So the schema floor stays at 3 (enough to catch a degenerate one-fact response) and the real target of 8 is asked for in the prompt, scaled by `targetDurationSec` when you pass one. The prompt's honest way out is `researchGaps`: one line per missing piece, naming what the script still needs and what would answer it. A short `keyFacts` plus a populated `researchGaps` is the correct answer to a thin story.

Compliance is then **counted, not trusted**. `researchCoverage` on the response is computed server-side:

```jsonc
"researchCoverage": {
  "sourcesUsable": 3, "sourcesTruncated": 1, "sourcesUndated": 1,
  "keyFacts": 9, "citedFacts": 7, "uncitedFacts": 2,
  "sourceArchiveId": "a1b2c3d4e5f60718"
}
```

`uncitedFacts` is the number the script will have to carry on trust. A model's own account of its sourcing would itself need checking, so none of this is asked of the model.

> **Not used: Google Search grounding.** The `google_search` tool has zero quota on the Gemini free tier — grounded calls 429 immediately while plain calls succeed. If you enable billing, adding it is a small change to `/api/research`; note that grounding and `responseSchema` are mutually exclusive, so it needs a second structuring call. Grounding is also not planned even with billing: fetching and disclosing real URLs (above) already does better than grounding's opaque citations, for free.
>
> **Rejected as a discovery source: Google News RSS.** Its `<link>` entries are opaque `news.google.com/rss/articles/CBMi…` redirect tokens, and the redirect target is a client-rendered Angular shell with no publisher URL recoverable from the HTML — verified 2026-09-17. Don't re-attempt this path; HN Algolia (`hn.algolia.com/api/v1/search`) and publisher RSS feeds return direct, fetchable URLs and are the better free, key-free option if a discovery stage is added later.

### The channel it writes for

One constant, `DEFAULT_CHANNEL_BRAND` in `shared/brand.ts`, is the show name every "no brand was supplied" path falls back to — server prompts, the canned fallback script, the UI header and watermark, the export headers, the placeholder infographic badge. A rename is one edit.

It is deliberately **not** the name of this tool and not the name of any source site. A script that opens "Welcome back to ContentPipe", or a frame with another publication's name burned into it, is a brand leak — and those aren't hypothetical, they were the defaults until `shared/brand.ts` existed. `server/brand.test.ts` renders every canned surface, including the generated SVG, and fails on any tool or publication name.

Pass `channelBrandName` on `/api/script` to override it per request.

### Script generation runs in three passes

Not one call, deliberately.

| Pass | Produces | Schema |
|---|---|---|
| 1. Production bible | `characterBible`, `styleGuide` | `productionBibleSchema` |
| 2. Narrative | scenes: narration, cinematography, infographics | `buildScriptScenesSchema(min, max)` |
| 3. Art direction | per scene: `visual`, `motion`, `citations` | `buildVisualDirectionSchema(count)` |

**Why split:** on a single combined schema, models return `finishReason: STOP` while silently omitting required fields. Observed with `gemini-3.6-flash`: `characterBible`, `styleGuide`, `visual` and `motion` all absent despite being listed in `required`. The same fields come back reliably when each pass gets a small, focused schema. If you merge these passes back together, expect fields to start disappearing.

Array bounds matter too — without `minItems` on `scenes`, the model returns a single scene and stops.

**Passes 2 and 3 are themselves chunked**, not one call each. `videoPlan.targetDurationSec` (a real request parameter on `/api/plan` — previously hardcoded to 60 regardless of input) is translated into a target scene count, and the narrative pass writes it 3 scenes at a time, carrying the last few scenes forward as prompt context so a long-form script stays continuous across calls. The art-direction pass batches 6 scenes per call. Those two chunk sizes are **not interchangeable, and not arbitrary**: pass 2's per-scene schema includes `infographic` (three more nested arrays on top of `visual`/`motion`), and measured live 2026-09-19, that schema gets a hard `400 INVALID_ARGUMENT` from every model the instant a chunk's `maxItems` reaches 4 — reproducible regardless of `minItems`, confirmed even against the schema exactly as it shipped before this chunking existed. Pass 3's schema has no `infographic` and isn't capped the same way. Don't raise either chunk size without retesting live first — see `scriptSceneItemSchema`'s docstring in `server/schemas.ts` and `NARRATIVE_SCENES_PER_CHUNK`/`VISUAL_DIRECTION_SCENES_PER_CHUNK` in `server/scriptPipeline.ts`.

A chunk that fails (quota exhaustion, a weak fallback-tier model going degenerate under load — both observed live) doesn't fail the whole script; whatever scenes already generated are kept and returned. Check `estimatedTotalDuration` against what was actually requested rather than assuming a match.

### Checkpointing and resume

`/api/script` writes each finished chunk to `.runs/` (gitignored). A run interrupted by a quota hit or a crash resumes from its last finished chunk when the **same request** is sent again — nothing to configure; a run that was already delivered is never replayed, so "regenerate" starts fresh. Optional body fields: `runId` (explicit key) and `fresh: true`. Every response carries `generation` — requested vs produced scenes and duration, whether it is complete, and what degraded — so a short script is never mistaken for a full one.

### Retention audit and mid-rolls

The script also comes back with `timeline`, `chapters`, `midrollMarkers` (two, snapped to scene boundaries near 2:30 and 6:00 — and none, with a warning, under 8:00) and `qualityChecks`: hook, pattern-interrupt cadence, duration shortfall, evidence mix (a slideshow of AI stills is flagged), and any figure or CVE in the narration that is not in the research dossier. All of it is computed from the scenes — no model involved — and the exported brief carries it plus a manual pre-publish checklist.

### Publish package

`POST /api/publish-package` (or the button on the script screen) returns five linted titles, three thumbnail concepts, a description, tags and hashtags. The model writes the copy; code does the rest — title/thumbnail linting, chapters and mid-roll times, a sources list containing only URLs that were actually read, and `{{PLACEHOLDER}}`s (never invented links) for newsletter/social. The recommendation is the linter's, not the model's.

### Request parameters worth knowing

| Endpoint | Field | Effect |
|---|---|---|
| `/api/research` | `sourceUrls` | URLs to fetch. Any URL in `messageText` is picked up too. |
| `/api/research` | `channelName` | Where the story came from, for the dossier's context. Omit it rather than inventing one — your own channel is not a story's origin. |
| `/api/research` | `targetDurationSec` | Optional, and deliberately not defaulted. It scales how much research the dossier is asked for; guessing would either ask a 60-second short for nine minutes of depth or let a documentary settle for four facts. |
| `/api/plan` | `targetDurationSec` | The real target length. Drives scene count and mid-roll placement. |
| `/api/script` | `channelBrandName` | Overrides `DEFAULT_CHANNEL_BRAND` for this script. |
| `/api/script` | `runId`, `fresh` | Explicit checkpoint key; `fresh: true` discards any resume. |

### For automated callers: strict mode

The browser UI always gets *something* — on quota exhaustion the endpoints fall back to canned sample content flagged `isQuotaFallback`. A pipeline must not mistake that for a real draft. Send `X-ContentPipe-Strict: 1` and you get real status codes instead: `429` + `Retry-After` for quota, `503` + `Retry-After` for overload, `502` for non-retryable failures, `409` if the same script run is already in flight. See CLAUDE.md for the full table.

### Character consistency

The mechanism is `promptAnchor`: one dense clause per character, generated once in pass 1, then pasted **verbatim** into every scene's `visual.character`. Rewording it between scenes is what makes a character's face drift across generated images. Same idea for `styleAnchor`, which the server forces to be byte-identical across all scenes.

---

## Exports

`POST /api/export/markdown` writes a full brief to `exports/`, named `YYYY-MM-DD-slug.md`, never overwriting (`-2`, `-3` suffixes). `GET /api/export/list` enumerates them.

Each brief contains YAML front matter, a production summary, loud warnings when the script is incomplete or canned, the quality checks, the source table with read/failed status, fact attribution, chapters and mid-roll placement, a manual pre-publish checklist, the publish package (when generated), the style guide, the character bible with copy-paste anchors, a continuous narration teleprompter, a shot list, and per scene: narration, layered image prompts (character / background / composed / style / negative), motion parameters with a paste-ready `motionPrompt`, and infographic data.

`exports/` is gitignored — these are working artefacts.

In the UI the button lives in the export modal as **Save Markdown to exports/**. It needs no sign-in.

---

## Model configuration

All text generation uses the `TEXT_MODELS` chain in `server/gemini.ts`, tried best-first:

```ts
const TEXT_MODELS = ['gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.1-flash-lite'];
```

**Do not put `gemini-2.5-flash` at the front of this list.** Google returns `404 — no longer available to new users` for it on accounts created recently, so leading with it burns a guaranteed-failed call on every request. The fallback chain exists because the 3.x Flash models return transient `503 high demand` on the free tier regularly; `gemini-3.1-flash-lite` is the most consistently available.

To see what your key can actually reach:

```bash
curl -s "https://generativelanguage.googleapis.com/v1beta/models" \
  -H "x-goog-api-key: $GEMINI_API_KEY" | jq -r '.models[].name'
```

Note that ListModels is not proof of access — `gemini-2.5-flash` appears in that listing and still 404s on `generateContent`.

> **zsh gotcha:** `"$m:generateContent"` in a URL is parsed as a history modifier and silently mangles the model name. Use `"${m}:generateContent"`.

---

## Known free-tier limits

| Capability | Free tier | Notes |
|---|---|---|
| Text generation | Works | Occasional `503` on 3.x Flash; the chain handles it |
| TTS | Works | `gemini-3.1-flash-tts-preview` |
| **Gemini image generation** | **Blocked** | `limit: 0` on `generate_content_free_tier_requests` for every image model — not a rate limit, no quota exists. Needs billing. |
| **Google Search grounding** | **Blocked** | 429 immediately. Needs billing, and not planned even then — see [Research is real, within limits](#research-is-real-within-limits). |

`/api/generate-image` (`server/imageProviders.ts`) doesn't stop at Gemini: it falls through to [Pollinations](https://pollinations.ai), a free hosted diffusion endpoint that needs no API key, before finally falling back to a generated SVG placeholder. The response's `provider` field names which one actually produced the image (`'gemini' | 'pollinations' | 'placeholder'`), and `isPlaceholder: true` means you got a placeholder, not artwork — the UI badges this rather than presenting a placeholder as real art. Note scene prompts sent to Pollinations leave the machine to a third-party host; this is judged acceptable because prompts describe public news stories, not private data.

---

## Google Workspace export (optional)

Creating a file in Google Drive requires OAuth — there is no anonymous path, and `GEMINI_API_KEY` is unrelated (it identifies a project, not a person). If you don't want to sign in, use the Markdown export instead; Drive converts an uploaded `.docx`/`.md` anyway.

To make it work locally, add `localhost` to **Firebase Console → Authentication → Settings → Authorized domains**. AI Studio-provisioned projects only authorize their Cloud Run domains, so `localhost` is missing by default and you get `auth/unauthorized-domain`.

Check the current list without opening the console:

```bash
curl -s "https://identitytoolkit.googleapis.com/v1/projects?key=$VITE_FIREBASE_API_KEY" | jq .authorizedDomains
```

---

## Scripts

```bash
npm test         # 169 unit tests — no network, no quota
npm run test:e2e # real server vs a stub Gemini: 429, overload, crash-resume, SSRF (~1 min)
npm run dev      # tsx server.ts — Express + Vite middleware
npm run build    # vite build + esbuild bundle -> dist/
npm start        # node dist/server.cjs
npm run lint     # tsc --noEmit
```

---

## Layout

```
server.ts                     Express app: routes and wiring only
server/
  gemini.ts                   client, TEXT_MODELS chain, quota-aware generateGeminiJson
  quota.ts                    classifies Gemini errors (per-minute / per-day / limit: 0 / overload)
  strict.ts                   strict-mode status mapping (X-ContentPipe-Strict)
  scriptPipeline.ts           the three script passes and chunking
  runJournal.ts               on-disk checkpoints (.runs/) for /api/script
  sourceArchive.ts            keeps the text the model actually saw (.runs/sources-*.json)
  researchCoverage.ts         counts how much of a dossier is genuinely cited
  timeline.ts                 timeline, chapters, mid-rolls, retention/compliance audit
  publishPackage.ts           titles / thumbnails / description / tags + linters
  netGuard.ts                 SSRF guard for fetched URLs
  hnThread.ts                 Hacker News discussion as a retrievable source (Algolia API)
  schemas.ts                  Gemini responseSchema definitions
  sourceFetcher.ts            URL fetching, HTML-to-text extraction, and the (hn-api) -> direct -> jina -> wayback rescue ladder
  imageProviders.ts           Scene image chain: Gemini -> Pollinations -> SVG placeholder
  markdownExporter.ts         Brief rendering + file writing
  fallbackGenerators.ts       Canned output when the API is unreachable
  notebooklmService.ts        Multi-voice podcast audio
shared/
  brand.ts                    DEFAULT_CHANNEL_BRAND — imported by both server/ and src/
src/
  App.tsx                     Stage orchestration
  components/                 One component per pipeline stage
  types.ts                    Shared types — mirrors server/schemas.ts
  utils/googleWorkspace.ts    Firebase Auth + Docs/Sheets export
exports/                      Generated briefs (gitignored)
.runs/                        Script-run checkpoints and source archives (gitignored, pruned after 7 days)
e2e/                          End-to-end failure-contract test (npm run test:e2e)
```

`src/types.ts` and `server/schemas.ts` describe the same shapes in two languages. **Change both together** or the schema will quietly stop matching what the UI reads.

---

## Troubleshooting

**Everything reads like canned content about an XZ backdoor.** You're getting `generateFallbackGenerators` output. Check `isQuotaFallback` in the response, then check that `GEMINI_API_KEY` is set *and* the server was restarted after setting it.

**`EADDRINUSE: 0.0.0.0:3000`.** Something else owns the port — Grafana is a common culprit. Use `PORT=3100 npm run dev`.

**Scenes missing `visual` or `motion`.** A pass returned incomplete output. Check `generation.degraded` in the response, then the server log for `[Art Director]` and `[Production Bible]` lines. Don't fix it by merging schemas.

**A script shorter than requested.** Check `generation` — it says how many scenes were produced and which chunk failed. Send the same request again after the quota resets and it resumes from the last finished chunk.

**`Blocked: … private or reserved address` on a source.** The SSRF guard refused an internal/loopback URL, by design.

**A source failed with `Response is a PDF, which cannot be decoded as text here`.** Working as intended — the direct rung refuses binary rather than passing mojibake off as an article. Check `attempts` on that source: the reader-proxy rung usually extracts the PDF on the next try. If every rung failed, no text was retrieved and the dossier genuinely has nothing from that URL.

**The dossier is thin and `researchGaps` is full.** The sources didn't support more. That's the honest answer, not a bug — `researchGaps` names what would fill it. Check `researchCoverage.uncitedFacts` too: those are claims the script will carry on trust.

**Everything in the brief says `Published: not stated`.** The pages carry no publication metadata. Nothing is inferred from the fetch time, so date-sensitive framing ("this week", "newly disclosed") needs checking by hand before publishing.

**`auth/unauthorized-domain`.** See [Google Workspace export](#google-workspace-export-optional).
