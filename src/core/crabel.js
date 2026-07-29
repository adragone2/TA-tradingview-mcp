/**
 * Toby Crabel — "Day Trading with Short Term Price Patterns and Opening Range
 * Breakout" (Market Analytics, 1990). The parts of it that are reachable from
 * daily bars.
 *
 * ── What this book is, and what it is not ──
 *
 * Crabel is a DAY TRADER. His holds are one to two days and his entries are
 * intraday, off the open. Two consequences govern everything here:
 *
 *   1. HALF THE BOOK IS UNREACHABLE. Opening Range Breakout — the title
 *      concept — needs the opening range, which he defines as the FIRST THIRTY
 *      SECONDS of trade. Chapters 1-4, 17, 26-32 all hang off it. Daily bars
 *      cannot see it, and nothing here pretends otherwise.
 *
 *   2. THE TURNOVER IS RUINOUS AT THIS HORIZON. A one-day hold is ~250 round
 *      trips a year. At 20bps that is ~50% annually before any edge exists.
 *      `turnover_cost` does the arithmetic; run it before treating any of this
 *      as a strategy rather than a description.
 *
 * So this module implements the CONTRACTION/EXPANSION half — Section III plus
 * the pieces of Section V that need only OHLC — and reports it as a volatility
 * statement, which is what it actually is. A narrow range says a move is
 * coming. It does not say which way.
 *
 * ── What was already here ──
 *
 * NR4 and NR7 (patterns.js) match his definitions exactly. Inside days, dojis,
 * gaps and pivot tops/bottoms are all present under other names — his "pivot
 * bottom" is a one-bar swing low. None of that is re-implemented.
 *
 * ── The one methodological thing worth stealing ──
 *
 * Chapter 3 is a CONTROL GROUP. Crabel measures the unconditional rate of a
 * move of a given size off the open, and states that every other test in the
 * book must be read against it. That is the noise floor discipline this repo
 * runs on, arrived at independently by a practitioner in 1990, and it is the
 * strongest reason to take his numbers more seriously than the usual
 * chart-pattern literature.
 *
 * All pure.
 */

const round = (n, dp = 4) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10 ** dp) / 10 ** dp);
const rangeOf = (b) => b.high - b.low;

/**
 * THE STRETCH — his entry distance.
 *
 * Defined as: over the previous ten days, average the difference between each
 * day's open and the closest of that day's extremes to it.
 *
 * The ORB entry it feeds is intraday and out of reach, but the quantity itself
 * is a useful daily-bar volatility measure: it is how far price typically
 * travels against the open before committing. Reported for that reason, and
 * labelled so nobody mistakes it for a tradeable trigger here.
 */
export function stretch(bars, { lookback = 10 } = {}) {
  if (!Array.isArray(bars) || bars.length < lookback) return null;
  const seg = bars.slice(-lookback);
  const diffs = seg.map((b) => Math.min(Math.abs(b.open - b.high), Math.abs(b.open - b.low)));
  const value = diffs.reduce((a, x) => a + x, 0) / diffs.length;
  const px = bars.at(-1).close;
  return {
    stretch: round(value),
    stretch_pct_of_price: round(px > 0 ? (value / px) * 100 : null, 3),
    lookback,
    definition: "Average over the last 10 days of |open - nearest extreme|. Crabel's ORB entry distance.",
    not_a_trigger: 'The ORB entry this feeds is INTRADAY — his opening range is the first thirty seconds '
      + 'of trade. On daily bars this is a volatility measure, not an entry.',
  };
}

/**
 * MULTI-BAR NARROW RANGE — 2BNR, 3BNR, 4BNR, 8BNR.
 *
 * The narrowest high-to-low range across any `span`-day period, relative to
 * every other `span`-day period in the previous `lookback` days. Crabel's own
 * pairings: 2 and 3 bars against 20 days, 4 bars against 30, 8 against 40.
 *
 * This is NOT NR4/NR7. Those compare ONE day's range against preceding single
 * days. This compares a multi-day range against multi-day ranges, so it
 * catches a market that coils over a week without any single day being
 * unusually quiet — which is the shape NR4 is blind to.
 */
export const MULTI_NR_SPECS = [
  { span: 2, lookback: 20, name: '2BNR' },
  { span: 3, lookback: 20, name: '3BNR' },
  { span: 4, lookback: 30, name: '4BNR' },
  { span: 8, lookback: 40, name: '8BNR' },
];

/** The high-to-low range of the `span` bars ending at index `i`. */
function spanRange(bars, i, span) {
  if (i - span + 1 < 0) return null;
  let hi = -Infinity, lo = Infinity;
  for (let k = i - span + 1; k <= i; k++) { if (bars[k].high > hi) hi = bars[k].high; if (bars[k].low < lo) lo = bars[k].low; }
  return hi - lo;
}

/**
 * Is the period ending at `i` the narrowest of its length in the lookback?
 *
 * Returns null rather than false when there is not enough history — "not
 * enough data" and "not narrow" are different answers.
 */
export function multiBarNR(bars, i, { span, lookback }) {
  if (!Array.isArray(bars) || i == null || i >= bars.length) return null;
  const here = spanRange(bars, i, span);
  if (here == null) return null;
  // Every other span-length window whose END lies in the previous `lookback`
  // days. Crabel compares periods, not days.
  let compared = 0;
  for (let j = i - 1; j >= i - lookback && j - span + 1 >= 0; j--) {
    const r = spanRange(bars, j, span);
    if (r == null) break;
    compared++;
    if (r <= here) return { qualifies: false, span, lookback, range: round(here), compared };
  }
  // Reached only when NOTHING was narrower. Insufficient history matters just
  // here: a counterexample above is a valid `false` however short the history,
  // but "narrowest" cannot be claimed from a handful of comparisons.
  if (compared < lookback / 2) return null;
  return {
    qualifies: true,
    span,
    lookback,
    compared,
    range: round(here),
    high: round(Math.max(...bars.slice(i - span + 1, i + 1).map((b) => b.high))),
    low: round(Math.min(...bars.slice(i - span + 1, i + 1).map((b) => b.low))),
  };
}

/** Every multi-bar NR that qualifies on the LAST bar. */
export function multiBarNRs(bars, { specs = MULTI_NR_SPECS } = {}) {
  if (!Array.isArray(bars) || !bars.length) return [];
  const i = bars.length - 1;
  const out = [];
  for (const s of specs) {
    const r = multiBarNR(bars, i, s);
    if (r?.qualifies) {
      out.push({
        pattern: s.name, ...r,
        breakout_levels: { above: r.high, below: r.low },
        meaning: `The narrowest ${s.span}-day range of the last ${s.lookback} days. Volatility has coiled `
          + 'across several bars, which NR4 and NR7 cannot see.',
        direction: 'neutral',
        direction_warning: 'A contraction says a RANGE EXPANSION is likelier. It says nothing about which '
          + 'way. Take the direction from structure, not from this.',
      });
    }
  }
  return out;
}

/** WIDE SPREAD — a daily range larger than the previous day's. The expansion half. */
export function wideSpread(bars, i = bars.length - 1) {
  if (!Array.isArray(bars) || i < 1) return null;
  const r = rangeOf(bars[i]), prev = rangeOf(bars[i - 1]);
  return { wide_spread: r > prev, range: round(r), prior_range: round(prev), ratio: round(prev > 0 ? r / prev : null, 3) };
}

/**
 * BULL and BEAR HOOK.
 *
 * Bear hook: opens BELOW the previous low, closes ABOVE the previous close,
 * on a narrow range. Bull hook: opens ABOVE the previous high, closes BELOW
 * the previous close, on a narrow range.
 *
 * Note the naming is counter-intuitive and is Crabel's: a "bull hook" opens
 * strong and closes weak. The names describe the OPENING, not the outcome.
 * Getting this backwards inverts the signal, so the direction field says which
 * way the bar actually resolved rather than relying on the name.
 */
export function hooks(bars, i = bars.length - 1) {
  if (!Array.isArray(bars) || i < 1) return null;
  const b = bars[i], p = bars[i - 1];
  const narrow = rangeOf(b) < rangeOf(p);
  if (!narrow) return null;
  if (b.open < p.low && b.close > p.close) {
    return {
      pattern: 'bear_hook', direction: 'bullish_resolution',
      note: "Crabel's naming describes the OPEN, not the outcome: a bear hook opens below the prior low "
        + 'and closes above the prior close. The bar itself resolved upward.',
      measurements: { open: round(b.open), prior_low: round(p.low), close: round(b.close), prior_close: round(p.close), range: round(rangeOf(b)), prior_range: round(rangeOf(p)) },
    };
  }
  if (b.open > p.high && b.close < p.close) {
    return {
      pattern: 'bull_hook', direction: 'bearish_resolution',
      note: "Crabel's naming describes the OPEN: a bull hook opens above the prior high and closes below "
        + 'the prior close. The bar itself resolved downward.',
      measurements: { open: round(b.open), prior_high: round(p.high), close: round(b.close), prior_close: round(p.close), range: round(rangeOf(b)), prior_range: round(rangeOf(p)) },
    };
  }
  return null;
}

/**
 * THREE DAY HIGH REVERSAL (3DHR).
 *
 * Three narrow-range days followed by a wide-spread day that closes beyond the
 * high or low of the three-day period, above its own open and mid-range.
 *
 * This is the contraction/expansion principle written as a single pattern:
 * three quiet bars, then the expansion, with the close confirming direction.
 */
export function threeDayHighReversal(bars, i = bars.length - 1) {
  if (!Array.isArray(bars) || i < 4) return null;
  const b = bars[i];
  const three = bars.slice(i - 3, i);
  // Three NARROW days: each narrower than the one before it.
  for (let k = 1; k < three.length; k++) if (rangeOf(three[k]) >= rangeOf(three[k - 1])) return null;
  const ws = rangeOf(b) > rangeOf(three[three.length - 1]);
  if (!ws) return null;
  const hi = Math.max(...three.map((x) => x.high));
  const lo = Math.min(...three.map((x) => x.low));
  const mid = (b.high + b.low) / 2;
  const up = b.close > hi && b.close > b.open && b.close > mid;
  const down = b.close < lo && b.close < b.open && b.close < mid;
  if (!up && !down) return null;
  return {
    pattern: '3DHR', direction: up ? 'bullish' : 'bearish',
    measurements: {
      three_day_high: round(hi), three_day_low: round(lo),
      close: round(b.close), open: round(b.open), mid_range: round(mid),
      range: round(rangeOf(b)), prior_range: round(rangeOf(three[three.length - 1])),
    },
    meaning: 'Three contracting days then a wide-spread close beyond the range, above open and mid-range. '
      + 'Crabel\'s contraction/expansion principle as one pattern.',
  };
}

/**
 * Everything in this module that fires on the last bar.
 *
 * Every result carries the horizon warning, because that is the part most
 * likely to be dropped when a finding is quoted onward.
 */
export function crabelPatterns(bars) {
  if (!Array.isArray(bars) || bars.length < 20) {
    return { patterns: [], stretch: null, note: 'Need at least 20 bars.', horizon: HORIZON_WARNING };
  }
  const patterns = [
    ...multiBarNRs(bars),
    ...[hooks(bars)].filter(Boolean),
    ...[threeDayHighReversal(bars)].filter(Boolean),
  ];
  return {
    patterns,
    count: patterns.length,
    stretch: stretch(bars),
    wide_spread: wideSpread(bars),
    horizon: HORIZON_WARNING,
    noise_baseline: CRABEL_NOISE_BASELINE,
  };
}

export const HORIZON_WARNING = {
  source: 'Crabel (1990), a day-trading book — holds of one to two days.',
  horizon_days: '1-2',
  turnover: 'A one-day hold is ~250 round trips a year; at 20bps that is ~50% annually before any edge. '
    + 'Run turnover_cost before treating any of this as a strategy.',
  reversal_zone: 'Below ~21 trading days the documented effect is REVERSAL, not continuation. These patterns '
    + 'sit at the extreme short end of that zone.',
  what_it_says: 'A contraction pattern is a VOLATILITY statement — a range expansion is likelier. It carries '
    + 'no directional information. Take direction from structure.',
  unreachable: 'Opening Range Breakout, the book\'s title concept, needs the first thirty seconds of trade. '
    + 'It is not implementable from daily bars and is deliberately absent.',
};

/**
 * How often these fire on data with no pattern in it.
 *
 * Populated by scripts/crabel-noise.js. A detector without this number is what
 * the rest of this repo exists to avoid.
 */
export const CRABEL_NOISE_BASELINE = {
  measured: true,
  script: 'scripts/crabel-noise.js',
  walks: 200,
  bars_per_walk: 300,
  // Every one of these fires on EVERY random walk, several times over. They
  // are the least selective detectors in this repo — zones, at 99.5%, are more
  // discriminating. That is not a bug in the implementation: they are
  // descriptions of bar geometry, and noise has bar geometry.
  walks_firing_pct: { '2BNR': 100, '3BNR': 100, '4BNR': 100, '8BNR': 100, hook: 100, '3DHR': 100 },
  occurrences_per_walk: { '2BNR': 12.79, '3BNR': 13.73, '4BNR': 9.71, '8BNR': 7.95, hook: 4.49, '3DHR': 13.31 },

  /**
   * THE CONTRACTION/EXPANSION PRINCIPLE, MEASURED AGAINST ITS OWN CONTROL.
   *
   * The book's central claim is that a contraction precedes an expansion. It
   * does — and it does so just as strongly when there is no market present.
   *
   *                        random walk    real data (12 large caps, 3600 bars)
   *   P(expansion)              50.1%              49.7%
   *   P(expansion | NR4)        80.2%              76.4%
   *   lift                     +30.0 pts          +26.7 pts
   *
   * Real data shows LESS lift than pure noise. Daily range is mean-reverting
   * by arithmetic — a narrow day sits below its own average, so the next day is
   * usually wider — and that accounts for the entire effect.
   *
   * The principle is therefore TRUE AS A DESCRIPTION and EMPTY AS AN EDGE. A
   * narrow range really is followed by a wider one about three quarters of the
   * time; knowing that tells you nothing a random number generator would not
   * also tell you. Crabel could not have seen this: he compares against an
   * unconditional move-off-the-open rate, not against a randomised control.
   */
  contraction_expansion: {
    random_walk: { base_pct: 50.1, given_nr4_pct: 80.2, lift_points: 30.0, n_conditional: 14477 },
    real_data: { base_pct: 49.7, given_nr4_pct: 76.4, lift_points: 26.7, n_conditional: 908,
      sample: '12 large caps, 300 daily bars each' },
    verdict: 'NO EDGE. Real data shows less lift than a random walk. The effect is range mean-reversion, '
      + 'which is arithmetic, not a market tendency.',
  },
  note: 'Use these patterns to DESCRIBE volatility state, never to justify a trade. Every one fires on '
    + '100% of random walks, and the contraction/expansion principle they rest on has no lift over noise.',
  context: { zones_pct: 99.5, structural_patterns_pct: 68, channels_pct: 33.5, vcp_pct: 0, pennants_pct: 0 },
};
