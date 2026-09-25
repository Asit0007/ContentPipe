# Next move: the first Blast Radius video, at $0

Written 2026-09-25. Blast Radius has **0 videos, 0 subscribers, 0 views**. The pipeline writes good scripts. What's missing is published videos. This plan gets the first one out by hand with free tools, learns from it, and only then builds more automation.

Budget rule: **$0.** Tools you already pay for (Google AI Pro) are fine to use. Nothing new gets bought, and no card goes on any pay-as-you-go account.

---

## 1. Where things stand

| Stage | State | Tool |
|---|---|---|
| Research → plan → script | **Works.** Produces a sourced dossier, narrative plan, and scenes with character / background / scene prompts, motion direction, chapters, mid-rolls and an audit | ContentPipe (`contentpipe` skill) |
| Titles, thumbnails, description, tags | **Works** | `/api/publish-package` |
| Shot list (which stills, which clips, which tool) | **Built 2026-09-25** | `.claude/skills/blast-radius-production/shotlist.py` |
| Stills | By hand, up to 30 per video | Flux on Hugging Face, niji (20 one-off), Gemini app, Pollinations |
| AI clips | By hand, for a few hero moments only | Wan 2.2 on HF ZeroGPU, Google Flow; Kling free for drafts only |
| Narration | One `/api/tts` call per scene (one Gemini voice) | ContentPipe; two-voice setup is designed but not built (ContentRender) |
| Edit | By hand | DaVinci Resolve (installed) |
| Captions | `.en.srt` sidecar from the assembler, or Resolve's own | `server/assemble.ts` |

### The licence rule (decides which tools you can use)

A channel with zero views still has to care, because **once it joins the YouTube Partner Program, every video already uploaded starts earning ad money.**

| Tool | Can the free output go on Blast Radius? |
|---|---|
| Ken Burns stills, Resolve graphics, your own screenshots | **Yes** |
| Wan 2.2 / FLUX.1 schnell (Apache 2.0), LTX-2.x (free under $10 M revenue) | **Yes**, any host |
| Google Flow (Veo / Omni Flash) | **Unclear.** Read Google's generative AI terms first |
| Dreamina (Seedance) | **Unclear.** ToS reads as personal use |
| **Kling free** | **No.** Kling's own terms: free users must keep the Kling logo, and commercial use needs a paid plan (kling.ai/docs/payment-policy, read 2026-09-25) |
| Fal.ai | Paid API. Only usable if the account has promo credits, which expire in 90 days |
| Topview | Paywalled |

Facts, sources and dates are in the global skill `~/.claude/skills/free-ai-video-stack`. Free tiers change monthly, so re-check anything older than about 30 days.

### Why most of the video can't be AI video

A 9-minute video is ~540 s of picture. Free credits across every tool give roughly **10–40 s of AI clips per day**. So:

| Layer | Share | Made with | Cost |
|---|---|---|---|
| Stills with a slow camera move (Ken Burns) | ~60–70 % | Resolve *Dynamic Zoom*, or `assemble.ts` | $0, unlimited |
| Graphics: terminal, diagram, headline, timeline cards | ~15–25 % | Resolve Fusion / Text+, or HTML screenshots | $0, unlimited |
| AI clips for the hook, act turns and climax | ~10 % | Wan 2.2 (HF), Flow | free daily credits |

**Never spend credits on a slow push-in over a still.** Resolve does it for free, without morphing.

---

## 2. Video #1, step by step

**Target:** one documentary-tone, long-form 16:9 video, **6–9 minutes**, plus **2–3 Shorts** cut from it. Pick a story with strong, clear stakes that a non-technical viewer can follow in one sentence. Leave out CVE ids and severity scores (the pipeline already enforces this).

### Day 1: script (about 30 min of your time)

```bash
cd ~/"Developer/My VSC projects/My Persona/ContentPipe"
npm run llm:check                # confirm which free models answer today
PORT=3100 npm run dev
```

Then run research → plan → script → publish-package, following the `contentpipe` skill (`.claude/skills/contentpipe/SKILL.md`). Use `"targetTone":"Deep Dive Documentary"`, `"targetFormat":"16:9"`, `"targetDurationSec":480` for a first video (8 min, the mid-roll floor). Save `r.json`, `p.json`, `s.json` into a folder such as `~/BlastRadius/ep01/`.

**Read the script before anything else.** Check `qualityChecks` (errors first) and `generation.complete`, and confirm every figure is in the dossier. Fix wording by hand. Nothing downstream catches a bad sentence.

### Day 1: shot list (5 min)

```bash
python3 .claude/skills/blast-radius-production/shotlist.py ~/BlastRadius/ep01/s.json --images 30 --clip-share 0.10
```

Open `~/BlastRadius/ep01/production/shotlist.md`. It lists:
- the stills to generate, in priority order (hook first)
- each scene's treatment: graphic, Ken Burns, or AI clip, with the tool
- the exact filename for every asset (timeline order, so Resolve's sorted bin *is* the edit)
- one-camera-move image-to-video prompts

If a row's "Why" looks wrong, edit that scene's `motion` / `visualType` in `s.json` and re-run.

### Days 1–2: stills (up to 30)

In order of preference, all $0:
1. **FLUX.1 [schnell] on a Hugging Face Space.** Apache 2.0, safe to monetise. Free account = 3.5 GPU-min/day, roughly 20–40 stills. Log in so you get the full quota.
2. **Pollinations** (no key; ContentPipe's `/api/generate-image` falls back to it). Check its terms before monetising.
3. **Gemini app image generation** on your AI Pro account. Check the daily limit and terms in the app.
4. **niji·journey app:** 20 free generations once, anime look only. Use only if the channel's look is going that way.

Rules: paste the character's anchor text word for word and the style suffix unchanged; reuse the same seed and the same reference image for the same character or place. Save as `stills/imgNN.png`.

### Days 2–4: hero clips (3–6 clips, only after all stills are approved)

- **Wan 2.2 image-to-video on an HF ZeroGPU Space:** about 1–2 short clips a day on the free quota.
- **Google Flow:** 50 credits/day (+ AI Pro monthly credits). Read the terms before publishing.
- **Kling free:** prompt tests only; do not publish its output.

Test at the lowest quality and 5 s first. Generate the keeper only when the motion is right. For a second clip in the same scene, start from the first clip's last frame:

```bash
ffmpeg -sseof -0.1 -i clips/0070_s07_c1_flow_8s.mp4 -frames:v 1 stills/s07_last.png
```

**A missing clip never blocks the video.** That scene falls back to Ken Burns on its still.

### Day 2: narration

One `/api/tts` call per scene (`{"text": "<scene narration>", "voice": "Charon"}`). The response's `audioBase64` is raw 16-bit mono PCM at 24 kHz. Convert each one:

```bash
ffmpeg -f s16le -ar 24000 -ac 1 -i s01.pcm audio/s01.wav
```

Listen to all of it once. Re-generate any scene that mispronounces a name or product. Free Gemini TTS quota is unmeasured, so a ~50-scene script may need two days. Note how many calls succeeded before a 429, and record it.

### Day 3–4: edit in DaVinci Resolve (free)

1. New project, 1920×1080, 24 or 30 fps. Import `audio/`, `stills/`, `clips/`, `graphics/`.
2. Put the narration WAVs on A1 in order. **Narration sets the timing.** Cut picture to it, not to the model's `durationEst`.
3. Sort the picture bin by name → select all → *Create New Timeline Using Selected Clips*, or drag onto V1 against the narration.
4. Ken Burns rows: set each still's length to its narration, enable *Dynamic Zoom* (Inspector). Alternate push-in and pull-out.
5. Graphics: Text+ titles over a dark plate for terminal / headline / diagram scenes, using `onScreenText` and the infographic spec from the exported brief.
6. Music: CC0 only (e.g. Pixabay Music, YouTube Audio Library). Log track, URL and licence in `ep01/licences.md`. Duck it under narration (−18 to −22 dB).
7. Captions: import the `.srt` from the assembler if you rendered one. Resolve's automatic *Create Subtitles from Audio* is a Studio (paid) feature, so on the free edition upload captions to YouTube instead (its auto-captions are free; correct names by hand).
8. Deliver: H.264 1080p, audio normalised to −14 LUFS (*Normalize Audio Levels*).

### Day 4: Shorts (2–3)

Take the strongest 30–50 s moments (hook, the reveal). New 1080×1920 timeline, reframe each shot (reframe stills; regenerate at 9:16 only if the subject is lost), big burned-in captions, first second must be the hook. End each with a pointer to the full video.

### Day 5: publish

- Title, thumbnail concept, description, chapters and tags come from `/api/publish-package`. Pick its recommended title unless one of the alternatives reads better out loud.
- Thumbnail: one of the approved stills + 2–4 words in Resolve or any free editor. Readable at phone size.
- **Tick YouTube's "altered or synthetic content" disclosure.** Put the sources list (from the brief) in the description.
- Upload the `.srt` as an English caption track.
- Publish the long video first, then the Shorts over the following days.

### Record what it cost (in time)

Create `~/BlastRadius/ep01/log.md` and note: hours per stage, stills made vs kept, clips made vs kept, TTS calls before quota, which free tool ran out first. **These numbers decide what to automate next.**

---

## 3. Cadence and targets (months 1–3)

- **Month 1:** 1 long video + 3 Shorts per week. Consistency beats volume, and YouTube's July 2026 "inauthentic content" policy targets templated, mass-produced uploads, not AI tools.
- Vary each video: new story, new look for its characters and places, a hand-written hook line, a custom thumbnail.
- Watch in YouTube Studio after each upload: click-through rate, average view duration, retention at 0:30 and at each chapter. A drop in retention points at the scene to fix next time.
- YPP full ad revenue: 1,000 subscribers + 4,000 watch hours (12 months) or 10 M Shorts views (90 days). **The watch-hour bar becomes 8,000 on 2027-02-01.** Fan funding starts at 500 subscribers + 3,000 hours or 3 M Shorts views.

---

## 4. What to build next (after video #1, in this order)

Each item removes by-hand work that video #1 proves is real. Numbers from `log.md` can reorder this list.

1. **Clip-aware scene lengths in ContentPipe.** Ask the art pass for a `clipLengthSec` from {5, 8, 10, 15, 30} per AI-clip scene, and have the narrative pass size narration to it. Today scene lengths are arbitrary and `shotlist.py` pads them with holds.
2. **Narration batch script.** One command: script JSON → one WAV per scene, checkpointed so a 429 resumes the next day (same pattern as `.runs/`). Directed TTS prompt instead of the hard-coded "punchy infotainment" one.
3. **Graphics renderer.** Terminal / headline / diagram scenes → 1080p PNGs from HTML templates via headless Chrome. Free, readable text, no Resolve typing. Also gives burned-in text without an ffmpeg rebuild.
4. **Resolve hand-off.** Export an FCPXML/EDL from `shotlist.py` so the timeline arrives pre-cut against narration lengths. Must be tested by importing into Resolve before relying on it.
5. **Hugging Face client for Wan 2.2 / FLUX.** `gradio_client` against a public Space is HF's own API, so it's allowed, unlike the consumer web apps. It fits in the 3.5 GPU-min/day free quota, checkpointed per asset. This is the only legally automatable free generator.
6. **Two voices** (Kokoro narrator, Charon analyst) in ContentRender, once one-voice videos are out.
7. **ContentPipe backlog** (from earlier sessions): bound a slow Gemini failure (timeout + bench), re-test `gemini-3.8-flash` / `3.5-flash` when capacity allows, guard title typos.

Not planned: scripting the Kling / Flow / Dreamina / Topview web apps (their terms forbid it; the penalty is the account), and paid APIs.

---

## 5. Open decisions (owner)

| Question | Recommendation |
|---|---|
| Channel look: photoreal, cinematic illustration, or anime (niji)? | Cinematic illustration: most forgiving for free models and for consistency across 30 stills |
| Use Kling free output in early videos anyway? | No. If used, plan to re-cut or remove those videos before applying to YPP |
| Flow output on the channel? | Read Google's generative AI terms for your plan first; record the answer in `free-ai-video-stack` |
| Fal.ai promo credits? | Check the dashboard. If any exist, spend them on hero clips before they expire; keep auto top-up off |
| First story? | Something already in the news this week with a human angle and a clear "how close it came" |

---

## 6. Skills that support this

| Skill | Where | Use it for |
|---|---|---|
| `contentpipe` | `.claude/skills/contentpipe` | Running research → plan → script → export |
| `blast-radius-production` | `.claude/skills/blast-radius-production` | Script JSON → shot list, stills budget, clip plan, Resolve filenames |
| `free-ai-video-stack` | `~/.claude/skills/` (global) | Free tiers, licences, prompt formulas, credit rules, Resolve finishing |
