import React, { useState } from 'react';
import { FileText, Sparkles, ArrowRight, Clock, Smartphone, Monitor, Flame, Layers, Sliders, CheckCircle2, ShieldCheck, RefreshCw } from 'lucide-react';
import { VideoPlan } from '../types';

interface PlanStageProps {
  videoPlan: VideoPlan | null;
  isLoading: boolean;
  onProceedToScript: () => void;
  onUpdatePlan: (updated: VideoPlan) => void;
  onRegeneratePlan: () => void;
}

export const PlanStage: React.FC<PlanStageProps> = ({
  videoPlan,
  isLoading,
  onProceedToScript,
  onUpdatePlan,
  onRegeneratePlan,
}) => {
  const [format, setFormat] = useState<'9:16' | '16:9'>(videoPlan?.format || '9:16');
  const [tone, setTone] = useState<VideoPlan['tone']>(videoPlan?.tone || 'Witty Tech & Sarcastic');

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[400px] rounded-2xl border border-zinc-800 bg-zinc-900/50 p-8 text-center space-y-4">
        <div className="relative">
          <div className="h-16 w-16 rounded-2xl bg-orange-500/10 border border-orange-500/30 flex items-center justify-center animate-pulse">
            <FileText className="h-8 w-8 text-orange-400 animate-bounce" />
          </div>
        </div>
        <div className="space-y-1 max-w-md">
          <h3 className="text-lg font-bold text-white">Directing Video Blueprint & Narrative Arc</h3>
          <p className="text-xs text-zinc-400">
            Structuring the 5-act storytelling arc, calibrating retention hooks, defining visual motifs, and timing pacing beats for maximum viewer engagement...
          </p>
        </div>
      </div>
    );
  }

  if (!videoPlan) {
    return (
      <div className="rounded-2xl border border-dashed border-zinc-800 bg-zinc-900/30 p-12 text-center">
        <p className="text-sm text-zinc-400">No video plan generated yet. Please complete research first.</p>
      </div>
    );
  }

  const handleFormatChange = (newFormat: '9:16' | '16:9') => {
    setFormat(newFormat);
    onUpdatePlan({ ...videoPlan, format: newFormat });
  };

  const handleToneChange = (newTone: VideoPlan['tone']) => {
    setTone(newTone);
    onUpdatePlan({ ...videoPlan, tone: newTone });
  };

  return (
    <div className="space-y-8 max-w-5xl mx-auto">
      {/* Top Banner with Controls */}
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-6 sm:p-8 shadow-xl space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="inline-flex items-center gap-2 rounded-full bg-orange-500/10 border border-orange-500/20 px-3 py-1 text-xs font-semibold text-orange-400">
            <FileText className="h-3.5 w-3.5" />
            <span>Video Blueprint • Stage 3 of 5</span>
          </div>

          <button
            onClick={onRegeneratePlan}
            className="flex items-center gap-1.5 text-xs text-zinc-400 hover:text-zinc-200 transition-colors self-start sm:self-auto"
          >
            <RefreshCw className="h-3.5 w-3.5" /> Regenerate Blueprint
          </button>
        </div>

        <div>
          <label htmlFor="plan-title-input" className="text-xs font-bold uppercase tracking-wider text-zinc-400">
            Working Video Title
          </label>
          <input
            id="plan-title-input"
            type="text"
            value={videoPlan.title}
            onChange={(e) => onUpdatePlan({ ...videoPlan, title: e.target.value })}
            className="mt-1 w-full bg-zinc-950/80 border border-zinc-800 rounded-xl px-4 py-2.5 text-lg font-bold text-white focus:outline-none focus:ring-1 focus:ring-orange-500"
          />
        </div>

        {/* Configuration Row: Format & Tone */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 pt-2 border-t border-zinc-800/80">
          {/* Format Selector */}
          <div>
            <span className="text-xs font-semibold text-zinc-400 block mb-2">Aspect Ratio & Format</span>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                id="format-9-16-button"
                onClick={() => handleFormatChange('9:16')}
                className={`flex items-center justify-center gap-2 rounded-lg py-2 px-3 text-xs font-medium border transition-all ${
                  format === '9:16'
                    ? 'border-orange-500 bg-orange-950/30 text-orange-300 font-bold'
                    : 'border-zinc-800 bg-zinc-950 text-zinc-400 hover:text-zinc-200'
                }`}
              >
                <Smartphone className="h-4 w-4" /> 9:16 (Shorts/TikTok)
              </button>
              <button
                type="button"
                id="format-16-9-button"
                onClick={() => handleFormatChange('16:9')}
                className={`flex items-center justify-center gap-2 rounded-lg py-2 px-3 text-xs font-medium border transition-all ${
                  format === '16:9'
                    ? 'border-orange-500 bg-orange-950/30 text-orange-300 font-bold'
                    : 'border-zinc-800 bg-zinc-950 text-zinc-400 hover:text-zinc-200'
                }`}
              >
                <Monitor className="h-4 w-4" /> 16:9 (YouTube)
              </button>
            </div>
          </div>

          {/* Tone Selector */}
          <div>
            <span className="text-xs font-semibold text-zinc-400 block mb-2">Narrative Infotainment Tone</span>
            <select
              id="plan-tone-select"
              value={tone}
              onChange={(e) => handleToneChange(e.target.value as VideoPlan['tone'])}
              className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-xs font-medium text-zinc-200 focus:outline-none focus:ring-1 focus:ring-orange-500"
            >
              <option value="Witty Tech & Sarcastic">Witty Tech & Sarcastic</option>
              <option value="Cyberpunk Drama">Cyberpunk Drama</option>
              <option value="Fast Tech Detective">Fast Tech Detective</option>
              <option value="Deep Dive Documentary">Deep Dive Documentary</option>
            </select>
          </div>

          {/* Target Duration */}
          <div>
            <span className="text-xs font-semibold text-zinc-400 block mb-2">Target Pacing Duration</span>
            <div className="flex items-center gap-2 bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-xs text-zinc-300">
              <Clock className="h-4 w-4 text-orange-400" />
              <span>~{videoPlan.targetDurationSec || 60} seconds total</span>
            </div>
          </div>
        </div>
      </div>

      {/* Storyboard Narrative Beats (5 Acts) */}
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-6 space-y-4 shadow-xl">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold uppercase tracking-wider text-zinc-200 flex items-center gap-2">
            <Layers className="h-4 w-4 text-orange-400" />
            <span>5-Act Storyboard Narrative Structure</span>
          </h3>
          <span className="text-xs text-zinc-400">{videoPlan.narrativeBeats?.length || 5} Beats</span>
        </div>

        <div className="space-y-3">
          {videoPlan.narrativeBeats?.map((beat, idx) => (
            <div
              key={idx}
              className="rounded-xl border border-zinc-800 bg-zinc-950/70 p-4 transition-all hover:border-zinc-700"
            >
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-2">
                <div className="flex items-center gap-2">
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-orange-500/20 text-[11px] font-bold text-orange-400">
                    {idx + 1}
                  </span>
                  <h4 className="text-sm font-bold text-white">{beat.act}</h4>
                </div>
                <div className="flex items-center gap-3 text-xs text-zinc-400">
                  <span className="rounded bg-zinc-900 px-2 py-0.5 font-mono text-[11px] text-zinc-300 border border-zinc-800">
                    ⏱️ {beat.durationSec}s
                  </span>
                </div>
              </div>

              <p className="text-xs sm:text-sm text-zinc-300 mb-2 leading-relaxed">
                <span className="font-semibold text-zinc-400">Purpose: </span>
                {beat.purpose}
              </p>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs pt-2 border-t border-zinc-900">
                <div className="text-zinc-400">
                  <span className="font-semibold text-orange-400">🎨 Visual Tone: </span>
                  {beat.visualTone}
                </div>
                <div className="text-zinc-400">
                  <span className="font-semibold text-emerald-400">🎯 Key Takeaway: </span>
                  {beat.keyTakeaway}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Retention Strategy & CTA */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-5 space-y-3">
          <h3 className="text-xs font-bold uppercase tracking-wider text-orange-400 flex items-center gap-1.5">
            <Flame className="h-4 w-4" /> Viral Retention Triggers
          </h3>
          <ul className="space-y-2">
            {videoPlan.viralRetentionHooks?.map((hook, i) => (
              <li key={i} className="flex items-start gap-2 text-xs text-zinc-300">
                <CheckCircle2 className="h-3.5 w-3.5 text-orange-400 shrink-0 mt-0.5" />
                <span>{hook}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="rounded-xl border border-zinc-800 bg-zinc-900 p-5 space-y-3">
          <h3 className="text-xs font-bold uppercase tracking-wider text-emerald-400 flex items-center gap-1.5">
            <ShieldCheck className="h-4 w-4" /> Signature Call to Action
          </h3>
          <div className="rounded-lg bg-zinc-950 p-3 border border-zinc-800 text-xs sm:text-sm font-medium text-zinc-200 italic">
            "{videoPlan.callToAction}"
          </div>
          <p className="text-[11px] text-zinc-500">Designed to trigger high comment velocity and algorithmic debate.</p>
        </div>
      </div>

      {/* Bottom Action */}
      <div className="flex items-center justify-end gap-3 pt-4 border-t border-zinc-800">
        <button
          id="proceed-to-script-button"
          onClick={onProceedToScript}
          className="flex items-center gap-2 rounded-xl bg-gradient-to-r from-orange-600 to-amber-500 px-6 py-3 text-sm font-semibold text-white shadow-lg shadow-orange-600/30 hover:from-orange-500 hover:to-amber-400 transition-all cursor-pointer"
        >
          <Sparkles className="h-4 w-4" />
          <span>Convert Blueprint to Scene-by-Scene Script</span>
          <ArrowRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
};
