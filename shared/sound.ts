/**
 * The sound & edit vocabulary (2026-09-26), shared by the server's sound pass, the exported brief and the UI.
 * Dependency-free, like shared/brand.ts, because both server/ and src/ import it.
 *
 * Before this existed a script carried one free-text `soundEffect` per scene and a free-text `transitionOut`: a live
 * 10-scene run gave every scene a stacked effect ("record scratch + glass shattering + sub-bass") and nine different
 * transition names ("glitch-cut", "Shatter transition", "Glitch impact"...) with no reason behind any of them, and no
 * music at all. The lists below are what an editor actually cuts with; the prompt explains each one.
 */

/** How the picture gets INTO a scene. `cut` is the default; every other one needs a story reason. */
export const TRANSITIONS = ['cut', 'smash-cut', 'match-cut', 'dissolve', 'fade-to-black', 'dip-to-black', 'whip'] as const;
export type Transition = (typeof TRANSITIONS)[number];

/** Sound crossing a cut: a J-cut lets the next scene's sound start early, an L-cut lets this scene's sound run on. */
export const AUDIO_BRIDGES = ['none', 'j-cut', 'l-cut'] as const;
export type AudioBridge = (typeof AUDIO_BRIDGES)[number];

export const MUSIC_ROLES = ['cold-open', 'tension', 'explainer', 'reveal', 'aftermath', 'resolve'] as const;
export const MUSIC_ENTRIES = ['fade-in', 'hard-in', 'sting'] as const;
export const MUSIC_EXITS = ['fade-out', 'button', 'cut-to-silence'] as const;

/** Per-scene sound & edit direction (the sound pass). Optional on a scene: older scripts, and runs where the pass failed, have none. */
export interface SceneSound {
  /** One sound effect, or "" for none — most scenes have none. */
  sfxCue: string;
  /** The word of this scene's narration the effect lands on; "" when there is no effect or the word wasn't in the narration. */
  sfxOnWord: string;
  /** Search phrases for a free SFX library (YouTube Audio Library, Pixabay). */
  sfxSearchTerms: string[];
  /** Background atmosphere under the scene (room tone, rain, a server hum), or "". */
  ambience: string;
  /** Seconds of silence (no music, no effects) before the narration starts — 0 for most scenes. */
  silenceBeforeSec: number;
  /** How the picture cuts into this scene. The previous scene's `motion.transitionOut` is set to the same value. */
  transitionIn: Transition;
  transitionReason: string;
  audioBridge: AudioBridge;
}

/** One music cue across a run of scenes. Scenes no cue covers are deliberate silence. Times come from the script's timeline. */
export interface MusicCue {
  cueId: string;
  startScene: number;
  endScene: number;
  role: (typeof MUSIC_ROLES)[number];
  mood: string;
  tempoBpm?: number;
  instruments: string;
  /** 1 = barely there, 3 = carries the moment. */
  intensity: 1 | 2 | 3;
  entry: (typeof MUSIC_ENTRIES)[number];
  exit: (typeof MUSIC_EXITS)[number];
  /** Search phrases for the YouTube Audio Library and Pixabay Music. Never a named song or artist. */
  searchTerms: string[];
}

/**
 * Maps whatever a model (or an older script) wrote onto the closed list. Stylised names from before this list existed
 * ("glitch-cut", "Shatter transition", "Impact Cut", "Smart Cut") are cuts: the effect is a style, not an edit.
 */
export function normalizeTransition(raw: unknown): Transition {
  const t = String(raw ?? '').toLowerCase().trim();
  if ((TRANSITIONS as readonly string[]).includes(t)) return t as Transition;
  if (/smash/.test(t)) return 'smash-cut';
  if (/match/.test(t)) return 'match-cut';
  if (/dissolve|cross-?fade|mix/.test(t)) return 'dissolve';
  if (/dip/.test(t)) return 'dip-to-black';
  if (/fade/.test(t)) return 'fade-to-black';
  if (/whip|swish/.test(t)) return 'whip';
  return 'cut';
}

export function isFade(t: unknown): boolean {
  return t === 'fade-to-black' || t === 'dip-to-black';
}
