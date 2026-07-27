/**
 * Time-series momentum, after Moskowitz, Ooi & Pedersen (2012),
 * "Time series momentum", Journal of Financial Economics 104(2).
 *
 * ── Why this module is different from everything else in src/core ──
 *
 * Almost every other detector here rests on evidence that is contested,
 * unreplicated, or both. This one does not. MOP tested a 12-month lookback
 * with a 1-month holding period across 58 futures and forwards spanning
 * equity indices, currencies, commodities and sovereign bonds over 25+ years,
 * and found it positive and significant FOR EVERY SINGLE INSTRUMENT. Composite
 * Sharpe 1.28 against 0.38 for buy-and-hold on the same universe.
 *
 * That is a completely different quality of evidence from the chart-pattern
 * literature, where the foundational study did not reproduce out of sample.
 *
 * ── What it does not mean ──
 *
 * MOP measured futures, not single stocks, and diversified across 58 of them.
 * A 12-month momentum reading on one equity is the same SIGNAL, not the same
 * STRATEGY, and carries none of the diversification that produced that Sharpe.
 * The effect also reverses: MOP found it persists about a year and then
 * partially unwinds, so a long lookback is a warning as well as a signal.
 *
 * ── The persistence baseline ──
 *
 * Radfar (2025) showed that published LSTM stock predictors reporting "97%
 * accuracy" were reproducing the naive rule "tomorrow equals today", which
 * scores 95-98% on the same metric. In his own results table the constant-
 * price baseline (85.25) beat his proposed CNN (85.21) across all stocks.
 *
 * So every forecast-shaped number in this module ships with the naive
 * baseline beside it. A signal that cannot beat "no change" is not a signal.
 *
 * All pure.
 */

const round = (n, dp = 4) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10 ** dp) / 10 ** dp);

/** Trading days, the convention MOP's monthly horizons translate to. */
export const HORIZONS = {
  '1m': 21,
  '3m': 63,
  '6m': 126,
  '12m': 252,
};

/**
 * The MOP signal: the sign of the excess return over the lookback.
 *
 * They used sign alone, not magnitude — the position is scaled by volatility
 * afterwards, not by how strong the signal looked. That separation is the
 * point, and it is why this returns `direction` and `volatility` as distinct
 * fields rather than one blended score.
 */
export function timeSeriesMomentum(bars, { lookback = 252, vol_window = 60, annualization = 252 } = {}) {
  if (!Array.isArray(bars) || bars.length < 30) {
    return { available: false, note: `Need at least 30 bars, have ${bars?.length ?? 0}.` };
  }
  if (bars.length < lookback + 1) {
    return {
      available: false,
      note: `A ${lookback}-bar lookback needs ${lookback + 1} bars; only ${bars.length} loaded. `
        + 'Load more history or choose a shorter horizon — do not read this as a neutral signal.',
      bars_available: bars.length,
      bars_required: lookback + 1,
    };
  }

  const closes = bars.map((b) => b.close);
  const last = closes[closes.length - 1];
  const then = closes[closes.length - 1 - lookback];
  const totalReturn = (last - then) / then;

  // Daily log returns for the volatility estimate.
  const rets = [];
  for (let i = 1; i < closes.length; i++) rets.push(Math.log(closes[i] / closes[i - 1]));
  const recent = rets.slice(-vol_window);
  const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
  const variance = recent.reduce((a, r) => a + (r - mean) ** 2, 0) / (recent.length - 1);
  const dailyVol = Math.sqrt(variance);
  const annualVol = dailyVol * Math.sqrt(annualization);

  return {
    available: true,
    lookback_bars: lookback,
    lookback_return_pct: round(totalReturn * 100, 2),
    direction: totalReturn > 0 ? 'long' : totalReturn < 0 ? 'short' : 'flat',
    signal: Math.sign(totalReturn),
    annualized_volatility_pct: round(annualVol * 100, 2),
    // MOP size positions to a constant volatility target, which is what makes
    // 58 instruments comparable. Reported as a scalar so it is obviously a
    // sizing input rather than a recommendation.
    volatility_scalar: annualVol > 0 ? round(0.40 / annualVol, 3) : null,
    volatility_scalar_basis: '40% annualized target, MOP\'s convention. Multiply your base size by this to equalise risk across instruments.',
    from_price: round(then, 4),
    to_price: round(last, 4),
    method: 'Sign of the excess return over the lookback, after Moskowitz, Ooi & Pedersen (2012). Magnitude is deliberately '
      + 'NOT part of the signal; it belongs to sizing.',
    evidence: 'Positive and significant for every one of 58 futures and forwards over 25+ years; composite Sharpe 1.28 '
      + 'vs 0.38 buy-and-hold. Measured on DIVERSIFIED FUTURES, not single equities — the signal transfers, the Sharpe does not.',
    caveat: 'MOP found the effect persists about 12 months and then partially REVERSES. A very extended lookback return '
      + 'is as much a warning as a signal.',
  };
}

/**
 * Read momentum at several horizons at once and say whether they agree.
 *
 * Disagreement across horizons is the finding, in the same way it is for
 * elliott_survey and divergence_survey: a name that is positive over 12 months
 * and negative over 1 is in a pullback, and one that is the reverse is either
 * turning or a dead-cat bounce. Neither is "momentum".
 */
export function momentumProfile(bars, { horizons = HORIZONS, vol_window = 60 } = {}) {
  const readings = [];
  for (const [label, lookback] of Object.entries(horizons)) {
    const m = timeSeriesMomentum(bars, { lookback, vol_window });
    readings.push({ horizon: label, lookback_bars: lookback, ...m });
  }
  const usable = readings.filter((r) => r.available);
  if (!usable.length) {
    return {
      readings,
      agreement: 'none',
      note: 'No horizon had enough history to read. This is missing data, not a neutral signal.',
    };
  }

  const longs = usable.filter((r) => r.signal > 0).length;
  const shorts = usable.filter((r) => r.signal < 0).length;
  const agreed = longs === usable.length || shorts === usable.length;

  return {
    readings,
    horizons_read: usable.length,
    horizons_requested: readings.length,
    agreement: agreed ? (longs ? 'all long' : 'all short') : 'mixed',
    ...(agreed
      ? { direction: longs ? 'long' : 'short' }
      : { direction: null, disagreement: usable.map((r) => `${r.horizon}:${r.direction}`).join(' ') }),
    interpretation: agreed
      ? `Every readable horizon points ${longs ? 'up' : 'down'}. That is what momentum agreement looks like.`
      : 'The horizons disagree. A name positive over 12 months and negative over 1 is in a pullback; the reverse is either '
        + 'turning or bouncing. Neither is momentum, and the mixed reading is the answer rather than a problem to resolve.',
    ...(usable.length < readings.length
      ? { warning: `${readings.length - usable.length} horizon(s) could not be read for lack of history and are NOT counted as neutral.` }
      : {}),
  };
}

/**
 * The naive persistence baseline: predict that tomorrow equals today.
 *
 * Exists to be the thing every other forecast is measured against. Radfar
 * (2025) traced a family of published "97% accurate" LSTM stock predictors to
 * exactly this rule, and in his own comparison the constant-price baseline
 * beat the proposed CNN across all stocks tested.
 *
 * `accuracy` here uses his Eq. 3 form — 1 minus mean absolute percentage
 * error — so the numbers are directly comparable to that literature, and so
 * that its inflated look is visible rather than hidden.
 */
export function persistenceBaseline(bars, { horizon = 1 } = {}) {
  if (!Array.isArray(bars) || bars.length < horizon + 2) {
    return { available: false, note: `Need at least ${horizon + 2} bars.` };
  }
  const closes = bars.map((b) => b.close);
  const errors = [];
  let correctDirection = 0, directional = 0;

  for (let i = 0; i + horizon < closes.length; i++) {
    const actual = closes[i + horizon];
    const predicted = closes[i];                 // the naive rule, in full
    if (actual !== 0) errors.push(Math.abs(actual - predicted) / Math.abs(actual));
    // A persistence forecast predicts no change, so it has no direction to be
    // right about. Counted for reference against a coin flip.
    if (actual !== closes[i]) {
      directional++;
      if (actual > closes[i] === (predicted > closes[i])) correctDirection++;
    }
  }

  const mape = errors.reduce((a, b) => a + b, 0) / errors.length;
  return {
    available: true,
    horizon_bars: horizon,
    accuracy_pct: round((1 - mape) * 100, 2),
    mean_abs_pct_error: round(mape * 100, 3),
    samples: errors.length,
    directional_accuracy_pct: directional ? round((correctDirection / directional) * 100, 2) : null,
    why_this_exists: 'Any model that cannot beat THIS has learned nothing. Radfar (2025) showed published LSTM predictors '
      + 'reporting up to 97% accuracy were reproducing this rule; his own constant-price baseline scored 85.25 against '
      + '85.21 for his proposed CNN across all stocks tested.',
    how_to_read: 'A high accuracy here is not skill — it is the arithmetic of daily price changes being small relative to '
      + 'price. Quote it as the floor, never as a result.',
  };
}

/**
 * Compare a directional signal to the persistence baseline over the same bars.
 *
 * `signalAt(index)` must return 1, -1 or 0 using ONLY bars up to and including
 * `index`. Look-ahead here would be invisible and would invalidate everything
 * downstream, so the contract is stated rather than assumed.
 */
export function versusBaseline(bars, signalAt, { horizon = 1 } = {}) {
  if (typeof signalAt !== 'function') throw new Error('signalAt must be a function of the bar index.');
  if (!Array.isArray(bars) || bars.length < horizon + 5) {
    return { available: false, note: 'Not enough bars to compare.' };
  }

  let signalCorrect = 0, signalTaken = 0;
  let coinflipEquivalent = 0, moves = 0;
  const signalReturns = [];

  for (let i = 0; i + horizon < bars.length; i++) {
    const actual = bars[i + horizon].close;
    const now = bars[i].close;
    if (actual === now) continue;
    moves++;
    coinflipEquivalent += 0.5;

    const s = signalAt(i);
    if (!s) continue;
    signalTaken++;
    const up = actual > now;
    if ((s > 0 && up) || (s < 0 && !up)) signalCorrect++;
    signalReturns.push((s > 0 ? 1 : -1) * ((actual - now) / now));
  }

  const hitRate = signalTaken ? signalCorrect / signalTaken : null;
  const baseline = persistenceBaseline(bars, { horizon });

  return {
    available: true,
    horizon_bars: horizon,
    signal_opportunities: moves,
    signal_taken: signalTaken,
    signal_hit_rate_pct: hitRate == null ? null : round(hitRate * 100, 2),
    coinflip_hit_rate_pct: 50,
    edge_over_coinflip_pct: hitRate == null ? null : round((hitRate - 0.5) * 100, 2),
    mean_signal_return_pct: signalReturns.length
      ? round((signalReturns.reduce((a, b) => a + b, 0) / signalReturns.length) * 100, 4)
      : null,
    persistence_baseline: baseline,
    verdict: hitRate == null ? 'the signal never fired — nothing to evaluate'
      : hitRate > 0.5 ? `beats a coin flip by ${round((hitRate - 0.5) * 100, 2)} points on ${signalTaken} signals`
      : 'does NOT beat a coin flip',
    caveat: 'Directional hit rate ignores the SIZE of the moves. A signal right 55% of the time on small moves and wrong '
      + '45% on large ones loses money. Pair this with expectancy from backtest_evaluate, and with a deflated Sharpe '
      + 'if the signal was selected from several candidates.',
  };
}
