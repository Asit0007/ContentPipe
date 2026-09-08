export type AspectRatio = '16:9' | '9:16' | '1:1';
export type ImageResolution = '1K' | '2K' | '4K';
export type VoiceName = 'Puck' | 'Charon' | 'Kore' | 'Fenrir' | 'Zephyr';
export type WorkflowStep = 'telegram' | 'research' | 'plan' | 'script' | 'studio' | 'ip_branding';

export interface TelegramMessage {
  id: string;
  sender: string;
  senderHandle: string;
  channelName: string;
  timestamp: string;
  text: string;
  topicDetected?: string;
  tags: string[];
  views?: string;
  sourceUrl?: string;
}

export interface RetrievedSource {
  /** Stable tag used in prompts and citations, e.g. "S1". */
  id: string;
  url: string;
  title: string;
  wordCount: number;
  fetchedAt: string;
  ok: boolean;
  error?: string;
}

/**
 * A recurring on-screen character, defined once so every scene that features
 * them can restate the same physical description verbatim. Without this,
 * generated images drift and the "same" character looks different each scene.
 */
export interface CharacterProfile {
  id: string;
  name: string;
  role: string;
  appearance: string;
  wardrobe: string;
  palette: string;
  expressionRange: string;
  /** Copy-paste block appended to any image prompt featuring this character. */
  promptAnchor: string;
}

/** Global look that every scene inherits, so the set feels like one production. */
export interface StyleGuide {
  artDirection: string;
  colorPalette: string;
  lighting: string;
  lensAndFilm: string;
  negativePrompt: string;
}

/** The image prompt split into independently usable layers. */
export interface SceneVisual {
  /** Who is in frame, referencing a CharacterProfile promptAnchor when applicable. */
  character: string;
  /** The environment alone, with no character described. */
  background: string;
  /** Full composed scene: staging, framing, depth, focal point. */
  scene: string;
  /** Style/quality suffix carried across every scene for consistency. */
  styleAnchor: string;
  /** What must NOT appear. */
  negative: string;
}

/** Direction for animating the still, for whatever tool does the animating. */
export interface MotionDirection {
  shotType: string;
  cameraMove: string;
  subjectMotion: string;
  durationSec: number;
  easing: string;
  transitionOut: string;
  /** Ready-to-paste prompt for an image-to-video model. */
  motionPrompt: string;
}

export interface ResearchData {
  topicTitle: string;
  oneLineHook: string;
  summary: string;
  coreTechExplanation: string;
  hnCommunitySentiment: {
    consensus: string;
    contrarianView: string;
    topHnComments: Array<{
      author: string;
      karma: number;
      comment: string;
      vibe: 'skeptical' | 'excited' | 'cynical' | 'insightful';
    }>;
  };
  infotainmentAngles: Array<{
    title: string;
    hook: string;
    whyItGoesViral: string;
  }>;
  keyFacts: string[];
  timeline: Array<{
    dateOrPhase: string;
    event: string;
  }>;
  groundingSources?: Array<{
    title: string;
    url: string;
  }>;
  /** Documents actually retrieved and read for this dossier. */
  retrievedSources?: RetrievedSource[];
  /** Per-claim attribution: which [S#] each key fact came from. */
  factCitations?: Array<{
    fact: string;
    sourceIds: string[];
  }>;
  isQuotaFallback?: boolean;
  selectedAngle?: string;
}

export interface VideoPlan {
  title: string;
  format: '9:16' | '16:9';
  targetDurationSec: number;
  tone: 'Witty Tech & Sarcastic' | 'Cyberpunk Drama' | 'Fast Tech Detective' | 'Deep Dive Documentary';
  hookStrategy: string;
  coreConflict: string;
  pacingStyle: string;
  targetAudience: string;
  narrativeBeats: Array<{
    act: string;
    purpose: string;
    durationSec: number;
    visualTone: string;
    keyTakeaway: string;
  }>;
  viralRetentionHooks: string[];
  callToAction: string;
}

export interface SceneInfographicStep {
  label: string;
  detail: string;
  status: 'vulnerable' | 'secure' | 'warning' | 'neutral' | 'active';
  icon?: string;
}

export interface SceneInfographicMetric {
  label: string;
  value: string;
  subtext?: string;
  color?: string;
}

export interface SceneInfographicCode {
  language: string;
  filename?: string;
  lines: Array<{
    text: string;
    highlight?: boolean;
    type?: 'cmd' | 'header' | 'payload' | 'comment' | 'success' | 'danger';
  }>;
}

export interface SceneInfographic {
  type: 'architecture' | 'threat_scorecard' | 'terminal_payload' | 'benchmark_chart' | 'sentiment_gauge' | 'timeline';
  title: string;
  badge?: string;
  badgeColor?: string;
  summary?: string;
  steps?: SceneInfographicStep[];
  metrics?: SceneInfographicMetric[];
  codeSnippet?: SceneInfographicCode;
  commentQuote?: {
    author: string;
    karma: number;
    comment: string;
    vibe: string;
  };
}

export interface VideoScriptScene {
  id: string;
  sceneNumber: number;
  title: string;
  actPhase?: string;
  narration: string;
  durationEst: number;
  /** Flat prompt, kept for the image endpoint and existing UI. */
  visualPrompt: string;
  /** Layered prompts: character, background, scene, style. */
  visual?: SceneVisual;
  /** Camera and subject motion for animating this scene's still. */
  motion?: MotionDirection;
  /** Source ids ([S#]) backing the factual claims in this narration. */
  citations?: string[];
  visualType: 'headline' | 'terminal' | 'meme' | 'cyberpunk' | 'diagram' | 'character';
  cinematography?: string;
  onScreenText: string;
  soundEffect: string;
  retentionNote?: string;
  wordCount?: number;
  infographic?: SceneInfographic;
  generatedImageUrl?: string;
  generatedAudioBase64?: string;
  isAudioLoading?: boolean;
  isImageLoading?: boolean;
  audioError?: string;
  imageError?: string;
}

export interface VideoScript {
  title: string;
  targetPlatform: 'Shorts/Reels/TikTok (9:16)' | 'YouTube Long-form (16:9)';
  aspectRatio: AspectRatio;
  estimatedTotalDuration: number;
  totalWordCount?: number;
  targetWpm?: number;
  viralityScore?: number;
  tonePacing?: string;
  signatureIntro: string;
  signatureOutro: string;
  /** Cast defined once; scenes reference these by id for visual consistency. */
  characterBible?: CharacterProfile[];
  /** Look applied across every scene. */
  styleGuide?: StyleGuide;
  scenes: VideoScriptScene[];
}

export interface IPBranding {
  id: string;
  name: string;
  tagline: string;
  hookLine: string;
  vibe: string;
  targetAudience: string;
  mascotOrVisualIdentity: string;
  suggestedHandle: string;
  whyItWorks: string;
}

export interface PodcastTurn {
  id: string;
  speaker: 'Host 1 (Alex)' | 'Host 2 (Morgan)';
  speakerRole: 'Tech Enthusiast' | 'Skeptical Pragmatist';
  text: string;
  tone: 'excited' | 'skeptical' | 'curious' | 'witty' | 'explanatory';
  audioBase64?: string;
  durationEst?: number;
}

export interface NotebookLMPodcast {
  title: string;
  episodeSummary: string;
  hosts: {
    host1: { name: string; title: string; voice: VoiceName; avatarColor: string };
    host2: { name: string; title: string; voice: VoiceName; avatarColor: string };
  };
  turns: PodcastTurn[];
  keyTakeaways: string[];
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'model';
  content: string;
  timestamp: number;
  modelUsed?: string;
  rolePreset?: 'ip_strategist' | 'script_doctor' | 'fast_brainstorm';
}

export interface NotebookLMAudioResult {
  audioId: string;
  audioUrl: string;
  durationSeconds: number;
  format: string;
  fileSizeFormatted: string;
  title: string;
  summary: string;
  hosts: {
    host1: { name: string; voice: string; role: string; avatarColor: string };
    host2: { name: string; voice: string; role: string; avatarColor: string };
  };
  chapters: {
    time: number;
    title: string;
    speaker: string;
  }[];
  transcript: {
    speaker: string;
    text: string;
    startTime: number;
  }[];
  generatedAt: string;
  isAiSynthesized: boolean;
  service: string;
}

