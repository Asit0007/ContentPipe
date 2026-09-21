/**
 * Two-voice scripts: who reads each scene aloud.
 *
 * ContentRender (../ContentRender) reads every video with two voices. The NARRATOR carries the story.
 * The ANALYST is a second, shorter voice that reacts between narrator sections.
 *
 * Placement is decided here, in code, and is NOT requested from the model:
 *  - the narrative pass writes 3 scenes per call and sees only the 3 before it, so it cannot judge how
 *    often the analyst has already spoken across a 50-scene script, and the providers in the chain differ
 *    in how well they would keep such a rule;
 *  - so `speaker` never goes in a response schema. That keeps it out of the schema-size failure modes in
 *    CLAUDE.md, and means it cannot be silently omitted the way large-schema fields were;
 *  - the model is told which scene numbers in its chunk are reactions and writes those in the analyst's voice.
 *
 * The rule: every ANALYST_EVERY-th scene, except the last. So the analyst never opens or closes the video
 * (the narrator does both), never speaks twice in a row, and a script of ANALYST_EVERY scenes or fewer has none.
 * ANALYST_EVERY is a starting guess (~one reaction a minute at ~11.5 s a scene) to be tuned by ear, not a measurement.
 *
 * Dependency-free: imported by both server/ and src/.
 */

export const SPEAKERS = ['narrator', 'analyst'] as const;
export type Speaker = (typeof SPEAKERS)[number];

export const ANALYST_EVERY = 6;

/** Who speaks scene `sceneNumber` (1-based) of a script that is meant to have `totalScenes` scenes. */
export function speakerFor(sceneNumber: number, totalScenes: number): Speaker {
  return Number.isInteger(sceneNumber) && sceneNumber >= 1 && sceneNumber % ANALYST_EVERY === 0 && sceneNumber < totalScenes ? 'analyst' : 'narrator';
}

/** The analyst's scene numbers inside `[first, first + count)` — what one narrative chunk is told about. */
export function analystSceneNumbers(first: number, count: number, totalScenes: number): number[] {
  const out: number[] = [];
  for (let n = first; n < first + count; n++) if (speakerFor(n, totalScenes) === 'analyst') out.push(n);
  return out;
}
