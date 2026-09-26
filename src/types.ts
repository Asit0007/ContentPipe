import type { Speaker } from '../shared/speakers';

import type { ModelCall } from '../shared/modelUsage';
import type { MusicCue, SceneSound } from '../shared/sound';
export type { ModelCall, ModelAttempt } from '../shared/modelUsage';

export type AspectRatio = '16:9' | '9:16' | '1:1';
export type ImageResolution = '1K' | '2K' | '4K';
export type ImageProviderId = 'hf' | 'gemini' | 'pollinations' | 'placeholder';
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
  /** Explicit source links to read for this story (in addition to any URLs in the text). */
  sourceUrls?: string[];
}

/** 'hn-api' = an HN discussion thread read via the Algolia API (comments, not the linked article). */
export type FetchVia = 'direct' | 'jina' | 'wayback' | 'hn-api';

export interface RetrievedSource {
  /** Stable tag used in prompts and citations, e.g. "S1". */
  id: string;
  url: string;
  title: string;
  wordCount: number;
  fetchedAt: string;
  ok: boolean;
  /** How the text was obtained. Absent on pre-ladder data; treat as 'direct'. */
  via?: FetchVia;
  /** The URL actually requested — the reader-proxy or archive URL, not `url`. */
  retrievalUrl?: string;
  /** ISO timestamp of the archived capture. Only set when `via === 'wayback'`. */
  snapshotDate?: string;
  /** The date the PAGE states for itself. Absent means the page did not say — not that it is new. */
  publishedAt?: string;
  /** The document was longer than the per-source cap; only its opening was read. */
  truncated?: boolean;
  /** Characters retrieved before truncation. Only set when `truncated`. */
  retrievedChars?: number;
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
      /** Not provided by the HN API for comments; only ever present on legacy/canned data. */
      karma?: number;
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
  /** What a full-length script still needs that the retrieved sources do not answer. The honest
   *  alternative to padding keyFacts up to its floor — thin research says so here. */
  researchGaps?: string[];
  timeline: Array<{
    dateOrPhase: string;
    event: string;
  }>;
  groundingSources?: Array<{
    title: string;
    url: string;
    /** How this source was retrieved. Absent on pre-ladder data; treat as 'direct'. */
    via?: FetchVia;
    snapshotDate?: string;
  }>;
  /** Documents actually retrieved and read for this dossier. */
  retrievedSources?: RetrievedSource[];
  /** Per-claim attribution: which [S#] each key fact came from. */
  factCitations?: Array<{
    fact: string;
    sourceIds: string[];
  }>;
  /** Computed server-side, not by the model: how much of this dossier is actually backed by a
   *  retrieved document. `uncitedFacts` is the number the script will have to carry on trust. */
  researchCoverage?: {
    sourcesUsable: number;
    sourcesTruncated: number;
    sourcesUndated: number;
    keyFacts: number;
    citedFacts: number;
    uncitedFacts: number;
    /** Where the full retrieved text was kept, so a later per-claim check can re-read it. */
    sourceArchiveId?: string;
  };
  isQuotaFallback?: boolean;
  selectedAngle?: string;
  /** Which model answered, and every model tried before it (server/llm/usage.ts). Stripped server-side from inputs. */
  modelUsage?: ModelCall[];
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
  /** True when this is canned fallback content (AI generation was unavailable). */
  isQuotaFallback?: boolean;
  modelUsage?: ModelCall[];
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
    karma?: number;
    comment: string;
    vibe: string;
  };
}

export interface VideoScriptScene {
  id: string;
  sceneNumber: number;
  title: string;
  actPhase?: string;
  /**
   * Who reads this scene aloud in a two-voice render (ContentRender): the narrator tells the story, the analyst
   * reacts between narrator sections. Assigned by shared/speakers.ts, never requested from the model, so it is
   * deliberately absent from server/schemas.ts. Absent on older scripts: treat as 'narrator'.
   */
  speaker?: Speaker;
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
  /**
   * Bible character ids present in this scene (art-direction pass, CLAUDE.md "Visual consistency").
   * Their promptAnchor is already force-included in visual.character by applyVisualDirection — this
   * field is the audit trail for that, not something a consumer needs to act on itself.
   */
  charactersInFrame?: string[];
  /**
   * Short slug for this scene's environment (art-direction pass), reused across scenes that return to
   * the same place. visual.background is force-matched to the first scene that established this id —
   * see applyVisualDirection's canonicalBackgroundByLocation.
   */
  locationId?: string;
  visualType: 'headline' | 'terminal' | 'meme' | 'cyberpunk' | 'diagram' | 'character';
  cinematography?: string;
  onScreenText: string;
  /** One sound effect or "" — written by the sound pass (the single cue from `sound.sfxCue`); older scripts carry free text. */
  soundEffect: string;
  /** Sound & edit direction (server/soundPipeline.ts). Absent on older scripts and where that pass failed. */
  sound?: SceneSound;
  retentionNote?: string;
  wordCount?: number;
  infographic?: SceneInfographic;
  generatedImageUrl?: string;
  /** Which backend actually produced generatedImageUrl. Absent = not yet generated. */
  imageProvider?: ImageProviderId;
  imageProviderLabel?: string;
  /** The model that drew generatedImageUrl / voiced generatedAudioBase64, as the server reported it. */
  imageModel?: string;
  audioModel?: string;
  /** True when generatedImageUrl is a generated placeholder, not real artwork. */
  imageIsPlaceholder?: boolean;
  generatedAudioBase64?: string;
  isAudioLoading?: boolean;
  isImageLoading?: boolean;
  audioError?: string;
  imageError?: string;
  /** An AI clip animated from generatedImageUrl (POST /api/generate-video), served from /clips/. */
  generatedVideoUrl?: string;
  /** The Space that made it (VIDEO_PROVIDER_ORDER). */
  videoModel?: string;
  videoHasAudio?: boolean;
  videoDurationSec?: number;
  isVideoLoading?: boolean;
  videoError?: string;
}

/** Mirrors ScriptGeneration in server/scriptPipeline.ts — change both together. */
export interface ScriptGeneration {
  runId?: string;
  /** True when this response continued an interrupted run instead of starting one. */
  resumed?: boolean;
  requestedDurationSec: number;
  requestedScenes: number;
  producedScenes: number;
  producedDurationSec: number;
  /** Every requested scene exists, every scene is art-directed, and the production bible exists. */
  complete: boolean;
  /** Human-readable notes on what degraded; empty when complete. */
  degraded: string[];
}

/** The four types below mirror server/timeline.ts — change both together. */
export interface TimelineEntry {
  sceneNumber: number;
  startSec: number;
  endSec: number;
}
export interface Chapter {
  startSec: number;
  timestamp: string;
  label: string;
}
export interface MidrollMarker {
  /** 1 = after the problem is set up, 2 = before the fix / conclusion. */
  index: 1 | 2;
  targetSec: number;
  afterSceneNumber: number;
  atSec: number;
  timestamp: string;
  reason: string;
}
export interface QualityCheck {
  id: string;
  severity: 'error' | 'warn' | 'info';
  message: string;
  sceneNumbers?: number[];
}

/** Mirrors the publish types in server/publishPackage.ts — change both together. */
export interface LintIssue {
  rule: string;
  severity: 'error' | 'warn' | 'info';
  message: string;
}
export interface TitleCandidate {
  title: string;
  structure: string;
  angle: string;
  bestThumbnail: 'A' | 'B' | 'C';
  chars: number;
  lint: LintIssue[];
  /** No lint errors. Warnings and info do not disqualify a title. */
  passesLint: boolean;
}
export interface ThumbnailConcept {
  variant: 'A' | 'B' | 'C';
  concept: string;
  imagePrompt: string;
  textOverlay: string;
  layout: string;
  rationale: string;
  lint: LintIssue[];
}
export interface PublishPackage {
  titles: TitleCandidate[];
  thumbnails: ThumbnailConcept[];
  /** Chosen by the linter (best-passing title), never by the model. */
  recommendedTitle?: string;
  recommendedThumbnail?: 'A' | 'B' | 'C';
  description: string;
  descriptionWordCount: number;
  chapters: Chapter[];
  midrollTimestamps: string[];
  tags: string[];
  hashtags: string[];
  /** Things a human still has to do (unfilled {{PLACEHOLDER}}s, ineligible mid-roll, …). */
  todos: string[];
  /** True when the model was unavailable and only the deterministic parts were produced. */
  deterministicOnly?: boolean;
  isQuotaFallback?: boolean;
  generatedAt: string;
  modelUsage?: ModelCall[];
}

export interface VideoScript {
  title: string;
  targetPlatform: 'Shorts/Reels/TikTok (9:16)' | 'YouTube Long-form (16:9)';
  aspectRatio: AspectRatio;
  estimatedTotalDuration: number;
  /** 'estimate' (default, absent): durations are the model's guesses. 'audio': re-timed from the rendered video. */
  timingSource?: 'estimate' | 'audio';
  totalWordCount?: number;
  targetWpm?: number;
  /** Retired: it was a hardcoded default, never a measurement. Kept only so old saved scripts still type-check. */
  viralityScore?: number;
  tonePacing?: string;
  /** True when this is canned fallback content (AI generation was unavailable). */
  isQuotaFallback?: boolean;
  /** How much of the request was actually produced, and what degraded. */
  generation?: ScriptGeneration;
  /** Computed deterministically server-side from the scenes; absent on scripts generated before it existed. */
  timeline?: TimelineEntry[];
  chapters?: Chapter[];
  midrollMarkers?: MidrollMarker[];
  qualityChecks?: QualityCheck[];
  /** Titles, thumbnails, description and tags; produced on demand by /api/publish-package. */
  publish?: PublishPackage;
  signatureIntro: string;
  signatureOutro: string;
  /** Cast defined once; scenes reference these by id for visual consistency. */
  characterBible?: CharacterProfile[];
  /** Music plan from the sound pass; scenes no cue covers are deliberate silence. Times come from `timeline`. */
  musicCues?: MusicCue[];
  /** Look applied across every scene. */
  styleGuide?: StyleGuide;
  scenes: VideoScriptScene[];
  /** Every model call behind this script — bible, narrative chunks, art direction — including ones replayed from a checkpoint. */
  modelUsage?: ModelCall[];
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

