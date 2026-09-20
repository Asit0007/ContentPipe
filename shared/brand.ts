/**
 * The channel this pipeline exists to serve. Every "no brand was supplied" fallback — server prompts, canned
 * fallback scripts, the UI's watermark and export headers — reads it from here, so a rename is one edit.
 *
 * Deliberately NOT the name of any tool or source (this is not "ContentPipe", not "Hacker News"): a script that
 * says "Welcome back to <tool name>" or a video that shows another site's name on screen is a brand leak.
 * Lives in `shared/` because both `server/` and `src/` import it; keep it dependency-free.
 */
export const DEFAULT_CHANNEL_BRAND = 'Blast Radius';
