import 'dotenv/config';
import express from 'express';
import path from 'path';
import { GoogleGenAI, Modality } from '@google/genai';
import { createServer as createViteServer } from 'vite';
import {
  generateFallbackResearch,
  generateFallbackPlan,
  generateFallbackScript,
  generateFallbackTTSAudio,
  generateFallbackImage,
  generateFallbackChatReply,
  generateFallbackIpList,
  generateFallbackNotebookLMPodcast,
} from './server/fallbackGenerators';
import { researchSchema, planSchema, scriptSchema, visualDirectionSchema, productionBibleSchema } from './server/schemas';
import { extractUrls, fetchSources, buildSourceContext } from './server/sourceFetcher';
import { writeScriptMarkdown, EXPORTS_DIR } from './server/markdownExporter';
import {
  generateNotebookLMAudioService,
  getCachedNotebookLMAudio,
} from './server/notebooklmService';

// Text model fallback chain, best-first. gemini-2.5-flash is intentionally
// absent: Google returns 404 "no longer available to new users" for it, so
// leading with it burned a guaranteed-failed call on every request.
const TEXT_MODELS = ['gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.1-flash-lite'];

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json({ limit: '20mb' }));

// Lazy initialization of GoogleGenAI
let aiClient: GoogleGenAI | null = null;
function getAIClient(): GoogleGenAI {
  if (!aiClient) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.log('[AI Server] GEMINI_API_KEY not found in environment, fallback pipeline primed.');
    }
    aiClient = new GoogleGenAI({
      apiKey: apiKey || '',
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
  }
  return aiClient;
}

// Helper: Check if error is transient, overloaded, 503 UNAVAILABLE, or quota exhaustion
function isTransientOrQuotaError(err: any): boolean {
  if (!err) return false;
  const msg = typeof err === 'string' ? err.toLowerCase() : ((err.message || '') + ' ' + (err.status || '') + ' ' + (err.code || '') + ' ' + JSON.stringify(err)).toLowerCase();
  const code = err.status || err.statusCode || err.code;
  return (
    code === 429 ||
    code === 503 ||
    code === 500 ||
    code === 502 ||
    code === 504 ||
    code === 'RESOURCE_EXHAUSTED' ||
    code === 'UNAVAILABLE' ||
    msg.includes('429') ||
    msg.includes('503') ||
    msg.includes('unavailable') ||
    msg.includes('high demand') ||
    msg.includes('resource_exhausted') ||
    msg.includes('quota') ||
    msg.includes('rate-limits') ||
    msg.includes('overloaded') ||
    msg.includes('temporary') ||
    msg.includes('spikes in demand')
  );
}

// Helper: Sleep for jittered retry
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Helper: Multi-tier resilient JSON generation
async function generateGeminiJson<T>(
  ai: GoogleGenAI,
  prompt: string,
  systemInstruction: string,
  models: string[] = TEXT_MODELS,
  responseSchema?: unknown
): Promise<T> {
  let lastErr: any = null;
  for (const model of models) {
    try {
      const response = await ai.models.generateContent({
        model,
        contents: prompt,
        config: {
          responseMimeType: 'application/json',
          // Constrains decoding to the schema, so the model cannot return prose
          // or a truncated object. Falls back to free-form JSON if unset.
          ...(responseSchema ? { responseSchema } : {}),
          systemInstruction,
        },
      });
      const fr = response?.candidates?.[0]?.finishReason;
      const um: any = response?.usageMetadata;
      console.log(`[Gemini Pipeline] ${model} finish=${fr} out=${um?.candidatesTokenCount} total=${um?.totalTokenCount}`);
      const raw = response?.text || '{}';
      const clean = raw.replace(/```json/g, '').replace(/```/g, '').trim();
      const parsed = JSON.parse(clean);
      return parsed;
    } catch (err: any) {
      lastErr = err;
      console.warn(`[Gemini Pipeline] Model ${model} encountered notice:`, err?.message || err?.status || err);
      if (isTransientOrQuotaError(err)) {
        await sleep(300);
        continue;
      }
      await sleep(200);
    }
  }
  throw lastErr || new Error('All model tiers exhausted');
}

// Helper: Multi-tier resilient Text generation
async function generateGeminiText(
  ai: GoogleGenAI,
  contents: any[],
  systemInstruction: string,
  models: string[] = TEXT_MODELS
): Promise<string> {
  let lastErr: any = null;
  for (const model of models) {
    try {
      const response = await ai.models.generateContent({
        model,
        contents,
        config: {
          systemInstruction,
        },
      });
      if (response?.text) {
        return response.text;
      }
    } catch (err: any) {
      lastErr = err;
      console.warn(`[Gemini Chat Pipeline] Model ${model} error:`, err?.message || err?.status || err);
      await sleep(250);
    }
  }
  throw lastErr || new Error('All chat models exhausted');
}

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// 1. Research Agent: Takes input message, extracts topic, and conducts deep Hacker News & technical research
app.post('/api/research', async (req, res) => {
  const { messageText, channelName, sourceUrls } = req.body;
  if (!messageText) {
    return res.status(400).json({ error: 'messageText is required' });
  }

  // Read the sources rather than asking the model to recall them. Explicit
  // sourceUrls win; otherwise any links in the pasted text are used.
  const explicit: string[] = Array.isArray(sourceUrls) ? sourceUrls.filter((u: unknown) => typeof u === 'string') : [];
  const candidateUrls = Array.from(new Set([...explicit, ...extractUrls(messageText)]));
  const fetched = await fetchSources(candidateUrls);
  const usable = fetched.filter((f) => f.ok);
  console.log(`[Research Agent] ${usable.length}/${fetched.length} source(s) retrieved (${usable.reduce((n, f) => n + f.wordCount, 0)} words)`);
  for (const f of fetched.filter((x) => !x.ok)) {
    console.warn(`[Research Agent] source unavailable: ${f.url} -> ${f.error}`);
  }
  const sourceContext = buildSourceContext(fetched);
  const retrievedSources = fetched.map((f, i) => ({
    id: `S${i + 1}`,
    url: f.url,
    title: f.title || f.url,
    wordCount: f.wordCount,
    fetchedAt: f.fetchedAt,
    ok: f.ok,
    ...(f.error ? { error: f.error } : {}),
  }));

  try {
    const ai = getAIClient();
    const prompt = `You are an elite investigative tech journalist and Hacker News deep-researcher agent.

${sourceContext || 'NOTE: No source documents could be retrieved. Work only from the input text below and do NOT fabricate specific figures, dates, CVE numbers, or quotes.'}

Analyze the following input text / story forwarded from a tech community, Telegram channel, or news wire:

Source Channel / Origin: "${channelName || 'Telegram HackerNews Radar'}"
Input Content:
"""
${messageText}
"""

CRITICAL INSTRUCTIONS:
0. SOURCE DISCIPLINE: Every specific figure, date, CVE id, version number, company name and direct quote must come from the PRIMARY SOURCE DOCUMENTS above. Populate "factCitations" mapping each entry of "keyFacts" to the [S#] ids that support it. If the sources do not cover a detail, omit it rather than inventing it. If no sources were retrieved, keep claims general and leave factCitations empty.
1. Ground your entire research directly in the exact topic, technologies, vulnerabilities, tools, or events described in the Input Content above (e.g. if it is about JFrog Artifactory auth bypass or token minting, research and explain THAT exact story in detail; do NOT substitute generic frontend or framework topics).
2. Synthesize the key facts, technical context, how the vulnerability or technology works under the hood, Hacker News community reactions/debates, and viral infotainment angles suitable for short/long video content.

Return strictly a valid JSON object matching this schema:
{
  "topicTitle": "Catchy yet accurate title of the story",
  "oneLineHook": "Jaw-dropping 1-sentence hook explaining why this matters",
  "summary": "2-3 sentence executive summary of the story",
  "coreTechExplanation": "Clear, accessible explanation of the underlying technology, exploit mechanism, or architecture (no jargon without quick analogy)",
  "hnCommunitySentiment": {
    "consensus": "What the majority of Hacker News top comments agree on",
    "contrarianView": "The most compelling counter-argument or cynical take in the thread",
    "topHnComments": [
      {
        "author": "handle_name",
        "karma": 420,
        "comment": "Authentic-sounding or real quoted comment insight directly about this topic",
        "vibe": "skeptical"
      }
    ]
  },
  "infotainmentAngles": [
    {
      "title": "Angle name (e.g. The Zero-Click Master Key)",
      "hook": "Opening sentence for this angle",
      "whyItGoesViral": "Why viewers will share this"
    }
  ],
  "keyFacts": ["Fact 1", "Fact 2", "Fact 3", "Fact 4"],
  "timeline": [
    { "dateOrPhase": "Phase 1 / Origin", "event": "What happened first" },
    { "dateOrPhase": "Phase 2 / Discovery", "event": "How it was uncovered" },
    { "dateOrPhase": "Phase 3 / Aftermath", "event": "Current state and community fallout" }
  ],
  "groundingSources": [
    { "title": "Primary Source or Disclosure", "url": "https://news.ycombinator.com" }
  ]
}`;

    const systemInstruction = "You are an elite Hacker News investigative researcher and tech infotainment producer. Output strictly valid JSON matching the schema without markdown fences. You must strictly focus on the user's specific topic.";

    let parsedData: any = null;
    try {
      parsedData = await generateGeminiJson(ai, prompt, systemInstruction, TEXT_MODELS, researchSchema);
    } catch (aiErr: any) {
      console.warn('[Research Agent] Live AI tiers unavailable, utilizing dynamic research synthesizer:', aiErr?.message || aiErr);
      parsedData = generateFallbackResearch(messageText, channelName);
    }

    // Report the documents actually read. Previously this regex-scraped a URL
    // out of the input (or hardcoded news.ycombinator.com) and presented it as
    // a source the agent had consulted, which it never had.
    parsedData.retrievedSources = retrievedSources;
    parsedData.groundingSources = usable.map((f) => ({ title: f.title || f.url, url: f.url }));
    if (parsedData.groundingSources.length === 0) {
      parsedData.sourcesUnavailable = true;
    }

    res.json(parsedData);
  } catch (error: any) {
    console.error('[Research Agent] Exception caught, providing synthesized dossier:', error);
    const fallback = generateFallbackResearch(messageText, channelName);
    res.json({ ...fallback, retrievedSources });
  }
});

// 2. Planning Agent: Takes research and produces a high-retention infotainment video plan
app.post('/api/plan', async (req, res) => {
  const { researchData, targetFormat, targetTone } = req.body;
  if (!researchData) {
    return res.status(400).json({ error: 'researchData is required' });
  }

  try {
    const ai = getAIClient();
    const prompt = `You are a viral YouTube / TikTok video creative director specializing in Hacker News and high-tech infotainment.
Convert this exact research into a comprehensive video production plan.

Research Data:
${JSON.stringify(researchData, null, 2)}

Target Platform Format: ${targetFormat || '9:16 (Shorts / Reels / TikTok)'}
Target Tone: ${targetTone || 'Witty Tech & Sarcastic'}

CRITICAL MANDATE:
The entire video plan MUST be strictly focused on the topic in the Research Data: "${researchData.topicTitle || 'the provided story'}".
Do NOT invent an unrelated topic (e.g. do NOT talk about virtual DOM or Rust if the story is about JFrog Artifactory or a security vulnerability).

Create a structured video plan with narrative acts, retention hooks, and visual direction.
Output strictly a JSON object matching this schema:
{
  "title": "${researchData.topicTitle || 'High-CTR Video Title'}",
  "format": "${targetFormat?.includes('16:9') ? '16:9' : '9:16'}",
  "targetDurationSec": 60,
  "tone": "${targetTone || 'Witty Tech & Sarcastic'}",
  "hookStrategy": "Specific visual + verbal 3-second hook pattern to stop scrolling on this exact story",
  "coreConflict": "The central drama or technological dilemma for this topic",
  "pacingStyle": "Fast-cut with terminal memes, code alerts, and dramatic pauses",
  "targetAudience": "Developers, DevOps engineers, security researchers, and curious hackers",
  "narrativeBeats": [
    {
      "act": "Act 1: The Inciting Incident",
      "purpose": "Hook the viewer with a shocking stat or absurd event from this story",
      "durationSec": 8,
      "visualTone": "Rapid glitch transition, giant red terminal alert",
      "keyTakeaway": "Immediate curiosity gap"
    },
    {
      "act": "Act 2: The Tech Breakdown",
      "purpose": "Explain how the vulnerability, architecture, or mechanism works using an intuitive analogy",
      "durationSec": 15,
      "visualTone": "Sleek animated 3D blueprint or exploit packet highlight",
      "keyTakeaway": "Viewer feels smart"
    },
    {
      "act": "Act 3: The Hacker News Drama",
      "purpose": "Highlight the community panic, funny debates, and roasted PRs/disclosures",
      "durationSec": 15,
      "visualTone": "Retro forum thread floating in cyberspace with upvote counters",
      "keyTakeaway": "Relatable developer and security humor"
    },
    {
      "act": "Act 4: The Twist / Revelation",
      "purpose": "Reveal the massive consequence, supply chain blast radius, or how it was caught",
      "durationSec": 12,
      "visualTone": "Dramatic zoom on single line of code or commit log",
      "keyTakeaway": "Mind blown moment"
    },
    {
      "act": "Act 5: Conclusion & CTA",
      "purpose": "Final verdict, remediation advice, and call to subscribe/comment debate",
      "durationSec": 10,
      "visualTone": "Channel signature card, animated terminal prompt",
      "keyTakeaway": "High comment conversion"
    }
  ],
  "viralRetentionHooks": [
    "Pattern interrupt at second 7 with audio beat drop",
    "On-screen visual easter egg at second 25",
    "Open loop question before the reveal"
  ],
  "callToAction": "Drop a comment: How is your team handling this?"
}`;

    const systemInstruction = 'You are an award-winning tech infotainment director. Output strictly valid JSON strictly tailored to the topic in the research.';

    let plan: any = null;
    try {
      plan = await generateGeminiJson(ai, prompt, systemInstruction, TEXT_MODELS, planSchema);
    } catch (aiErr: any) {
      console.warn('[Plan Agent] Live AI tiers unavailable, utilizing dynamic plan generator:', aiErr?.message || aiErr);
      plan = generateFallbackPlan(researchData, targetFormat, targetTone);
    }

    res.json(plan);
  } catch (error: any) {
    console.error('[Plan Agent] Exception caught, activating video plan generator:', error);
    const fallback = generateFallbackPlan(researchData, targetFormat, targetTone);
    res.json(fallback);
  }
});

/**
 * First pass: lock the cast and the look before a single scene is written.
 * Its own call with a small schema, because on the combined script schema both
 * fields were routinely omitted despite being required.
 */
async function generateProductionBible(
  ai: GoogleGenAI,
  videoPlan: any,
  researchData: any,
  channelBrandName?: string
): Promise<{ characterBible: any[]; styleGuide: any }> {
  const prompt = `You are the production designer for a short infotainment video.
Show: "${channelBrandName || 'The Orange Thread'}"
Story: "${videoPlan?.title || researchData?.topicTitle || 'the story'}"
Tone: ${videoPlan?.tone || 'Witty Tech & Sarcastic'}
Summary: ${researchData?.summary || ''}
Core conflict: ${videoPlan?.coreConflict || ''}

Define the production's visual foundation.

A. "characterBible": 1 to 3 recurring characters who carry this story (e.g. the Narrator-Analyst, the Attacker, the On-Call Engineer). For EACH:
   - "id": short slug, e.g. "analyst"
   - "name", "role": who they are and their narrative function
   - "appearance": IMMUTABLE physical description — apparent age, build, hair, facial structure, skin tone, distinguishing features. Be specific and unambiguous; vagueness is exactly what makes a character morph between shots.
   - "wardrobe": exact clothing, never varying between scenes
   - "palette": the 2-3 colours bound to this character
   - "expressionRange": their emotional register
   - "promptAnchor": ONE dense clause restating appearance + wardrobe + palette, written to be pasted verbatim into any image prompt featuring them. This exact string is the consistency mechanism — it will be reused unchanged in every scene.

B. "styleGuide": "artDirection", "colorPalette", "lighting", "lensAndFilm", "negativePrompt".`;

  try {
    const bible: any = await generateGeminiJson(
      ai,
      prompt,
      'You are a precise production designer. Output strictly valid JSON matching the schema.',
      TEXT_MODELS,
      productionBibleSchema
    );
    console.log(`[Production Bible] ${bible?.characterBible?.length || 0} character(s) defined`);
    return { characterBible: bible?.characterBible || [], styleGuide: bible?.styleGuide || {} };
  } catch (err: any) {
    console.warn('[Production Bible] failed, continuing without a locked cast:', err?.message || err);
    return { characterBible: [], styleGuide: {} };
  }
}

/**
 * Second pass over a finished script: produces the layered image prompts and
 * motion direction for every scene, then merges them in. Falls back to leaving
 * the scenes as-is (they still carry visualPrompt) if the call fails.
 */
async function applyVisualDirection(ai: GoogleGenAI, script: any, researchData: any): Promise<any> {
  const scenes: any[] = Array.isArray(script?.scenes) ? script.scenes : [];
  if (scenes.length === 0) return script;

  const bible = script.characterBible || [];
  const style = script.styleGuide || {};
  const sourceIds = (researchData?.retrievedSources || [])
    .filter((r: any) => r.ok)
    .map((r: any) => `${r.id} = ${r.title} (${r.url})`);

  const prompt = `You are the art director and cinematographer for this video. The script is written; your job is the visual layer only.

CHARACTER BIBLE (immutable — reuse promptAnchor strings VERBATIM):
${JSON.stringify(bible, null, 2)}

STYLE GUIDE (every scene inherits this):
${JSON.stringify(style, null, 2)}

AVAILABLE SOURCE IDS for citations:
${sourceIds.length ? sourceIds.join('\n') : '(none retrieved — return [] for every citations field)'}

SCENES:
${JSON.stringify(
  scenes.map((s: any) => ({
    sceneNumber: s.sceneNumber,
    title: s.title,
    actPhase: s.actPhase,
    narration: s.narration,
    durationEst: s.durationEst,
    cinematography: s.cinematography,
    visualType: s.visualType,
    onScreenText: s.onScreenText,
  })),
  null,
  2
)}

For EVERY scene above return an object with:
- "sceneNumber": matching integer
- "visual":
  - "character": ONLY the people in frame — pose, expression, framing — and the exact promptAnchor of every character present, copied word for word, unchanged. If nobody is in frame write "No characters in frame."
  - "background": ONLY the environment — location, architecture, depth, atmosphere, time of day. Mention no people.
  - "scene": the composed shot — how character and background combine, staging, focal point, foreground/midground/background layering, composition rule.
  - "styleAnchor": the style guide restated compactly. This string MUST be byte-identical across every scene.
  - "negative": what must not appear in this image.
- "motion": "shotType", "cameraMove", "subjectMotion", "durationSec" (match durationEst), "easing", "transitionOut", and "motionPrompt" — one ready-to-paste sentence for an image-to-video model.
- "citations": source ids backing the factual claims in that scene's narration; [] for purely rhetorical scenes. Never invent an id that is not listed above.

Return one entry per scene, in order.`;

  try {
    const direction: any = await generateGeminiJson(
      ai,
      prompt,
      'You are a precise art director. Output strictly valid JSON matching the schema. Reuse character promptAnchor strings verbatim so characters stay identical between scenes.',
      TEXT_MODELS,
      visualDirectionSchema
    );
    const byNumber = new Map<number, any>();
    for (const d of direction?.scenes || []) byNumber.set(Number(d.sceneNumber), d);

    // A single styleAnchor wins across the set even if the model varied it.
    const anchors = (direction?.scenes || []).map((d: any) => d?.visual?.styleAnchor).filter(Boolean);
    const canonicalAnchor = anchors[0];

    script.scenes = scenes.map((s: any, i: number) => {
      const d = byNumber.get(Number(s.sceneNumber)) || (direction?.scenes || [])[i];
      if (!d) return s;
      const visual = d.visual ? { ...d.visual, styleAnchor: canonicalAnchor || d.visual.styleAnchor } : undefined;
      return {
        ...s,
        ...(visual ? { visual } : {}),
        ...(d.motion ? { motion: d.motion } : {}),
        ...(Array.isArray(d.citations) ? { citations: d.citations } : {}),
        // Keep the flat prompt consistent with the layered one.
        visualPrompt: visual ? [visual.scene, visual.styleAnchor].filter(Boolean).join(' ') : s.visualPrompt,
      };
    });
    const covered = script.scenes.filter((s: any) => s.visual).length;
    console.log(`[Art Director] visual direction applied to ${covered}/${scenes.length} scenes`);
  } catch (err: any) {
    console.warn('[Art Director] visual direction pass failed, keeping flat prompts:', err?.message || err);
  }
  return script;
}

// 3. Scriptwriting Agent: Converts plan into scene-by-scene script with voiceover and image prompts
app.post('/api/script', async (req, res) => {
  const { videoPlan, researchData, channelBrandName } = req.body;
  if (!videoPlan) {
    return res.status(400).json({ error: 'videoPlan is required' });
  }

  try {
    const ai = getAIClient();
    const productionBible = await generateProductionBible(ai, videoPlan, researchData, channelBrandName);
    const prompt = `You are an elite, award-winning infotainment video scriptwriter & creative director for top-tier YouTube Shorts, TikTok, and video essays (in the style of Veritasium, Fireship, and ColdFusion).
Brand Identity / Show Name: "${channelBrandName || 'The Orange Thread'}"

Video Blueprint Plan:
${JSON.stringify(videoPlan, null, 2)}

Original Research Dossier:
${JSON.stringify(researchData || {}, null, 2)}

Production Bible (cast and look are already locked — write scenes that fit them):
${JSON.stringify(productionBible, null, 2)}

CRITICAL REQUIREMENT:
The script narration, cinematography, visual prompts, and onScreenText for EVERY SINGLE SCENE must be 100% focused on this specific topic: "${videoPlan.title || researchData?.topicTitle || 'the story'}".
If the topic is a security vulnerability (e.g. JFrog Artifactory auth bypass or token minting), EVERY scene must discuss that specific vulnerability, exploit mechanism, supply chain risks, and community panic.
Do NOT output generic text about unrelated topics.

FACTUAL DISCIPLINE: every figure, date, CVE id, version number and quoted comment in the narration must trace to the research dossier. The dossier lists what was actually retrieved under "retrievedSources" and per-fact attribution under "factCitations". Do not introduce specifics the dossier does not contain.

The production bible and style guide are already fixed (given above). Write to them.

Write an extraordinary, high-octane scene-by-scene script.
The "scenes" array MUST contain either 5 or 6 scene objects — never fewer. Every narrative beat in the plan needs its own scene.
For EACH scene, you MUST craft:
1. "sceneNumber": integer index (1..N)
2. "title": Punchy scene title
3. "actPhase": One of "Hook (0-5s)", "Technical Breakdown", "The Flame War", "The Critical Flaw", "The Revelation & Twist", "The Payoff & CTA"
4. "narration": Spoken-word voiceover script. Must sound natural, electrifying, conversational, witty, and incisive. Use rhetorical questions, crisp pacing, contrast, and clever technical humor directly about this story. (approx 22-38 words per scene).
5. "durationEst": Realistic speaking duration in seconds (8 to 15s).
6. "cinematography": Precise visual director cues (camera framing e.g., 'Slow dynamic push-in on macro CRT monitor with anamorphic lens flare and volumetric neon haze').
7. "visualPrompt": An exquisitely detailed single-string image prompt. Cinematic, atmospheric, stylish. This is the flat fallback prompt — it must equal the concatenation of visual.scene + visual.styleAnchor below.
8. "visualType": One of "headline", "terminal", "meme", "cyberpunk", "diagram", "character"
9. "onScreenText": 3 to 5 high-impact kinetic typography words for the viewer's eye.
10. "soundEffect": Specific audio/SFX cue (e.g. "[SFX: Deep sub-bass riser + rapid keyboard clatter]").
11. "retentionNote": Psychological reason why this beat prevents viewer dropoff.
12. "infographic": A structured high-tech infographic object detailing technical facts, architecture steps, CVSS scorecards, terminal commands, or benchmark metrics:
    {
      "type": "architecture" | "threat_scorecard" | "terminal_payload" | "benchmark_chart" | "sentiment_gauge",
      "title": "Clear uppercase headline for the diagram or scorecard",
      "badge": "Short badge tag (e.g. CVSS 9.8 or EXPLOIT CHAIN)",
      "badgeColor": "#f97316" or "#ef4444" or "#22c55e",
      "summary": "1 sentence technical summary of this visual infographic",
      "steps": [{"label": "Step 1", "detail": "...", "status": "active" | "vulnerable" | "secure"}],
      "metrics": [{"label": "Metric", "value": "9.8", "subtext": "Critical", "color": "#ef4444"}]
    }

Return strictly a JSON object matching this schema:
{
  "title": "${videoPlan.title || 'Hacker News Infotainment Masterclass'}",
  "targetPlatform": "${videoPlan.format === '16:9' ? 'YouTube Long-form (16:9)' : 'Shorts/Reels/TikTok (9:16)'}",
  "aspectRatio": "${videoPlan.format === '16:9' ? '16:9' : '9:16'}",
  "estimatedTotalDuration": 60,
  "totalWordCount": 160,
  "targetWpm": 150,
  "viralityScore": 96,
  "tonePacing": "${videoPlan.tone || 'Witty Tech & Sarcastic'}",
  "signatureIntro": "Welcome back to ${channelBrandName || 'The Orange Thread'}...",
  "signatureOutro": "Drop your hot take in the comments and subscribe to ${channelBrandName || 'The Orange Thread'}.",
  "scenes": [
    {
      "id": "scene-1",
      "sceneNumber": 1,
      "title": "Scene Title",
      "actPhase": "Hook (0-5s)",
      "narration": "Electrifying 3-second hook voiceover tailored specifically to this story...",
      "durationEst": 9,
      "cinematography": "Camera and lighting direction for scene 1",
      "visualPrompt": "Detailed cinematic prompt for AI image generator matching the scene (equals visual.scene + visual.styleAnchor)",
      "visualType": "headline",
      "onScreenText": "3-5 KINETIC WORDS",
      "soundEffect": "Specific SFX cue",
      "retentionNote": "Why this hooks the viewer",
      "infographic": {
        "type": "threat_scorecard",
        "title": "VULNERABILITY SCORECARD",
        "badge": "CVSS 9.8",
        "badgeColor": "#ef4444",
        "summary": "Core exploit pathway summary",
        "metrics": [{"label": "Severity", "value": "Critical", "color": "#ef4444"}]
      }
    }
  ]
}`;

    const systemInstruction = 'You write the sharpest, most viral infotainment scripts on the internet with cinematic visual cues and brilliant narration. Output valid JSON strictly grounded in the topic.';

    let script: any = null;
    try {
      script = await generateGeminiJson(ai, prompt, systemInstruction, TEXT_MODELS, scriptSchema);
    } catch (aiErr: any) {
      console.warn('[Script Agent] Live AI tiers unavailable, utilizing dynamic script generator:', aiErr?.message || aiErr);
      script = generateFallbackScript(videoPlan, researchData, channelBrandName);
    }

    // Calculate word counts & metrics if missing
    let calcTotalWords = 0;
    let calcTotalDuration = 0;

    if (Array.isArray(script.scenes)) {
      script.scenes = script.scenes.map((s: any, idx: number) => {
        const words = (s.narration || '').split(/\s+/).filter(Boolean).length;
        const dur = s.durationEst || Math.max(Math.round(words / 2.5), 8);
        calcTotalWords += words;
        calcTotalDuration += dur;

        return {
          id: s.id || `scene-${idx + 1}-${Date.now()}`,
          sceneNumber: idx + 1,
          title: s.title || `Scene ${idx + 1}`,
          actPhase: s.actPhase || (idx === 0 ? 'Hook (0-5s)' : idx === 1 ? 'Technical Breakdown' : idx === 2 ? 'The Flame War' : idx === 3 ? 'The Critical Flaw' : 'The Payoff & CTA'),
          narration: s.narration || '',
          durationEst: dur,
          cinematography: s.cinematography || 'Cinematic stylized camera tracking with amber lighting and depth of field',
          visualPrompt: s.visualPrompt || 'Cyberpunk hacker news terminal in glowing orange lighting, 8k render',
          visualType: s.visualType || 'cyberpunk',
          onScreenText: s.onScreenText || 'HACKER NEWS BREAKDOWN',
          soundEffect: s.soundEffect || 'Subtle electronic pulse',
          retentionNote: s.retentionNote || 'Pacing interrupt and narrative momentum',
          wordCount: words,
          infographic: s.infographic || undefined,
        };
      });
    }

    script.totalWordCount = script.totalWordCount || calcTotalWords;
    script.estimatedTotalDuration = script.estimatedTotalDuration || calcTotalDuration || 60;
    script.targetWpm = Math.round((script.totalWordCount / (script.estimatedTotalDuration / 60))) || 150;
    script.viralityScore = script.viralityScore || 96;

    // --- Pass 2: art direction ---------------------------------------------
    // Kept separate from the narrative pass on purpose. The combined schema was
    // large enough that models returned finishReason STOP while silently
    // omitting `visual` and `motion`; a small focused schema is honoured.
    script.characterBible = productionBible.characterBible;
    script.styleGuide = productionBible.styleGuide;
    script = await applyVisualDirection(ai, script, researchData);

    res.json(script);
  } catch (error: any) {
    console.error('[Script Agent] Exception caught, providing synthesized script:', error);
    const fallback = generateFallbackScript(videoPlan, researchData, channelBrandName);
    res.json(fallback);
  }
});

// 4. Text-To-Speech (TTS): Uses 'gemini-3.1-flash-tts-preview' with a 2.5 TTS fallback
app.post('/api/tts', async (req, res) => {
  const { text, voice = 'Puck' } = req.body;
  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'text is required for TTS' });
  }

  const validVoices = ['Puck', 'Charon', 'Kore', 'Fenrir', 'Zephyr'];
  const selectedVoice = validVoices.includes(voice) ? voice : 'Puck';

  try {
    const ai = getAIClient();
    let base64Audio: string | null = null;

    const ttsModels = ['gemini-3.1-flash-tts-preview', 'gemini-2.5-flash-preview-tts'];
    for (const model of ttsModels) {
      try {
        const response = await ai.models.generateContent({
          model,
          contents: [{ parts: [{ text: `Speak in a punchy, engaging infotainment documentary narrator voice: ${text}` }] }],
          config: {
            responseModalities: [Modality.AUDIO],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName: selectedVoice },
              },
            },
          },
        });
        const candidateAudio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
        if (candidateAudio) {
          base64Audio = candidateAudio;
          break;
        }
      } catch (ttsErr: any) {
        console.warn(`[TTS Agent] Model ${model} notice:`, ttsErr?.message || ttsErr);
      }
    }

    if (!base64Audio) {
      throw new Error('No audio returned by models');
    }

    res.json({
      audioBase64: base64Audio,
      voice: selectedVoice,
      sampleRate: 24000,
    });
  } catch (error: any) {
    console.log('[TTS Agent] Audio synthesis active via browser/synth generator.');
    const fallbackBase64 = generateFallbackTTSAudio(text, selectedVoice);
    res.json({
      audioBase64: fallbackBase64,
      voice: selectedVoice,
      sampleRate: 24000,
      isQuotaFallback: true,
    });
  }
});

// 5. High-Quality Image Generation: Uses model 'gemini-2.5-flash-image' / 'gemini-3.1-flash-image' with smart fallback
app.post('/api/generate-image', async (req, res) => {
  const { prompt, aspectRatio = '16:9', imageSize = '1K' } = req.body;
  if (!prompt) {
    return res.status(400).json({ error: 'prompt is required' });
  }

  const validAspectRatios = ['16:9', '9:16', '1:1', '4:3', '3:4'];
  const validSizes = ['1K', '2K', '4K'];
  const targetAspectRatio = validAspectRatios.includes(aspectRatio) ? aspectRatio : '16:9';
  const targetSize = validSizes.includes(imageSize) ? imageSize : '1K';

  try {
    const ai = getAIClient();
    let imageUrl: string | null = null;

    const imgModels = ['gemini-3.1-flash-image', 'gemini-2.5-flash-image', 'gemini-3.1-flash-lite-image'];
    for (const model of imgModels) {
      try {
        const response = await ai.models.generateContent({
          model,
          contents: {
            parts: [{ text: prompt }],
          },
          config: {
            imageConfig: {
              aspectRatio: targetAspectRatio,
              imageSize: targetSize,
            },
          },
        });

        const parts = response?.candidates?.[0]?.content?.parts || [];
        for (const part of parts) {
          if (part.inlineData?.data) {
            const mime = part.inlineData.mimeType || 'image/png';
            imageUrl = `data:${mime};base64,${part.inlineData.data}`;
            break;
          }
        }
        if (imageUrl) break;
      } catch (imgErr: any) {
        console.warn(`[Image Agent] Model ${model} notice:`, imgErr?.message || imgErr);
      }
    }

    if (!imageUrl) {
      const fallbackUrl = generateFallbackImage(prompt, targetAspectRatio);
      return res.json({ imageUrl: fallbackUrl, imageSize: targetSize, aspectRatio: targetAspectRatio, isQuotaFallback: true });
    }

    res.json({ imageUrl, imageSize: targetSize, aspectRatio: targetAspectRatio });
  } catch (error: any) {
    console.log('[Image Agent] Exception handled, returning visual artwork.');
    const fallbackUrl = generateFallbackImage(prompt, targetAspectRatio);
    res.json({ imageUrl: fallbackUrl, imageSize: targetSize, aspectRatio: targetAspectRatio, isQuotaFallback: true });
  }
});

// 5b. Markdown export: writes the finished script to exports/ as a production brief
app.post('/api/export/markdown', async (req, res) => {
  const { script, research, plan, channelBrandName } = req.body;
  if (!script || !Array.isArray(script.scenes)) {
    return res.status(400).json({ error: 'script with a scenes array is required' });
  }
  try {
    const result = await writeScriptMarkdown({ script, research, plan, channelBrandName });
    console.log(`[Export] wrote ${result.relativePath} (${result.bytes} bytes)`);
    res.json({ ok: true, ...result });
  } catch (err: any) {
    console.error('[Export] failed:', err);
    res.status(500).json({ error: err?.message || 'Failed to write markdown export' });
  }
});

// 5c. List previously exported briefs
app.get('/api/export/list', async (_req, res) => {
  try {
    const fs = await import('fs/promises');
    const path = await import('path');
    let names: string[] = [];
    try {
      names = (await fs.readdir(EXPORTS_DIR)).filter((n) => n.endsWith('.md'));
    } catch {
      return res.json({ exports: [] });
    }
    const stats = await Promise.all(
      names.map(async (name) => {
        const st = await fs.stat(path.join(EXPORTS_DIR, name));
        return { filename: name, bytes: st.size, modified: st.mtime.toISOString() };
      })
    );
    stats.sort((a, b) => b.modified.localeCompare(a.modified));
    res.json({ exports: stats });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to list exports' });
  }
});

// 6. Gemini Multi-Turn Chatbot with Role Selection & Model Selection
app.post('/api/chat', async (req, res) => {
  const { message, history = [], rolePreset = 'ip_strategist', customModel } = req.body;
  if (!message) {
    return res.status(400).json({ error: 'message is required' });
  }

  try {
    const ai = getAIClient();

    let preferredModel = 'gemini-3.7-flash';
    let systemInstruction = '';

    if (rolePreset === 'ip_strategist') {
      preferredModel = customModel || 'gemini-3.7-flash';
      systemInstruction = `You are the Lead IP Brand Strategist & Showrunner for viral tech & Hacker News infotainment channels.
Your mission is to help the creator brainstorm memorable IP names, media brand identities, show formats, catchy handles, merch lore, signature catchphrases, and visual aesthetics (e.g., retro-orange YCombinator cybernetic themes, high-contrast terminal minimalism).
Give structured, punchy, actionable advice with ready-to-use names, taglines, and show concepts.`;
    } else if (rolePreset === 'script_doctor') {
      preferredModel = customModel || 'gemini-3.7-flash';
      systemInstruction = `You are a world-class Infotainment Script Doctor and Viral Video Retention Editor.
You help refine voiceover scripts, inject developer humor, punch up hooks, sharpen technical explanations, and optimize scene pacing for maximum viewer retention on YouTube, Shorts, and TikTok.`;
    } else if (rolePreset === 'fast_brainstorm') {
      preferredModel = customModel || 'gemini-3.1-flash-lite';
      systemInstruction = `You are a lightning-fast idea sparker. Deliver punchy bullet-point ideas, rapid-fire title variants, hook alternatives, and thumbnail concepts in seconds.`;
    } else {
      preferredModel = customModel || 'gemini-3.7-flash';
      systemInstruction = 'You are an expert AI assistant for tech infotainment creators.';
    }

    const contents: any[] = [];
    if (Array.isArray(history)) {
      for (const item of history) {
        contents.push({
          role: item.role === 'model' ? 'model' : 'user',
          parts: [{ text: item.content }],
        });
      }
    }
    contents.push({
      role: 'user',
      parts: [{ text: message }],
    });

    let replyText = '';
    try {
      replyText = await generateGeminiText(ai, contents, systemInstruction, [
        preferredModel,
        'gemini-3.7-flash',
        'gemini-3.7-flash',
        'gemini-3.1-flash-lite',
      ]);
    } catch (chatErr: any) {
      console.warn('[Chatbot] AI tiers busy, returning strategist reply:', chatErr?.message || chatErr);
      replyText = generateFallbackChatReply(message, rolePreset);
      return res.json({
        reply: replyText,
        modelUsed: 'gemini-local-strategist',
        rolePreset,
        isQuotaFallback: true,
      });
    }

    res.json({
      reply: replyText,
      modelUsed: preferredModel,
      rolePreset,
    });
  } catch (error: any) {
    console.log('[Chatbot] Exception handled, returning strategist guidance.');
    const reply = generateFallbackChatReply(message, rolePreset);
    res.json({
      reply,
      modelUsed: 'gemini-local-strategist',
      rolePreset,
      isQuotaFallback: true,
    });
  }
});

// 7. IP Brand Identity & Naming Generator
app.post('/api/ip-names', async (req, res) => {
  const { topicContext, customVibe } = req.body;
  try {
    const ai = getAIClient();
    const prompt = `Generate 5 distinctive, high-value Media IP brand identities for a tech infotainment channel that turns Hacker News stories, open-source drama, and zero-day exploits into entertaining short-form and long-form video content.

Context / Preferred Vibe: ${customVibe || 'Witty, cyberpunk-infused, insider developer culture, authoritative yet entertaining'}.
Sample Topic being covered: ${topicContext || 'Hacker News frontpage engineering stories, rewrites, security audits, and developer debates'}.

Return strictly a JSON array of 5 IP brand identity objects:
[
  {
    "id": "ip-1",
    "name": "The Orange Thread",
    "tagline": "Unfiltered Hacker News breakdowns for the curious engineer.",
    "hookLine": "What the top 1% of developers are arguing about right now.",
    "vibe": "Sleek retro-cyberpunk terminal with warm YC-orange glowing accents",
    "targetAudience": "Software engineers, startup founders, CS students, tech enthusiasts",
    "mascotOrVisualIdentity": "A vintage 1980s mainframe CRT monitor displaying live animated ASCII art",
    "suggestedHandle": "@TheOrangeThread",
    "whyItWorks": "Direct homage to Hacker News signature color and comment threads, instantly recognizable in tech circles."
  }
]`;

    const systemInstruction = 'You are the ultimate creative branding director for top tech media IPs. Output valid JSON array only.';

    let ipList: any = null;
    try {
      ipList = await generateGeminiJson(ai, prompt, systemInstruction, [
        'gemini-3.7-flash',
        'gemini-3.1-pro-preview',
        'gemini-3.1-flash-lite',
      ]);
    } catch (aiErr: any) {
      console.warn('[IP Names] AI tiers busy, returning curated brands:', aiErr?.message || aiErr);
      ipList = generateFallbackIpList(topicContext);
    }

    res.json(ipList);
  } catch (error: any) {
    console.log('[IP Names] Exception handled, returning curated IP roster.');
    res.json(generateFallbackIpList(topicContext));
  }
});

// 8. NotebookLM Deep Dive 2-Host Podcast Dialogue Generator
app.post('/api/notebooklm-dialogue', async (req, res) => {
  const { researchData, topicText = '' } = req.body;

  try {
    const ai = getAIClient();
    const topic = researchData?.topicTitle || topicText || 'Hacker News Breakthrough';
    const summary = researchData?.summary || '';
    const sentiment = JSON.stringify(researchData?.hnCommunitySentiment || {});
    const keyFacts = JSON.stringify(researchData?.keyFacts || []);

    const prompt = `You are the lead showrunner for a NotebookLM-style "Deep Dive" two-host audio podcast.
Generate an engaging, natural, 2-host conversational discussion breaking down this Hacker News tech topic:
TOPIC: ${topic}
SUMMARY: ${summary}
COMMUNITY SENTIMENT: ${sentiment}
KEY FACTS: ${keyFacts}

HOST 1 ("Host 1 (Alex)"): Enthusiastic, energetic tech scout, curious and articulate.
HOST 2 ("Host 2 (Morgan)"): Experienced, witty infrastructure engineer, asks tough questions, brings in skepticism and trade-offs.

Requirements:
- Structure as a 6 to 8 turn lively conversation between Host 1 and Host 2.
- The tone should feel like two smart colleagues casually discussing an exciting technical discovery over coffee.
- Include natural interjections ("Wait, really?", "Hold on a second", "Exactly", "Here's the catch").
- Highlight the core engineering problem, the surprising benchmark or exploit, and the community reaction.
- Conclude with a clear, memorable takeaway.

Output STRICTLY valid JSON adhering to this schema:
{
  "title": "Deep Dive: [Catchy Episode Title]",
  "episodeSummary": "One paragraph overview of the conversation.",
  "hosts": {
    "host1": { "name": "Alex", "title": "Tech Host", "voice": "Puck", "avatarColor": "#f97316" },
    "host2": { "name": "Morgan", "title": "Senior Infra Engineer", "voice": "Kore", "avatarColor": "#06b6d4" }
  },
  "turns": [
    {
      "id": "turn-1",
      "speaker": "Host 1 (Alex)",
      "speakerRole": "Tech Enthusiast",
      "text": "Exact spoken line for Host 1...",
      "tone": "excited",
      "durationEst": 8
    },
    {
      "id": "turn-2",
      "speaker": "Host 2 (Morgan)",
      "speakerRole": "Skeptical Pragmatist",
      "text": "Exact spoken line for Host 2...",
      "tone": "curious",
      "durationEst": 9
    }
  ],
  "keyTakeaways": [
    "Takeaway 1",
    "Takeaway 2",
    "Takeaway 3"
  ]
}`;

    const systemInstruction = 'You are the lead showrunner for a NotebookLM two-host podcast. Output strictly valid JSON.';

    let podcast: any = null;
    try {
      podcast = await generateGeminiJson(ai, prompt, systemInstruction, TEXT_MODELS);
    } catch (aiErr: any) {
      console.warn('[NotebookLM] Live AI tiers unavailable, returning dynamic podcast dialogue:', aiErr?.message || aiErr);
      podcast = generateFallbackNotebookLMPodcast(researchData, topicText);
    }

    res.json(podcast);
  } catch (error: any) {
    console.log('[NotebookLM] Exception caught, returning curated dialogue.');
    res.json(generateFallbackNotebookLMPodcast(researchData, topicText));
  }
});

// 9. NotebookLM High-Quality Audio Narration & Multi-Speaker Audio Synthesis
app.post('/api/notebooklm/generate-audio', async (req, res) => {
  try {
    const { script, researchData, host1Voice, host2Voice, podcastStyle } = req.body;
    console.log('[Server /api/notebooklm/generate-audio] Received request for topic:', researchData?.topicTitle || script?.title);
    
    const result = await generateNotebookLMAudioService({
      script,
      researchData,
      host1Voice: host1Voice || 'Puck',
      host2Voice: host2Voice || 'Kore',
      podcastStyle: podcastStyle || 'deep_dive',
    });

    res.json(result);
  } catch (error: any) {
    console.warn('[Server /api/notebooklm/generate-audio] Error generating NotebookLM audio:', error?.message);
    res.status(500).json({ error: 'Failed to generate NotebookLM audio', details: error?.message });
  }
});

// 10. NotebookLM Audio File Streamer / Delivery Endpoint
app.get('/api/notebooklm/audio/:id', (req, res) => {
  const audioId = req.params.id;
  const entry = getCachedNotebookLMAudio(audioId);

  if (!entry) {
    return res.status(404).json({ error: 'Audio file not found or expired' });
  }

  res.setHeader('Content-Type', entry.mimeType || 'audio/wav');
  res.setHeader('Content-Length', entry.buffer.length);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.setHeader('Content-Disposition', `inline; filename="${audioId}.wav"`);
  res.send(entry.buffer);
});

// 11. NotebookLM Service Health & Status
app.get('/api/notebooklm/status', (req, res) => {
  res.json({
    status: 'online',
    service: 'Google NotebookLM Audio & Podcast Service',
    hasApiKey: Boolean(process.env.NOTEBOOKLM_API_KEY || process.env.GEMINI_API_KEY),
    supportedModalities: ['audio/wav', 'audio/pcm', 'multi-speaker'],
    voices: ['Puck', 'Kore', 'Fenrir', 'Aoede', 'Charon'],
  });
});

// Setup Vite or static serving
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Telegram to HN Video Agent Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
