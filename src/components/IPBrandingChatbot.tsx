import React, { useState, useRef, useEffect } from 'react';
import { Sparkles, MessageSquare, Send, Bot, User, Trash2, CheckCircle2, Copy, Flame, Layers, Radio, Cpu, RefreshCw, X, ArrowRight } from 'lucide-react';
import confetti from 'canvas-confetti';
import { IPBranding, ChatMessage } from '../types';

interface IPBrandingChatbotProps {
  isOpen: boolean;
  onClose: () => void;
  activeIp: IPBranding | null;
  onSelectIp: (ip: IPBranding) => void;
  topicContext?: string;
}

export const IPBrandingChatbot: React.FC<IPBrandingChatbotProps> = ({
  isOpen,
  onClose,
  activeIp,
  onSelectIp,
  topicContext,
}) => {
  const [activeTab, setActiveTab] = useState<'chat' | 'curated'>('chat');
  const [rolePreset, setRolePreset] = useState<'ip_strategist' | 'script_doctor' | 'fast_brainstorm'>('ip_strategist');
  const [inputMessage, setInputMessage] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: 'welcome-1',
      role: 'model',
      content: `👋 Welcome! I am your AI IP Brand Strategist & Infotainment Director.

I specialize in brainstorming viral names, visual identities, show formats, and signature hooks for your Hacker News infotainment channels (like *The Orange Thread*, *Kernel Panic Daily*, *Show HN Express*, etc.).

How can I help you build a dominant tech media brand today?`,
      timestamp: Date.now(),
      modelUsed: 'gemini-3.1-pro-preview',
      rolePreset: 'ip_strategist',
    },
  ]);

  const [curatedIps, setCuratedIps] = useState<IPBranding[]>([
    {
      id: 'ip-1',
      name: 'The Orange Thread',
      tagline: 'Unfiltered Hacker News breakdowns for the curious engineer.',
      hookLine: 'What the top 1% of developers are arguing about right now.',
      vibe: 'Sleek retro-cyberpunk terminal with warm YC-orange glowing accents',
      targetAudience: 'Software engineers, startup founders, CS students, and tech enthusiasts',
      mascotOrVisualIdentity: 'A vintage 1980s mainframe CRT monitor displaying live animated ASCII art',
      suggestedHandle: '@TheOrangeThread',
      whyItWorks: 'Direct homage to Hacker News signature color and comment threads, instantly recognizable in tech circles.',
    },
    {
      id: 'ip-2',
      name: 'Kernel Panic Daily',
      tagline: 'Tech disasters, zero-day heists, and code that broke production.',
      hookLine: 'The single commit that almost deleted the internet.',
      vibe: 'High-energy investigative tech documentary with dramatic glitch transitions',
      targetAudience: 'DevOps, security researchers, backend engineers, and tech curious viewers',
      mascotOrVisualIdentity: 'A flashing red terminal alert icon with cyberpunk neon accents',
      suggestedHandle: '@KernelPanicDaily',
      whyItWorks: 'Taps into every developer’s primal fear (kernel panic) with gripping postmortem storytelling.',
    },
    {
      id: 'ip-3',
      name: 'The 900-Line Show',
      tagline: 'Extreme rewrites, benchmark drama, and indie developer flexes.',
      hookLine: 'Why one indie dev just made a trillion-dollar framework look obsolete.',
      vibe: 'Witty, sarcastic developer comedy with fast-paced meme infographics',
      targetAudience: 'Frontend devs, Rustaceans, indie hackers, and framework enthusiasts',
      mascotOrVisualIdentity: 'A minimalist 3D neon crab (Ferris) typing on a mechanical keyboard',
      suggestedHandle: '@900LineShow',
      whyItWorks: 'References the legendary "rewrote in Rust in 900 lines" Show HN archetype.',
    },
    {
      id: 'ip-4',
      name: 'Root Access Media',
      tagline: 'Declassifying Silicon Valley controversies and algorithmic drama.',
      hookLine: 'Here is what Big Tech does not want on the front page.',
      vibe: 'Neo-noir tech thriller with dark mode terminal diagnostics',
      targetAudience: 'AI researchers, cybersecurity pros, privacy advocates, and hackers',
      mascotOrVisualIdentity: 'An encrypted cryptographic key glowing in emerald green',
      suggestedHandle: '@RootAccessMedia',
      whyItWorks: 'Conveys exclusive insider privilege and unfiltered technical depth.',
    },
  ]);

  const [isLoadingIps, setIsLoadingIps] = useState(false);
  const chatScrollRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll to bottom of chat
  useEffect(() => {
    if (chatScrollRef.current) {
      chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
    }
  }, [messages, isSending]);

  if (!isOpen) return null;

  // Send message to Gemini Chatbot
  const handleSendMessage = async (customText?: string) => {
    const textToSend = customText || inputMessage;
    if (!textToSend.trim() || isSending) return;

    const userMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: textToSend,
      timestamp: Date.now(),
    };

    setMessages((prev) => [...prev, userMsg]);
    setInputMessage('');
    setIsSending(true);

    try {
      // Model assignment based on role as required:
      // gemini-3.1-pro-preview for complex tasks (ip_strategist)
      // gemini-3.7-flash for general tasks (script_doctor)
      // gemini-3.1-flash-lite for fast tasks (fast_brainstorm)
      const targetModel =
        rolePreset === 'ip_strategist'
          ? 'gemini-3.1-pro-preview'
          : rolePreset === 'script_doctor'
          ? 'gemini-3.7-flash'
          : 'gemini-3.1-flash-lite';

      const historyPayload = messages.map((m) => ({
        role: m.role,
        content: m.content,
      }));

      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: textToSend,
          history: historyPayload,
          rolePreset,
          customModel: targetModel,
        }),
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Chat failed');

      const modelMsg: ChatMessage = {
        id: `model-${Date.now()}`,
        role: 'model',
        content: data.reply,
        timestamp: Date.now(),
        modelUsed: data.modelUsed || targetModel,
        rolePreset,
      };

      setMessages((prev) => [...prev, modelMsg]);
    } catch (err: any) {
      const errorMsg: ChatMessage = {
        id: `error-${Date.now()}`,
        role: 'model',
        content: `⚠️ Oops, could not reach Gemini: ${err.message}`,
        timestamp: Date.now(),
      };
      setMessages((prev) => [...prev, errorMsg]);
    } finally {
      setIsSending(false);
    }
  };

  // Generate new batch of IP names via Gemini Pro
  const handleGenerateFreshIps = async () => {
    setIsLoadingIps(true);
    try {
      const res = await fetch('/api/ip-names', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topicContext: topicContext || 'Hacker News breaking stories' }),
      });
      const data = await res.json();
      if (Array.isArray(data) && data.length > 0) {
        setCuratedIps(data);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setIsLoadingIps(false);
    }
  };

  // Select an IP with confetti celebration
  const handleSelectAndApply = (ip: IPBranding) => {
    onSelectIp(ip);
    confetti({
      particleCount: 80,
      spread: 60,
      origin: { y: 0.6 },
    });
  };

  const quickPrompts = [
    'Suggest 5 catchy IP brand names for my Hacker News video channel',
    'What visual aesthetic and color palette works best for HN infotainment?',
    'Give me 3 punchy signature catchphrases for my video intros and outros',
    'How do I position my channel to go viral on YouTube Shorts and TikTok?',
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="w-full max-w-4xl h-[90vh] max-h-[750px] rounded-2xl border border-zinc-800 bg-zinc-950 flex flex-col shadow-2xl overflow-hidden">
        {/* Modal Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800 bg-zinc-900/80">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-tr from-amber-500 to-orange-500 shadow-md shadow-orange-500/30">
              <Sparkles className="h-5 w-5 text-white" />
            </div>
            <div>
              <h2 className="text-base font-bold text-white flex items-center gap-2">
                <span>IP Branding & Creative Showrunner</span>
                <span className="rounded-full bg-orange-500/10 px-2 py-0.5 text-[10px] font-semibold text-orange-400 border border-orange-500/20">
                  Gemini Chatbot
                </span>
              </h2>
              <p className="text-xs text-zinc-400">
                Brainstorm media brand names, viral show formats, and script polishes
              </p>
            </div>
          </div>

          <button
            id="close-ip-modal-button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Tab & Role Switcher */}
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between px-6 py-3 border-b border-zinc-800/80 bg-zinc-950 gap-3">
          {/* Main View Tabs */}
          <div className="flex rounded-xl bg-zinc-900 p-1 border border-zinc-800">
            <button
              id="tab-chat-button"
              onClick={() => setActiveTab('chat')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                activeTab === 'chat' ? 'bg-orange-500 text-white' : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              <MessageSquare className="h-3.5 w-3.5" />
              <span>Multi-Turn Chatbot</span>
            </button>
            <button
              id="tab-curated-button"
              onClick={() => setActiveTab('curated')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                activeTab === 'curated' ? 'bg-orange-500 text-white' : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              <Flame className="h-3.5 w-3.5" />
              <span>Curated IP Brands</span>
            </button>
          </div>

          {/* Chatbot Role & Model Selector (Mandated multi-turn role presets) */}
          {activeTab === 'chat' && (
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-semibold text-zinc-400 hidden sm:inline">Role & Model:</span>
              <select
                id="chatbot-role-select"
                value={rolePreset}
                onChange={(e) => setRolePreset(e.target.value as any)}
                className="bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-1 text-xs font-medium text-zinc-200 focus:outline-none focus:ring-1 focus:ring-orange-500"
              >
                <option value="ip_strategist">🧠 IP Brand Strategist (gemini-3.1-pro-preview)</option>
                <option value="script_doctor">⚡ Viral Script Doctor (gemini-3.5-flash)</option>
                <option value="fast_brainstorm">🚀 Fast Idea Sparker (gemini-3.1-flash-lite)</option>
              </select>
            </div>
          )}
        </div>

        {/* Tab 1: Multi-Turn Chatbot View */}
        {activeTab === 'chat' && (
          <div className="flex-1 flex flex-col min-h-0 bg-zinc-950">
            {/* Scrollable Message Thread */}
            <div ref={chatScrollRef} className="flex-1 p-6 overflow-y-auto space-y-4">
              {messages.map((msg) => {
                const isUser = msg.role === 'user';
                return (
                  <div
                    key={msg.id}
                    className={`flex items-start gap-3 ${isUser ? 'flex-row-reverse' : 'flex-row'}`}
                  >
                    <div
                      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-xl text-xs font-bold ${
                        isUser
                          ? 'bg-orange-600 text-white'
                          : 'bg-zinc-800 text-orange-400 border border-orange-500/30'
                      }`}
                    >
                      {isUser ? <User className="h-4 w-4" /> : <Bot className="h-4 w-4" />}
                    </div>

                    <div
                      className={`rounded-2xl px-4 py-3 max-w-[85%] text-xs sm:text-sm leading-relaxed space-y-1.5 shadow-md ${
                        isUser
                          ? 'bg-orange-600 text-white rounded-tr-none'
                          : 'bg-zinc-900 text-zinc-200 border border-zinc-800 rounded-tl-none'
                      }`}
                    >
                      <div className="whitespace-pre-wrap">{msg.content}</div>
                      {!isUser && msg.modelUsed && (
                        <div className="pt-1 text-[10px] text-zinc-500 font-mono flex items-center gap-1 border-t border-zinc-800/80">
                          <Sparkles className="h-2.5 w-2.5 text-orange-400" />
                          <span>Generated by {msg.modelUsed}</span>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}

              {isSending && (
                <div className="flex items-center gap-2 text-xs text-zinc-400 italic pl-11">
                  <RefreshCw className="h-3.5 w-3.5 animate-spin text-orange-400" />
                  <span>Generating strategic recommendations...</span>
                </div>
              )}
            </div>

            {/* Quick Prompt Suggestions */}
            <div className="px-6 py-2 border-t border-zinc-900 bg-zinc-950/80 overflow-x-auto flex items-center gap-2 no-scrollbar">
              <span className="text-[11px] text-zinc-500 font-semibold shrink-0">Quick sparks:</span>
              {quickPrompts.map((prompt, i) => (
                <button
                  key={i}
                  onClick={() => handleSendMessage(prompt)}
                  className="shrink-0 text-xs text-zinc-400 hover:text-zinc-200 bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 px-2.5 py-1 rounded-full transition-colors"
                >
                  {prompt}
                </button>
              ))}
            </div>

            {/* Chat Input Box */}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                handleSendMessage();
              }}
              className="p-4 border-t border-zinc-800 bg-zinc-900/60 flex items-center gap-2"
            >
              <input
                type="text"
                id="chatbot-message-input"
                value={inputMessage}
                onChange={(e) => setInputMessage(e.target.value)}
                placeholder={`Ask ${
                  rolePreset === 'ip_strategist'
                    ? 'IP Brand Strategist (gemini-3.1-pro-preview)...'
                    : rolePreset === 'script_doctor'
                    ? 'Script Doctor (gemini-3.5-flash)...'
                    : 'Fast Idea Sparker (gemini-3.1-flash-lite)...'
                }`}
                className="flex-1 bg-zinc-950 border border-zinc-800 rounded-xl px-4 py-2.5 text-xs sm:text-sm text-zinc-200 focus:outline-none focus:ring-1 focus:ring-orange-500 placeholder-zinc-500"
              />

              <button
                type="submit"
                id="chatbot-send-button"
                disabled={isSending || !inputMessage.trim()}
                className="flex items-center justify-center h-10 w-10 rounded-xl bg-orange-500 hover:bg-orange-400 text-white disabled:opacity-40 transition-colors cursor-pointer"
              >
                <Send className="h-4 w-4" />
              </button>
            </form>
          </div>
        )}

        {/* Tab 2: Curated & Generated IP Brand Identities */}
        {activeTab === 'curated' && (
          <div className="flex-1 p-6 overflow-y-auto space-y-6 bg-zinc-950">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-bold text-white">Curated Hacker News Media IPs</h3>
                <p className="text-xs text-zinc-400">
                  Select any brand identity to apply it across all video plans, intros, and scene scripts.
                </p>
              </div>

              <button
                onClick={handleGenerateFreshIps}
                disabled={isLoadingIps}
                className="flex items-center gap-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 px-3 py-1.5 text-xs font-semibold text-zinc-200 transition-colors cursor-pointer"
              >
                {isLoadingIps ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5 text-orange-400" />}
                <span>Generate 5 New IPs with Pro</span>
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {curatedIps.map((ip) => {
                const isSelected = activeIp?.name === ip.name;
                return (
                  <div
                    key={ip.id || ip.name}
                    id={`curated-ip-card-${ip.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}
                    className={`rounded-xl border p-5 transition-all flex flex-col justify-between space-y-4 ${
                      isSelected
                        ? 'border-orange-500 bg-orange-950/20 ring-1 ring-orange-500 shadow-lg'
                        : 'border-zinc-800 bg-zinc-900/60 hover:border-zinc-700'
                    }`}
                  >
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="font-mono text-[11px] text-orange-400 font-semibold">{ip.suggestedHandle}</span>
                        {isSelected && (
                          <span className="inline-flex items-center gap-1 text-[11px] font-bold text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded-full border border-emerald-500/20">
                            <CheckCircle2 className="h-3 w-3" /> Active Brand
                          </span>
                        )}
                      </div>

                      <h4 className="text-lg font-bold text-white tracking-tight">{ip.name}</h4>
                      <p className="text-xs font-semibold text-zinc-300 italic">"{ip.tagline}"</p>

                      <div className="space-y-1.5 pt-2 text-xs border-t border-zinc-800">
                        <div className="text-zinc-400">
                          <span className="font-semibold text-zinc-300">Hook: </span>"{ip.hookLine}"
                        </div>
                        <div className="text-zinc-400">
                          <span className="font-semibold text-zinc-300">Visual Vibe: </span>{ip.vibe}
                        </div>
                        <div className="text-zinc-400">
                          <span className="font-semibold text-zinc-300">Audience: </span>{ip.targetAudience}
                        </div>
                        <div className="text-zinc-400">
                          <span className="font-semibold text-zinc-300">Mascot / Motif: </span>{ip.mascotOrVisualIdentity}
                        </div>
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={() => handleSelectAndApply(ip)}
                      className={`w-full py-2 px-3 rounded-lg text-xs font-bold transition-all flex items-center justify-center gap-1.5 cursor-pointer ${
                        isSelected
                          ? 'bg-zinc-800 text-zinc-300 border border-zinc-700'
                          : 'bg-gradient-to-r from-orange-500 to-amber-500 text-white hover:from-orange-400 hover:to-amber-400 shadow-md shadow-orange-500/20'
                      }`}
                    >
                      {isSelected ? (
                        <>
                          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
                          <span>Currently Active IP Brand</span>
                        </>
                      ) : (
                        <>
                          <Sparkles className="h-3.5 w-3.5" />
                          <span>Set as Active Channel IP</span>
                        </>
                      )}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
