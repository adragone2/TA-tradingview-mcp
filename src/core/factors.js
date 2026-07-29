/**
 * The Tier A cross-sectional factors.
 *
 * Four results from docs/swing-evidence-review.md that were catalogued and
 * never implemented. Three belong to the MONTHS bucket, one to WEEKS.
 *
 * ── The thing that makes these implementable at all ──
 *
 * Every one is CROSS-SECTIONAL: a decile sort across a universe, not a
 * per-chart detector. TradingView's scanner returns 4,505 index members with
 * their moving averages and volume in one request, which is exactly the shape
 * these need. A per-symbol version of any of them would be a different object
 * with none of the evidence behind it.
 *
 * ── What is deliberately NOT here ──
 *
 * The trend factor's learned weights. Han, Zhou & Zhu estimate coefficients by
 * monthly cross-sectional regression of returns on the moving-average signals,
 * using the time series of those estimates to forecast. That needs a stored
 * panel of past cross-sections, which this toolchain does not keep. The signal
 * vector is computed; the weighting is not invented. See `trendSignals`.
 *
 * All pure. Feed them scanner rows.
 */

const round = (n, dp = 4) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10 ** dp) / 10 ** dp);

/**
 * Decile rank within a cross-section, 1 = lowest, 10 = highest.
 *
 * Ties share the lower rank rather than being split arbitrarily, and rows with
 * no value are EXCLUDED rather than sorted to one end — a missing signal at the
 * bottom of the sort reads as a strong short.
 */
export function decileRank(rows, valueOf, { deciles = 10 } = {}) {
  const scored = rows
    .map((r) => ({ row: r, v: valueOf(r) }))
    .filter((x) => Number.isFinite(x.v));
  scored.sort((a, b) => a.v - b.v);
  const n = scored.length;
  return scored.map((x, i) => ({
    ...x.row,
    _value: round(x.v, 6),
    _decile: n < deciles ? null : Math.min(deciles, Math.floor((i / n) * deciles) + 1),
    _pct_rank: n > 1 ? round(i / (n - 1), 4) : null,
  }));
}

/* ─────────────────────────── MONTHS ─────────────────────────── */

/**
 * MOVING AVERAGE DISTANCE — Avramov, Kaplanski & Subrahmanyam (2021).
 *
 * The normalised distance between a short-run and long-run moving average
 * predicts the cross-section. Value-weighted hedge-portfolio alphas around 9%
 * annualised, incremental to momentum, the 52-week-high effect and
 * profitability. It survives trading costs at institutional levels, is stronger
 * on the LONG side, and remained meaningful in periods when standard momentum
 * did not — momentum is insignificant in its presence.
 *
 * THE CONSTRUCTION MATTERS AND IS EASY TO GET WRONG. This is a cross-sectional
 * decile sort on a normalised distance, rebalanced MONTHLY. It is not a
 * crossover trigger and not a same-day entry signal. **The signal is a STATE,
 * not an EVENT.** Implementing it as "price crossed its moving average" would
 * be a different thing carrying none of this evidence.
 *
 * The paper uses 21-day and 200-day. TradingView exposes SMA20, which is one
 * session different — and Han, Zhou & Zhu found results "remarkably
 * insensitive to which specific lags are chosen", which is the same family of
 * signal. The substitution is noted rather than hidden.
 */
export const MAD_SPEC = {
  short_field: 'SMA20',
  long_field: 'SMA200',
  paper_short_days: 21,
  substitution_note: 'Paper uses 21-day; TradingView exposes SMA20. Han et al. (2016) found this family of '
    + 'signal remarkably insensitive to lag choice, so the one-session difference is not material.',
  rebalance: 'monthly',
  horizon: 'MONTHS',
  evidence: 'Tier A. Avramov, Kaplanski & Subrahmanyam, Review of Financial Economics (2021). ~9% annualised '
    + 'on value-weighted hedge portfolios; survives institutional costs; stronger long than short.',
  caution: 'A STATE, not an EVENT. Not a crossover trigger, not a same-day entry.',
};

/** Normalised MA distance for one row. Null when either average is missing. */
export function madValue(row) {
  const s = row[MAD_SPEC.short_field], l = row[MAD_SPEC.long_field];
  if (!Number.isFinite(s) || !Number.isFinite(l) || !(l > 0)) return null;
  return (s - l) / l;
}

/** Rank a cross-section by MAD. Top decile is the long side. */
export function movingAverageDistance(rows) {
  const ranked = decileRank(rows, madValue);
  return {
    factor: 'moving_average_distance',
    ...MAD_SPEC,
    universe: rows.length,
    ranked: ranked.length,
    ranked_rows: ranked,
    long_side: ranked.filter((r) => r._decile === 10),
    short_side: ranked.filter((r) => r._decile === 1),
    long_side_note: 'The paper reports the long side as the stronger one, which matters for anyone who '
      + 'cannot short cheaply.',
  };
}

/**
 * THE TREND FACTOR — Han, Zhou & Zhu (2016).
 *
 * Normalised moving averages across many lag lengths, combined by monthly
 * cross-sectional regressions whose coefficients are LEARNED from the data each
 * period. ~1.63%/month, t≈13.6 against 6.04 for momentum, positive through
 * 2008-09 when momentum lost heavily, replicates in the G7.
 *
 * ── WHAT IS IMPLEMENTED, AND WHAT IS NOT ──
 *
 * The signal vector is computed here: MA(L)/close for each lag. The LEARNED
 * WEIGHTS are not, because estimating them needs a stored panel of past
 * cross-sections and their subsequent returns, which this toolchain does not
 * keep.
 *
 * An equal-weighted blend of these signals is NOT the trend factor. It is a
 * different object with none of the evidence, and shipping it under this name
 * would be exactly the kind of borrowed-credibility mistake the rest of this
 * repo exists to avoid. `weights: null` says so in the output.
 *
 * The paper's own robustness result is the reason this is still worth having:
 * results barely change when the lag set changes. So the information is in the
 * joint configuration, not in a magic lookback — and effort spent hunting *the*
 * right moving average is spent where the signal is least sensitive and
 * overfitting is most easily mistaken for skill.
 */
export const TREND_LAGS = ['SMA10', 'SMA20', 'SMA50', 'SMA100', 'SMA200'];

export function trendSignals(row) {
  const c = row.close;
  if (!Number.isFinite(c) || !(c > 0)) return null;
  const out = {};
  for (const f of TREND_LAGS) {
    const v = row[f];
    out[f] = Number.isFinite(v) ? round(v / c, 6) : null;
  }
  return out;
}

export function trendFactor(rows) {
  return {
    factor: 'trend_factor',
    horizon: 'MONTHS',
    evidence: 'Tier A. Han, Zhou & Zhu, Journal of Financial Economics (2016). ~1.63%/month, t≈13.6.',
    lags: TREND_LAGS,
    signals: rows.map((r) => ({ symbol: r.symbol, signals: trendSignals(r) })),
    weights: null,
    weights_note: 'NOT IMPLEMENTED. The paper learns coefficients by monthly cross-sectional regression of '
      + 'returns on these signals; that needs a stored panel of past cross-sections and their subsequent '
      + 'returns, which this toolchain does not retain. An equal-weighted blend of these signals is a '
      + 'DIFFERENT object with none of the evidence — so no composite is produced here.',
    to_enable: 'Persist each morning\'s cross-section with forward returns. After ~24 monthly observations '
      + 'the regression becomes estimable and the factor can be completed.',
    robustness_lesson: 'Results barely change when the lag set changes. The information is in the joint '
      + 'configuration, not in a specific lookback — so tuning lag lengths is the dimension where '
      + 'overfitting is most easily mistaken for skill.',
  };
}

/**
 * HIGH-VOLUME RETURN PREMIUM — Gervais, Kaniel & Mingelgrin (2001).
 *
 * Stocks with unusually high trading volume over a day or a week tend to
 * appreciate over the FOLLOWING MONTH; unusually low volume tends to
 * depreciate. Mechanism is visibility — a shock to trading activity raises
 * salience, which raises subsequent demand (Merton's investor recognition
 * hypothesis). Return autocorrelation, announcements, market risk and liquidity
 * were ruled out. Replicates across developed and emerging markets, and the
 * cross-country variation tracks proxies for visibility.
 *
 * NOTE WHAT WAS ACTUALLY TESTED: a cross-sectional sort on abnormal volume,
 * held for roughly a month. That is NOT a volume-confirmation filter attached
 * to a same-day breakout entry, and there is no basis for assuming the effect
 * size survives that translation. This repo has used relative volume the second
 * way before; this is the first time it is used the way it was measured.
 */
export const VOLUME_PREMIUM_SPEC = {
  field: 'relative_volume_10d_calc',
  horizon: 'MONTHS',
  hold: '~1 month',
  evidence: 'Tier A. Gervais, Kaniel & Mingelgrin, Journal of Finance (2001).',
  caution: 'Tested as a cross-sectional sort held ~1 month. NOT a same-day breakout confirmation filter.',
};

export function volumePremium(rows) {
  const ranked = decileRank(rows, (r) => r[VOLUME_PREMIUM_SPEC.field]);
  return {
    factor: 'high_volume_premium',
    ...VOLUME_PREMIUM_SPEC,
    universe: rows.length,
    ranked: ranked.length,
    ranked_rows: ranked,
    long_side: ranked.filter((r) => r._decile === 10),
    short_side: ranked.filter((r) => r._decile === 1),
  };
}

/* ─────────────────────────── WEEKS ─────────────────────────── */

/**
 * SHORT-TERM REVERSAL AS LIQUIDITY PROVISION — Nagel (2012).
 *
 * The anchor of the Weeks bucket, and the only Tier A result at that horizon.
 *
 * Nagel reinterprets short-horizon reversal as the return to SUPPLYING
 * LIQUIDITY: the strategy buys what the public is selling and sells what it is
 * buying, which is what a market maker does. The payoff of that reframing is
 * the conditioning — expected returns are strongly time-varying and highly
 * predictable from VIX, rising sharply during turmoil.
 *
 * THE CONDITIONING IS NOT OPTIONAL. Reversal portfolios formed from industry
 * indices "earn essentially nothing unconditionally" and "become profitable
 * when VIX is high". A standing, unconditional reversal screen is therefore
 * expected to earn nothing — running one is not a small compromise on this
 * result, it is discarding the result.
 *
 * The VIX level is an INPUT rather than fetched here, so this stays pure and
 * the caller decides its source.
 */
export const REVERSAL_SPEC = {
  signal: 'negative prior-week return — buy the losers',
  field: 'Perf.W',
  horizon: 'WEEKS',
  evidence: 'Tier A. Nagel, Review of Financial Studies (2012).',
  conditioning: 'VIX. Unconditionally this earns essentially nothing.',
};

/**
 * Is the volatility environment one where the effect has been documented?
 *
 * Nagel shows expected returns rising WITH VIX rather than switching on at a
 * level, so any threshold is a discretisation of a continuum. The default sits
 * near the long-run median so "elevated" means what it usually means; the
 * actual level and the threshold are both reported so the call is visible
 * rather than buried.
 */
export function volatilityRegime(vix, { threshold = 20 } = {}) {
  if (!Number.isFinite(vix)) {
    return {
      vix: null, threshold, favourable: false, unknown: true,
      verdict: 'VIX unavailable. The conditioning cannot be evaluated, so this factor is NOT active — '
        + 'an unconditional reversal screen is expected to earn nothing.',
    };
  }
  const favourable = vix >= threshold;
  return {
    vix: round(vix, 2),
    threshold,
    favourable,
    verdict: favourable
      ? `VIX ${round(vix, 2)} is at or above ${threshold}. This is the regime in which short-term reversal `
        + 'has been documented to pay — the liquidity-provision premium rises with volatility.'
      : `VIX ${round(vix, 2)} is below ${threshold}. Nagel finds reversal earns essentially NOTHING `
        + 'unconditionally, so this factor is inactive rather than merely weaker.',
    caution: 'Returns rise CONTINUOUSLY with VIX in the paper; a threshold is a discretisation. Treat a '
      + 'reading just either side of it as the same thing.',
  };
}

export function shortTermReversal(rows, { vix = null, threshold = 20 } = {}) {
  const regime = volatilityRegime(vix, { threshold });
  // Rank by prior-week return ASCENDING, so decile 1 is the biggest loser —
  // which is the side this buys.
  const ranked = decileRank(rows, (r) => r[REVERSAL_SPEC.field]);
  return {
    factor: 'short_term_reversal',
    ...REVERSAL_SPEC,
    regime,
    active: regime.favourable,
    universe: rows.length,
    ranked: ranked.length,
    ranked_rows: ranked,
    // Buy the losers: decile 1 on prior-week return.
    long_side: regime.favourable ? ranked.filter((r) => r._decile === 1) : [],
    long_side_note: regime.favourable
      ? 'Decile 1 by prior-week return — the biggest losers, which is the side liquidity provision buys.'
      : 'EMPTY BY DESIGN. The regime is not favourable, and unconditionally this earns nothing.',
  };
}

/** Every Tier A factor over one cross-section. */
export function allFactors(rows, { vix = null } = {}) {
  return {
    universe: rows.length,
    months: {
      moving_average_distance: movingAverageDistance(rows),
      trend_factor: trendFactor(rows),
      high_volume_premium: volumePremium(rows),
    },
    weeks: {
      short_term_reversal: shortTermReversal(rows, { vix }),
    },
    note: 'All four are CROSS-SECTIONAL decile results. A single name\'s decile is a statement about its '
      + 'rank in this universe on this day, not a forecast for that name — see edge_breadth for what a '
      + 'cross-sectional edge retains on one position.',
  };
}
