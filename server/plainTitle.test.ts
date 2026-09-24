import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripCveIds } from '../shared/plainTitle';

test('a bracketed CVE id is removed with its brackets', () => {
  assert.equal(stripCveIds('The Heartbleed Bug (CVE-2014-0160)'), 'The Heartbleed Bug');
  assert.equal(stripCveIds('Backdoor in xz [CVE-2024-3094]'), 'Backdoor in xz');
  assert.equal(stripCveIds('Log4Shell (CVE-2021-44228, CVE-2021-45046)'), 'Log4Shell');
});

test('a leading or trailing id goes with its separator, and a lowercase start is capitalised', () => {
  assert.equal(stripCveIds('CVE-2024-3094: the xz backdoor'), 'The xz backdoor');
  assert.equal(stripCveIds('Heartbleed – CVE-2014-0160'), 'Heartbleed');
  assert.equal(stripCveIds('Heartbleed, CVE-2014-0160'), 'Heartbleed');
});

test('an id in the middle of a sentence is dropped without leaving a double space', () => {
  assert.equal(stripCveIds('How CVE-2024-3094 nearly broke the internet'), 'How nearly broke the internet');
});

test('matching is case-insensitive and needs a real id (a year, then 4 to 7 digits)', () => {
  assert.equal(stripCveIds('Heartbleed (cve-2014-0160)'), 'Heartbleed');
  assert.equal(stripCveIds('Patch 2024-1234 and CVE-2024-1 stay'), 'Patch 2024-1234 and CVE-2024-1 stay');
});

test('a title without an id is returned untouched, and one that is only an id is never blanked', () => {
  assert.equal(stripCveIds('The xz backdoor that almost happened'), 'The xz backdoor that almost happened');
  assert.equal(stripCveIds('CVE-2024-3094'), 'CVE-2024-3094');
  assert.equal(stripCveIds('  (CVE-2024-3094)  '), '(CVE-2024-3094)');
  assert.equal(stripCveIds(''), '');
});
