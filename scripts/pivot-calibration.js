#!/usr/bin/env node
/**
 * The lookback -> bandwidth mapping in `src/core/pivots.js`, re-measured.
 *
 * The pivot backbone replaced a FRACTAL swing detector (extreme of a 2L+1 bar
 * window) with KERNEL extrema (turns of a Nadaraya-Watson smooth, mapped back to
 * real bar highs and lows). Those two have different density knobs — `lookback`
 * in bars either side, `bandwidth` in bars of smoothing — and they are not the
 * same quantity. `BANDWIDTH_PER_LOOKBACK` is the conversion, and it was measured
 * rather than chosen: pick the bandwidth whose pivot COUNT matches what the
 * fractal produced at each lookback.
 *
 * Why a constant and not cross-validation: `kernel.optimalBandwidth` picks h by
 * leave-one-out CV, which on these series lands near 0.6 — finer than fractal
 * lookback 2 — and depends only on the DATA. Under CV, `lookback` would stop
 * doing anything at all, and `assessment.js` calls a pattern STABLE when it
 * survives 3 of a 5-lookback sweep. Every pattern would survive 5 of 5.
 *
 * Synthetic only. No chart, no network.
 *
 *   node scripts/pivot-calibration.js [--walks 40]
 */
import { randomWalk, barsFromPath } from '../src/core/synthetic.js';
import { findKernelPivots } from '../src/core/kernel.js';
import { optimalBandwidth } from '../src/core/kernel.js';
import { findPivots, bandwidthForLookback, BANDWIDTH_PER_LOOKBACK } from '../src/core/pivots.js';

const args = process.argv.slice(2);
const wi = args.indexOf('--walks');
const WALKS = wi >= 0 ? Number(args[wi + 1]) : 40;

const walk = (n, s) => barsFromPath(randomWalk({ n, seed: 7000 + s }), { noise: 0.006, seed: 8000 + s });

/**
 * The fractal detector as it stood before the swap, kept here and NOWHERE else.
 *
 * A calibration against a moving target measures nothing, so the reference
 * implementation is frozen in the script that uses it rather than imported from
 * a module that has since changed. This is a copy on purpose — the one case
 * where the repo's no-second-copy rule does not apply, because the point of it
 * is to be the OLD behaviour.
 */
function fractalSwings(bars, { lookback = 5 } = {}) {
  const L = Math.max(1, Math.floor(lookback));
  const swings = [];
  for (let i = L; i < bars.length - L; i += 1) {
    const bar = bars[i];
    let isHigh = true; let isLow = true;
    for (let j = i - L; j < i; j += 1) {
      if (bars[j].high >= bar.high) isHigh = false;
      if (bars[j].low <= bar.low) isLow = false;
    }
    for (let j = i + 1; j <= i + L; j += 1) {
      if (bars[j].high > bar.high) isHigh = false;
      if (bars[j].low < bar.low) isLow = false;
    }
    if (isHigh) swings.push({ index: i, kind: 'high' });
    if (isLow) swings.push({ index: i, kind: 'low' });
  }
  return swings;
}

const LOOKBACKS = [2, 3, 4, 5, 6, 8, 10];
const BANDWIDTHS = [0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, 12];

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

for (const n of [200, 400]) {
  const series = Array.from({ length: WALKS }, (_, s) => walk(n, s));

  const fractal = Object.fromEntries(LOOKBACKS.map((L) => [
    L, mean(series.map((b) => fractalSwings(b, { lookback: L }).length)),
  ]));
  const kernel = BANDWIDTHS.map((h) => [
    h, mean(series.map((b) => findKernelPivots(b, { bandwidth: h, map_window: 1 }).pivots.length)),
  ]);

  /** The bandwidth whose count matches a fractal count, linearly interpolated. */
  const matchingBandwidth = (target) => {
    for (let i = 1; i < kernel.length; i += 1) {
      const [h0, c0] = kernel[i - 1];
      const [h1, c1] = kernel[i];
      if (c0 >= target && target >= c1) return h0 + (h1 - h0) * ((c0 - target) / (c0 - c1));
    }
    return null;
  };

  console.log(`\n=== ${WALKS} random walks of ${n} bars ===`);
  console.log('lookback   fractal   matching h   ratio h/lookback   h from the constant   kernel count there');
  for (const L of LOOKBACKS) {
    const target = fractal[L];
    const h = matchingBandwidth(target);
    const hConst = bandwidthForLookback(L);
    const atConst = mean(series.map((b) => findPivots(b, { lookback: L }).length));
    console.log(
      `${String(L).padStart(5)}   ${target.toFixed(2).padStart(9)}   `
      + `${(h == null ? 'n/a' : h.toFixed(2)).padStart(10)}   `
      + `${(h == null ? 'n/a' : (h / L).toFixed(3)).padStart(16)}   `
      + `${hConst.toFixed(2).padStart(19)}   ${atConst.toFixed(2).padStart(18)}`,
    );
  }
  console.log(`\nBANDWIDTH_PER_LOOKBACK is ${BANDWIDTH_PER_LOOKBACK}. Read the ratio column: if it has drifted`);
  console.log('away from that on both arms, the constant is stale and every level, pattern and leg');
  console.log('in the repo moves with it.');

  const cv = mean(series.slice(0, 10).map((b) => optimalBandwidth(b.map((x) => x.close))));
  console.log(`Cross-validation would pick h = ${cv.toFixed(3)} — finer than fractal lookback 2, and`);
  console.log('independent of what the caller asked for. That is why the bandwidth follows `lookback`.');
}

/* ────────────────────────────────────────────────────────────────────────────
 * The count is matched. The POSITIONS are not, and this says how far apart.
 * ──────────────────────────────────────────────────────────────────────────── */
console.log('\n\n=== how far the pivots MOVED, lookback 5, 400 bars ===');
{
  const series = Array.from({ length: WALKS }, (_, s) => walk(400, s));
  let exact = 0; let total = 0; const dists = [];
  for (const bars of series) {
    const f = fractalSwings(bars, { lookback: 5 });
    const k = findPivots(bars, { lookback: 5 });
    for (const p of k) {
      total += 1;
      const same = f.filter((x) => x.kind === p.kind).map((x) => Math.abs(x.index - p.index));
      const d = same.length ? Math.min(...same) : null;
      if (d === 0) exact += 1;
      if (d != null) dists.push(d);
    }
  }
  dists.sort((a, b) => a - b);
  console.log(`${total} kernel pivots; ${exact} (${((exact / total) * 100).toFixed(1)}%) land on a bar the`);
  console.log('fractal detector also called a pivot of the same kind.');
  console.log(`Distance to the nearest same-kind fractal pivot: median ${dists[Math.floor(dists.length / 2)]} bars, `
    + `p90 ${dists[Math.floor(dists.length * 0.9)]}, max ${dists[dists.length - 1]}.`);
  console.log('A high exact-match rate would mean the swap changed nothing. A low one is expected:');
  console.log('a kernel extremum sits where the smoothed curve turns, a fractal one where a 2L+1');
  console.log('window happened to peak.');
}
