---
name: blast-radius-youtube
description: The YouTube side of a Blast Radius video, stage by stage — check and rewrite scene 1's hook before the media run, title + thumbnail as one pairing, Shorts cut from the finished video, niche research by outlier multiple, and after publishing the retention leak, comment replies and the one-fix channel audit. Use when asked about a Blast Radius hook or opening, "is the hook good", titles and thumbnails, Shorts or clips from a video, what is working in the niche, competitor channels, retention, "why do people stop watching", comments, or how the channel is doing.
---

# Blast Radius on YouTube

Adapted 2026-10-08 from the MIT-licensed [youtube-agent-skill](https://github.com/Jakeschincariol/youtube-agent-skill)
(commit `a2feb21`) for a **faceless, AI-narrated** channel. Its creator-on-camera parts (dead-air cutting,
a personal `voice.md`) don't apply: the voice is the channel's, set in `shared/topicProfile.ts`, and the
narration is TTS. Our own code does the checks; this skill says when to run them and how to read them.

**Nothing here publishes.** Every stage ends in something the owner copies or approves, and the last
line of every answer is the question: **ship it, or change it?**

The rules of the house still bind every line written here: facts only from the dossier, no CVE ids or
severity ratings on screen, plain words for a non-technical viewer, and no harm beyond what the sources
report (ContentPipe `CLAUDE.md`).

## 1. Before the media run: the hook

`npm run story:start` ends with a script whose `qualityChecks` score scene 1 (`server/hookScore.ts`, a
port of the pack's `hookscore.py`): `hook-weak` (warn) or `hook-score` (info), with the five properties
— specificity, address ("you"), stakes, curiosity, brevity — and the weakest one's fix. The script prompt
(`openingHookBrief`) already asks scene 1 to confirm the title, name the viewer's stake, and leave one
question open.

When scene 1 is WEAK, or the owner asks:

1. Write **five** scene-1 narrations, each on a different formula from `server/hooks.json` that fits
   this story. 22-30 words, two or three sentences. Skip a formula that needs a number the dossier
   doesn't have (The Statistic, Someone Else's Result): its examples use invented figures and ours may not.
2. Score them: put one per line in a scratch file and run `npm run hook:score -- hooks.txt`.
   (`npm run hook:score -- .runs/story-<slug>/brief.json` scores the current one.)
3. Show the owner the **top two** with their panels, and say which formula each uses and why it fits.
   Never hand over just one. The score is a heuristic: its author found it separates bad hooks from real
   ones but barely separates a creator's hits from misses. Read the line aloud before trusting a number.
4. On the owner's pick, edit `scenes[0].narration` in `.runs/story-<slug>/brief.json` (and
   `script.json`) **before** `submit_job.py adopt`. Clips, captions and narration all derive from it
   later, so nothing else needs changing. Keep `durationEst` sensible (~150 words a minute).

## 2. Before publishing: title + thumbnail as one pairing

`POST /api/publish-package` drafts five titles and three thumbnails. Its linter now warns
`thumbnail-repeats-title` when a title's paired overlay (`bestThumbnail`) repeats the title's words: a
viewer reads them together, so a repeated word wastes half of what they read. Then hand the pick to
SEO-Agent (`../SEO-Agent`): its `make lint P=<slug>` checks the same pairing plus whether the primary
keyword survives a phone feed's ~40-character cut. For the winner write the thumbnail brief: the
subject (an object or scene, never a host face), framing, the 2-3 overlay words, and what keeps contrast
at feed size.

## 3. After the Resolve bundle: Shorts

Read `../ContentRender/output/runs/<videoId>/resolve/*.en.srt` with the brief beside it. A Short is not
the best moment; it is a moment that **survives without the video around it**. Find spans of 20-55 s
where all three hold:

1. It opens on a complete thought (the first sentence doesn't need the previous minute).
2. There is a turn: a claim, then something that complicates or proves it.
3. It ends on a line, not a trail-off.

Show the top five with timecodes and first lines, so the owner can reject one without reading the
transcript. For each one kept, write: a **new first line** (score it with `npm run hook:score`); 2 s of
on-screen text in different words from that line; a loop point (the last line sets up the first); and
what a 9:16 crop of the 16:9 frame loses. The new line must be voiced in the narrator's voice (Kokoro
`af_heart`), or carried as on-screen text over the original audio. Write it all to
`resolve/shorts.md` in that run folder.

## 4. Choosing stories and angles: what is working in the niche

Raw views rank channel size. Rank by **views over each channel's own median** instead (SEO-Agent):

```bash
cd ../SEO-Agent
yt-dlp --flat-playlist -J --playlist-end 30 "https://www.youtube.com/@<channel>/videos" > projects/<slug>/research/<channel>-$(date +%F).json
make outliers F=projects/<slug>/research/<channel>-<date>.json MIN=2
```

Public listings only, one channel at a time, never logged in. A channel needs at least four videos for a
median; the tool says when it skips one. Hand back the top five with their multiples, the **one**
structural thing they share, and which of them Blast Radius could make this week from a real story.
Study them, never copy a title or thumbnail (SEO-Agent hard rule 6). Naming a title's formula is a
judgement about its words, not a claim about why it worked: say so.

## 5. After publishing

**Retention** (once a video has ~48 h of views). Studio → the video → Analytics → Engagement → the
audience-retention chart → download. Then, from `../SEO-Agent`:
`make retention F=<csv> DUR=<seconds> SRT=<the run's .en.srt>`. It reports the **hook leak** (points
lost in the first 30 s; under 25 is healthy), **cliffs** (the moments people left at, with what was
said) and the **slide** (steady loss per minute). Name the single biggest leak and one change for the
*next* video. Hook leak means scene 1 (section 1 above); a cliff is a moment (a topic change with no
signpost, a long setup); a steady slide is pacing, fixed by cutting. A healthy hook and a flat slide
mean the video is fine and the problem is packaging (section 2).

**Comments** (the owner pastes them). Sort into four piles and say how many are in each before writing:
questions (answer; repeats are next-video topics), corrections (if right, say so plainly and thank them;
never argue a fact you can't check), praise (reply to a few with something specific from their
comment), bait (no reply, ever). Replies are under 30 words, answer in the first sentence, sound like
the channel (measured, plain, no host persona), no emoji, and never promise a video. Say which ONE
comment to pin: the question the most people also have.

**Channel audit** (after about five videos). In this order: the last ten titles read as a list (same
shape every time is a format problem); thumbnails shrunk to feed size; scene 1 of the three most recent
through `npm run hook:score`; upload rhythm (consistency, not frequency); retention if exported. Hand
back **one** fix with what to do this week, three things that work (specific), and what not to do yet.

## Left out on purpose

The pack's `/yt-edit` (cuts ums and retakes: TTS has none), `/yt-chapters` (ContentPipe computes
chapters to YouTube's rules) and `/yt-plan` (a weekly upload rhythm; stories here start by hand).
