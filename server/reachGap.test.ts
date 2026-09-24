import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reachGapFor, REACH_GAP_TEXT } from './reachGap';

// The Heartbleed dossier from the live run that wrote "Millions of websites and users were exposed":
// a mechanism, versions, dates and an attack-effort figure, but nothing on how far it reached.
const heartbleedFacts = [
  'The vulnerability is officially designated as CVE-2014-0160.',
  'OpenSSL versions 1.0.1 through 1.0.1f are affected.',
  'The bug was introduced in December 2011 and remained active until the release of OpenSSL 1.0.1g on April 7, 2014.',
  'Exploitation allows an attacker to retrieve 64KB chunks of memory per request without leaving a trace in system logs.',
  'The bug was independently discovered by a team at Codenomicon and Neel Mehta of Google Security.',
  'Extracting private SSL keys is possible but requires significant effort; researchers were able to do it after roughly 2.5 million requests.',
];

const dossier = (extra: Partial<any> = {}) => ({
  summary: 'A missing bounds check let an attacker read server memory.',
  timeline: [{ dateOrPhase: 'December 2011', event: 'The flaw is introduced into the OpenSSL codebase.' }],
  researchGaps: [],
  keyFacts: heartbleedFacts,
  ...extra,
});

test('a dossier with a mechanism, versions, dates and an attack-effort figure but no reach gets the gap', () => {
  assert.equal(reachGapFor(dossier()), REACH_GAP_TEXT);
});

test('"2.5 million requests" and a year followed by a noun are not reach figures', () => {
  assert.equal(reachGapFor(dossier({ keyFacts: [...heartbleedFacts, 'In 2014 users were told to change passwords.'] })), REACH_GAP_TEXT);
});

test('a stated reach figure — a count, a share, a scale word or a cost — means there is no gap', () => {
  for (const fact of [
    'An estimated 500,000 servers were vulnerable.',
    'About 17% of secure web servers were affected.',
    'It exposed 3.2 million user accounts.',
    'Millions of users were exposed, the vendor said.',
    'Hundreds of thousands of sites were still unpatched.',
    'Clean-up cost the company $1.5 billion.',
  ]) {
    assert.equal(reachGapFor(dossier({ keyFacts: [...heartbleedFacts, fact] })), null, fact);
  }
});

test('a reach figure that appears only in a model-written angle does not count; the sources\' own text does', () => {
  const angles = [{ title: 'Millions at risk', hook: 'Millions of users were exposed', whyItGoesViral: 'x' }];
  assert.equal(reachGapFor(dossier({ infotainmentAngles: angles })), REACH_GAP_TEXT);
  assert.equal(reachGapFor(dossier({ summary: 'It reached over 40,000 servers in a week.' })), null);
});

test('a gap the model already wrote about reach is not duplicated, but an unrelated "affected" gap is not mistaken for one', () => {
  assert.equal(reachGapFor(dossier({ researchGaps: ['no figure for how many sites were hit — a vendor report would give it'] })), null);
  assert.equal(reachGapFor(dossier({ researchGaps: ['no affected version range stated — the advisory would give it'] })), REACH_GAP_TEXT);
});

test('a dossier with nothing in it still reports the gap and does not throw', () => {
  assert.equal(reachGapFor({}), REACH_GAP_TEXT);
  assert.equal(reachGapFor(undefined), REACH_GAP_TEXT);
});
