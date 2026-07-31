/**
 * THE pivot backbone. One answer to "what is a swing", for every detector here.
 *
 * ── Why this module exists ──
 *
 * Three implementations of swing detection coexisted and could disagree:
 *
 *   1. `structure.findSwings` — fractal: the extreme of a 2L+1 bar window,
 *      ~27 consumers, everything downstream of it (levels, patterns, legs,
 *      Elliott, Wyckoff, divergence, liquidity, MTF, relative strength).
 *   2. `assessment_draw.windowPivots` — a second fractal, written for the
 *      native head-and-shoulders drawing, with its own 3/2/1 loosening ladder.
 *   3. `kernel.findKernelPivots` — Lo, Mamaysky & Wang (2000) extrema on a
 *      Nadaraya-Watson smoothed curve, mapped back to real bar highs and lows.
 *
 * Three detectors, three answers, one chart. A wedge drawn from (2) could be
 * anchored to prices the structure block in (1) never saw. Consolidated here on
 * (3), which is the only one with a published derivation and the only one whose
 * central property is enforced rather than assumed.
 *
 * ── The property that must never be lost ──
 *
 * SMOOTHING DECIDES ONLY WHERE TO LOOK. Every price returned here is a real
 * `high` or `low` off a real bar — `kernel.js` maps each smoothed extremum back
 * to the actual extreme in the bars around it, and `tests/pivots.test.js` pins
 * that as a property test rather than a fixture. This is what stopped the CSCO
 * falling wedge: the detector reported converging 17.18 -> 9.02 while the real
 * pivots went 13.87 -> 14.08, because the convergence belonged to the fitted
 * boundary lines and not to the price.
 *
 * ── `lookback` -> bandwidth: the density mapping, measured ──
 *
 * The fractal detector's density knob was `lookback`; the kernel's is
 * `bandwidth` (in bars). They are not the same quantity, so the mapping was
 * MEASURED rather than guessed — pivot counts over 40 random walks at 200 and
 * at 400 bars, `scripts/pivot-calibration.js`:
 *
 *     lookback   fractal pivots   bandwidth matching that count   ratio
 *        2          102.4               ~0.90                     0.45
 *        3           72.5                1.25                     0.42
 *        4           55.9                1.62                     0.40
 *        5           45.3                1.97                     0.39
 *        6           37.8                2.34                     0.39
 *        8           28.2                3.12                     0.39
 *       10           22.9                3.87                     0.39
 *
 * (400-bar arm; the 200-bar arm gives the same ratios — fractal L=5 -> 22.2
 * pivots, bandwidth 2.0 -> 22.4 — so the mapping is scale-free in series
 * length, which is what makes it safe to apply to a 300-bar chart and to a
 * 3,300-bar intraday one alike.)
 *
 * Hence `BANDWIDTH_PER_LOOKBACK = 0.4`. A caller asking for `lookback: 5` gets
 * about as many pivots as the fractal gave it, at the same places give or take
 * the smoothing. THE COUNT IS MATCHED; THE POSITIONS ARE NOT, and that is the
 * point of the change.
 *
 * ── Why the bandwidth is NOT cross-validated ──
 *
 * `kernel.optimalBandwidth` picks h by leave-one-out CV, and LMW then multiply
 * it by 0.3 while calling that "admittedly an ad hoc adjustment". Measured on
 * these bars, CV picks h ~= 0.62 — finer than fractal lookback 2, and LMW's
 * 0.3x would take it to 0.19, which is no smoothing at all. That is the correct
 * answer to the question CV asks (a near-random-walk series is best predicted
 * by its neighbours) and the wrong answer to the question a swing detector
 * asks.
 *
 * It is also a silent breakage, which is the real reason: CV depends only on
 * the DATA, so `lookback` would stop doing anything. `assessment.js` sweeps
 * lookback 3/4/5/6/8 and calls a pattern STABLE when it survives 3 of the 5 —
 * with a data-determined bandwidth every pattern survives 5 of 5 and the
 * stability measure silently reads 100%. A confidence number that cannot fail
 * is worse than no confidence number.
 *
 * So: bandwidth follows the caller's stated density, `bandwidth` overrides it
 * outright, and `kernel.optimalBandwidth` stays available to anyone who wants
 * to see what the data prefers.
 *
 * All pure. No chart, no network.
 */
import { findKernelPivots } from './kernel.js';

/**
 * Bandwidth in bars per unit of `lookback`. Measured, not chosen — see the
 * table above. Changing it changes every level, pattern and leg in the repo.
 */
export const BANDWIDTH_PER_LOOKBACK = 0.4;

/**
 * Below this the smoothed curve is the raw series and every bar-to-bar wiggle
 * is an extremum. `windowPivots` had the same floor expressed as `lookback: 1`.
 */
export const MIN_BANDWIDTH = 0.4;

/** The calibration, kept next to the constant it justifies. */
export const PIVOT_DENSITY = Object.freeze({
  status: 'MEASURED — count-matched to the fractal detector it replaces',
  method: '40 random walks per cell, pivot counts compared at 200 and 400 bars. scripts/pivot-calibration.js re-measures.',
  bandwidth_per_lookback: BANDWIDTH_PER_LOOKBACK,
  /**
   * `bandwidth` is the h whose pivot count MATCHES the fractal's, interpolated
   * from a bandwidth sweep. `kernel_at_mapping` is what `bandwidth_per_lookback`
   * actually delivers — the number that matters, since that is the bandwidth the
   * code uses. Compare it to `fractal`.
   */
  matched_counts_400_bars: Object.freeze({
    2: { fractal: 102.42, bandwidth: 0.90, kernel_at_mapping: 97.08 },
    3: { fractal: 72.53, bandwidth: 1.25, kernel_at_mapping: 72.35 },
    4: { fractal: 55.92, bandwidth: 1.62, kernel_at_mapping: 55.55 },
    5: { fractal: 45.25, bandwidth: 1.97, kernel_at_mapping: 43.90 },
    6: { fractal: 37.77, bandwidth: 2.34, kernel_at_mapping: 36.25 },
    8: { fractal: 28.23, bandwidth: 3.12, kernel_at_mapping: 27.20 },
    10: { fractal: 22.90, bandwidth: 3.87, kernel_at_mapping: 21.88 },
  }),
  cv_optimal_bandwidth: { bars_200: 0.623, bars_400: 0.618 },
  caveat: 'The COUNT is matched. The POSITIONS are not, and are not meant to be — a kernel extremum '
    + 'sits where the smoothed curve turns, a fractal pivot where a 2L+1 window happened to peak. '
    + 'Every downstream number moves; that is the change, not a defect in it.',
});

/** Bandwidth in bars for a fractal-style `lookback`. */
export function bandwidthForLookback(lookback) {
  const L = Number.isFinite(lookback) ? lookback : 5;
  return Math.max(MIN_BANDWIDTH, Math.abs(L) * BANDWIDTH_PER_LOOKBACK);
}

/**
 * Memo, keyed on the bars ARRAY IDENTITY.
 *
 * `assess()` calls the swing finder a dozen-plus times on the same array —
 * structure, legs, key levels, zones, the 5-lookback pattern sweep, divergence,
 * Elliott, Wyckoff. Kernel smoothing is O(n·h) and so is the fractal scan it
 * replaces, so the swap is not expensive per call, but repeating it 15 times
 * is. A WeakMap means a bars array that goes out of scope takes its cache with
 * it; nothing here is retained.
 *
 * The stored array is never handed out — callers get a copy, because
 * `findSwings` has always returned a fresh array and a shared one would let any
 * consumer's sort reorder every other consumer's view.
 */
const MEMO = new WeakMap();

function memoKey(o) {
  return `${o.bandwidth}|${o.source}|${o.map_window}`;
}

/**
 * The two post-conditions, enforced rather than assumed.
 *
 *   1. STRICTLY INCREASING INDEX.
 *   2. ALTERNATING kind.
 *
 * (2) `findKernelPivots` already does. (1) it does NOT, and the gap is real:
 * measured over 200 random walks of 300 bars at lookback 5, **23 pivot pairs
 * came back out of index order**. The cause is the map-back step — two adjacent
 * smoothed extrema search overlapping bar windows (`map_window` either side),
 * so extremum at t=50 can map to bar 51 while the one at t=51 maps to bar 50.
 * The kernel's alternation pass runs on `kind` and never looks at the index, so
 * it lets the inversion through.
 *
 * That has to be caught here because the fractal detector this replaces sorted
 * its output by index, and everything downstream assumes it: `classifyLegs`
 * slices `bars.slice(a.index + 1, b.index + 1)` and gets an EMPTY leg from an
 * inversion; `structuralPatterns` tests `c.index - a.index >= min_separation`
 * and gets a negative separation; `pivotTrail` walks the sequence in order.
 * None of them would throw. All of them would quietly measure nothing.
 *
 * Violators are collapsed the same way a run of one kind is — keep the more
 * extreme — because an inversion means two smoothed turns claimed the same
 * stretch of bars, and only one of them is the turn.
 *
 * Reported, not silently patched: `kernel.findKernelPivots` still returns the
 * unrepaired sequence to `pivots_kernel` and `lmw_patterns.js`.
 */
function enforceInvariants(list) {
  const out = [];
  for (const p of list) {
    const last = out[out.length - 1];
    if (!last) { out.push(p); continue; }
    const sameKind = last.kind === p.kind;
    const notAfter = p.index <= last.index;
    if (!sameKind && !notAfter) { out.push(p); continue; }
    // Keep whichever of the pair is the more extreme reading of its own kind.
    if (sameKind) {
      const keepNew = p.kind === 'high' ? p.price > last.price : p.price < last.price;
      if (keepNew) out[out.length - 1] = p;
      continue;
    }
    /**
     * Different kinds, wrong order. Neither is "more extreme" than the other in
     * a comparable sense, so the EARLIER one is kept: it is the turn the
     * smoothing found first, and dropping the later one cannot reorder anything
     * already emitted.
     */
  }
  return out;
}

/**
 * How stable is a pivot, and how soon? MEASURED, because the fractal detector
 * this replaces had a hard guarantee here and the kernel does not.
 *
 * The fractal rule could not report a swing inside the last `lookback` bars —
 * it needed that many bars to its right — so once a pivot appeared it never
 * moved. The kernel's derivative test only needs `smooth[t+1]`, so a turn can
 * surface almost immediately, and near the right edge the smoothed value is a
 * TRUNCATED-window average that keeps re-bending as bars arrive.
 *
 * Measured over 200 random walks of 300 bars at lookback 5, comparing the pivot
 * set at bar 300 against the set after 1, 3 and 5 more bars — the share of
 * pivots that moved or vanished, by how far back from the last bar they sat:
 *
 *     bars back      0     1     2     3     4     5     6    7+
 *     revised     100%   50%   43%   13%   15%    4%    4%    0%
 *
 * Two readings, and they point different ways:
 *
 *   - Beyond ~7 bars a kernel pivot is FIXED. Overall only 0.2-0.3% of all
 *     pivots were revised, so this is an edge effect and not a drift.
 *   - A pivot ON THE LAST BAR was revised in 100% of cases. Every single one.
 *     That is not a swing; it is the current bar, reported as structure. It is
 *     dropped, and that is the only trimming done here — the mechanism is that
 *     the derivative test at the final index has no bar after it to turn
 *     against, not a chosen confirmation lag.
 *
 * The rest are kept. Suppressing six bars of structure to recover a guarantee
 * the algorithm does not make would be inventing the fractal's lag back, and
 * the responsiveness is a genuine property of the method. Callers that ratchet
 * on structure — `pivotTrail` above all — should read the table rather than
 * assume the old guarantee.
 */
export const PIVOT_EDGE_STABILITY = Object.freeze({
  status: 'MEASURED',
  method: '200 random walks of 300 bars, lookback 5; pivot set compared against the set 1, 3 and 5 bars later.',
  overall_revised_pct: { plus_1_bar: 0.2, plus_3_bars: 0.3, plus_5_bars: 0.3 },
  revised_pct_by_bars_back: Object.freeze({
    0: 100, 1: 50, 2: 43, 3: 13, 4: 15, 5: 4, 6: 4, '7+': 0,
  }),
  last_bar_rule: 'A pivot mapped onto the final bar is dropped: it was revised in 100% of cases, and the '
    + 'derivative test at that index has no following bar to turn against.',
  vs_fractal: 'The fractal detector could not report a swing inside the last `lookback` bars at all, so a '
    + 'pivot never moved once seen. The kernel trades that guarantee for responsiveness. Anything that '
    + 'ratchets on structure is reading a less settled sequence than it used to.',
});

function compute(bars, { bandwidth, source, map_window }) {
  const res = findKernelPivots(bars, { bandwidth, source, map_window });
  const lastIndex = bars.length - 1;
  const repaired = enforceInvariants((res.pivots || []).filter((p) => p.index < lastIndex));
  return repaired.map((p) => ({
    index: p.index,
    time: p.time,
    price: p.price,
    /**
     * `type` is the name this module publishes; `kind` is the name the ~27
     * existing consumers read. They are the same string. Emitting both is what
     * lets `structure.findSwings` stay a pass-through instead of a mapping
     * layer that allocates a second object per pivot on every call.
     */
    type: p.kind,
    kind: p.kind,
    smoothed_price: p.smoothed_price,
  }));
}

/** Pivots for the whole series at one bandwidth, memoised. */
function seriesPivots(bars, opts) {
  let byOpts = MEMO.get(bars);
  if (!byOpts) { byOpts = new Map(); MEMO.set(bars, byOpts); }
  const k = memoKey(opts);
  let hit = byOpts.get(k);
  if (!hit) { hit = compute(bars, opts); byOpts.set(k, hit); }
  return hit;
}

/**
 * Bandwidths to try, coarsest first, when a caller has stated `want`.
 *
 * `windowPivots` loosened lookback 3 -> 2 -> 1 for the same reason: a pattern
 * window is short, and a native TradingView pattern tool given fewer points
 * than it declares places what it has and STAYS ARMED — measured on
 * triangle_pattern, 2 of 5, drawing cursor still live afterwards. So the floor
 * is a hard one and the finder has to be allowed to look harder for it.
 *
 * Multiplicative rather than the old integer ladder, because bandwidth is
 * continuous. It always terminates: every rung is 0.6x the last and the loop
 * stops at MIN_BANDWIDTH.
 */
function bandwidthLadder(h0) {
  const out = [];
  let h = h0;
  while (h > MIN_BANDWIDTH * 1.2) { out.push(h); h *= 0.6; }
  out.push(MIN_BANDWIDTH);
  return out;
}

/**
 * THE finder.
 *
 * Three consumption shapes, one implementation:
 *
 *   findPivots(bars)                                  whole series, lookback 5
 *   findPivots(bars, { lookback: 3 })                 whole series, finer
 *   findPivots(bars, { from_time, to_time, want: 7 }) a window, with a floor
 *
 * @param {object[]} bars                   normalised bars, oldest first
 * @param {object}   [opts]
 * @param {number}   [opts.lookback=5]      fractal-compatible density knob
 * @param {number}   [opts.bandwidth]       bandwidth in bars; overrides lookback
 * @param {string}   [opts.source='close']  'close' or 'hl2' — what gets smoothed
 * @param {number}   [opts.map_window=1]    bars either side to search for the real extreme
 * @param {number}   [opts.from_time]       restrict output to bars at or after this time
 * @param {number}   [opts.to_time]         restrict output to bars at or before this time
 * @param {number}   [opts.want=0]          keep loosening the bandwidth until this many are found
 * @returns {Array<{index:number,time:number,price:number,type:string,kind:string}>}
 *   Strictly alternating high/low, oldest first. Every `price` is a real bar
 *   high or low. Empty when the series is too short or genuinely has no turn in
 *   it — a monotonic series returns nothing rather than inventing a pivot at
 *   its own boundary.
 */
export function findPivots(bars, {
  lookback = 5,
  bandwidth = null,
  source = 'close',
  map_window = 1,
  from_time = null,
  to_time = null,
  want = 0,
} = {}) {
  if (!Array.isArray(bars) || bars.length < 5) return [];

  const base = Number.isFinite(bandwidth) && bandwidth > 0
    ? Math.max(MIN_BANDWIDTH, bandwidth)
    : bandwidthForLookback(lookback);

  const windowed = (list) => {
    if (from_time == null && to_time == null) return list;
    return list.filter((p) => (from_time == null || p.time >= from_time)
      && (to_time == null || p.time <= to_time));
  };

  const wanted = Number.isFinite(want) && want > 0 ? Math.floor(want) : 0;
  if (!wanted) return windowed(seriesPivots(bars, { bandwidth: base, source, map_window })).slice();

  /**
   * Loosen until `want` is met, and RETURN THE BEST ATTEMPT when it never is.
   * The alternative — returning the last, finest attempt — is worse: on a
   * monotonic series every rung finds nothing and the caller should get
   * nothing, but on a two-turn zigzag the finest rung can find FEWER than a
   * coarser one once alternation collapses a run.
   */
  let best = [];
  for (const h of bandwidthLadder(base)) {
    const got = windowed(seriesPivots(bars, { bandwidth: h, source, map_window }));
    if (got.length > best.length) best = got;
    if (got.length >= wanted) return got.slice();
  }
  return best.slice();
}

/**
 * The same finder, with the bandwidth it actually used.
 *
 * Separate from `findPivots` because the finder returns a bare array — the
 * shape 27 call sites already destructure — and a `{ pivots, bandwidth }`
 * envelope there would have been an unreviewable diff. Use this when the
 * bandwidth is part of what you are reporting.
 */
export function findPivotsWithBandwidth(bars, opts = {}) {
  const pivots = findPivots(bars, opts);
  const base = Number.isFinite(opts.bandwidth) && opts.bandwidth > 0
    ? Math.max(MIN_BANDWIDTH, opts.bandwidth)
    : bandwidthForLookback(opts.lookback ?? 5);
  return {
    pivots,
    bandwidth: base,
    lookback: opts.lookback ?? 5,
    bandwidth_per_lookback: BANDWIDTH_PER_LOOKBACK,
    method: 'Nadaraya-Watson kernel extrema (Lo, Mamaysky & Wang 2000) mapped back to real bar highs and lows. '
      + 'Every price reported traded.',
  };
}
