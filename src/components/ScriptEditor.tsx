import React, { useState, useEffect, useRef } from 'react';
import {
  Sparkles,
  Play,
  Pause,
  Volume2,
  Image as ImageIcon,
  RefreshCw,
  ArrowRight,
  CheckCircle2,
  AlertCircle,
  Wand2,
  Sliders,
  Layers,
  Download,
  Music,
  Eye,
  Copy,
  Check,
  FileText,
  Table,
  Radio,
  Clock,
  Zap,
  AlignLeft,
  Flame,
  Film,
  Camera,
  MessageSquare
} from 'lucide-react';
import { VideoScript, VideoScriptScene, ImageResolution, VoiceName, VideoPlan, ResearchData } from '../types';
import { playAudioFromBase64, pcmBase64ToWavDataUrl, speakWithBrowserSpeech, stopAllSpeechAndAudio, playWebAudioSFX } from '../utils/audioUtils';
import { GoogleWorkspaceExportModal } from './GoogleWorkspaceExportModal';

interface ScriptEditorProps {
  videoScript: VideoScript | null;
  isLoading: boolean;
  onUpdateScript: (script: VideoScript) => void;
  onProceedToStudio: () => void;
  onRegenerateScript: () => void;
  plan?: VideoPlan | null;
  research?: ResearchData | null;
}

export const ScriptEditor: React.FC<ScriptEditorProps> = ({
  videoScript,
  isLoading,
  onUpdateScript,
  onProceedToStudio,
  onRegenerateScript,
  plan,
  research,
}) => {
  const [viewMode, setViewMode] = useState<'director' | 'document' | 'teleprompter'>('director');
  const [selectedVoice, setSelectedVoice] = useState<VoiceName>('Puck');
  const [selectedResolution, setSelectedResolution] = useState<ImageResolution>('1K');
  const [playingSceneId, setPlayingSceneId] = useState<string | null>(null);
  const [activeAudioElement, setActiveAudioElement] = useState<HTMLAudioElement | null>(null);
  const [isBatchGenerating, setIsBatchGenerating] = useState(false);
  const [batchProgress, setBatchProgress] = useState<{ current: number; total: number; message: string }>({
    current: 0,
    total: 0,
    message: '',
  });

  // Google Workspace Export Modal State
  const [isGoogleExportModalOpen, setIsGoogleExportModalOpen] = useState(false);
  const [googleExportType, setGoogleExportType] = useState<'doc' | 'sheet' | 'both'>('both');

  // Export / Copy Feedback States
  const [copiedType, setCopiedType] = useState<'all' | 'voiceover' | null>(null);

  // Teleprompter State
  const [isTeleprompterPlaying, setIsTeleprompterPlaying] = useState(false);
  const [teleprompterSpeed, setTeleprompterSpeed] = useState(1.5);
  const [teleprompterFontSize, setTeleprompterFontSize] = useState<'sm' | 'base' | 'lg' | 'xl' | '2xl'>('xl');
  const teleprompterRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll loop for teleprompter
  useEffect(() => {
    let animationFrameId: number;
    if (isTeleprompterPlaying && teleprompterRef.current) {
      const scrollContainer = teleprompterRef.current;
      const scrollStep = () => {
        if (scrollContainer) {
          scrollContainer.scrollTop += teleprompterSpeed * 0.8;
          if (scrollContainer.scrollTop + scrollContainer.clientHeight >= scrollContainer.scrollHeight - 5) {
            setIsTeleprompterPlaying(false);
            return;
          }
        }
        animationFrameId = requestAnimationFrame(scrollStep);
      };
      animationFrameId = requestAnimationFrame(scrollStep);
    }
    return () => cancelAnimationFrame(animationFrameId);
  }, [isTeleprompterPlaying, teleprompterSpeed]);

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[460px] rounded-2xl border border-zinc-800 bg-zinc-900/50 p-8 text-center space-y-5">
        <div className="relative">
          <div className="h-20 w-20 rounded-2xl bg-orange-500/10 border border-orange-500/30 flex items-center justify-center animate-pulse">
            <Sparkles className="h-10 w-10 text-orange-400 animate-spin" style={{ animationDuration: '3s' }} />
          </div>
        </div>
        <div className="space-y-2 max-w-lg">
          <h3 className="text-xl font-bold text-white">Engineering Master Infotainment Script</h3>
          <p className="text-xs sm:text-sm text-zinc-400 leading-relaxed">
            Crafting conversational voiceover narration, directing cinematography cues, timing kinetic on-screen typography, and prompt-engineering 4K visuals for every scene...
          </p>
        </div>
      </div>
    );
  }

  if (!videoScript) {
    return (
      <div className="rounded-2xl border border-dashed border-zinc-800 bg-zinc-900/30 p-12 text-center">
        <p className="text-sm text-zinc-400">No script generated yet. Please provide a story topic first.</p>
      </div>
    );
  }

  // Calculate Metrics
  const totalWords = videoScript.scenes.reduce((acc, s) => acc + (s.narration?.split(/\s+/).filter(Boolean).length || 0), 0);
  const totalDurationEst = videoScript.scenes.reduce((acc, s) => acc + (s.durationEst || 10), 0);
  const targetWpm = Math.round((totalWords / (Math.max(totalDurationEst, 1) / 60))) || 150;
  const completedAudioCount = videoScript.scenes.filter((s) => s.generatedAudioBase64).length;
  const completedImageCount = videoScript.scenes.filter((s) => s.generatedImageUrl).length;

  // Handle single scene update
  const handleSceneChange = (sceneId: string, updates: Partial<VideoScriptScene>) => {
    const updatedScenes = videoScript.scenes.map((s) => (s.id === sceneId ? { ...s, ...updates } : s));
    onUpdateScript({ ...videoScript, scenes: updatedScenes });
  };

  // Generate TTS for a single scene
  const handleGenerateTTS = async (scene: VideoScriptScene) => {
    handleSceneChange(scene.id, { isAudioLoading: true, audioError: undefined });
    try {
      const response = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: scene.narration, voice: selectedVoice }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'TTS failed');

      handleSceneChange(scene.id, {
        generatedAudioBase64: data.audioBase64,
        isAudioLoading: false,
      });
      playWebAudioSFX('pop');
    } catch (err: any) {
      handleSceneChange(scene.id, {
        isAudioLoading: false,
        audioError: err.message || 'TTS Error',
      });
    }
  };

  // Generate high quality Image for a single scene
  const handleGenerateImage = async (scene: VideoScriptScene) => {
    handleSceneChange(scene.id, { isImageLoading: true, imageError: undefined });
    try {
      const response = await fetch('/api/generate-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: scene.visualPrompt,
          aspectRatio: videoScript.aspectRatio || '16:9',
          imageSize: selectedResolution,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Image gen failed');

      handleSceneChange(scene.id, {
        generatedImageUrl: data.imageUrl,
        isImageLoading: false,
      });
      playWebAudioSFX('pop');
    } catch (err: any) {
      handleSceneChange(scene.id, {
        isImageLoading: false,
        imageError: err.message || 'Image Generation Error',
      });
    }
  };

  // Batch generate all TTS audio and images
  const handleBatchGenerateAll = async () => {
    setIsBatchGenerating(true);
    const scenes = videoScript.scenes;
    const totalOps = scenes.length * 2;
    let currentOp = 0;

    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];

      // 1. Generate TTS if needed
      if (!scene.generatedAudioBase64) {
        setBatchProgress({
          current: ++currentOp,
          total: totalOps,
          message: `Generating TTS Narration for Scene ${scene.sceneNumber} (${selectedVoice})...`,
        });
        await handleGenerateTTS(scene);
      } else {
        currentOp++;
      }

      // 2. Generate Image if needed
      if (!scene.generatedImageUrl) {
        setBatchProgress({
          current: ++currentOp,
          total: totalOps,
          message: `Generating ${selectedResolution} Image for Scene ${scene.sceneNumber}...`,
        });
        await handleGenerateImage(scene);
      } else {
        currentOp++;
      }
    }

    setIsBatchGenerating(false);
    setBatchProgress({ current: 0, total: 0, message: '' });
    playWebAudioSFX('success');
  };

  // Play audio preview
  const handleTogglePlayAudio = (scene: VideoScriptScene) => {
    if (activeAudioElement) {
      activeAudioElement.pause();
      setActiveAudioElement(null);
    }
    stopAllSpeechAndAudio();

    if (playingSceneId === scene.id) {
      setPlayingSceneId(null);
      return;
    }

    if (scene.generatedAudioBase64) {
      const audio = playAudioFromBase64(scene.generatedAudioBase64);
      setActiveAudioElement(audio);
      setPlayingSceneId(scene.id);
      audio.onended = () => {
        setPlayingSceneId(null);
        setActiveAudioElement(null);
      };
    } else {
      setPlayingSceneId(scene.id);
      speakWithBrowserSpeech(scene.narration, {
        voiceGender: 'male',
        pitch: 1.0,
        rate: 1.05,
        onEnd: () => {
          setPlayingSceneId(null);
        },
      });
    }
  };

  // Export & Copy Helpers
  const generateMarkdownScript = () => {
    let md = `# ${videoScript.title}\n\n`;
    md += `**Platform:** ${videoScript.targetPlatform} | **Aspect Ratio:** ${videoScript.aspectRatio}\n`;
    md += `**Total Estimated Duration:** ~${totalDurationEst} seconds | **Word Count:** ${totalWords} words (~${targetWpm} WPM)\n\n`;
    md += `**Signature Intro:** *${videoScript.signatureIntro}*\n\n`;
    md += `---\n\n## SCENE BREAKDOWN\n\n`;

    videoScript.scenes.forEach((scene) => {
      md += `### Scene ${scene.sceneNumber}: ${scene.title} [${scene.actPhase || 'Beat'}]\n`;
      md += `- **Estimated Duration:** ~${scene.durationEst}s\n`;
      if (scene.cinematography) md += `- **Cinematography:** ${scene.cinematography}\n`;
      md += `- **On-Screen Kinetic Caption:** \`${scene.onScreenText}\`\n`;
      if (scene.soundEffect) md += `- **Sound Design SFX:** ${scene.soundEffect}\n`;
      if (scene.retentionNote) md += `- **Retention Strategy:** ${scene.retentionNote}\n`;
      md += `- **Visual Prompt:** *${scene.visualPrompt}*\n\n`;
      md += `**VOICEOVER NARRATION:**\n> "${scene.narration}"\n\n---\n\n`;
    });

    md += `**Signature Outro & CTA:** *${videoScript.signatureOutro}*\n`;
    return md;
  };

  const generateCleanVoiceoverOnly = () => {
    let vo = `${videoScript.signatureIntro}\n\n`;
    videoScript.scenes.forEach((s) => {
      vo += `[Scene ${s.sceneNumber}: ${s.title}]\n${s.narration}\n\n`;
    });
    vo += `${videoScript.signatureOutro}`;
    return vo;
  };

  const handleCopyMarkdown = () => {
    navigator.clipboard.writeText(generateMarkdownScript());
    setCopiedType('all');
    playWebAudioSFX('pop');
    setTimeout(() => setCopiedType(null), 2500);
  };

  const handleCopyVoiceoverOnly = () => {
    navigator.clipboard.writeText(generateCleanVoiceoverOnly());
    setCopiedType('voiceover');
    playWebAudioSFX('pop');
    setTimeout(() => setCopiedType(null), 2500);
  };

  const handleDownloadMarkdown = () => {
    const text = generateMarkdownScript();
    const blob = new Blob([text], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${videoScript.title.toLowerCase().replace(/[^a-z0-9]/g, '-')}-production-script.md`;
    a.click();
    URL.revokeObjectURL(url);
    playWebAudioSFX('pop');
  };

  const handleDownloadTeleprompterText = () => {
    const text = generateCleanVoiceoverOnly();
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${videoScript.title.toLowerCase().replace(/[^a-z0-9]/g, '-')}-teleprompter.txt`;
    a.click();
    URL.revokeObjectURL(url);
    playWebAudioSFX('pop');
  };

  return (
    <div className="space-y-8 max-w-5xl mx-auto">
      {/* Top Banner: Master Script Dossier */}
      <div className="rounded-2xl border border-orange-500/30 bg-gradient-to-br from-zinc-900 via-zinc-900 to-orange-950/20 p-6 sm:p-8 shadow-xl space-y-6 relative overflow-hidden">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-orange-500/10 border border-orange-500/20 px-3 py-1 text-xs font-semibold text-orange-400">
              <Sparkles className="h-3.5 w-3.5" />
              <span>Final Destination • Master Detailed Script</span>
            </span>
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 border border-emerald-500/20 px-2.5 py-0.5 text-xs font-semibold text-emerald-400">
              <Flame className="h-3 w-3" /> Virality Score: {videoScript.viralityScore || 96}/100
            </span>
            <span className="inline-flex items-center gap-1 rounded-full bg-sky-500/10 border border-sky-500/20 px-2.5 py-0.5 text-xs font-semibold text-sky-300">
              {videoScript.targetPlatform}
            </span>
          </div>

          <div className="flex items-center gap-2">
            <button
              id="export-google-workspace-top-button"
              type="button"
              onClick={() => {
                setGoogleExportType('both');
                setIsGoogleExportModalOpen(true);
              }}
              className="flex items-center gap-1.5 text-xs font-bold text-white bg-gradient-to-r from-blue-600 via-indigo-600 to-emerald-600 hover:from-blue-500 hover:to-emerald-500 px-3 py-1.5 rounded-lg shadow-md shadow-blue-500/20 transition-all cursor-pointer"
            >
              <FileText className="h-3.5 w-3.5" />
              <span>Export to Docs & Sheets</span>
            </button>
            <button
              onClick={onRegenerateScript}
              className="flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-200 transition-colors bg-zinc-800/60 px-2.5 py-1.5 rounded-lg border border-zinc-700/50"
            >
              <RefreshCw className="h-3 w-3" /> Re-write Script
            </button>
          </div>
        </div>

        <div>
          <label htmlFor="script-title-input" className="text-xs font-bold uppercase tracking-wider text-zinc-400">
            Episode Script Title
          </label>
          <input
            id="script-title-input"
            type="text"
            value={videoScript.title}
            onChange={(e) => onUpdateScript({ ...videoScript, title: e.target.value })}
            className="mt-1 w-full bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-2.5 text-xl font-bold text-white focus:outline-none focus:ring-1 focus:ring-orange-500"
          />
        </div>

        {/* Master Performance & Pacing Stats Bar */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-2">
          <div className="rounded-xl bg-zinc-950/80 p-3 border border-zinc-800/80">
            <div className="text-[10px] font-bold uppercase tracking-wider text-zinc-400 flex items-center gap-1">
              <Clock className="h-3 w-3 text-orange-400" /> Runtime Est.
            </div>
            <div className="text-lg font-bold text-white mt-0.5">~{totalDurationEst}s</div>
            <div className="text-[10px] text-zinc-500">{videoScript.scenes.length} Scenes</div>
          </div>

          <div className="rounded-xl bg-zinc-950/80 p-3 border border-zinc-800/80">
            <div className="text-[10px] font-bold uppercase tracking-wider text-zinc-400 flex items-center gap-1">
              <AlignLeft className="h-3 w-3 text-sky-400" /> Word Count
            </div>
            <div className="text-lg font-bold text-white mt-0.5">{totalWords} words</div>
            <div className="text-[10px] text-zinc-500">~{targetWpm} WPM Pacing</div>
          </div>

          <div className="rounded-xl bg-zinc-950/80 p-3 border border-zinc-800/80">
            <div className="text-[10px] font-bold uppercase tracking-wider text-zinc-400 flex items-center gap-1">
              <Film className="h-3 w-3 text-amber-400" /> Visual Direction
            </div>
            <div className="text-lg font-bold text-white mt-0.5">{completedImageCount}/{videoScript.scenes.length}</div>
            <div className="text-[10px] text-zinc-500">{selectedResolution} Visual Assets</div>
          </div>

          <div className="rounded-xl bg-zinc-950/80 p-3 border border-zinc-800/80">
            <div className="text-[10px] font-bold uppercase tracking-wider text-zinc-400 flex items-center gap-1">
              <Volume2 className="h-3 w-3 text-emerald-400" /> TTS Narration
            </div>
            <div className="text-lg font-bold text-white mt-0.5">{completedAudioCount}/{videoScript.scenes.length}</div>
            <div className="text-[10px] text-zinc-500">Voice: {selectedVoice}</div>
          </div>
        </div>

        {/* Global Controls: Image Quality + Voice Selector + Batch Generator */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-4 border-t border-zinc-800/80">
          {/* Image Resolution Selector */}
          <div className="rounded-xl bg-zinc-950 p-3.5 border border-zinc-800">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-xs font-bold uppercase tracking-wider text-orange-400 flex items-center gap-1.5">
                <ImageIcon className="h-3.5 w-3.5" /> Image Quality
              </span>
              <span className="text-[10px] text-zinc-400 font-mono">gemini-3-pro-image</span>
            </div>
            <div className="grid grid-cols-3 gap-1.5 mt-2">
              {(['1K', '2K', '4K'] as ImageResolution[]).map((res) => (
                <button
                  key={res}
                  id={`image-res-${res}`}
                  type="button"
                  onClick={() => setSelectedResolution(res)}
                  className={`py-1.5 px-2 rounded-lg text-xs font-bold transition-all border ${
                    selectedResolution === res
                      ? 'bg-orange-500 text-white border-orange-400 shadow-sm shadow-orange-500/30'
                      : 'bg-zinc-900 text-zinc-400 border-zinc-800 hover:text-zinc-200'
                  }`}
                >
                  {res}
                </button>
              ))}
            </div>
          </div>

          {/* Voice Selector */}
          <div className="rounded-xl bg-zinc-950 p-3.5 border border-zinc-800">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-xs font-bold uppercase tracking-wider text-emerald-400 flex items-center gap-1.5">
                <Volume2 className="h-3.5 w-3.5" /> TTS Narrator Voice
              </span>
              <span className="text-[10px] text-zinc-400 font-mono">gemini-3.1-flash-tts</span>
            </div>
            <select
              id="voice-selector-select"
              value={selectedVoice}
              onChange={(e) => setSelectedVoice(e.target.value as VoiceName)}
              className="mt-2 w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-1.5 text-xs font-medium text-zinc-200 focus:outline-none focus:ring-1 focus:ring-emerald-500"
            >
              <option value="Puck">Puck (Energetic, Modern, Crisp)</option>
              <option value="Charon">Charon (Deep, Authoritative, Cinematic)</option>
              <option value="Kore">Kore (Clear, Professional, Articulate)</option>
              <option value="Fenrir">Fenrir (Bold, Dramatic, Gripping)</option>
              <option value="Zephyr">Zephyr (Smooth, Analytical, Calm)</option>
            </select>
          </div>

          {/* Batch Generate Button */}
          <div className="rounded-xl bg-zinc-950 p-3.5 border border-zinc-800 flex flex-col justify-between">
            <div>
              <span className="text-xs font-bold uppercase tracking-wider text-sky-400 flex items-center gap-1.5">
                <Wand2 className="h-3.5 w-3.5" /> Asset Engine
              </span>
              <div className="text-[11px] text-zinc-400 mt-1 flex items-center justify-between">
                <span>Audio: {completedAudioCount}/{videoScript.scenes.length}</span>
                <span>Visuals: {completedImageCount}/{videoScript.scenes.length}</span>
              </div>
            </div>

            <button
              id="batch-generate-assets-button"
              type="button"
              disabled={isBatchGenerating}
              onClick={handleBatchGenerateAll}
              className="mt-2 w-full flex items-center justify-center gap-1.5 rounded-lg bg-gradient-to-r from-orange-500 to-amber-500 py-1.5 px-3 text-xs font-bold text-white shadow hover:from-orange-400 hover:to-amber-400 transition-all disabled:opacity-50 cursor-pointer"
            >
              {isBatchGenerating ? (
                <>
                  <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                  <span>Generating Assets...</span>
                </>
              ) : (
                <>
                  <Sparkles className="h-3.5 w-3.5" />
                  <span>Generate All TTS & {selectedResolution} Images</span>
                </>
              )}
            </button>
          </div>
        </div>

        {/* Batch Progress Bar if active */}
        {isBatchGenerating && (
          <div className="rounded-xl bg-zinc-950 p-3 border border-orange-500/30 space-y-1.5">
            <div className="flex items-center justify-between text-xs text-orange-300">
              <span className="font-semibold">{batchProgress.message}</span>
              <span className="font-mono">{batchProgress.current} / {batchProgress.total}</span>
            </div>
            <div className="h-1.5 w-full bg-zinc-800 rounded-full overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-orange-500 to-amber-400 transition-all duration-300"
                style={{ width: `${(batchProgress.current / Math.max(1, batchProgress.total)) * 100}%` }}
              />
            </div>
          </div>
        )}

        {/* Export & Copy Action Bar */}
        <div className="flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-zinc-800/80">
          <div className="flex items-center gap-2 flex-wrap">
            {/* Google Workspace Export Buttons */}
            <button
              id="export-google-doc-action-button"
              type="button"
              onClick={() => {
                setGoogleExportType('doc');
                setIsGoogleExportModalOpen(true);
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-500/10 hover:bg-blue-500/20 text-blue-300 text-xs font-semibold border border-blue-500/30 transition-all cursor-pointer shadow-sm shadow-blue-500/10"
              title="Export script to a new Google Doc"
            >
              <FileText className="h-3.5 w-3.5 text-blue-400" />
              <span>Export Google Doc</span>
            </button>
            <button
              id="export-google-sheet-action-button"
              type="button"
              onClick={() => {
                setGoogleExportType('sheet');
                setIsGoogleExportModalOpen(true);
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-300 text-xs font-semibold border border-emerald-500/30 transition-all cursor-pointer shadow-sm shadow-emerald-500/10"
              title="Export script to a new Google Sheet"
            >
              <Table className="h-3.5 w-3.5 text-emerald-400" />
              <span>Export Google Sheet</span>
            </button>

            <button
              type="button"
              onClick={handleCopyMarkdown}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-medium border border-zinc-700 transition-all"
            >
              {copiedType === 'all' ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5 text-orange-400" />}
              <span>{copiedType === 'all' ? 'Copied Full Script!' : 'Copy Markdown'}</span>
            </button>
            <button
              type="button"
              onClick={handleCopyVoiceoverOnly}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-medium border border-zinc-700 transition-all"
            >
              {copiedType === 'voiceover' ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5 text-sky-400" />}
              <span>{copiedType === 'voiceover' ? 'Copied Voiceover!' : 'Copy VO Only'}</span>
            </button>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              onClick={handleDownloadMarkdown}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-950 hover:bg-zinc-800 text-zinc-300 text-xs font-medium border border-zinc-800 transition-all"
            >
              <Download className="h-3.5 w-3.5" />
              <span>Download .md</span>
            </button>
            <button
              type="button"
              onClick={handleDownloadTeleprompterText}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-950 hover:bg-zinc-800 text-zinc-300 text-xs font-medium border border-zinc-800 transition-all"
            >
              <Download className="h-3.5 w-3.5" />
              <span>Download .txt</span>
            </button>
          </div>
        </div>
      </div>

      {/* Script View Switcher (Director Cards vs Document View vs Teleprompter) */}
      <div className="flex items-center justify-between gap-4 border-b border-zinc-800 pb-3">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setViewMode('director')}
            className={`flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all ${
              viewMode === 'director'
                ? 'bg-orange-500 text-white shadow-sm shadow-orange-500/30'
                : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900'
            }`}
          >
            <Layers className="h-3.5 w-3.5" />
            <span>Scene Director Cards</span>
          </button>
          <button
            type="button"
            onClick={() => setViewMode('document')}
            className={`flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all ${
              viewMode === 'document'
                ? 'bg-orange-500 text-white shadow-sm shadow-orange-500/30'
                : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900'
            }`}
          >
            <FileText className="h-3.5 w-3.5" />
            <span>Full Script Document</span>
          </button>
          <button
            type="button"
            onClick={() => setViewMode('teleprompter')}
            className={`flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all ${
              viewMode === 'teleprompter'
                ? 'bg-orange-500 text-white shadow-sm shadow-orange-500/30'
                : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900'
            }`}
          >
            <Radio className="h-3.5 w-3.5" />
            <span>Teleprompter Studio</span>
          </button>
        </div>

        <span className="text-xs text-zinc-500 hidden sm:inline">
          {viewMode === 'director' && 'Detailed cinematography, prompts & audio cues'}
          {viewMode === 'document' && 'Clean formatted Markdown production script'}
          {viewMode === 'teleprompter' && 'Auto-scrolling prompt for recording'}
        </span>
      </div>

      {/* VIEW 1: SCENE DIRECTOR CARDS */}
      {viewMode === 'director' && (
        <div className="space-y-5">
          {/* Signature Intro Card */}
          <div className="rounded-xl bg-zinc-900 border border-zinc-800 p-4 space-y-1">
            <span className="text-[11px] font-bold uppercase tracking-wider text-orange-400 flex items-center gap-1.5">
              🎙️ Show Hook & Signature Intro
            </span>
            <p className="text-sm text-zinc-200 italic leading-relaxed">
              "{videoScript.signatureIntro}"
            </p>
          </div>

          {videoScript.scenes.map((scene) => (
            <div
              key={scene.id}
              id={`script-scene-card-${scene.sceneNumber}`}
              className="rounded-2xl border border-zinc-800 bg-zinc-900 p-6 space-y-5 shadow-lg transition-all hover:border-zinc-700"
            >
              {/* Scene Header */}
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-zinc-800 pb-3">
                <div className="flex items-center gap-3">
                  <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-orange-500/20 text-sm font-bold text-orange-400 border border-orange-500/30 shrink-0">
                    {scene.sceneNumber}
                  </span>
                  <div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <h4 className="text-sm sm:text-base font-bold text-white">{scene.title}</h4>
                      {scene.actPhase && (
                        <span className="text-[10px] font-semibold bg-orange-500/10 text-orange-400 border border-orange-500/20 px-2 py-0.5 rounded-full">
                          {scene.actPhase}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 text-[11px] text-zinc-400 mt-0.5">
                      <span className="font-mono">Est: ~{scene.durationEst}s</span>
                      <span>•</span>
                      <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-300 uppercase font-semibold text-[10px]">
                        {scene.visualType}
                      </span>
                      {scene.soundEffect && (
                        <>
                          <span>•</span>
                          <span className="text-amber-400 flex items-center gap-1">
                            <Music className="h-3 w-3" /> {scene.soundEffect}
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                </div>

                {/* Status Pills */}
                <div className="flex items-center gap-2 shrink-0">
                  {scene.generatedAudioBase64 ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-400 border border-emerald-500/20">
                      <CheckCircle2 className="h-3 w-3" /> Audio Ready
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 rounded-full bg-zinc-800 px-2.5 py-0.5 text-[11px] font-semibold text-zinc-400">
                      Audio Pending
                    </span>
                  )}

                  {scene.generatedImageUrl ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-sky-500/10 px-2.5 py-0.5 text-[11px] font-semibold text-sky-400 border border-sky-500/20">
                      <CheckCircle2 className="h-3 w-3" /> Image Ready
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 rounded-full bg-zinc-800 px-2.5 py-0.5 text-[11px] font-semibold text-zinc-400">
                      Image Pending
                    </span>
                  )}
                </div>
              </div>

              {/* Directorial & Retention Notes */}
              {scene.cinematography && (
                <div className="rounded-lg bg-zinc-950/80 p-3 border border-zinc-800/80 flex items-start gap-2.5 text-xs text-zinc-300">
                  <Camera className="h-4 w-4 text-orange-400 shrink-0 mt-0.5" />
                  <div>
                    <span className="font-bold text-orange-400 uppercase tracking-wide mr-1.5">Cinematography:</span>
                    <span>{scene.cinematography}</span>
                  </div>
                </div>
              )}

              {/* Scene Content Grid */}
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
                {/* Narration & Subtitle Column */}
                <div className="lg:col-span-7 space-y-3.5">
                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <label htmlFor={`narration-input-${scene.id}`} className="text-xs font-bold text-zinc-300 uppercase tracking-wide flex items-center gap-1.5">
                        <MessageSquare className="h-3.5 w-3.5 text-orange-400" />
                        <span>Voiceover Narration Script</span>
                      </label>
                      <span className="text-[11px] text-zinc-500 font-mono">
                        {scene.narration?.split(/\s+/).filter(Boolean).length} words
                      </span>
                    </div>
                    <textarea
                      id={`narration-input-${scene.id}`}
                      rows={3}
                      value={scene.narration}
                      onChange={(e) => handleSceneChange(scene.id, { narration: e.target.value })}
                      placeholder="Scene voiceover text..."
                      className="w-full bg-zinc-950 border border-zinc-800 rounded-xl p-3 text-xs sm:text-sm text-zinc-100 focus:outline-none focus:ring-1 focus:ring-orange-500 leading-relaxed font-sans"
                    />
                  </div>

                  {/* On-Screen Punchy Subtitle */}
                  <div>
                    <label htmlFor={`onscreen-text-input-${scene.id}`} className="text-xs font-bold text-orange-400 uppercase tracking-wide block mb-1">
                      On-Screen Kinetic Caption (Lower Third)
                    </label>
                    <input
                      id={`onscreen-text-input-${scene.id}`}
                      type="text"
                      value={scene.onScreenText}
                      onChange={(e) => handleSceneChange(scene.id, { onScreenText: e.target.value })}
                      placeholder="Short punchy caption..."
                      className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-xs font-bold text-orange-300 focus:outline-none focus:ring-1 focus:ring-orange-500 font-mono"
                    />
                  </div>

                  {/* Audio Controls */}
                  <div className="flex items-center gap-2 pt-1 flex-wrap">
                    <button
                      type="button"
                      id={`gen-tts-btn-${scene.sceneNumber}`}
                      disabled={scene.isAudioLoading || !scene.narration.trim()}
                      onClick={() => handleGenerateTTS(scene)}
                      className="flex items-center gap-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-200 transition-colors disabled:opacity-50 cursor-pointer"
                    >
                      {scene.isAudioLoading ? (
                        <>
                          <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                          <span>Synthesizing ({selectedVoice})...</span>
                        </>
                      ) : (
                        <>
                          <Volume2 className="h-3.5 w-3.5 text-emerald-400" />
                          <span>{scene.generatedAudioBase64 ? 'Re-generate Audio' : 'Generate TTS Audio'}</span>
                        </>
                      )}
                    </button>

                    {scene.generatedAudioBase64 && (
                      <button
                        type="button"
                        id={`play-tts-btn-${scene.sceneNumber}`}
                        onClick={() => handleTogglePlayAudio(scene)}
                        className="flex items-center gap-1.5 rounded-lg bg-emerald-600/20 hover:bg-emerald-600/30 border border-emerald-500/30 px-3 py-1.5 text-xs font-semibold text-emerald-300 transition-colors cursor-pointer"
                      >
                        {playingSceneId === scene.id ? (
                          <>
                            <Pause className="h-3.5 w-3.5" />
                            <span>Stop</span>
                          </>
                        ) : (
                          <>
                            <Play className="h-3.5 w-3.5" />
                            <span>Play Audio</span>
                          </>
                        )}
                      </button>
                    )}

                    {scene.audioError && (
                      <span className="text-[11px] text-rose-400 flex items-center gap-1">
                        <AlertCircle className="h-3 w-3" /> {scene.audioError}
                      </span>
                    )}
                  </div>
                </div>

                {/* Visual Prompt & Image Preview Column */}
                <div className="lg:col-span-5 space-y-3">
                  <div>
                    <label htmlFor={`visual-prompt-input-${scene.id}`} className="text-xs font-bold text-zinc-300 uppercase tracking-wide block mb-1">
                      Gemini Pro Image Prompt ({selectedResolution})
                    </label>
                    <textarea
                      id={`visual-prompt-input-${scene.id}`}
                      rows={3}
                      value={scene.visualPrompt}
                      onChange={(e) => handleSceneChange(scene.id, { visualPrompt: e.target.value })}
                      placeholder="Image generation prompt..."
                      className="w-full bg-zinc-950 border border-zinc-800 rounded-xl p-3 text-xs text-zinc-300 focus:outline-none focus:ring-1 focus:ring-sky-500 leading-relaxed font-mono"
                    />
                  </div>

                  {/* Image Controls & Preview */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <button
                        type="button"
                        id={`gen-image-btn-${scene.sceneNumber}`}
                        disabled={scene.isImageLoading || !scene.visualPrompt.trim()}
                        onClick={() => handleGenerateImage(scene)}
                        className="flex items-center gap-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 px-3 py-1.5 text-xs font-medium text-zinc-200 transition-colors disabled:opacity-50 cursor-pointer"
                      >
                        {scene.isImageLoading ? (
                          <>
                            <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                            <span>Rendering {selectedResolution}...</span>
                          </>
                        ) : (
                          <>
                            <ImageIcon className="h-3.5 w-3.5 text-sky-400" />
                            <span>{scene.generatedImageUrl ? `Re-render (${selectedResolution})` : `Generate ${selectedResolution} Image`}</span>
                          </>
                        )}
                      </button>

                      {scene.imageError && (
                        <span className="text-[11px] text-rose-400 flex items-center gap-1">
                          <AlertCircle className="h-3 w-3" /> Failed
                        </span>
                      )}
                    </div>

                    {scene.generatedImageUrl && (
                      <div className="relative rounded-xl overflow-hidden border border-zinc-700 bg-zinc-950 group aspect-video">
                        <img
                          src={scene.generatedImageUrl}
                          alt={`Scene ${scene.sceneNumber}`}
                          className="w-full h-full object-cover"
                        />
                        <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity p-2.5 flex items-end justify-between">
                          <span className="text-[10px] font-bold text-white bg-black/60 px-2 py-0.5 rounded">
                            {selectedResolution} Render
                          </span>
                          <a
                            href={scene.generatedImageUrl}
                            download={`scene-${scene.sceneNumber}.png`}
                            className="p-1 rounded bg-zinc-800 hover:bg-zinc-700 text-white"
                            title="Download Image"
                          >
                            <Download className="h-3.5 w-3.5" />
                          </a>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          ))}

          {/* Signature Outro Card */}
          <div className="rounded-xl bg-zinc-900 border border-zinc-800 p-4 space-y-1">
            <span className="text-[11px] font-bold uppercase tracking-wider text-emerald-400 flex items-center gap-1.5">
              📢 Signature Outro & Viral Call to Action
            </span>
            <p className="text-sm text-zinc-200 italic leading-relaxed">
              "{videoScript.signatureOutro}"
            </p>
          </div>
        </div>
      )}

      {/* VIEW 2: FULL PRODUCTION SCRIPT DOCUMENT */}
      {viewMode === 'document' && (
        <div className="rounded-2xl border border-zinc-800 bg-zinc-900 p-6 sm:p-8 space-y-6 shadow-xl">
          <div className="flex items-center justify-between border-b border-zinc-800 pb-4">
            <div>
              <h3 className="text-lg font-bold text-white">Full Production Script Document</h3>
              <p className="text-xs text-zinc-400">Formatted scene-by-scene script ready for production, editing, and voiceover.</p>
            </div>
            <button
              onClick={handleCopyMarkdown}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-orange-500 hover:bg-orange-400 text-zinc-950 font-bold text-xs shadow transition-all"
            >
              {copiedType === 'all' ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              <span>{copiedType === 'all' ? 'Copied to Clipboard!' : 'Copy Formatted Script'}</span>
            </button>
          </div>

          <div className="space-y-6 text-sm text-zinc-200 font-sans leading-relaxed">
            {/* Intro */}
            <div className="p-4 rounded-xl bg-zinc-950 border border-zinc-800/80">
              <span className="text-[11px] font-bold uppercase tracking-wider text-orange-400 block mb-1">
                [SHOW SIGNATURE INTRO]
              </span>
              <p className="text-zinc-200 font-medium italic">"{videoScript.signatureIntro}"</p>
            </div>

            {/* Scenes */}
            {videoScript.scenes.map((s) => (
              <div key={s.id} className="p-5 rounded-xl bg-zinc-950/60 border border-zinc-800 space-y-3">
                <div className="flex items-center justify-between border-b border-zinc-800/80 pb-2">
                  <div className="flex items-center gap-2">
                    <span className="px-2 py-0.5 rounded bg-orange-500/20 text-orange-400 text-xs font-bold">
                      SCENE {s.sceneNumber}
                    </span>
                    <span className="font-bold text-white">{s.title}</span>
                    {s.actPhase && <span className="text-xs text-zinc-500">({s.actPhase})</span>}
                  </div>
                  <span className="text-xs font-mono text-zinc-400">~{s.durationEst}s</span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs text-zinc-400">
                  {s.cinematography && (
                    <div>
                      <span className="font-semibold text-zinc-300">Camera / Visual Cue:</span> {s.cinematography}
                    </div>
                  )}
                  <div>
                    <span className="font-semibold text-orange-400">On-Screen Caption:</span> <code className="text-orange-300">{s.onScreenText}</code>
                  </div>
                  {s.soundEffect && (
                    <div>
                      <span className="font-semibold text-amber-300">SFX Audio:</span> {s.soundEffect}
                    </div>
                  )}
                  {s.retentionNote && (
                    <div>
                      <span className="font-semibold text-emerald-400">Retention Strategy:</span> {s.retentionNote}
                    </div>
                  )}
                </div>

                <div className="mt-2 pt-2 border-t border-zinc-900 bg-zinc-900/60 p-3.5 rounded-lg">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-400 block mb-1">
                    NARRATION SCRIPT:
                  </span>
                  <p className="text-base text-zinc-100 font-medium leading-relaxed">
                    "{s.narration}"
                  </p>
                </div>
              </div>
            ))}

            {/* Outro */}
            <div className="p-4 rounded-xl bg-zinc-950 border border-zinc-800/80">
              <span className="text-[11px] font-bold uppercase tracking-wider text-emerald-400 block mb-1">
                [SHOW SIGNATURE OUTRO & CTA]
              </span>
              <p className="text-zinc-200 font-medium italic">"{videoScript.signatureOutro}"</p>
            </div>
          </div>
        </div>
      )}

      {/* VIEW 3: TELEPROMPTER & RECORDING STUDIO */}
      {viewMode === 'teleprompter' && (
        <div className="rounded-2xl border border-zinc-800 bg-zinc-950 p-6 sm:p-8 space-y-5 shadow-2xl">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-zinc-800 pb-4">
            <div>
              <h3 className="text-lg font-bold text-white flex items-center gap-2">
                <Radio className="h-4 w-4 text-rose-500 animate-pulse" />
                <span>Teleprompter & Recording Studio</span>
              </h3>
              <p className="text-xs text-zinc-400">Auto-scrolling display for smooth voice recording and live narration.</p>
            </div>

            {/* Teleprompter Controls */}
            <div className="flex items-center gap-2.5 flex-wrap">
              <button
                type="button"
                onClick={() => setIsTeleprompterPlaying(!isTeleprompterPlaying)}
                className={`flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-bold transition-all shadow ${
                  isTeleprompterPlaying
                    ? 'bg-rose-600 hover:bg-rose-500 text-white'
                    : 'bg-emerald-600 hover:bg-emerald-500 text-white'
                }`}
              >
                {isTeleprompterPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                <span>{isTeleprompterPlaying ? 'Pause Teleprompter' : 'Start Auto-Scroll'}</span>
              </button>

              <div className="flex items-center gap-1.5 bg-zinc-900 px-3 py-1.5 rounded-xl border border-zinc-800">
                <span className="text-xs text-zinc-400">Speed:</span>
                <input
                  type="range"
                  min="0.5"
                  max="3.0"
                  step="0.25"
                  value={teleprompterSpeed}
                  onChange={(e) => setTeleprompterSpeed(parseFloat(e.target.value))}
                  className="w-20 accent-orange-500"
                />
                <span className="text-xs font-mono text-zinc-200">{teleprompterSpeed}x</span>
              </div>

              <div className="flex items-center gap-1 bg-zinc-900 p-1 rounded-xl border border-zinc-800">
                {(['sm', 'base', 'lg', 'xl', '2xl'] as const).map((size) => (
                  <button
                    key={size}
                    onClick={() => setTeleprompterFontSize(size)}
                    className={`px-2 py-1 rounded text-xs font-bold transition-all ${
                      teleprompterFontSize === size ? 'bg-orange-500 text-white' : 'text-zinc-400 hover:text-white'
                    }`}
                  >
                    {size.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Scrolling Canvas */}
          <div
            ref={teleprompterRef}
            className="h-[450px] overflow-y-auto rounded-xl bg-black border border-zinc-800 p-8 space-y-10 focus:outline-none select-text shadow-inner"
          >
            <div className="text-center py-6 border-b border-zinc-900">
              <h2 className="text-xl font-extrabold text-orange-400 uppercase tracking-widest">{videoScript.title}</h2>
              <p className="text-xs text-zinc-500 mt-1">~{totalDurationEst}s • {totalWords} words</p>
            </div>

            <div className="p-4 rounded-xl bg-zinc-900/40 border border-zinc-800/60">
              <span className="text-xs font-bold uppercase tracking-wider text-orange-400 block mb-2">Intro:</span>
              <p className={`text-zinc-300 font-medium italic ${
                teleprompterFontSize === 'sm' ? 'text-sm' :
                teleprompterFontSize === 'base' ? 'text-base' :
                teleprompterFontSize === 'lg' ? 'text-lg' :
                teleprompterFontSize === 'xl' ? 'text-xl leading-relaxed' :
                'text-2xl leading-relaxed'
              }`}>
                {videoScript.signatureIntro}
              </p>
            </div>

            {videoScript.scenes.map((s) => (
              <div key={s.id} className="space-y-3 p-5 rounded-2xl bg-zinc-950/80 border border-zinc-900">
                <div className="flex items-center justify-between text-xs text-orange-400 font-bold uppercase tracking-wider">
                  <span>Scene {s.sceneNumber}: {s.title}</span>
                  <span className="font-mono text-zinc-500">[{s.onScreenText}]</span>
                </div>
                <p className={`text-white font-semibold ${
                  teleprompterFontSize === 'sm' ? 'text-base' :
                  teleprompterFontSize === 'base' ? 'text-lg' :
                  teleprompterFontSize === 'lg' ? 'text-xl leading-relaxed' :
                  teleprompterFontSize === 'xl' ? 'text-2xl leading-relaxed tracking-wide' :
                  'text-3xl leading-relaxed tracking-wide'
                }`}>
                  {s.narration}
                </p>
                {s.soundEffect && (
                  <div className="text-xs text-amber-400 italic">
                    [SFX: {s.soundEffect}]
                  </div>
                )}
              </div>
            ))}

            <div className="p-4 rounded-xl bg-zinc-900/40 border border-zinc-800/60">
              <span className="text-xs font-bold uppercase tracking-wider text-emerald-400 block mb-2">Outro:</span>
              <p className={`text-zinc-300 font-medium italic ${
                teleprompterFontSize === 'sm' ? 'text-sm' :
                teleprompterFontSize === 'base' ? 'text-base' :
                teleprompterFontSize === 'lg' ? 'text-lg' :
                teleprompterFontSize === 'xl' ? 'text-xl leading-relaxed' :
                'text-2xl leading-relaxed'
              }`}>
                {videoScript.signatureOutro}
              </p>
            </div>

            <div className="text-center py-8 text-zinc-600 text-xs">
              — End of Script —
            </div>
          </div>
        </div>
      )}

      {/* Bottom Optional Action: Launch Live Video Player */}
      <div className="flex flex-col sm:flex-row items-center justify-between gap-4 pt-6 border-t border-zinc-800">
        <div className="text-xs text-zinc-400">
          Want to watch your script come to life with synced waveforms, dynamic captions, and Ken Burns animations?
        </div>
        <button
          id="proceed-to-studio-button"
          onClick={onProceedToStudio}
          className="flex items-center gap-2 rounded-xl bg-gradient-to-r from-orange-600 to-amber-500 px-6 py-3 text-sm font-semibold text-white shadow-lg shadow-orange-600/30 hover:from-orange-500 hover:to-amber-400 transition-all cursor-pointer shrink-0"
        >
          <Play className="h-4 w-4 fill-white" />
          <span>Launch Interactive Video Player</span>
          <ArrowRight className="h-4 w-4" />
        </button>
      </div>

      {/* Google Workspace Export Modal */}
      {videoScript && (
        <GoogleWorkspaceExportModal
          isOpen={isGoogleExportModalOpen}
          onClose={() => setIsGoogleExportModalOpen(false)}
          videoScript={videoScript}
          plan={plan}
          research={research}
          initialExportType={googleExportType}
        />
      )}
    </div>
  );
};

