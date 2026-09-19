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
        │            builds a dossier with per-fact citations
        ▼
  /api/plan ─────── narrative beats, hook strategy, pacing, target duration
        │
        ▼
  /api/script ───── three passes, scenes generated in duration-sized chunks
        │            (see below)
        │
        ▼
  /api/export/markdown ── writes the brief to exports/
```

### Research is real, within limits

`/api/research` fetches every URL you supply (or any URL found in the pasted text), strips the HTML to prose, and feeds that into the prompt. Facts come back with `factCitations` mapping each claim to the source that supports it, and `retrievedSources` records exactly what was read — including what failed and why.

If a direct fetch fails (paywall, JS-rendered page, timeout) `server/sourceFetcher.ts` escalates through two rescue rungs before giving up: [r.jina.ai](https://r.jina.ai) (a free reader proxy that renders JS server-side) and then a Wayback Machine snapshot. Whichever rung succeeds is recorded as `via: 'direct' | 'jina' | 'wayback'` and disclosed everywhere the source is shown — the model prompt, the UI, and the exported brief's Retrieval column — because a rescued source must never be presented as an ordinary live read. Wayback's own API is aggressively rate-limited (429s observed in normal use), so it's a last resort, never a dependency.

If every rung fails, the source is reported as `ok: false` rather than silently ignored, and the exported brief carries a warning banner. **A brief with no retrieved sources is unverified model output** and says so at the top.

> **Not used: Google Search grounding.** The `google_search` tool has zero quota on the Gemini free tier — grounded calls 429 immediately while plain calls succeed. If you enable billing, adding it is a small change to `/api/research`; note that grounding and `responseSchema` are mutually exclusive, so it needs a second structuring call. Grounding is also not planned even with billing: fetching and disclosing real URLs (above) already does better than grounding's opaque citations, for free.
>
> **Rejected as a discovery source: Google News RSS.** Its `<link>` entries are opaque `news.google.com/rss/articles/CBMi…` redirect tokens, and the redirect target is a client-rendered Angular shell with no publisher URL recoverable from the HTML — verified 2026-09-17. Don't re-attempt this path; HN Algolia (`hn.algolia.com/api/v1/search`) and publisher RSS feeds return direct, fetchable URLs and are the better free, key-free option if a discovery stage is added later.

### Script generation runs in three passes

Not one call, deliberately.

| Pass | Produces | Schema |
|---|---|---|
| 1. Production bible | `characterBible`, `styleGuide` | `productionBibleSchema` |
| 2. Narrative | scenes: narration, cinematography, infographics | `buildScriptScenesSchema(min, max)` |
| 3. Art direction | per scene: `visual`, `motion`, `citations` | `buildVisualDirectionSchema(count)` |

**Why split:** on a single combined schema, models return `finishReason: STOP` while silently omitting required fields. Observed with `gemini-3.6-flash`: `characterBible`, `styleGuide`, `visual` and `motion` all absent despite being listed in `required`. The same fields come back reliably when each pass gets a small, focused schema. If you merge these passes back together, expect fields to start disappearing.

Array bounds matter too — without `minItems` on `scenes`, the model returns a single scene and stops.

**Passes 2 and 3 are themselves chunked**, not one call each. `videoPlan.targetDurationSec` (a real request parameter on `/api/plan` — previously hardcoded to 60 regardless of input) is translated into a target scene count, and the narrative pass writes it 3 scenes at a time, carrying the last few scenes forward as prompt context so a long-form script stays continuous across calls. The art-direction pass batches 6 scenes per call. Those two chunk sizes are **not interchangeable, and not arbitrary**: pass 2's per-scene schema includes `infographic` (three more nested arrays on top of `visual`/`motion`), and measured live 2026-09-19, that schema gets a hard `400 INVALID_ARGUMENT` from every model the instant a chunk's `maxItems` reaches 4 — reproducible regardless of `minItems`, confirmed even against the schema exactly as it shipped before this chunking existed. Pass 3's schema has no `infographic` and isn't capped the same way. Don't raise either chunk size without retesting live first — see `scriptSceneItemSchema`'s docstring in `server/schemas.ts` and `NARRATIVE_SCENES_PER_CHUNK`/`VISUAL_DIRECTION_SCENES_PER_CHUNK` in `server.ts`.

A chunk that fails (quota exhaustion, a weak fallback-tier model going degenerate under load — both observed live) doesn't fail the whole script; whatever scenes already generated are kept and returned. Check `estimatedTotalDuration` against what was actually requested rather than assuming a match.

### Character consistency

The mechanism is `promptAnchor`: one dense clause per character, generated once in pass 1, then pasted **verbatim** into every scene's `visual.character`. Rewording it between scenes is what makes a character's face drift across generated images. Same idea for `styleAnchor`, which the server forces to be byte-identical across all scenes.

---

## Exports

`POST /api/export/markdown` writes a full brief to `exports/`, named `YYYY-MM-DD-slug.md`, never overwriting (`-2`, `-3` suffixes). `GET /api/export/list` enumerates them.

Each brief contains YAML front matter, a production summary, the source table with read/failed status, fact attribution, the style guide, the character bible with copy-paste anchors, a continuous narration teleprompter, a shot list, and per scene: narration, layered image prompts (character / background / composed / style / negative), motion parameters with a paste-ready `motionPrompt`, and infographic data.

`exports/` is gitignored — these are working artefacts.

In the UI the button lives in the export modal as **Save Markdown to exports/**. It needs no sign-in.

---

## Model configuration

All text generation uses the `TEXT_MODELS` chain in `server.ts`, tried best-first:

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
npm run dev      # tsx server.ts — Express + Vite middleware
npm run build    # vite build + esbuild bundle -> dist/
npm start        # node dist/server.cjs
npm run lint     # tsc --noEmit
```

---

## Layout

```
server.ts                     Express app, all endpoints, model chain
server/
  schemas.ts                  Gemini responseSchema definitions
  sourceFetcher.ts            URL fetching, HTML-to-text extraction, and the direct -> jina -> wayback rescue ladder
  imageProviders.ts           Scene image chain: Gemini -> Pollinations -> SVG placeholder
  markdownExporter.ts         Brief rendering + file writing
  fallbackGenerators.ts       Canned output when the API is unreachable
  notebooklmService.ts        Multi-voice podcast audio
src/
  App.tsx                     Stage orchestration
  components/                 One component per pipeline stage
  types.ts                    Shared types — mirrors server/schemas.ts
  utils/googleWorkspace.ts    Firebase Auth + Docs/Sheets export
exports/                      Generated briefs (gitignored)
```

`src/types.ts` and `server/schemas.ts` describe the same shapes in two languages. **Change both together** or the schema will quietly stop matching what the UI reads.

---

## Troubleshooting

**Everything reads like canned content about an XZ backdoor.** You're getting `generateFallbackGenerators` output. Check `isQuotaFallback` in the response, then check that `GEMINI_API_KEY` is set *and* the server was restarted after setting it.

**`EADDRINUSE: 0.0.0.0:3000`.** Something else owns the port — Grafana is a common culprit. Use `PORT=3100 npm run dev`.

**Scenes missing `visual` or `motion`.** A pass returned incomplete output. Check the server log for `[Art Director]` and `[Production Bible]` lines, which report coverage. Don't fix it by merging schemas.

**`auth/unauthorized-domain`.** See [Google Workspace export](#google-workspace-export-optional).
