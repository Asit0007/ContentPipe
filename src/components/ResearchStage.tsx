import React, { useState } from 'react';
import { Compass, Sparkles, ArrowRight, MessageSquare, Flame, CheckCircle2, RefreshCw, ExternalLink, Lightbulb, TrendingUp, ShieldAlert, Cpu } from 'lucide-react';
import { ResearchData } from '../types';

interface ResearchStageProps {
  researchData: ResearchData | null;
  isLoading: boolean;
  onProceedToPlan: (selectedAngle?: string) => void;
  onReResearch: () => void;
}

export const ResearchStage: React.FC<ResearchStageProps> = ({
  researchData,
  isLoading,
  onProceedToPlan,
  onReResearch,
}) => {
  const [selectedAngleIndex, setSelectedAngleIndex] = useState<number>(0);

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px] rounded-2xl border border-zinc-800 bg-zinc-900/50 p-8 text-center space-y-4">
        <div className="relative">
          <div className="h-16 w-16 rounded-2xl bg-orange-500/10 border border-orange-500/30 flex items-center justify-center animate-pulse">
            <Compass className="h-8 w-8 text-orange-400 animate-spin" style={{ animationDuration: '4s' }} />
          </div>
          <div className="absolute -top-1 -right-1 h-4 w-4 bg-orange-500 rounded-full animate-ping" />
        </div>
        <div className="space-y-1 max-w-md">
          <h3 className="text-lg font-bold text-white">Investigative Research Agent at Work</h3>
          <p className="text-xs text-zinc-400">
            Querying Google Search grounding, analyzing Hacker News discussion threads, synthesizing developer sentiments, and isolating high-retention infotainment angles...
          </p>
        </div>
      </div>
    );
  }

  if (!researchData) {
    return (
      <div className="rounded-2xl border border-dashed border-zinc-800 bg-zinc-900/30 p-12 text-center">
        <p className="text-sm text-zinc-400">No research data available yet. Please submit a Telegram message first.</p>
      </div>
    );
  }

  return (
    <div className="space-y-8 max-w-5xl mx-auto">
      {/* Topic Title & Hook Card */}
      <div className="rounded-2xl border border-orange-500/30 bg-gradient-to-br from-zinc-900 via-zinc-900 to-orange-950/20 p-6 sm:p-8 shadow-xl relative overflow-hidden">
        <div className="flex items-center justify-between gap-4 mb-3">
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-orange-500/10 border border-orange-500/20 px-3 py-1 text-xs font-semibold text-orange-400">
              <Compass className="h-3.5 w-3.5" />
              <span>Research Dossier • Stage 2 of 5</span>
            </span>
            {researchData.isQuotaFallback && (
              <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 border border-amber-500/20 px-2.5 py-0.5 text-[11px] font-semibold text-amber-300">
                ⚡ Quota Resilience Active
              </span>
            )}
          </div>
          <button
            onClick={onReResearch}
            className="flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
          >
            <RefreshCw className="h-3 w-3" /> Re-run Research
          </button>
        </div>

        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-white leading-tight">
          {researchData.topicTitle}
        </h1>

        <div className="mt-4 rounded-xl bg-orange-500/10 border border-orange-500/20 p-4">
          <div className="text-[11px] font-bold uppercase tracking-wider text-orange-400 flex items-center gap-1.5 mb-1">
            <Flame className="h-3.5 w-3.5" /> Viral Retention Hook (Opening 3 Seconds)
          </div>
          <p className="text-sm sm:text-base font-semibold text-zinc-100 italic">
            "{researchData.oneLineHook}"
          </p>
        </div>
      </div>

      {/* Grid: Core Explanation & HN Sentiment */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Technical & Story Summary */}
        <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-5 space-y-4 shadow-lg">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-zinc-300 flex items-center gap-2">
            <Cpu className="h-4 w-4 text-emerald-400" />
            <span>Core Tech & Incident Breakdown</span>
          </h3>

          <div className="space-y-3">
            <div>
              <span className="text-xs font-bold text-zinc-400 uppercase tracking-wide">Executive Summary</span>
              <p className="text-xs sm:text-sm text-zinc-200 mt-1 leading-relaxed">{researchData.summary}</p>
            </div>

            <div className="rounded-lg bg-zinc-950/80 p-3.5 border border-zinc-800">
              <span className="text-xs font-bold text-emerald-400 uppercase tracking-wide flex items-center gap-1.5 mb-1">
                <Lightbulb className="h-3.5 w-3.5" /> Under the Hood (Analogy)
              </span>
              <p className="text-xs text-zinc-300 leading-relaxed">{researchData.coreTechExplanation}</p>
            </div>

            <div>
              <span className="text-xs font-bold text-zinc-400 uppercase tracking-wide">Key Facts & Milestones</span>
              <ul className="mt-1.5 space-y-1.5">
                {researchData.keyFacts?.map((fact, idx) => (
                  <li key={idx} className="flex items-start gap-2 text-xs text-zinc-300">
                    <CheckCircle2 className="h-3.5 w-3.5 text-orange-400 shrink-0 mt-0.5" />
                    <span>{fact}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>

        {/* Hacker News Sentiment & Debate */}
        <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-5 space-y-4 shadow-lg">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-zinc-300 flex items-center gap-2">
            <MessageSquare className="h-4 w-4 text-orange-400" />
            <span>Hacker News Frontpage Pulse & Debates</span>
          </h3>

          <div className="space-y-3">
            <div className="rounded-lg bg-zinc-950/80 p-3 border border-zinc-800">
              <span className="text-[11px] font-bold text-amber-400 uppercase tracking-wide">Community Consensus</span>
              <p className="text-xs text-zinc-300 mt-1">{researchData.hnCommunitySentiment?.consensus}</p>
            </div>

            <div className="rounded-lg bg-zinc-950/80 p-3 border border-zinc-800">
              <span className="text-[11px] font-bold text-rose-400 uppercase tracking-wide">The Cynical / Contrarian Take</span>
              <p className="text-xs text-zinc-300 mt-1">{researchData.hnCommunitySentiment?.contrarianView}</p>
            </div>

            <div>
              <span className="text-xs font-bold text-zinc-400 uppercase tracking-wide">Top Quoted HN Comments</span>
              <div className="mt-2 space-y-2">
                {researchData.hnCommunitySentiment?.topHnComments?.map((c, i) => (
                  <div key={i} className="rounded-lg bg-zinc-950/60 p-2.5 border border-zinc-800/80 text-xs">
                    <div className="flex items-center justify-between text-[11px] text-zinc-500 mb-1">
                      <span className="font-mono text-orange-400">@{c.author}</span>
                      <span className="text-zinc-400">{c.karma} points • vibe: {c.vibe}</span>
                    </div>
                    <p className="text-zinc-300 italic">"{c.comment}"</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Selectable Infotainment Video Angles */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-5 space-y-4 shadow-lg">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-zinc-300 flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-orange-400" />
            <span>Choose Your Infotainment Video Angle</span>
          </h3>
          <span className="text-xs text-zinc-500">Pick one to guide the video blueprint</span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {researchData.infotainmentAngles?.map((angle, idx) => {
            const isSelected = selectedAngleIndex === idx;
            return (
              <div
                key={idx}
                id={`infotainment-angle-${idx}`}
                onClick={() => setSelectedAngleIndex(idx)}
                className={`cursor-pointer rounded-xl border p-4 transition-all flex flex-col justify-between ${
                  isSelected
                    ? 'border-orange-500 bg-orange-950/30 ring-1 ring-orange-500/40 shadow-md'
                    : 'border-zinc-800 bg-zinc-950/60 hover:border-zinc-700'
                }`}
              >
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-orange-400">Angle #{idx + 1}</span>
                    {isSelected && <CheckCircle2 className="h-4 w-4 text-orange-400" />}
                  </div>
                  <h4 className="text-sm font-bold text-zinc-100 mb-1">{angle.title}</h4>
                  <p className="text-xs text-zinc-300 italic mb-2">"{angle.hook}"</p>
                </div>
                <div className="mt-2 pt-2 border-t border-zinc-800/80 text-[11px] text-zinc-400">
                  <span className="font-semibold text-zinc-300">Why it works:</span> {angle.whyItGoesViral}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Sources & Citations */}
      {researchData.groundingSources && researchData.groundingSources.length > 0 && (
        <div className="rounded-xl border border-zinc-800/80 bg-zinc-950/60 p-4 text-xs text-zinc-400">
          <span className="font-bold text-zinc-300 uppercase tracking-wider block mb-2">
            Google Search Grounding Sources
          </span>
          <div className="flex flex-wrap gap-2">
            {researchData.groundingSources.map((source, idx) => (
              <a
                key={idx}
                href={source.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 rounded-md bg-zinc-900 border border-zinc-800 px-2.5 py-1 text-zinc-300 hover:text-orange-300 hover:border-orange-500/40 transition-colors"
              >
                <ExternalLink className="h-3 w-3" />
                <span className="truncate max-w-[200px]">{source.title}</span>
              </a>
            ))}
          </div>
        </div>
      )}

      {/* Bottom Action Bar */}
      <div className="flex items-center justify-end gap-3 pt-4 border-t border-zinc-800">
        <button
          id="proceed-to-plan-button"
          onClick={() => onProceedToPlan(researchData.infotainmentAngles?.[selectedAngleIndex]?.title)}
          className="flex items-center gap-2 rounded-xl bg-gradient-to-r from-orange-600 to-amber-500 px-6 py-3 text-sm font-semibold text-white shadow-lg shadow-orange-600/30 hover:from-orange-500 hover:to-amber-400 transition-all cursor-pointer"
        >
          <Sparkles className="h-4 w-4" />
          <span>Generate Video Production Blueprint</span>
          <ArrowRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
};
