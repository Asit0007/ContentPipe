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
6. Music: CC0 only (e.g. Pixabay Music, YouTube Audio Library). Log track, URL and licence in `ep01/licences.md`. Duck it under narration (−18 to −22 dB). Once the sound & edit pass (section 4, item 0) is built, the brief's **Sound & edit** section gives the cue sheet: where each track starts and stops, where silence goes, which scene gets a sound effect and on which word, and each transition.
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

0. **Sound & edit pass + writing fixes — built 2026-09-26** (plan in 4.0 below; details in CLAUDE.md "Sound & edit
   pass"). Live check on a 2-minute OnePlus script, same research and plan, before → after:
   - **Sound effects:** 10/10 scenes, stacked → 3/10, one sound each, each tied to a word.
   - **Transition names:** 9 → 1 non-cut (a dip-to-black with a reason, after 0.8 s of silence, in a music gap before
     the cover-up reveal).
   - **Music:** none → 2 cues under 82 % of the runtime.
   - **Opening:** the "Welcome back" intro is gone.
   - **"CVE":** 1 on-screen mention → 0.
   - **Cost:** 7 → 9 calls.

   One run, 10 scenes, weakest-available models (Gemma 4 31B wrote both sound calls). Still to watch on a full 585 s
   run: chunking at 10 scenes, ambience (the model left it empty everywhere), J/L-cuts (none used), and hook wording (it
   said "massive", a size claim).

### 4.0 Sound & edit pass + writing fixes (plan, 2026-09-26)

**Why.** The latest real script (OnePlus, 25 Sep, 51 scenes) showed what ContentPipe does for sound and editing today:

- **Music: nothing.** No field, no prompt, no export line; only step 6 of the Resolve list above.
- **Sound effects: one free-text `soundEffect` per scene**, required in the narrative pass with a single example line.
  Every scene stacked 2–3 effects, most with "sub-bass": a wall of noise, no silence, nothing tied to a word, nothing
  you can search a library for.
- **Transitions: free-text `motion.transitionOut`** with no rules: "Cut / cut / Hard Cut / Smart Cut / Impact Cut", no
  reason behind any choice, nothing tying picture cuts to sound (J/L-cuts).
- **Writing:** `server.ts:644` hardcodes "Welcome back to Blast Radius..." for every non-documentary script while the
  audit (`timeline.ts:389`) warns about that exact line, and "welcome back" is wrong on a 0-subscriber channel. "No
  patch. No CVE." appears in 14 scenes: jargon a non-technical viewer can't follow, and the audit mislabels it as "a CVE
  id or CVSS score".

**Owner's decisions.** A **director's cue sheet** in the script and brief. You build it by hand in Resolve;
`assemble.ts` does not change. **Audio libraries** as sources: YouTube Audio Library and Pixabay search terms, plus a
licence log. No AI music, because Suno's and MusicGen's free output is non-commercial. Scope is **audio + edit + writing
fixes**, not a full story-structure overhaul.

**How: a fourth pass, "Sound & edit", built like art direction.** It uses a small flat schema, runs in chunks, passes a
summary of earlier chunks forward, and then code **verifies or forces** what matters. `applyVisualDirection` is the
template.

1. **Score plan: one call per script** (new `server/soundPipeline.ts`, `generateScorePlan`).
   - **Input, computed in code first:** acts (runs of equal `actPhase`, reusing `timeline.ts` chapter grouping),
     mid-roll boundaries, tone, and the analyst scenes.
   - **Output `musicCues[]`:** `startScene/endScene`, `role` (cold-open | tension | explainer | reveal | aftermath |
     resolve), `mood`, `tempoBpm`, `instruments`, `intensity` 1–3, `entry` (fade-in | hard-in | sting), `exit`
     (fade-out | button | cut-to-silence), and `searchTerms` (up to 4).
   - **Code rules:** clamp and sort the ranges and drop overlaps. **Gaps are intentional silence** and are never
     filled. A cue that spans a mid-roll is split there with a fade-out. Timecodes come from `durationEst`, and
     `retimeFromAudio` recomputes them.
2. **Per-scene sound & edit, in chunks of 10** (`generateSoundChunk`). The schema has no nested arrays, because the
   size limits in CLAUDE.md are driven by nesting.
   - **Fields:** `sfxCue` ("" = none), `sfxOnWord`, `sfxSearchTerms`, `ambience`, `silenceBeforeSec` (0–1.5),
     `transitionIn`, `transitionReason`, and `audioBridge` (none | j-cut | l-cut).
   - **Transitions are a closed list, with each meaning written into the prompt:**
     - `cut` is the default.
     - `smash-cut` is a sudden contrast.
     - `match-cut` is a visual rhyme.
     - `dissolve` is time passing.
     - `fade-to-black` ends a chapter or leads into a mid-roll.
     - `dip-to-black` is a beat of weight.
     - `whip` is for energy, infotainment only.
   - **Prompt rules, each with its reason and short examples:**
     - Most scenes get **no** sound effect.
     - A scene gets at most one sound, never a stack, and it lands on a specific word.
     - Put 0.5–1 s of silence before the biggest reveals.
     - Any transition other than `cut` needs a story reason.
   - **Context:** `buildPriorSoundContext`, which mirrors `buildPriorVisualContext`. It passes the sound effects used
     so far against the budget, and the last 6 transitions.
   - **Code rules (`applySoundDirection`):**
     - Map loose names onto the list ("Hard Cut" → `cut`).
     - Set the previous scene's `motion.transitionOut` from the next scene's `transitionIn`, so there is one source
       of truth.
     - Force a fade or dip at mid-rolls and at chapter ends.
     - Clear `sfxOnWord` if the word isn't in the narration (use `normalizeForAnchorMatch`).
     - The legacy `soundEffect` becomes `sfxCue` or "". Its `server.ts` fallback changes from "Subtle electronic
       pulse" to "", because no sound is a valid choice.
3. **The narrative pass drops its sound job, and the writing fixes land.**
   - Remove `soundEffect` from the narrative prompt and schema. The schema gets *smaller*, which is the safe direction.
   - Add a **PLAIN WORDS** block: explain every technical term the first time it appears, in everyday words. Never
     say "CVE"; say "no official public warning was issued".
   - The cyber examples live in a new `shared/topicProfile.ts` field, and `topicProfile.test.ts`'s pinned object is
     updated on purpose for that field only.
   - `signatureIntro` becomes '' for every tone, so every video opens on the hook. The UI-only fallbacks keep theirs.
   - The `severity-rating-shown` message now tells the bare word "CVE" apart from an id or score.
4. **New audits (warn):**
   - `sfx-overused`: more than ~35% of scenes have a cue, or a cue joins sounds with "+".
   - `music-wall-to-wall`: music covers more than 90% of the runtime, with no silence gap.
   - `transition-showy`: more than 25% of transitions aren't `cut`.
   - `midroll-without-fade`.
5. **Wiring:**
   - **`/api/script` order:** art direction → score plan → sound chunks → CVE scrub and audit.
   - **Scene rebuild list:** add every new field to `server.ts`'s rebuild list, or it silently vanishes.
   - **Resume and failures:** `runJournal` checkpoints `scorePlan` and `soundChunks`. A failed pass shows in
     `generation.degraded`, and strict mode still rethrows retryable failures.
   - **Types and schemas:** `src/types.ts` and `server/schemas.ts` change together (`SceneSound`, `MusicCue[]`).
   - **Brief export:** a new **Sound & edit** section with:
     - a music cue sheet (timecodes, mood, BPM, instruments, entry/exit, YouTube Audio Library and Pixabay search
       terms)
     - a sound-effect table (timecode, sound, on-word, search terms)
     - transitions with their reasons
     - mix notes: −14 LUFS final, music −18 to −22 dB under the narration, sound effects under the voice
     - a licence-log template
   - **UI:** a transition chip and a music-cue chip in `ScriptEditor`.
   - **Skills and docs:** `blast-radius-production` reads the cue sheet. Update ContentPipe's CLAUDE.md and README.

**Cost.** One score call plus one sound call per 10 scenes is **about 6 more calls** for a 51-scene script (~25 → ~31).
Chunk size 10 is a starting value: verify it live, and drop to 6 if the schema is refused.

**Verification.**
1. `npm run lint` and `npm test`. New tests go in `server/soundPipeline.test.ts` (fake `generateJson`, as in
   `scriptPipeline.test.ts`). They cover:
   - transition mapping, forced mid-roll fades and the `transitionOut` sync
   - `sfxOnWord` checks
   - cue clamping, overlaps and mid-roll splits, with silence gaps kept
   - resuming sound chunks from the journal
   - the new audits, and the updated topic-profile pin
2. `npm run test:e2e`: route the two new prompts in the stub, and add a "SOUND" contract test, like "TWO VOICES", that
   fails if a field falls out of the rebuild list.
3. **Live, cheap run first:** OnePlus research with `targetDurationSec: 120` (~12 scenes). Check that the schema is
   accepted, SFX density, transitions, and the cue sheet in the brief. If quota allows, run the full 585 s and compare
   with the 25 Sep brief: the intro gone, no "CVE" in narration, sound effects on fewer than ~35% of scenes.
4. Restart `npm run dev` after server changes, because `tsx` doesn't reload.

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
