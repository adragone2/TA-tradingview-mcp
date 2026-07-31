/**
 * How often does the channel detector fire on data with no pattern in it?
 *
 * Every detector in this repo carries this number. A channel that appears on
 * most random walks is not a finding, it is a property of the fitting.
 */
import { randomWalk, barsFromPath } from '../src/core/synthetic.js';
import { findChannels } from '../src/core/channels.js';

const WALKS = 200, BARS = 200;
let any = 0, stable = 0;
const byDir = {};
for (let w = 0; w < WALKS; w++) {
  const bars = barsFromPath(randomWalk({ n: BARS, seed: 7000 + w }), { noise: 0.006, seed: 8000 + w });
  const r = findChannels(bars);
  if (r.found) { any++; byDir[r.direction] = (byDir[r.direction] || 0) + 1; if (r.stable) stable++; }
}
console.log(`walks: ${WALKS} of ${BARS} bars`);
console.log(`  ANY channel found:    ${any} (${(any / WALKS * 100).toFixed(1)}%)`);
console.log(`  STABLE (>=3 windows): ${stable} (${(stable / WALKS * 100).toFixed(1)}%)`);
console.log(`  by direction:`, byDir);
console.log('\nFor comparison: structural patterns fire on 64.5% of random walks;');
console.log('the LMW definitions match 37.9% of five-pivot windows; VCP fires on 0%.');
