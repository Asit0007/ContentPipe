/**
 * The shape of "which model produced this", shared by the server (server/llm/usage.ts records it) and the UI
 * (ModelsPanel shows it). Dependency-free, like shared/brand.ts, because both sides import it.
 */

/** One model tried for one call: the winner (`ok`) or why it did not answer. */
export interface ModelAttempt {
  provider: string;
  model: string;
  outcome: 'ok' | 'quota' | 'overloaded' | 'invalid_output' | 'error' | 'skipped';
  /** Short human-readable reason for a non-ok outcome (HTTP status, "cooling down after ..."). */
  detail?: string;
  ms?: number;
  inputTokens?: number;
  outputTokens?: number;
}

/** One logical model call — e.g. "Narrative scenes 4-6" — and every model tried for it, in order. */
export interface ModelCall {
  task: string;
  kind: 'json' | 'text' | 'speech' | 'image';
  ok: boolean;
  /** The model that answered (absent if none did). */
  provider?: string;
  model?: string;
  attempts: ModelAttempt[];
  startedAt: string;
  ms: number;
  /** Written by an earlier, interrupted run of the same script and replayed from the .runs/ checkpoint. */
  fromCheckpoint?: boolean;
}

/** Response bodies that echo back into later requests (research -> plan -> script) carry this; strip before prompting. */
export const MODEL_USAGE_FIELD = 'modelUsage';

/** A copy without `modelUsage`, so provenance never ends up inside a prompt or a resume hash. */
export function withoutModelUsage<T>(value: T): T {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !(MODEL_USAGE_FIELD in (value as any))) return value;
  const { [MODEL_USAGE_FIELD]: _drop, ...rest } = value as any;
  return rest as T;
}
