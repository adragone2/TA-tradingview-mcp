#!/usr/bin/env node
/**
 * How much does Shannon's stage gate actually filter?
 *
 * Wyckoff's `classifyPhase` fires on 100% of random walks because it NEVER
 * abstains — a phase is therefore descriptive, not evidence. Shannon's stages
 * are defined by explicit moving-average clauses that CAN disagree, so this
 * measures the thing that matters: how often does the classifier abstain, and
 * how often does it hand back one of the two TRADEABLE stages on pure noise?
 *
 * A gate that opens on most random walks is not a gate.
 *
 *   node scripts/stage-noise.js
 *   node scripts/stage-noise.js --noise    # skip the real-data arm
 */
import { classifyStage, MA_SETS } from '../src/core/stages.js';
import { normalizeBars } from '../src/core/structure.js';
import { classifyPhase } from '../src/core/wyckoff.js';
import { randomWalk, barsFromPath } from '../src/core/synthetic.js';

const NOISE_ONLY = process.argv.includes('--noise');
const tfIdx = process.argv.indexOf('--timeframe');
/** Explicit, never inherited. See scripts/_real_bars.js for why. */
const TIMEFRAME = tfIdx === -1 ? '1D' : String(process.argv[tfIdx + 1]);
const WALKS = 200;
const BARS = 300;
const SYMBOLS = ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'JPM', 'XOM', 'JNJ', 'PG', 'HD', 'PNC'];

function tally(barSets, label) {
  const counts = { abstain: 0, 1: 0, 2: 0, 3: 0, 4: 0 };
  let wyckoffNamed = 0;
  let n = 0;

  for (const bars of barSets) {
    if (!bars || bars.length < 60) continue;
    n += 1;
    const r = classifyStage(bars, { periods: MA_SETS.daily });
    if (!r.available) { n -= 1; continue; }
    if (r.stage === null) counts.abstain += 1; else counts[r.stage] += 1;

    // The contrast that makes the point: does the Wyckoff classifier ever
    // decline to name a phase on the same bars?
    const w = classifyPhase(bars);
    if (w.phase && w.phase !== 'unclear') wyckoffNamed += 1;
  }

  const pct = (x) => (n ? Math.round((x / n) * 1000) / 10 : null);
  const tradeable = counts[2] + counts[4];
  return {
    label, n,
    abstain_pct: pct(counts.abstain),
    stage_1_pct: pct(counts[1]),
    stage_2_pct: pct(counts[2]),
    stage_3_pct: pct(counts[3]),
    stage_4_pct: pct(counts[4]),
    tradeable_pct: pct(tradeable),
    wyckoff_named_pct: pct(wyckoffNamed),
  };
}

const noiseSets = [];
for (let seed = 1; seed <= WALKS; seed += 1) {
  noiseSets.push(normalizeBars(barsFromPath(randomWalk({ n: BARS, vol: 0.015, seed }))));
}
const noise = tally(noiseSets, `random walk (${WALKS} x ${BARS} bars)`);

let real = null;
if (!NOISE_ONLY) {
  // loadRealBars requires an EXPLICIT timeframe. An earlier version of this
  // script called setSymbol without setTimeframe, inherited the chart's
  // 60-minute resolution, and recorded the result as "daily bars".
  const { loadRealBars, describeBatch } = await import('./_real_bars.js');
  try {
    const b = await loadRealBars(SYMBOLS, { timeframe: TIMEFRAME, count: BARS + 20 });
    process.stderr.write(`
${describeBatch(b, 'real data')}
`);
    real = tally(b.sets.map((x) => x.bars), `real data (${b.sets.length} symbols @ ${b.actual_resolution})`);
  } catch (err) {
    process.stderr.write(`
Chart unavailable, noise arm only: ${err.message}
`);
  }
}

const row = (r) => `  ${String(r.abstain_pct).padStart(7)}%  ${String(r.stage_1_pct).padStart(5)}%  `
  + `${String(r.stage_2_pct).padStart(5)}%  ${String(r.stage_3_pct).padStart(5)}%  ${String(r.stage_4_pct).padStart(5)}%  `
  + `${String(r.tradeable_pct).padStart(9)}%  ${String(r.wyckoff_named_pct).padStart(8)}%   ${r.label}`;

console.log('\nShannon stage classifier — does the gate filter anything?\n');
console.log('  abstain   St1    St2    St3    St4  tradeable  wyckoff*   sample');
console.log(row(noise));
if (real) console.log(row(real));
console.log('\n  * wyckoff = share where classifyPhase named a phase on the SAME bars.');

console.log('\nWhat this says:');
console.log(`  Shannon's clauses abstain on ${noise.abstain_pct}% of random walks and open the gate on ${noise.tradeable_pct}%.`);
console.log(`  classifyPhase named a phase on ${noise.wyckoff_named_pct}% of the same walks — it never abstains, which is`);
console.log('  why a Wyckoff phase is descriptive and a Shannon stage can act as a filter.');
if (real) {
  const lift = (real.tradeable_pct ?? 0) - (noise.tradeable_pct ?? 0);
  console.log(`\n  Real data opens the gate on ${real.tradeable_pct}% vs ${noise.tradeable_pct}% on noise `
    + `(${lift > 0 ? '+' : ''}${Math.round(lift * 10) / 10} points).`);
  console.log(lift > 10
    ? '  -> The gate is selective AND finds more structure in real data than in noise.'
    : '  -> The gate is selective, but it finds no more tradeable structure in real data than in noise.'
      + '\n     Treat it as a CONSISTENCY filter (are the averages aligned?), not as evidence of trend.');
}
console.log('\n  Either way: the stage is a description of price versus three averages. It forecasts nothing.\n');
