/**
 * add-clip-prompts.ts — give a story that was written before the clip pass (2026-10-01) its per-clip video prompts.
 *
 *   npm run clips:add -- .runs/story-oneplus-root-2026-09            # run the clip pass, rewrite the brief and export
 *   npm run clips:add -- .runs/story-oneplus-root-2026-09 --derived  # no model calls: clips built from each scene's motion
 *   npm run clips:add -- .runs/story-oneplus-root-2026-09 --names-only  # no model calls: keep the clips, only take
 *                                                                       # character names out of every picture prompt
 *
 * Every mode takes character names out of the picture prompts (server/characterNames.ts): a name in a video prompt
 * got a clip refused by Gemini on 2026-10-01.
 *
 * It runs the same pass `/api/script` now runs (server/clipPipeline.ts), in this process, so the ContentPipe server
 * need not be running. It spends about one text call per 6 scenes (9 for a 51-scene story). Strict: a quota or
 * overload failure stops the run with the time to retry, and finished chunks are checkpointed in
 * .runs/clips-<story>.json, so a re-run picks up where it stopped.
 *
 * It rewrites the story folder's brief.json and script.json (the old ones are kept as *.before-clips.json) and writes
 * a fresh export in exports/ (Markdown + HTML page). It does not touch a ContentRender run that already copied the
 * brief: that run keeps the copy it started with.
 */
import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import { getAIClient } from '../server/gemini';
import { applyClipDirection } from '../server/clipPipeline';
import { RunJournal, hashRunInput } from '../server/runJournal';
import { writeScriptMarkdown } from '../server/markdownExporter';
import { sceneClips } from '../shared/clipPrompts';
import { scrubCharacterNames } from '../server/characterNames';
import { DEFAULT_CHANNEL_BRAND } from '../shared/brand';

const args = process.argv.slice(2);
const derivedOnly = args.includes('--derived');
const namesOnly = args.includes('--names-only');
const target = args.find((a) => !a.startsWith('--'));

async function readJson(file: string): Promise<any | undefined> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf-8'));
  } catch {
    return undefined;
  }
}

async function main() {
  if (!target) throw new Error('usage: npm run clips:add -- <story folder, e.g. .runs/story-oneplus-root-2026-09> [--derived]');
  const dir = path.resolve(target.endsWith('.json') ? path.dirname(target) : target);
  const briefPath = path.join(dir, 'brief.json');
  const brief = await readJson(briefPath);
  if (!Array.isArray(brief?.scenes) || brief.scenes.length === 0) throw new Error(`no scenes in ${briefPath}`);

  let script: any;
  const scrub = (s: any) => ({ ...s, scenes: scrubCharacterNames(s.scenes, s.characterBible) });
  if (namesOnly) {
    script = scrub(brief);
  } else if (derivedOnly) {
    script = scrub({ ...brief, scenes: brief.scenes.map((s: any) => ({ ...s, clips: sceneClips({ ...s, clips: undefined }) })) });
  } else {
    const key = `clips-${path.basename(dir)}`.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64);
    const journal = await RunJournal.open(key, hashRunInput(brief.scenes.map((s: any) => [s.sceneNumber, s.durationEst, s.narration, s.visual, s.motion])));
    if (journal.resumed) console.log(`resuming: ${JSON.stringify(journal.progress())}`);
    const degraded: string[] = [];
    script = scrub(await applyClipDirection(getAIClient(), scrub(structuredClone(brief)), { strict: true, journal, degraded }));
    for (const d of degraded) console.log(`degraded: ${d}`);
    await journal.markDelivered();
  }

  for (const name of ['brief.json', 'script.json']) {
    const file = path.join(dir, name);
    const backup = path.join(dir, name.replace('.json', '.before-clips.json'));
    if (!(await readJson(file))) continue;
    try {
      await fs.access(backup); // keep the first backup: a second run must not overwrite the original with clipped output
    } catch {
      await fs.copyFile(file, backup);
    }
    await fs.writeFile(file, name === 'brief.json' ? JSON.stringify(script) : JSON.stringify(script, null, 2), 'utf-8');
  }

  const all = script.scenes.flatMap((s: any) => s.clips);
  const fromModel = all.filter((c: any) => c.source === 'model').length;
  console.log(`${all.length} clips across ${script.scenes.length} scenes: ${fromModel} written by the model, ${all.length - fromModel} built from motion`);

  const research = await readJson(path.join(dir, 'research.json'));
  const plan = await readJson(path.join(dir, 'plan.json'));
  const exported = await writeScriptMarkdown({ script, research, plan, channelBrandName: DEFAULT_CHANNEL_BRAND });
  console.log(`export: ${exported.relativePath}${exported.pagePath ? `  (page: ${path.relative(process.cwd(), exported.pagePath)})` : ''}`);
}

main().catch((err) => {
  const retry = err?.retryAfterSec ? ` — retry in ~${Math.ceil(err.retryAfterSec / 60)} min; finished chunks are kept` : '';
  console.error(`${err?.message || err}${retry}`);
  process.exit(1);
});
