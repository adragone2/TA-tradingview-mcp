/**
 * Does the swing-anchored primary level beat the nearest level, out of sample?
 *
 * The rule in `src/core/level_display.js` was derived from ONE chart on ONE day.
 * On DLO the three levels nearest price were traded through 16.7%, 16.7% and 21.7%
 * of the last 60 bars while the swing-anchored resistance was traded through 0.0%.
 * That is a single-sample finding, and this repo has already had two of those pass
 * a noise floor and a trial count and then die on a holdout — `level_pressure` went
 * from +39.1 to +4.6, and `stage_plan`'s gate forward-tested negative.
 *
 * So the claim under test is narrow and falsifiable:
 *
 *   A level sitting on the last confirmed swing extreme is traded through LESS
 *   often than the level nearest to price.
 *
 * "Traded through" = the fraction of the last N bars whose high-low range spans the
 * level. A level price cuts across is not acting as a barrier. It is a description
 * of what already happened, NOT a forecast that the level will hold — that would be
 * the touch-count mistake again, and touch count is dead here.
 *
 * Reported per symbol and pooled, with the count of symbols where the sign REVERSES,
 * because a mean that hides a 50/50 split is the thing that fooled us before.
 *
 * Run:  node scripts/level-primary-holdout.js [--symbols A,B,C] [--window 60]
 */
import { loadRealBars } from './_real_bars.js';
import { findKeyLevels, findSwings, alternateSwings } from '../src/core/structure.js';
import { selectPrimary } from '../src/core/level_display.js';

const args = process.argv.slice(2);
const argVal = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const WINDOW = Number(argVal('--window', '60'));

/**
 * A holdout universe: NOT DLO, and deliberately mixed across sector, price and
 * volatility. Tuning on a mid-range 54%-vol payments name and testing on twenty
 * more like it would not be a holdout.
 */
const DEFAULT_SYMBOLS = [
  'NASDAQ:AAPL', 'NASDAQ:MSFT', 'NYSE:JPM', 'NYSE:XOM', 'NASDAQ:AMZN',
  'NYSE:JNJ', 'NASDAQ:TSLA', 'NYSE:WMT', 'NASDAQ:NVDA', 'NYSE:PG',
  'NYSE:BAC', 'NASDAQ:NFLX', 'NYSE:CVX', 'NASDAQ:COST', 'NYSE:KO',
  'NASDAQ:AMD', 'NYSE:DIS', 'NASDAQ:INTC', 'NYSE:PFE', 'NASDAQ:SBUX',
];
const SYMBOLS = argVal('--symbols', '').trim()
  ? argVal('--symbols', '').split(',').map((s) => s.trim()).filter(Boolean)
  : DEFAULT_SYMBOLS;

/** Fraction of the last `window` bars whose range spans `price`. */
function throughPct(bars, price, window) {
  const w = bars.slice(-window);
  if (!w.length) return null;
  const n = w.filter((b) => b.low <= price && b.high >= price).length;
  return (n / w.length) * 100;
}

const rows = [];
const failures = [];

console.log(`Swing-anchored vs nearest level — through-rate over the last ${WINDOW} bars`);
console.log(`Holdout universe: ${SYMBOLS.length} symbols, none of them DLO\n`);

/**
 * `actual_resolution` is the resolution the harness VERIFIED the chart was on, which
 * is the whole reason it exists — three earlier scripts inherited 60-minute bars and
 * recorded the results as daily. Reading back the timeframe we asked for would defeat
 * the check; this run printed "undefined" until that was noticed.
 */
const { sets, failures: loadFailures, actual_resolution: timeframe } = await loadRealBars(SYMBOLS, {
  timeframe: '1D', count: 400, skipNewest: 1,
});
failures.push(...(loadFailures || []));
console.log(`Loaded ${sets.length} symbols at ${timeframe}\n`);

for (const { symbol, bars } of sets) {
  try {
    const price = bars[bars.length - 1].close;
    const found = findKeyLevels(bars, {
      lookback: 5, tolerance_pct: 0.75, min_touches: 2, max_levels: 40, max_distance_pct: 25,
    });
    if (found.levels.length < 4) { failures.push({ symbol, why: 'too few levels' }); continue; }

    const alt = alternateSwings(findSwings(bars, { lookback: 5 }));
    const lastHigh = [...alt].reverse().find((s) => s.kind === 'high');
    const lastLow = [...alt].reverse().find((s) => s.kind === 'low');

    const sel = selectPrimary(found.levels, {
      price, swing_high: lastHigh?.price ?? null, swing_low: lastLow?.price ?? null,
    });
    // Only anchored picks test the claim; an unanchored fallback IS the nearest level.
    const anchored = sel.shown.filter((l) => l.anchored);
    if (!anchored.length) { failures.push({ symbol, why: 'no side anchored to a swing' }); continue; }

    const above = found.levels.filter((l) => l.price >= price).sort((a, b) => a.price - b.price);
    const below = found.levels.filter((l) => l.price < price).sort((a, b) => b.price - a.price);

    for (const lvl of anchored) {
      const nearest = (lvl.side === 'resistance' ? above : below)[0];
      if (!nearest || nearest.price === lvl.price) continue;   // nothing to compare against
      const primary = throughPct(bars, lvl.price, WINDOW);
      const near = throughPct(bars, nearest.price, WINDOW);
      rows.push({
        symbol, side: lvl.side,
        primary_price: lvl.price, primary_through: primary,
        nearest_price: nearest.price, nearest_through: near,
        edge: near - primary,          // positive = the anchored level is the better barrier
      });
    }
  } catch (e) {
    failures.push({ symbol, why: e.message });
  }
}

/* ------------------------------- results ------------------------------- */

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const edges = rows.map((r) => r.edge);
const wins = edges.filter((e) => e > 0).length;
const losses = edges.filter((e) => e < 0).length;
const ties = edges.filter((e) => e === 0).length;

console.log('symbol      side         primary  through%   nearest  through%     edge');
for (const r of rows) {
  console.log(
    `${r.symbol.split(':')[1].padEnd(8)}  ${r.side.padEnd(10)}  `
    + `${r.primary_price.toFixed(2).padStart(8)}  ${r.primary_through.toFixed(1).padStart(7)}  `
    + `${r.nearest_price.toFixed(2).padStart(8)}  ${r.nearest_through.toFixed(1).padStart(7)}  `
    + `${(r.edge >= 0 ? '+' : '') + r.edge.toFixed(1)}`.padStart(9),
  );
}

const m = mean(edges);
/**
 * A paired sign test rather than a t-test: the pairs are one per symbol-side, the
 * distribution of through-rates is bounded and skewed, and what matters is whether
 * the sign is consistent — not the size of a mean that a couple of symbols could set.
 */
const n = wins + losses;
const p = n ? 2 * (1 - normalCdf(Math.abs(wins - n / 2) / Math.sqrt(n / 4))) : null;

console.log(`\nn = ${rows.length} comparisons across ${new Set(rows.map((r) => r.symbol)).size} symbols`);
console.log(`mean edge      ${m == null ? 'n/a' : `${m >= 0 ? '+' : ''}${m.toFixed(2)} points`} `
  + '(positive = the swing-anchored level is crossed LESS)');
console.log(`sign           ${wins} favour anchored, ${losses} favour nearest, ${ties} tied`);
console.log(`two-sided p    ${p == null ? 'n/a' : p.toFixed(4)} (sign test)`);
console.log(`REVERSALS      ${losses} of ${n} comparisons go the OTHER way`);

const verdict = m == null ? 'NO DATA'
  : (p != null && p < 0.05 && m > 0) ? 'REPLICATES — the anchored level is crossed less, and the sign is consistent'
    : m > 0 ? 'DIRECTIONALLY RIGHT BUT NOT SIGNIFICANT — treat the rule as a display convention, not a finding'
      : 'DOES NOT REPLICATE — the DLO result was sample-specific';
console.log(`\nVERDICT        ${verdict}`);

if (failures.length) {
  console.log(`\nskipped ${failures.length}: ${failures.map((f) => `${f.symbol} (${f.why})`).join(', ')}`);
}
console.log('\nNOTE: through-rate is a DESCRIPTION of what price already did to the level. It is not '
  + 'evidence the level will hold next time — that is the touch-count mistake, and touch count is dead here.');

/** Abramowitz & Stegun 26.2.17 — enough precision for a sign test. */
function normalCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-z * z / 2);
  const prob = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - prob : prob;
}
