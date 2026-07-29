/**
 * Crabel's patterns against the control group he himself demands.
 *
 * Chapter 3 of the book is a CONTROL GROUP: the unconditional rate of a move
 * of a given size, against which every conditional result must be read. That
 * is the discipline this repo runs on, so the same test is applied to his own
 * patterns here.
 *
 * TWO QUESTIONS, and the second is the one that matters:
 *
 *   1. How often does each pattern fire on a random walk? (selectivity)
 *   2. Does a contraction actually raise the odds of an expansion ABOVE the
 *      unconditional rate — on random walks, where no market edge exists?
 *
 * Question 2 is the sharp one. Daily range is mean-reverting as a matter of
 * arithmetic: a narrow day is followed by a wider one most of the time simply
 * because the narrow day sat below its own average. If P(expansion |
 * contraction) exceeds the base rate on a RANDOM WALK by as much as it does on
 * real data, the contraction/expansion principle is a property of ranges, not
 * a tradable tendency — and a practitioner would have had no way to tell.
 *
 *   node scripts/crabel-noise.js [--walks 200]
 */
import { randomWalk, barsFromPath } from '../src/core/synthetic.js';
import { multiBarNR, MULTI_NR_SPECS, hooks, threeDayHighReversal, wideSpread } from '../src/core/crabel.js';

const args = process.argv.slice(2);
const wi = args.indexOf('--walks');
const WALKS = wi >= 0 ? Number(args[wi + 1]) : 200;
const BARS = 300;

const walk = (s) => barsFromPath(randomWalk({ n: BARS, seed: 7000 + s }), { noise: 0.006, seed: 8000 + s });
const rangeOf = (b) => b.high - b.low;

// ── 1. selectivity ──────────────────────────────────────────────────────────
const fired = {};
for (const s of MULTI_NR_SPECS) fired[s.name] = 0;
fired.hook = 0; fired['3DHR'] = 0;
const perWalk = { ...fired };

for (let w = 0; w < WALKS; w++) {
  const b = walk(w);
  const seen = new Set();
  for (let i = 50; i < b.length; i++) {
    for (const s of MULTI_NR_SPECS) {
      if (multiBarNR(b, i, s)?.qualifies) { perWalk[s.name]++; seen.add(s.name); }
    }
    if (hooks(b, i)) { perWalk.hook++; seen.add('hook'); }
    if (threeDayHighReversal(b, i)) { perWalk['3DHR']++; seen.add('3DHR'); }
  }
  for (const k of seen) fired[k]++;
}

console.log(`${WALKS} random walks of ${BARS} bars\n`);
console.log('SELECTIVITY');
const pad = 8;
console.log(`  ${'pattern'.padEnd(pad)}  walks%   per-walk`);
for (const k of Object.keys(fired)) {
  console.log(`  ${k.padEnd(pad)}  ${String(((fired[k] / WALKS) * 100).toFixed(1)).padStart(5)}   ${(perWalk[k] / WALKS).toFixed(2)}`);
}

// ── 2. the control group ────────────────────────────────────────────────────
//
// P(next-day range > today's range | today is an NR4) versus the unconditional
// P(next-day range > today's range). Same question Crabel asks, same shape of
// answer.
function conditionalExpansion(bars) {
  let ncond = 0, hitcond = 0, nall = 0, hitall = 0;
  for (let i = 7; i < bars.length - 1; i++) {
    const r = rangeOf(bars[i]);
    const expands = rangeOf(bars[i + 1]) > r;
    nall++; if (expands) hitall++;
    // NR4: narrower than each of the previous three days
    let nr4 = true;
    for (let k = i - 3; k < i; k++) if (rangeOf(bars[k]) <= r) { nr4 = false; break; }
    if (nr4) { ncond++; if (expands) hitcond++; }
  }
  return { ncond, hitcond, nall, hitall };
}

let C = { ncond: 0, hitcond: 0, nall: 0, hitall: 0 };
for (let w = 0; w < WALKS; w++) {
  const r = conditionalExpansion(walk(w));
  C = { ncond: C.ncond + r.ncond, hitcond: C.hitcond + r.hitcond, nall: C.nall + r.nall, hitall: C.hitall + r.hitall };
}
const condPct = (C.hitcond / C.ncond) * 100;
const basePct = (C.hitall / C.nall) * 100;

console.log('\nTHE CONTROL GROUP — does contraction predict expansion?');
console.log(`  P(next range > this range)              ${basePct.toFixed(1)}%   (n=${C.nall})`);
console.log(`  P(next range > this range | NR4)        ${condPct.toFixed(1)}%   (n=${C.ncond})`);
console.log(`  lift on a RANDOM WALK                   ${(condPct - basePct >= 0 ? '+' : '')}${(condPct - basePct).toFixed(1)} points`);
console.log('\n  A large lift here is NOT an edge — it is daily range being mean-reverting');
console.log('  by arithmetic. Any real-data lift must be read against THIS number,');
console.log('  which is exactly the comparison Crabel builds his Chapter 3 around.');
