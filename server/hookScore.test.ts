import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreHook, type HookScore } from './hookScore';

// Every expectation below was produced by running the original, unmodified
// hookscore.py (Jake Schincariol, MIT, youtube-agent-skill@a2feb21) on the same text:
// `python3 -I hookscore.py --json --hook "<hook>"` for properties/verdict/band/formula, and its
// plain report for the matched-pattern count, the weakest property and the fix text.
// `hook` in the result is the stripped text, as in the Python's JSON.
type Expected = Omit<HookScore, 'hook'>;

const CASES: { hook: string; expected: Expected }[] = [
  {
    hook: "We are taught that Android security is a fortress of isolation. Apps live in locked rooms, unable to touch the system's core. But for OnePlus and OPPO users, that wall had a hidden gap.",
    expected: {"properties": {"SPECIFICITY": 52, "ADDRESS": 26, "STAKES": 22, "CURIOSITY": 41, "BREVITY": 30}, "verdict": 29, "band": "WEAK", "formula": "The Insider", "matched": 1, "weakest": "STAKES", "fix": "name what it costs them to keep doing it the current way"},
  },
  {
    hook: "Hello",
    expected: {"properties": {"SPECIFICITY": 34, "ADDRESS": 26, "STAKES": 22, "CURIOSITY": 24, "BREVITY": 30}, "verdict": 25, "band": "WEAK", "formula": "Unclassified", "matched": 0, "weakest": "STAKES", "fix": "name what it costs them to keep doing it the current way"},
  },
  {
    hook: "",
    expected: {"properties": {"SPECIFICITY": 0, "ADDRESS": 26, "STAKES": 22, "CURIOSITY": 24, "BREVITY": 0}, "verdict": 9, "band": "WEAK", "formula": "Unclassified", "matched": 0, "weakest": "SPECIFICITY", "fix": "swap one adjective for a number, a name or a date"},
  },
  {
    hook: "So basically today guys we are going to look at what happened when a very large company that nobody had really heard of decided to quietly change the way that it stores customer passwords across several of its older systems and then forgot to tell anyone about it until the whole thing came apart on a Tuesday afternoon",
    expected: {"properties": {"SPECIFICITY": 10, "ADDRESS": 26, "STAKES": 22, "CURIOSITY": 75, "BREVITY": 10}, "verdict": 21, "band": "WEAK", "formula": "Unclassified", "matched": 0, "weakest": "SPECIFICITY", "fix": "swap one adjective for a number, a name or a date"},
  },
  {
    hook: "Why did a single app get to read every message on millions of phones?",
    expected: {"properties": {"SPECIFICITY": 34, "ADDRESS": 26, "STAKES": 22, "CURIOSITY": 59, "BREVITY": 100}, "verdict": 38, "band": "WEAK", "formula": "The Question", "matched": 2, "weakest": "STAKES", "fix": "name what it costs them to keep doing it the current way"},
  },
  {
    hook: "The flaw was never exploited because the vendor patched it before anyone noticed.",
    expected: {"properties": {"SPECIFICITY": 34, "ADDRESS": 26, "STAKES": 74, "CURIOSITY": 23, "BREVITY": 100}, "verdict": 40, "band": "WEAK", "formula": "The Impossible Claim", "matched": 1, "weakest": "CURIOSITY", "fix": "cut the half of the sentence that answers itself"},
  },
  {
    hook: "97% of people never update their router, and one breach cost Target $292 million.",
    expected: {"properties": {"SPECIFICITY": 84, "ADDRESS": 26, "STAKES": 88, "CURIOSITY": 24, "BREVITY": 100}, "verdict": 48, "band": "WEAK", "formula": "The Statistic", "matched": 1, "weakest": "CURIOSITY", "fix": "cut the half of the sentence that answers itself"},
  },
  {
    hook: "You are probably still using the same password you made in 2014 and it could cost you everything.",
    expected: {"properties": {"SPECIFICITY": 56, "ADDRESS": 100, "STAKES": 62, "CURIOSITY": 24, "BREVITY": 100}, "verdict": 51, "band": "WEAK", "formula": "Unclassified", "matched": 0, "weakest": "CURIOSITY", "fix": "cut the half of the sentence that answers itself"},
  },
  {
    hook: "Last March Microsoft and Okta quietly told Mandiant that Lapsus$ had broken in.",
    expected: {"properties": {"SPECIFICITY": 52, "ADDRESS": 26, "STAKES": 22, "CURIOSITY": 24, "BREVITY": 100}, "verdict": 36, "band": "WEAK", "formula": "Unclassified", "matched": 0, "weakest": "STAKES", "fix": "name what it costs them to keep doing it the current way"},
  },
  {
    hook: "This channel went from 400 to 200,000 subscribers in seven months, but nobody talks about it.",
    expected: {"properties": {"SPECIFICITY": 73, "ADDRESS": 26, "STAKES": 36, "CURIOSITY": 58, "BREVITY": 100}, "verdict": 46, "band": "WEAK", "formula": "Someone Else's Result", "matched": 2, "weakest": "ADDRESS", "fix": "say 'you' in the first six words"},
  },
  {
    hook: "  Stop doing this before you lose your account.  \n",
    expected: {"properties": {"SPECIFICITY": 34, "ADDRESS": 96, "STAKES": 100, "CURIOSITY": 41, "BREVITY": 89}, "verdict": 57, "band": "WORKABLE", "formula": "The Warning", "matched": 2, "weakest": "SPECIFICITY", "fix": "swap one adjective for a number, a name or a date"},
  },
  {
    hook: "10 mistakes that will get you hacked this week",
    expected: {"properties": {"SPECIFICITY": 56, "ADDRESS": 76, "STAKES": 36, "CURIOSITY": 24, "BREVITY": 100}, "verdict": 45, "band": "WEAK", "formula": "The List", "matched": 1, "weakest": "CURIOSITY", "fix": "cut the half of the sentence that answers itself"},
  },
  {
    hook: "Is this the best, most insane, amazing secret ever?",
    expected: {"properties": {"SPECIFICITY": 0, "ADDRESS": 26, "STAKES": 22, "CURIOSITY": 42, "BREVITY": 100}, "verdict": 23, "band": "WEAK", "formula": "The Question", "matched": 2, "weakest": "SPECIFICITY", "fix": "swap one adjective for a number, a name or a date"},
  },
  {
    hook: "Zero days vs. N-days: which one is more dangerous to you?",
    expected: {"properties": {"SPECIFICITY": 40, "ADDRESS": 46, "STAKES": 22, "CURIOSITY": 59, "BREVITY": 100}, "verdict": 41, "band": "WEAK", "formula": "The Comparison", "matched": 2, "weakest": "STAKES", "fix": "name what it costs them to keep doing it the current way"},
  },
  {
    hook: "A \u00e9t\u00e9 Caf\u00e9 \u00c9COLE na\u00efve 3 \u00d7 4 weeks",
    expected: {"properties": {"SPECIFICITY": 90, "ADDRESS": 26, "STAKES": 36, "CURIOSITY": 24, "BREVITY": 100}, "verdict": 43, "band": "WEAK", "formula": "Unclassified", "matched": 0, "weakest": "CURIOSITY", "fix": "cut the half of the sentence that answers itself"},
  },
  {
    hook: "iOS and Android versus Windows; Alice told Bob about 5.5k users in 3 days",
    expected: {"properties": {"SPECIFICITY": 96, "ADDRESS": 26, "STAKES": 36, "CURIOSITY": 24, "BREVITY": 100}, "verdict": 43, "band": "WEAK", "formula": "The Comparison", "matched": 1, "weakest": "CURIOSITY", "fix": "cut the half of the sentence that answers itself"},
  },
  {
    hook: "You are losing 40% of your viewers in 8 seconds, but nobody tells you why.",
    expected: {"properties": {"SPECIFICITY": 78, "ADDRESS": 100, "STAKES": 36, "CURIOSITY": 75, "BREVITY": 100}, "verdict": 61, "band": "WORKABLE", "formula": "The Statistic", "matched": 1, "weakest": "STAKES", "fix": "name what it costs them to keep doing it the current way"},
  },
  {
    hook: "Why does your router cost you 3 days of work before Google shuts it down?",
    expected: {"properties": {"SPECIFICITY": 62, "ADDRESS": 96, "STAKES": 88, "CURIOSITY": 76, "BREVITY": 100}, "verdict": 75, "band": "STRONG", "formula": "The Question", "matched": 2, "weakest": "SPECIFICITY", "fix": "swap one adjective for a number, a name or a date"},
  },
  {
    hook: "Stop wasting 12 hours a week: why do 90% of Apple users never fix this before it breaks?",
    expected: {"properties": {"SPECIFICITY": 84, "ADDRESS": 26, "STAKES": 100, "CURIOSITY": 76, "BREVITY": 100}, "verdict": 57, "band": "WORKABLE", "formula": "The Statistic", "matched": 1, "weakest": "ADDRESS", "fix": "say 'you' in the first six words"},
  },
];

for (const [i, c] of CASES.entries()) {
  test(`hookScore parity ${i + 1}: ${JSON.stringify(c.hook.trim().slice(0, 50))}`, () => {
    const got = scoreHook(c.hook);
    assert.deepEqual(got, { hook: c.hook.trim(), ...c.expected });
  });
}

test('hookScore covers all three bands and several formulas', () => {
  assert.deepEqual(new Set(CASES.map((c) => c.expected.band)), new Set(['STRONG', 'WORKABLE', 'WEAK']));
  assert.ok(new Set(CASES.map((c) => c.expected.formula)).size >= 6);
});

test('hookScore: a tie for weakest resolves to the first property in order (Python min())', () => {
  // empty text: SPECIFICITY and BREVITY are both 0; SPECIFICITY comes first
  const got = scoreHook('');
  assert.equal(got.properties.SPECIFICITY, 0);
  assert.equal(got.properties.BREVITY, 0);
  assert.equal(got.weakest, 'SPECIFICITY');
});
