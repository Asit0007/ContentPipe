/**
 * hook-score.ts — score hook lines with server/hookScore.ts, the same panel the script audit uses.
 *
 *   npm run hook:score -- "Your phone could lose every photo before you notice."   # one line
 *   npm run hook:score -- hooks.txt                                                  # one hook per line, ranked
 *   npm run hook:score -- .runs/story-<slug>/brief.json                              # scene 1 of a story
 *   npm run hook:score -- hooks.txt --json
 *
 * A heuristic: a WEAK band is a reason to rewrite, a STRONG one is not a promise (see hookScore.ts).
 * Calls nothing and spends nothing.
 */
import fs from 'node:fs';
import { scoreHook, type HookScore } from '../server/hookScore';

function hooksFrom(arg: string): string[] {
  if (!fs.existsSync(arg)) return [arg];
  const text = fs.readFileSync(arg, 'utf8');
  if (arg.endsWith('.json')) {
    const data = JSON.parse(text);
    const scenes = data?.script?.scenes || data?.scenes || [];
    const first = scenes[0]?.narration;
    if (!first) throw new Error(`${arg} has no scenes[0].narration`);
    return [first];
  }
  return text.split('\n').map((l) => l.trim()).filter(Boolean);
}

function show(h: HookScore): string {
  const bar = (v: number) => '#'.repeat(Math.floor(v / 5));
  const rows = Object.entries(h.properties).map(([k, v]) => `    ${k.padEnd(12)} ${String(v).padStart(3)}  ${bar(v)}`);
  return [
    `\n  ${h.hook}`,
    ...rows,
    `    ${'VERDICT'.padEnd(12)} ${String(h.verdict).padStart(3)}  ${h.band}`,
    `    formula      ${h.formula}${h.matched ? '' : '  (no formula matched: usually a summary, not a hook)'}`,
    `    weakest      ${h.weakest}: ${h.fix}`,
  ].join('\n');
}

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const input = args.filter((a) => a !== '--json');
if (!input.length) {
  console.error('usage: npm run hook:score -- "<hook line>" | hooks.txt | brief.json [--json]');
  process.exit(2);
}
const scored = input.flatMap(hooksFrom).map(scoreHook).sort((a, b) => b.verdict - a.verdict);
if (asJson) console.log(JSON.stringify(scored, null, 1));
else {
  for (const h of scored) console.log(show(h));
  if (scored.length > 1) console.log(`\n  best: ${scored[0].hook}  (${scored[0].verdict}, ${scored[0].band})\n`);
}
