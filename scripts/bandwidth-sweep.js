/**
 * Settle the kernel bandwidth question with measurement instead of citation.
 *
 * Lo, Mamaysky & Wang select h by cross-validation and then use 0.3 x h*,
 * calling it "admittedly an ad hoc adjustment". Nekrasov's 2010 reproduction
 * found 0.3 x h* "tends to detecting of too local extrema" and preferred h*.
 * Neither settled it, and nobody since has.
 *
 * We can, for our own data, because synthetic.js already provides the two
 * numbers that matter: how often a pattern that IS there gets found, and how
 * often one that is NOT there gets reported.
 *
 * Run:  node scripts/bandwidth-sweep.js
 */
import { GENERATORS, barsFromPath, randomWalk } from '../src/core/synthetic.js';
import { detectLmwPatterns } from '../src/core/lmw_patterns.js';

const MULTIPLIERS = [0.2, 0.3, 0.5, 0.75, 1.0, 1.5, 2.0];

// Constructed shapes, mapped onto the LMW naming.
const TRUTH = [
  ['head_and_shoulders', 'head_and_shoulders'],
  ['inverse_head_and_shoulders', 'inverse_head_and_shoulders'],
  ['broadening_formation', 'broadening_top'],
  ['symmetrical_triangle', 'triangle_top'],
  ['rectangle', 'rectangle_top'],
  ['double_top', 'double_top'],
  ['double_bottom', 'double_bottom'],
];

const TRIALS = 6;
const WALKS = 40;
const WALK_BARS = 200;

function detectNames(bars, mult) {
  return detectLmwPatterns(bars, { window: null, bandwidth_multiplier: mult }).patterns.map((p) => p.pattern);
}

console.log('Bandwidth sweep — LMW definitions on kernel pivots');
console.log(`${TRIALS} trials per shape at noise 0.01, ${WALKS} random walks of ${WALK_BARS} bars\n`);
console.log('mult   detect%   pivots/walk   detections/walk   walks w/ any%   signal:noise');
console.log('----   -------   -----------   ---------------   -------------   ------------');

const rows = [];
for (const mult of MULTIPLIERS) {
  // Detection rate against constructed truth.
  let found = 0, total = 0;
  for (const [gen, expected] of TRUTH) {
    for (let t = 0; t < TRIALS; t++) {
      const bars = barsFromPath(GENERATORS[gen]({}), { noise: 0.01, seed: 2000 + t });
      total++;
      if (detectNames(bars, mult).includes(expected)) found++;
    }
  }
  const detectPct = (found / total) * 100;

  // False positives on random walks.
  let hits = 0, walksWithAny = 0, pivotTotal = 0;
  for (let w = 0; w < WALKS; w++) {
    const bars = barsFromPath(randomWalk({ n: WALK_BARS, seed: 5000 + w }), { noise: 0.005, seed: 9000 + w });
    const out = detectLmwPatterns(bars, { window: null, bandwidth_multiplier: mult });
    hits += out.patterns.length;
    pivotTotal += out.pivots_found;
    if (out.patterns.length) walksWithAny++;
  }
  const perWalk = hits / WALKS;
  const pivotsPerWalk = pivotTotal / WALKS;
  const anyPct = (walksWithAny / WALKS) * 100;
  const ratio = perWalk > 0 ? detectPct / perWalk : Infinity;

  rows.push({ mult, detectPct, pivotsPerWalk, perWalk, anyPct, ratio });
  console.log(
    `${String(mult).padEnd(6)} ${detectPct.toFixed(1).padStart(6)}%  ${pivotsPerWalk.toFixed(1).padStart(10)}   `
    + `${perWalk.toFixed(2).padStart(15)}   ${anyPct.toFixed(0).padStart(12)}%   ${Number.isFinite(ratio) ? ratio.toFixed(1).padStart(12) : '         inf'}`,
  );
}

console.log('\nReading it:');
console.log('  detect%          — a pattern that IS there, found. Higher is better.');
console.log('  detections/walk  — patterns reported on pure noise. LOWER is better.');
console.log('  signal:noise     — detect% per noise detection. Higher is better.');

const best = rows.filter((r) => Number.isFinite(r.ratio)).sort((a, b) => b.ratio - a.ratio)[0];
const cleanest = rows.slice().sort((a, b) => a.perWalk - b.perWalk)[0];
const sharpest = rows.slice().sort((a, b) => b.detectPct - a.detectPct)[0];

console.log(`\nBest signal:noise      ${best ? best.mult : 'n/a'}`);
console.log(`Fewest false positives ${cleanest.mult}  (${cleanest.perWalk.toFixed(2)}/walk)`);
console.log(`Highest detection      ${sharpest.mult}  (${sharpest.detectPct.toFixed(1)}%)`);

const lmw = rows.find((r) => r.mult === 0.3);
const nek = rows.find((r) => r.mult === 1.0);
if (lmw && nek) {
  console.log('\nThe disputed pair:');
  console.log(`  LMW      0.3x : detect ${lmw.detectPct.toFixed(1)}%, ${lmw.pivotsPerWalk.toFixed(1)} pivots/walk, ${lmw.perWalk.toFixed(2)} false/walk`);
  console.log(`  Nekrasov 1.0x : detect ${nek.detectPct.toFixed(1)}%, ${nek.pivotsPerWalk.toFixed(1)} pivots/walk, ${nek.perWalk.toFixed(2)} false/walk`);
  console.log(`  Nekrasov's claim was that 0.3x over-detects local extrema: ${lmw.pivotsPerWalk > nek.pivotsPerWalk ? 'SUPPORTED' : 'NOT supported'} `
    + `(${lmw.pivotsPerWalk.toFixed(1)} vs ${nek.pivotsPerWalk.toFixed(1)} pivots per random walk).`);
}
