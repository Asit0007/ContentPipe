import React, { useState, useEffect, useRef } from 'react';
import { Play, Pause, RotateCcw, Volume2, VolumeX, Sparkles, Mic, Download, Share2, Headphones, Radio, Flame, CheckCircle, RefreshCw, Layers, Copy, Check, ExternalLink, Link as LinkIcon } from 'lucide-react';
import { NotebookLMPodcast, PodcastTurn, ResearchData, IPBranding, NotebookLMAudioResult } from '../types';
import { speakWithBrowserSpeech, stopAllSpeechAndAudio, playWebAudioSFX, playAudioFromBase64, pcmBase64ToWavDataUrl } from '../utils/audioUtils';

interface NotebookLMStudioProps {
  researchData: ResearchData | null;
  activeIp: IPBranding | null;
  onSwitchToInfotainment: () => void;
}

export const NotebookLMStudio: React.FC<NotebookLMStudioProps> = ({
  researchData,
  activeIp,
  onSwitchToInfotainment,
}) => {
  const [podcast, setPodcast] = useState<NotebookLMPodcast | null>(null);
  const [audioResult, setAudioResult] = useState<NotebookLMAudioResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isGeneratingMasterAudio, setIsGeneratingMasterAudio] = useState(false);
  const [currentTurnIndex, setCurrentTurnIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [activeSpeakerAnim, setActiveSpeakerAnim] = useState<'alex' | 'morgan' | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const animFrameRef = useRef<number | null>(null);

  // Fetch or generate the NotebookLM 2-Host Podcast Dialogue
  const generatePodcast = async () => {
    setIsLoading(true);
    stopAllSpeechAndAudio();
    setIsPlaying(false);
    setCurrentTurnIndex(0);

    try {
      const response = await fetch('/api/notebooklm-dialogue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          researchData,
          topicText: researchData?.topicTitle || 'Hacker News Viral Discovery',
        }),
      });

      const data = await response.json();
      setPodcast(data);
      playWebAudioSFX('success');

      // Also trigger the backend NotebookLM audio service
      generateMasterAudioFile(data);
    } catch (e) {
      console.error('Failed to generate NotebookLM dialogue:', e);
    } finally {
      setIsLoading(false);
    }
  };

  // Generate and fetch the backend audio file URL
  const generateMasterAudioFile = async (podcastData?: NotebookLMPodcast) => {
    setIsGeneratingMasterAudio(true);
    try {
      const res = await fetch('/api/notebooklm/generate-audio', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          researchData,
          script: {
            title: podcastData?.title || podcast?.title || researchData?.topicTitle,
            scenes: (podcastData?.turns || podcast?.turns || []).map((t, idx) => ({
              sceneNumber: idx + 1,
              title: t.speaker,
              narration: t.text,
              durationEst: t.durationEst || 8,
            })),
          },
          host1Voice: 'Puck',
          host2Voice: 'Kore',
        }),
      });
      const data = await res.json();
      if (data.audioUrl) {
        setAudioResult(data);
      }
    } catch (err) {
      console.warn('NotebookLM master audio service error:', err);
    } finally {
      setIsGeneratingMasterAudio(false);
    }
  };

  useEffect(() => {
    generatePodcast();
  }, [researchData?.topicTitle]);

  // Audio frequency visualization canvas animation loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let phase = 0;
    const render = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const width = canvas.width;
      const height = canvas.height;
      const midY = height / 2;

      const numBars = 36;
      const barWidth = width / numBars - 3;

      for (let i = 0; i < numBars; i++) {
        let barHeight = 4;
        if (isPlaying) {
          const freq = Math.sin(phase + i * 0.3) * Math.cos(phase * 0.7 + i * 0.2);
          barHeight = Math.max(4, Math.abs(freq) * (height * 0.75));
        }

        const isAlexSpeaking = activeSpeakerAnim === 'alex';
        const color = isPlaying
          ? isAlexSpeaking
            ? `rgba(249, 115, 22, ${0.4 + (barHeight / height) * 0.6})`
            : `rgba(6, 182, 212, ${0.4 + (barHeight / height) * 0.6})`
          : 'rgba(113, 113, 122, 0.3)';

        ctx.fillStyle = color;
        const x = i * (barWidth + 3);
        const y = midY - barHeight / 2;
        ctx.beginPath();
        ctx.roundRect(x, y, barWidth, barHeight, 2);
        ctx.fill();
      }

      phase += isPlaying ? 0.12 : 0.02;
      animFrameRef.current = requestAnimationFrame(render);
    };

    render();

    return () => {
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    };
  }, [isPlaying, activeSpeakerAnim]);

  // Playback execution for each turn
  useEffect(() => {
    if (!isPlaying || !podcast || !podcast.turns || podcast.turns.length === 0) {
      stopAllSpeechAndAudio();
      setActiveSpeakerAnim(null);
      return;
    }

    const turn = podcast.turns[currentTurnIndex];
    if (!turn) {
      setIsPlaying(false);
      setCurrentTurnIndex(0);
      setActiveSpeakerAnim(null);
      return;
    }

    const isHost1 = turn.speaker.includes('Alex') || turn.speaker.includes('Host 1');
    setActiveSpeakerAnim(isHost1 ? 'alex' : 'morgan');

    if (turn.audioBase64) {
      const wavUrl = pcmBase64ToWavDataUrl(turn.audioBase64);
      const audio = new Audio(wavUrl);
      audio.muted = isMuted;
      audioRef.current = audio;
      audio.play().catch(() => {});
      audio.onended = () => {
        handleNextTurn();
      };
    } else {
      const utterance = speakWithBrowserSpeech(turn.text, {
        voiceGender: isHost1 ? 'male' : 'female',
        pitch: isHost1 ? 0.95 : 1.15,
        rate: 1.05,
        volume: isMuted ? 0 : 1,
        onEnd: () => {
          handleNextTurn();
        },
      });

      if (!utterance) {
        const timer = setTimeout(() => {
          handleNextTurn();
        }, (turn.durationEst || 7) * 1000);
        return () => clearTimeout(timer);
      }
    }
  }, [isPlaying, currentTurnIndex, podcast, isMuted]);

  const handleNextTurn = () => {
    if (!podcast) return;
    if (currentTurnIndex < podcast.turns.length - 1) {
      setCurrentTurnIndex((prev) => prev + 1);
      playWebAudioSFX('pop');
    } else {
      setIsPlaying(false);
      setCurrentTurnIndex(0);
      setActiveSpeakerAnim(null);
      playWebAudioSFX('success');
    }
  };

  const handlePrevTurn = () => {
    if (currentTurnIndex > 0) {
      setCurrentTurnIndex((prev) => prev - 1);
    }
  };

  const handleTogglePlay = () => {
    if (isPlaying) {
      setIsPlaying(false);
      stopAllSpeechAndAudio();
      setActiveSpeakerAnim(null);
    } else {
      setIsPlaying(true);
      playWebAudioSFX('whoosh');
    }
  };

  const handleRestart = () => {
    stopAllSpeechAndAudio();
    setIsPlaying(false);
    setCurrentTurnIndex(0);
    setActiveSpeakerAnim(null);
  };

  const handleCopyAudioUrl = () => {
    if (!audioResult?.audioUrl) return;
    const fullUrl = `${window.location.origin}${audioResult.audioUrl}`;
    navigator.clipboard.writeText(fullUrl);
    setCopiedUrl(true);
    playWebAudioSFX('pop');
    setTimeout(() => setCopiedUrl(false), 2000);
  };

  const handleExportPodcastTranscript = () => {
    if (!podcast) return;
    const content = `# ${podcast.title}
**NotebookLM Deep Dive Audio Overview**
Channel IP: ${activeIp ? activeIp.name : 'The Orange Thread'}
Audio URL: ${audioResult ? `${window.location.origin}${audioResult.audioUrl}` : 'Generating...'}
Hosts: ${podcast.hosts.host1.name} (${podcast.hosts.host1.title}) & ${podcast.hosts.host2.name} (${podcast.hosts.host2.title})

---
### Summary
${podcast.episodeSummary}

---
### Key Takeaways
${podcast.keyTakeaways.map((t) => `- ${t}`).join('\n')}

---
### Full 2-Host Dialogue Transcript
${podcast.turns
  .map(
    (t, i) => `**${t.speaker}** (${t.speakerRole}) [Tone: ${t.tone}]:
> "${t.text}"`
  )
  .join('\n\n')}
`;

    const blob = new Blob([content], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${podcast.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-notebooklm.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[450px] rounded-2xl border border-zinc-800 bg-zinc-900/50 p-8 text-center space-y-4">
        <div className="relative">
          <div className="h-16 w-16 rounded-2xl bg-cyan-500/10 border border-cyan-500/30 flex items-center justify-center animate-pulse">
            <Radio className="h-8 w-8 text-cyan-400 animate-spin" style={{ animationDuration: '4s' }} />
          </div>
        </div>
        <div className="space-y-1 max-w-md">
          <h3 className="text-lg font-bold text-white">Interfacing with Google NotebookLM API</h3>
          <p className="text-xs text-zinc-400">
            Synthesizing 2-host deep-dive audio dialogue and generating high-fidelity audio stream...
          </p>
        </div>
      </div>
    );
  }

  if (!podcast) return null;

  const currentTurn = podcast.turns[currentTurnIndex] || podcast.turns[0];
  const isAlexTurn = currentTurn.speaker.includes('Alex') || currentTurn.speaker.includes('Host 1');

  return (
    <div className="space-y-8 max-w-5xl mx-auto">
      {/* Top Header Controls */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="inline-flex items-center gap-2 rounded-full bg-cyan-500/10 border border-cyan-500/20 px-3 py-1 text-xs font-semibold text-cyan-400 mb-2">
            <Headphones className="h-3.5 w-3.5" />
            <span>NotebookLM 2-Host Deep Dive Audio & Video Studio</span>
          </div>
          <h1 className="text-xl sm:text-2xl font-bold text-white">{podcast.title}</h1>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={generatePodcast}
            className="flex items-center gap-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-200 transition-colors"
          >
            <RefreshCw className="h-3.5 w-3.5 text-cyan-400" />
            <span>Regenerate Dialogue</span>
          </button>
          <button
            onClick={handleExportPodcastTranscript}
            className="flex items-center gap-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-200 transition-colors"
          >
            <Download className="h-3.5 w-3.5 text-cyan-400" />
            <span>Export Transcript (.md)</span>
          </button>
        </div>
      </div>

      {/* NotebookLM Backend Audio Service Output Banner */}
      {audioResult && (
        <div className="rounded-2xl border border-cyan-500/30 bg-cyan-950/20 p-4 shadow-lg flex flex-col sm:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-3 w-full sm:w-auto">
            <div className="h-10 w-10 rounded-xl bg-cyan-500/20 border border-cyan-500/40 flex items-center justify-center shrink-0">
              <Headphones className="h-5 w-5 text-cyan-400" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold text-white uppercase tracking-wider">NotebookLM Audio File Ready</span>
                <span className="text-[10px] bg-cyan-500/20 text-cyan-300 px-2 py-0.5 rounded font-mono">
                  {audioResult.format} • {audioResult.fileSizeFormatted}
                </span>
              </div>
              <p className="text-xs text-zinc-400 font-mono truncate max-w-md">
                URL: {audioResult.audioUrl}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 w-full sm:w-auto justify-end">
            <button
              onClick={handleCopyAudioUrl}
              className="flex items-center gap-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-200 transition-colors"
            >
              {copiedUrl ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5 text-cyan-400" />}
              <span>{copiedUrl ? 'Copied!' : 'Copy Audio URL'}</span>
            </button>
            <a
              href={audioResult.audioUrl}
              download={`${podcast.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.wav`}
              className="flex items-center gap-1.5 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-zinc-950 px-3 py-1.5 text-xs font-bold transition-colors"
            >
              <Download className="h-3.5 w-3.5" />
              <span>Download .wav</span>
            </a>
          </div>
        </div>
      )}

      {/* Main Studio Viewport */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left 8 Cols: Interactive Dual-Host Stage & Visualizer */}
        <div className="lg:col-span-8 space-y-4">
          <div
            id="notebooklm-stage"
            className="relative overflow-hidden rounded-2xl border border-zinc-800 bg-gradient-to-b from-zinc-900 via-zinc-950 to-black p-6 shadow-2xl"
          >
            {/* Background Ambient Aura */}
            <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_20%,rgba(6,182,212,0.08),transparent_70%)] pointer-events-none" />

            {/* Top Stage Badges */}
            <div className="flex items-center justify-between text-xs text-zinc-400 mb-6 relative z-10">
              <div className="flex items-center gap-2">
                <span className="flex h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
                <span className="font-semibold text-zinc-200">
                  {isPlaying ? 'ON AIR • LIVE BROADCAST' : 'STUDIO STANDBY'}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className="rounded-full bg-zinc-800/80 px-2.5 py-0.5 text-[11px] text-zinc-300 border border-zinc-700">
                  Turn {currentTurnIndex + 1} of {podcast.turns.length}
                </span>
              </div>
            </div>

            {/* Dual Hosts Visual Spotlight Cards */}
            <div className="grid grid-cols-2 gap-4 my-4 relative z-10">
              {/* Host 1: Alex */}
              <div
                className={`relative rounded-xl border p-4 transition-all duration-300 flex flex-col items-center text-center ${
                  isAlexTurn && isPlaying
                    ? 'border-orange-500 bg-orange-500/10 shadow-lg shadow-orange-500/20 scale-[1.02]'
                    : 'border-zinc-800/80 bg-zinc-900/40 opacity-70'
                }`}
              >
                <div className="relative mb-3">
                  <div
                    className={`h-16 w-16 rounded-full flex items-center justify-center text-xl font-bold text-white shadow-inner transition-transform ${
                      isAlexTurn && isPlaying ? 'ring-4 ring-orange-500/50 scale-105' : 'ring-1 ring-zinc-700'
                    }`}
                    style={{ backgroundColor: '#ea580c' }}
                  >
                    AL
                  </div>
                  {isAlexTurn && isPlaying && (
                    <span className="absolute -bottom-1 -right-1 bg-orange-500 text-black p-1 rounded-full text-[10px] font-black animate-bounce">
                      <Mic className="h-3 w-3" />
                    </span>
                  )}
                </div>
                <h4 className="text-sm font-bold text-white">{podcast.hosts.host1.name}</h4>
                <p className="text-[11px] text-orange-400 font-medium">{podcast.hosts.host1.title}</p>
                <span className="mt-2 text-[10px] bg-orange-500/10 text-orange-300 px-2 py-0.5 rounded border border-orange-500/20">
                  Energetic Scout
                </span>
              </div>

              {/* Host 2: Morgan */}
              <div
                className={`relative rounded-xl border p-4 transition-all duration-300 flex flex-col items-center text-center ${
                  !isAlexTurn && isPlaying
                    ? 'border-cyan-500 bg-cyan-500/10 shadow-lg shadow-cyan-500/20 scale-[1.02]'
                    : 'border-zinc-800/80 bg-zinc-900/40 opacity-70'
                }`}
              >
                <div className="relative mb-3">
                  <div
                    className={`h-16 w-16 rounded-full flex items-center justify-center text-xl font-bold text-white shadow-inner transition-transform ${
                      !isAlexTurn && isPlaying ? 'ring-4 ring-cyan-500/50 scale-105' : 'ring-1 ring-zinc-700'
                    }`}
                    style={{ backgroundColor: '#0891b2' }}
                  >
                    MO
                  </div>
                  {!isAlexTurn && isPlaying && (
                    <span className="absolute -bottom-1 -right-1 bg-cyan-500 text-black p-1 rounded-full text-[10px] font-black animate-bounce">
                      <Mic className="h-3 w-3" />
                    </span>
                  )}
                </div>
                <h4 className="text-sm font-bold text-white">{podcast.hosts.host2.name}</h4>
                <p className="text-[11px] text-cyan-400 font-medium">{podcast.hosts.host2.title}</p>
                <span className="mt-2 text-[10px] bg-cyan-500/10 text-cyan-300 px-2 py-0.5 rounded border border-cyan-500/20">
                  Pragmatic Engineer
                </span>
              </div>
            </div>

            {/* Real-time Frequency Waveform Visualizer Canvas */}
            <div className="relative z-10 my-4 h-12 w-full bg-zinc-950/60 rounded-xl border border-zinc-800/60 flex items-center justify-center px-4 overflow-hidden">
              <canvas ref={canvasRef} width={500} height={48} className="w-full h-full" />
            </div>

            {/* Active Dialogue Subtitle Banner */}
            <div className="relative z-10 bg-black/70 backdrop-blur-md rounded-xl p-4 border border-zinc-800 shadow-xl">
              <div className="flex items-center justify-between text-xs font-semibold mb-2">
                <span
                  className={`flex items-center gap-1.5 uppercase tracking-wider text-[11px] ${
                    isAlexTurn ? 'text-orange-400' : 'text-cyan-400'
                  }`}
                >
                  <Volume2 className="h-3.5 w-3.5" />
                  {currentTurn.speaker} • {currentTurn.tone} tone
                </span>
                <span className="text-[11px] text-zinc-500">~{currentTurn.durationEst}s</span>
              </div>
              <p className="text-sm sm:text-base font-medium text-white leading-relaxed tracking-wide">
                "{currentTurn.text}"
              </p>
            </div>

            {/* Playback Controls */}
            <div className="mt-6 flex items-center justify-between pt-4 border-t border-zinc-800/60 relative z-10">
              <div className="flex items-center gap-2">
                <button
                  onClick={handleRestart}
                  className="p-2 rounded-lg bg-zinc-800/60 hover:bg-zinc-700 text-zinc-300 transition-colors"
                  title="Restart from beginning"
                >
                  <RotateCcw className="h-4 w-4" />
                </button>
                <button
                  onClick={handlePrevTurn}
                  disabled={currentTurnIndex === 0}
                  className="px-2.5 py-1 text-xs font-semibold rounded-lg bg-zinc-800/60 hover:bg-zinc-700 text-zinc-300 disabled:opacity-40 transition-colors"
                >
                  Prev
                </button>
                <button
                  onClick={handleTogglePlay}
                  className="flex items-center gap-2 px-5 py-2 rounded-xl bg-gradient-to-r from-orange-500 to-amber-500 hover:from-orange-600 hover:to-amber-600 text-zinc-950 font-extrabold shadow-lg shadow-orange-500/30 transition-transform active:scale-95"
                >
                  {isPlaying ? (
                    <>
                      <Pause className="h-4 w-4 fill-zinc-950" />
                      <span>Pause Audio</span>
                    </>
                  ) : (
                    <>
                      <Play className="h-4 w-4 fill-zinc-950" />
                      <span>Play Podcast Overview</span>
                    </>
                  )}
                </button>
                <button
                  onClick={handleNextTurn}
                  disabled={currentTurnIndex === podcast.turns.length - 1}
                  className="px-2.5 py-1 text-xs font-semibold rounded-lg bg-zinc-800/60 hover:bg-zinc-700 text-zinc-300 disabled:opacity-40 transition-colors"
                >
                  Next
                </button>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => setIsMuted((prev) => !prev)}
                  className="p-2 rounded-lg bg-zinc-800/60 hover:bg-zinc-700 text-zinc-300 transition-colors"
                >
                  {isMuted ? <VolumeX className="h-4 w-4 text-rose-400" /> : <Volume2 className="h-4 w-4" />}
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Right 4 Cols: Full Synchronized Transcript & Key Takeaways */}
        <div className="lg:col-span-4 space-y-4">
          {/* Key Takeaways Card */}
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4 space-y-3 shadow-lg">
            <h3 className="text-xs font-bold uppercase tracking-wider text-zinc-400 flex items-center gap-1.5">
              <Sparkles className="h-3.5 w-3.5 text-cyan-400" />
              <span>Key Episode Takeaways</span>
            </h3>
            <div className="space-y-2">
              {podcast.keyTakeaways.map((takeaway, i) => (
                <div key={i} className="flex items-start gap-2 text-xs text-zinc-300">
                  <CheckCircle className="h-3.5 w-3.5 text-emerald-400 shrink-0 mt-0.5" />
                  <span>{takeaway}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Full Interactive Transcript */}
          <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4 space-y-3 shadow-lg">
            <h3 className="text-xs font-bold uppercase tracking-wider text-zinc-400 flex items-center justify-between">
              <span>Interactive Transcript</span>
              <span className="text-[10px] text-zinc-500 font-normal">Click turn to jump</span>
            </h3>
            <div className="space-y-2 max-h-[380px] overflow-y-auto pr-1 no-scrollbar">
              {podcast.turns.map((turn, idx) => {
                const isSelected = idx === currentTurnIndex;
                const isHost1 = turn.speaker.includes('Alex') || turn.speaker.includes('Host 1');
                return (
                  <div
                    key={turn.id}
                    onClick={() => {
                      setCurrentTurnIndex(idx);
                      if (!isPlaying) setIsPlaying(true);
                    }}
                    className={`cursor-pointer rounded-xl p-3 border transition-all text-xs ${
                      isSelected
                        ? isHost1
                          ? 'border-orange-500/80 bg-orange-500/10 text-white shadow-md'
                          : 'border-cyan-500/80 bg-cyan-500/10 text-white shadow-md'
                        : 'border-zinc-800/80 bg-zinc-950/40 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200'
                    }`}
                  >
                    <div className="flex items-center justify-between font-semibold mb-1">
                      <span className={isHost1 ? 'text-orange-400' : 'text-cyan-400'}>{turn.speaker}</span>
                      <span className="text-[10px] text-zinc-500">#{idx + 1}</span>
                    </div>
                    <p className="line-clamp-2 leading-relaxed">{turn.text}</p>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
