/**
 * The noise floor for hold_health: how many Minervini violations does a
 * position in PURE NOISE rack up? 200 random walks with lognormal volume,
 * 300 bars, "entered" 20 bars before the end — the same shape as a swing
 * position under review. Headless: no chart, no lock.
 *
 * The point of the number: these clauses describe pullbacks, and every walk
 * pulls back. A tally without this floor beside it reads like evidence.
 */
import { randomWalkWithGaps } from '../src/core/synthetic.js';
import { holdHealth } from '../src/core/hold_health.js';

const WALKS = 200;
const BARS = 300;
const ENTRY_BARS_AGO = 20;

const perClause = {};
let totalViolations = 0;
let totalConfirmations = 0;
const tallyDist = {};

for (let s = 0; s < WALKS; s++) {
  const { bars } = randomWalkWithGaps({ n: BARS, seed: 7000 + s, volume_mode: 'lognormal' });
  const h = holdHealth(bars, { entry_bars_ago: ENTRY_BARS_AGO });
  if (!h.available) { console.error('walk', s, 'unavailable:', h.why); continue; }
  totalViolations += h.violation_count;
  totalConfirmations += h.confirmation_count;
  tallyDist[h.violation_count] = (tallyDist[h.violation_count] ?? 0) + 1;
  for (const v of h.violations) {
    if (v.fired) perClause[v.key] = (perClause[v.key] ?? 0) + 1;
  }
}

const pct = (x) => Math.round((x / WALKS) * 1000) / 10;
const atLeast = (k) => pct(Object.entries(tallyDist).reduce((s, [n, c]) => s + (Number(n) >= k ? c : 0), 0));

console.log(`walks ${WALKS}, bars ${BARS}, entry ${ENTRY_BARS_AGO} bars back`);
console.log(`mean violations per walk: ${(totalViolations / WALKS).toFixed(2)}`);
console.log(`mean confirmations per walk: ${(totalConfirmations / WALKS).toFixed(2)}`);
console.log(`walks with >=1 violation: ${atLeast(1)}%  >=3: ${atLeast(3)}%  >=5: ${atLeast(5)}%`);
console.log('per clause fire rate:');
for (const [k, c] of Object.entries(perClause).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(36)} ${pct(c)}%`);
}
console.log('\nPaste into HOLD_HEALTH_NOISE_BASELINE in src/core/hold_health.js.');
