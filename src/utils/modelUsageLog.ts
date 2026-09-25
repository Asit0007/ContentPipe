import { useSyncExternalStore } from 'react';
import type { ModelCall } from '../../shared/modelUsage';
import type { WorkflowStep } from '../types';

/**
 * Model calls made from a page after its main result arrived: per-scene narration and stills, podcast audio.
 * They answer one request each and belong to no single response object, so they are kept here for the session
 * (in memory only: a reload starts clean, like the rest of the UI state) and ModelsPanel shows them per page.
 */

const byPage = new Map<WorkflowStep, ModelCall[]>();
const listeners = new Set<() => void>();
const EMPTY: ModelCall[] = [];

export function logModelCalls(page: WorkflowStep, calls: ModelCall[] | undefined): void {
  if (!Array.isArray(calls) || calls.length === 0) return;
  // A new array each time, so useSyncExternalStore sees the change.
  byPage.set(page, [...(byPage.get(page) ?? []), ...calls]);
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useSessionModelCalls(page: WorkflowStep): ModelCall[] {
  return useSyncExternalStore(subscribe, () => byPage.get(page) ?? EMPTY);
}
