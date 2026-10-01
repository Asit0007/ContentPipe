# UI review and declutter plan (2026-09-30)

A read of the browser UI's source (`src/`, against `server.ts`), page by page. **Nothing was run or clicked**: every
finding comes from reading the code at commit `a425e23`, so line numbers are for that commit. "Checked" means the cited
lines were re-read a second time for this document; "reported" means found in the first pass only. Nothing here is
built. This is the plan to pick from.

**Short answer to "does the UI work as expected?"** Partly. Every page calls a route that exists, with field names the
server accepts, and the main path (story → research → blueprint → script → export) is wired end to end. But the script
page's batch button throws away almost everything it generates, several fallbacks are shown as real results, and
nothing survives a page reload. Those are listed first.

The UI is not how the first real story was made: that went through `npm run story:start` and ContentRender's command
line. The UI matters for trying a story interactively, editing a script, copying prompts and exporting the brief.

---

## 1. What is broken

Ranked by cost to the owner. Size: S = under an hour, M = half a day, L = more.

| # | Defect | Where | Effect | Status | Size |
|---|---|---|---|---|---|
| 1 | "Generate All TTS & Images" keeps only the last result | `ScriptEditor.tsx:143-146`, `:252-289`; `App.tsx:217` | Each finished call rebuilds the script from the copy captured when the button was clicked, so it overwrites the one before. A 51-scene batch spends ~100 TTS and image calls and leaves one image | Checked | S |
| 2 | Two per-scene generations at once overwrite each other; narration typed while one runs is reverted | same cause | A scene can stay stuck on "Synthesizing…" | Checked (same code) | with #1 |
| 3 | A TTS quota fallback (a synthesized tone) is shown as "Audio Ready" and played as narration | server sets `isQuotaFallback` (`server.ts:818`); `ScriptEditor.tsx` never reads it | You think a scene has a voice and it has a beep | Checked | S |
| 4 | The podcast tab spends one text call and one TTS call every time it is opened | `NotebookLMStudio.tsx:98-100` (generates on mount) | Scarce quota (TTS is 10 requests a day) spent without a click | Checked | S |
| 5 | Blueprint format and tone controls show 9:16 / Witty for a fresh 16:9 documentary plan | `PlanStage.tsx:24-25` (state set once, before the plan exists) | The controls lie about the plan; touching them changes it | Checked | S |
| 6 | Player: Next or mute while a clip plays starts a second audio over the first, and the scene advances twice | `VideoStudio.tsx:303-356`; `audioUtils.ts:78-82` only cancels browser speech | Garbled playback | Reported | S |
| 7 | The Video Player tab with no script is a blank page | `App.tsx:227` | Looks like a crash | Checked | S |
| 8 | The angle picked on the Research page barely reaches the model and is lost on "Regenerate Blueprint" | `App.tsx:87`; no reference in `server.ts` | The choice is decorative | Checked | M |
| 9 | Re-running research leaves the old blueprint and script in place; "Re-write Script" deletes every generated still, voice and clip with no confirmation | `App.tsx:36-61`, `:125` | Stale or lost work | Reported | S |
| 10 | Exports drop context: the player's export has no research or plan; no export sends the chosen channel brand | `VideoStudio.tsx:974-979`; `GoogleWorkspaceExportModal.tsx:64` | A thinner brief than the script page gives | Checked (first half) | S |
| 11 | Markdown export and podcast audio post the whole script including every still and audio clip as `data:` text | same modal; `server.ts` 20 MB body limit | Likely a 413 and a raw JSON parse error on a long script with stills | Suspected | S |
| 12 | Edits to a scene's image prompt are ignored by the copy-prompt buttons (the two image prompts and, since 2026-10-01, the per-clip video prompts) | `shared/nanoBananaPrompt.ts:37-41`, `shared/imagePrompts.ts:46-47` | You copy the old prompt | Reported | S |
| 13 | Wrong labels: "gemini-3-pro-image" and "gemini-3.1-flash-tts" are hard-coded; the 1K/2K/4K picker does nothing for the providers in use; the chat says 3.5 Flash and sends 3.7; research loading text says "Google Search grounding" (not used); "NotebookLM" is one Gemini voice reading the first 1,200 characters | `ScriptEditor.tsx:497`, `:524`; `IPBrandingChatbot.tsx:36`, `:125`; `ResearchStage.tsx:34` | The page misstates what made the output, next to a panel that states it correctly | Checked | S |
| 14 | Nothing is saved: a reload loses the dossier, blueprint, script, stills, audio and publish package, with no warning | no storage use anywhere in `src/` | The biggest practical risk on a long script | Checked | L |
| 15 | Quota and overload are invisible: the UI never asks for strict mode, so a spent quota returns canned content; only some of it is flagged | no `Retry-After` handling in `src/` | Canned research looks nearly the same as real research | Reported | M |

Smaller, reported: the player's "Generate All" banner hides once any one scene has an image and any one has audio
(`VideoStudio.tsx:533-534`, checked); generated clips are never shown in the player; image downloads are always named
`.png`; `/api/notebooklm-dialogue` returns no `modelUsage`, so that call never appears in the models panel;
`ImageProviderId` in `src/types.ts` lacks `cloudflare`.

---

## 2. Page by page

### Every page: header, models panel, error banner
**Today.** Five step tabs, all clickable at any time, plus an export button and a brand button. A collapsed "AI models
on this page" panel above each page. One error string with Dismiss.
**Problems.** Tabs lead to empty or blank pages. The panel re-collapses on every tab change.
**Proposed.** Grey out a tab until its input exists. Keep the panel where it is: it is already the one honest account
of which model answered.

### 1. Story Input (`TelegramIngestion.tsx`, 380 lines)
**Today.** A hero card; three input-mode tabs; a form (channel name, story, source links, topic, four starter pills,
submit); beside it a sample feed and a "Pipeline Stages" card. About 18 controls in 6 blocks, all visible.
**Dead or duplicated.** The three mode tabs only change a two-letter badge (`:25`, `:151`, checked). "Pipeline Stages"
repeats the header. The model label repeats the panel. The starter pills are general tech stories under a hacking
headline. Choosing a sample does not fill the source-links box.
**Server offers, page ignores.** `targetDurationSec` on research, which scales research depth: the length is only
chosen after research.
**Proposed.** One column: story, links, target length, submit. Samples behind a "Try an example" link. Remove the mode
tabs and the stage card. Move the length choice here so research is as deep as the video needs.

### 2. Topic Research (`ResearchStage.tsx`, 276 lines)
**Today.** Title card, a two-column breakdown and "Hacker News Pulse", three angle cards, source chips, an action bar.
Five equal-weight blocks, nothing collapsed.
**Server offers, page ignores.** `researchCoverage`, `researchGaps`, failed and truncated sources, per-fact citations
(checked: none of these appears in any component). A dossier built from no readable source looks like a well-sourced
one. Canned research gets a mild amber pill while canned plan and script get a red banner.
**Proposed.** Put a trust strip at the top: sources read / failed / truncated, facts cited / uncited, gaps. Then the
summary and key facts with their citations. Collapse community reaction. Make the angle choice a real input (#8) or
remove it. Same red banner as the other pages for canned content.

### 3. Video Blueprint (`PlanStage.tsx`, 279 lines)
**Today.** Controls (title, format, tone, length, topic), the act list, two cards, an action bar. The cleanest page.
**Problems.** Defect #5. The hint "Regenerate the blueprint to apply it" is wrong for format, tone and length, which
the script reads directly; only the act list goes stale. `hookStrategy`, `coreConflict`, `pacingStyle` and
`targetAudience` are never shown. Topic domain is asked here and on page 1.
**Proposed.** Read the controls from the plan. Show the hook and conflict above the acts. Mark the act list as "out of
date" when a control changes instead of a blanket hint. Ask for the topic once.

### 4. Detailed Script (`ScriptEditor.tsx`, 1,325 lines, plus `ScriptQualityPanel.tsx`, 210)
**Today.** The densest page by far, one long scroll holding four jobs:
1. Quality and publish: banners, the audit, titles, thumbnails with full prompts inline, the description.
2. The "Master Script Dossier" card: title, four stat tiles, three control tiles, a progress bar, six export and copy
   buttons.
3. A view switch (Director Cards / Full Script Document / Teleprompter).
4. One card per scene with 9 to 11 controls: narration, caption, voice, image prompt, generate image, three
   copy-prompt buttons, preview, animate, clip player.

A 51-scene documentary puts roughly 500 controls on one page. Exports appear in five places. Asset counts appear three
times.
**Server offers, page ignores.** Per scene: `speaker` (narrator or analyst; checked, no reference), the visual layers,
shot type and camera move, citations, place, sound cues. Per script: the character bible, style guide, music plan,
chapters. Per publish package: tags, hashtags, chapters, mid-roll times. The panel says "chapters … below" and does not
render them.
**Proposed.**
- Three tabs inside the page: **Scenes**, **Quality & Publish**, **Export**. The first screen is the scene list.
- One sticky bar for assets: voice, counts, "Generate missing", progress. Remove the resolution picker until a provider
  honours it.
- Scene rows collapsed by default: number, speaker, act, first line of narration, three status dots (voice, still,
  clip). Expanding a row shows the editor. Prompts and copy buttons sit behind a "Prompts" expander inside it.
- One Export menu for the whole app, opened from the header, with "Save Markdown brief" first.
- Show `speaker`, chapters, tags and the music plan, since the brief already carries them.
- Filters: analyst scenes, scenes missing a still, scenes with a warning.

### 5. Video Player (`VideoStudio.tsx`, 983 lines)
**Today.** A mode switch, two stacked banners (generate all; "NotebookLM audio"), an aspect toggle and export, the
player with transport, a scene playlist.
**Problems.** Defects #6, #7, #10. Three different audio ideas on one page (per-scene voice, a "master audio", podcast
mode). Its batch button ignores the voice chosen on the script page and swallows errors. It shows stills only, never
the generated clips. Labels claim "4K" and "Dual-Voice".
**Proposed.** A preview page and nothing else: player, playlist, and the clip when a scene has one. Remove both
banners; generation lives on the script page. An empty state when there is no script.

### 5b. Podcast (`NotebookLMStudio.tsx`, 597 lines)
**Today.** Generates a two-host dialogue on open, plays it with the browser's speech voices, and offers a separate
single-voice audio file.
**Problems.** Defect #4. No error state: a failure renders nothing. The name promises a Google product it does not use.
**Proposed.** Decide whether it stays. Blast Radius videos are not podcasts and nothing downstream uses this. If kept:
a "Generate" button, an honest name ("Two-host summary"), and an error message.

### Channel brand and chat (`IPBrandingChatbot.tsx`, 473 lines)
**Problems.** The chosen brand reaches the script, publish package and watermark but not the plan or the export, though
the dialog says "across all video plans". Model labels are wrong (#13). A failed name generation is silent.
**Proposed.** A plain brand picker (the default is Blast Radius and rarely changes). Send the brand everywhere or say
where it applies. Keep the chat only if it is used.

### Export (`GoogleWorkspaceExportModal.tsx`, 545 lines)
**Problems.** Five entry points, two instances mounted at once. The Markdown brief, the actual deliverable, is a
sub-card inside a dialog titled "Export Script to Google Workspace".
**Proposed.** One instance, one entry point. "Save Markdown brief" as the main button; Google Docs and Sheets under
"More". Always pass research, plan and brand; strip `data:` media from the request.

---

## 3. Improvement plan

### Phase 1 — make it correct (about a day; no layout change)
| Do | Files | How to check |
|---|---|---|
| Scene updates merge into the latest script: `onUpdateScript` takes an updater, `App` uses `setVideoScript(prev => …)` (#1, #2) | `ScriptEditor.tsx`, `App.tsx`, `VideoStudio.tsx` | Batch on a 3-scene script against the e2e stub: every scene ends with audio and a still |
| Honour `isQuotaFallback` and `isPlaceholder`: show "quota, no audio", do not count it, do not play it (#3) | `ScriptEditor.tsx`, `VideoStudio.tsx` | Stub `/api/tts` to return the fallback |
| Podcast generates on click (#4) | `NotebookLMStudio.tsx` | Open the tab; the network log stays empty |
| Blueprint controls read from the plan (#5) | `PlanStage.tsx` | Generate a documentary plan: 16:9 and Deep Dive are selected |
| Stop the current audio before starting the next (#6) | `VideoStudio.tsx`, `audioUtils.ts` | Press Next mid-clip: one voice |
| Empty state for the player; grey out tabs with no input (#7) | `App.tsx`, `Header.tsx` | Open each tab on a fresh load |
| Confirm before "Re-write Script"; clear downstream steps when research is re-run (#9) | `App.tsx` | — |
| Exports always carry research, plan and brand, and strip `data:` media (#10, #11) | `GoogleWorkspaceExportModal.tsx`, `VideoStudio.tsx` | Export a script with stills: request body under 1 MB |
| Model labels come from the response, or go (#13) | `ScriptEditor.tsx`, `IPBrandingChatbot.tsx`, `ResearchStage.tsx` | — |
| A first front-end test for the merge in row 1 | new `src/*.test.ts` | `npm test` |

### Phase 2 — declutter (two to three days)
1. Shared pieces first, so the pages shrink as they are rebuilt: `Button`, `Card`, `Tabs`, `CopyButton`, `LoadingCard`,
   `EmptyState`, `Banner`. Today the loading card is pasted four times and the copy button about eight.
2. The script page as in section 2: three tabs, one asset bar, collapsed scene rows, prompts behind an expander.
3. One Export menu in the header; remove the other four entry points.
4. Story Input down to one form; Research led by the trust strip; the player as preview only.
5. Decide on the podcast and the brand chat: keep and fix, or remove. Removing both takes ~1,070 lines out.

Check: each page's first screen shows one primary action; the script page for a 51-scene script renders the scene list
without scrolling past other jobs.

### Phase 3 — fit the real workflow (larger; decide after the first video ships)
1. **Survive a reload.** List finished scripts from `.runs/` and clips from `renders/clips/`, and open one. Needs a
   small read-only route. Stills need a place on disk first: today they exist only in the page.
2. **Show quota honestly.** Ask for strict mode from the UI and show "out of quota, back at 12:30" with a retry button
   instead of canned content.
3. **Show what the pipeline already knows.** Open a `story:start` run and its ContentRender progress (stills done,
   which gate is waiting), so the UI becomes the place to review a run and not a second way to make one.
4. Pass the target length to research, and make the chosen angle a real input to plan and script.

**Not proposed:** changing the palette, fonts or the no-gradients rule (`src/index.css`, the persona palette), or
adding a router or a state library. `useState` in `App` is enough once updates merge correctly.
