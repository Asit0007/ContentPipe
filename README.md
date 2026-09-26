# ContentPipe

Turns a news story and its source links into a production-ready video brief: researched dossier, narrative plan, scene-by-scene script, layered image prompts, motion direction and source citations — exported as Markdown.

Text generation runs through a **multi-provider LLM chain** — DeepSeek first, then Grok, the free-tier providers, and Gemini last (see [Model configuration](#model-configuration)). Narration audio uses Gemini TTS. Scene images and image-to-video clips come from Hugging Face Spaces in an order set in `.env` (Qwen-Image-2512 → HiDream-O1-Image; MiniMax-H3 → Wan 2.2), and every scene also gets a Nano Banana Pro prompt to paste into the Gemini app by hand. Node + Express serving a Vite/React front end from one process.

> Related, outside this repo: a separate set of Claude Skills for openly-AI influencer characters
> reuses this repo's consistency lessons: a verbatim character anchor that is checked rather than just
> requested, a style anchor held identical, canonical recurring locations, and a figures-must-be-sourced
> audit. Different content, same rules; nothing from them is used here.

---

## Where it stands (2026-09-26)

The goal: *feed in a news item and links to its sources, have the app research it, write the script, and produce the images (character, background, scene) and the animation of those images into video.*

| Step | State |
|---|---|
| Research from real sources, cited, with honest gaps | **Done** |
| Plan and scene-by-scene script, written for a non-technical viewer | **Done** |
| Layered image prompts with enforced character/style/place consistency | **Done** |
| Motion direction and a paste-ready image-to-video prompt per scene | **Done** |
| Sound & edit cue sheet (music, restrained SFX, silences, transitions) | **Done** (for a human editor) |
| Titles, thumbnails, description, tags, chapters | **Done** |
| Scene stills generated in the app | **Done**: Hugging Face (Qwen-Image-2512, HiDream-O1-Image), live-verified; Nano Banana Pro by hand via a copy button |
| Stills animated into clips in the app | **Done, one scene at a time**: MiniMax-H3 then Wan 2.2, live-verified. The free GPU allowance gives about 2 MiniMax clips a day |
| Narration | Works, **one voice**; the two-voice (narrator + analyst) read is not wired into TTS |
| Stills + narration → one MP4 with captions | **Module only** (`server/assemble.ts`, `npm run render:fixture`); no endpoint or button, and it uses stills, not the AI clips |
| Batch generation of every scene's assets, checkpointed | **Not built** |
| Burned-in captions / on-screen text | **Not built** (this ffmpeg lacks `drawtext`) |
| Automated end to end via CyberPipe | Stages 1-3 only (research, plan, script) |
| A published Blast Radius video | **Not yet** |

**Known quality issue:** MiniMax-H3's own soundtrack on clips is poor (owner's verdict on the first live clip, 2026-09-26). Mute clip audio in the edit and use the sound pass's cue sheet (YouTube Audio Library / Pixabay) and the narration instead. The picture is good.

---

## Quick start

```bash
npm install
cp .env.example .env      # then add at least one provider key (DEEPSEEK_API_KEY, GEMINI_API_KEY, ...)
npm run llm:check         # verifies each key and model id against the live APIs
npm run dev               # http://localhost:3000
```

The startup log prints the chain it resolved, e.g. `[LLM Chain] deepseek(deepseek-v4-pro,deepseek-flash) -> gemini(...)`. A provider with no key is skipped; with none set the chain is Gemini alone.

Port 3000 in use? `PORT=3100 npm run dev`.

---

## Environment

| Variable | Required | Purpose |
|---|---|---|
| `GEMINI_API_KEY` | **Yes, for TTS**; for text only if no other provider key is set | Narration audio and the last text tier. Get one at [aistudio.google.com/apikey](https://aistudio.google.com/apikey). |
| `DEEPSEEK_API_KEY` | No | Default first provider. Pay-per-token. |
| `XAI_API_KEY` | No | Grok (xAI), pay-per-token. `GROK_API_KEY` is accepted too. Not the same company as Groq. |
| `GROQ_API_KEY`, `CEREBRAS_API_KEY`, `OPENROUTER_API_KEY` | No | Free tiers, rate-limited. OpenRouter uses its `:free` models. |
| `MISTRAL_API_KEY` | No | Free "Experiment" tier, which requires opting into training on your prompts. |
| `LLM_PROVIDER_ORDER` | No | Comma-separated. Default `deepseek,xai,groq,cerebras,openrouter,mistral,gemini`. |
| `<ID>_MODELS`, `<ID>_MAX_TOKENS`, `<ID>_BASE_URL` | No | Per-provider overrides, `<ID>` = `DEEPSEEK`, `XAI`, `GROQ`, `CEREBRAS`, `OPENROUTER`, `MISTRAL`. Model ids drift — see `npm run llm:check`. |
| `LLM_TIMEOUT_MS` | No | Per-request ceiling for the non-Gemini providers. Defaults to 120000. |
| `NOTEBOOKLM_API_KEY` | No | Falls back to `GEMINI_API_KEY`. |
| `APP_URL` | No | Self-referential links. |
| `PORT` | No | Defaults to 3000. |
| `CONTENTPIPE_RENDERS_DIR` | No | Where `server/assemble.ts` writes MP4s and captions. Defaults to `./renders` (gitignored). |
| `HF_TOKEN` | For images/video | Free Hugging Face read token. ZeroGPU Spaces bill GPU time to it (free: 5 min/day). Without it you get the 2-minute anonymous allowance. |
| `IMAGE_PROVIDER_ORDER` / `VIDEO_PROVIDER_ORDER` | No | Which Spaces (and, for images, `gemini:<model>` / `pollinations`) to try, best first. Defaults in `server/mediaOrder.ts`. Switch to another Space by editing this line. |
| `HF_SPACE_BASE_URL` | No | Replaces every Space's host; exists so the e2e test can stand in for Hugging Face. |
| `POLLINATIONS_BASE_URL` | No | Overrides the image fallback host. Exists so the end-to-end test can stand in for Pollinations instead of reaching the network. |
| `HOST` | No | Interface to bind. Defaults to `127.0.0.1` (this machine only) — the endpoints are unauthenticated and spend your provider quota and money. `HOST=0.0.0.0` to expose it, only behind something that authenticates callers. |
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
  /api/script ───── four passes (bible, narrative, art, sound & edit), scenes in duration-sized chunks
        │            (see below)
        │
        ▼
  /api/export/markdown ── writes the brief to exports/

  /api/publish-package ─ titles, thumbnails, description, tags (on demand, after the script)

  /api/tts, /api/generate-image ── narration audio and scene stills, per scene
  /api/generate-video ── animate a scene still into a short clip (Hugging Face), saved to renders/clips/
  server/assemble.ts ──────────── stills + narration -> MP4 + .en.srt (a module, not an endpoint yet)
```

### Who calls it

Two callers, same endpoints. **The browser UI** walks the stages interactively and always gets something back (canned fallbacks when a provider is out). **[CyberPipe](https://github.com/Asit0007/CyberPipe)**, a separate Python repo, is the automated caller: it turns a story into a durable job, runs research → plan → script against this server with `X-ContentPipe-Strict: 1`, schedules retries from `Retry-After`, and holds the script for a Telegram approve/regenerate. CyberPipe generates nothing itself; this repo does all the generation, and knows nothing about jobs, schedules or Telegram.

| | ContentPipe (this repo) | CyberPipe |
|---|---|---|
| Role | the engine: research, plan, script, audit, media, assembly | the orchestrator: jobs, retries, crash recovery, human approval |
| Stack | Node/TypeScript, Express + React UI | Python stdlib + `requests`, SQLite (WAL) |
| Runs as | one HTTP server on `localhost:3000` | two long-running processes (scheduler, Telegram poller) under launchd |
| State | `.runs/` chunk journals, `exports/`, `renders/` | `pipeline.db`: job status, stage outputs, notifications |
| Retries | seconds, inside one request (provider chain, cooldowns, one bounded wait) | minutes to days, across requests (`Retry-After`, backoff, 7-day cap) |

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

### Topic domain: beyond cybersecurity

Every prompt in this repo used to hardcode a single topic: an "elite investigative technology and security journalist," CVE/CVSS-aware audience framing, hacker-cliché visual bans. `shared/topicProfile.ts` pulls that out into a `topicDomain` request field, optional on `/api/research`, `/api/plan`, `/api/script`, `/api/publish-package`, `/api/ip-names`, `/api/chat` and `/api/notebooklm-dialogue`.

- **Omit it (or send `"hacking and cybersecurity news"`) and nothing changes** — every prompt, persona and inline example reproduces the historical cybersecurity wording byte-for-byte. `server/topicProfile.test.ts` pins this: it's the guarantee that Blast Radius and CyberPipe's existing calls are unaffected.
- **Send anything else** (`"personal finance and markets"`, `"true crime"`, `"space science"`, …) and every persona, audience description, and topic-drift guard is templated on it instead — real scriptwriting craft (curiosity-gap hooks, audience-calibrated jargon translation, grounded-specifics discipline, non-cliché visuals), not a find-and-replace of the word "cybersecurity." The two large inline JSON examples in `/api/plan` get a parallel generic pair (`genericDocumentaryExample`/`genericInfotainmentExample` in `server.ts`) rather than being templated in place — per the inline-example lesson above, a cyber-flavored example biases the model toward cyber content regardless of instructions, so a genuinely different example is safer than trying to generalize the cyber one live.
- **Cybersecurity-specific quality rules stay cybersecurity-specific on purpose.** `server/timeline.ts`'s CVE/CVSS "don't rate it, show it" audit and the `terminal`/`diagram`/`headline` evidence-mix check are untouched — they're harmless no-ops outside a tech/security story, and generalizing them further is a separate, unscoped effort.
- **Not covered:** `server/fallbackGenerators.ts` (the canned-content path used only when every LLM provider is down) is still cybersecurity-flavored regardless of `topicDomain` — a non-default topic under total provider outage gets the cyber fallback, flagged `isQuotaFallback` as always.

### Script generation runs in four passes

Not one call, deliberately.

| Pass | Produces | Schema |
|---|---|---|
| 1. Production bible | `characterBible`, `styleGuide` | `productionBibleSchema` |
| 2. Narrative | scenes: narration, cinematography, infographics | `buildScriptScenesSchema(min, max)` |
| 3. Art direction | per scene: `visual`, `motion`, `citations` | `buildVisualDirectionSchema(count)` |
| 4. Sound & edit | `musicCues` (one call), then per scene: `sound` (effect, ambience, silence, transition, J/L-cut) | `buildScorePlanSchema`, `buildSoundDirectionSchema(count)` |

**Why split:** on a single combined schema, models return `finishReason: STOP` while silently omitting required fields. Observed with `gemini-3.6-flash`: `characterBible`, `styleGuide`, `visual` and `motion` all absent despite being listed in `required`. The same fields come back reliably when each pass gets a small, focused schema. If you merge these passes back together, expect fields to start disappearing.

Array bounds matter too — without `minItems` on `scenes`, the model returns a single scene and stops.

**Passes 2 and 3 are themselves chunked**, not one call each. `videoPlan.targetDurationSec` (a real request parameter on `/api/plan` — previously hardcoded to 60 regardless of input) is translated into a target scene count, and the narrative pass writes it 3 scenes at a time, carrying the last few scenes forward as prompt context so a long-form script stays continuous across calls. The art-direction pass batches 6 scenes per call. Those two chunk sizes are **not interchangeable, and not arbitrary**: pass 2's per-scene schema includes `infographic` (three more nested arrays on top of `visual`/`motion`), and measured live 2026-09-19, that schema gets a hard `400 INVALID_ARGUMENT` from every model the instant a chunk's `maxItems` reaches 4 — reproducible regardless of `minItems`, confirmed even against the schema exactly as it shipped before this chunking existed. Pass 3's schema has no `infographic` and isn't capped the same way. Don't raise either chunk size without retesting live first — see `scriptSceneItemSchema`'s docstring in `server/schemas.ts` and `NARRATIVE_SCENES_PER_CHUNK`/`VISUAL_DIRECTION_SCENES_PER_CHUNK` in `server/scriptPipeline.ts`.

A chunk that fails (quota exhaustion, a weak fallback-tier model going degenerate under load — both observed live) doesn't fail the whole script; whatever scenes already generated are kept and returned. Check `estimatedTotalDuration` against what was actually requested rather than assuming a match.

### Two voices

Each scene carries an optional `speaker`: `narrator` or `analyst`. [ContentRender](../ContentRender) reads a video with two voices — the narrator tells the story, and the analyst is a short first-person reaction between narrator sections. Absent means narrator, so older scripts are unaffected.

Placement is decided **in code, not by the model** (`shared/speakers.ts`): every 6th scene except the last, so the analyst never opens or closes the video and never speaks twice in a row. The narrative pass is told which scene numbers in its chunk are reactions and how to write one; it never returns `speaker`, so the field is deliberately absent from `server/schemas.ts`. An analyst scene keeps the previous scene's `actPhase` (otherwise it would split a chapter), and `qualityChecks` warns when a reaction runs past 30 words. Details, the reasons, and an honest live-test caveat are in `CLAUDE.md` ("Two voices").

### Checkpointing and resume

`/api/script` writes each finished chunk to `.runs/` (gitignored). A run interrupted by a quota hit or a crash resumes from its last finished chunk when the **same request** is sent again — nothing to configure; a run that was already delivered is never replayed, so "regenerate" starts fresh. Optional body fields: `runId` (explicit key) and `fresh: true`. Every response carries `generation` — requested vs produced scenes and duration, whether it is complete, and what degraded — so a short script is never mistaken for a full one.

### Retention audit and mid-rolls

The script also comes back with `timeline`, `chapters`, `midrollMarkers` (two, snapped to scene boundaries near 2:30 and 6:00 — and none, with a warning, under 8:00) and `qualityChecks`: hook, pattern-interrupt cadence, duration shortfall, evidence mix (a slideshow of AI stills is flagged), and any figure or CVE in the narration that is not in the research dossier. All of it is computed from the scenes — no model involved — and the exported brief carries it plus a manual pre-publish checklist.

The shortfall error fires below **0.92** of the requested runtime, and the documentary preset and CyberPipe's default target are **585 s**: the old 540 s × 0.85 tolerance was 459 s, under the 480 s mid-roll minimum. Durations start as the model's `durationEst` guesses; `retimeFromAudio` (`server/timeline.ts`) replaces them with the rendered video's real scene durations and recomputes all of the above, so chapters and mid-rolls land on what actually plays. It refuses timings that don't match the scenes one-to-one by `id`, and drops any built publish package (its description embeds the old chapter times).

### Publish package

`POST /api/publish-package` (or the button on the script screen) returns five linted titles, three thumbnail concepts, a description, tags and hashtags. The model writes the copy; code does the rest — title/thumbnail linting, chapters and mid-roll times, a sources list containing only URLs that were actually read, and `{{PLACEHOLDER}}`s (never invented links) for newsletter/social. The recommendation is the linter's, not the model's.

### Video assembly

`server/assemble.ts` turns scene stills and narration audio into an MP4 by running the local `ffmpeg`. It is a **module and a script — not yet an endpoint or a CyberPipe stage**, and nothing generates the per-scene assets for it yet.

```bash
npm run render:fixture                 # stub stills + tone "narration" -> renders/fixture-stub-<ts>.mp4 and .en.srt; no quota, no network
npm run render:fixture -- --720        # faster; --vertical for 9:16
```

- **It refuses rather than degrades.** `/api/tts` and `/api/generate-image` fall back to a synthesized tone and an SVG placeholder so the UI never dead-ends; a render would publish those as if they were real. Every scene is validated before any encoding and *all* problems are reported: placeholder images, non-image bodies labelled `image/png`, the quota-fallback tone, audio under 0.5 s, unsupported WAVs, mixed sample rates, partial captions.
- **Audio is joined once, sample-accurately,** and muxed with a single AAC encode (loudness-normalised to -14 LUFS) against stream-copied video. Encoding AAC per scene and concatenating drifts by an encoder delay at every join. On the 56.5 s fixture, audio and video are both exactly 56.500 s, and each scene's silence starts within ~2 ms of the timeline's prediction. 1080p with a slow push-in/pull-out encodes at about 0.3× the video's length on an idle machine (0.66× measured while other test suites were running).
- **The result's `scenes[]` is the real timeline** (`startSec`, `audioSec`, `durationSec`) — feed it to `retimeFromAudio`.
- **Captions are a sidecar SRT** (`server/captions.ts`). Pass each scene's spoken text as `captionText` and the render writes `<name>.en.srt` beside the MP4: the narration verbatim (never a dropped or reordered word — tested), at most two lines of 42 characters, spread across each scene's real speech window. Scene starts are exact; inside a scene the timing is an estimate with no forced alignment (measured against macOS `say`: median 0.29 s, worst 0.76 s, always early). Upload it to YouTube as an English caption track.
- **Not built:** burned-in captions and on-screen text (this Homebrew ffmpeg has no `drawtext`/`subtitles` filter; `brew install ffmpeg-full` is keg-only and would add them), and the stage that generates and checkpoints per-scene TTS and images. One `/api/tts` call per scene is about 51 calls for a 585 s script and the free-tier TTS request quota has not been measured.

### Request parameters worth knowing

| Endpoint | Field | Effect |
|---|---|---|
| `/api/research` | `sourceUrls` | URLs to fetch. Any URL in `messageText` is picked up too. |
| `/api/research` | `channelName` | Where the story came from, for the dossier's context. Omit it rather than inventing one — your own channel is not a story's origin. |
| `/api/research` | `targetDurationSec` | Optional, and deliberately not defaulted. It scales how much research the dossier is asked for; guessing would either ask a 60-second short for nine minutes of depth or let a documentary settle for four facts. |
| `/api/plan` | `targetDurationSec` | The real target length. Drives scene count and mid-roll placement. |
| `/api/script` | `channelBrandName` | Overrides `DEFAULT_CHANNEL_BRAND` for this script. |
| `/api/script` | `runId`, `fresh` | Explicit checkpoint key; `fresh: true` discards any resume. |
| `/api/research`, `/api/plan`, `/api/script`, `/api/publish-package` | `topicDomain` | Optional free text (see "Topic domain" above). Omit for the cybersecurity default. Included in `/api/script`'s resume hash, so resuming with a different `topicDomain` starts a fresh run instead of splicing mismatched prompts into one journal. |

### For automated callers: strict mode

The browser UI always gets *something* — on quota exhaustion the endpoints fall back to canned sample content flagged `isQuotaFallback`. A pipeline must not mistake that for a real draft. Send `X-ContentPipe-Strict: 1` and you get real status codes instead: `429` + `Retry-After` for quota, `503` + `Retry-After` for overload, `502` for non-retryable failures, `409` if the same script run is already in flight. The same header covers `/api/tts` and `/api/generate-image`: a strict caller is never handed the synthesized tone or the SVG placeholder (Pollinations is a real provider and is still returned, labelled). See CLAUDE.md for the full table.

### Character consistency

The mechanism is `promptAnchor`: one dense clause per character, generated once in pass 1, then pasted **verbatim** into every scene's `visual.character`. Rewording it between scenes is what makes a character's face drift across generated images. Same idea for `styleAnchor`, which the server forces to be byte-identical across all scenes.

**Fixed 2026-09-22: the flat `visualPrompt` fallback used to drop `character` and `background` entirely**, building itself from just `scene + styleAnchor`. Since `visualPrompt` is the field every non-layered consumer reads, that silently discarded the verbatim `promptAnchor` — a character could be locked in the bible and still visually drift in anything using the flat prompt. It now concatenates `character + background + scene + styleAnchor` (`negative` stays out on purpose — that belongs in an image API's separate negative-prompt field). See `applyVisualDirection` in `server/scriptPipeline.ts`.

**Closed 2026-09-24**, using the same shape as `styleAnchor`'s enforcement: (1) `promptAnchor` reuse — each scene now also returns `charactersInFrame` (bible character ids present), and `applyVisualDirection` force-splices a listed character's anchor into `visual.character` if the model didn't paste it verbatim; (2) recurring backgrounds — each scene also returns a `locationId` slug, and the first chunk to use one sets the canonical `background` text that every later scene claiming the same id is force-matched to; (3) cut/shot rhythm — each art-direction chunk after the first is shown a summary of every earlier chunk's `visualType` tally, established locations and recent shot types/camera moves, so the model can vary rhythm and lean into whichever the documentary "at least half terminal/diagram/headline" target is short on. See CLAUDE.md ("Visual consistency: what's enforced, what isn't") for the live-verification results and what's still a single sample.

---

## Exports

`POST /api/export/markdown` writes a full brief to `exports/`, named `YYYY-MM-DD-slug.md`, never overwriting (`-2`, `-3` suffixes). `GET /api/export/list` enumerates them.

Each brief contains YAML front matter, a production summary, loud warnings when the script is incomplete or canned, the quality checks, the source table with read/failed status, fact attribution, chapters and mid-roll placement, a manual pre-publish checklist, the publish package (when generated), the style guide, the character bible with copy-paste anchors, a continuous narration teleprompter, a shot list, and per scene: narration, layered image prompts (character / background / composed / style / negative), motion parameters with a paste-ready `motionPrompt`, and infographic data.

`exports/` is gitignored — these are working artefacts.

In the UI the button lives in the export modal as **Save Markdown to exports/**. It needs no sign-in.

---

## Model configuration

### The provider chain

`generateJson` / `generateText` (`server/llm/chain.ts`) try the configured providers in order and return the first usable answer. Registry, default model ids and token caps live in `server/llm/providers.ts`; adding another OpenAI-compatible provider is one entry there.

| Order | Provider | Cost | Default models |
|---|---|---|---|
| 1 | DeepSeek | pay-per-token | `deepseek-v4-pro`, `deepseek-flash` |
| 2 | Grok (xAI) | pay-per-token | `grok-4.6`, `grok-4.3` |
| 3 | Groq | free tier | `qwen/qwen3.8-27b`, `openai/gpt-oss-120b` |
| 4 | Cerebras | free tier | `gpt-oss-120b`, `llama-3.3-70b` |
| 5 | OpenRouter | free `:free` models | `nvidia/nemotron-3-ultra-550b-a55b:free`, `nvidia/nemotron-3-super-120b-a12b:free`, `z-ai/glm-5.2:free`, `qwen/qwen3.8-27b:free`, `nvidia/nemotron-3.5-lightning:free` |
| 6 | Ollama Cloud | free usage tier | `nemotron-3-ultra`, `gemma4:31b`, `nemotron-3-super`, `gpt-oss:120b` |
| 7 | Mistral | free tier, trains on prompts | `mistral-large-latest`, `mistral-small-latest` |
| 8 | Gemini | free tier, ~20 requests/day/model | the `TEXT_MODELS` chain below |

**Those model ids are best guesses from documentation, not live calls.** Run `npm run llm:check`: it lists each provider's real `/models`, flags any configured id that isn't there, and makes one tiny JSON request per provider so a bad key, an empty balance or a rejected parameter shows up before a real run. Override with `<ID>_MODELS`.

How it behaves:

- **Schemas.** Gemini can constrain decoding to a schema; the others only offer `json_object` mode. They get the schema (converted by `server/llm/schema.ts`) in the system prompt, and the answer is checked locally — required keys, types, enums, `minItems`/`maxItems`. A violation gets one repair round with the problems fed back, then the next provider. An answer cut off at the token cap counts as a failure, never a result.
- **Arrays.** `json_object` mode cannot return a bare array, so a caller that wants one passes `rootArray: true`; the model is asked for `{"items": [...]}` and the chain unwraps it (`/api/ip-names` does this).
- **Errors keep the strict-mode contract.** Each failure is classified (no balance → never retry; 429 → per-minute or per-day, reading `Retry-After` and bodies like "try again in 7m12s"; 5xx and timeouts → transient; bad key or bad request → real error). If every provider fails, quota dominates and reports the **earliest** retry across all of them, so strict callers still get `429` / `503` / `502` + `Retry-After`.
- **Cooldowns** are in-process: a provider that answered 401/402/403 is skipped for 30 minutes (restart after fixing a key); a model id the provider doesn't have (404, or a 400 saying so) for 30 minutes; a model that answered 413 "request too large" for 10 minutes; a 429 for its `Retry-After` (the skip is capped at 30 minutes, but a request that finds it cooling still reports the provider's real reset time); a timeout or 5xx for 30 seconds.
- **A daily limit that doesn't say when it resets** (OpenRouter's free daily cap, for one) is treated as lasting until the next 00:00 UTC, and at least an hour — not 60 seconds, which had a strict caller re-polling a spent quota every minute. OpenRouter's `X-RateLimit-Reset` is read from the error body when it is there.
- **Not covered:** TTS and the NotebookLM service still call Gemini directly; images and video go to Hugging Face Spaces (see below). None of these text providers offer them.
- **Privacy.** Every prompt goes to whichever provider answers. DeepSeek's API is hosted in China and Mistral's free tier trains on prompts. That is acceptable here because prompts describe public news stories; it is a different question for private data.

### Which model wrote what (the "AI models on this page" panel)

The chain skips any model that is busy, rate-limited or cooling down, so the configuration alone doesn't tell you who wrote a script. Every page of the UI therefore has an **AI models on this page** panel (`src/components/ModelsPanel.tsx`):

- **What produced this page.** One row per model call ("Narrative, scenes 4-6 (chunk 2/4)", "Scene image (16:9, 1K)"). Each row gives the model that answered (name, maker, provider, exact id), the time, tokens in and out, and every model tried before it with the reason it was passed over. Calls reused from an interrupted run's checkpoint are tagged *from checkpoint*.
- **Configured models, in the order they are tried.** From `GET /api/models` (`server/modelLineup.ts`), built by the same `buildTiers` the chain uses, so it lists only models that have a key. Each one shows its maker, Artificial Analysis intelligence score, cost on this account and what live runs showed (`shared/modelCatalog.ts`, dated 2026-09-24).

| Page | Shows |
|---|---|
| 1. Story Input | the text models Research will use |
| 2. Topic Research | the research dossier call |
| 3. Video Blueprint | the blueprint call |
| 4. Detailed Script | production bible, every narrative and art-direction chunk, the publish package, per-scene voice and image calls |
| 5. Video Player | voice, images, podcast dialogue and podcast audio |

For API callers, `/api/research`, `/api/plan`, `/api/script`, `/api/publish-package`, `/api/tts`, `/api/generate-image`, `/api/chat` and the NotebookLM routes return the same record as `modelUsage` (shape in `shared/modelUsage.ts`). It is recorded per request with AsyncLocalStorage (`server/llm/usage.ts`). The server strips an incoming `modelUsage` from request bodies, so echoing a research or plan response back never puts it into a prompt or changes a script's resume key.

### The Gemini tier

The Gemini tier uses the `TEXT_MODELS` chain in `server/gemini.ts`, tried best-first:

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

## Known Gemini free-tier limits

These are Gemini's limits specifically. The other providers' free tiers have their own rate limits, which change — check each provider's dashboard rather than trusting a number written here.

| Capability | Free tier | Notes |
|---|---|---|
| Text generation | Works | Occasional `503` on 3.x Flash; the chain handles it |
| TTS | Works | `gemini-3.1-flash-tts-preview`. Free of charge, but its request quota is unmeasured — one call per scene is ~51 calls for a 585 s script. Check `aistudio.google.com/rate-limit`. |
| **Gemini image generation** | **Blocked** | `limit: 0` on `generate_content_free_tier_requests` for every image model — not a rate limit, no quota exists. Needs billing. |
| **Google Search grounding** | **Blocked** | 429 immediately. Needs billing, and not planned even then — see [Research is real, within limits](#research-is-real-within-limits). |

**Images and video come from Hugging Face Spaces (2026-09-26).** `/api/generate-image` walks `IMAGE_PROVIDER_ORDER` (default: Qwen-Image-2512, Apache 2.0, then HiDream-O1-Image, MIT) and `/api/generate-video` walks `VIDEO_PROVIDER_ORDER` (default: MiniMax-H3 Turbo, then Wan 2.2), calling each Space's Gradio API with your `HF_TOKEN`. The order was picked from the Artificial Analysis arenas among licences that allow a monetised channel; the higher-ranked Qwen-Image-2.1, Ideogram 4 and FLUX.2 [dev] are non-commercial. Nothing outside the list is tried, so Gemini's image models (Nano Banana Pro needs billing on this key) and Pollinations are opt-in entries. A Space out of GPU quota, asleep or changed is skipped for a while and the next one is tried; a strict caller gets 429 / 503 / 502. The response's `provider` (`'hf' | 'gemini' | 'pollinations' | 'placeholder'`) and `model` (the Space id) say what drew it. For Nano Banana Pro by hand, each scene has a **Nano Banana Pro prompt** button, and the exported brief carries the same prompt. **Licence note:** MiniMax-H3 clips need a "MiniMax H3" credit in the video description. Their built-in soundtrack is poor: mute it in the edit.

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
npm test         # 318 unit tests — no network, no quota (pinned to LLM_PROVIDER_ORDER=gemini)
npm run test:e2e # real server vs a stub Gemini + Pollinations + Hugging Face Spaces: 429, overload, crash-resume, SSRF, strict TTS/image/video, two-voice speakers (~1 min)
npm run render:fixture # stub media through the real assembler -> renders/ (needs ffmpeg)
npm run llm:check # live check of every configured provider: key, model ids, one JSON call
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
  llm/chain.ts                the provider chain: generateJson / generateText, error classification, cooldowns
  llm/providers.ts            provider registry, default model ids, env resolution
  llm/schema.ts               Gemini schema -> JSON Schema, and the local validator
  llm/usage.ts                per-request record of which model answered each call (modelUsage)
  modelLineup.ts              GET /api/models: the configured models per kind of generation, in order
  gemini.ts                   Gemini client, TEXT_MODELS chain, quota-aware generateGeminiJson (the chain's last tier)
  quota.ts                    classifies Gemini errors (per-minute / per-day / limit: 0 / overload) and reduces failures across providers
  strict.ts                   strict-mode status mapping (X-ContentPipe-Strict)
  assemble.ts                 scene stills + narration -> MP4 via local ffmpeg; refuses placeholders and fallback audio
  captions.ts                 verbatim English SRT, timed across each scene's real speech window
  stubMedia.ts                stand-in TTS/image output for the assembler's tests and fixture render (never wired to an endpoint)
  scriptPipeline.ts           the three script passes and chunking
  runJournal.ts               on-disk checkpoints (.runs/) for /api/script
  sourceArchive.ts            keeps the text the model actually saw (.runs/sources-*.json)
  researchCoverage.ts         counts how much of a dossier is genuinely cited
  timeline.ts                 timeline, chapters, mid-rolls, retention/compliance audit
  publishPackage.ts           titles / thumbnails / description / tags + linters
  netGuard.ts                 SSRF guard for fetched URLs
  hnThread.ts                 Hacker News discussion as a retrievable source (Algolia API)
  schemas.ts                  response schemas (Gemini format; converted to JSON Schema for the other providers)
  sourceFetcher.ts            URL fetching, HTML-to-text extraction, and the (hn-api) -> direct -> jina -> wayback rescue ladder
  imageProviders.ts           Scene image chain in IMAGE_PROVIDER_ORDER (HF Spaces by default) -> SVG placeholder (UI only)
  videoProviders.ts           Image-to-video chain in VIDEO_PROVIDER_ORDER; clips saved to renders/clips/, served at /clips/
  mediaOrder.ts, hfSpace.ts, spaceAdapters.ts   provider order + cooldowns; Gradio HTTP client; per-Space call shapes
  markdownExporter.ts         Brief rendering + file writing
  fallbackGenerators.ts       Canned output when the API is unreachable
  notebooklmService.ts        Multi-voice podcast audio
shared/
  brand.ts                    DEFAULT_CHANNEL_BRAND — imported by both server/ and src/
  speakers.ts                 narrator / analyst placement (every 6th scene except the last) — imported by both server/ and src/
  modelUsage.ts               the modelUsage shape, and withoutModelUsage (strips it from echoed inputs)
  modelCatalog.ts             per-model details for the UI: maker, intelligence score, cost, live notes
src/
  App.tsx                     Stage orchestration
  components/                 One component per pipeline stage
  types.ts                    Shared types — mirrors server/schemas.ts
  utils/googleWorkspace.ts    Firebase Auth + Docs/Sheets export
exports/                      Generated briefs (gitignored)
.runs/                        Script-run checkpoints and source archives (gitignored, pruned after 7 days)
e2e/                          End-to-end failure-contract test (npm run test:e2e)
scripts/                      render-fixture.ts (npm run render:fixture), llm-check.ts (npm run llm:check),
                              tts-bakeoff/ (TTS engine comparison + blind listening set — see its README)
renders/                      Assembled videos and captions (gitignored)
```

`src/types.ts` and `server/schemas.ts` describe the same shapes in two languages. **Change both together** or the schema will quietly stop matching what the UI reads.

---

## Troubleshooting

**Everything reads like canned content about an XZ backdoor.** You're getting `generateFallbackGenerators` output. Check `isQuotaFallback` in the response, then check the `[LLM Chain]` line at startup: it must list at least one provider, so a key is set *and* the server was restarted after setting it. Then run `npm run llm:check`.

**A provider is configured but never answers.** Look for `[LLM Chain] <provider>/<model> -> ...` warnings in the server log. `zero` or HTTP 401/402/403 means a bad key or no balance, and that provider is then skipped for 30 minutes — fix it and restart. HTTP 404, or a 400 saying the model doesn't exist, means a stale model id: that model is skipped for 30 minutes, `npm run llm:check` lists the live ones, and `<ID>_MODELS` overrides the default. HTTP 413 means the request is too large for that model's limit (Groq's free tier counts the output cap against tokens-per-minute) — lower `<ID>_MAX_TOKENS`.

**A non-Gemini provider keeps falling through with "answer rejected".** Its output broke the schema twice. The log names the violations. Small schemas help both the model and the validator — see [Script generation runs in four passes](#script-generation-runs-in-four-passes).

**`EADDRINUSE: 0.0.0.0:3000`.** Something else owns the port — Grafana is a common culprit. Use `PORT=3100 npm run dev`.

**Scenes missing `visual` or `motion`.** A pass returned incomplete output. Check `generation.degraded` in the response, then the server log for `[Art Director]` and `[Production Bible]` lines. Don't fix it by merging schemas.

**A script shorter than requested.** Check `generation` — it says how many scenes were produced and which chunk failed. Send the same request again after the quota resets and it resumes from the last finished chunk.

**`Blocked: … private or reserved address` on a source.** The SSRF guard refused an internal/loopback URL, by design.

**A source failed with `Response is a PDF, which cannot be decoded as text here`.** Working as intended — the direct rung refuses binary rather than passing mojibake off as an article. Check `attempts` on that source: the reader-proxy rung usually extracts the PDF on the next try. If every rung failed, no text was retrieved and the dossier genuinely has nothing from that URL.

**The dossier is thin and `researchGaps` is full.** The sources didn't support more. That's the honest answer, not a bug — `researchGaps` names what would fill it. Check `researchCoverage.uncitedFacts` too: those are claims the script will carry on trust.

**Everything in the brief says `Published: not stated`.** The pages carry no publication metadata. Nothing is inferred from the fetch time, so date-sensitive framing ("this week", "newly disclosed") needs checking by hand before publishing.

**`auth/unauthorized-domain`.** See [Google Workspace export](#google-workspace-export-optional).
