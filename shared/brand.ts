/**
 * The channel this pipeline exists to serve. Every "no brand was supplied" fallback — server prompts, canned
 * fallback scripts, the UI's watermark and export headers — reads it from here, so a rename is one edit.
 *
 * Deliberately NOT the name of any tool or source (this is not "ContentPipe", not "Hacker News"): a script that
 * says "Welcome back to <tool name>" or a video that shows another site's name on screen is a brand leak.
 * Lives in `shared/` because both `server/` and `src/` import it; keep it dependency-free.
 */
export const DEFAULT_CHANNEL_BRAND = 'Blast Radius';

/**
 * How every Blast Radius video looks, in a production designer's words.
 *
 * It lives here beside the channel name, not in `shared/topicProfile.ts`, because it is a property of the
 * CHANNEL, not of the subject: another channel covering the same cybersecurity story would look nothing like
 * this, and the same look is wanted whatever the story is about.
 *
 * The final clause is load-bearing. "Cyberpunk" on its own is one of the most over-fitted prompts there is —
 * unqualified, image models return synthwave poster art: neon signage, purple grids, a lone figure in rain.
 * Naming what the grade is NOT keeps it a lighting and lens instruction rather than a genre pastiche.
 */
export const CHANNEL_VISUAL_STYLE =
  'cyberpunk noir: high-contrast practical lighting, deep shadow, one or two saturated sources (cyan, magenta or ember) against near-black, ' +
  'reflective and rain-wet surfaces, volumetric haze, anamorphic lens with shallow depth of field, 35mm cinematic texture — ' +
  'grounded and restrained, never neon-sign clutter, purple grid horizons or synthwave poster art';

