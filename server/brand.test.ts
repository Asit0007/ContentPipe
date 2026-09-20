import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetModelCooldowns } from './gemini';
import { generateProductionBible, generateSceneChunks } from './scriptPipeline';
import {
  generateFallbackScript, generateFallbackPlan, generateFallbackResearch, generateFallbackIpList,
  generateFallbackNotebookLMPodcast, generateFallbackChatReply, generateFallbackImage,
} from './fallbackGenerators';
import { DEFAULT_CHANNEL_BRAND } from '../shared/brand';

// A request with no channelBrandName must be written for the channel, never for a tool or another site.
beforeEach(() => resetModelCooldowns());

const PLAN = { title: 'T', tone: 'Deep Dive Documentary', targetDurationSec: 60 };
const RESEARCH = { topicTitle: 'T', summary: 's', retrievedSources: [] };
const NOT_OUR_BRAND = /Orange Thread|Hacker ?News|HN Infotainment|CyberPipe|ContentPipe/i;

function promptRecorder() {
  const prompts: string[] = [];
  const ai: any = {
    models: {
      generateContent: async ({ contents }: { contents: string }) => {
        prompts.push(String(contents));
        return { text: JSON.stringify({ characterBible: [], styleGuide: {}, scenes: [] }), candidates: [{ finishReason: 'STOP' }], usageMetadata: {} };
      },
    },
  };
  return { ai, prompts };
}

test('the default channel brand is the channel, not a tool or a source site', () => {
  assert.equal(DEFAULT_CHANNEL_BRAND, 'Blast Radius');
  assert.doesNotMatch(DEFAULT_CHANNEL_BRAND, NOT_OUR_BRAND);
});

test('production-bible and narrative prompts name the default brand when none is supplied', async () => {
  const { ai, prompts } = promptRecorder();
  const opts = { degraded: [] as string[] };
  await generateProductionBible(ai, PLAN, RESEARCH, undefined, opts);
  await generateSceneChunks(ai, PLAN, RESEARCH, { characterBible: [], styleGuide: {} } as any, undefined, opts).catch(() => undefined);
  const branded = prompts.filter((p) => p.includes(`"${DEFAULT_CHANNEL_BRAND}"`));
  assert.ok(branded.length >= 2, `expected the bible and a narrative prompt to carry the default brand; got ${branded.length} of ${prompts.length}`);
  for (const p of prompts) assert.doesNotMatch(p.match(/(?:Show|Brand Identity \/ Show Name): "[^"]*"/)?.[0] ?? '', NOT_OUR_BRAND);
});

test('an explicit brand still wins over the default', async () => {
  const { ai, prompts } = promptRecorder();
  await generateProductionBible(ai, PLAN, RESEARCH, 'Some Other Show', { degraded: [] });
  assert.ok(prompts.some((p) => p.includes('"Some Other Show"')));
  assert.ok(!prompts.some((p) => p.includes(`"${DEFAULT_CHANNEL_BRAND}"`)));
});

test('the canned fallback script signs off as the default brand and never as another', () => {
  const script: any = generateFallbackScript({ ...PLAN, tone: 'Witty Tech & Sarcastic', format: '16:9' }, RESEARCH, '');
  assert.match(script.signatureIntro, new RegExp(DEFAULT_CHANNEL_BRAND));
  assert.doesNotMatch(`${script.signatureIntro} ${script.signatureOutro} ${script.title}`, NOT_OUR_BRAND);
});

// Every canned surface too: these are what a viewer sees when the model is unavailable, and an SVG
// placeholder with another site's name burned into it ships as a real frame.
test('no canned fallback surface names a tool or another publication', () => {
  const research: any = generateFallbackResearch('a story about a CVE in a build server');
  const plan: any = generateFallbackPlan(research, '16:9', 'Deep Dive Documentary');
  const ipList: any = generateFallbackIpList('');
  const podcast: any = generateFallbackNotebookLMPodcast({ topicTitle: 'T' }, '');
  const chats = ['ip_strategist', 'script_doctor', 'fast_brainstorm'].map((r) => generateFallbackChatReply('name my show', r));
  const script: any = generateFallbackScript(plan, research, '');
  for (const [what, value] of [
    ['plan', plan], ['research', research], ['ipList', ipList], ['podcast', podcast],
    ['chat', chats], ['script', script],
  ] as const) {
    // The one legitimate mention is the research dossier's "no HN discussion was retrieved" sentence,
    // which names the API it did not get data from. Anything else is a brand leak.
    const text = JSON.stringify(value).replace(/No Hacker News discussion was retrieved[^"]*/g, '');
    const hit = text.match(NOT_OUR_BRAND);
    assert.equal(hit, null, `${what} leaks ${hit?.[0]}: ${text.slice(Math.max(0, (hit?.index ?? 0) - 90), (hit?.index ?? 0) + 90)}`);
  }
});

test('the generated infographic SVG carries our brand, not another', () => {
  const svg = Buffer.from(generateFallbackImage('benchmark upvote metrics terminal').split(',')[1], 'base64').toString();
  assert.match(svg, new RegExp(DEFAULT_CHANNEL_BRAND.toUpperCase()));
  assert.doesNotMatch(svg, NOT_OUR_BRAND);
});
