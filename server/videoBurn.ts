/**
 * The daily video "burn": spend each free Hugging Face ZeroGPU window on as much AI-generated footage as it will
 * give, across every trusted Wan / MiniMax / LTX Space (owner's decision 2026-09-27; design in ContentRender
 * DESIGN.md, "95-100% AI-generated picture at $0"). Pure state and planning; the runner is scripts/video-burn.ts.
 *
 * Two independent quota pools:
 *  - **account**: the owner's HF_TOKEN, free 5 GPU-min a day. Only Spaces owned by organisations already trusted with
 *    the token (Lightricks, MiniMaxAI, zerogpu-aoti).
 *  - **anonymous**: no token, HF's 2 GPU-min a day per IP. Other people's Spaces (Hugging Face staff) are called this
 *    way so the token is never sent to their code. Their code sees the still and the prompt.
 *
 * ZeroGPU "resets exactly 24 hours after your first GPU usage", and a call must fit its *reservation* into what is
 * left to start (billed for the time used). A refused call costs no quota. So each pool works like this: try every
 * entry in order (highest reservation first packs the window fullest), a success opens the window, and once every
 * entry has been refused or capped the pool sleeps a few hours and starts a fresh window 24 h after its first success.
 */

export type PoolId = 'account' | 'anonymous';

export interface BurnEntry {
  space: string;
  label: string;
  /** Wan only: diffusion steps (4 reserves ~27% less quota than 6). */
  steps?: number;
  clipSec: number;
  /** Clips of this model per window (the MiniMax hero shot is capped at one). */
  maxPerWindow: number;
  /** What is known about the licence, for the record; not legal advice. */
  licence: string;
}

export interface BurnPool {
  id: PoolId;
  entries: BurnEntry[];
}

/** The "Balanced" profile (owner, 2026-09-27): one MiniMax hero clip, then LTX-2.3, then Wan fills what is left. */
export const DEFAULT_POOLS: BurnPool[] = [
  {
    id: 'account',
    entries: [
      { space: 'MiniMaxAI/MiniMax-H3-Turbo-Lora', label: 'MiniMax-H3 Turbo (hero)', clipSec: 4, maxPerWindow: 1, licence: 'MiniMax H3 Community: commercial use under $20M/yr; credit "MiniMax H3" in the description' },
      { space: 'Lightricks/LTX-2-3', label: 'LTX-2.3 distilled', clipSec: 5, maxPerWindow: 99, licence: 'LTX-2 Community License; commercial terms NOT yet read' },
      { space: 'zerogpu-aoti/wan2-2-fp8da-aoti-faster', label: 'Wan 2.2 14B', steps: 4, clipSec: 4, maxPerWindow: 99, licence: 'Apache 2.0' },
    ],
  },
  {
    id: 'anonymous',
    entries: [
      // multimodalart/minimax-h3 (28 default steps on an xlarge GPU) and cbensimon/wan2-2-fp8da-aoti-preview2 (xlarge,
      // many extra inputs) were left out: they would not fit the 2-minute anonymous pool.
      { space: 'multimodalart/wan2-1-fast', label: 'Wan 2.1 14B fast (multimodalart)', clipSec: 4, maxPerWindow: 99, licence: 'Apache 2.0 weights; the Space is a third party\'s code' },
      { space: 'linoyts/wan2-2-i2v-rCM', label: 'Wan 2.2 rCM (linoyts)', clipSec: 4, maxPerWindow: 99, licence: 'Apache 2.0 weights; the Space is a third party\'s code' },
    ],
  },
];

export interface Shot {
  id: string;
  /** Path to the still, relative to the burn folder or absolute. */
  still: string;
  prompt: string;
  aspectRatio?: string;
}

export interface Clip {
  at: string;
  pool: PoolId;
  space: string;
  label: string;
  steps?: number;
  shot: string;
  wallSec: number;
  bytes: number;
  width?: number;
  height?: number;
  fps?: string;
  durationSec?: number;
  hasAudio?: boolean;
  file: string;
}
export interface Refusal {
  at: string;
  space: string;
  message: string;
}
export interface Window {
  /** First success: ZeroGPU starts its 24 h clock here. */
  start?: string;
  resetAt?: string;
  clips: Clip[];
  refusals: Refusal[];
}
export interface PoolState {
  id: PoolId;
  windows: Window[];
  /** Do not try again before this (an all-refused sweep costs nothing but is pointless every hour). */
  sleepUntil?: string;
}
export interface State {
  version: 2;
  createdAt: string;
  pools: PoolState[];
}

const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;
const iso = (d: Date) => d.toISOString();

export function newState(now = new Date(), pools: BurnPool[] = DEFAULT_POOLS): State {
  return { version: 2, createdAt: iso(now), pools: pools.map((p) => ({ id: p.id, windows: [{ clips: [], refusals: [] }] })) };
}

/** The window to work on: the last one, or a fresh one once the last has passed its reset. */
export function currentWindow(pool: PoolState, now = new Date()): Window {
  const last = pool.windows[pool.windows.length - 1];
  if (last && (!last.resetAt || new Date(last.resetAt).getTime() > now.getTime())) return last;
  const fresh: Window = { clips: [], refusals: [] };
  pool.windows.push(fresh);
  return fresh;
}

export const isSleeping = (pool: PoolState, now = new Date()): boolean => !!pool.sleepUntil && new Date(pool.sleepUntil).getTime() > now.getTime();

export const clipsFor = (w: Window, space: string): number => w.clips.filter((c) => c.space === space).length;

export function recordClip(w: Window, clip: Clip, now = new Date()): void {
  if (!w.start) {
    w.start = iso(now);
    w.resetAt = iso(new Date(now.getTime() + DAY_MS));
  }
  w.clips.push(clip);
}

export function recordRefusal(w: Window, space: string, message: string, now = new Date()): void {
  w.refusals.push({ at: iso(now), space, message: message.slice(0, 400) });
}

/**
 * After a sweep in which every entry was refused or capped: if the window has clips, sleep (3 h, never past its
 * reset); if it has none, stay awake so the next hourly tick tries again.
 */
export function endSweep(pool: PoolState, w: Window, allRefusedOrCapped: boolean, now = new Date()): void {
  if (allRefusedOrCapped && w.start && w.clips.length > 0) {
    const until = Math.min(now.getTime() + 3 * HOUR_MS, new Date(w.resetAt!).getTime());
    pool.sleepUntil = iso(new Date(until));
  } else {
    delete pool.sleepUntil;
  }
}

/** Round-robin over the shots by how many clips have been made so far. */
export function pickShot(shots: Shot[], state: State): Shot {
  const made = state.pools.reduce((n, p) => n + p.windows.reduce((m, w) => m + w.clips.length, 0), 0);
  return shots[made % shots.length];
}

export function summarize(state: State, pools: BurnPool[] = DEFAULT_POOLS): string {
  const out = ['# Video burn summary', `Started ${state.createdAt}.`, ''];
  for (const p of state.pools) {
    const entries = pools.find((x) => x.id === p.id)?.entries ?? [];
    out.push(`## ${p.id} pool`);
    p.windows.forEach((w, i) => {
      out.push(`### Window ${i + 1}${w.start ? ` — opened ${w.start}, resets ${w.resetAt}` : ' — not opened yet'}`);
      const total = w.clips.reduce((a, c) => a + (c.durationSec ?? 0), 0);
      out.push(`${w.clips.length} clip(s), ${total.toFixed(1)} s of footage; ${w.refusals.length} refused call(s).`);
      for (const e of entries) {
        const cs = w.clips.filter((c) => c.space === e.space);
        if (!cs.length) continue;
        const wall = cs.reduce((a, c) => a + c.wallSec, 0);
        const foot = cs.reduce((a, c) => a + (c.durationSec ?? 0), 0);
        const dim = cs[0].width ? ` ${cs[0].width}x${cs[0].height}@${cs[0].fps ?? '?'}` : '';
        out.push(`- ${e.label}: ${cs.length} clip(s), ${foot.toFixed(1)} s, avg ${(wall / cs.length).toFixed(1)} s wall${dim}`);
      }
      const last = w.refusals[w.refusals.length - 1];
      if (last) out.push(`Last refusal ${last.at} (${last.space}): ${last.message.slice(0, 160)}`);
    });
    if (p.sleepUntil) out.push(`Sleeping until ${p.sleepUntil}.`);
    out.push('');
  }
  return out.join('\n');
}
