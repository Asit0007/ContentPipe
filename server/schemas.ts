import { Type } from '@google/genai';

/**
 * Response schemas for the Gemini structured-output API.
 *
 * Passing these as `responseSchema` constrains decoding to the shape, so the
 * model cannot emit prose, markdown fences, or a half-finished object. These
 * mirror the interfaces in src/types.ts — keep the two in sync.
 */

const groundingSource = {
  type: Type.OBJECT,
  properties: {
    title: { type: Type.STRING },
    url: { type: Type.STRING },
  },
  required: ['title', 'url'],
};

export const researchSchema = {
  type: Type.OBJECT,
  properties: {
    topicTitle: { type: Type.STRING },
    oneLineHook: { type: Type.STRING },
    summary: { type: Type.STRING },
    coreTechExplanation: { type: Type.STRING },
    hnCommunitySentiment: {
      type: Type.OBJECT,
      properties: {
        consensus: { type: Type.STRING },
        contrarianView: { type: Type.STRING },
        topHnComments: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              author: { type: Type.STRING },
              karma: { type: Type.INTEGER },
              comment: { type: Type.STRING },
              vibe: {
                type: Type.STRING,
                enum: ['skeptical', 'excited', 'cynical', 'insightful'],
              },
            },
            required: ['author', 'karma', 'comment', 'vibe'],
          },
        },
      },
      required: ['consensus', 'contrarianView', 'topHnComments'],
    },
    infotainmentAngles: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          title: { type: Type.STRING },
          hook: { type: Type.STRING },
          whyItGoesViral: { type: Type.STRING },
        },
        required: ['title', 'hook', 'whyItGoesViral'],
      },
    },
    keyFacts: { type: Type.ARRAY, items: { type: Type.STRING } },
    timeline: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          dateOrPhase: { type: Type.STRING },
          event: { type: Type.STRING },
        },
        required: ['dateOrPhase', 'event'],
      },
    },
    groundingSources: { type: Type.ARRAY, items: groundingSource },
    factCitations: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          fact: { type: Type.STRING },
          sourceIds: { type: Type.ARRAY, items: { type: Type.STRING } },
        },
        required: ['fact', 'sourceIds'],
      },
    },
  },
  required: [
    'topicTitle',
    'oneLineHook',
    'summary',
    'coreTechExplanation',
    'hnCommunitySentiment',
    'infotainmentAngles',
    'keyFacts',
    'timeline',
  ],
  propertyOrdering: [
    'topicTitle',
    'oneLineHook',
    'summary',
    'coreTechExplanation',
    'hnCommunitySentiment',
    'infotainmentAngles',
    'keyFacts',
    'timeline',
    'groundingSources',
    'factCitations',
  ],
};

export const planSchema = {
  type: Type.OBJECT,
  properties: {
    title: { type: Type.STRING },
    format: { type: Type.STRING, enum: ['9:16', '16:9'] },
    targetDurationSec: { type: Type.NUMBER },
    tone: {
      type: Type.STRING,
      enum: [
        'Witty Tech & Sarcastic',
        'Cyberpunk Drama',
        'Fast Tech Detective',
        'Deep Dive Documentary',
      ],
    },
    hookStrategy: { type: Type.STRING },
    coreConflict: { type: Type.STRING },
    pacingStyle: { type: Type.STRING },
    targetAudience: { type: Type.STRING },
    narrativeBeats: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          act: { type: Type.STRING },
          purpose: { type: Type.STRING },
          durationSec: { type: Type.NUMBER },
          visualTone: { type: Type.STRING },
          keyTakeaway: { type: Type.STRING },
        },
        required: ['act', 'purpose', 'durationSec', 'visualTone', 'keyTakeaway'],
      },
    },
    viralRetentionHooks: { type: Type.ARRAY, items: { type: Type.STRING } },
    callToAction: { type: Type.STRING },
  },
  required: [
    'title',
    'format',
    'targetDurationSec',
    'tone',
    'hookStrategy',
    'coreConflict',
    'pacingStyle',
    'targetAudience',
    'narrativeBeats',
    'viralRetentionHooks',
    'callToAction',
  ],
  propertyOrdering: [
    'title',
    'format',
    'targetDurationSec',
    'tone',
    'hookStrategy',
    'coreConflict',
    'pacingStyle',
    'targetAudience',
    'narrativeBeats',
    'viralRetentionHooks',
    'callToAction',
  ],
};

const infographicSchema = {
  type: Type.OBJECT,
  properties: {
    type: {
      type: Type.STRING,
      enum: [
        'architecture',
        'threat_scorecard',
        'terminal_payload',
        'benchmark_chart',
        'sentiment_gauge',
        'timeline',
      ],
    },
    title: { type: Type.STRING },
    badge: { type: Type.STRING },
    badgeColor: { type: Type.STRING },
    summary: { type: Type.STRING },
    steps: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          label: { type: Type.STRING },
          detail: { type: Type.STRING },
          status: {
            type: Type.STRING,
            enum: ['vulnerable', 'secure', 'warning', 'neutral', 'active'],
          },
          icon: { type: Type.STRING },
        },
        required: ['label', 'detail', 'status'],
      },
    },
    metrics: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          label: { type: Type.STRING },
          value: { type: Type.STRING },
          subtext: { type: Type.STRING },
          color: { type: Type.STRING },
        },
        required: ['label', 'value'],
      },
    },
    codeSnippet: {
      type: Type.OBJECT,
      properties: {
        language: { type: Type.STRING },
        filename: { type: Type.STRING },
        lines: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              text: { type: Type.STRING },
              highlight: { type: Type.BOOLEAN },
              type: {
                type: Type.STRING,
                enum: ['cmd', 'header', 'payload', 'comment', 'success', 'danger'],
              },
            },
            required: ['text'],
          },
        },
      },
      required: ['language', 'lines'],
    },
    commentQuote: {
      type: Type.OBJECT,
      properties: {
        author: { type: Type.STRING },
        karma: { type: Type.INTEGER },
        comment: { type: Type.STRING },
        vibe: { type: Type.STRING },
      },
      required: ['author', 'karma', 'comment', 'vibe'],
    },
  },
  required: ['type', 'title'],
};

const characterProfileSchema = {
  type: Type.OBJECT,
  properties: {
    id: { type: Type.STRING },
    name: { type: Type.STRING },
    role: { type: Type.STRING },
    appearance: { type: Type.STRING },
    wardrobe: { type: Type.STRING },
    palette: { type: Type.STRING },
    expressionRange: { type: Type.STRING },
    promptAnchor: { type: Type.STRING },
  },
  required: ['id', 'name', 'role', 'appearance', 'wardrobe', 'palette', 'promptAnchor'],
};

const styleGuideSchema = {
  type: Type.OBJECT,
  properties: {
    artDirection: { type: Type.STRING },
    colorPalette: { type: Type.STRING },
    lighting: { type: Type.STRING },
    lensAndFilm: { type: Type.STRING },
    negativePrompt: { type: Type.STRING },
  },
  required: ['artDirection', 'colorPalette', 'lighting', 'lensAndFilm', 'negativePrompt'],
};

const sceneVisualSchema = {
  type: Type.OBJECT,
  properties: {
    character: { type: Type.STRING },
    background: { type: Type.STRING },
    scene: { type: Type.STRING },
    styleAnchor: { type: Type.STRING },
    negative: { type: Type.STRING },
  },
  required: ['character', 'background', 'scene', 'styleAnchor', 'negative'],
};

const motionSchema = {
  type: Type.OBJECT,
  properties: {
    shotType: { type: Type.STRING },
    cameraMove: { type: Type.STRING },
    subjectMotion: { type: Type.STRING },
    durationSec: { type: Type.NUMBER },
    easing: { type: Type.STRING },
    transitionOut: { type: Type.STRING },
    motionPrompt: { type: Type.STRING },
  },
  required: ['shotType', 'cameraMove', 'subjectMotion', 'durationSec', 'easing', 'transitionOut', 'motionPrompt'],
};

export const scriptSchema = {
  type: Type.OBJECT,
  properties: {
    title: { type: Type.STRING },
    targetPlatform: {
      type: Type.STRING,
      enum: ['Shorts/Reels/TikTok (9:16)', 'YouTube Long-form (16:9)'],
    },
    aspectRatio: { type: Type.STRING, enum: ['16:9', '9:16', '1:1'] },
    estimatedTotalDuration: { type: Type.NUMBER },
    totalWordCount: { type: Type.INTEGER },
    targetWpm: { type: Type.INTEGER },
    viralityScore: { type: Type.NUMBER },
    tonePacing: { type: Type.STRING },
    signatureIntro: { type: Type.STRING },
    signatureOutro: { type: Type.STRING },
    scenes: {
      type: Type.ARRAY,
      // Without an explicit floor the model will happily return a single scene.
      minItems: 5,
      maxItems: 6,
      items: {
        type: Type.OBJECT,
        properties: {
          sceneNumber: { type: Type.INTEGER },
          title: { type: Type.STRING },
          actPhase: { type: Type.STRING },
          narration: { type: Type.STRING },
          durationEst: { type: Type.NUMBER },
          visualPrompt: { type: Type.STRING },
          visualType: {
            type: Type.STRING,
            enum: ['headline', 'terminal', 'meme', 'cyberpunk', 'diagram', 'character'],
          },
          cinematography: { type: Type.STRING },
          onScreenText: { type: Type.STRING },
          soundEffect: { type: Type.STRING },
          retentionNote: { type: Type.STRING },
          wordCount: { type: Type.INTEGER },
          visual: sceneVisualSchema,
          motion: motionSchema,
          citations: { type: Type.ARRAY, items: { type: Type.STRING } },
          infographic: infographicSchema,
        },
        required: [
          'sceneNumber',
          'title',
          'narration',
          'durationEst',
          'visualPrompt',
          'visualType',
          'onScreenText',
          'soundEffect',
        ],
        propertyOrdering: [
          'sceneNumber',
          'title',
          'actPhase',
          'narration',
          'durationEst',
          'cinematography',
          'visualPrompt',
          'visual',
          'motion',
          'citations',
          'visualType',
          'onScreenText',
          'soundEffect',
          'retentionNote',
          'wordCount',
          'infographic',
        ],
      },
    },
  },
  required: [
    'title',
    'targetPlatform',
    'aspectRatio',
    'estimatedTotalDuration',
    'signatureIntro',
    'signatureOutro',
    'scenes',
  ],
  propertyOrdering: [
    'title',
    'targetPlatform',
    'aspectRatio',
    'estimatedTotalDuration',
    'totalWordCount',
    'targetWpm',
    'viralityScore',
    'tonePacing',
    'signatureIntro',
    'signatureOutro',
    'scenes',
  ],
};

/**
 * Second-pass schema: art direction only.
 *
 * The full script schema is large enough that some models silently drop
 * required fields from it (observed: gemini-3.6-flash returning finishReason
 * STOP with `visual` and `motion` absent). Asking for the visual layer on its
 * own keeps the schema small enough to be honoured reliably.
 */
export const visualDirectionSchema = {
  type: Type.OBJECT,
  properties: {
    scenes: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          sceneNumber: { type: Type.INTEGER },
          visual: sceneVisualSchema,
          motion: motionSchema,
          citations: { type: Type.ARRAY, items: { type: Type.STRING } },
        },
        required: ['sceneNumber', 'visual', 'motion', 'citations'],
        propertyOrdering: ['sceneNumber', 'visual', 'motion', 'citations'],
      },
    },
  },
  required: ['scenes'],
};

/**
 * First-pass schema: the production bible.
 *
 * Split out for the same reason as visualDirectionSchema — when characterBible
 * and styleGuide lived on the full script schema, models returned scripts with
 * both fields simply absent despite being listed as required.
 */
export const productionBibleSchema = {
  type: Type.OBJECT,
  properties: {
    characterBible: {
      type: Type.ARRAY,
      minItems: 1,
      maxItems: 3,
      items: characterProfileSchema,
    },
    styleGuide: styleGuideSchema,
  },
  required: ['characterBible', 'styleGuide'],
  propertyOrdering: ['characterBible', 'styleGuide'],
};
