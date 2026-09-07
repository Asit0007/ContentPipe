import React, { useState } from 'react';
import { Send, ArrowRight, MessageSquare, Flame, CheckCircle2, Sparkles, RefreshCw, Layers, Radio, PenTool, Link2, FileText, Trash2 } from 'lucide-react';
import { TelegramMessage } from '../types';
import { SAMPLE_TELEGRAM_MESSAGES } from '../data/sampleMessages';

interface TelegramIngestionProps {
  currentMessage: TelegramMessage;
  onUpdateMessage: (msg: TelegramMessage) => void;
  onStartResearch: (msg: TelegramMessage) => void;
  isLoading: boolean;
}

export const TelegramIngestion: React.FC<TelegramIngestionProps> = ({
  currentMessage,
  onUpdateMessage,
  onStartResearch,
  isLoading,
}) => {
  const [inputMode, setInputMode] = useState<'custom' | 'telegram' | 'presets'>('custom');
  const [customText, setCustomText] = useState(currentMessage.text);
  const [channelName, setChannelName] = useState(currentMessage.channelName || 'Custom Input');
  const [senderHandle, setSenderHandle] = useState(currentMessage.senderHandle || '@techlead');
  const [selectedSampleId, setSelectedSampleId] = useState<string>(SAMPLE_TELEGRAM_MESSAGES[0].id);

  const handleSelectSample = (sample: TelegramMessage) => {
    setSelectedSampleId(sample.id);
    setCustomText(sample.text);
    setChannelName(sample.channelName);
    setSenderHandle(sample.senderHandle);
    onUpdateMessage(sample);
  };

  const handleClear = () => {
    setCustomText('');
  };

  const handleCustomSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!customText.trim()) return;

    const updated: TelegramMessage = {
      ...currentMessage,
      text: customText.trim(),
      channelName: channelName.trim() || 'Custom Story',
      senderHandle: senderHandle.trim() || '@creator',
      timestamp: 'Just now',
    };
    onUpdateMessage(updated);
    onStartResearch(updated);
  };

  return (
    <div className="space-y-8 max-w-5xl mx-auto">
      {/* Top Banner / Concept Explainer */}
      <div className="rounded-2xl border border-zinc-800 bg-gradient-to-b from-zinc-900/90 to-zinc-950 p-6 sm:p-8 shadow-xl relative overflow-hidden">
        <div className="absolute top-0 right-0 w-96 h-96 bg-orange-500/5 rounded-full blur-3xl pointer-events-none" />
        
        <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-6">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full bg-orange-500/10 border border-orange-500/20 px-3 py-1 text-xs font-semibold text-orange-400 mb-3">
              <Radio className="h-3.5 w-3.5 animate-pulse" />
              <span>Stage 1 of 4 • Story & Topic Input</span>
            </div>
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-white">
              Transform Any Tech Topic into an Amazing Infotainment Script
            </h1>
            <p className="mt-2 text-sm sm:text-base text-zinc-400 max-w-2xl leading-relaxed">
              Provide any story, breaking news, Hacker News controversy, Telegram message, or raw prompt. Our agentic pipeline runs deep web research, extracts viral angles, builds a retention blueprint, and writes a detailed, master-grade scene script.
            </p>
          </div>
        </div>
      </div>

      {/* Input Mode Selector Bar */}
      <div className="flex items-center justify-between gap-4 border-b border-zinc-800 pb-3">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setInputMode('custom')}
            className={`flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all ${
              inputMode === 'custom'
                ? 'bg-orange-500 text-white shadow-sm shadow-orange-500/30'
                : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900'
            }`}
          >
            <PenTool className="h-3.5 w-3.5" />
            <span>Custom Topic / Prompt</span>
          </button>
          <button
            type="button"
            onClick={() => setInputMode('telegram')}
            className={`flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all ${
              inputMode === 'telegram'
                ? 'bg-orange-500 text-white shadow-sm shadow-orange-500/30'
                : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900'
            }`}
          >
            <MessageSquare className="h-3.5 w-3.5" />
            <span>Telegram Forward</span>
          </button>
          <button
            type="button"
            onClick={() => setInputMode('presets')}
            className={`flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all ${
              inputMode === 'presets'
                ? 'bg-orange-500 text-white shadow-sm shadow-orange-500/30'
                : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900'
            }`}
          >
            <Flame className="h-3.5 w-3.5" />
            <span>Trending HN Presets</span>
          </button>
        </div>

        <div className="hidden sm:flex items-center gap-2 text-xs text-zinc-500">
          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
          <span>Gemini 3.7 Flash Research Engine Ready</span>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left column: Input Form Area (8 cols) */}
        <div className="lg:col-span-8 space-y-4">
          <form onSubmit={handleCustomSubmit} className="rounded-2xl border border-zinc-800 bg-zinc-900 p-6 space-y-5 shadow-xl">
            {/* Header info */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-zinc-800 pb-4">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-xl bg-orange-500/10 border border-orange-500/20 flex items-center justify-center text-orange-400 font-bold text-sm">
                  {inputMode === 'telegram' ? 'TG' : 'HN'}
                </div>
                <div>
                  <label className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider block">
                    Source Channel / Topic Label
                  </label>
                  <input
                    type="text"
                    id="input-channel-name"
                    value={channelName}
                    onChange={(e) => setChannelName(e.target.value)}
                    placeholder="e.g. Hacker News Frontpage, @techinsider, or My Notes"
                    className="bg-transparent text-sm font-semibold text-white focus:outline-none focus:ring-1 focus:ring-orange-500 rounded px-1.5 -ml-1.5 py-0.5"
                  />
                </div>
              </div>

              <div className="flex items-center gap-2">
                {customText.length > 0 && (
                  <button
                    type="button"
                    onClick={handleClear}
                    className="flex items-center gap-1 text-xs text-zinc-400 hover:text-rose-400 transition-colors px-2 py-1 rounded bg-zinc-800/50 hover:bg-zinc-800"
                  >
                    <Trash2 className="h-3 w-3" />
                    <span>Clear</span>
                  </button>
                )}
                <span className="text-xs text-zinc-500 font-mono bg-zinc-950 px-2 py-1 rounded border border-zinc-800">
                  {customText.length} chars
                </span>
              </div>
            </div>

            {/* Rich Textarea */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label htmlFor="story-input-textarea" className="text-xs font-semibold uppercase tracking-wider text-zinc-300 flex items-center gap-1.5">
                  <PenTool className="h-3.5 w-3.5 text-orange-400" />
                  <span>Your Story, Topic, or News Input</span>
                </label>
                <span className="text-[11px] text-zinc-500">
                  Paste full text, bullets, link summaries, or raw controversy
                </span>
              </div>

              <textarea
                id="story-input-textarea"
                rows={9}
                value={customText}
                onChange={(e) => setCustomText(e.target.value)}
                placeholder="Type or paste your topic here. For example:
- A breakthrough AI model or library release
- A controversial pull request or engineering architecture debate on Hacker News
- An incident postmortem, Linux kernel bug, or distributed systems outage
- Your startup pitch or engineering technical deep dive..."
                className="w-full rounded-xl bg-zinc-950/90 border border-zinc-800 p-4 text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-orange-500 focus:ring-1 focus:ring-orange-500 resize-y leading-relaxed font-sans transition-all"
              />
            </div>

            {/* Quick Inspiration Pills */}
            <div className="space-y-2 pt-1">
              <span className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider block">
                Quick Story Starters (Click to insert)
              </span>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => setCustomText('The SQLite creator explains why SQLite uses 100% C instead of Rust, sparking a massive 800-comment debate on Hacker News about memory safety vs. backwards compatibility.')}
                  className="rounded-lg bg-zinc-800/70 hover:bg-zinc-800 text-[11px] text-zinc-300 hover:text-white px-2.5 py-1.5 transition-all border border-zinc-700/60"
                >
                  ⚡ SQLite: C vs. Rust Debate
                </button>
                <button
                  type="button"
                  onClick={() => setCustomText('DeepSeek announces a radical new transformer architecture with Multi-Head Latent Attention that cut training costs by 90%, igniting intense algorithmic audits across Silicon Valley.')}
                  className="rounded-lg bg-zinc-800/70 hover:bg-zinc-800 text-[11px] text-zinc-300 hover:text-white px-2.5 py-1.5 transition-all border border-zinc-700/60"
                >
                  🤖 DeepSeek Attention Breakthrough
                </button>
                <button
                  type="button"
                  onClick={() => setCustomText('A single BPF kernel patch caused a cascading outage across tier-1 cloud infrastructure. The postmortem reveals an unchecked pointer arithmetic assumption.')}
                  className="rounded-lg bg-zinc-800/70 hover:bg-zinc-800 text-[11px] text-zinc-300 hover:text-white px-2.5 py-1.5 transition-all border border-zinc-700/60"
                >
                  🚨 BPF Cloud Outage Postmortem
                </button>
                <button
                  type="button"
                  onClick={() => setCustomText('A solo developer built an open-source database engine with 900 lines of code that beats Redis in micro-benchmarks by stripping virtual memory overhead.')}
                  className="rounded-lg bg-zinc-800/70 hover:bg-zinc-800 text-[11px] text-zinc-300 hover:text-white px-2.5 py-1.5 transition-all border border-zinc-700/60"
                >
                  🔥 900-Line Redis Killer
                </button>
              </div>
            </div>

            {/* Action Submit Button */}
            <button
              type="submit"
              id="start-research-agent-button"
              disabled={isLoading || !customText.trim()}
              className="w-full flex items-center justify-center gap-2.5 rounded-xl bg-gradient-to-r from-orange-600 to-amber-500 px-6 py-3.5 text-sm sm:text-base font-bold text-white shadow-xl shadow-orange-600/25 hover:from-orange-500 hover:to-amber-400 transition-all disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
            >
              {isLoading ? (
                <>
                  <RefreshCw className="h-5 w-5 animate-spin" />
                  <span>Agent is Researching & Formulating Viral Angles...</span>
                </>
              ) : (
                <>
                  <Sparkles className="h-5 w-5" />
                  <span>Start Deep Research & Story Analysis</span>
                  <ArrowRight className="h-5 w-5" />
                </>
              )}
            </button>
          </form>
        </div>

        {/* Right column: Feed Samples & Workflow Roadmap (4 cols) */}
        <div className="lg:col-span-4 space-y-4">
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-5 space-y-4 shadow-lg">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-bold uppercase tracking-wider text-zinc-300 flex items-center gap-1.5">
                <Flame className="h-4 w-4 text-orange-400" />
                <span>Curated HN Feed Samples</span>
              </h3>
              <span className="text-[11px] text-zinc-500">Pick to test</span>
            </div>

            <div className="space-y-2.5 max-h-[360px] overflow-y-auto pr-1 no-scrollbar">
              {SAMPLE_TELEGRAM_MESSAGES.map((sample) => {
                const isSelected = selectedSampleId === sample.id;
                return (
                  <div
                    key={sample.id}
                    id={`sample-msg-${sample.id}`}
                    onClick={() => handleSelectSample(sample)}
                    className={`group cursor-pointer rounded-xl border p-3.5 transition-all ${
                      isSelected
                        ? 'border-orange-500/60 bg-orange-950/20 shadow-md ring-1 ring-orange-500/40'
                        : 'border-zinc-800 bg-zinc-950/50 hover:border-zinc-700 hover:bg-zinc-900'
                    }`}
                  >
                    <div className="flex items-center justify-between mb-1.5">
                      <span className="text-[11px] font-bold text-orange-400">{sample.channelName}</span>
                      <span className="text-[10px] text-zinc-500">{sample.views}</span>
                    </div>

                    <h4 className="text-xs font-medium text-zinc-200 line-clamp-2 group-hover:text-orange-300 transition-colors">
                      {sample.topicDetected || sample.text.slice(0, 60)}
                    </h4>

                    <div className="mt-2 flex flex-wrap gap-1">
                      {sample.tags.slice(0, 2).map((tag) => (
                        <span
                          key={tag}
                          className="rounded bg-zinc-800 px-1.5 py-0.5 text-[9px] font-medium text-zinc-400"
                        >
                          #{tag}
                        </span>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Workflow overview card */}
          <div className="rounded-2xl border border-zinc-800/80 bg-zinc-900/40 p-4 space-y-3">
            <h4 className="text-xs font-bold uppercase tracking-wider text-zinc-400 flex items-center gap-1.5">
              <Layers className="h-3.5 w-3.5 text-orange-400" />
              <span>Pipeline Stages</span>
            </h4>
            <div className="space-y-2 text-xs">
              <div className="flex items-center gap-2 text-orange-400 font-semibold">
                <span className="h-5 w-5 rounded-full bg-orange-500/20 flex items-center justify-center text-[10px]">1</span>
                <span>Story Input (Current)</span>
              </div>
              <div className="flex items-center gap-2 text-zinc-400">
                <span className="h-5 w-5 rounded-full bg-zinc-800 flex items-center justify-center text-[10px]">2</span>
                <span>Deep Research & 3 Viral Angles</span>
              </div>
              <div className="flex items-center gap-2 text-zinc-400">
                <span className="h-5 w-5 rounded-full bg-zinc-800 flex items-center justify-center text-[10px]">3</span>
                <span>Video Blueprint & Retention Beats</span>
              </div>
              <div className="flex items-center gap-2 text-zinc-400">
                <span className="h-5 w-5 rounded-full bg-zinc-800 flex items-center justify-center text-[10px]">4</span>
                <span>Master Detailed Script & Narration</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

