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
  const data = await import('../src/core/data.js');
  const chart = await import('../src/core/chart.js');
  let restore = null;
  try {
    const state = await chart.getState();
    restore = state?.symbol || null;
    const sets = [];
    for (const sym of SYMBOLS) {
      try {
        await chart.setSymbol({ symbol: sym });
        const series = await data.getOhlcv({ count: BARS + 20, summary: false });
        // Drop the partial daily bar: its high/low are not a day's.
        const bars = normalizeBars(series);
        sets.push(bars.slice(0, -1));
        process.stderr.write(`  ${sym}: ${bars.length} bars\n`);
      } catch (err) {
        process.stderr.write(`  ${sym}: ${err.message}\n`);
      }
    }
    real = measure(sets, `real data (${sets.length} symbols x ~${BARS} daily bars)`);
  } catch (err) {
    process.stderr.write(`\nChart unavailable, running the noise arm only: ${err.message}\n`);
  } finally {
    // A scan drives the chart and must restore it.
    if (restore) { try { await chart.setSymbol({ symbol: restore }); } catch {} }
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
  console.log(lift > 5
    ? '  -> Real data beats the null. Worth keeping, still needs a trial count.'
    : '  -> NO EDGE over noise. Resolution direction is close to a coin flip in both arms,'
      + '\n     so report the STATE and refuse to predict the break.');
} else {
  console.log('\n  Real-data arm not run (no chart). The noise figure alone cannot settle the resolution claim.');
}
console.log();
