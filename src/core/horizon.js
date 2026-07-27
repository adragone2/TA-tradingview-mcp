/**
 * The horizon problem: swing trading sits on top of a sign change.
 *
 * ── The structure most swing systems ignore ──
 *
 * Below roughly one month, the dominant documented cross-sectional regularity
 * in equities is REVERSAL — stocks that fell over the prior days and weeks
 * tend to outperform (Jegadeesh 1990; Lehmann 1990). Above roughly three
 * months and out to twelve, the dominant regularity is CONTINUATION
 * (Jegadeesh & Titman 1993).
 *
 * The standard momentum construction skips the most recent month. That skip
 * is not a technical nicety. It is an explicit acknowledgment that
 * continuation and reversal are separated by a horizon boundary — and the
 * boundary falls INSIDE the two-to-twenty-day window swing traders operate in.
 *
 * ── What follows for this toolchain ──
 *
 * Breakout systems, moving-average reclaim systems and momentum-continuation
 * patterns are all placing a continuation bet at the horizon where
 * continuation is WEAKEST and the opposing effect is STRONGEST. Mean-reversion
 * setups — oversold bounces, pullback entries, fading extended moves — are
 * placing a reversal bet where reversal is actually documented.
 *
 * This does not make continuation at swing horizon impossible; several
 * well-evidenced effects are continuation-flavoured. It means **the prior on a
 * continuation setup at ten days should be materially lower than the prior on
 * the same logic at six months**, and that most swing systems weight the two
 * families as though the priors were equal. They are not.
 *
 * Our own detectors are almost entirely continuation-flavoured — flags,
 * breakouts, triangles, wedges, VCP. That is a systematic tilt into the weaker
 * side of the boundary, and until now nothing in the toolchain said so.
 *
 * ── Credit ──
 *
 * This framing comes from the user's own evidence review (2026-07-27), which
 * identified it as the structural problem underneath the swing canon. It was
 * absent from my prior research passes. See docs/swing-evidence-review.md.
 *
 * All pure.
 */

const round = (n, dp = 2) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10 ** dp) / 10 ** dp);

/** Trading-day boundaries, from the literature rather than round numbers. */
export const HORIZON_ZONES = {
  reversal: {
    max_days: 21,
    effect: 'reversal',
    sources: 'Jegadeesh (1990), Journal of Finance 45(3); Lehmann (1990), QJE 105(1)',
    magnitude: 'Roughly 2% per month for the reversal strategy over 1934-1987.',
    what_it_means: 'Below about a month, losers tend to outperform winners. A continuation bet here is fighting the '
      + 'documented effect; a mean-reversion bet is aligned with it.',
  },
  contested: {
    min_days: 22,
    max_days: 62,
    effect: 'contested',
    sources: 'The gap the momentum skip-month exists to avoid.',
    what_it_means: 'Neither effect dominates. Standard momentum deliberately skips this stretch, which is the clearest '
      + 'statement in the literature that it is not a good place to take either side.',
  },
  continuation: {
    min_days: 63,
    effect: 'continuation',
    sources: 'Jegadeesh & Titman (1993), Journal of Finance 48(1)',
    magnitude: '~1.31%/month at 12-month formation, 3-month holding; 0.9-1.3% across all 16 formation/holding combinations.',
    what_it_means: 'Past winners continue. This is where continuation logic has its evidence, and it is beyond the swing window.',
  },
};

/** Which side of the boundary does an intended holding period fall on? */
export function horizonZone(holding_days) {
  if (!(holding_days > 0)) throw new Error('holding_days must be positive.');
  if (holding_days <= HORIZON_ZONES.reversal.max_days) return { zone: 'reversal', ...HORIZON_ZONES.reversal };
  if (holding_days <= HORIZON_ZONES.contested.max_days) return { zone: 'contested', ...HORIZON_ZONES.contested };
  return { zone: 'continuation', ...HORIZON_ZONES.continuation };
}

/** Setups this toolchain detects, classified by which bet they are making. */
export const SETUP_FAMILY = {
  continuation: [
    'bull_flag', 'bear_flag', 'high_tight_flag', 'ascending_triangle', 'descending_triangle',
    'symmetrical_triangle', 'rectangle', 'breakout', 'vcp', 'falling_wedge', 'rising_wedge',
    'moving_average_reclaim', 'pivot_breakout',
  ],
  reversal: [
    'double_top', 'double_bottom', 'triple_top', 'triple_bottom', 'head_and_shoulders',
    'inverse_head_and_shoulders', 'broadening_formation', 'oversold_bounce', 'pullback_entry',
    'wyckoff_spring', 'divergence',
  ],
};

export function setupFamily(name) {
  const n = String(name || '').toLowerCase();
  if (SETUP_FAMILY.continuation.includes(n)) return 'continuation';
  if (SETUP_FAMILY.reversal.includes(n)) return 'reversal';
  return 'unclassified';
}

/**
 * Does this setup, at this holding period, run with or against the documented
 * effect at that horizon?
 *
 * Returns a PRIOR ADJUSTMENT, not a forecast. Nothing here says a trade will
 * work or fail — it says which way the base rate leans before the chart is
 * consulted, which is exactly the thing a chart cannot tell you.
 */
export function horizonPrior(setup, { holding_days = 10 } = {}) {
  const zone = horizonZone(holding_days);
  const family = typeof setup === 'string' ? setupFamily(setup) : setup;

  if (family === 'unclassified') {
    return {
      setup, holding_days, horizon_zone: zone.zone,
      alignment: 'unknown',
      note: `"${setup}" is not classified as continuation or reversal here. Classify it before reading a prior — `
        + 'the whole question is which bet it makes.',
      zone_detail: zone,
    };
  }

  const aligned = family === zone.effect;
  const contested = zone.zone === 'contested';

  let alignment, guidance;
  if (contested) {
    alignment = 'contested horizon';
    guidance = `A ${holding_days}-day hold lands in the stretch standard momentum deliberately SKIPS. Neither effect `
      + 'dominates here. That is not a neutral result — it is the literature declining to take either side.';
  } else if (aligned) {
    alignment = 'with the documented effect';
    guidance = `A ${family} setup held ~${holding_days} days runs WITH the effect documented at that horizon. `
      + 'This is the favourable case, and it is worth saying so explicitly because it is the rarer one for our detectors.';
  } else {
    alignment = 'AGAINST the documented effect';
    guidance = `A ${family} setup held ~${holding_days} days runs AGAINST the effect documented at that horizon `
      + `(${zone.effect} dominates below ${zone.zone === 'reversal' ? '~21' : ''} days). The prior on this setup should be `
      + 'materially LOWER than the same logic applied at a horizon where its effect has evidence. Take it if the chart '
      + 'justifies it — but do not treat it as a neutral-prior setup.';
  }

  return {
    setup,
    setup_family: family,
    holding_days,
    horizon_zone: zone.zone,
    dominant_effect_at_this_horizon: zone.effect,
    alignment,
    guidance,
    zone_detail: zone,
    the_boundary: 'Reversal dominates below ~21 trading days; continuation above ~63. The swing window straddles the '
      + 'sign change, and the momentum skip-month is the literature admitting exactly that.',
    caveat: 'This is a PRIOR, not a forecast. It adjusts the starting odds, it does not predict this trade. And these '
      + 'are cross-sectional effects — see edge_breadth for what they are worth on one position.',
  };
}

/**
 * Nagel's conditioning: the payoff to mean reversion is not a constant.
 *
 * Nagel (2012) reinterprets short-horizon reversal as the return to SUPPLYING
 * LIQUIDITY — the strategy buys what the public is selling. He shows that
 * return is strongly time-varying and highly predictable from VIX, with
 * expected returns and conditional Sharpe ratios rising sharply in turmoil.
 * Reversal portfolios built from industry indices earn essentially nothing
 * unconditionally and become profitable when VIX is high.
 *
 * We cannot read VIX from a single chart, so this uses realised volatility
 * relative to its own history as a proxy and says so. The point is the shape
 * of the conditioning, not a precise level.
 */
export function reversalConditioning(bars, { window = 21, history = 252 } = {}) {
  if (!Array.isArray(bars) || bars.length < history + window) {
    return {
      available: false,
      note: `Need ${history + window} bars to compare current volatility against its own history; have ${bars?.length ?? 0}.`,
    };
  }
  const rets = [];
  for (let i = 1; i < bars.length; i++) rets.push(Math.log(bars[i].close / bars[i - 1].close));

  const sd = (xs) => {
    const m = xs.reduce((a, b) => a + b, 0) / xs.length;
    return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
  };
  const current = sd(rets.slice(-window));

  // Percentile of current volatility within its own trailing history.
  const windows = [];
  for (let i = history; i >= window; i--) windows.push(sd(rets.slice(-i - window, -i)));
  const below = windows.filter((v) => v < current).length;
  const pct = windows.length ? (below / windows.length) * 100 : null;

  const elevated = pct != null && pct >= 70;
  return {
    available: true,
    current_volatility_annualized_pct: round(current * Math.sqrt(252) * 100),
    volatility_percentile: round(pct, 1),
    regime: pct == null ? 'unknown' : elevated ? 'elevated' : pct <= 30 ? 'calm' : 'ordinary',
    mean_reversion_expectation: elevated
      ? 'FAVOURABLE — volatility is elevated relative to its own history. Nagel shows the return to liquidity '
        + 'provision rises sharply in turmoil, because liquidity suppliers withdraw and the price of what remains goes up.'
      : 'MUTED — volatility is not elevated. Nagel found reversal portfolios earn essentially nothing unconditionally; '
        + 'the payoff is concentrated in stressed states.',
    mechanism: 'Short-horizon reversal is compensation for SUPPLYING LIQUIDITY — buying what the public is selling. '
      + 'It is a business with a capital requirement and a tail risk, not a free anomaly.',
    source: 'Nagel (2012), Review of Financial Studies 25(7), 2005-2039.',
    proxy_warning: 'Nagel conditions on VIX. This uses the instrument\'s own realised volatility percentile as a stand-in, '
      + 'because one chart cannot see VIX. The shape of the conditioning transfers; the exact threshold does not.',
  };
}
