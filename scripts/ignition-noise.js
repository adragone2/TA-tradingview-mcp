/**
 * Does the 1-2-3's top-third clause earn its place?
 *
 * The shape is a structural continuation pattern, and that family already fires
 * on 64.5% of random walks. The only thing that could make this one worth having
 * is its geometry: the resting bar confined to the top third of the igniting
 * bar. So the measurement is a COMPARISON, not a single number —
 *
 *   with the clause     vs   without it (resting bar anywhere in the range)
 *
 * If the two rates are close, the clause is decoration and the detector is just
 * another 68% shape. If it cuts the rate hard, it is doing real work.
 *
 * A third arm drops the "must ignite" rule, which is the condition easiest to
 * leave out when implementing from a description.
 *
 *   node scripts/ignition-noise.js [--walks 200]
 */
import { randomWalk, barsFromPath } from '../src/core/synthetic.js';
import { findOneTwoThree } from '../src/core/ignition.js';

const args = process.argv.slice(2);
const i = args.indexOf('--walks');
const WALKS = i >= 0 ? Number(args[i + 1]) : 200;
const BARS = 200;

/**
 * randomWalk returns a PRICE PATH, not bars. Feeding it straight to a detector
 * gives a meaningless 0% and reads as a wonderfully selective detector — a
 * mistake made three times in this repo already.
 */
const walk = (s) => barsFromPath(randomWalk({ n: BARS, seed: 41000 + s }), { noise: 0.006, seed: 42000 + s });

const ARMS = {
  'full rule (top third + must ignite)': {},
  'without the top-third clause': { rest_zone_pct: 100 },
  'without the must-ignite rule': { max_prior_run: 3 },
  'neither clause': { rest_zone_pct: 100, max_prior_run: 3 },
};

console.log(`1-2-3 noise floor over ${WALKS} random walks of ${BARS} bars\n`);

const results = {};
for (const [label, opts] of Object.entries(ARMS)) {
  let walksWithAny = 0;
  let total = 0;
  for (let s = 0; s < WALKS; s++) {
    const hits = findOneTwoThree(walk(s), opts);
    if (hits.length) walksWithAny++;
    total += hits.length;
  }
  const pct = (walksWithAny / WALKS) * 100;
  results[label] = {
    walks_with_at_least_one: walksWithAny,
    pct_of_walks: Math.round(pct * 10) / 10,
    per_walk: Math.round((total / WALKS) * 100) / 100,
  };
  console.log(
    label.padEnd(38),
    `${String(results[label].pct_of_walks).padStart(5)}% of walks`,
    `  ${String(results[label].per_walk).padStart(5)} per walk`,
  );
}

const full = results['full rule (top third + must ignite)'].pct_of_walks;
const noZone = results['without the top-third clause'].pct_of_walks;
console.log(`\nstructural family baseline for comparison: 64.5% of random walks`);
console.log(`top-third clause changes the rate ${noZone.toFixed(1)}% -> ${full.toFixed(1)}%`);
console.log(full < 20
  ? `\nVERDICT: worth building. ${full}% is well under the 68% structural floor.`
  : full < 40
    ? `\nVERDICT: marginal. ${full}% is better than the 68% family rate but not selective.`
    : `\nVERDICT: DO NOT BUILD. ${full}% is not meaningfully better than the family it belongs to.`);
