/**
 * Two questions the first sweep raised:
 *   1. detect% sat at exactly 71.4% (5 of 7) at EVERY bandwidth. Which two
 *      shapes are never found, and why?
 *   2. 20-65 false detections per random walk is far worse than our own
 *      detector's 0.78. Is that the definitions, or is it because I ran with
 *      window:null instead of the paper's 38 bars?
 */
import { GENERATORS, barsFromPath, randomWalk } from '../src/core/synthetic.js';
import { detectLmwPatterns } from '../src/core/lmw_patterns.js';
import { findKernelPivots } from '../src/core/kernel.js';

const TRUTH = [
  ['head_and_shoulders', 'head_and_shoulders'],
  ['inverse_head_and_shoulders', 'inverse_head_and_shoulders'],
  ['broadening_formation', 'broadening_top'],
  ['symmetrical_triangle', 'triangle_top'],
  ['rectangle', 'rectangle_top'],
  ['double_top', 'double_top'],
  ['double_bottom', 'double_bottom'],
];

console.log('Q1 — which shapes are missed?  (mult 1.0, window null, 6 trials each)\n');
for (const [gen, expected] of TRUTH) {
  let found = 0;
  const sample = [];
  for (let t = 0; t < 6; t++) {
    const bars = barsFromPath(GENERATORS[gen]({}), { noise: 0.01, seed: 2000 + t });
    const out = detectLmwPatterns(bars, { window: null, bandwidth_multiplier: 1.0 });
    const names = out.patterns.map((p) => p.pattern);
    if (names.includes(expected)) found++;
    if (t === 0) {
      const piv = findKernelPivots(bars, { bandwidth_multiplier: 1.0 }).pivots;
      sample.push(`pivots=${piv.length} [${piv.map((p) => p.kind[0] + p.price.toFixed(0)).join(' ')}]`);
      sample.push(`got: ${[...new Set(names)].join(', ') || 'nothing'}`);
    }
  }
  console.log(`${expected.padEnd(28)} ${found}/6`);
  for (const s of sample) console.log(`    ${s}`);
}

console.log('\n\nQ2 — does the paper\'s 38-bar window control the noise?\n');
console.log('window   mult   detections/walk   walks w/ any%   pivots/walk');
console.log('------   ----   ---------------   -------------   -----------');
for (const window of [38, 60, null]) {
  for (const mult of [0.3, 1.0, 2.0]) {
    let hits = 0, any = 0, piv = 0;
    const WALKS = 25;
    for (let w = 0; w < WALKS; w++) {
      const bars = barsFromPath(randomWalk({ n: 200, seed: 5000 + w }), { noise: 0.005, seed: 9000 + w });
      const out = detectLmwPatterns(bars, { window, bandwidth_multiplier: mult });
      hits += out.patterns.length;
      piv += out.pivots_found;
      if (out.patterns.length) any++;
    }
    console.log(
      `${String(window ?? 'none').padEnd(8)} ${String(mult).padEnd(6)} ${(hits / WALKS).toFixed(2).padStart(15)}   `
      + `${((any / WALKS) * 100).toFixed(0).padStart(12)}%   ${(piv / WALKS).toFixed(1).padStart(11)}`,
    );
  }
}

console.log('\n\nQ3 — how many 5-pivot windows even exist per walk? (the denominator)\n');
for (const mult of [0.3, 1.0, 2.0]) {
  let piv = 0;
  for (let w = 0; w < 25; w++) {
    const bars = barsFromPath(randomWalk({ n: 200, seed: 5000 + w }), { noise: 0.005, seed: 9000 + w });
    piv += findKernelPivots(bars, { bandwidth_multiplier: mult }).pivots.length;
  }
  const avg = piv / 25;
  console.log(`mult ${mult}: ${avg.toFixed(1)} pivots => ${Math.max(0, avg - 4).toFixed(1)} five-pivot windows per walk`);
}
