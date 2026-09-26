import React, { useEffect, useState } from 'react';
import { Cpu, ChevronDown, CheckCircle2, XCircle, History } from 'lucide-react';
import type { ModelCall, WorkflowStep } from '../types';
import { modelInfo, providerInfo, type LineupEntry, type ModelLineup } from '../../shared/modelCatalog';
import { useSessionModelCalls } from '../utils/modelUsageLog';

/**
 * "AI models on this page": what the page is configured to try (GET /api/models, from the live .env) and which model
 * actually produced what is on screen (the `modelUsage` each response carries). The two can differ a lot — the chain
 * skips a busy or rate-limited model — so both are shown, and a result's rows are the ones to trust.
 */

type Capability = 'text' | 'speech' | 'image' | 'podcastSpeech';

const PAGE_LINEUPS: Record<string, Array<{ cap: Capability; label: string; usedFor: string }>> = {
  telegram: [{ cap: 'text', label: 'Text models', usedFor: 'Pressing Research reads your source links (no AI), then one text model writes the cited dossier.' }],
  research: [{ cap: 'text', label: 'Text models', usedFor: 'One call writes the research dossier from the fetched sources.' }],
  plan: [{ cap: 'text', label: 'Text models', usedFor: 'One call writes the video blueprint (acts, hook, pacing).' }],
  script: [
    { cap: 'text', label: 'Text models', usedFor: 'Production bible, the narrative in chunks of 3 scenes, art direction in chunks of 6, and the publish package.' },
    { cap: 'speech', label: 'Narration (text-to-speech)', usedFor: 'Voice a scene with the Audio button.' },
    { cap: 'image', label: 'Scene images', usedFor: 'Draw a scene still with the Image button.' },
  ],
  studio: [
    { cap: 'speech', label: 'Narration (text-to-speech)', usedFor: 'Voice every scene (Generate all).' },
    { cap: 'image', label: 'Scene images', usedFor: 'Draw every scene still (Generate all).' },
    { cap: 'text', label: 'Text models', usedFor: 'Write the two-host podcast dialogue.' },
    { cap: 'podcastSpeech', label: 'Podcast audio', usedFor: 'Read the podcast as one audio file.' },
  ],
};

// One fetch per page load; every panel shares it.
let lineupPromise: Promise<ModelLineup> | null = null;
export function loadLineup(): Promise<ModelLineup> {
  if (!lineupPromise) {
    lineupPromise = fetch('/api/models')
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        // An HTML page here means the running server predates this route (Vite hot-reloads the UI, `tsx` does
        // not reload the server) and the request fell through to index.html.
        if (!(r.headers.get('content-type') || '').includes('json')) {
          throw new Error('the server is older than this page; restart `npm run dev`');
        }
        return r.json();
      })
      .catch((err) => {
        lineupPromise = null; // let the next panel try again
        throw err;
      });
  }
  return lineupPromise;
}

export function displayName(model?: string): string {
  return modelInfo(model)?.name || model || 'unknown';
}

function seconds(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

const OUTCOME_LABEL: Record<string, string> = {
  quota: 'quota / rate limit',
  overloaded: 'overloaded',
  invalid_output: 'unusable answer',
  error: 'error',
  skipped: 'skipped',
};

const LineupList: React.FC<{ entries: LineupEntry[]; intelligenceSource: string }> = ({ entries, intelligenceSource }) => {
  if (entries.length === 0) return <p className="text-xs text-zinc-500">No model is configured for this.</p>;
  return (
    <ol className="space-y-1.5">
      {entries.map((e) => (
        <li key={`${e.provider}:${e.model}`} className="rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="text-[11px] font-mono text-zinc-500">#{e.rank}</span>
            <span className="text-xs font-semibold text-zinc-100">{e.info?.name || e.model}</span>
            <span className="text-[11px] text-zinc-400">{e.info?.maker ? `${e.info.maker} · ` : ''}via {e.providerInfo?.label || e.provider}</span>
            {e.info?.intelligence !== undefined && (
              <span className="rounded bg-orange-500/10 border border-orange-500/20 px-1.5 text-[10px] font-semibold text-orange-300" title={intelligenceSource}>
                Intelligence {e.info.intelligence}
              </span>
            )}
          </div>
          <div className="mt-0.5 text-[11px] text-zinc-500">
            <code className="text-zinc-400 break-all">{e.model}</code>
            {e.providerInfo?.cost ? ` · ${e.providerInfo.cost}` : ''}
          </div>
          {e.info?.notes && <div className="mt-0.5 text-[11px] text-zinc-400">{e.info.notes}</div>}
        </li>
      ))}
    </ol>
  );
};

const CallRow: React.FC<{ call: ModelCall }> = ({ call }) => {
  const winner = call.attempts.find((a) => a.outcome === 'ok');
  const failed = call.attempts.filter((a) => a.outcome !== 'ok');
  const prov = providerInfo(call.provider);
  return (
    <li className="rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {call.ok ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-400" /> : <XCircle className="h-3.5 w-3.5 shrink-0 text-rose-400" />}
        <span className="text-xs font-semibold text-zinc-200">{call.task}</span>
        {call.fromCheckpoint && (
          <span className="inline-flex items-center gap-1 rounded bg-zinc-800 px-1.5 text-[10px] text-zinc-400" title="Written by an earlier, interrupted run of this script and reused from its checkpoint">
            <History className="h-3 w-3" /> from checkpoint
          </span>
        )}
      </div>
      <div className="mt-1 text-[11px] text-zinc-400">
        {call.ok && call.model ? (
          <>
            Written by <span className="font-semibold text-zinc-100">{displayName(call.model)}</span>
            {modelInfo(call.model)?.maker ? ` (${modelInfo(call.model)!.maker})` : ''} via {prov?.label || call.provider} ·{' '}
            <code className="text-zinc-500 break-all">{call.model}</code>
          </>
        ) : (
          <span className="text-rose-300">No model answered{call.kind === 'image' ? ' — a placeholder was used' : call.kind === 'speech' ? ' — a synthesized tone was used' : ' — canned or partial content'}.</span>
        )}
      </div>
      <div className="mt-0.5 text-[11px] text-zinc-500">
        {seconds(call.ms)} total
        {winner?.inputTokens || winner?.outputTokens ? ` · ${winner.inputTokens ?? '?'} tokens in, ${winner.outputTokens ?? '?'} out` : ''}
        {failed.length > 0 && ` · ${failed.length} model${failed.length === 1 ? '' : 's'} tried first`}
      </div>
      {failed.length > 0 && (
        <ul className="mt-1 space-y-0.5 border-l border-zinc-800 pl-2">
          {failed.map((a, i) => (
            <li key={i} className="text-[11px] text-zinc-500">
              <span className="text-zinc-400">{displayName(a.model)}</span> ({a.provider}): {OUTCOME_LABEL[a.outcome] || a.outcome}
              {a.detail ? ` — ${a.detail}` : ''}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
};

/** "Gemma 4 31B ×5, Gemini 3.1 Flash-Lite ×2" */
function summarize(calls: ModelCall[]): string {
  const counts = new Map<string, number>();
  for (const c of calls) {
    const key = c.ok && c.model ? displayName(c.model) : 'no model (fallback)';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name)).join(', ');
}

interface ModelsPanelProps {
  page: WorkflowStep;
  /** Calls behind the result shown on this page (e.g. researchData.modelUsage). */
  calls?: ModelCall[];
}

export const ModelsPanel: React.FC<ModelsPanelProps> = ({ page, calls = [] }) => {
  const [open, setOpen] = useState(false);
  const [lineup, setLineup] = useState<ModelLineup | null>(null);
  const [lineupError, setLineupError] = useState<string | null>(null);
  const sessionCalls = useSessionModelCalls(page);
  const allCalls = [...calls, ...sessionCalls];
  const sections = PAGE_LINEUPS[page] ?? [];

  useEffect(() => {
    let alive = true;
    loadLineup()
      .then((l) => alive && setLineup(l))
      .catch((err) => alive && setLineupError(err?.message || 'unavailable'));
    return () => {
      alive = false;
    };
  }, []);

  if (sections.length === 0) return null;

  return (
    <section className="mx-auto mb-6 max-w-5xl rounded-2xl border border-zinc-800 bg-zinc-900/50">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
      >
        <span className="flex min-w-0 items-center gap-2">
          <Cpu className="h-4 w-4 shrink-0 text-orange-400" />
          <span className="text-xs font-semibold uppercase tracking-wider text-zinc-300">AI models on this page</span>
          <span className="truncate text-xs text-zinc-500">
            {allCalls.length > 0 ? `· ${summarize(allCalls)}` : lineup ? `· ${sections.map((s) => s.label.toLowerCase()).join(', ')}` : ''}
          </span>
        </span>
        <ChevronDown className={`h-4 w-4 shrink-0 text-zinc-500 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="space-y-5 border-t border-zinc-800 px-4 py-4">
          <div>
            <h3 className="mb-2 text-[11px] font-bold uppercase tracking-wider text-zinc-400">What produced this page</h3>
            {allCalls.length > 0 ? (
              <ul className="space-y-1.5">
                {allCalls.map((c, i) => (
                  <CallRow key={`${c.startedAt}-${i}`} call={c} />
                ))}
              </ul>
            ) : (
              <p className="text-xs text-zinc-500">
                Nothing generated on this page yet{page === 'telegram' ? ': this page only collects the story' : ''}. Once something is, each call is listed with the model that answered and any model skipped before it.
              </p>
            )}
          </div>

          <div>
            <h3 className="mb-1 text-[11px] font-bold uppercase tracking-wider text-zinc-400">Configured models, in the order they are tried</h3>
            {lineup && <p className="mb-3 text-[11px] text-zinc-500">Text order: {lineup.textOrderSource}. The first model that gives a usable answer wins; busy or rate-limited ones are skipped.</p>}
            {lineupError && <p className="text-xs text-rose-300">Could not load the model list ({lineupError}).</p>}
            {!lineup && !lineupError && <p className="text-xs text-zinc-500">Loading…</p>}
            {lineup && (
              <div className="grid gap-4 md:grid-cols-2">
                {sections.map((s) => (
                  <div key={s.cap}>
                    <div className="text-xs font-semibold text-zinc-200">{s.label}</div>
                    <p className="mb-2 text-[11px] text-zinc-500">
                      {s.usedFor}
                      {s.cap === 'speech' && lineup.voices.length ? ` Voices: ${lineup.voices.join(', ')}.` : ''}
                    </p>
                    <LineupList entries={lineup[s.cap]} intelligenceSource={lineup.intelligenceSource} />
                  </div>
                ))}
              </div>
            )}
            {lineup && sections.some((s) => s.cap === 'text') && (
              <p className="mt-3 text-[11px] text-zinc-600">Intelligence scores: {lineup.intelligenceSource}; not measured in this pipeline.</p>
            )}
          </div>
        </div>
      )}
    </section>
  );
};
