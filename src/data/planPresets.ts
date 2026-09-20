/**
 * What the research → plan hand-off asks /api/plan for. `short` is the original,
 * previously hardcoded request (App.tsx used to send exactly this and nothing else, so the
 * chunked long-form path and the documentary voice were unreachable from the UI).
 */
export type PlanPresetKey = 'short' | 'documentary';

export const PLAN_PRESETS: Record<PlanPresetKey, { label: string; targetFormat: string; targetTone: string; targetDurationSec: number }> = {
  short: {
    label: 'Short · 60s · 9:16 · Witty',
    targetFormat: '9:16 (Shorts / Reels / TikTok)',
    targetTone: 'Witty Tech & Sarcastic',
    targetDurationSec: 60,
  },
  documentary: {
    label: 'Documentary · 9 min · 16:9 · Investigative',
    targetFormat: '16:9 (YouTube long-form)',
    targetTone: 'Deep Dive Documentary',
    targetDurationSec: 540,
  },
};
