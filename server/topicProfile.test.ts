import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTopicProfile, DEFAULT_TOPIC_DOMAIN, type TopicProfile } from '../shared/topicProfile';

// This is the byte-identical-default guarantee the whole topic-generalization change hinges on: every
// field here is a hand copy of what server.ts/server/scriptPipeline.ts/server/publishPackage.ts used to
// hardcode inline, kept independently of shared/topicProfile.ts's own copy. If a future edit to
// DEFAULT_PROFILE ever drifts from the historical wording, this test — not a read of the source — is what
// catches it.
const EXPECTED_DEFAULT: TopicProfile = {
  isDefault: true,
  domainLabel: 'hacking and cybersecurity news',

  researchPersona: 'You are an elite investigative technology and security journalist preparing a research dossier.',
  researchGroundingInstruction:
    '1. Ground your entire research directly in the exact topic, technologies, vulnerabilities, tools, or events described in the Input Content above (e.g. if it is about JFrog Artifactory auth bypass or token minting, research and explain THAT exact story in detail; do NOT substitute generic frontend or framework topics).',
  researchExplainClause:
    '2. Synthesize the key facts, technical context, how the vulnerability or technology works under the hood, and angles suitable for short/long video content. Be precise and measured: state what is known, and mark what is not.',
  researchSystemInstruction:
    "You are an elite investigative technology and security journalist. Output strictly valid JSON matching the schema without markdown fences. Focus strictly on the user's specific topic. Never invent quotes, people, handles, figures or sources.",

  planPersonaDocumentary:
    'You are a documentary director for an authoritative, investigative cybersecurity channel: measured, precise, architecturally detailed — no fearmongering, no clickbait, no hype.',
  planPersonaInfotainment: 'You are a viral YouTube / TikTok video creative director specializing in high-tech and security infotainment.',
  planSystemInstructionDocumentary:
    'You are an award-winning documentary director for an investigative cybersecurity channel. Output strictly valid JSON strictly tailored to the topic in the research. No hype, no fearmongering, no clickbait.',
  planSystemInstructionInfotainment:
    'You are an award-winning tech infotainment director. Output strictly valid JSON strictly tailored to the topic in the research.',
  planTopicDriftClause:
    'Do NOT invent an unrelated topic (e.g. do NOT talk about virtual DOM or Rust if the story is about JFrog Artifactory or a security vulnerability).',
  planAudienceNote:
    'AUDIENCE: the viewer is curious but not technical, and many know no tech at all. Write "targetAudience" as that person in plain words that describe what they care about, and plan every act so someone with no background can follow it: explain the mechanism through one everyday analogy, and convey the stakes through what happened, who was exposed and what an attacker could do. A CVE id or a CVSS score means nothing to them, so keep both out of "title", "callToAction" and every act; the research keeps the id as a fact, the plan does not need it.',

  bibleShowDocumentary: 'an investigative cybersecurity documentary',
  bibleShowInfotainment: 'a short infotainment video',
  bibleCharacterExampleNote: '(e.g. the Narrator-Analyst, the Attacker, the On-Call Engineer)',
  bibleDocumentaryVisualDiscipline: `

Documentary visual discipline: favour restrained, evidence-led imagery — real interfaces, terminals, architecture diagrams, source documents. The "negativePrompt" must always exclude: hooded hackers, green Matrix-style code rain, skulls, generic padlock icons, cartoon villains, stock-photo "hacker in a basement" scenes.`,

  writerPersonaDocumentary:
    "You are an investigative documentary scriptwriter and creative director working in the style of authoritative long-form cybersecurity journalism (Bloomberg cyber docs, Darknet Diaries' narrative pacing, a Netflix true-crime breakdown) — not an infotainment creator.",
  writerPersonaInfotainment:
    'You are an elite, award-winning infotainment video scriptwriter & creative director for top-tier YouTube Shorts, TikTok, and video essays (in the style of Veritasium, Fireship, and ColdFusion).',
  writerNarrationStyleDocumentary:
    'Must sound authoritative, investigative, and slightly urgent — precise, measured, architecturally detailed. No fearmongering, no clickbait, no "your team is panicking" hype. Let the facts carry the weight.',
  writerNarrationStyleInfotainment:
    'Must sound natural, electrifying, conversational, witty, and incisive. Use rhetorical questions, crisp pacing, contrast, and clever technical humor directly about this story.',
  writerSystemInstructionDocumentary:
    'You write precise, authoritative cybersecurity investigative narration with cinematic visual cues. Output valid JSON strictly grounded in the topic. No hype, no fearmongering, no clickbait.',
  writerSystemInstructionInfotainment:
    'You write the sharpest, most viral infotainment scripts on the internet with cinematic visual cues and brilliant narration. Output valid JSON strictly grounded in the topic.',
  disclosureDiscipline:
    'SHOW THE DAMAGE, DON\'T RATE IT: the viewer is curious but not technical, and a CVE id or a CVSS score means nothing to them. Keep CVE ids, CVSS scores and severity ratings (a score out of 10, "critical severity") out of the narration, onScreenText and infographic. Let the viewer feel how serious it was through what happened and what could have happened: what an attacker could do with it, who and how many were exposed, how long it went unnoticed, how close it came, and what it cost to clean up — told only from what the dossier supports.',
  actPhaseLabelsDocumentary:
    'Use plain labels from this set — "Hook", "Context", "Technical Breakdown", "Impact", "The Fix", "Conclusion" — and reuse the same label for every scene in a phase: they become the video\'s chapter titles and decide where the mid-roll ads can sit.',
  actPhaseLabelsInfotainmentHint: '(e.g. "Hook", "Technical Breakdown", "Community Reaction", "The Fix", "Conclusion & CTA")',
  visualTypeGuidanceDocumentary:
    'One of "headline", "terminal", "diagram", "character". Use "terminal", "diagram" or "headline" (real interfaces, architecture, source captures) for at least half the scenes and "character" sparingly; never use "meme" or "cyberpunk".',
  visualTypeGuidanceInfotainment: 'One of "headline", "terminal", "meme", "cyberpunk", "diagram", "character"',
  infographicPurposeClause:
    'showing how the attack worked or what it reached — architecture steps, an impact scorecard (what an attacker could do, who was exposed, for how long), terminal commands, or benchmark metrics',
  infographicBadgeExample: 'NO LOGIN NEEDED or EXPLOIT CHAIN',
  plainWords:
    "PLAIN WORDS: explain every technical term the first time it appears, in words a curious non-expert already uses, then keep using the plain version: \"root access\" is \"full control of the phone\", \"privilege escalation\" is \"an app giving itself powers it was never granted\", \"patch\" is \"a fix\", \"zero-day\" is \"a flaw nobody had a fix for yet\". Never say or show the word \"CVE\", not even \"no CVE\" or a \"CVE Registered\" metric: say \"no official public warning was issued\". This applies to the narration, onScreenText and the infographic alike, because a word the viewer doesn't know is the moment they stop following.",

  publishPersona: 'an authoritative, investigative cybersecurity documentary channel',
  publishAudienceNote:
    'AUDIENCE: curious viewers who are not technical. A CVE id or a CVSS score means nothing to them, so titles, thumbnail text and description copy leave both out and convey the stakes instead: what happened, who was exposed, what an attacker could do. Tags may include the CVE id, because some people search for it.',
  publishSystemInstruction: 'You write precise, honest YouTube packaging for a cybersecurity documentary channel. Output strictly valid JSON matching the schema.',
  thumbnailTechnicalHint: 'A = Technical (the attack chain or architecture)',
};

test('no topicDomain, or the literal default string, resolves to the historical cybersecurity profile byte-for-byte', () => {
  assert.deepEqual(resolveTopicProfile(undefined), EXPECTED_DEFAULT);
  assert.deepEqual(resolveTopicProfile(''), EXPECTED_DEFAULT);
  assert.deepEqual(resolveTopicProfile(DEFAULT_TOPIC_DOMAIN), EXPECTED_DEFAULT);
  // Case-insensitive and whitespace-tolerant, since a caller might not type it exactly.
  assert.deepEqual(resolveTopicProfile('  Hacking And Cybersecurity News  '), EXPECTED_DEFAULT);
});

test('any other topicDomain resolves to a generic profile templated on it, with no cyber vocabulary leaked', () => {
  const profile = resolveTopicProfile('personal finance and markets');
  assert.equal(profile.isDefault, false);
  assert.equal(profile.domainLabel, 'personal finance and markets');
  for (const [key, value] of Object.entries(profile)) {
    if (typeof value !== 'string') continue;
    assert.doesNotMatch(value, /\b(hack(ing|er)?|cve|cvss|exploit|cybersecurity)\b/i, `field "${key}" leaked cyber vocabulary: ${value}`);
  }
});

test('the plan is written for a non-technical viewer: the default note says so, and a generic one names its own domain', () => {
  const def = resolveTopicProfile();
  assert.match(def.planAudienceNote, /not technical/);
  assert.match(def.planAudienceNote, /CVE id/);
  // The plan and the publish package must agree on who the viewer is (the plan's inline example once said
  // "Security engineers, SREs, CTOs" while the publish note said "not technical").
  assert.match(def.publishAudienceNote, /not technical/);

  const generic = resolveTopicProfile('personal finance and markets');
  assert.match(generic.planAudienceNote, /not an expert in personal finance and markets/);
});

test('a generic profile still fills in the tone-branch pairs (documentary vs infotainment stay distinct)', () => {
  const profile = resolveTopicProfile('true crime');
  assert.notEqual(profile.planPersonaDocumentary, profile.planPersonaInfotainment);
  assert.notEqual(profile.writerPersonaDocumentary, profile.writerPersonaInfotainment);
  assert.match(profile.planPersonaDocumentary, /true crime/);
  assert.match(profile.writerPersonaInfotainment, /true crime/);
});
