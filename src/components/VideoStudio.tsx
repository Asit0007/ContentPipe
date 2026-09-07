import React, { useState, useEffect, useRef } from 'react';
import {
  Play,
  Pause,
  RotateCcw,
  SkipBack,
  SkipForward,
  Volume2,
  VolumeX,
  Maximize2,
  Download,
  Sparkles,
  Flame,
  Layers,
  Film,
  Smartphone,
  Monitor,
  Headphones,
  Video,
  Wand2,
  CheckCircle2,
  Radio,
  Copy,
  Check,
  ExternalLink,
  Link as LinkIcon,
  Music
} from 'lucide-react';
import { VideoScript, VideoScriptScene, IPBranding, ResearchData, NotebookLMAudioResult } from '../types';
import {
  pcmBase64ToWavDataUrl,
  speakWithBrowserSpeech,
  stopAllSpeechAndAudio,
  playWebAudioSFX
} from '../utils/audioUtils';
import { NotebookLMStudio } from './NotebookLMStudio';

interface VideoStudioProps {
  videoScript: VideoScript;
  researchData: ResearchData | null;
  activeIp: IPBranding | null;
  onBackToScript: () => void;
  onUpdateScript?: (script: VideoScript) => void;
}

export const VideoStudio: React.FC<VideoStudioProps> = ({
  videoScript,
  researchData,
  activeIp,
  onBackToScript,
  onUpdateScript,
}) => {
  const [studioMode, setStudioMode] = useState<'infotainment' | 'notebooklm'>('infotainment');
  const [currentSceneIndex, setCurrentSceneIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0); // 0..100 for current scene
  const [totalPlaybackSec, setTotalPlaybackSec] = useState(0);
  const [isMuted, setIsMuted] = useState(false);
  const [playerAspectRatio, setPlayerAspectRatio] = useState<'9:16' | '16:9'>(
    videoScript.aspectRatio === '9:16' ? '9:16' : '16:9'
  );
  const [isBatchGenerating, setIsBatchGenerating] = useState(false);
  const [batchProgress, setBatchProgress] = useState({ current: 0, total: 0, msg: '' });
  const [isRecordingVideo, setIsRecordingVideo] = useState(false);

  // NotebookLM Master Audio State
  const [notebooklmAudioResult, setNotebooklmAudioResult] = useState<NotebookLMAudioResult | null>(null);
  const [isGeneratingNotebookLMAudio, setIsGeneratingNotebookLMAudio] = useState(false);
  const [copiedAudioUrl, setCopiedAudioUrl] = useState(false);
  const [audioPlaybackSource, setAudioPlaybackSource] = useState<'scene_sync' | 'notebooklm_master'>('scene_sync');
  const [isMasterAudioPlaying, setIsMasterAudioPlaying] = useState(false);
  const masterAudioRef = useRef<HTMLAudioElement | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const animFrameRef = useRef<number | null>(null);
  const timerRef = useRef<number | null>(null);

  const currentScene = videoScript.scenes[currentSceneIndex] || videoScript.scenes[0];
  const sceneDurationSec = currentScene?.durationEst || 9;

  // Automated Batch Generation for Video & Audio Assets
  const handleAutoGenerateAllAssets = async () => {
    if (isBatchGenerating) return;
    setIsBatchGenerating(true);
    const scenes = [...videoScript.scenes];
    const totalOps = scenes.length * 2;
    let opCount = 0;

    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];

      // 1. Generate Voiceover TTS
      if (!scene.generatedAudioBase64) {
        setBatchProgress({
          current: ++opCount,
          total: totalOps,
          msg: `Synthesizing Audio Voiceover for Scene ${scene.sceneNumber}...`,
        });
        try {
          const res = await fetch('/api/tts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: scene.narration, voice: 'Puck' }),
          });
          const data = await res.json();
          if (data.audioBase64) {
            scenes[i] = { ...scenes[i], generatedAudioBase64: data.audioBase64 };
          }
        } catch (e) {
          console.warn('TTS error in batch:', e);
        }
      } else {
        opCount++;
      }

      // 2. Generate 4K Visual Scene
      if (!scene.generatedImageUrl) {
        setBatchProgress({
          current: ++opCount,
          total: totalOps,
          msg: `Rendering 4K Visual for Scene ${scene.sceneNumber}...`,
        });
        try {
          const res = await fetch('/api/generate-image', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              prompt: scene.visualPrompt,
              aspectRatio: videoScript.aspectRatio || '16:9',
              imageSize: '1K',
            }),
          });
          const data = await res.json();
          if (data.imageUrl) {
            scenes[i] = { ...scenes[i], generatedImageUrl: data.imageUrl };
          }
        } catch (e) {
          console.warn('Image error in batch:', e);
        }
      } else {
        opCount++;
      }
    }

    if (onUpdateScript) {
      onUpdateScript({ ...videoScript, scenes });
    }
    setIsBatchGenerating(false);
    setBatchProgress({ current: 0, total: 0, msg: '' });
    playWebAudioSFX('success');
  };

  // Generate Master Narration via Google NotebookLM Audio API
  const handleGenerateNotebookLMAudio = async () => {
    if (isGeneratingNotebookLMAudio) return;
    setIsGeneratingNotebookLMAudio(true);
    playWebAudioSFX('whoosh');

    try {
      const response = await fetch('/api/notebooklm/generate-audio', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          script: videoScript,
          researchData,
          host1Voice: 'Puck',
          host2Voice: 'Kore',
          podcastStyle: 'deep_dive',
        }),
      });

      const result = await response.json();
      if (result.audioUrl) {
        setNotebooklmAudioResult(result);
        playWebAudioSFX('success');
      }
    } catch (err) {
      console.warn('NotebookLM Audio API error in VideoStudio:', err);
    } finally {
      setIsGeneratingNotebookLMAudio(false);
    }
  };

  const handleCopyNotebookLMAudioUrl = () => {
    if (!notebooklmAudioResult?.audioUrl) return;
    const fullUrl = `${window.location.origin}${notebooklmAudioResult.audioUrl}`;
    navigator.clipboard.writeText(fullUrl);
    setCopiedAudioUrl(true);
    playWebAudioSFX('pop');
    setTimeout(() => setCopiedAudioUrl(false), 2000);
  };

  const handleToggleMasterAudio = () => {
    if (!notebooklmAudioResult) return;
    if (isMasterAudioPlaying) {
      if (masterAudioRef.current) {
        masterAudioRef.current.pause();
      }
      setIsMasterAudioPlaying(false);
    } else {
      stopAllSpeechAndAudio();
      setIsPlaying(false);
      if (!masterAudioRef.current) {
        masterAudioRef.current = new Audio(notebooklmAudioResult.audioUrl);
        masterAudioRef.current.onended = () => setIsMasterAudioPlaying(false);
      }
      masterAudioRef.current.muted = isMuted;
      masterAudioRef.current.play().catch(() => {});
      setIsMasterAudioPlaying(true);
      playWebAudioSFX('pop');
    }
  };


  // Canvas visual rendering loop for dynamic procedural cyberpunk background & waveforms
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let time = 0;
    const render = () => {
      const w = canvas.width;
      const h = canvas.height;

      // Dark cyber gradient
      const grad = ctx.createLinearGradient(0, 0, w, h);
      grad.addColorStop(0, '#09090b');
      grad.addColorStop(0.5, '#18181b');
      grad.addColorStop(1, '#09090b');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);

      // Glowing grid lines
      ctx.strokeStyle = 'rgba(249, 115, 22, 0.08)';
      ctx.lineWidth = 1;
      const gridSize = 32;
      for (let x = 0; x < w; x += gridSize) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
      }
      for (let y = 0; y < h; y += gridSize) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }

      // Animated audio spectrum waves at bottom
      const bars = 40;
      const barW = w / bars - 2;
      for (let i = 0; i < bars; i++) {
        let barH = 6;
        if (isPlaying) {
          const s = Math.sin(time * 3 + i * 0.4) * Math.cos(time * 2 + i * 0.2);
          barH = Math.max(6, Math.abs(s) * (h * 0.35));
        }
        ctx.fillStyle = isPlaying
          ? `rgba(249, 115, 22, ${0.3 + (barH / h) * 0.7})`
          : 'rgba(113, 113, 122, 0.2)';
        ctx.beginPath();
        ctx.roundRect(i * (barW + 2), h - barH - 12, barW, barH, 2);
        ctx.fill();
      }

      time += 0.03;
      animFrameRef.current = requestAnimationFrame(render);
    };

    render();

    return () => {
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    };
  }, [isPlaying]);

  // Audio Playback & Guaranteed Speech Synthesis Engine
  useEffect(() => {
    if (!isPlaying || !currentScene) {
      stopAllSpeechAndAudio();
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
      return;
    }

    // Play SFX on scene transition
    if (currentScene.soundEffect) {
      playWebAudioSFX('whoosh');
    }

    if (currentScene.generatedAudioBase64) {
      // 1. Play Gemini TTS generated WAV audio
      const wavUrl = pcmBase64ToWavDataUrl(currentScene.generatedAudioBase64);
      const audio = new Audio(wavUrl);
      audio.muted = isMuted;
      audioRef.current = audio;

      audio.play().catch((err) => {
        console.warn('Audio play exception, fallback to browser speech:', err);
        speakFallback();
      });

      audio.onended = () => {
        handleNextScene();
      };
    } else {
      // 2. Guaranteed Browser Web Speech Synthesis
      speakFallback();
    }

    function speakFallback() {
      const utt = speakWithBrowserSpeech(currentScene.narration, {
        voiceGender: 'male',
        pitch: 1.0,
        rate: 1.05,
        volume: isMuted ? 0 : 1,
        onEnd: () => {
          handleNextScene();
        },
      });

      if (!utt) {
        const fallbackTimer = setTimeout(() => {
          handleNextScene();
        }, sceneDurationSec * 1000);
        return () => clearTimeout(fallbackTimer);
      }
    }
  }, [currentSceneIndex, isPlaying, isMuted, currentScene]);

  // Progress Bar timer
  useEffect(() => {
    if (!isPlaying) {
      if (timerRef.current) clearInterval(timerRef.current);
      return;
    }

    const intervalMs = 100;
    const step = (intervalMs / (sceneDurationSec * 1000)) * 100;

    timerRef.current = window.setInterval(() => {
      setProgress((prev) => {
        if (prev + step >= 100) {
          return 100;
        }
        return prev + step;
      });
      setTotalPlaybackSec((prev) => prev + intervalMs / 1000);
    }, intervalMs);

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [isPlaying, currentSceneIndex, sceneDurationSec]);

  const handleNextScene = () => {
    setProgress(0);
    if (currentSceneIndex < videoScript.scenes.length - 1) {
      setCurrentSceneIndex((prev) => prev + 1);
      playWebAudioSFX('pop');
    } else {
      setIsPlaying(false);
      setCurrentSceneIndex(0);
      playWebAudioSFX('success');
    }
  };

  const handlePrevScene = () => {
    setProgress(0);
    if (currentSceneIndex > 0) {
      setCurrentSceneIndex((prev) => prev - 1);
    }
  };

  const handleTogglePlay = () => {
    if (isPlaying) {
      setIsPlaying(false);
      stopAllSpeechAndAudio();
    } else {
      setIsPlaying(true);
      playWebAudioSFX('whoosh');
    }
  };

  const handleRestart = () => {
    stopAllSpeechAndAudio();
    setIsPlaying(false);
    setCurrentSceneIndex(0);
    setProgress(0);
    setTotalPlaybackSec(0);
  };

  // Fullscreen toggle
  const handleToggleFullscreen = () => {
    if (!stageRef.current) return;
    if (!document.fullscreenElement) {
      stageRef.current.requestFullscreen().catch((err) => console.error(err));
    } else {
      document.exitFullscreen().catch((err) => console.error(err));
    }
  };

  // Export full video script as formatted markdown
  const handleExportScriptMarkdown = () => {
    const md = `# ${videoScript.title}
**Target Platform:** ${videoScript.targetPlatform}
**Estimated Duration:** ~${videoScript.estimatedTotalDuration}s
**Channel IP Brand:** ${activeIp ? activeIp.name : 'HN Infotainment'}

---

## Signature Intro
> "${videoScript.signatureIntro}"

---

## Scene Breakdown

${videoScript.scenes
  .map(
    (s) => `### Scene ${s.sceneNumber}: ${s.title} (~${s.durationEst}s)
- **On-Screen Caption:** \`${s.onScreenText}\`
- **SFX Cue:** ${s.soundEffect || 'None'}
- **Visual Prompt:** *"${s.visualPrompt}"*
- **Voiceover Narration:**
  "${s.narration}"
`
  )
  .join('\n---\n\n')}

---

## Signature Outro
> "${videoScript.signatureOutro}"
`;

    const blob = new Blob([md], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${videoScript.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-script.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-8 max-w-5xl mx-auto">
      {/* Studio Format Switcher Banner */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-zinc-800 pb-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="h-2.5 w-2.5 rounded-full bg-orange-500 animate-ping" />
            <span className="text-xs font-bold uppercase tracking-wider text-orange-400">
              Stage 5: Live Infotainment & Podcast Studio
            </span>
          </div>
          <h1 className="text-xl sm:text-2xl font-bold text-white">{videoScript.title}</h1>
        </div>

        {/* Studio Mode Selector */}
        <div className="flex items-center gap-2">
          <div className="flex rounded-xl bg-zinc-900 border border-zinc-800 p-1">
            <button
              onClick={() => {
                setStudioMode('infotainment');
                stopAllSpeechAndAudio();
              }}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-lg transition-all ${
                studioMode === 'infotainment'
                  ? 'bg-orange-500 text-white shadow-md shadow-orange-500/30'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              <Film className="h-3.5 w-3.5" />
              <span>Infotainment Video</span>
            </button>
            <button
              onClick={() => {
                setStudioMode('notebooklm');
                stopAllSpeechAndAudio();
              }}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-lg transition-all ${
                studioMode === 'notebooklm'
                  ? 'bg-cyan-500 text-white shadow-md shadow-cyan-500/30'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              <Headphones className="h-3.5 w-3.5" />
              <span>NotebookLM 2-Host Podcast</span>
            </button>
          </div>
        </div>
      </div>

      {/* If NotebookLM Studio Mode Selected */}
      {studioMode === 'notebooklm' ? (
        <NotebookLMStudio
          researchData={researchData}
          activeIp={activeIp}
          onSwitchToInfotainment={() => setStudioMode('infotainment')}
        />
      ) : (
        /* Infotainment Video Scene Player Mode */
        <div className="space-y-6">
          {/* Quick Asset Auto-Generator Banner if any scene lacks images or audio */}
          {(!videoScript.scenes.some((s) => s.generatedImageUrl) ||
            !videoScript.scenes.some((s) => s.generatedAudioBase64)) && (
            <div className="rounded-2xl border border-orange-500/30 bg-orange-950/20 p-4 flex flex-col sm:flex-row items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-xl bg-orange-500/20 border border-orange-500/40 flex items-center justify-center shrink-0">
                  <Wand2 className="h-5 w-5 text-orange-400" />
                </div>
                <div>
                  <h4 className="text-sm font-bold text-white">Generate All AI Voices & 4K Visuals</h4>
                  <p className="text-xs text-zinc-400">
                    One-click generate high-definition Gemini visuals and studio narration for all scenes.
                  </p>
                </div>
              </div>

              <button
                onClick={handleAutoGenerateAllAssets}
                disabled={isBatchGenerating}
                className="w-full sm:w-auto flex items-center justify-center gap-2 px-5 py-2 rounded-xl bg-orange-500 hover:bg-orange-400 text-white text-xs font-bold shadow-lg shadow-orange-500/30 transition-all disabled:opacity-50"
              >
                {isBatchGenerating ? (
                  <>
                    <Sparkles className="h-4 w-4 animate-spin" />
                    <span>{batchProgress.msg || 'Generating Assets...'}</span>
                  </>
                ) : (
                  <>
                    <Sparkles className="h-4 w-4" />
                    <span>Generate All Video & Audio</span>
                  </>
                )}
              </button>
            </div>
          )}

          {/* Google NotebookLM High-Quality Audio Narration Service Banner */}
          <div className="rounded-2xl border border-cyan-500/40 bg-gradient-to-r from-cyan-950/40 via-zinc-900 to-zinc-900 p-4 shadow-xl flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
            <div className="flex items-start gap-3.5">
              <div className="h-10 w-10 rounded-xl bg-cyan-500/20 border border-cyan-500/40 flex items-center justify-center shrink-0">
                <Radio className="h-5 w-5 text-cyan-400" />
              </div>
              <div className="space-y-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <h4 className="text-sm font-bold text-white">Google NotebookLM Audio Narration Service</h4>
                  <span className="text-[10px] bg-cyan-500/20 text-cyan-300 font-semibold px-2 py-0.5 rounded border border-cyan-500/30">
                    Dual-Voice AI Audio
                  </span>
                </div>
                <p className="text-xs text-zinc-400 max-w-xl">
                  Synthesize an uninterrupted master audio narration with professional conversational pacing, dual-host commentary, and full audio track download.
                </p>
                {notebooklmAudioResult && (
                  <div className="flex items-center gap-2 pt-1 flex-wrap">
                    <span className="text-[11px] text-zinc-300 font-mono bg-black/50 px-2 py-0.5 rounded border border-zinc-800">
                      URL: {notebooklmAudioResult.audioUrl}
                    </span>
                    <span className="text-[10px] text-emerald-400 font-semibold">
                      ✓ {notebooklmAudioResult.fileSizeFormatted} • {notebooklmAudioResult.format}
                    </span>
                  </div>
                )}
              </div>
            </div>

            <div className="flex items-center gap-2 w-full md:w-auto justify-end flex-wrap">
              {notebooklmAudioResult ? (
                <>
                  <button
                    onClick={handleToggleMasterAudio}
                    className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-cyan-300 border border-cyan-500/30 text-xs font-bold transition-all"
                  >
                    {isMasterAudioPlaying ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                    <span>{isMasterAudioPlaying ? 'Pause Master Stream' : 'Play Master Audio'}</span>
                  </button>
                  <button
                    onClick={handleCopyNotebookLMAudioUrl}
                    className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-zinc-900 hover:bg-zinc-800 text-zinc-200 border border-zinc-700 text-xs font-medium transition-all"
                    title="Copy Audio File URL"
                  >
                    {copiedAudioUrl ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5 text-cyan-400" />}
                    <span>{copiedAudioUrl ? 'Copied URL' : 'Copy URL'}</span>
                  </button>
                  <a
                    href={notebooklmAudioResult.audioUrl}
                    download="notebooklm-narration.wav"
                    className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-zinc-950 text-xs font-bold transition-all"
                  >
                    <Download className="h-3.5 w-3.5" />
                    <span>Download .wav</span>
                  </a>
                </>
              ) : (
                <button
                  onClick={handleGenerateNotebookLMAudio}
                  disabled={isGeneratingNotebookLMAudio}
                  className="w-full md:w-auto flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-gradient-to-r from-cyan-500 to-blue-500 hover:from-cyan-400 hover:to-blue-400 text-zinc-950 text-xs font-extrabold shadow-lg shadow-cyan-500/20 transition-all disabled:opacity-50"
                >
                  {isGeneratingNotebookLMAudio ? (
                    <>
                      <Sparkles className="h-4 w-4 animate-spin text-zinc-950" />
                      <span>Sending to NotebookLM API...</span>
                    </>
                  ) : (
                    <>
                      <Headphones className="h-4 w-4 text-zinc-950" />
                      <span>Synthesize NotebookLM Audio</span>
                    </>
                  )}
                </button>
              )}
            </div>
          </div>


          {/* Top Stage Bar */}
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <div className="flex rounded-lg bg-zinc-900 border border-zinc-800 p-1">
                <button
                  onClick={() => setPlayerAspectRatio('9:16')}
                  className={`flex items-center gap-1 px-2.5 py-1 text-xs font-semibold rounded-md transition-all ${
                    playerAspectRatio === '9:16' ? 'bg-orange-500 text-white' : 'text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  <Smartphone className="h-3 w-3" /> 9:16 Vertical
                </button>
                <button
                  onClick={() => setPlayerAspectRatio('16:9')}
                  className={`flex items-center gap-1 px-2.5 py-1 text-xs font-semibold rounded-md transition-all ${
                    playerAspectRatio === '16:9' ? 'bg-orange-500 text-white' : 'text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  <Monitor className="h-3 w-3" /> 16:9 Landscape
                </button>
              </div>
            </div>

            <button
              onClick={handleExportScriptMarkdown}
              className="flex items-center gap-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-200 transition-colors"
            >
              <Download className="h-3.5 w-3.5 text-orange-400" />
              <span>Export Script (.md)</span>
            </button>
          </div>

          {/* Main Studio Viewport Grid */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
            {/* Left: Player Canvas / Stage */}
            <div className="lg:col-span-8 flex flex-col items-center">
              <div
                ref={stageRef}
                id="video-player-stage"
                className={`relative overflow-hidden rounded-2xl border border-zinc-800 bg-black shadow-2xl transition-all duration-300 ${
                  playerAspectRatio === '9:16' ? 'w-full max-w-[340px] aspect-[9/16]' : 'w-full aspect-[16/9]'
                }`}
              >
                {/* Visual Scene Background (AI Image or Dynamic Procedural Cyber Canvas) */}
                {currentScene.generatedImageUrl ? (
                  <img
                    src={currentScene.generatedImageUrl}
                    alt={currentScene.title}
                    key={currentScene.id}
                    className={`w-full h-full object-cover transition-transform duration-[8000ms] ease-out ${
                      isPlaying ? 'scale-110 translate-x-1 -translate-y-1' : 'scale-100'
                    }`}
                  />
                ) : (
                  <div className="relative w-full h-full">
                    <canvas
                      ref={canvasRef}
                      width={640}
                      height={playerAspectRatio === '9:16' ? 1136 : 360}
                      className="w-full h-full"
                    />
                    <div className="absolute inset-0 flex flex-col items-center justify-center p-6 text-center z-10 pointer-events-none">
                      <div className="h-14 w-14 rounded-2xl bg-orange-500/20 border border-orange-500/40 flex items-center justify-center mb-3 animate-pulse">
                        <Flame className="h-7 w-7 text-orange-400" />
                      </div>
                      <h4 className="text-sm font-bold text-white mb-1 drop-shadow-md">{currentScene.title}</h4>
                      <p className="text-xs text-zinc-300 max-w-[260px] line-clamp-3 italic drop-shadow">
                        "{currentScene.visualPrompt}"
                      </p>
                      <span className="mt-3 text-[10px] uppercase tracking-wider text-orange-400 bg-orange-500/10 px-2.5 py-0.5 rounded-full border border-orange-500/30">
                        {currentScene.visualType} live visualizer
                      </span>
                    </div>
                  </div>
                )}

                {/* Overlays & Watermark */}
                <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/25 to-black/60 pointer-events-none" />

                {/* Top Bar inside Player */}
                <div className="absolute top-4 left-4 right-4 flex items-center justify-between text-xs text-white z-10">
                  <div className="flex items-center gap-2">
                    <div className="flex h-6 w-6 items-center justify-center rounded-md bg-orange-600 font-bold text-[11px] shadow">
                      Y
                    </div>
                    <span className="font-bold tracking-tight text-white drop-shadow-md">
                      {activeIp ? activeIp.name : 'The Orange Thread'}
                    </span>
                  </div>

                  <div className="flex items-center gap-2">
                    {currentScene.soundEffect && (
                      <span className="bg-black/60 backdrop-blur-md px-2 py-0.5 rounded-full text-[10px] text-amber-300 font-medium border border-amber-500/30">
                        🎵 {currentScene.soundEffect}
                      </span>
                    )}
                    <span className="bg-black/60 backdrop-blur-md px-2 py-0.5 rounded-full text-[10px] text-zinc-300 border border-zinc-700">
                      {currentSceneIndex + 1}/{videoScript.scenes.length}
                    </span>
                  </div>
                </div>

                {/* Kinetic On-Screen Caption Badge */}
                <div className="absolute top-14 left-4 right-4 z-10 flex justify-center">
                  <div className="rounded-xl bg-orange-500/90 backdrop-blur-md px-3.5 py-1.5 text-center shadow-lg shadow-orange-950/60 border border-orange-300/40 transform scale-105 animate-pulse">
                    <span className="text-xs sm:text-sm font-extrabold uppercase tracking-wider text-zinc-950">
                      {currentScene.onScreenText}
                    </span>
                  </div>
                </div>

                {/* Bottom Subtitle / Voiceover Box */}
                <div className="absolute bottom-6 left-4 right-4 z-10 space-y-2">
                  <div className="rounded-xl bg-black/85 backdrop-blur-md p-3.5 border border-zinc-800/80 shadow-2xl">
                    <div className="flex items-center justify-between text-[10px] text-zinc-400 font-semibold mb-1">
                      <span className="text-orange-400 uppercase tracking-wider flex items-center gap-1">
                        <Volume2 className="h-3 w-3" /> Spoken Voiceover Narration
                      </span>
                      <span>Scene {currentSceneIndex + 1}</span>
                    </div>
                    <p className="text-xs sm:text-sm font-bold text-white leading-relaxed drop-shadow">
                      "{currentScene.narration}"
                    </p>
                  </div>

                  {/* Scene Progress Bar */}
                  <div className="h-1 w-full bg-zinc-800/80 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-orange-500 transition-all duration-100"
                      style={{ width: `${progress}%` }}
                    />
                  </div>
                </div>
              </div>

              {/* Player Controls Bar */}
              <div className="w-full mt-4 rounded-2xl border border-zinc-800 bg-zinc-900 p-4 shadow-lg flex flex-col sm:flex-row items-center justify-between gap-4">
                {/* Play/Pause & Step Controls */}
                <div className="flex items-center gap-2">
                  <button
                    id="player-restart-button"
                    onClick={handleRestart}
                    className="p-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition-colors"
                    title="Restart"
                  >
                    <RotateCcw className="h-4 w-4" />
                  </button>
                  <button
                    id="player-prev-button"
                    onClick={handlePrevScene}
                    disabled={currentSceneIndex === 0}
                    className="p-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition-colors disabled:opacity-40"
                    title="Previous Scene"
                  >
                    <SkipBack className="h-4 w-4" />
                  </button>
                  <button
                    id="player-play-pause-button"
                    onClick={handleTogglePlay}
                    className="flex items-center gap-2 rounded-xl bg-orange-500 hover:bg-orange-400 px-6 py-2.5 text-sm font-extrabold text-white shadow-lg shadow-orange-500/30 transition-all cursor-pointer active:scale-95"
                  >
                    {isPlaying ? (
                      <>
                        <Pause className="h-4 w-4 fill-white" />
                        <span>Pause</span>
                      </>
                    ) : (
                      <>
                        <Play className="h-4 w-4 fill-white" />
                        <span>Play Video with Audio</span>
                      </>
                    )}
                  </button>
                  <button
                    id="player-next-button"
                    onClick={handleNextScene}
                    disabled={currentSceneIndex === videoScript.scenes.length - 1}
                    className="p-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition-colors disabled:opacity-40"
                    title="Next Scene"
                  >
                    <SkipForward className="h-4 w-4" />
                  </button>
                </div>

                {/* Timeline info & secondary buttons */}
                <div className="flex items-center gap-3 text-xs text-zinc-400">
                  <span className="font-mono">
                    Scene {currentSceneIndex + 1} of {videoScript.scenes.length}
                  </span>

                  <button
                    onClick={() => setIsMuted((m) => !m)}
                    className="p-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition-colors"
                    title={isMuted ? 'Unmute' : 'Mute'}
                  >
                    {isMuted ? <VolumeX className="h-4 w-4 text-rose-400" /> : <Volume2 className="h-4 w-4 text-emerald-400" />}
                  </button>

                  <button
                    onClick={handleToggleFullscreen}
                    className="p-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 transition-colors"
                    title="Fullscreen Stage"
                  >
                    <Maximize2 className="h-4 w-4" />
                  </button>
                </div>
              </div>
            </div>

            {/* Right: Scene Queue & Selector */}
            <div className="lg:col-span-4 space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold uppercase tracking-wider text-zinc-300 flex items-center gap-2">
                  <Layers className="h-4 w-4 text-orange-400" />
                  <span>Scene Playlist ({videoScript.scenes.length})</span>
                </h3>
                <button
                  onClick={onBackToScript}
                  className="text-xs text-orange-400 hover:text-orange-300 transition-colors font-medium"
                >
                  Edit Script & Assets →
                </button>
              </div>

              <div className="space-y-2.5 max-h-[580px] overflow-y-auto pr-1">
                {videoScript.scenes.map((scene, idx) => {
                  const isActive = currentSceneIndex === idx;
                  return (
                    <div
                      key={scene.id}
                      id={`playlist-scene-${scene.sceneNumber}`}
                      onClick={() => {
                        setCurrentSceneIndex(idx);
                        setProgress(0);
                      }}
                      className={`cursor-pointer rounded-xl border p-3 transition-all ${
                        isActive
                          ? 'border-orange-500 bg-orange-950/30 ring-1 ring-orange-500/40 shadow-md'
                          : 'border-zinc-800 bg-zinc-900/80 hover:border-zinc-700 hover:bg-zinc-900'
                      }`}
                    >
                      <div className="flex items-center justify-between mb-1.5">
                        <div className="flex items-center gap-2">
                          <span
                            className={`flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold ${
                              isActive ? 'bg-orange-500 text-white' : 'bg-zinc-800 text-zinc-400'
                            }`}
                          >
                            {scene.sceneNumber}
                          </span>
                          <h5 className="text-xs font-bold text-zinc-200 line-clamp-1">{scene.title}</h5>
                        </div>
                        <span className="text-[10px] text-zinc-500 font-mono">~{scene.durationEst}s</span>
                      </div>

                      <p className="text-[11px] text-zinc-400 line-clamp-2 italic mb-2">
                        "{scene.narration}"
                      </p>

                      <div className="flex items-center justify-between text-[10px] text-zinc-500 pt-1 border-t border-zinc-800/60">
                        <span className="font-semibold text-orange-400/90 truncate max-w-[150px]">
                          {scene.onScreenText}
                        </span>
                        <div className="flex items-center gap-1.5">
                          {scene.generatedAudioBase64 ? (
                            <span className="text-emerald-400 font-semibold" title="Gemini TTS Voice Ready">
                              🎙️ AI Voice
                            </span>
                          ) : (
                            <span className="text-amber-400" title="Web Speech Voice Ready">
                              🔊 Live Synth
                            </span>
                          )}
                          {scene.generatedImageUrl ? (
                            <span className="text-sky-400 font-semibold" title="4K Visual Ready">
                              🖼️ 4K Scene
                            </span>
                          ) : (
                            <span className="text-zinc-500" title="Procedural Visual">
                              ⚡ Cyber Canvas
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
