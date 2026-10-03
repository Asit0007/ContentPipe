# Next move: publish the first Blast Radius video, at $0

Rewritten 2026-10-03 (the 2026-09-25 version planned a by-hand workflow that the story cycle has since replaced; it is
in git history). Blast Radius has **0 videos published**. The first one is the OnePlus story, already scripted and with
its stills made. This file is the path from here to "published", then what to measure and build next.

Budget rule: **$0.** No paid tools. A Google AI Pro plan the owner already has at no cost is fine to use (Flow/Veo for
clips, the Gemini app for Nano Banana Pro stills). **Kling is out** for now: its free tier gives too few credits and its
free output isn't licensed for a monetised channel (see the licence table).

---

## 1. Where things stand

| Stage | State | Tool |
|---|---|---|
| Research → plan → script | **Works.** Sourced dossier, plan, ~50-scene script with picture prompts, sound & edit cue sheet, per-clip video prompts, audits | `npm run story:start` (by hand); CyberPipe once installed (`../plan-cyberpipe.md`) |
| Titles, thumbnails, description, tags | **Works** | `/api/publish-package` |
| Stills | **Automatic**: Cloudflare FLUX klein-4b, free, 1920 wide for new stories (OnePlus: 1536×864). Lettered or evidence shots: Nano Banana Pro by hand in the Gemini app, saved over `stills/scene-NNN.png` | ContentRender `stills` stage; the brief marks FLUX or Nano Banana Pro per scene |
| Narration | **Automatic, two voices**: Kokoro `af_heart` narrator (local), Gemini `Charon` analyst; loudness matched | ContentRender `narration` stage |
| Free AI clips | **Automatic, the main source**: Hugging Face ZeroGPU Spaces (MiniMax-H3, Wan 2.2, two token-less Wan Spaces), a few short clips a day; the run pauses when the free quota is spent and resumes when it is back | ContentRender `clips` stage, **every scene** since 2026-10-03 (`CLIP_SLOTS_MAX=100`), best first |
| Hand-made clips | **By hand** in Google Flow/Veo from the per-clip prompts in the export; drop the file in `clips-in/slot-NN.mp4` (NN = scene number) | Flow on Google AI Pro credits |
| Edit | **Resolve bundle**: FCPXML timeline (stills with Ken Burns, clips, two voices, markers), captions, rough cut, shot list, licence list | ContentRender `bundle` stage → DaVinci Resolve 18.6 (free) |
| On-screen text | Added in the edit, never baked into AI pictures | `exports/<brief>.overlays.srt` (Resolve subtitle import) + the per-scene "On-screen text" list |

### The licence rule

Once the channel joins the YouTube Partner Program, every video already uploaded earns ad money, so every asset must be
cleared for commercial use from day one. This is a reading of the terms, not legal advice.

| Source | On a monetised channel? |
|---|---|
| Ken Burns stills, Resolve graphics and text, your own screenshots | **Yes** |
| Wan 2.1 / 2.2 clips (account or token-less Spaces) | **Yes**: Apache 2.0 |
| MiniMax-H3 clips | **Yes** under $20M/yr revenue; credit **"MiniMax H3"** in the description. Mute its soundtrack |
| FLUX.2 klein-4b stills via Cloudflare | Weights Apache 2.0 (BFL); Cloudflare's hosted terms not yet read |
| Google Flow / Veo, Nano Banana Pro (Gemini app) | Google's Terms of Service (effective 2026-07-30): "Google won't claim ownership over that content"; output may not be used to train AI models. No commercial restriction found in those terms, the Google One terms (2025-11-11) or the Flow FAQ (read 2026-10-03). **Downloads carry a visible watermark** (owner, 2026-10-03): use Flow only as a fallback, and never crop or remove the mark |
| LTX-2.x clips | **Not cleared**: its licence's commercial terms are unread |
| Kling free | **No**: free output must keep Kling's logo; commercial use needs a paid plan. Not used |
| Kaggle notebooks | **No**: personal, non-commercial use only |
| Music | CC0 or YouTube Audio Library / Pixabay only; no AI music (Suno and MusicGen free output is non-commercial) |

Always tick YouTube's **"altered or synthetic content"** box.

---

## 2. Video #1 (OnePlus), step by step

Run folder: `../ContentRender/output/runs/2026-09-30-how-a-zero-permission-app-could-control/`. Use the **1 Oct export**
`exports/2026-10-01-how-a-zero-permission-app-could-control-your-oneplus-4.md` for prompts (earlier exports are stale).

1. **Stills.** Remake the lettered stills the brief marks for Nano Banana Pro (FLUX garbled their text) and save each over
   `stills/scene-NNN.png`. ContentRender keeps a still replaced by hand.
2. **Images gate.** Approve through CyberPipe (`submit_job.py adopt`, once built, see `../plan-cyberpipe.md`) or by hand:
   `npm run cli -- approve --gate images --brief <run>/brief.json --video-id <run id>` in ContentRender, then `step`.
   Always use the run's own `brief.json`: a different brief starts the run over.
3. **Narration gate.** Listen to `review/narration.mp3`; redo bad scenes (`regenerate --kind narration --scenes N`); approve.
4. **Clips.** The pipeline tries a free clip for every scene, best first (scenes 1, 3, 9, 13, 15, 19, 25, 27…), a few a
   day, pausing when the free quota runs out and resuming the next day; at ~2-4 a day all 51 take 2-3 weeks. Make any
   you want by hand meanwhile (Flow adds a visible watermark) and drop them in; `/finish` stops the wait any day. A clip that is
   refused: short prompt → wipe the words off the still → another tool → a still with a slow zoom. Never respell words to
   get past a filter. `finish-clips` stops the wait; a clip dropped in later still wins on `rebuild`.
5. **Bundle → Resolve.** Open `resolve/*.fcpxml` in Resolve 18.6. Add on-screen text from `*.overlays.srt`, music and
   effects from the brief's "Sound & edit" cue sheet, and log each track in `licences.md`. Note how the import behaved on
   real content (the first real test of it).
6. **Deliver.** H.264 1080p, audio normalised to −14 LUFS, captions from `.en.srt`.
7. **Publish.** Title, description, chapters and tags from `/api/publish-package`; thumbnail = an approved still + 2–4
   words, readable at phone size; sources list in the description; the "MiniMax H3" credit if any MiniMax clip is used;
   the disclosure box; upload the `.srt`. Then 2–3 Shorts (30–50 s, 1080×1920, captions burned in Resolve, hook in the
   first second).

### Record what it cost

Write `log.md` next to the run: hours per step, stills remade by hand, free clips made vs. tried, Flow credits per kept
clip, the final motion share (seconds of clips ÷ runtime), and what ran out first. **These numbers decide what to build
next and whether the motion goal is realistic.**

---

## 3. Cadence and targets (months 1–3)

- 1 long video + 2–3 Shorts a week once the cycle is routine. Consistency over volume; YouTube's July 2026
  "inauthentic content" policy targets templated mass uploads, not AI tools.
- Vary every video: new story, a hand-written hook line, a custom thumbnail.
- After each upload, check click-through rate, average view duration, and retention at 0:30 and at each chapter.
- YPP full ad revenue: 1,000 subscribers + 4,000 watch hours in 12 months, or 10 M Shorts views in 90 days; the
  watch-hour bar was reported to rise to 8,000 on 2027-02-01 (re-check YouTube's own page before relying on it).

---

## 4. What to build next (after video #1)

1. **Install CyberPipe** so a story runs end to end with Telegram approvals: `../plan-cyberpipe.md`.
2. **Phase 3 of `../plan-story-cycle.md`:** 24 fps timeline, conform every clip, `qc.md` with the motion share per video.
3. **ContentPipe UI fixes:** `UI_REVIEW.md`.
4. Anything `log.md` shows is the biggest by-hand cost.

Not planned: scripting Flow, Kling, Dreamina or any other consumer web app (their terms forbid it, and the penalty is the
account), and paid APIs.

## 5. Open questions

| Question | How to answer it |
|---|---|
| How many Flow/Veo clips a month does the AI Pro plan allow? | Google's pages don't say; read the credit counter in Flow after a few clips |
| Cloudflare's hosted terms for FLUX klein-4b | Read them before the first monetised upload |

## 6. Skills that support this

| Skill | Where | Use it for |
|---|---|---|
| `contentpipe` | `.claude/skills/contentpipe` | Running research → plan → script → export |
| `blast-radius-production` | `.claude/skills/blast-radius-production` | Shot list, stills budget, clip plan, Resolve filenames |
| `free-ai-video-stack` | `~/.claude/skills/` (global) | Free tiers, licences, prompt formulas (being updated 2026-10-03: Kling out, Kaggle and Midjourney retired) |
