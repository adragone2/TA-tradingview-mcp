/**
 * Lo, Mamaysky & Wang's pattern definitions, implemented verbatim.
 *
 * These are transcribed from Definitions 1-5 of "Foundations of Technical
 * Analysis" (Journal of Finance, 2000). They are deliberately NOT a
 * replacement for src/core/patterns.js — they are a SECOND OPINION, derived
 * from a different pivot detector and a different rule set, so that agreement
 * means something and disagreement is visible.
 *
 * ── What the evidence actually says about these ──
 *
 * LMW found 7 of 10 patterns significant on NYSE/AMEX and all 10 on Nasdaq,
 * over 1962-1996. Nekrasov (2010) tried to reproduce that on 1995-2010 data
 * across DJ30, S&P 100, NASDAQ 100 and DAX and concluded "the results are not
 * anymore reproducible" — only RTOP survived at the CV-optimal bandwidth.
 *
 * He also observed that LMW's significance came from the TAILS of the return
 * distribution, not the body: QQ-plots showed good conformance through the
 * middle and divergence only in the first and last quantiles.
 *
 * So this module implements the canonical definitions faithfully and reports
 * that they did not replicate. Both facts belong next to any detection.
 *
 * All pure.
 */
import { findKernelPivots } from './kernel.js';

/**
 * The paper's tolerances. Named so they are arguable rather than buried.
 *
 * `double_min_separation` is 22 because Edwards & Magee require the two tops
 * of a double to be at least a month apart. Note that our own synthetic
 * `double_top` fixture puts its peaks ~20 bars apart, so LMW correctly REJECTS
 * it. That is the definition working, not a bug — do not lower this to 20 to
 * make a test go green.
 */
export const LMW_TOLERANCES = {
  hs_shoulder_pct: 1.5,        // E1,E5 and E2,E4 each within 1.5% of their average
  rectangle_pct: 0.75,         // tops within 0.75% of average; bottoms likewise
  double_pct: 1.5,             // the two tops/bottoms within 1.5% of their average
  double_min_separation: 22,   // trading days, following Edwards & Magee
};

/** LMW's window: l=35 trading days plus d=3 lag for out-of-sample returns. */
export const LMW_WINDOW = { l: 35, d: 3, total: 38 };

export const LMW_REPLICATION = {
  original: 'Lo, Mamaysky & Wang (2000): 7 of 10 patterns significant on NYSE/AMEX, all 10 on Nasdaq, 1962-1996.',
  reproduction: 'Nekrasov (2010) on 1995-2010 (DJ30, S&P100, NASDAQ100, DAX): "the results are not anymore reproducible". '
    + 'Only RTOP survived at the cross-validated bandwidth.',
  where_significance_came_from: 'In the original, the difference between conditional and unconditional return '
    + 'distributions was concentrated in the TAILS. The body of the distribution conformed well.',
  read_as: 'A detection here means the shape matches a canonical definition. It is not evidence of an edge — '
    + 'the one study that found an edge for these shapes did not replicate out of sample.',
};

/**
 * How often each definition fires on RANDOM data.
 *
 * Measured by scripts/lmw-permissiveness.js over 4,209 five-pivot windows
 * taken from 60 random walks of 200 bars, pivots from kernel regression at the
 * cross-validated bandwidth. Reproduce with:
 *
 *     node scripts/lmw-permissiveness.js
 *
 * This is the number that decides how to use this module. **43.4% of random
 * five-pivot windows match at least one definition.** These are not selective
 * detectors, and this module is therefore NOT registered as a scanner — it is
 * a second opinion whose DISAGREEMENT with src/core/patterns.js is the useful
 * signal.
 *
 * For comparison, our own structural detector reports 0.78 patterns per
 * 200-bar random walk. The academic definitions report roughly 50. Ours is far
 * more selective, which was not the expected result.
 *
 * The ordering is worth noting. The inequality-chain patterns (triangle,
 * broadening) are the MOST selective at ~2% each. The permissive ones are
 * rectangle at 13.6% and head-and-shoulders at ~9%, because their tolerance
 * terms (0.75% and 1.5% of an average) are easy to satisfy when pivots happen
 * to cluster.
 *
 * That last point casts a shadow over the one result that did replicate:
 * rectangle was the only pattern to survive in Nekrasov's reproduction, and
 * rectangle is also the definition that fires most often on noise. A pattern
 * that fires often yields a larger conditional sample and therefore more power
 * in a KS test — significance without an edge would look exactly like this.
 */
export const LMW_NOISE_PROFILE = {
  measured_on: '4209 five-pivot windows from 60 random walks of 200 bars',
  bandwidth_multiplier: 1.0,
  any_definition_pct: 43.4,
  by_pattern_pct: {
    rectangle_bottom: 13.6,
    rectangle_top: 13.6,
    inverse_head_and_shoulders: 9.4,
    head_and_shoulders: 9.2,
    triangle_top: 2.0,
    broadening_top: 1.9,
    broadening_bottom: 1.8,
    triangle_bottom: 1.8,
  },
  our_detector_for_comparison: '0.78 structural patterns per 200-bar random walk (src/core/patterns.js NOISE_BASELINE)',
  implication: 'Do not use these definitions as a screen. Use them as a second opinion: agreement adds little, '
    + 'disagreement with a selective detector is worth investigating.',
};

/** Are all values within `pct` of their own average? */
function withinPct(values, pct) {
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  if (avg === 0) return false;
  return values.every((v) => Math.abs((v - avg) / avg) * 100 <= pct);
}

/**
 * Test one window of exactly 5 consecutive alternating extrema against every
 * five-point definition. Returns the names that match — plural, because the
 * definitions are not mutually exclusive and pretending otherwise would hide
 * a real ambiguity.
 */
export function classifyFive(e, tol = LMW_TOLERANCES) {
  if (!Array.isArray(e) || e.length !== 5) return [];
  const [E1, E2, E3, E4, E5] = e.map((x) => x.price);
  const startsHigh = e[0].kind === 'high';
  const hits = [];

  // Definition 1 — head and shoulders.
  if (startsHigh && E3 > E1 && E3 > E5
      && withinPct([E1, E5], tol.hs_shoulder_pct) && withinPct([E2, E4], tol.hs_shoulder_pct)) {
    hits.push('head_and_shoulders');
  }
  if (!startsHigh && E3 < E1 && E3 < E5
      && withinPct([E1, E5], tol.hs_shoulder_pct) && withinPct([E2, E4], tol.hs_shoulder_pct)) {
    hits.push('inverse_head_and_shoulders');
  }

  // Definition 2 — broadening. Boundaries spread apart.
  if (startsHigh && E1 < E3 && E3 < E5 && E2 > E4) hits.push('broadening_top');
  if (!startsHigh && E1 > E3 && E3 > E5 && E2 < E4) hits.push('broadening_bottom');

  // Definition 3 — triangle. The exact mirror of broadening: boundaries close.
  if (startsHigh && E1 > E3 && E3 > E5 && E2 < E4) hits.push('triangle_top');
  if (!startsHigh && E1 < E3 && E3 < E5 && E2 > E4) hits.push('triangle_bottom');

  // Definition 4 — rectangle. Tops flat, bottoms flat, and they do not cross.
  const tops = startsHigh ? [E1, E3, E5] : [E2, E4];
  const bottoms = startsHigh ? [E2, E4] : [E1, E3, E5];
  if (withinPct(tops, tol.rectangle_pct) && withinPct(bottoms, tol.rectangle_pct)
      && Math.min(...tops) > Math.max(...bottoms)) {
    hits.push(startsHigh ? 'rectangle_top' : 'rectangle_bottom');
  }

  return hits;
}

/**
 * Definition 5 — double top and bottom.
 *
 * Structurally different from the others: it is not a fixed five-extremum
 * window. Starting from a local maximum E1, find the HIGHEST subsequent
 * maximum in the whole sample; the pair qualifies if they are within 1.5% and
 * at least 22 trading days apart.
 */
export function findDoubles(pivots, { tol = LMW_TOLERANCES, bar_index = (p) => p.index } = {}) {
  const out = [];
  for (let i = 0; i < pivots.length; i++) {
    const E1 = pivots[i];
    const later = pivots.slice(i + 1).filter((p) => p.kind === E1.kind);
    if (!later.length) continue;

    const partner = E1.kind === 'high'
      ? later.reduce((a, b) => (b.price > a.price ? b : a))
      : later.reduce((a, b) => (b.price < a.price ? b : a));

    const separation = bar_index(partner) - bar_index(E1);
    if (separation < tol.double_min_separation) continue;
    if (!withinPct([E1.price, partner.price], tol.double_pct)) continue;

    out.push({
      pattern: E1.kind === 'high' ? 'double_top' : 'double_bottom',
      first: E1,
      second: partner,
      separation_bars: separation,
      spread_pct: Math.round(Math.abs((partner.price - E1.price) / ((partner.price + E1.price) / 2)) * 1e4) / 1e2,
    });
  }
  // One double per starting extremum is enough; collapse repeats of the pair.
  const seen = new Set();
  return out.filter((d) => {
    const k = `${d.pattern}:${d.first.index}:${d.second.index}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * Run the LMW definitions over a bar series.
 *
 * `window` defaults to the paper's 38 bars (l=35 + d=3). Set `window: null` to
 * scan the whole series in one pass — useful for comparing against our own
 * detector, which is not windowed, but note that LMW deliberately restricted
 * the window because "if we fit a single kernel regression to the entire
 * dataset, many patterns of various durations may emerge, and without imposing
 * some additional structure it is virtually impossible to distinguish signal
 * from noise".
 */
export function detectLmwPatterns(bars, {
  window = LMW_WINDOW.total,
  bandwidth_multiplier = 1.0,
  tolerances = LMW_TOLERANCES,
} = {}) {
  if (!Array.isArray(bars) || bars.length < 10) {
    return { patterns: [], note: 'Need at least 10 bars.', replication: LMW_REPLICATION };
  }

  const found = [];
  const scan = (segment, offset) => {
    const { pivots } = findKernelPivots(segment, { bandwidth_multiplier });
    const shifted = pivots.map((p) => ({ ...p, index: p.index + offset }));

    for (let i = 0; i + 4 < shifted.length; i++) {
      const five = shifted.slice(i, i + 5);
      for (const name of classifyFive(five, tolerances)) {
        found.push({
          pattern: name,
          source: 'lmw',
          extrema: five.map((p) => ({ index: p.index, kind: p.kind, price: p.price, time: p.time })),
          from_index: five[0].index,
          to_index: five[4].index,
          from_time: five[0].time,
          to_time: five[4].time,
        });
      }
    }
    return shifted;
  };

  let allPivots;
  if (window && window < bars.length) {
    // Rolling windows, as the paper specifies.
    for (let start = 0; start + window <= bars.length; start++) {
      scan(bars.slice(start, start + window), start);
    }
    allPivots = findKernelPivots(bars, { bandwidth_multiplier }).pivots;
  } else {
    allPivots = scan(bars, 0);
  }

  // Doubles are defined over the whole sample, not a 38-bar window — the
  // 22-day separation requirement would not fit otherwise.
  const doubles = findDoubles(allPivots, { tol: tolerances }).map((d) => ({
    pattern: d.pattern,
    source: 'lmw',
    extrema: [d.first, d.second].map((p) => ({ index: p.index, kind: p.kind, price: p.price, time: p.time })),
    from_index: d.first.index,
    to_index: d.second.index,
    from_time: d.first.time,
    to_time: d.second.time,
    separation_bars: d.separation_bars,
    spread_pct: d.spread_pct,
  }));

  // Collapse identical detections found in overlapping windows.
  const seen = new Set();
  const patterns = [...found, ...doubles].filter((p) => {
    const k = `${p.pattern}:${p.from_index}:${p.to_index}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).sort((a, b) => a.from_index - b.from_index);

  return {
    patterns,
    count: patterns.length,
    pivots_found: allPivots.length,
    window: window || 'whole series',
    bandwidth_multiplier,
    tolerances,
    replication: LMW_REPLICATION,
    noise_profile: LMW_NOISE_PROFILE,
    method: 'Definitions 1-5 of Lo, Mamaysky & Wang (2000), tested against pivots located by kernel regression and '
      + 'read from actual bar highs and lows.',
    health_warning: `${LMW_NOISE_PROFILE.any_definition_pct}% of five-pivot windows drawn from PURE RANDOM WALKS match at `
      + 'least one of these definitions. Treat a detection here as "the shape is consistent with the textbook definition", '
      + 'never as a signal. Our own detector reports 0.78 patterns per random walk against roughly 50 for these.',
  };
}
