/**
 * Scaling between timeframes — and measuring whether the scaling law holds.
 *
 * Two quantities scale DIFFERENTLY when you move a method from one timeframe to
 * another, and conflating them is how "the same setup on a faster chart" quietly
 * becomes a different strategy at a different horizon.
 *
 *   LOOKBACKS scale LINEARLY.      A 65-bar average on 30-minute bars spans the
 *                                  same calendar time as a 195-bar average on
 *                                  10-minute bars. Both are 5 trading days.
 *                                  (Shannon 2008, fig. 10.4 — his confirmation
 *                                  column is built on exactly this identity.)
 *
 *   VOLATILITY scales as SQRT(t).  A 1.5-point stop on 5-minute bars becomes
 *                                  1.5 x sqrt(60/5) = 5.2 on hourly. Applies to
 *                                  ranges, stops and targets alike.
 *                                  (Grimes / Waverly Advisors 2013, slides 5-6.)
 *
 * Both are checked against their own sources' arithmetic in the tests, so a
 * regression here fails loudly rather than producing plausible numbers.
 *
 * The sqrt law is the RANDOM-WALK law: variance accumulates linearly in time
 * only when increments are independent. So the realised exponent is itself a
 * measurement — `scalingExponent` returns it, and a reading away from 0.5 is
 * autocorrelation, which is the same quantity the horizon doctrine rests on.
 * That makes the reversal/continuation boundary measurable on OUR data instead
 * of imported from a 1993 paper.
 *
 * All pure.
 */

/**
 * Minutes per bar. Daily and above use SESSION minutes, not calendar minutes —
 * a US equity day is 390 minutes of trading, and Shannon's table only balances
 * under that convention (65 x 30 = 1950 = 5 x 390).
 */
export const SESSION_MINUTES = 390;
export const WEEK_MINUTES = SESSION_MINUTES * 5;
export const MONTH_MINUTES = SESSION_MINUTES * 21;

/** Minutes spanned by one bar of `resolution`, or null if unparseable. */
export function barMinutes(resolution) {
  const r = String(resolution ?? '').trim().toUpperCase();
  if (r === '') return null;
  if (/^\d+$/.test(r)) return Number(r);
  const m = r.match(/^(\d*)\s*([SDWM])$/);
  if (!m) return null;
  const n = m[1] === '' ? 1 : Number(m[1]);
  if (m[2] === 'S') return n / 60;
  if (m[2] === 'D') return n * SESSION_MINUTES;
  if (m[2] === 'W') return n * WEEK_MINUTES;
  return n * MONTH_MINUTES;
}

/**
 * Translate a method from one timeframe to another.
 *
 * `lookback_bars` and `price_distance` are optional; pass whichever you are
 * actually moving. The ratio guidance is Grimes's: below 3 the second timeframe
 * adds little information, above 5 it starts omitting it.
 */
export function scaleTimeframe({ from, to, lookback_bars = null, price_distance = null } = {}) {
  const a = barMinutes(from);
  const b = barMinutes(to);
  if (!(a > 0) || !(b > 0)) {
    return { available: false, note: `Could not parse resolutions "${from}" -> "${to}".` };
  }

  const ratio = b / a;                       // how much longer one target bar is
  const lookbackFactor = a / b;              // linear: bars needed to span the same time
  const volatilityFactor = Math.sqrt(ratio); // sqrt: one bar's expected move

  const out = {
    available: true,
    from, to,
    from_minutes: a, to_minutes: b,
    timeframe_ratio: round(ratio, 4),
    lookback_factor: round(lookbackFactor, 4),
    volatility_factor: round(volatilityFactor, 4),
    laws: {
      lookback: 'LINEAR in the timeframe ratio — a lookback is a count of bars covering a span of time.',
      volatility: 'SQRT of the timeframe ratio — variance accumulates linearly in time, so deviation goes as its root.',
      why_they_differ: 'Scaling a stop linearly is the common error: it makes the stop several times too wide '
        + 'and quietly changes the strategy into a different one.',
    },
    /**
     * The guidance is on the SPREAD between the two views, so it is symmetric:
     * daily-to-hourly and hourly-to-daily are the same 6.5x apart. Using the
     * signed ratio reported 0.15 for daily-to-hourly and called it "below 3",
     * which inverted the advice.
     */
    timeframe_spread: round(Math.max(ratio, 1 / ratio), 4),
    ratio_guidance: (() => {
      const spread = Math.max(ratio, 1 / ratio);
      const s = round(spread, 2);
      if (spread >= 3 && spread <= 5) return `Spread ${s}x is in the useful 3-5 band.`;
      if (spread < 3) return `Spread ${s}x is below 3 — the second view adds little the first does not already show.`;
      return `Spread ${s}x is above 5 — these two views may omit what happens between them; consider an intermediate timeframe.`;
    })(),
    source: 'Lookback: Shannon (2008) fig. 10.4. Volatility: Grimes / Waverly Advisors (2013) slides 5-6.',
  };

  if (Number.isFinite(lookback_bars)) {
    out.lookback = {
      from_bars: lookback_bars,
      to_bars: round(lookback_bars * lookbackFactor, 2),
      to_bars_rounded: Math.max(1, Math.round(lookback_bars * lookbackFactor)),
      spans_minutes: round(lookback_bars * a, 1),
      spans_sessions: round((lookback_bars * a) / SESSION_MINUTES, 2),
    };
  }
  if (Number.isFinite(price_distance)) {
    out.price_distance = {
      from: price_distance,
      to: round(price_distance * volatilityFactor, 4),
      note: 'Stops, targets and expected ranges all move by this factor, NOT by the timeframe ratio.',
    };
  }
  return out;
}

/**
 * The realised scaling exponent, measured from bars.
 *
 * Aggregates returns over increasing horizons and fits log(stdev) against
 * log(horizon). Under independence the slope is 0.5 — that IS the sqrt law.
 * A slope above 0.5 means moves compound (persistence, trend); below 0.5 means
 * they offset (mean reversion).
 *
 * This is the variance-ratio idea in log form, and it is the reason to bother:
 * it turns the reversal-versus-continuation boundary from a literature citation
 * into something measurable per symbol.
 */
export function scalingExponent(bars, { horizons = [1, 2, 5, 10, 21, 63] } = {}) {
  if (!Array.isArray(bars) || bars.length < 80) {
    return { available: false, note: `Need at least 80 bars, have ${bars?.length ?? 0}.` };
  }
  const closes = bars.map((b) => Number(b.close)).filter((c) => Number.isFinite(c) && c > 0);
  if (closes.length < 80) return { available: false, note: 'Not enough finite closes.' };

  const logs = closes.map((c) => Math.log(c));
  const points = [];
  for (const h of horizons) {
    if (h < 1 || logs.length - h < 30) continue;
    // NON-overlapping increments: overlapping windows share data and shrink the
    // apparent variance, which biases the slope toward mean reversion.
    const rets = [];
    for (let i = h; i < logs.length; i += h) rets.push(logs[i] - logs[i - h]);
    if (rets.length < 8) continue;
    const m = rets.reduce((x, y) => x + y, 0) / rets.length;
    const sd = Math.sqrt(rets.reduce((x, y) => x + (y - m) ** 2, 0) / (rets.length - 1));
    if (!(sd > 0)) continue;
    points.push({ horizon: h, samples: rets.length, stdev: sd });
  }
  if (points.length < 3) return { available: false, note: 'Too few usable horizons to fit a slope.' };

  const xs = points.map((p) => Math.log(p.horizon));
  const ys = points.map((p) => Math.log(p.stdev));
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  const slope = den > 0 ? num / den : null;
  if (slope == null) return { available: false, note: 'Degenerate fit.' };

  /**
   * The standard error is NOT reported from the regression alone. With 4-6
   * points a slope looks far more precise than it is, and quoting a tight
   * interval here would be the same flattery this repo fights elsewhere.
   */
  const dev = slope - 0.5;
  const verdict = Math.abs(dev) < 0.05
    ? 'indistinguishable from a random walk at these horizons'
    : dev > 0
      ? 'moves COMPOUND across horizons — persistence, the continuation side'
      : 'moves OFFSET across horizons — mean reversion, the reversal side';

  return {
    available: true,
    exponent: round(slope, 4),
    random_walk_exponent: 0.5,
    deviation: round(dev, 4),
    by_horizon: points.map((p) => ({ ...p, stdev: round(p.stdev, 6) })),
    verdict,
    caution:
      'Fitted on a handful of horizons from one series, so treat it as a reading, not a test. No standard '
      + 'error is quoted because with 4-6 points it would look far tighter than it is. Non-overlapping '
      + 'increments are used deliberately — overlapping windows share data and bias the slope downward, '
      + 'manufacturing mean reversion.',
    what_it_is:
      'The exponent the sqrt-of-time law assumes to be 0.5. Measuring it rather than assuming it makes the '
      + 'reversal/continuation boundary a property of THIS series instead of a citation.',
  };
}

function round(v, dp = 2) {
  if (v == null || !Number.isFinite(v)) return null;
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}
