/**
 * The REAL-DATA ARM for gaps.js and pip.js — the half of the measurement the
 * synthetic harness cannot run.
 *
 * Why this exists: a noise floor you cannot compare against real data is not a
 * noise floor. ignition.js fired on 5.9% of real charts against 22.5% of its
 * synthetic null — the null was broken, and only the real arm showed it. This
 * script runs the same probes the synthetic sweep runs, over real daily bars,
 * and prints both sides.
 *
 * It also measures the ONE free parameter the synthetic sweep could not pin:
 * the gap-day volume multiple (`gap_volume_multiple`). The generator guessed
 * 2.0; measured 2026-07-30 the real median was 1.21 across 303 gaps. The
 * script then re-runs the null AT the measured value on the SAME seeds as the
 * published table (7000+s — the x2.0 arm must reproduce GAP_NOISE_BASELINE
 * exactly, which is the check that the two runs are comparable). That re-run
 * is what turned exhaustion's 4.5–37.0% bracket into a floor.
 *
 * Results live in GAP_NOISE_BASELINE.real_arm and PIP_NOISE_BASELINE.real_arm.
 * If you re-run this and a class fires LESS on real bars than on the null,
 * the null is broken and the floors may not be quoted — update the constants
 * and say so.
 *
 * Drives the live chart (via loadRealBars, which takes the chart lock and
 * restores symbol + resolution). Do not run during a morning screen or an
 * active analysis.
 *
 * Run: node scripts/gaps-real-arm.js
 */
import { loadRealBars } from './_real_bars.js';
import { classifyGaps, GAP_NOISE_BASELINE } from '../src/core/gaps.js';
import { scanBullFlag, PIP_NOISE_BASELINE } from '../src/core/pip.js';
import { randomWalkWithGaps } from '../src/core/synthetic.js';

const SYMBOLS = ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'JPM', 'BAC', 'XOM', 'CVX',
  'JNJ', 'PFE', 'PG', 'KO', 'WMT', 'HD', 'CAT', 'BA', 'DIS', 'NFLX'];
const CLASSES = ['common', 'breakaway', 'runaway', 'exhaustion', 'pending', 'unclassified'];

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const median = (a) => {
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Same formula as tests/synthetic_gaps.test.js — ATR counts gaps, bar range does not. */
function atrOverRange(bars) {
  const tr = [], rg = [];
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i], p = bars[i - 1];
    tr.push(Math.max(b.high - b.low, Math.abs(b.high - p.close), Math.abs(b.low - p.close)));
    rg.push(b.high - b.low);
  }
  return mean(tr) / mean(rg);
}

// ---------------------------------------------------------------------------
// Arm 1: real bars.
// ---------------------------------------------------------------------------
const { sets, failures } = await loadRealBars(SYMBOLS, {
  timeframe: '1D', count: 420, skipNewest: 1, label: 'gaps-real-arm',
});
if (failures.length) console.log(`FAILED to load: ${failures.map((f) => `${f.symbol} (${f.error})`).join(', ')}`);

const per200 = Object.fromEntries(CLASSES.map((c) => [c, []]));
const symWith = Object.fromEntries(CLASSES.map((c) => [c, 0]));
const anyPer200 = [], volRatios = [], aors = [];
const pipRates = {};

for (const { symbol, bars } of sets) {
  if (bars.length < 100) { console.log(`  ${symbol}: only ${bars.length} bars, skipped`); continue; }
  const scale = 200 / bars.length;
  const gaps = classifyGaps(bars).gaps || [];
  anyPer200.push(gaps.length * scale);
  const counts = Object.fromEntries(CLASSES.map((c) => [c, 0]));
  for (const g of gaps) {
    const v = g.verdict ?? 'unclassified';
    counts[v] = (counts[v] || 0) + 1;
    if (Number.isFinite(g.volume_ratio)) volRatios.push(g.volume_ratio);
  }
  for (const c of CLASSES) {
    per200[c].push((counts[c] || 0) * scale);
    if (counts[c] > 0) symWith[c] += 1;
  }
  aors.push(atrOverRange(bars));
  for (const mapping of ['pip', 'rank']) {
    for (const T of [3, 5, 7]) {
      const key = `${mapping}${T}`;
      const r = scanBullFlag(bars, { mapping, min_fit: T, window: 20 });
      if (r.windows_scored) (pipRates[key] ||= []).push((100 * r.count) / r.windows_scored);
    }
  }
}

const n = aors.length;
console.log(`\n=== REAL ARM (${n} symbols, per-200-bar normalised) vs the published null ===`);
const syn = GAP_NOISE_BASELINE.by_class;
console.log(`any gap        real ${mean(anyPer200).toFixed(2)}/200 | null ${syn.any_gap.per_walk}`);
for (const c of CLASSES) {
  const nul = syn[c] ? `${syn[c].pct_of_walks}% ${syn[c].per_walk}` : 'n/a';
  console.log(`${c.padEnd(14)} real ${(100 * symWith[c] / n).toFixed(1)}% of symbols, ${mean(per200[c]).toFixed(2)}/200 | null ${nul}`);
}
const measuredMult = median(volRatios);
console.log(`\ngap-day volume multiple: median ${measuredMult.toFixed(2)} (n=${volRatios.length}; the generator's default is `
  + `${GAP_NOISE_BASELINE.generator_params.gap_volume_multiple})`);
console.log(`ATR/mean-range: mean ${mean(aors).toFixed(3)} (anchor 1.070; generator 1.068)`);
console.log('\nPIP bull-flag, % of windows meeting threshold (real | published null):');
const pn = PIP_NOISE_BASELINE.by_threshold.wang_chan_2007;
for (const T of [3, 5, 7]) {
  console.log(`  T=${T}  pip ${mean(pipRates[`pip${T}`]).toFixed(1)} | ${pn.pip[`T>=${T}.0`].windows_pct}`
    + `    rank ${mean(pipRates[`rank${T}`]).toFixed(1)} | ${pn.rank[`T>=${T}.0`].windows_pct}`);
}

// ---------------------------------------------------------------------------
// Arm 2: the null AT the measured volume multiple, on the published seeds.
// The x2.0 (default) run must reproduce GAP_NOISE_BASELINE exactly — that
// identity is the proof the two arms are comparable.
// ---------------------------------------------------------------------------
console.log('\n=== NULL at the measured multiple (same seeds as the published table) ===');
for (const mult of [GAP_NOISE_BASELINE.generator_params.gap_volume_multiple, Number(measuredMult.toFixed(2))]) {
  const tally = {}; const walksWith = {}; let any = 0;
  for (let s = 0; s < 200; s++) {
    const { bars } = randomWalkWithGaps({ n: 200, seed: 7000 + s, volume_mode: 'gap_elevated', gap_volume_multiple: mult });
    const gaps = classifyGaps(bars).gaps || [];
    any += gaps.length;
    const seen = new Set();
    for (const g of gaps) { const v = g.verdict ?? 'unclassified'; tally[v] = (tally[v] || 0) + 1; seen.add(v); }
    for (const v of seen) walksWith[v] = (walksWith[v] || 0) + 1;
  }
  console.log(`x${mult}: any ${(any / 200).toFixed(2)}/walk | `
    + CLASSES.map((v) => `${v} ${(100 * (walksWith[v] || 0) / 200).toFixed(1)}%/${((tally[v] || 0) / 200).toFixed(2)}`).join(' | '));
}
console.log('\nIf any class above fires LESS on real bars than on its null, the null is broken and the floor may not be quoted.');
process.exit(0);
