/**
 * Kernel-regression pivot detection, after Lo, Mamaysky & Wang (2000),
 * "Foundations of Technical Analysis", Journal of Finance 55(4).
 *
 * ── Why this exists ──
 *
 * On CSCO 1D (2026-07-27) the existing detector reported a falling wedge with
 * `converging: true`, width narrowing 17.18 -> 9.02. Measured between the
 * ACTUAL pivots it was 13.87 -> 14.08 — diverging. No wedge existed. The
 * convergence was a property of the detector's own fitted boundary lines, not
 * of the price.
 *
 * LMW's algorithm structurally cannot make that error, because of one step:
 *
 *   1. Smooth the prices with a Nadaraya-Watson kernel regression
 *   2. Find extrema on the SMOOTHED curve, by sign change of its derivative
 *   3. Map each one back to the actual high/low in the ORIGINAL bars nearby,
 *      and test the pattern against THOSE prices
 *
 * Step 3 is the part we were missing. Smoothing decides only WHERE TO LOOK;
 * every number the pattern test sees is a real price that really traded.
 *
 * ── The bandwidth is an open question, not a constant ──
 *
 * LMW select h by cross-validation and then use 0.3 x h*, calling it
 * "admittedly an ad hoc adjustment". Nekrasov's 2010 reproduction found that
 * 0.3 x h* "tends to detecting of too local extrema" and preferred h*. He also
 * found that two kernel-smoothing implementations at the SAME bandwidth gave
 * significantly different results — so this is not a settled recipe.
 *
 * Hence `bandwidth_multiplier` is a parameter with a measured default rather
 * than a magic number. See tests/kernel.test.js and the sweep in
 * scripts/bandwidth-sweep.js, which measure it against constructed truth and
 * against random walks using src/core/synthetic.js.
 *
 * All pure.
 */

/** Gaussian kernel. LMW use this one. */
function gaussian(z) {
  return Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI);
}

/**
 * Nadaraya-Watson kernel regression of `values` on their own index.
 *
 * Returns the smoothed series. Bandwidth is in units of bars.
 */
export function kernelSmooth(values, h) {
  if (!Array.isArray(values) || values.length === 0) return [];
  if (!(h > 0)) throw new Error(`Bandwidth must be positive, got ${h}.`);
  const n = values.length;
  const out = new Array(n);
  // Beyond ~4 bandwidths the Gaussian weight is under 1e-4 of the peak, so the
  // window is truncated. This turns an O(n^2) smooth into O(n*h) with no
  // visible change to the curve.
  const reach = Math.max(1, Math.ceil(4 * h));
  for (let t = 0; t < n; t++) {
    let num = 0, den = 0;
    const lo = Math.max(0, t - reach), hi = Math.min(n - 1, t + reach);
    for (let s = lo; s <= hi; s++) {
      const w = gaussian((t - s) / h);
      num += w * values[s];
      den += w;
    }
    out[t] = den > 0 ? num / den : values[t];
  }
  return out;
}

/**
 * Leave-one-out cross-validation score for a bandwidth. Lower is better.
 *
 * This is the h* that LMW then multiply by 0.3. Reported so callers can see
 * what the data itself prefers before any ad hoc adjustment.
 */
export function crossValidationScore(values, h) {
  const n = values.length;
  if (n < 3) return Infinity;
  let sse = 0;
  const reach = Math.max(1, Math.ceil(4 * h));
  for (let t = 0; t < n; t++) {
    let num = 0, den = 0;
    const lo = Math.max(0, t - reach), hi = Math.min(n - 1, t + reach);
    for (let s = lo; s <= hi; s++) {
      if (s === t) continue;                 // leave one out
      const w = gaussian((t - s) / h);
      num += w * values[s];
      den += w;
    }
    if (den > 0) sse += (values[t] - num / den) ** 2;
  }
  return sse / n;
}

/** The bandwidth minimising the CV score, searched over a geometric grid. */
export function optimalBandwidth(values, { min = 0.5, max = null, steps = 24 } = {}) {
  const n = values.length;
  const hi = max ?? Math.max(2, n / 6);
  if (!(hi > min)) return min;
  let best = min, bestScore = Infinity;
  for (let i = 0; i < steps; i++) {
    const h = min * Math.pow(hi / min, i / (steps - 1));
    const s = crossValidationScore(values, h);
    if (s < bestScore) { bestScore = s; best = h; }
  }
  return best;
}

/**
 * Find pivots the LMW way.
 *
 * Returns extrema whose `price` is a REAL high or low from the bars, never a
 * smoothed value. `smoothed_price` is kept alongside so the two can be
 * compared — a large gap between them means the smoothing is doing a lot of
 * work and the pivot is less trustworthy.
 *
 * Consecutive extrema are forced to alternate max/min. For a smooth function
 * that is automatic; after mapping back to real prices it occasionally is not,
 * and a run of two maxima would silently corrupt any E1..E5 pattern test.
 */
export function findKernelPivots(bars, {
  bandwidth = null,
  bandwidth_multiplier = 1.0,
  source = 'close',
  map_window = 1,
} = {}) {
  if (!Array.isArray(bars) || bars.length < 5) {
    return { pivots: [], bandwidth: null, note: 'Need at least 5 bars.' };
  }
  const values = bars.map((b) => (source === 'close' ? b.close : (b.high + b.low) / 2));

  const hStar = bandwidth ?? optimalBandwidth(values);
  const h = hStar * bandwidth_multiplier;
  const smooth = kernelSmooth(values, h);

  // Extrema by sign change of the derivative, exactly as LMW define it:
  // Sgn(m'(t)) != Sgn(m'(t+1)).
  const raw = [];
  for (let t = 1; t < smooth.length - 1; t++) {
    const dPrev = smooth[t] - smooth[t - 1];
    const dNext = smooth[t + 1] - smooth[t];
    if (dPrev > 0 && dNext <= 0) raw.push({ index: t, kind: 'high' });
    else if (dPrev < 0 && dNext >= 0) raw.push({ index: t, kind: 'low' });
  }

  // Map each smoothed extremum onto the real extreme nearby. THIS is the step
  // that keeps every reported price a price that actually traded.
  const mapped = raw.map((e) => {
    const lo = Math.max(0, e.index - map_window);
    const hi = Math.min(bars.length - 1, e.index + map_window);
    let bestIdx = e.index;
    let bestVal = e.kind === 'high' ? -Infinity : Infinity;
    for (let i = lo; i <= hi; i++) {
      const v = e.kind === 'high' ? bars[i].high : bars[i].low;
      if (e.kind === 'high' ? v > bestVal : v < bestVal) { bestVal = v; bestIdx = i; }
    }
    return {
      index: bestIdx,
      kind: e.kind,
      price: bestVal,
      time: bars[bestIdx].time,
      smoothed_price: Math.round(smooth[e.index] * 1e6) / 1e6,
      smoothed_index: e.index,
    };
  });

  // Enforce alternation. Where two of a kind land in a row, keep the more
  // extreme — that is the one the pattern definitions care about.
  const pivots = [];
  for (const p of mapped) {
    const last = pivots[pivots.length - 1];
    if (!last || last.kind !== p.kind) { pivots.push(p); continue; }
    const keepNew = p.kind === 'high' ? p.price > last.price : p.price < last.price;
    if (keepNew) pivots[pivots.length - 1] = p;
  }

  return {
    pivots,
    bandwidth: Math.round(h * 1e4) / 1e4,
    bandwidth_cv_optimal: Math.round(hStar * 1e4) / 1e4,
    bandwidth_multiplier,
    bars_used: bars.length,
    method: 'Extrema located on a Nadaraya-Watson smoothed curve, then mapped to the actual high/low in the original bars. '
      + 'Every price reported here traded.',
    ...(bandwidth_multiplier !== 1
      ? { bandwidth_note: `Cross-validation preferred h=${Math.round(hStar * 1e4) / 1e4}; this run used ${bandwidth_multiplier}x that. `
          + 'LMW use 0.3x and call it ad hoc; Nekrasov (2010) found 0.3x over-detects local extrema and preferred 1x.' }
      : {}),
  };
}

/**
 * Width between the upper and lower pivot envelopes at the start and end of a
 * pivot sequence — the converging/diverging test, measured on real prices.
 *
 * This is the check that would have caught the CSCO wedge. It takes no
 * fitted lines and has no opinion about slope; it compares the first
 * high/low pair to the last.
 */
export function pivotWidth(pivots) {
  const highs = pivots.filter((p) => p.kind === 'high');
  const lows = pivots.filter((p) => p.kind === 'low');
  if (highs.length < 2 || lows.length < 2) {
    return {
      verdict: 'indeterminate',
      highs: highs.length,
      lows: lows.length,
      note: `Only ${highs.length} pivot highs and ${lows.length} pivot lows. `
        + 'Two of each are the minimum for a boundary; below that no wedge or triangle claim can be supported.',
    };
  }
  const start = highs[0].price - lows[0].price;
  const end = highs[highs.length - 1].price - lows[lows.length - 1].price;
  const change = start === 0 ? 0 : ((end - start) / Math.abs(start)) * 100;
  return {
    verdict: end < start ? 'converging' : 'diverging',
    width_start: Math.round(start * 1e4) / 1e4,
    width_end: Math.round(end * 1e4) / 1e4,
    change_pct: Math.round(change * 100) / 100,
    highs: highs.length,
    lows: lows.length,
    note: 'Measured between actual pivot prices, not fitted boundary lines. A detector reporting the opposite of this '
      + 'is describing its own fit rather than the price.',
  };
}
