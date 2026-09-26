---
name: blast-radius-production
description: Turn a finished ContentPipe script (the /api/script JSON) into a $0 production pack for the by-hand image and video stage — which stills to generate within an image budget (default 30), which scenes get AI clips and from which free tool, clip lengths snapped to each tool's limits (Kling 5/10 s, Flow 8 s, Seedance up to 30 s), one-camera-move image-to-video prompts, timeline-ordered filenames and DaVinci Resolve assembly steps. Use when asked for a shot list, image list, clip plan, "what do I generate next", or how to take a Blast Radius script into Flux / Midjourney / Nano Banana, Kling / Seedance / Wan / Flow and DaVinci Resolve.
---

# Blast Radius production pack

ContentPipe stops at a script. This skill covers the step after it: the stills and clips you make by hand with free tools, then the edit in DaVinci Resolve. It follows `free-ai-video-stack` (global skill), which has the free-tier facts, the licence checks and the prompt rules. Read its section 1 before recommending any tool for a monetised video.

## Run it

```bash
python3 .claude/skills/blast-radius-production/shotlist.py /path/to/s.json            # 30-image budget, AI clips ≤ 25 % of runtime
python3 .claude/skills/blast-radius-production/shotlist.py s.json --images 20 --clip-share 0.15
python3 .claude/skills/blast-radius-production/shotlist.py s.json --allow-noncommercial   # drafts only: lets Kling free in
```

Writes `production/shotlist.md`, `production/shots.json` and empty `stills/ clips/ graphics/ audio/` folders next to the script (`--out` to change). It calls nothing and spends nothing. Get `s.json` from the `contentpipe` skill's run steps.

Test fixture (14 scenes, every route): `fixtures/sample-script.json`.

## What it decides, and why

| Decision | Rule | Why |
|---|---|---|
| Graphic, no still | `visualType` terminal / diagram / headline | Build these in Resolve Fusion or as an HTML screenshot: readable text, $0, and they are what the timeline audit counts as evidence |
| Ken Burns, no credits | no subject motion and a camera move a still can fake (push-in, pull-out, slow pan, static) | Never pay credits for motion Resolve's Dynamic Zoom does free, without morphing |
| AI clip | subject moves; `action` words (runs, slams, explodes, whip pan…), `long` (> 10 s), else `motion` | Credits only where a still cannot do the job |
| Which tool | first tool in `tools.json` → `routes` whose free output is not known to be non-commercial | Kling's free output must carry its logo and may not be used commercially (Kling's own terms, 2026-09-25) |
| AI-clip share | top-priority moving scenes up to `--clip-share` of runtime; the rest fall back to Ken Burns | Free credits give roughly 10–40 s of clip per day |
| Stills within budget | ranked: hook first, then each new act, action / long / moving, characters in frame, longer scenes. Over budget, a scene reuses the nearest still of the same `locationId` | The budget cap is the owner's (30); reuse of the same place is what ContentPipe's `locationId` exists for |
| Clip lengths | a shorter clip plus a ≤ 3 s hold in the edit beats buying a longer clip; clip 2+ starts from the last frame of clip 1 | Saves credits; a continuation costs no image budget |
| One camera move | a `motionPrompt` with 2+ camera moves is rebuilt from `subjectMotion` + one `cameraMove` | Multiple moves in one prompt cause warping |

Edit `tools.json` when a tool's limits or credits change (they drift monthly). `commercialOk: "unknown"` tools (Flow, Seedance) are allowed but shown as unknown in the summary: check their terms before the video is monetised.

## After generating

1. Save every file under the exact name in the Timeline table, into `clips/`, `stills/` or `graphics/`.
2. Resolve: sort the bin by name, *Create New Timeline Using Selected Clips*, then follow the pack's assembly steps.
3. Narration: `/api/tts` per scene, or ContentRender's voices (Kokoro `af_heart` narrator, Gemini `Charon` analyst) once built.
4. Music, sound effects and cuts: follow the exported brief's **Sound & edit** section (from the sound pass, 2026-09-26). It gives the music cue sheet with library search terms, the few scenes that get a sound effect and the word it lands on, the silences, every non-cut transition with its reason, and the J/L-cuts. Everything else is a straight cut. Fill in its licence log as you download tracks. Scripts made before 2026-09-26 have no such section.

## Known limits

- Routing reads the model's `motion` text with keyword rules. Read the "Why" column; override a row by editing the scene's `motion` or `visualType` and re-running.
- Credit costs in `tools.json` are approximate, from third-party pricing pages (2026-09-25); Seedance's are unknown.
- It does not make the images or clips: the web apps must not be automated (see `free-ai-video-stack`).
