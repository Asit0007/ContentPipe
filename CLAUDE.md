# CLAUDE.md

Guidance for Claude Code when working in this repository.

Read `README.md` first for setup and the pipeline overview. This file covers what isn't obvious from the code and what has already been tried and rejected.

---

## What this is

A news story plus its source links go in; a production-ready video brief comes out — researched dossier, narrative plan, scene-by-scene script with layered image prompts, motion direction and citations, exported as Markdown to `exports/`.

The owner's stated goal: *feed in a news item and a link to its sources, have the app research it, and produce scripts for the images (character, background, scene) and for animating those images into video.* For a long time the output stopped at **prompts and direction, not rendered video**, by decision. On 2026-09-21 the owner asked for rendering: `server/assemble.ts` now turns scene stills + narration into an MP4 (Ken Burns-style zoom, sidecar captions). On 2026-09-26 the owner asked for image-to-video too: `/api/generate-video` animates a scene still through Hugging Face Spaces (see "Images and video: Hugging Face Spaces"). Still not built: a CyberPipe stage for it, or an endpoint around the assembler — don't, unless asked.

The automated caller is **CyberPipe** (`../CyberPipe`, its own repo): a Python job orchestrator that calls `/api/research`, `/api/plan`, `/api/script` in strict mode and adds durable jobs, scheduled retries and a Telegram approval. It reimplements none of the generation, and this repo has no notion of jobs — keep it that way; see the table in `README.md` ("Who calls it").

---

## Architecture

Single Express app (`server.ts`) that also serves the Vite/React front end in middleware mode. One process, one port. No routing library, no database — state lives in the browser, `exports/` (briefs), `.runs/` (script checkpoints and source archives) and `renders/` (MP4s + captions), all gitignored.

```
/api/research  → fetches source URLs, extracts text, builds a cited dossier
/api/plan      → narrative beats
/api/script    → four passes: production bible → narrative → art direction → sound & edit (checkpointed, resumable)
/api/publish-package → titles, thumbnails, description, tags (model writes copy; the checkable parts are deterministic)
/api/tts       → narration audio
/api/generate-image → scene stills (Hugging Face Spaces in IMAGE_PROVIDER_ORDER, then an SVG placeholder for the UI only)
/api/generate-video → scene still + motionPrompt → short clip (Spaces in VIDEO_PROVIDER_ORDER), saved to renders/clips/, served at /clips/
/api/export/markdown → writes the brief to exports/
/api/chat, /api/ip-names, /api/notebooklm-* → side features
```

Where things live (`server.ts` is routes and wiring only — the logic moved out so it can be unit-tested; `server.ts` calls `startServer()` at import and cannot be imported by a test):

| File | Owns |
|---|---|
| `server/llm/chain.ts` | the provider chain — `generateJson` / `generateText`, per-provider error classification, cooldowns, the JSON repair round. **Call this, not `generateGeminiJson`, for text.** See "LLM provider chain" below |
| `server/llm/providers.ts`, `server/llm/schema.ts` | provider registry + env resolution; Gemini schema → JSON Schema and the local validator |
| `server/gemini.ts` | Gemini client, `TEXT_MODELS` chain, `generateGeminiJson` (quota-aware: cooldowns, one bounded retry pass) — now the chain's last tier |
| `server/quota.ts` | classifies Gemini errors; typed `QuotaExhaustedError` / `UpstreamUnavailableError`; `summarizeQuotaFailures` reduces failures across providers |
| `server/strict.ts` | the strict-mode contract (`X-ContentPipe-Strict`) and `orFallback` |
| `server/scriptPipeline.ts` | the first three script passes, chunk sizes, `buildGenerationSummary` |
| `server/soundPipeline.ts`, `shared/sound.ts` | the fourth pass: music plan, sound effects, silences, transitions, and the closed transition list — see "Sound & edit pass" below |
| `server/runJournal.ts` | on-disk checkpoints in `.runs/` |
| `server/timeline.ts` | deterministic timeline, chapters, mid-roll placement, retention/compliance audit |
| `server/publishPackage.ts` | titles / thumbnails / description / tags and their linters |
| `server/sourceFetcher.ts`, `hnThread.ts`, `netGuard.ts`, `htmlText.ts` | fetching, the HN thread rung, the SSRF guard |
| `server/mediaOrder.ts`, `server/hfSpace.ts`, `server/spaceAdapters.ts` | image/video provider order and Space cooldowns; the Gradio HTTP client (upload, two-step call, event stream, error classification); how each Space is called. See "Images and video" below |
| `server/imageProviders.ts`, `server/videoProviders.ts` | the two media chains; `shared/nanoBananaPrompt.ts` builds the paste-by-hand Nano Banana Pro prompt |
| `shared/topicProfile.ts`, `shared/tone.ts` | resolve the topic domain (cybersecurity default vs. any other subject) and the documentary/infotainment tone axis — see "Conventions" below |

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

A second, harder failure mode on the same root cause: it's not just about field *breadth*, array *length* has its own ceiling, and this one is a hard `400` rather than a silent omission. `scriptSceneItemSchema` (the narrative pass's per-scene shape, which includes `infographic` — three more nested arrays-of-objects on top of `visual`/`motion`) gets an immediate `400 INVALID_ARGUMENT` from every model in `TEXT_MODELS` the instant a wrapping array's `maxItems` reaches 4 — measured live 2026-09-19, reproducible regardless of `minItems` or whether `min === max`, confirmed even against the schema exactly as it shipped before long-form chunking existed (it was always there, just never exercised past 6 items). Removing just `infographic` let `maxItems: 6` succeed again. This is why `/api/script`'s narrative pass generates scenes 3 at a time (`NARRATIVE_SCENES_PER_CHUNK` in `server/scriptPipeline.ts`) while the art-direction pass, whose schema lacks `infographic`, stays at 6 (`VISUAL_DIRECTION_SCENES_PER_CHUNK`). Don't raise either without retesting live first.

`publishPackageSchema` (two arrays of shallow objects plus string arrays — deliberately flat) was confirmed accepted live 2026-09-19. Keep it flat; anything the model doesn't have to write (chapters, mid-rolls, sources, the recommendation) is computed in code instead of added to it.

### Grounding and structured output are mutually exclusive

`tools: [{google_search: {}}]` cannot be combined with `responseMimeType: 'application/json'` + `responseSchema`. If grounding is ever enabled it needs two calls: grounded free-form generation, then a structuring pass. Currently moot — see quota below.

### Free tier has hard zeroes, not just rate limits

| Capability | Status |
|---|---|
| Text | works (transient 503s on 3.x Flash; the chain absorbs them) |
| TTS | works |
| Gemini image generation | **`limit: 0`** — no quota exists at all |
| Google Search grounding | **429 immediately** |

A 429 saying `limit: 0` is not something to retry or work around on the Gemini side; it needs billing. Don't add backoff for it. Nano Banana Pro (`gemini-3-pro-image`) was re-probed 2026-09-26: still `limit: 0`. Images now come from Hugging Face Spaces instead (see "Images and video"); Gemini and Pollinations are opt-in entries in `IMAGE_PROVIDER_ORDER`. Grounding stays genuinely unaddressed and is not planned even with billing: fetching real URLs and disclosing exactly what was read (see the rescue ladder below) already beats grounding's opaque citations, for free.

### Reading a Gemini 429 (captured live 2026-09-19 — fixtures in `server/__fixtures__/`)

`server/quota.ts` encodes all of this; the tests use the real bodies, don't "simplify" it from memory:

- The SDK's `ApiError` has the numeric code on `.status` and the **whole JSON body, stringified, on `.message`**.
- **One 429 lists every violated quota at once** — per-minute *and* per-day `quotaId`s together — beside a `retryDelay` of only a few seconds (4s, 9s, 48s seen). A short `retryDelay` is the per-minute window, not proof that waiting helps. **Any `…PerDay…` violation wins**, and the retry time is the next midnight Pacific (Gemini's reset), not the delay.
- `limit: 0` appears only in the human-readable message text (`* Quota exceeded for metric: …, limit: 0`), not as a structured field. It means no quota exists (free-tier image models, grounding): never retried, and a strict caller gets a non-retryable 502, not a 429.
- Two of the three text models had their daily quota (`limit: 20`) spent by ordinary testing that same day; `gemini-3.1-flash-lite` carried the work. Budget live tests accordingly — `GOOGLE_GEMINI_BASE_URL` points the SDK at a stub so the quota paths can be exercised for free (see Verifying changes).
- A model known to be exhausted is skipped for its retry time (capped at 30 min so enabling billing takes effect); a chain that fails on quota/overload waits once (≤45 s per-minute delay, 8 s overload) and retries the chain once.

### The fetch rescue ladder, and its two live gotchas

`server/sourceFetcher.ts` doesn't give up after one failed fetch. It escalates: direct → [r.jina.ai](https://r.jina.ai) reader proxy → Wayback Machine snapshot, stopping at first success. Whichever rung wins is recorded as `via` and disclosed everywhere a source is shown (prompt, UI, exported brief) — a rescued source must never look like an ordinary live read.

There is a fourth rung ahead of the others for one URL shape: `news.ycombinator.com/item?id=N` is read through the HN Algolia API (`via: 'hn-api'`) — real comments, real handles. Every hop of every rung, including redirect targets, goes through `server/netGuard.ts` (loopback / RFC1918 / link-local-metadata / CGNAT / ULA / v4-mapped are refused; ports 80/443 only); a blocked URL fails the whole ladder up front so it is never handed to r.jina.ai or archive.org. Residual DNS-rebinding risk is documented in `netGuard.ts`.

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

**The UI palette is the persona palette, defined once in `src/index.css` (2026-09-26).** Its `@theme` block redefines the Tailwind scales the components already use — zinc → warm neutrals, orange/amber → ember (`orange-500` = `#c84b11`, so white text on a button passes AA; `orange-400` = `#e0602a` for accent text), emerald → signal, cyan/sky/blue/indigo → neutral "wire", rose/red → a warm error red. Keep writing ordinary Tailwind classes; don't add hex values or new colour families in components. **No gradients, glow orbs or coloured shadows** (the Playbook's rule, see `../Blogs/BRAND.md`); the two black image scrims over video (`VideoStudio`, `ScriptEditor`) are the only gradients left, for caption legibility. Fonts are DM Sans / DM Serif Display (stage headlines, `font-serif font-normal` — it has one weight) / JetBrains Mono.

**`npm run dev` does not reload the server.** `tsx server.ts` has no watch mode, while Vite hot-reloads the UI, so after pulling a commit that adds a route the page can call a route the running server doesn't have and get `index.html` back (this is how "Could not load the model list … `<!doctype`" happened, 2026-09-26). Restart after server changes. Vite's HMR websocket is bound to `127.0.0.1` (`vite.config.ts`; it listened on every interface, `*:24678`, until 2026-09-26). Vite's watcher ignores `scripts/` (the ~12k-file TTS bake-off env held the idle server at 80-97 % CPU), `.runs/`, `renders/`, `exports/`, `dist/`, `e2e/`.

**The default channel brand lives in `shared/brand.ts` (`DEFAULT_CHANNEL_BRAND`, "Blast Radius").** Server prompts, the canned fallback script, and the UI's watermark / export headers all fall back to it when no `channelBrandName` is supplied — never hard-code a show name (the old fallbacks said "The Orange Thread", i.e. another site's colour, and a video's on-screen default said "HACKER NEWS BREAKDOWN"). It is imported by both `server/` and `src/`, so keep it dependency-free. The UI starts with **no** preset IP (`activeIp = null`), and the IP-brainstorming gallery, `/api/ip-names` and the chatbot now lead with the default brand instead of another publication's.

**`server/brand.test.ts` is the guard.** It renders every canned fallback surface — plan, research, IP roster, podcast, chat replies, script, and the placeholder infographic SVG — and fails on any mention of a tool name or another publication. The one allowed exception is the dossier's "No Hacker News discussion was retrieved" sentence, which names the API it did *not* get data from. Hacker News is still a first-class **source** (`server/hnThread.ts`, `via: 'hn-api'`, the sentiment panel): naming it where it labels retrieved data is provenance, naming it anywhere else is a brand leak.

**The `visualType` fill-in stays `'cyberpunk'`** in `server.ts`. `'terminal'`, `'diagram'` and `'headline'` are what the evidence-mix audit counts as real evidence, so defaulting a *missing* field to one of them would make a slideshow of AI stills score as sourced footage.

**`src/types.ts` and `server/schemas.ts` are two descriptions of the same shapes.** Change both together. The schema constrains what the model emits; the types describe what the UI reads. Drift is silent.

**New optional scene fields must stay optional in `src/types.ts`** (`visual?`, `motion?`, `citations?`). Scenes generated before a pass existed, or when a pass fails, won't have them, and every consumer must tolerate that. `visualPrompt` is the always-present fallback.

**Prompts carry an inline JSON example alongside `responseSchema`.** When they disagree the model follows the inline example — this caused `visual`/`motion` to go missing even with a correct schema. Update both, or delete the example.

**Fallback generators are load-bearing — for the UI.** Every AI endpoint degrades to `server/fallbackGenerators.ts` rather than erroring, so the browser always has something to render. Keep that property; make failures visible in the *output* (`isQuotaFallback`, `generation`, source status tables) instead of throwing. **Automated callers opt out** with `X-ContentPipe-Strict: 1` and never receive fallback content — see the next section.

**Source honesty is a product requirement.** `/api/research` used to regex-scrape a URL out of the input — or hardcode `news.ycombinator.com` — and present it as a source it had consulted. It hadn't. Never present unread URLs as sources. `retrievedSources` records what was actually fetched, failures included, and the exported brief warns when nothing was read.

That includes **people**: the research prompt used to ask for "authentic-sounding" Hacker News comments with a handle and karma while no HN data was ever fetched — every commenter was invented, shown in the UI and quoted into scripts. Community reaction now comes only from a retrieved HN thread (`hn-api`); otherwise `hnCommunitySentiment` says none was retrieved and `topHnComments` is `[]`. The HN API gives comments no points and returns them chronologically, so `karma` is optional everywhere and they are never called "top" comments. Likewise `viralityScore` was a hardcoded 96 — removed; `qualityChecks` replaces it.

Source ids: `S#` is a source's position in the **fetched** list (`sourceId()` in `sourceFetcher.ts`), used for both `retrievedSources` and the prompt. Numbering only the usable subset used to make `[S1]` point at a different document than `retrievedSources[S1]` whenever an earlier fetch had failed. Fetched text is wrapped in `<source>` tags and declared untrusted in the prompt (for a security channel the sources are often attacker-authored); the tag names inside page text are escaped so a page can't close the wrapper.

**Topic domain is a resolved profile, not a scattered `isDocumentary`-style flag (2026-09-23).** Every prompt used to hardcode "cybersecurity" as the subject regardless of what story was submitted — persona, audience, inline JSON examples, visual-cliché rules, ~30 distinct locations across `server.ts`, `server/scriptPipeline.ts` and `server/publishPackage.ts`. `shared/topicProfile.ts` (`resolveTopicProfile(topicDomain?: string)`) is now the single place that resolves this. Omitted, or the literal `DEFAULT_TOPIC_DOMAIN` ("hacking and cybersecurity news"), returns `DEFAULT_PROFILE` — every field copied byte-for-byte from what used to be inline, so Blast Radius and CyberPipe's existing calls are unaffected. **`server/topicProfile.test.ts` pins this against an independently hand-copied expected object** — that test, not a read of the source, is what catches a future edit accidentally reworking the default wording. Any other free-text value returns a generic profile templated on it (curiosity-gap hooks, audience-calibrated jargon translation, grounded-specifics discipline, a universal AI-slop visual-cliché blocklist instead of the hacker-specific one). The tone axis (documentary vs. infotainment — *how* a story is told) is orthogonal and unchanged; it now lives in `shared/tone.ts` (`isDocumentaryTone`) instead of being re-derived four times with two different comparison strategies (a regex in `/api/plan`, an exact match everywhere else — unified onto the regex, a strict superset since `planSchema.tone`'s closed enum always matches both).

Two things were deliberately left untouched rather than generalized: **`server/timeline.ts`** (its CVE/CVSS-specific `SEVERITY_RATING_RE` and the `terminal`/`diagram`/`headline` evidence-mix check are harmless no-ops on a non-cyber script, and this file is the most fragility-documented one in the repo — not worth the risk for no behavioral gain), and **`server/fallbackGenerators.ts`** (1119 lines, the canned-content path used only when every LLM provider is down — UI-only, CyberPipe's strict mode never sees it, so a non-default `topicDomain` under total provider outage still gets the cyber-flavored fallback, correctly flagged `isQuotaFallback` as always).

---

## LLM provider chain (`server/llm/`)

Text generation is no longer Gemini-only. `generateJson` / `generateText` (`server/llm/chain.ts`) walk `LLM_PROVIDER_ORDER` — default **DeepSeek → Grok (xAI) → Groq → Cerebras → OpenRouter (free) → Ollama Cloud → Mistral → Gemini** — and return the first usable answer. A provider with no API key is skipped; with none configured the chain is Gemini alone, byte-for-byte the old behaviour. Registry, default model ids and token caps: `server/llm/providers.ts`. Adding a provider is one entry there (anything OpenAI-compatible); `<ID>_BASE_URL` redirects one (proxy, self-hosted, test stub).

**Model-by-model order (`LLM_MODEL_ORDER`, 2026-09-24).** The owner's rule is *highest intelligence first*, and the smartest free models sit on different providers, so ordering whole providers cannot honour it (it would try Groq's gpt-oss-120b, score 12, before OpenRouter's GLM-5.2, score 34, whenever Groq's Qwen failed). `LLM_MODEL_ORDER=gemini:gemini-3.7-flash,groq:qwen/qwen3.8-27b,openrouter:z-ai/glm-5.2:free,…` is one ranking across providers: the provider is what precedes the **first** colon (model ids contain slashes and colons), the same provider may recur further down, and it replaces `LLM_PROVIDER_ORDER` and every `<ID>_MODELS`. Unset, nothing changes. `buildTiers` makes one tier per run of consecutive same-provider entries; `npm run llm:check` verifies exactly the ids named. **A Gemini tier that is not last fails over at once** (`retryPass: false` in `server/gemini.ts`); only a Gemini tier at the very end keeps its one 8 s wait-and-retry, because split into several tiers each would otherwise wait separately. The order in `.env` was ranked by the Artificial Analysis Intelligence Index on 2026-09-24 (free models only; paid DeepSeek/Kimi/GLM-5.3 were left out on purpose). Scores are for specific reasoning settings, not measured in this pipeline, and two of them are single-source — re-rank when models change.
- **Ollama Cloud** (`https://ollama.com/v1`, key `OLLAMA_API_KEY`; the misspelt `OLAMA_API_KEY` is also read). Its free usage covers only `nemotron-3-ultra`, `nemotron-3-super`, `gpt-oss:120b/20b`, `gemma4:31b` and `nemotron-3-nano:30b`; every DeepSeek, Kimi, GLM 5.x, Qwen 397B, MiniMax and Mistral Large 3 model answers **402 "add usage credits"**. `nemotron-3-ultra` answers a tiny request in 8 s but timed out (>120 s) on real research and plan prompts.
- **Free OpenRouter models are flaky:** rate-limited or overloaded upstream most of the time, `inkling:free` returns 403 ("only available on agentic harnesses"), `ling-3.0-flash-fin:free` rejects JSON mode. Fallbacks, not workhorses.
- **Groq's free tier is 8,000 tokens/minute** (`x-ratelimit-limit-tokens`), so the ~10k-token research prompt gets a 413 while the plan and script prompts fit. `qwen/qwen3.8-27b` is also capped at **1,000 output tokens/minute** (OTPM): a ~1k-token plan just fits (2.4 s), a 1.3-2.3k-token script chunk does not, and answers 429 "try again in 3.5s" (`per_minute`). That 429's upgrade link contains the word "billing", which the `NO_BALANCE` pattern used to match, classifying a 3.5 s limit as out of credits and benching all of Groq for 30 min (fixed: only "billing details" counts). Groq's User-Agent check also blocks Python's default urllib (empty 403) — probe with curl.
- **Live result, 2026-09-24:** with the fixes above, a plan that took 144 s (Ultra timeout, Groq wrongly benched) took 3.9 s (Gemini 503 → instant fail-over → Groq Qwen). The smartest models were often unavailable, though: over a full script run Gemma 4 31B (score 19) wrote 5 of 7 calls because Gemini 3.7 Flash returned 503 every time, GLM-5.2 and Qwen (free) were rate-limited and Nemotron 3 Ultra timed out.

- **Cost:** DeepSeek and Grok are pay-per-token; Groq / Cerebras / OpenRouter `:free` / Mistral have free tiers. Mistral's free tier trains on prompts, so it sits behind the ones that don't.
- **Not covered:** TTS and images stay on Gemini / Pollinations (`/api/tts`, `/api/generate-image`) — none of the chat providers do either. `notebooklmService.ts` still calls Gemini directly.
- **Gemini's schema-constrained decoding does not exist elsewhere.** The other providers get `response_format: json_object` plus the schema (converted by `server/llm/schema.ts`) written into the system prompt, and the answer is validated locally — required keys, types, enums, `minItems`/`maxItems`. A violation gets ONE repair round (the rejection is fed back), then the next provider. `finish_reason: length` counts as a failure, never a result. The three small-schema passes in `/api/script` stay as they are: they exist for Gemini's schema limits, but small schemas also make the validator's job and the repair round cheap.
- **Errors keep the strict contract.** Each provider's failure is classified (`classifyProviderError`: 402 / "insufficient balance" → `zero`, 429 + `Retry-After` or "try again in 7m12s" → per-minute / per-day, 5xx + timeouts → transient, 401/400 → `other`) and the chain reduces them exactly like a Gemini chain: quota dominates and reports the **earliest** retry across providers, so one provider recovering in 20 s beats Gemini's daily reset. Strict callers therefore still see 429 / 503 / 502 + `Retry-After`.
- **Cooldowns are in-process.** A provider that answered 402/401/403 is skipped for 30 min (restart the server after fixing a key); a missing model (404, or 400/422 matching `MODEL_MISSING`) for 30 min; a 413 for 10 min, **but only for requests at least as large as the one that got it** (the entry keeps that size; a smaller request is still tried, and a smaller 413 lowers the bar — Groq's 413 on the research prompt used to bench its Qwen for the plan prompt that fits); a 429 for its `Retry-After`, capped at 30 min — but the entry keeps the provider's real `retryAt`, so a request that finds it cooling reports the real reset, not the shorter skip; a **timeout for 10 min** (the model is slow for our prompts, not down — it used to earn only the 30 s of a 5xx and cost 120 s per request); a 5xx for 30 s. When every model is skipped for a non-retryable reason, the thrown error carries the original failure ("skipped while cooling down after: ...").
- **A per-day 429 with no reset hint waits until 00:00 UTC, floor 1 h** (`classifyProviderError`, fixed 2026-09-21). It used to default to 60 s, so when every provider was out, strict mode answered `Retry-After: 60` for a spent daily quota and CyberPipe re-polled (and paged Telegram) every minute. Explicit hints still win: `Retry-After`, "try again in 7m12s", OpenRouter's `X-RateLimit-Reset` in the body.
- **Tests and e2e pin the chain to Gemini** (`LLM_PROVIDER_ORDER=gemini` **and an empty `LLM_MODEL_ORDER`** in `npm test` and in the e2e spawn env) so a real key in `.env` or the shell can never make a "no network" suite spend money. The second half matters: `LLM_MODEL_ORDER` replaces `LLM_PROVIDER_ORDER`, and the e2e server loads `.env`, so a ranked list there once silently un-pinned the suite (4 e2e failures, one 137 s, calls to real providers). dotenv does not override a variable that is already set, even to the empty string.
- **Model ids drift and the defaults are best guesses** — `npm run llm:check` lists each provider's live `/models`, flags any configured id that isn't there, and makes one tiny JSON call per provider. Run it after adding a key and before trusting the chain.
- **Privacy:** every prompt now goes to whichever provider answers. DeepSeek's API is hosted in China. Fine for public-news scripts; `JobPipe` has its own Gemini client (`src/jobpipe/llm.py`) and is not on this chain — résumé data is a separate privacy decision.

## Model provenance: which model wrote what (2026-09-25)

Every page of the UI has an **"AI models on this page"** panel (`src/components/ModelsPanel.tsx`) with two parts: the models the page is configured to try, in order (`GET /api/models`, built by `server/modelLineup.ts` from the same `buildTiers` the chain uses, so it can't drift), and the model that actually produced each part of what's on screen.

- **Recording.** `server/llm/usage.ts` uses AsyncLocalStorage. Middleware in `server.ts` opens a recording per `/api` request; `trackModelCall` wraps each `generateJson` / `generateText` / TTS / image call; `noteModelAttempt` logs every model tried: the winner, and every failed or skipped one with the reason and tokens. `withModelTask` labels calls ("Narrative, scenes 4-6 (chunk 2/4)"). Research, plan, script, publish-package, tts, generate-image, chat and both NotebookLM routes return it as `modelUsage` (shape: `shared/modelUsage.ts`).
- **Never in a prompt.** Research and plan bodies echo back into later requests, and the plan and script prompts `JSON.stringify` them. The middleware strips a top-level `modelUsage` from every body field, except on `/api/export/markdown`, so prompts and `/api/script` resume hashes are unchanged.
- **Resume.** The run journal persists the calls with each checkpoint. A resumed run reports its earlier calls first, marked `fromCheckpoint` (e2e "CRASH" asserts this).
- **Details** (maker, intelligence score, cost, live notes) live in `shared/modelCatalog.ts`. They are dated evidence; update them when you re-rank `LLM_MODEL_ORDER`. A model missing from it still shows up, just without details.
- Per-scene TTS/image calls are kept in memory per page (`src/utils/modelUsageLog.ts`), and the scene stores `imageModel` / `audioModel`.
- Fixed along the way: chat's `via` always credited the first Gemini model in its list; its canned reply claimed a model (`gemini-local-strategist`); and the footer named Gemini 3.1 Pro and Pro Image, which this free key cannot call.

## Images and video: Hugging Face Spaces (2026-09-26)

The owner's call: images and image-to-video from Hugging Face, Nano Banana Pro by hand (its API has no free quota on this key). The order is `.env` config, not code, because Spaces change and "switch to the next model" should be one line:

```
IMAGE_PROVIDER_ORDER=hf:Qwen/Qwen-Image-2512,hf:HiDream-ai/HiDream-O1-Image          (the default)
VIDEO_PROVIDER_ORDER=hf:MiniMaxAI/MiniMax-H3-Turbo-Lora,hf:zerogpu-aoti/wan2-2-fp8da-aoti-faster
```

- **How the defaults were chosen: best first on the Artificial Analysis arenas, commercial licences only** (Blast Radius is meant to be monetised). Images: Qwen-Image-2.1 (#1 open weights), Ideogram 4 and FLUX.2 [dev] rank higher but are **non-commercial**, so Qwen-Image-2512 (Apache 2.0), then HiDream-O1-Image (MIT). Video: MiniMax-H3 (image-to-video Elo 1357 without audio / 1181 with) far above Wan 2.2 (off the current board; Wan 2.6 is 889). The Space runs MiniMax-H3 with a 6-step turbo LoRA, so it is weaker than the arena score. **MiniMax H3 Community License: commercial use under $20M/yr, and "MiniMax H3" must be credited** (video description).
- **Official Spaces only.** The two Spaces in the owner's screenshot were copies: `observantdistressed/wan2-2-i2v-v3` ships dozens of explicit-content LoRAs with `auto_lora_enabled: true` by default (it adds them based on the prompt), and `Pepe104/MiniMax-H3-Turbo-Lora-UNCENSORED` is an uncensored fork. Never put either in the order.
- **The token only goes to trusted owners** (`tokenAllowedFor`, `DEFAULT_TOKEN_SPACE_OWNERS` in `server/mediaOrder.ts`: Qwen, HiDream-ai, MiniMaxAI, zerogpu-aoti, Wan-AI, black-forest-labs, Lightricks, Tongyi-MAI; `HF_TOKEN_SPACE_OWNERS` overrides). A Space is someone else's code and could read the header. Other Spaces are still called, anonymously. Space ids matching nsfw/uncensored/porn/etc. are refused from the order outright. Each Space's `agents.md` (e.g. `huggingface.co/spaces/<id>/agents.md`) is Hugging Face's generated API note and says "Auth: Bearer $HF_TOKEN" for every Space, trusted or not — don't follow it for third-party Spaces.
- **Nothing outside the list is tried.** Gemini image models (`gemini:gemini-3-pro-image`, once billing is on) and `pollinations` are opt-in entries; video takes `hf:` only. There is no fallback clip at all. The SVG placeholder still reaches the UI when every image entry fails, flagged, and never a strict caller.
- **Protocol** (`server/hfSpace.ts`, no `@gradio/client`): `POST /gradio_api/upload` for the still, `POST /gradio_api/call/<endpoint>` → `event_id`, then `GET` the event stream until `complete` or `error`; output files are downloaded **only from the Space's own origin**. The token goes in `x-hf-authorization`, as gradio_client sends it, so ZeroGPU bills it to the account. Host from `https://huggingface.co/api/spaces/<id>/host`; `HF_SPACE_BASE_URL` replaces it (the e2e stub).
- **Errors** are classified like providers': "exceeded your ZeroGPU quota … Try again in 23:59:09" → quota with that wait (≥1 h is `per_day`); asleep/busy/no GPU/5xx → transient; a missing endpoint (the Space's API changed), a content-filter refusal, a bad id → other. Newer Gradio wraps the message as `{"error": "'…'", "visible": true}` (captured live, fixture in `server/hfSpace.test.ts`). A **null** error (the Space hides messages) is explicitly transient — an earlier wording of that message contained "GPU limit" and got classified as a daily quota by our own regex. A failed Space is skipped in-process: quota until its reset (≤30 min), transient 2 min, other 30 min.
- **Adapters** (`server/spaceAdapters.ts`) hold each Space's positional inputs, read from its `/gradio_api/info` and `app.py` on 2026-09-26. Prompt rewriting is **off** on every Space (Qwen `prompt_enhance`, HiDream refine, MiniMax `upsample`): a rewrite would drift from the enforced character and style anchors. Duration is clamped to each Space (MiniMax 2-14 s, Wan 1-5 s) and the response reports the clamped value. A Space with no adapter goes through `genericAdapter`, which reads its API and fills parameters by name, and refuses (rather than guesses) a parameter with no default it can't name.
- **GPU budget** (HF docs, checked 2026-09-26): unauthenticated 2 min/day, free account 5, PRO 40 (resets 24 h after first use). MiniMax runs on the `xlarge` size (2× quota): one 4 s clip **reserved 146 s**, so ~2 clips/day on a free token. HiDream's Space runs on CPU and forwards to HiDream's own GPUs, so it spends no quota (its hosted-service terms are not checked; the weights are MIT).
- **Live, 2026-09-26.** Without a token: HiDream 60 s → 2560×1440 PNG; Wan 2.2 49 s → 4.06 s 832×480 16 fps clip; Qwen hidden error; MiniMax quota refusal. **With the token (fine-grained, `repo.content.read` only), through the real endpoints:** Qwen-Image-2512 52 s → 1664×928 **WebP** (so `imageSize` reads PNG, WebP and JPEG headers), prompt followed element by element; MiniMax-H3 63 s → 4.46 s 1152×640 24 fps H.264 + AAC soundtrack (mean −22.9 dB), subject and room stable. **Owner's verdict: picture good, audio not good** — clip audio is to be muted in the edit (the sound pass's cue sheet is the soundtrack); don't build anything on MiniMax's audio. The Space re-fit the canvas to the still's shape (asked 960×544).
- **Security (audited 2026-09-26 with gitleaks, redacted):** history and tree clean (hits are the decorative `eyJhbGciOiJS…` fragment in `fallbackGenerators.ts` and the public, restricted Firebase web key in git-ignored files). Every token-bearing request uses `redirect: 'manual'` and refuses 3xx: fetch strips only `Authorization` on a cross-site redirect, so `x-hf-authorization` would have followed one.
- **UI:** each scene has "Nano Banana Pro prompt" (copies `nanoBananaProPrompt`: character anchor first, style anchor last, no negatives and no "no text" — Nano Banana has no negative field and "no X" tends to add X) and, once it has a real still, "Animate clip" (sends `motion.motionPrompt` and `motion.durationSec`). Clips are written to `renders/clips/` and served from `/clips/`, because GPU minutes are the scarce thing. The exported brief carries the Nano Banana Pro prompt per scene.
- **Tests:** `server/hfSpace.test.ts` (protocol against a local server, classification with the live bodies, cooldowns, adapters, generic adapter, sniffing, the Nano Banana prompt); e2e "IMAGE via a Hugging Face Space" and two "VIDEO" tests against a stub Space that answers ok / quota / asleep.

## Failure contract for API clients (strict mode)

Send `X-ContentPipe-Strict: 1` on `/api/research`, `/api/plan`, `/api/script`, `/api/publish-package`, `/api/tts`, `/api/generate-image` and `/api/generate-video`. Without it you get the UI contract (always 200, fallback content flagged `isQuotaFallback`). CyberPipe sends it. With it there is **never** fallback content:

| Status | Meaning | Body |
|---|---|---|
| `429` + `Retry-After` | quota exhausted (`per_minute` \| `per_day`); retry at the given time | `{error, kind, retryable: true, retryAfterSec, runId?, progress?}` |
| `503` + `Retry-After: 30` | upstream overloaded on every tier, after one bounded wait | same shape, `kind: 'upstream_unavailable'` |
| `502` | not retryable: no quota exists (`zero_quota`, needs billing), bad key, rejected request | `{error, kind, retryable: false}` |
| `409` | an identical `/api/script` run is already in flight | `{kind: 'in_progress', runId}` |

Strict mode rethrows *retryable* failures instead of absorbing them into a shorter or flatter script; non-retryable ones (a rejected schema, unparseable output) still degrade — and say so in `generation.degraded`. Every `/api/script` response carries `generation` (`complete`, requested vs produced scenes/duration, `degraded[]`), so a partial script is self-describing in both modes.

**Media endpoints under strict.** `/api/tts` degrades to a synthesized tone and `/api/generate-image` to an SVG placeholder for the UI; a render would publish either as if it were real, so strict callers never get them. TTS classifies every model's error together (`reduceModelErrors` in `server/quota.ts`, the same reduction `generateGeminiJson` applies to text: a daily quota is not masked by the other model's 404) and answers 429/503/502. Images: every listed provider's image is real and returned, labelled (`provider`, `model`); only the placeholder is refused, as 429 (every entry out of quota) or 503 (busy/asleep), with each provider's error in the message. Video has no fallback in either mode: the UI gets a 502 with the reasons. `POLLINATIONS_BASE_URL` overrides the host so the e2e test needs no network.

## Run journal (`.runs/`, gitignored)

A 9-minute script is ~25 sequential LLM calls; on Gemini alone that is against ~20 requests/day per model, so restarting from zero after a quota hit at call 22 never converges (the provider chain eases this once keys exist; the journal still matters). Each finished chunk is written to `.runs/<key>.json` (atomic temp+rename). **A run resumes iff its journal exists, its input hash matches, and it has not been delivered.** The key is `runId` from the body if given, else a hash of plan + research + brand — so an interrupted strict run resumes on the identical re-POST with no client cooperation, while "regenerate" after a delivered script starts fresh. A run that finished while its client was gone is served from the journal without regenerating. `fresh: true` discards. One in-flight run per key (409). Journals older than 7 days are pruned at startup. `CONTENTPIPE_RUNS_DIR` relocates it (the e2e test uses this).

## What the retrieval layer promises about its own sources

Everything here exists because the previous failure mode was not a crash — it was a dossier that
looked fine and was not.

**Binary is never text.** `res.text()` decodes a PDF into mojibake that has no tags, survives
`htmlToText`, clears the 120-character floor, and is then reported as `ok: true, via: 'direct'` — a
clean read. `unreadableAs()` (`server/sourceFetcher.ts`) refuses it by magic bytes, by content-type,
and by the density of replacement/control characters in the decoded text, in that order, because
content-type is often wrong or missing. A refused PDF is **not lost**: the direct rung fails, and
r.jina.ai extracts PDF text properly on the next rung.

**Two different dates, never merged.** `published` is what the page states about itself and is the
only basis for "when"; `retrieved` is just when this tool read the page. A page that states no date
gets `published="not stated by the page"` and the prompt forbids inferring one. A bare
`<time datetime>` is deliberately not read — on an article page it is as likely to be a comment.

**Truncation is disclosed, not silent.** The cap is 40k characters per source (raised from 12k,
which cut most long-form write-ups off mid-article) and is applied in exactly one place,
`fetchSource`, so every rung is capped alike. Whatever still overflows sets `truncated` and says so
in the prompt and the exported brief: the model must not report an absence in a document it only
half read.

**The source text is kept.** `server/sourceArchive.ts` writes the exact text the model saw to
`.runs/sources-<id>.json`, so the question "is this line in the script actually supported?" is
answerable after the fact. It is on disk rather than in the response because six sources at the cap
is ~240 KB that would otherwise ride in every research response, every CyberPipe job row, and every
plan and script body that echoes the dossier back. Same 7-day `pruneOldRuns` sweep as the journals.

**Depth is asked for in the prompt and measured in code.** `keyFacts` has a schema floor of 3 — only
enough to catch a degenerate one-fact response. The real target (`KEY_FACT_TARGET_WITH_SOURCES`, 8)
lives in the prompt, scaled by `targetDurationSec` when the caller supplies one, because a hard
`minItems` on a thin story does not produce research, it produces invention. The prompt's honest way
out is `researchGaps`: name what the script still needs and what would answer it. `measureCoverage`
(`server/researchCoverage.ts`) then counts what is actually cited, server-side, so thin research is
visible in `researchCoverage` rather than silently accepted — a model's own account of its sourcing
would itself need checking.

## Video assembly (`server/assemble.ts`)

Scene stills + narration → one MP4, by spawning the local `ffmpeg` (argument array, no shell). It is a module and a script, **not yet an endpoint or a CyberPipe stage** — nothing calls it with real assets yet.

```bash
npm run render:fixture                 # stub stills + sine-tone "narration" -> renders/fixture-stub-<ts>.mp4, no quota, no network
npm run render:fixture -- --720 | --vertical
```

- **Refuse, don't degrade.** `validateScenes` checks every scene before any encoding and reports *all* problems: a placeholder image, an SVG or non-image body labelled `image/png` (bytes are sniffed, not the label), the synthesized quota-fallback tone (`audioIsFallback`), audio under 0.5 s, non-16-bit-mono WAV, mixed sample rates. One bad scene fails the render with `AssemblyInputError.problems`.
- **Audio is joined once, in Node.** Each scene's PCM is padded with silence to a whole number of frames, everything is concatenated, and muxed with a single AAC encode (`loudnorm` to -14 LUFS) against stream-copied video segments. Per-scene AAC + concat adds encoder delay at every join and drifts. Verified on the 56.5 s fixture: audio and video are both exactly 56.500 s and each scene's silence starts within ~2 ms of the timeline's prediction.
- **The result's `scenes[]` (`startSec`, `audioSec`, `durationSec`, `frames`) is the real timeline.** Feed it to `retimeFromAudio` (`server/timeline.ts`) to replace the model's `durationEst` guesses and recompute chapters, mid-rolls and the audit; it refuses timings that don't match the scenes one-to-one by `id`, and drops `script.publish` (its description embeds the old chapter times — rebuild via `/api/publish-package`).
- **Captions** (`server/captions.ts`): pass each scene's spoken text as `captionText` (all scenes or none — a track with holes is refused) and the render also writes `<name>.en.srt`. Text is captioned verbatim (whitespace and `[S#]` markers cleaned, no word ever dropped — tested), split at sentence/clause boundaries into ≤ 2 lines of ≤ 42 chars, and spread across each scene's real speech window in proportion to how long each cue takes to say. Scene starts are exact; inside a scene it is an estimate with **no forced alignment**. Measured against macOS `say` speech (2026-09-21, 9 inner cue starts): median 0.29 s, worst 0.76 s, every error *early* (a caption appears just before the words, the safe direction). Re-check on real Gemini narration before trusting the constants in `speechWeight`.
- Input shapes are what the endpoints return: `imageUrl` is a `data:` URL, `audioBase64` is raw s16le mono PCM at 24 kHz (the WAV header is parsed if present). Output goes to `renders/` (gitignored; `CONTENTPIPE_RENDERS_DIR` overrides), written under a temp name and copied in only after `ffprobe` confirms one video + one audio stream, the frame size and the duration.
- Cost: 1080p stills with a 6 % push-in/pull-out took **0.29× the video's length** on this Mac (a 9-minute video ≈ 2.6 min). The zoom oversamples 2× to avoid jitter; `zoomOversample: 1` or `zoom: false` is faster.

**Known gaps, all deliberate for now:**
- **Captions are a sidecar SRT, not burned in; `onScreenText` and infographics are not rendered.** This Homebrew ffmpeg has no `drawtext` or `subtitles` filter (no libfreetype/libass — check with `ffmpeg -filters`). Burn-in means `brew install ffmpeg-full` (keg-only, so it does not replace this ffmpeg; pass its path as `ffmpegPath`; 47 dependencies) or a pre-rendered PNG overlay path — a decision, not a bug. Upload the `.en.srt` to YouTube as an English caption track.
- **Nothing generates the per-scene assets.** One `/api/tts` call per scene is ~51 calls for a 585 s script; the free-tier TTS quota has not been measured, and the text tier is ~20/day/model. Assets need to be checkpointed to disk (like `.runs/` does for scripts) so a quota hit resumes instead of restarting.
- `/api/tts` still uses one stock voice and a hardcoded "punchy infotainment" prompt (Tier 4).

## Two voices (`speaker`)

Every scene carries an optional `speaker`: `narrator` or `analyst`. ContentRender (`../ContentRender`) reads the video with two voices — the narrator tells the story, the analyst is a short reaction between narrator sections. Absent means narrator, so older scripts are unaffected.

- **Placed by code, not asked of the model.** `shared/speakers.ts`: every `ANALYST_EVERY`-th scene (6) except the last, so the analyst never opens or closes the video, never speaks twice in a row, and a script of 6 scenes or fewer has none. `generateSceneChunks` assigns it; each narrative chunk's prompt has a `VOICES` block naming the analyst scene numbers *in that chunk* and how to write one. `ANALYST_EVERY` is a starting guess (about one reaction a minute), to be tuned by ear.
- **Why it is not in `server/schemas.ts`:** the narrative pass writes 3 scenes per call and sees only the last 3, so it cannot judge how often the analyst has spoken; the chain's providers differ in how well they'd keep such a rule; and a new schema field runs into the size failure modes above. `speaker` is therefore deliberately absent from the schema (`src/types.ts` says so) and cannot be silently omitted.
- **`server.ts` rebuilds every scene from a fixed field list** after generation. A new scene field that is not added there vanishes from the HTTP response with no error. `e2e/contract.e2e.test.ts` ("TWO VOICES") guards this; it fails if the line is removed.
- **An analyst scene inherits the previous scene's `actPhase`.** Chapters are built from consecutive equal labels, so a label of its own would split the chapter it interrupts.
- **Audit:** `analyst-scene-too-long` warns above 30 words (the prompt asks for 12-25). Invented figures in a reaction are already caught by the dossier check, which covers every scene's narration whoever speaks it.
- **Live check, 2026-09-21** (17 scenes, two analyst scenes, every chunk written by `gemini-3.1-flash-lite` because nothing stronger was reachable): the mechanics work. The prompt's first version produced alarm words ("terrifying", "chilling") and a claim bigger than the dossier; the revised wording produced one measured, practical reaction, and one that read like narration (33 words) beside a narrator scene that spoke as the analyst. That is a sample of two on the weakest model — the voice quality is **not** established. Re-check with a stronger provider, and treat a run's analyst scenes as something to read, not trust.
- **Not done:** the canned fallback script has no analyst (the renderer refuses canned content anyway); the UI does not show `speaker`; `/api/tts` still reads everything with one voice.

## Visual consistency: what's enforced, what isn't

The owner's stated bar (2026-09-22) is that character, background, cut and style consistency across a script is **non-negotiable**. A code review that day found the mechanism real but partial — only `styleAnchor` was enforced in code, three more were only requested in a prompt and could silently drift. As of 2026-09-24 all four are enforced in code, using the same pattern throughout: **ask the model for something, then verify or force it in code inside `applyVisualDirection`** — never trust prose compliance alone.

**Enforced in code, not just asked for:**
- `styleAnchor`. Takes the first non-empty `styleAnchor` produced by *any* art-direction chunk (in scene-number order) and force-overwrites every scene's `styleAnchor` with it (`canonicalAnchor`) — byte-identical across the whole script regardless of what an individual chunk's call returned.
- The flat `visualPrompt` field — the one field every non-layered consumer reads, and what `README.md` calls "the always-present fallback" — is built from `character + background + scene + styleAnchor` (`negative` stays out — separate field, an image API's negative-prompt parameter, never the positive prompt). A `NO_CHARACTERS_SENTINEL` constant keeps the model's "No characters in frame." placeholder out of that concatenation.
- **`promptAnchor` reuse.** `buildVisualDirectionSchema` (`server/schemas.ts`) asks each scene for a new `charactersInFrame: string[]` field (bible character ids actually in frame) alongside `visual`/`motion`/`citations` — deliberately a sibling field there, not added inside the shared `sceneVisualSchema`, which is also embedded in the narrative pass's fragile schema (see "Large response schemas..." above) and would have risked that ceiling for a field the narrative pass doesn't use. `enforcePromptAnchors` (`server/scriptPipeline.ts`) then checks, for every listed character id, whether the bible's `promptAnchor` is present in `visual.character`; if not, it's prepended. "Present" is compared through `normalizeForAnchorMatch` (NFKC, every dash and quote variant folded to ASCII, whitespace collapsed, case ignored): models write non-breaking hyphens (U+2011) and curly apostrophes into the bible and plain ones when they copy it, and an exact substring test called that a miss and put the description into the prompt twice (live run, 2026-09-24, scene 6). The anchor is guaranteed present regardless of what the model actually wrote.
- **Recurring backgrounds.** The same schema addition includes `locationId: string`, a slug the model invents per scene and is told to reuse when a story returns to a place. `applyVisualDirection` walks scenes in order and treats the *first* occurrence of a `locationId` as canonical: every later scene claiming that id gets its `visual.background` force-overwritten to match, the same override shape as `styleAnchor`.
- **Cut/shot rhythm and location continuity across chunks.** `buildPriorVisualContext` (`server/scriptPipeline.ts`) gives every art-direction chunk after the first a compact summary of everything generated so far: the running `visualType` tally (with an explicit nudge toward the documentary "at least half terminal/diagram/headline" target when short), every location established with its canonical background text, and the last 6 scenes' shot type/camera move — mirroring the narrative pass's existing `priorScenesContext` pattern. The prompt asks the model to vary `shotType`/`cameraMove` against that history and reuse a known `locationId` verbatim. This is generation-time steering, not a replacement for `timeline.ts`'s `no-pattern-interrupt`/evidence-mix audits, which still run unchanged after the script is finished.

**Place variety (2026-09-24).** The three mechanisms above made a place *consistent* but nothing made the video *varied*: a live script put one "split-screen terminal | void" canvas behind 7 of 10 scenes (3 distinct backgrounds), because the prompt called `background` "the environment" without saying a diagram is not a place, put no limit on reuse, and later chunks were not told how often a place had been used. Now: `background` may not contain composition, panel splits, overlays or on-screen text (those belong in `scene`); `locationId` must be a *place* (a diagram is set in a briefing-room whiteboard, a wall display, a desk — never a generic void), used for at most 2 scenes in a row and about a quarter of all scenes; `buildPriorVisualContext` shows each place with how often it has been used and lists any used 3+ times as spent (`PLACE_USED_UP_AT`); and `timeline.ts` raises `background-monotony` (**warn**) when one place fills more than 40% of the scenes (at least 4). Measured live on the same 10 narrative scenes, 3 runs: most-used place **2 of 10** every time (was 7), 5-6 distinct backgrounds (was 3), audit clear. One story, three runs, so re-check on other stories.

**Live-verified 2026-09-24** (forced through the real Gemini API, `LLM_PROVIDER_ORDER=gemini`, 12 synthetic scenes across 2 art-direction chunks on `gemini-3.1-flash-lite`, the other two `TEXT_MODELS` momentarily 503): no schema error at `maxItems:6` with the two new fields. The model genuinely reused all 3 established `locationId`s in chunk 2 without needing the code-level override to correct anything, shot types/camera moves showed real variety scene to scene, and every `charactersInFrame` claim already carried its anchor before enforcement ran. One live sample on the weakest model — a size worth re-checking on a stronger provider before leaning on it, same caveat as "Two voices" above.

Tests: `server/scriptPipeline.test.ts` — recurring-background force-match across 3 chunks, anchor force-splice (and no duplication when already present), an unknown `charactersInFrame` id skipped without throwing, `priorVisualContext` empty on chunk 1 and populated from chunk 2 on, the documentary shot-tally hint gated on tone, a journaled chunk still informing the next chunk's context after resume, and canonical values resolving by scene number rather than response order.

## Sound & edit pass (2026-09-26)

A fourth pass after art direction (`server/soundPipeline.ts`, wired in `/api/script`) writes what a sound designer and an editor decide: the music plan, sound effects, silences and transitions. It's **direction for a person editing in DaVinci Resolve with free library audio. Nothing renders sound**, and `server/assemble.ts` is unchanged (owner's decision: cue sheet, not auto-mix).

Why: the narrative pass used to write one `soundEffect` per scene as item 10 of 12. A live 10-scene run (2026-09-26, baseline in the commit) stacked 2-3 effects on **every** scene ("record scratch + glass shattering + sub-bass"). The art pass's free-text `transitionOut` produced nine names in ten scenes ("glitch-cut", "Shatter transition"...), with no reason behind any of them. There was no music at all.

- **Music plan: one call per script** (`generateScorePlan`, flat `buildScorePlanSchema`). The model gets acts, scene gists, mid-rolls and tone, and returns `musicCues[]` (scene range, role, mood, BPM, instruments, intensity 1-3, entry/exit, library search terms).
  - `normalizeScorePlan` clamps and sorts the ranges and trims overlaps. **Uncovered scenes are deliberate silence and are never filled.** A cue that spans a mid-roll is split there with a fade-out.
  - Cues hold scene numbers, not times: the brief derives times from `script.timeline`, so `retimeFromAudio` keeps them right.
- **Per-scene sound & edit, in chunks of `SOUND_SCENES_PER_CHUNK` (10)** (`buildSoundDirectionSchema`, flat). Fields: `sfxCue`, `sfxOnWord`, `sfxSearchTerms`, `ambience`, `silenceBeforeSec`, `transitionIn` (enum from `shared/sound.ts`), `transitionReason` and `audioBridge` (none | j-cut | l-cut).
  - The prompt explains every transition's meaning, and that most scenes get no effect (about 1 in 4, with the running count passed forward).
  - It avoids AI-video sound clichés, and names both libraries (YouTube Audio Library, Pixabay).
  - Chunk size 10 is a starting value: **re-verify live before raising it.**
- **Enforced in code (`applySoundDirection` / `toSceneSound`), not just asked:**
  - Stacked effects are cut to one (`cleanSfxCue`), and `sfxOnWord` is dropped if the word isn't in the narration.
  - Transitions are mapped onto the closed list (`normalizeTransition`: "Hard Cut" → `cut`). `whip` becomes `cut` in documentary tone.
  - Scene 1 is forced to `cut`, and the scene after a mid-roll is forced to `fade-to-black`.
  - **`motion.transitionOut` is set from the next scene's `transitionIn`** (one source of truth), and the last scene fades out.
  - The legacy `soundEffect` becomes the single cue or `""`. Its default in `server.ts` is now `""`, not "Subtle electronic pulse".
- **The narrative pass no longer writes `soundEffect`** (removed from the prompt and from `scriptSceneItemSchema`, which makes that fragile schema smaller). Older scripts still carry it.
- **Audits** (`timeline.ts` `auditSound`, run from `analyzeScript` because it needs the mid-roll markers):
  - `sfx-overused`: more than 35 % of scenes have an effect, or any effect is stacked.
  - `music-wall-to-wall`: music under more than 90 % of the runtime.
  - `transition-showy`: more than 25 % non-cut, not counting the forced ones.
  - `midroll-without-fade`: only once a music plan exists.
- **Journal:** `scorePlan` and `soundChunks` are checkpointed, and the progress object gains `soundChunksDone`. A failed chunk degrades as `generation.degraded`; strict mode rethrows retryable failures, like the other passes.
- **Brief:** a "Sound & edit" section with the music cue sheet, the effects/ambience/silence table, the non-cut transitions with reasons and J/L-cuts, mix levels and a licence log. Each scene's table shows its music, effect and cut.
- **Cost:** 1 + ceil(scenes/10) calls, so about 6 more on a 9-minute script.

**Writing fixes shipped with it:**
- `signatureIntro` is `''` for every tone. It used to be "Welcome back to Blast Radius..." for non-documentary scripts, while `intro-line-present` warned about that exact line.
- A `plainWords` rule in `shared/topicProfile.ts` now goes into the narrative prompt: technical terms get explained, and the word "CVE" is never used. A live script said "No patch. No CVE." in 14 scenes.
- The bare word is audited as `cve-jargon`, separately from real ids and scores (`severity-rating-shown`).

## Retention audit and publish package

`server/timeline.ts` is pure and deterministic — no model call, no quota. `/api/script` adds `timeline`, `chapters`, `midrollMarkers` and `qualityChecks` to the script: mid-rolls at ~2:30 and ~6:00 snapped to real scene boundaries (a semantic bonus for "after the problem is set up" / "before the fix"), **none and a warning if the runtime is under 8:00**, chapters grouped by `actPhase` (≥3, ≥10 s each, ≤12), and checks for missing hook, 30 s+ runs with no pattern interrupt, duration shortfall, narration that can't fit its scene, an AI-slideshow-risk evidence mix, a CVE id or CVSS score spoken or shown (`severity-rating-shown`), and **specifics in the narration or on-screen text (CVE ids, %, $, large numbers, versions) that are not in the research dossier**. The matcher compares whole canonical tokens (`specificKey`: `pct:83.5`, `usd:1500000000`, `ver:5.6.1`, `num:5:gb`), never substrings — an earlier `includes()` over a squashed blob let `45%` pass on `2045`, `CVE-2024-3094` on `CVE-2024-30945` and `5.6.1` on `5.6.10`. Kind and named unit are part of the claim (`%` ≠ `$`, GB ≠ TB), spellings of one claim are equal (`83 percent` = `83%`, `$1.5B` = `$1.5 billion`, `1,200,000` = `1.2 million`), and the dossier is tokenised field by field. On-screen coverage is `onScreenText` plus infographic title/badge/summary/steps/metrics; code snippets are excluded on purpose (terminal lines look like versions). Bare numbers, years and CVSS scores like `9.8` are still not specifics — only the patterns in `SPECIFIC_RE` are checked. The shortfall error fires below **0.92** of the requested runtime (it was 0.85; 0.85 × the old 540 s default was 459 s, under the 480 s mid-roll floor) and the default target is now 585 s. Durations are the model's `durationEst` until `retimeFromAudio` replaces them with the rendered video's (`script.timingSource: 'audio'`). Thresholds are named constants at the top of the file; they encode the spec's targets, not measured truths, and the 8:00 rule should be re-verified against YouTube's current policy.

Documentary tone (`Deep Dive Documentary`) now actually changes the output: no `signatureIntro` (cold open), a calm outro, and tone-conditional plan / bible / scene prompts. The plan prompt's inline example used to be infotainment-shaped regardless of tone, and the inline example wins over instructions.

**`hookStrategy` is asked to name a deliberate mechanism (2026-09-24), not generic boilerplate** — a short taxonomy (curiosity-gap/open loop, in-medias-res cold open, contrast/reversal, ticking-clock) added to the `/api/plan` prompt, with all four inline examples' `hookStrategy` values tightened to instantiate one each. No schema change; unenforced prose, like `hookStrategy` always was. **Live-checked 2026-09-24** (one real `/api/plan` call): the model consistently returns a concrete, story-specific hook instead of boilerplate, but did not always literally name which mechanism it used the way the inline example models — a sample of one, on whichever provider answered, not proof either way. Nothing downstream parses this field, so it is a prose-quality nudge, not a guarantee.

`/api/publish-package` is a fourth small-schema pass. The model writes titles, thumbnail concepts, description copy and tags; code does the rest: title lint (≤70 chars, no ≥6-letter ALL-CAPS words, no emoji, banned clickbait phrases, no brackets, **no CVE id or CVSS score** (an error — see "No severity ratings on screen"), **figures must be in the dossier**), thumbnail lint, one feedback retry when fewer than 3 titles pass, a linter-chosen recommendation, chapters and mid-roll times from the timeline, and a description whose only URLs are retrieved sources — contact links are literal `{{PLACEHOLDER}}`s listed in `todos`, never invented.

### No severity ratings on screen (2026-09-22)

Blast Radius's audience is anyone curious about a hacking story, including people who know no tech, so the owner's rule is that **a video shows how serious a flaw was instead of rating it**. CVE ids, CVSS scores and "critical severity" labels stay out of the narration, `onScreenText`, infographics, titles, thumbnails and description copy. Severity comes through consequences instead: what an attacker could do, who and how many were exposed, how long it went unnoticed, how close it came. Where each part of the rule lives:
- **Script prompt:** a "SHOW THE DAMAGE, DON'T RATE IT" block in `generateSceneChunk`'s narrative prompt. The infographic example used to suggest "CVSS scorecards" with a `CVSS 9.8` badge and a `9.8 / Critical` metric. It now asks for an impact scorecard, and its example values are descriptions, not figures, so a model copying the example can't invent a score.
- **Enforcement:** `SEVERITY_RATING_RE` in `server/timeline.ts` matches the word CVE or CVEs, a CVE id, or CVSS. The audit raises `severity-rating-shown` as a **warn**, and `lintTitle` and `lintThumbnail` treat it as an **error**, so the publish package's one retry kicks in.
- **CVE ids are replaced in code (2026-09-24).** A live run still put "CVE-2014-0160 RESOLVED" in a badge and the id in an infographic summary, and a warning does not take it off the screen. `scrubCveIds` (`server/severityScrub.ts`), called in `/api/script` before the audit and before the journal keeps the script, replaces an id in narration, `onScreenText` and infographic title/badge/summary/steps/metrics with "the flaw" (case-aware; a bracketed id goes with its brackets). It discloses what it did as a **warn** check, `cve-ids-replaced` (CyberPipe's review shows only warn and error, and the wording around a replaced id can read oddly), and runs in linear time (an earlier version sliced the whole prefix per match: 800 KB of ids took 1.7 s). Code snippets and image/motion prompts are left alone, as the audit leaves them. `e2e/contract.e2e.test.ts` ("CVE SCRUB") guards the wiring.
- **Severity labels are flagged, not replaced.** `SEVERITY_LABEL_RE` (`server/timeline.ts`) catches a rating in words — "CRITICAL RISK", "high severity", "severity: critical", a bare "CRITICAL" badge, "9.8/10" — as `severity-label-shown` (**warn**). A live run put a "CRITICAL RISK" badge on screen and the id-only check said nothing. It is deliberately label-shaped ("critical infrastructure" and "8 out of 10 servers" pass) and has no clean stand-in, so a person rewords it. The title and thumbnail linters still use the id-only `SEVERITY_RATING_RE`.
- **Still allowed:** the research dossier keeps CVE ids, because they are facts and the specifics matcher still uses them. Tags may carry the id too, since some people search for it.
- The canned fallback's `CVSS 9.8` badge, metric and SVG text, which were invented numbers, are gone.

---

## Verifying changes

```bash
npm run lint       # tsc --noEmit — the baseline is zero errors (tests are type-checked too)
npm test           # unit tests (server/*.test.ts, node:test via tsx) — fast, no network, no quota
npm run test:e2e   # the real server against a stub Gemini, Pollinations and Hugging Face Space: 429/503/kill -9/resume/409/SSRF, strict TTS + image + video (~1 min)
npm run llm:check  # LIVE: every configured provider's key, model ids and one tiny JSON call (spends a fraction of a cent)
```

`npm test` and the e2e spawn env both set `LLM_PROVIDER_ORDER=gemini` and an empty `LLM_MODEL_ORDER`, so a real provider key in `.env` or the shell can never be reached by a "no network" suite. Keep that when adding a test runner. To exercise the chain end to end without spending anything, point one provider at a local stub with `<ID>_BASE_URL` (e.g. `DEEPSEEK_API_KEY=x DEEPSEEK_BASE_URL=http://127.0.0.1:4599`) — it speaks plain OpenAI `/chat/completions`.

The SDK honours `GOOGLE_GEMINI_BASE_URL`, which is how `test:e2e` (and any ad-hoc check) exercises quota paths without spending quota: run the server with it pointed at a stub. Unit tests build fakes from **real captured bodies** in `server/__fixtures__/`; add a fixture when a new failure shape shows up live.

Then, against the live API:

```bash
PORT=3100 npm run dev

curl -s -X POST localhost:3100/api/research -H 'Content-Type: application/json' \
  -d '{"messageText":"...","sourceUrls":["https://..."]}' > /tmp/r.json

# then /api/plan with {researchData, targetDurationSec}, /api/script with {videoPlan, researchData}
# targetDurationSec defaults to 60 if omitted (short-form) — pass e.g. 540 to exercise the
# chunked long-form path in /api/script instead of the single-chunk short-form one.
```

Check the server log for coverage lines — `[Production Bible] N character(s) defined`, `[Script Agent] generated N/M scenes across K chunk(s)`, and `[Art Director] visual direction applied to N/M scenes across K chunk(s)`. Partial coverage means a pass (or one chunk of it) is degrading — and the response says so itself: `generation.complete` / `generation.degraded[]`, plus `qualityChecks` for everything the audit found.

Then confirm structure holds:

```bash
python3 -c "
import json; d=json.load(open('/tmp/s.json')); sc=d['scenes']
print('visual:', sum(1 for x in sc if x.get('visual')), '/', len(sc))
print('anchors identical:', len({(x.get('visual') or {}).get('styleAnchor') for x in sc})==1)
by_loc = {}
for x in sc:
    loc = x.get('locationId')
    if loc: by_loc.setdefault(loc, set()).add((x.get('visual') or {}).get('background'))
print('each reused location has exactly one background:', all(len(v) == 1 for v in by_loc.values()))
bible = {c['id']: c['promptAnchor'] for c in d.get('characterBible', [])}
bad = [x['sceneNumber'] for x in sc if any(bible.get(cid) and bible[cid] not in (x.get('visual') or {}).get('character','') for cid in x.get('charactersInFrame', []))]
print('scenes missing a listed character anchor (should be empty):', bad)
"
```

---

## Security

The server binds **`127.0.0.1` by default** (`HOST` env to change it): the endpoints are unauthenticated and spend provider quota and money, and `/api/research` fetches arbitrary URLs. Set `HOST=0.0.0.0` only behind something that authenticates callers (Cloud Run / AI Studio). Source fetches pass the SSRF guard on every hop (see the rescue ladder above); `runId` becomes a filename, so it is validated against `^[A-Za-z0-9_-]{1,64}$`.

`.env`, `exports/`, `.runs/`, `renders/` and `firebase-applet-config.json` are gitignored. The repo is **public** — nothing with a real credential in it may be committed.

Firebase web config values are public by design (they ship in the browser bundle) but are kept out of the repo anyway; they load from `VITE_FIREBASE_*`. A Firebase API key was committed once and force-pushed out of history — treat that key as burned, and remember GitHub still serves orphaned commits by SHA after a force-push, so rotation matters more than history rewriting.
