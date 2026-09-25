import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import type { ModelCall } from '../shared/modelUsage';

/**
 * On-disk checkpoints for /api/script.
 *
 * A 9-minute script is ~25 sequential Gemini calls against a free tier that
 * caps a model at ~20 requests/day. Restarting from zero after a quota hit at
 * call 22 burns the day's budget again and never converges, so every finished
 * chunk is persisted the moment it exists and an interrupted run picks up where
 * it stopped.
 *
 * Resume rule — the only one: **a run resumes iff its journal exists, its input
 * hash matches, and it has not been delivered.** That makes "regenerate" after a
 * delivered script start fresh (as the UI and CyberPipe expect), while a run
 * that was cut off by a 429 — which strict callers never receive a partial for —
 * resumes with no client cooperation, keyed by a hash of the inputs.
 *
 * Deliberately not a database: ContentPipe has none, and CLAUDE.md keeps it that
 * way. One small JSON file per run, atomically replaced, pruned after a week.
 */

// CONTENTPIPE_RUNS_DIR lets the end-to-end test keep its journals out of the working directory.
export const RUNS_DIR = process.env.CONTENTPIPE_RUNS_DIR ? path.resolve(process.env.CONTENTPIPE_RUNS_DIR) : path.resolve(process.cwd(), '.runs');
const STATE_VERSION = 1;
export const DEFAULT_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

// Explicit run ids come from the request body and become a filename.
const RUN_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export function isValidRunId(id: unknown): id is string {
  return typeof id === 'string' && RUN_ID_PATTERN.test(id);
}

export function hashRunInput(input: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(input) ?? '').digest('hex').slice(0, 24);
}

export type RunStatus = 'in_progress' | 'complete' | 'delivered';

interface JournalState {
  version: number;
  runId: string;
  inputHash: string;
  createdAt: string;
  updatedAt: string;
  status: RunStatus;
  bible?: { characterBible: any[]; styleGuide: any };
  narrativeChunks: Record<string, any[]>;
  artChunks: Record<string, { firstScene: number; directions: any[] }>;
  finalScript?: any;
  /** Every model call made for this run so far, so a resumed run can still say which model wrote its earlier chunks. */
  modelCalls?: ModelCall[];
}

// One in-flight generation per run id. Express keeps working after a client
// times out, so a re-POST can otherwise race the still-running original and
// spend the quota twice.
const inFlight = new Set<string>();
export function acquireRun(key: string): boolean {
  if (inFlight.has(key)) return false;
  inFlight.add(key);
  return true;
}
export function releaseRun(key: string): void {
  inFlight.delete(key);
}

export class RunJournal {
  private liveModelCalls: ModelCall[] = [];
  private constructor(
    private readonly dir: string,
    private state: JournalState,
    readonly resumed: boolean
  ) {}

  static async open(
    key: string,
    inputHash: string,
    opts: { dir?: string; fresh?: boolean } = {}
  ): Promise<RunJournal> {
    if (!isValidRunId(key)) throw new Error(`Invalid run id: ${key}`);
    const dir = opts.dir ?? RUNS_DIR;
    await fs.mkdir(dir, { recursive: true });

    let existing: JournalState | null = null;
    if (!opts.fresh) {
      try {
        const parsed = JSON.parse(await fs.readFile(path.join(dir, `${key}.json`), 'utf8'));
        if (parsed?.version === STATE_VERSION && parsed.inputHash === inputHash && parsed.status !== 'delivered') {
          existing = parsed;
        }
      } catch {
        // Missing or corrupt journal: start clean rather than fail the request.
      }
    }

    const now = new Date().toISOString();
    const state: JournalState = existing ?? {
      version: STATE_VERSION,
      runId: key,
      inputHash,
      createdAt: now,
      updatedAt: now,
      status: 'in_progress',
      narrativeChunks: {},
      artChunks: {},
    };
    const journal = new RunJournal(dir, state, existing !== null);
    if (!existing) await journal.save();
    return journal;
  }

  get runId(): string {
    return this.state.runId;
  }
  get status(): RunStatus {
    return this.state.status;
  }

  getBible() {
    return this.state.bible;
  }
  async setBible(bible: { characterBible: any[]; styleGuide: any }) {
    this.state.bible = bible;
    await this.save();
  }

  getNarrativeChunk(index: number): any[] | undefined {
    return this.state.narrativeChunks[String(index)];
  }
  async setNarrativeChunk(index: number, scenes: any[]) {
    this.state.narrativeChunks[String(index)] = scenes;
    await this.save();
  }

  /** `firstScene` guards against reusing a chunk whose scene boundaries have shifted. */
  getArtChunk(index: number, firstScene: number): any[] | undefined {
    const c = this.state.artChunks[String(index)];
    return c && c.firstScene === firstScene ? c.directions : undefined;
  }
  async setArtChunk(index: number, firstScene: number, directions: any[]) {
    this.state.artChunks[String(index)] = { firstScene, directions };
    await this.save();
  }

  /** Calls recorded by earlier, interrupted requests for this run — marked, because this request did not make them. */
  priorModelCalls(): ModelCall[] {
    return (this.state.modelCalls ?? []).map((c) => ({ ...c, fromCheckpoint: true }));
  }
  /**
   * The array this request's calls are being recorded into (server/llm/usage.ts). Every save writes prior + live,
   * so the calls behind a checkpointed chunk are on disk with the chunk.
   */
  trackModelCalls(live: ModelCall[]) {
    this.liveModelCalls = live;
  }

  getFinalScript(): any | undefined {
    return this.state.finalScript;
  }
  async markComplete(script: any) {
    this.state.status = 'complete';
    this.state.finalScript = script;
    await this.save();
  }
  /** Drops payloads: the delivered script lives in the caller / exports/, not here. */
  async markDelivered() {
    this.state = {
      version: STATE_VERSION,
      runId: this.state.runId,
      inputHash: this.state.inputHash,
      createdAt: this.state.createdAt,
      updatedAt: new Date().toISOString(),
      status: 'delivered',
      narrativeChunks: {},
      artChunks: {},
    };
    await this.save();
  }

  /**
   * A run that failed before storing anything has nothing to resume; leaving its
   * file behind is just litter. Returns true if the journal was removed.
   */
  async discardIfEmpty(): Promise<boolean> {
    const p = this.progress();
    if (this.state.status !== 'in_progress' || p.hasProductionBible || p.narrativeChunksDone > 0 || p.artChunksDone > 0) return false;
    await fs.rm(path.join(this.dir, `${this.state.runId}.json`), { force: true });
    return true;
  }

  progress() {
    return {
      hasProductionBible: Boolean(this.state.bible),
      narrativeChunksDone: Object.keys(this.state.narrativeChunks).length,
      artChunksDone: Object.keys(this.state.artChunks).length,
      scenesSoFar: Object.values(this.state.narrativeChunks).reduce((n, c) => n + c.length, 0),
    };
  }

  /** Temp file + rename, so a crash mid-write can never leave a half-written journal. */
  private async save() {
    this.state.updatedAt = new Date().toISOString();
    if (this.state.status !== 'delivered') {
      const prior = this.state.modelCalls ?? [];
      // Replayed calls (fromCheckpoint) are copies of ones already in `prior`.
      const live = this.liveModelCalls.filter((c) => !c.fromCheckpoint && !prior.includes(c));
      if (live.length) this.state.modelCalls = [...prior, ...live];
    }
    const file = path.join(this.dir, `${this.state.runId}.json`);
    const tmp = `${file}.tmp-${process.pid}`;
    await fs.writeFile(tmp, JSON.stringify(this.state), 'utf8');
    await fs.rename(tmp, file);
  }
}

/** Removes journals not touched within maxAgeMs. Returns how many were removed. */
export async function pruneOldRuns(dir: string = RUNS_DIR, maxAgeMs: number = DEFAULT_MAX_AGE_MS): Promise<number> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  const cutoff = Date.now() - maxAgeMs;
  for (const name of names) {
    if (!name.endsWith('.json') && !name.includes('.json.tmp-')) continue;
    try {
      const full = path.join(dir, name);
      if ((await fs.stat(full)).mtimeMs < cutoff) {
        await fs.unlink(full);
        removed++;
      }
    } catch {
      // Raced with another delete; nothing to do.
    }
  }
  return removed;
}
