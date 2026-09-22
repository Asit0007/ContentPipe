import React, { useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronDown, Copy, Loader2, Package } from 'lucide-react';
import { VideoScript, VideoPlan, ResearchData } from '../types';

interface ScriptQualityPanelProps {
  videoScript: VideoScript;
  research?: ResearchData | null;
  plan?: VideoPlan | null;
  channelBrandName?: string;
  topicDomain?: string;
  onUpdateScript: (script: VideoScript) => void;
}

const SEVERITY_STYLE: Record<string, string> = {
  error: 'bg-rose-500/10 border-rose-500/30 text-rose-300',
  warn: 'bg-amber-500/10 border-amber-500/30 text-amber-300',
  info: 'bg-zinc-800/60 border-zinc-700 text-zinc-300',
};

/**
 * Everything the pipeline knows about how trustworthy this script is: canned-content and
 * shortfall banners, the deterministic audit, mid-roll placement, and the publish package.
 * Nothing here is model opinion — the audit is computed server-side from the scenes.
 */
export const ScriptQualityPanel: React.FC<ScriptQualityPanelProps> = ({ videoScript, research, plan, channelBrandName, topicDomain, onUpdateScript }) => {
  const [isBuilding, setIsBuilding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const checks = videoScript.qualityChecks || [];
  const errors = checks.filter((c) => c.severity === 'error').length;
  const gen = videoScript.generation;
  const pub = videoScript.publish;

  const buildPublishPackage = async () => {
    setIsBuilding(true);
    setError(null);
    try {
      // Generated stills and audio are large and irrelevant to titles/description; don't ship them.
      const slim = {
        ...videoScript,
        publish: undefined,
        scenes: videoScript.scenes.map(({ generatedImageUrl, generatedAudioBase64, ...rest }) => rest),
      };
      const response = await fetch('/api/publish-package', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ script: slim, research, plan, channelBrandName, topicDomain }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Publish package failed');
      onUpdateScript({ ...videoScript, publish: data });
    } catch (err: any) {
      setError(err.message || 'Could not build the publish package.');
    } finally {
      setIsBuilding(false);
    }
  };

  const copyDescription = async () => {
    if (!pub?.description) return;
    try {
      await navigator.clipboard.writeText(pub.description);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable (insecure context) — the text is visible to select by hand */
    }
  };

  return (
    <div className="space-y-4">
      {videoScript.isQuotaFallback && (
        <div className="rounded-xl border border-rose-500/40 bg-rose-950/40 p-4 text-xs text-rose-200 flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
          <span>
            <strong>Canned placeholder script.</strong> AI generation was unavailable, so this is sample content about a different story, not a real
            draft. Do not export or publish it — regenerate once quota is back.
          </span>
        </div>
      )}

      {gen && !gen.complete && !videoScript.isQuotaFallback && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-950/30 p-4 text-xs text-amber-200 space-y-1.5">
          <div className="flex items-center gap-2 font-semibold">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            Incomplete script: {gen.producedScenes}/{gen.requestedScenes} scenes, ~{gen.producedDurationSec}s of a {gen.requestedDurationSec}s target
          </div>
          <ul className="list-disc pl-6 space-y-0.5 text-amber-300/90">
            {gen.degraded.map((d, i) => (
              <li key={i}>{d}</li>
            ))}
          </ul>
        </div>
      )}

      {(checks.length > 0 || (videoScript.midrollMarkers?.length ?? 0) > 0) && (
        <details open={errors > 0} className="group rounded-xl border border-zinc-800 bg-zinc-900/60">
          <summary className="flex items-center justify-between cursor-pointer list-none p-3.5 text-xs font-semibold text-zinc-300">
            <span className="flex items-center gap-2">
              {errors > 0 ? <AlertTriangle className="h-4 w-4 text-rose-400" /> : <CheckCircle2 className="h-4 w-4 text-emerald-400" />}
              Retention &amp; compliance audit
              <span className="font-normal text-zinc-500">
                {checks.length === 0 ? 'nothing flagged' : `${errors} error${errors === 1 ? '' : 's'}, ${checks.length - errors} other`}
              </span>
            </span>
            <ChevronDown className="h-4 w-4 text-zinc-500 transition-transform group-open:rotate-180" />
          </summary>
          <div className="px-3.5 pb-3.5 space-y-2">
            <p className="text-[11px] text-zinc-500">Computed from the scenes themselves — no model involved. It does not replace the manual checklist in the exported brief.</p>
            {videoScript.midrollMarkers?.map((m) => (
              <div key={m.index} className="rounded-lg border border-sky-500/30 bg-sky-500/10 px-3 py-2 text-[11px] text-sky-200">
                <strong>Mid-roll #{m.index} at {m.timestamp}</strong> — {m.reason}
              </div>
            ))}
            {checks.map((c, i) => (
              <div key={i} className={`rounded-lg border px-3 py-2 text-[11px] ${SEVERITY_STYLE[c.severity] || SEVERITY_STYLE.info}`}>
                <span className="font-bold uppercase tracking-wide mr-1.5">{c.severity}</span>
                {c.message}
                {c.sceneNumbers?.length ? <span className="opacity-70"> (scenes {c.sceneNumbers.slice(0, 12).join(', ')}{c.sceneNumbers.length > 12 ? '…' : ''})</span> : null}
              </div>
            ))}
          </div>
        </details>
      )}

      <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-3.5 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <span className="flex items-center gap-2 text-xs font-semibold text-zinc-300">
            <Package className="h-4 w-4 text-orange-400" /> Publish package
            <span className="font-normal text-zinc-500">titles · thumbnails · description · tags</span>
          </span>
          <button
            id="build-publish-package-button"
            type="button"
            onClick={buildPublishPackage}
            disabled={isBuilding}
            className="inline-flex items-center gap-1.5 rounded-lg bg-orange-600 hover:bg-orange-500 disabled:opacity-60 px-3 py-1.5 text-xs font-semibold text-white transition-colors"
          >
            {isBuilding ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Package className="h-3.5 w-3.5" />}
            {pub ? 'Regenerate' : 'Generate'}
          </button>
        </div>
        {error && <div className="text-[11px] text-rose-300">{error}</div>}

        {pub && (
          <div className="space-y-3 text-[11px] text-zinc-300">
            {pub.deterministicOnly && (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-amber-200">
                AI generation was unavailable: no titles, thumbnails or tags were produced. Only chapters, mid-rolls and sources below.
              </div>
            )}
            {pub.recommendedTitle && (
              <div>
                <span className="text-zinc-500">Recommended (by the linter): </span>
                <strong className="text-white">{pub.recommendedTitle}</strong>
                {pub.recommendedThumbnail && <span className="text-zinc-500"> · thumbnail {pub.recommendedThumbnail}</span>}
              </div>
            )}
            {pub.titles.length > 0 && (
              <ul className="space-y-1">
                {pub.titles.map((t, i) => (
                  <li key={i} className="flex items-start gap-2">
                    <span className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold ${t.passesLint ? 'bg-emerald-500/15 text-emerald-300' : 'bg-rose-500/15 text-rose-300'}`}>
                      {t.passesLint ? 'PASS' : 'FAIL'}
                    </span>
                    <span>
                      {t.title} <span className="text-zinc-500">({t.chars})</span>
                      {t.lint.filter((l) => l.severity !== 'info').map((l, j) => (
                        <span key={j} className="block text-zinc-500">↳ {l.message}</span>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {pub.thumbnails.length > 0 && (
              <ul className="space-y-1">
                {pub.thumbnails.map((t) => (
                  <li key={t.variant}>
                    <strong>{t.variant} · {t.concept}</strong> — overlay “{t.textOverlay}”
                    <span className="block text-zinc-500">{t.imagePrompt}</span>
                  </li>
                ))}
              </ul>
            )}
            {pub.description && (
              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-zinc-500">Description ({pub.descriptionWordCount} words)</span>
                  <button type="button" onClick={copyDescription} className="inline-flex items-center gap-1 text-zinc-400 hover:text-white">
                    <Copy className="h-3 w-3" /> {copied ? 'Copied' : 'Copy'}
                  </button>
                </div>
                <pre className="whitespace-pre-wrap rounded-lg bg-zinc-950 border border-zinc-800 p-3 text-[11px] leading-relaxed text-zinc-300 max-h-72 overflow-auto">{pub.description}</pre>
              </div>
            )}
            {pub.todos.length > 0 && (
              <ul className="list-disc pl-5 space-y-0.5 text-amber-300/90">
                {pub.todos.map((t, i) => (
                  <li key={i}>{t}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
