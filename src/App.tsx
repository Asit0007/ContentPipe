import React, { useState } from 'react';
import { Header } from './components/Header';
import { TelegramIngestion } from './components/TelegramIngestion';
import { ResearchStage } from './components/ResearchStage';
import { PlanStage } from './components/PlanStage';
import { ScriptEditor } from './components/ScriptEditor';
import { VideoStudio } from './components/VideoStudio';
import { IPBrandingChatbot } from './components/IPBrandingChatbot';
import { GoogleWorkspaceExportModal } from './components/GoogleWorkspaceExportModal';
import { ModelsPanel } from './components/ModelsPanel';
import { SAMPLE_TELEGRAM_MESSAGES } from './data/sampleMessages';
import { PLAN_PRESETS, PlanPresetKey } from './data/planPresets';
import { TelegramMessage, ResearchData, VideoPlan, VideoScript, IPBranding, WorkflowStep } from './types';
import { AlertCircle } from 'lucide-react';
import { DEFAULT_CHANNEL_BRAND } from '../shared/brand';

export default function App() {
  const [currentStep, setCurrentStep] = useState<WorkflowStep>('telegram');
  const [currentMessage, setCurrentMessage] = useState<TelegramMessage>(SAMPLE_TELEGRAM_MESSAGES[0]);
  const [researchData, setResearchData] = useState<ResearchData | null>(null);
  const [videoPlan, setVideoPlan] = useState<VideoPlan | null>(null);
  const [videoScript, setVideoScript] = useState<VideoScript | null>(null);
  // No preset brand: an unchosen IP falls back to DEFAULT_CHANNEL_BRAND everywhere it is read.
  const [activeIp, setActiveIp] = useState<IPBranding | null>(null);
  // Empty means the server's default (Blast Radius / hacking & cybersecurity news) — see shared/topicProfile.ts.
  const [topicDomain, setTopicDomain] = useState('');

  const [isIpModalOpen, setIsIpModalOpen] = useState(false);
  const [isGlobalGoogleExportOpen, setIsGlobalGoogleExportOpen] = useState(false);
  const [isResearchLoading, setIsResearchLoading] = useState(false);
  const [isPlanLoading, setIsPlanLoading] = useState(false);
  const [isScriptLoading, setIsScriptLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // 1. Trigger Deep Research on Telegram Message
  const handleStartResearch = async (msg: TelegramMessage) => {
    setIsResearchLoading(true);
    setErrorMessage(null);
    setCurrentStep('research');
    try {
      const response = await fetch('/api/research', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messageText: msg.text,
          channelName: msg.channelName,
          ...(msg.sourceUrls?.length ? { sourceUrls: msg.sourceUrls } : {}),
          ...(topicDomain.trim() ? { topicDomain: topicDomain.trim() } : {}),
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Research failed');

      setResearchData(data);
    } catch (err: any) {
      console.error(err);
      setErrorMessage(err.message || 'Failed to research story. Please try again.');
    } finally {
      setIsResearchLoading(false);
    }
  };

  // 2. Trigger Video Planning from Research
  const handleProceedToPlan = async (selectedAngleTitle?: string, presetKey?: PlanPresetKey) => {
    if (!researchData) return;
    setIsPlanLoading(true);
    setErrorMessage(null);
    setCurrentStep('plan');
    // A regeneration keeps whatever was set on the blueprint (format, tone, duration). A first plan
    // uses the preset chosen on the research screen; 'short' is exactly what was hardcoded before.
    const preset = PLAN_PRESETS[presetKey ?? 'short'];
    const settings =
      videoPlan && !presetKey
        ? {
            targetFormat: videoPlan.format === '16:9' ? PLAN_PRESETS.documentary.targetFormat : PLAN_PRESETS.short.targetFormat,
            targetTone: videoPlan.tone,
            targetDurationSec: videoPlan.targetDurationSec || preset.targetDurationSec,
          }
        : { targetFormat: preset.targetFormat, targetTone: preset.targetTone, targetDurationSec: preset.targetDurationSec };
    try {
      const response = await fetch('/api/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          researchData: {
            ...researchData,
            selectedAngle: selectedAngleTitle,
          },
          ...settings,
          ...(topicDomain.trim() ? { topicDomain: topicDomain.trim() } : {}),
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Planning failed');

      setVideoPlan(data);
    } catch (err: any) {
      console.error(err);
      setErrorMessage(err.message || 'Failed to generate video blueprint.');
    } finally {
      setIsPlanLoading(false);
    }
  };

  // 3. Trigger Script Generation from Blueprint
  const handleProceedToScript = async () => {
    if (!videoPlan) return;
    setIsScriptLoading(true);
    setErrorMessage(null);
    setCurrentStep('script');
    try {
      const response = await fetch('/api/script', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          videoPlan,
          researchData,
          channelBrandName: activeIp?.name || DEFAULT_CHANNEL_BRAND,
          ...(topicDomain.trim() ? { topicDomain: topicDomain.trim() } : {}),
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Scriptwriting failed');

      setVideoScript(data);
    } catch (err: any) {
      console.error(err);
      setErrorMessage(err.message || 'Failed to generate scene-by-scene script.');
    } finally {
      setIsScriptLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col font-sans selection:bg-orange-500 selection:text-white">
      {/* Top Header */}
      <Header
        currentStep={currentStep}
        onSelectStep={(step) => setCurrentStep(step)}
        activeIp={activeIp}
        onOpenIpModal={() => setIsIpModalOpen(true)}
        onOpenGoogleExport={() => setIsGlobalGoogleExportOpen(true)}
        hasScript={!!videoScript}
      />

      {/* Global Error Banner */}
      {errorMessage && (
        <div className="mx-auto mt-4 max-w-5xl px-4 w-full">
          <div className="rounded-xl border border-rose-500/30 bg-rose-950/40 p-4 text-xs sm:text-sm text-rose-300 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <AlertCircle className="h-4 w-4 shrink-0 text-rose-400" />
              <span>{errorMessage}</span>
            </div>
            <button
              onClick={() => setErrorMessage(null)}
              className="text-rose-400 hover:text-white text-xs underline font-semibold ml-4"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* Main Content Area */}
      <main className="flex-1 px-4 py-8 sm:px-6 lg:px-8">
        {/* Which models this page uses, and which one produced what is on it. */}
        <ModelsPanel
          key={currentStep}
          page={currentStep}
          calls={
            currentStep === 'research'
              ? researchData?.modelUsage
              : currentStep === 'plan'
                ? videoPlan?.modelUsage
                : currentStep === 'script'
                  ? [...(videoScript?.modelUsage ?? []), ...(videoScript?.publish?.modelUsage ?? [])]
                  : undefined
          }
        />

        {currentStep === 'telegram' && (
          <TelegramIngestion
            currentMessage={currentMessage}
            onUpdateMessage={(msg) => setCurrentMessage(msg)}
            onStartResearch={(msg) => handleStartResearch(msg)}
            isLoading={isResearchLoading}
            topicDomain={topicDomain}
            onTopicDomainChange={setTopicDomain}
          />
        )}

        {currentStep === 'research' && (
          <ResearchStage
            researchData={researchData}
            isLoading={isResearchLoading}
            onProceedToPlan={handleProceedToPlan}
            onReResearch={() => handleStartResearch(currentMessage)}
          />
        )}

        {currentStep === 'plan' && (
          <PlanStage
            videoPlan={videoPlan}
            isLoading={isPlanLoading}
            onProceedToScript={handleProceedToScript}
            onUpdatePlan={(updated) => setVideoPlan(updated)}
            onRegeneratePlan={() => handleProceedToPlan()}
            topicDomain={topicDomain}
            onTopicDomainChange={setTopicDomain}
          />
        )}

        {currentStep === 'script' && (
          <ScriptEditor
            videoScript={videoScript}
            isLoading={isScriptLoading}
            onUpdateScript={(updated) => setVideoScript(updated)}
            onProceedToStudio={() => setCurrentStep('studio')}
            onRegenerateScript={handleProceedToScript}
            plan={videoPlan}
            research={researchData}
            channelBrandName={activeIp?.name}
            topicDomain={topicDomain}
          />
        )}

        {currentStep === 'studio' && videoScript && (
          <VideoStudio
            videoScript={videoScript}
            researchData={researchData}
            activeIp={activeIp}
            onBackToScript={() => setCurrentStep('script')}
            onUpdateScript={(updated) => setVideoScript(updated)}
          />
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-zinc-900 bg-zinc-950 py-6 text-center text-xs text-zinc-600">
        {/* It used to name Gemini 3.1 Pro and Gemini Pro Image, neither of which this free key can call. */}
        <p>News-to-Video Brief Agent • The models each page uses, and which one wrote what, are under “AI models on this page”</p>
      </footer>

      {/* IP Branding & Gemini Chatbot Modal */}
      <IPBrandingChatbot
        isOpen={isIpModalOpen}
        onClose={() => setIsIpModalOpen(false)}
        activeIp={activeIp}
        onSelectIp={(ip) => {
          setActiveIp(ip);
          setIsIpModalOpen(false);
        }}
        topicContext={researchData?.topicTitle || currentMessage.text}
      />

      {/* Global Google Workspace Export Modal (accessible from Header or anywhere) */}
      {videoScript && (
        <GoogleWorkspaceExportModal
          isOpen={isGlobalGoogleExportOpen}
          onClose={() => setIsGlobalGoogleExportOpen(false)}
          videoScript={videoScript}
          plan={videoPlan}
          research={researchData}
          initialExportType="both"
        />
      )}
    </div>
  );
}
