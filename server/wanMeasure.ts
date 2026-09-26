/**
 * State machine for the scheduled Wan 2.2 quota measurement (scripts/wan-measure.ts, run hourly by a LaunchAgent).
 *
 * Question: how many clips does a free Hugging Face token get per 24 h window, and when does it reset? ZeroGPU
 * "resets exactly 24 hours after your first GPU usage", and a refused call costs no quota, so the job simply retries
 * every hour until a call is let in: that first success starts the window. It then keeps generating until a call fails
 * (the wall) and records how many clips fitted. Then the next phase (a different step count) waits for the reset.
 */

export interface Clip {
  at: string;
  wallSec: number;
  bytes: number;
  width?: number;
  height?: number;
  fps?: string;
  durationSec?: number;
}
export interface Attempt {
  at: string;
  message: string;
}
export interface Phase {
  steps: number;
  status: 'pending' | 'open' | 'done';
  windowStart?: string;
  resetAt?: string;
  clips: Clip[];
  attempts: Attempt[];
  wall?: Attempt;
}
export interface State {
  createdAt: string;
  phases: Phase[];
}

const DAY_MS = 24 * 3600 * 1000;
const iso = (d: Date) => d.toISOString();

export function newState(now = new Date(), stepsList: number[] = [6, 4]): State {
  return { createdAt: iso(now), phases: stepsList.map((steps) => ({ steps, status: 'pending', clips: [], attempts: [] })) };
}

/** The phase to work on: the first that is not done. */
export function currentPhase(state: State): Phase | undefined {
  return state.phases.find((p) => p.status !== 'done');
}

/** A pending phase after a finished one must wait for that window's reset before it can start a clean window. */
export function waitUntil(state: State, now = new Date()): string | undefined {
  const cur = currentPhase(state);
  if (!cur || cur.status !== 'pending') return undefined;
  const i = state.phases.indexOf(cur);
  const prev = i > 0 ? state.phases[i - 1] : undefined;
  if (prev?.resetAt && new Date(prev.resetAt).getTime() > now.getTime()) return prev.resetAt;
  return undefined;
}

export function recordSuccess(phase: Phase, clip: Clip, now = new Date()): void {
  if (!phase.windowStart) {
    phase.windowStart = iso(now);
    phase.status = 'open';
  }
  phase.clips.push(clip);
}

/**
 * A failure before any success is "not let in yet" (retry next hour). A failure after at least one success is the
 * wall: the window is used up, and the reset is 24 h after its first success.
 */
export function recordFailure(phase: Phase, message: string, now = new Date()): 'retry_later' | 'wall' {
  const at = iso(now);
  if (phase.clips.length === 0 || !phase.windowStart) {
    phase.attempts.push({ at, message });
    return 'retry_later';
  }
  phase.wall = { at, message };
  phase.status = 'done';
  phase.resetAt = iso(new Date(new Date(phase.windowStart).getTime() + DAY_MS));
  return 'wall';
}

export const allDone = (state: State): boolean => state.phases.every((p) => p.status === 'done');

export function summarize(state: State): string {
  const lines = ['# Wan 2.2 free-quota measurement', `Started ${state.createdAt}.`, ''];
  for (const p of state.phases) {
    const n = p.clips.length;
    const total = p.clips.reduce((a, c) => a + c.wallSec, 0);
    lines.push(`## ${p.steps} steps — ${p.status}`);
    if (!p.windowStart) {
      lines.push(`No clip yet. ${p.attempts.length} refused attempt(s)${p.attempts.length ? `; last ${p.attempts[p.attempts.length - 1].at}: ${p.attempts[p.attempts.length - 1].message.slice(0, 160)}` : ''}.`, '');
      continue;
    }
    lines.push(`Window opened ${p.windowStart} (first success); ${n} clip(s), total ${total.toFixed(0)} s wall, average ${n ? (total / n).toFixed(1) : '-'} s.`);
    if (p.wall) lines.push(`Wall at ${p.wall.at}: ${p.wall.message.slice(0, 200)}`);
    if (p.resetAt) lines.push(`Reset expected ${p.resetAt}.`);
    lines.push('');
  }
  return lines.join('\n');
}
