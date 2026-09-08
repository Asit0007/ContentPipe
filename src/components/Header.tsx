import React from 'react';
import { Sparkles, Video, FileText, Compass, Send, ShieldCheck, Play, Flame } from 'lucide-react';
import { WorkflowStep, IPBranding } from '../types';

interface HeaderProps {
  currentStep: WorkflowStep;
  onSelectStep: (step: WorkflowStep) => void;
  activeIp: IPBranding | null;
  onOpenIpModal: () => void;
  onOpenGoogleExport?: () => void;
  hasScript?: boolean;
}

export const Header: React.FC<HeaderProps> = ({
  currentStep,
  onSelectStep,
  activeIp,
  onOpenIpModal,
  onOpenGoogleExport,
  hasScript,
}) => {
  const steps: { id: WorkflowStep; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
    { id: 'telegram', label: '1. Story Input', icon: Send },
    { id: 'research', label: '2. Topic Research', icon: Compass },
    { id: 'plan', label: '3. Video Blueprint', icon: FileText },
    { id: 'script', label: '4. Detailed Script', icon: Sparkles },
    { id: 'studio', label: '5. Video Player', icon: Play },
  ];

  return (
    <header className="sticky top-0 z-40 w-full border-b border-zinc-800/80 bg-zinc-950/90 backdrop-blur-md">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3 sm:px-6">
        {/* Left: Brand / Title */}
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-tr from-amber-600 to-orange-500 shadow-lg shadow-orange-500/20 ring-1 ring-orange-400/30">
            <Flame className="h-5 w-5 text-white" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold tracking-tight text-white sm:text-base">
                HN Infotainment Script Agent
              </span>
              <span className="rounded-full bg-orange-500/10 px-2 py-0.5 text-[11px] font-medium text-orange-400 border border-orange-500/20">
                AI Studio
              </span>
            </div>
            <p className="text-xs text-zinc-400 hidden sm:block">
              Custom Story Input → Deep Research → Blueprint → Detailed Script & Narration
            </p>
          </div>
        </div>

        {/* Center: Step Navigation Tabs */}
        <nav className="hidden lg:flex items-center gap-1 rounded-xl bg-zinc-900/80 p-1 border border-zinc-800/60">
          {steps.map((step) => {
            const Icon = step.icon;
            const isActive = currentStep === step.id;
            return (
              <button
                key={step.id}
                id={`nav-step-${step.id}`}
                onClick={() => onSelectStep(step.id)}
                className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-all ${
                  isActive
                    ? 'bg-orange-500 text-white shadow-sm shadow-orange-500/30'
                    : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50'
                }`}
              >
                <Icon className="h-3.5 w-3.5" />
                <span>{step.label}</span>
              </button>
            );
          })}
        </nav>

        {/* Right: Active IP Brand & Chatbot Affordance */}
        <div className="flex items-center gap-2">
          {onOpenGoogleExport && hasScript && (
            <button
              id="header-google-workspace-export-button"
              onClick={onOpenGoogleExport}
              className="flex items-center gap-1.5 rounded-xl bg-gradient-to-r from-blue-500/10 via-indigo-500/10 to-emerald-500/10 hover:from-blue-500/20 hover:to-emerald-500/20 border border-blue-500/30 px-3 py-1.5 text-xs font-semibold text-blue-300 transition-all cursor-pointer shadow-sm shadow-blue-500/10"
              title="Export detailed script to Google Docs or Google Sheets"
            >
              <FileText className="h-3.5 w-3.5 text-blue-400" />
              <span className="hidden sm:inline">Google Docs / Sheets</span>
            </button>
          )}

          <button
            id="open-ip-branding-button"
            onClick={onOpenIpModal}
            className={`flex items-center gap-2 rounded-xl px-3 py-1.5 text-xs font-medium transition-all border ${
              activeIp
                ? 'bg-gradient-to-r from-amber-500/10 to-orange-500/10 border-orange-500/30 text-orange-300 hover:border-orange-500/50'
                : 'bg-zinc-900 border-zinc-800 text-zinc-300 hover:border-zinc-700'
            }`}
          >
            <Sparkles className="h-3.5 w-3.5 text-orange-400 animate-pulse" />
            <div className="text-left">
              <span className="block text-[10px] text-zinc-400 uppercase tracking-wider font-semibold">
                Channel IP Brand
              </span>
              <span className="font-semibold text-zinc-100">
                {activeIp ? activeIp.name : 'Brainstorm IP & Brand'}
              </span>
            </div>
          </button>
        </div>
      </div>

      {/* Mobile step bar */}
      <div className="flex lg:hidden overflow-x-auto px-4 py-2 border-t border-zinc-800/50 gap-1.5 no-scrollbar bg-zinc-950">
        {steps.map((step) => {
          const Icon = step.icon;
          const isActive = currentStep === step.id;
          return (
            <button
              key={step.id}
              onClick={() => onSelectStep(step.id)}
              className={`flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium transition-all ${
                isActive
                  ? 'bg-orange-500 text-white'
                  : 'text-zinc-400 bg-zinc-900 border border-zinc-800'
              }`}
            >
              <Icon className="h-3 w-3" />
              <span>{step.label.split('. ')[1]}</span>
            </button>
          );
        })}
      </div>
    </header>
  );
};
