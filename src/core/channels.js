/**
 * Parallel channels — the shape our pattern detector could not see.
 *
 * ── Why this exists ──
 *
 * The user looked at CSD and said "I see a bearish channel that you haven't
 * detected". They were right, and for two separate reasons:
 *
 *   1. There is no channel in STRUCTURAL_PATTERNS. The trendline detector
 *      classifies a shape by whether its boundaries CONVERGE (wedge, triangle)
 *      or DIVERGE (broadening). A channel does neither — its boundaries are
 *      PARALLEL — so it fell straight through the middle and was emitted as
 *      nothing at all. `rectangle` is the horizontal special case only.
 *
 *   2. The channel on CSD is clearest at swing lookback 2, and the detector
 *      only ever ran 3, 4, 5, 6 and 8. At lookback 3 the post-high window had
 *      two pivots a side — too few to fit anything.
 *
 * Measured on CSD: at a 30-bar window the pivot-high slope is -0.4941/bar and
 * the pivot-low slope -0.5135/bar, a ratio of 1.04. That is about as parallel
 * as real price gets, and three consecutive window lengths agreed.
 *
 * ── What a channel is here ──
 *
 * Boundaries fitted by least squares through the ACTUAL pivot highs and pivot
 * lows — never a slope extrapolated backwards from a current level, which is
 * the failure that put a CQTM boundary at 22.25 on a bar trading near 29.
 *
 * A channel requires:
 *   - at least `min_touches` pivots on EACH boundary (default 3)
 *   - both slopes the same sign
 *   - the slopes within `parallel_tolerance` of each other
 *
 * All pure.
 */

const round = (n, dp = 4) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10 ** dp) / 10 ** dp);

/**
 * Thresholds, and why they are where they are.
 *
 * The first version of this detector used only "parallel slopes, 3 touches a
 * side" and fired on **93.5% of random walks** — 64% of them even passing a
 * three-window stability check. A shape you can fit to nine walks in ten is a
 * property of the fitting, not of the price.
 *
 * Two tests fixed it, both cheap:
 *
 *   - CONTAINMENT. A real channel holds the price action. Noise fitted with
 *     two lines does not.
 *   - FIT QUALITY (R²). A boundary through genuine touches explains its
 *     pivots; a boundary through scattered noise does not.
 *
 * See scripts/channel-noise.js for the measurement, and CHANNEL_NOISE_BASELINE
 * for where it landed.
 */
export const CHANNEL_DEFAULTS = {
  windows: [25, 30, 40, 50, 60, 75],
  lookbacks: [2, 3],
  min_touches: 3,
  parallel_tolerance: 0.25,  // |slopeLow/slopeHigh - 1| must be below this
  flat_slope_pct: 0.05,      // per-bar % below which a slope counts as flat
  min_r2: 0.85,              // least-squares fit quality on EACH boundary — the real discriminator
  max_width_atr: 6,          // a channel wider than this contains everything and says nothing
  // FLAT boundaries only: max pivot scatter about the line, in bar ranges.
  // R2 cannot judge a horizontal boundary (see channelIn), so scatter is the
  // gate instead. CALIBRATED, not guessed: at 1.0 the flat path fired on 28.5%
  // of random walks on its own and took the detector from 32% to 58.5%. At 0.30
  // horizontal contributes 1.5% and the total returns to 33.5%.
  flat_max_rms_atr: 0.30,
};


/**
 * Where the trade is, on a channel.
 *
 * Two distinct trades, and conflating them is how people lose money on
 * channels. WITH the channel is the continuation trade — fade the boundary,
 * because while price stays inside, the boundaries are where it turns. THROUGH
 * the boundary is the reversal trade, and it only exists once a bar CLOSES
 * outside.
 *
 * Both are reported with their invalidation, and neither is a recommendation.
 */
function entryFor(direction, upperNow, lowerNow, px, atr) {
  const height = upperNow - lowerNow;
  const pos = height > 0 ? (px - lowerNow) / height : null;
  const pad = atr * 0.5;

  if (direction === 'descending') {
    return {
      with_channel: {
        side: 'short', trigger: round(upperNow),
        note: 'Fade the upper boundary while price stays inside. This is the continuation trade.',
        stop: round(upperNow + pad), target: round(lowerNow),
        ready: pos != null && pos > 0.75,
      },
      against_channel: {
        side: 'long', trigger: round(upperNow),
        note: 'Only on a CLOSE above the upper boundary. Until then the channel is intact and this does not exist.',
        stop: round(lowerNow), confirmed: false,
      },
      primary: pos != null && pos > 0.75 ? 'with_channel' : 'wait',
      why: pos != null && pos > 0.75
        ? 'Price is at the upper boundary of a descending channel — the continuation entry is live.'
        : 'Price is not at a boundary. A channel entry is a boundary trade; mid-channel there is nothing to do.',
    };
  }
  if (direction === 'ascending') {
    return {
      with_channel: {
        side: 'long', trigger: round(lowerNow),
        note: 'Buy the lower boundary while price stays inside. This is the continuation trade.',
        stop: round(lowerNow - pad), target: round(upperNow),
        ready: pos != null && pos < 0.25,
      },
      against_channel: {
        side: 'short', trigger: round(lowerNow),
        note: 'Only on a CLOSE below the lower boundary.',
        stop: round(upperNow), confirmed: false,
      },
      primary: pos != null && pos < 0.25 ? 'with_channel' : 'wait',
      why: pos != null && pos < 0.25
        ? 'Price is at the lower boundary of an ascending channel — the continuation entry is live.'
        : 'Price is not at a boundary. Mid-channel there is nothing to do.',
    };
  }
  return {
    with_channel: { side: 'range', trigger: null, note: 'Horizontal channel — buy the lower boundary, sell the upper.' },
    against_channel: { side: 'either', trigger: null, note: 'A close outside either boundary ends the range.' },
    primary: 'wait',
    why: 'Horizontal channel: the edges are the trade, the middle is not.',
  };
}

/** Least-squares fit. Returns slope and intercept in index space. */
function fit(points) {
  const n = points.length;
  if (n < 2) return null;
  const mx = points.reduce((a, p) => a + p.x, 0) / n;
  const my = points.reduce((a, p) => a + p.y, 0) / n;
  let num = 0, den = 0;
  for (const p of points) { num += (p.x - mx) * (p.y - my); den += (p.x - mx) ** 2; }
  if (!den) return null;
  const m = num / den;
  return { m, b: my - m * mx };
}

/** Pivot highs and lows inside a segment, by simple fractal rule. */
function pivots(seg, lookback) {
  const highs = [], lows = [];
  for (let i = lookback; i < seg.length - lookback; i++) {
    const w = seg.slice(i - lookback, i + lookback + 1);
    if (seg[i].high === Math.max(...w.map((b) => b.high))) highs.push({ x: i, y: seg[i].high, i });
    if (seg[i].low === Math.min(...w.map((b) => b.low))) lows.push({ x: i, y: seg[i].low, i });
  }
  return { highs, lows };
}

/**
 * Look for a channel in one window at one sensitivity.
 *
 * Returns null when the pivots do not support one — which is most of the time,
 * and is the correct answer.
 */
export function channelIn(bars, { window = 30, lookback = 2, opts = CHANNEL_DEFAULTS } = {}) {
  if (!Array.isArray(bars) || bars.length < window) return null;
  const seg = bars.slice(-window);
  const { highs, lows } = pivots(seg, lookback);
  if (highs.length < opts.min_touches || lows.length < opts.min_touches) return null;

  const fh = fit(highs), fl = fit(lows);
  if (!fh || !fl) return null;

  // PARALLEL. The obvious test — same sign, ratio near 1 — is correct for a
  // sloping channel and completely wrong for a flat one. On a constructed
  // horizontal channel the two fitted slopes came out +0.0012 and -0.00004
  // per bar: both flat to any eye, but opposite in sign and a ratio of -0.03,
  // so the sign gate and the ratio gate each rejected it. `horizontal_channel`
  // and its entry block were unreachable.
  //
  // A ratio is the wrong instrument near zero. When BOTH slopes are flat in
  // percent-of-price terms they are parallel by definition, so the ratio is
  // skipped and the flatness itself is the test.
  const pxRef = seg[seg.length - 1].close;
  const pctPerBar = (m) => (pxRef > 0 ? Math.abs(m / pxRef) * 100 : Infinity);
  const bothFlat = pctPerBar(fh.m) < opts.flat_slope_pct && pctPerBar(fl.m) < opts.flat_slope_pct;
  const ratio = fh.m !== 0 ? fl.m / fh.m : null;
  if (!bothFlat) {
    if (fh.m * fl.m <= 0) return null;
    if (ratio == null || Math.abs(ratio - 1) > opts.parallel_tolerance) return null;
  }

  // FIT QUALITY is the real discriminator, and it is measured on the
  // least-squares lines BEFORE they are turned into envelopes. Measured on
  // CSD: R² 0.92/0.87 at the 25-bar window. Measured on random walks at the
  // 40-bar window: 0.06/0.08. That gap is what separates a channel from two
  // lines dragged through noise.
  const r2 = (pts, f) => {
    const my = pts.reduce((a, p) => a + p.y, 0) / pts.length;
    let ssTot = 0, ssRes = 0;
    for (const p of pts) { ssTot += (p.y - my) ** 2; ssRes += (p.y - (f.m * p.x + f.b)) ** 2; }
    return ssTot === 0 ? 1 : 1 - ssRes / ssTot;
  };
  const r2Upper = r2(highs, fh), r2Lower = r2(lows, fl);

  // R² is the wrong gate for a FLAT boundary, and not marginally so. It asks
  // "how much of the variance does the line explain?" — but a horizontal
  // boundary's pivots have almost no variance to explain, so a textbook flat
  // channel scores near zero and gets rejected for being exactly what it is.
  //
  // When both slopes are flat, the question is not "does the line explain the
  // scatter" but "is the scatter small". Measured against typical bar range so
  // it scales across instruments, same as the width gate below.
  const barRanges = seg.map((b) => b.high - b.low);
  const atrSeg = barRanges.reduce((a, b) => a + b, 0) / barRanges.length;
  const rms = (pts, f) => Math.sqrt(
    pts.reduce((a, p) => a + (p.y - (f.m * p.x + f.b)) ** 2, 0) / pts.length,
  );
  const rmsUpper = rms(highs, fh), rmsLower = rms(lows, fl);

  if (bothFlat) {
    // A flat boundary must be TIGHT: its pivots scatter less than one typical
    // bar range around the line. Loose scatter is a range, not a channel.
    if (!(atrSeg > 0)) return null;
    if (rmsUpper / atrSeg > opts.flat_max_rms_atr || rmsLower / atrSeg > opts.flat_max_rms_atr) return null;
  } else if (r2Upper < opts.min_r2 || r2Lower < opts.min_r2) {
    return null;
  }

  // ENVELOPE, not a centre line. A least-squares fit through the pivot highs
  // runs THROUGH them — about half sit above it — so using it as the upper
  // boundary put containment at 0.76 on a channel whose fits were excellent.
  // A channel boundary touches the extremes. Take one common slope (the two
  // are already known parallel by the ratio test) and translate each line out
  // until it touches its most extreme pivot.
  const slope = (fh.m + fl.m) / 2;
  const bUpper = Math.max(...highs.map((p) => p.y - slope * p.x));
  const bLower = Math.min(...lows.map((p) => p.y - slope * p.x));

  const last = seg.length - 1;
  const upperNow = slope * last + bUpper;
  const lowerNow = slope * last + bLower;
  if (!(upperNow > lowerNow)) return null;

  // Containment is now near-certain by construction, so it is REPORTED rather
  // than used as a gate — the gate is R², the parallel ratio, and width.
  let inside = 0;
  for (let i = 0; i < seg.length; i++) {
    if (seg[i].close <= slope * i + bUpper && seg[i].close >= slope * i + bLower) inside++;
  }
  const containment = inside / seg.length;

  // WIDTH. A channel wide enough to contain anything says nothing. Measured
  // against typical bar range, so it scales across instruments.
  const atr = atrSeg;
  const widthInAtr = atr > 0 ? (upperNow - lowerNow) / atr : Infinity;
  if (widthInAtr > opts.max_width_atr) return null;

  const px = seg[last].close;
  const midSlopePct = ((fh.m + fl.m) / 2 / px) * 100;
  const direction = Math.abs(midSlopePct) < opts.flat_slope_pct ? 'horizontal'
    : midSlopePct > 0 ? 'ascending' : 'descending';

  const height = upperNow - lowerNow;
  const posInChannel = height > 0 ? (px - lowerNow) / height : null;

  return {
    pattern: `${direction}_channel`,
    direction,
    // A channel is a CONTINUATION shape while price stays inside it, so the
    // bias follows the slope rather than the position within it.
    bias: direction === 'ascending' ? 'bullish' : direction === 'descending' ? 'bearish' : 'neutral',
    window, lookback,
    touches_upper: highs.length,
    touches_lower: lows.length,
    containment: round(containment, 3),
    r2_upper: round(r2Upper, 3),
    r2_lower: round(r2Lower, 3),
    // Reported for every channel, but only GATED on when the boundaries are
    // flat — where R2 is not a meaningful measure of fit.
    rms_upper_in_atr: round(atrSeg > 0 ? rmsUpper / atrSeg : null, 3),
    rms_lower_in_atr: round(atrSeg > 0 ? rmsLower / atrSeg : null, 3),
    fit_gated_on: bothFlat ? 'scatter (flat boundaries — R2 is undefined on a constant)' : 'r2',
    width_in_atr: round(widthInAtr, 2),
    slope_upper_per_bar: round(fh.m),
    slope_lower_per_bar: round(fl.m),
    slope_used: round(slope),
    slope_ratio: round(ratio, 3),
    parallel_by: bothFlat ? 'flatness' : 'slope_ratio',
    // Sort key for picking the best fit. A ratio is meaningless when both
    // slopes are flat, so flatness scores as perfectly parallel.
    parallel_deviation: round(bothFlat ? 0 : Math.abs(ratio - 1), 4),
    slope_pct_per_bar: round(midSlopePct, 4),
    upper_now: round(upperNow),
    lower_now: round(lowerNow),
    height: round(height),
    height_pct: round((height / px) * 100, 2),
    price: round(px),
    position_in_channel: round(posInChannel, 3),
    position_note: posInChannel == null ? null
      : posInChannel > 0.8 ? 'at the upper boundary'
      : posInChannel < 0.2 ? 'at the lower boundary'
      : 'mid-channel',
    // Endpoints for drawing, anchored to real pivot bars.
    from_index: bars.length - window,
    from_time: seg[0].time,
    to_time: seg[last].time,
    upper_start: round(bUpper),
    lower_start: round(bLower),
    break_levels: { above: round(upperNow), below: round(lowerNow) },
    entry: entryFor(direction, upperNow, lowerNow, px, atr),
  };
}

/**
 * Sweep windows and sensitivities, and report agreement.
 *
 * A channel visible at one window and one lookback is a fit. One that survives
 * several is a shape — the same discipline the pattern sensitivity sweep
 * applies, for the same reason.
 */
export function findChannels(bars, options = {}) {
  const opts = { ...CHANNEL_DEFAULTS, ...options };
  const hits = [];
  for (const window of opts.windows) {
    for (const lookback of opts.lookbacks) {
      const c = channelIn(bars, { window, lookback, opts });
      if (c) hits.push(c);
    }
  }
  if (!hits.length) {
    return {
      found: false, channels: [], best: null,
      note: 'No parallel channel across any window or sensitivity tested.',
      windows_tested: opts.windows.length * opts.lookbacks.length,
      windows: opts.windows, lookbacks: opts.lookbacks,
      noise_baseline: CHANNEL_NOISE_BASELINE,
    };
  }

  const byDirection = hits.reduce((m, c) => ({ ...m, [c.direction]: (m[c.direction] || 0) + 1 }), {});
  const dominant = Object.entries(byDirection).sort((a, b) => b[1] - a[1])[0][0];
  const agreeing = hits.filter((c) => c.direction === dominant);
  // Prefer the most parallel fit among the agreeing windows.
  const best = agreeing.slice().sort((a, b) => a.parallel_deviation - b.parallel_deviation)[0];

  return {
    found: true,
    channels: hits,
    best,
    direction: dominant,
    windows_agreeing: agreeing.length,
    windows_tested: opts.windows.length * opts.lookbacks.length,
    stable: agreeing.length >= 3,
    stability_note: agreeing.length >= 3
      ? `${agreeing.length} of ${opts.windows.length * opts.lookbacks.length} window/sensitivity combinations found a ${dominant} channel. That is a shape, not a fit.`
      : `Only ${agreeing.length} combination(s) found a ${dominant} channel. Treat it as a candidate — a channel visible at one window is a fit.`,
    mixed_directions: Object.keys(byDirection).length > 1 ? byDirection : null,
    noise_baseline: CHANNEL_NOISE_BASELINE,
    method: 'Boundaries fitted by least squares through ACTUAL pivot highs and lows, never extrapolated backwards from a current level.',
  };
}

/**
 * How often this fires on data with no pattern in it.
 *
 * Populated by scripts/channel-noise.js. A detector without this number is
 * exactly what the rest of this repo exists to avoid.
 */
export const CHANNEL_NOISE_BASELINE = {
  measured: true,
  script: 'scripts/channel-noise.js',
  walks: 200,
  bars_per_walk: 200,
  any_channel_pct: 33.5,
  stable_channel_pct: 12.0,
  by_direction: { descending: 40, ascending: 24, horizontal: 3 },
  // The flat-boundary path was calibrated against this number rather than
  // eyeballed. Its first version used a scatter gate of 1.0 bar range and took
  // the detector from 32.0% to 58.5% on noise, horizontal alone accounting for
  // 28.5%. Tightening to 0.30 put it back to 33.5% while still finding a
  // constructed horizontal channel.
  flat_path_cost: { gate_1_0: 58.5, gate_0_30: 33.5, without_flat_path: 32.0 },
  before_containment_and_r2: { any_channel_pct: 93.5, stable_channel_pct: 64.0 },
  note:
    'A channel is found on about a THIRD of random walks, and one in nine walks '
    + 'produces a "stable" one across three or more windows. So a single detection '
    + 'is weak evidence — quote the stability count, and treat an unstable channel '
    + 'as a fit rather than a shape. The pre-gate figures show why the R2 and width '
    + 'tests exist: without them the detector fired on 93.5% of noise.',
  context: {
    structural_patterns_pct: 68,
    lmw_definitions_pct: 43.4,
    vcp_pct: 0,
    pennants_pct: 0,
  },
};
