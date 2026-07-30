#!/usr/bin/env node
/**
 * Noise floor for `findTimeCorrections`, plus the one claim attached to it.
 *
 * Shannon says a time correction "often will be resolved in the direction of
 * the primary trend." That is a directional claim about a volatility state, and
 * this repo has been burned by exactly that shape before — every Crabel pattern
 * fires on 100% of random walks, and contraction-to-expansion shows LESS lift on
 * real data (76.4%) than on noise (80.2%).
 *
 * So two arms, both required:
 *   RANDOM WALK — how often does the detector fire at all, and how often does a
 *                 correction resolve with the prior trend by chance?
 *   REAL DATA   — the same two numbers off the live chart.
 *
 * A real-data figure that does not beat the random-walk figure means the claim
 * is arithmetic, not a tendency.
 *
 *   node scripts/time-correction-noise.js            # both arms
 *   node scripts/time-correction-noise.js --noise    # skip the chart
 */
import { findTimeCorrections, normalizeBars } from '../src/core/structure.js';
import { randomWalk, barsFromPath } from '../src/core/synthetic.js';

const NOISE_ONLY = process.argv.includes('--noise');
const tfIdx = process.argv.indexOf('--timeframe');
/** Explicit, never inherited. See scripts/_real_bars.js for why. */
const TIMEFRAME = tfIdx === -1 ? '1D' : String(process.argv[tfIdx + 1]);
const WALKS = 200;
const BARS = 300;

/** Same universe shape as the crabel real-data arm: 12 large caps, daily. */
const SYMBOLS = ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'JPM', 'XOM', 'JNJ', 'PG', 'HD', 'PNC'];

function measure(barSets, label) {
  let sets = 0; let withCorrection = 0; let corrections = 0;
  let resolved = 0; let withTrend = 0; let brokeInside = 0;
  const durations = [];

  for (const bars of barSets) {
    if (!bars || bars.length < 60) continue;
    sets += 1;
    const r = findTimeCorrections(bars);
    if (!r.available) continue;
    if (r.count > 0) withCorrection += 1;
    corrections += r.count;
    for (const c of r.corrections) {
      durations.push(c.bars);
      if (!c.resolution) continue;
      if (c.resolution.broke === 'still_inside') { brokeInside += 1; continue; }
      resolved += 1;
      if (c.resolution.with_prior_trend) withTrend += 1;
    }
  }

  const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
  return {
    label,
    sets,
    detection_rate_pct: pct(withCorrection, sets),
    mean_per_set: sets ? Math.round((corrections / sets) * 100) / 100 : 0,
    mean_duration_bars: durations.length
      ? Math.round((durations.reduce((a, b) => a + b, 0) / durations.length) * 10) / 10
      : null,
    resolved,
    still_inside: brokeInside,
    with_prior_trend: withTrend,
    with_prior_trend_pct: pct(withTrend, resolved),
  };
}

const noiseSets = [];
for (let seed = 1; seed <= WALKS; seed += 1) {
  noiseSets.push(normalizeBars(barsFromPath(randomWalk({ n: BARS, vol: 0.015, seed }))));
}
const noise = measure(noiseSets, `random walk (${WALKS} x ${BARS} bars)`);

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
    real = measure(b.sets.map((x) => x.bars), `real data (${b.sets.length} symbols @ ${b.actual_resolution})`);
  } catch (err) {
    process.stderr.write(`
Chart unavailable, noise arm only: ${err.message}
`);
  }
}

const row = (r) => `  ${String(r.detection_rate_pct).padStart(6)}%  ${String(r.mean_per_set).padStart(6)}  `
  + `${String(r.mean_duration_bars).padStart(6)}  ${String(r.resolved).padStart(5)}  ${String(r.with_prior_trend_pct).padStart(7)}%   ${r.label}`;

console.log('\nTime corrections (Shannon ch. 8) — detection rate and the resolution claim\n');
console.log('   fires   per-set  dur/bars  resolved  with-trend   sample');
console.log(row(noise));
if (real) console.log(row(real));

console.log('\nWhat this says:');
console.log(`  A horizontal, low-volatility stretch after a move appears on ${noise.detection_rate_pct}% of random walks.`);
console.log('  The detector is DESCRIPTIVE. It says "digesting", never "about to break".');
if (real) {
  const lift = (real.with_prior_trend_pct ?? 0) - (noise.with_prior_trend_pct ?? 0);
  console.log(`\n  Shannon's resolution claim, measured:`);
  console.log(`    real data  ${real.with_prior_trend_pct}% resolved with the prior trend (n=${real.resolved})`);
  console.log(`    noise      ${noise.with_prior_trend_pct}% (n=${noise.resolved})`);
  console.log(`    lift       ${lift > 0 ? '+' : ''}${Math.round(lift * 10) / 10} points`);
  // n=18 cannot settle anything against a 52.8% null, so the verdict is gated on
  // POWER rather than on the sign of the lift.
  const n1 = real.resolved; const n2 = noise.resolved;
  const p1 = (real.with_prior_trend_pct ?? 0) / 100; const p2 = (noise.with_prior_trend_pct ?? 0) / 100;
  const pp = (p1 * n1 + p2 * n2) / (n1 + n2);
  const se = Math.sqrt(pp * (1 - pp) * (1 / n1 + 1 / n2));
  const z = se > 0 ? Math.round(((p1 - p2) / se) * 100) / 100 : 0;
  console.log(`    z          ${z} (n=${n1} vs ${n2})`);
  if (n1 < 40 || Math.abs(z) < 1.96) {
    console.log(`  -> NOT SETTLED. ${n1} resolved corrections cannot distinguish ${real.with_prior_trend_pct}% from a`);
    console.log(`     ${noise.with_prior_trend_pct}% null (z = ${z}). At 60-minute this same arm came out BELOW the null,`);
    console.log('     so the sign is not stable across resolutions. Report the STATE and refuse to predict the');
    console.log('     break — because the claim is UNTESTED here, not because it is refuted.');
  } else if (lift > 5) {
    console.log('  -> Real data beats the null on an adequate sample. Needs an out-of-sample arm before use.');
  } else {
    console.log('  -> NO EDGE over noise on an adequate sample.');
  }
  console.log('\n  Real-data arm not run (no chart). The noise figure alone cannot settle the resolution claim.');
}
console.log();
