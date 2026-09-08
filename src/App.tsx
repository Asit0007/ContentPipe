import React, { useState } from 'react';
import { Header } from './components/Header';
import { TelegramIngestion } from './components/TelegramIngestion';
import { ResearchStage } from './components/ResearchStage';
import { PlanStage } from './components/PlanStage';
import { ScriptEditor } from './components/ScriptEditor';
import { VideoStudio } from './components/VideoStudio';
import { IPBrandingChatbot } from './components/IPBrandingChatbot';
import { GoogleWorkspaceExportModal } from './components/GoogleWorkspaceExportModal';
import { SAMPLE_TELEGRAM_MESSAGES } from './data/sampleMessages';
import { TelegramMessage, ResearchData, VideoPlan, VideoScript, IPBranding, WorkflowStep } from './types';
import { AlertCircle } from 'lucide-react';

export default function App() {
  const [currentStep, setCurrentStep] = useState<WorkflowStep>('telegram');
  const [currentMessage, setCurrentMessage] = useState<TelegramMessage>(SAMPLE_TELEGRAM_MESSAGES[0]);
  const [researchData, setResearchData] = useState<ResearchData | null>(null);
  const [videoPlan, setVideoPlan] = useState<VideoPlan | null>(null);
  const [videoScript, setVideoScript] = useState<VideoScript | null>(null);
  const [activeIp, setActiveIp] = useState<IPBranding | null>({
    id: 'ip-1',
    name: 'The Orange Thread',
    tagline: 'Unfiltered Hacker News breakdowns for the curious engineer.',
    hookLine: 'What the top 1% of developers are arguing about right now.',
    vibe: 'Sleek retro-cyberpunk terminal with warm YC-orange glowing accents',
    targetAudience: 'Software engineers, startup founders, CS students, and tech enthusiasts',
    mascotOrVisualIdentity: 'A vintage 1980s mainframe CRT monitor displaying live animated ASCII art',
    suggestedHandle: '@TheOrangeThread',
    whyItWorks: 'Direct homage to Hacker News signature color and comment threads.',
  });

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
  const handleProceedToPlan = async (selectedAngleTitle?: string) => {
    if (!researchData) return;
    setIsPlanLoading(true);
    setErrorMessage(null);
    setCurrentStep('plan');
    try {
      const response = await fetch('/api/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          researchData: {
            ...researchData,
            selectedAngle: selectedAngleTitle,
          },
          targetFormat: '9:16 (Shorts / Reels / TikTok)',
          targetTone: 'Witty Tech & Sarcastic',
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
          channelBrandName: activeIp?.name || 'The Orange Thread',
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
        {currentStep === 'telegram' && (
          <TelegramIngestion
            currentMessage={currentMessage}
            onUpdateMessage={(msg) => setCurrentMessage(msg)}
            onStartResearch={(msg) => handleStartResearch(msg)}
            isLoading={isResearchLoading}
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
        <p>Hacker News Infotainment Video Agent • Powered by Gemini 3.7 Flash, Gemini 3.1 Pro, Gemini Pro Image & Gemini TTS</p>
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
