/**
 * How much information does an LMW pattern definition actually carry?
 *
 * The sweep found ~50 detections per random walk against ~72 available
 * five-pivot windows. If most windows match something, a match means almost
 * nothing — which would be a simpler explanation for Nekrasov's failure to
 * replicate than anything about bandwidth.
 *
 * Measured directly: take random-walk pivots, slide a 5-window, count how
 * often each definition fires.
 */
import { randomWalk, barsFromPath } from '../src/core/synthetic.js';
import { findKernelPivots } from '../src/core/kernel.js';
import { classifyFive } from '../src/core/lmw_patterns.js';

const WALKS = 60;
const counts = {};
let windows = 0, windowsWithAny = 0;

for (let w = 0; w < WALKS; w++) {
  const bars = barsFromPath(randomWalk({ n: 200, seed: 5000 + w }), { noise: 0.005, seed: 9000 + w });
  const { pivots } = findKernelPivots(bars, { bandwidth_multiplier: 1.0 });
  for (let i = 0; i + 4 < pivots.length; i++) {
    windows++;
    const hits = classifyFive(pivots.slice(i, i + 5));
    if (hits.length) windowsWithAny++;
    for (const h of hits) counts[h] = (counts[h] || 0) + 1;
  }
}

console.log(`Five-pivot windows examined on pure random walks: ${windows}\n`);
console.log('pattern                        fires on   % of windows');
console.log('----------------------------   --------   ------------');
for (const [name, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
  console.log(`${name.padEnd(30)} ${String(n).padStart(8)}   ${((n / windows) * 100).toFixed(1).padStart(11)}%`);
}
console.log(`\nWindows matching AT LEAST ONE definition: ${windowsWithAny} / ${windows} = ${((windowsWithAny / windows) * 100).toFixed(1)}%`);
console.log('\nA definition that fires on a large share of RANDOM five-pivot sequences carries');
console.log('little information. The four broadening/triangle variants are pure inequality');
console.log('chains with no tolerance term, so a monotonic run of alternating extrema');
console.log('satisfies one of them almost by construction.');
