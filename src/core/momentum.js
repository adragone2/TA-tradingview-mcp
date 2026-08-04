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
 * Nearness to the 52-week high, after George & Hwang (2004), Journal of
 * Finance — the ranking variable this toolchain has been computing all along
 * without knowing what it was.
 *
 * Their measure is simply:
 *
 *     P(t) / max(price over the trailing 12 months)
 *
 * which is `1 - off_high_pct/100`. Every chart read in this repo already
 * reports "X% off its high". That number is the George-Hwang signal.
 *
 * ── Why it matters, and why it is counter-intuitive ──
 *
 * Ranking all CRSP stocks by this ratio and buying the top 30% while selling
 * the bottom 30% produced returns roughly TWICE those of Jegadeesh-Titman
 * momentum after controlling for size and bid-ask bounce. Excluding January,
 * 1.23% per month against JT's 1.07%. And unlike JT momentum, **the profits do
 * not reverse in the long run.**
 *
 * The instinct that a stock near its high is "extended" and needs a pullback
 * is the opposite of what the data says. Their explanation is anchoring:
 * traders treat the 52-week high as a reference point and are reluctant to bid
 * through it even when news warrants it, so the information prevails gradually
 * — which is a continuation.
 *
 * ── The part that must be said every time ──
 *
 * This is a CROSS-SECTIONAL result. It describes a portfolio long the top 30%
 * and short the bottom 30% of a thousand-plus names. It is not a statement
 * about one stock, and src/core/breadth.js exists to do that division.
 */
export function fiftyTwoWeekHigh(bars, { lookback = 252 } = {}) {
  if (!Array.isArray(bars) || bars.length < 30) {
    return { available: false, note: `Need at least 30 bars, have ${bars?.length ?? 0}.` };
  }
  const window = bars.slice(-Math.min(lookback, bars.length));
  const covers = window.length;
  const high = Math.max(...window.map((b) => b.high));
  const low = Math.min(...window.map((b) => b.low));
  const price = bars[bars.length - 1].close;
  const ratio = price / high;

  // George & Hwang cut at the top and bottom 30% of the cross-section. Without
  // a cross-section we cannot assign a percentile, so this reports the raw
  // ratio and refuses to invent a rank.
  return {
    available: true,
    ratio: round(ratio, 4),
    pct_of_52w_high: round(ratio * 100, 2),
    off_high_pct: round((1 - ratio) * 100, 2),
    high: round(high, 4),
    low: round(low, 4),
    price: round(price, 4),
    bars_covered: covers,
    ...(covers < lookback
      ? { warning: `Only ${covers} bars available for a ${lookback}-bar window, so this is a ${covers}-bar high, not a 52-week high. Load more history.` }
      : {}),
    at_new_high: price >= high * 0.999,
    evidence: 'George & Hwang (2004): ranking stocks by this ratio and buying the top 30% while selling the bottom 30% '
      + 'returned roughly TWICE Jegadeesh-Titman momentum after size and bid-ask controls (1.23% vs 1.07% per month '
      + 'ex-January), and the profits do NOT reverse long-run.',
    counter_intuition: 'Nearness to the 52-week high PREDICTS CONTINUATION. The instinct that a stock at its high is '
      + 'extended and owed a pullback is the opposite of the measured result. The proposed mechanism is anchoring: '
      + 'traders will not bid through the reference point even when the news justifies it.',
    breadth_caveat: 'CROSS-SECTIONAL result — a portfolio of 1000+ names ranked against each other. This function reports '
      + 'the raw ratio and deliberately does NOT assign a percentile, because one chart has no cross-section. '
      + 'Use breadth.singleNameExpectation("fifty_two_week_high") for what the edge is worth at your position count.',
  };
}

/**
 * Moving Average Distance, after Avramov, Kaplanski & Subrahmanyam (2021),
 * Review of Financial Economics 39(2), 127-145.
 *
 * MAD is the ratio of a short-run moving average to a long-run one:
 *
 *     MAD = SMA(short) / SMA(long)
 *
 * Their result is unusually strong for a technical signal. Annualized
 * value-weighted alphas from the hedge portfolios are around **9%**, the
 * predictability goes **beyond momentum, 52-week highs, profitability and
 * other prominent anomalies**, and — rare in this literature — the payoffs
 * **survive reasonable trading costs faced by institutions**. The effect is
 * stronger on the long side than the short.
 *
 * This is the same quantity a moving-average ribbon displays, expressed as a
 * number rather than a colour. Han, Zhou & Zhu (2016) build a related "trend
 * factor" by combining short, intermediate and long MA signals, and report
 * more than DOUBLE the Sharpe of short-term reversal, momentum and long-term
 * reversal used separately.
 *
 * The usual caveat applies and is not decoration: this is a CROSS-SECTIONAL
 * hedge portfolio. See breadth.js.
 */
export function movingAverageDistance(bars, { short_window = 21, long_window = 200 } = {}) {
  if (!Array.isArray(bars) || bars.length < long_window) {
    return {
      available: false,
      note: `MAD needs ${long_window} bars for the long average; only ${bars?.length ?? 0} loaded. `
        + 'This is missing data, not a neutral reading.',
    };
  }
  const closes = bars.map((b) => b.close);
  const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const shortMa = avg(closes.slice(-short_window));
  const longMa = avg(closes.slice(-long_window));
  if (!(longMa > 0)) return { available: false, note: 'Long moving average is not positive.' };

  const mad = shortMa / longMa;
  return {
    available: true,
    mad: round(mad, 4),
    mad_pct: round((mad - 1) * 100, 2),
    short_ma: round(shortMa, 4),
    long_ma: round(longMa, 4),
    short_window,
    long_window,
    direction: mad > 1 ? 'short above long' : mad < 1 ? 'short below long' : 'flat',
    evidence: 'Avramov, Kaplanski & Subrahmanyam (2021): annualized value-weighted alphas around 9% from MAD hedge '
      + 'portfolios, with predictability BEYOND momentum, 52-week highs and profitability, and payoffs that survive '
      + 'reasonable institutional trading costs. Stronger on the long side than the short.',
    related: 'Han, Zhou & Zhu (2016) combine short, intermediate and long MA signals into a trend factor reporting more '
      + 'than double the Sharpe of short-term reversal, momentum and long-term reversal taken separately.',
    breadth_caveat: 'CROSS-SECTIONAL hedge-portfolio result. The 9% alpha belongs to a ranked long-short book, not to '
      + 'one stock. Use edge_breadth before quoting it at a single chart.',
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

/**
 * EXTENSION PERCENTILE — how stretched is price from its moving average,
 * ranked against this symbol's OWN history of that same distance.
 *
 * The Minervini practitioners call this "historical extension levels" and use
 * it for the SELLING side: a stock trading further above its 50-day than it
 * has been on ~95% of its own past days is statistically stretched, which is
 * where their sell-into-strength policy leaks shares out (MPA podcast, read
 * 2026-08-03). This is a DESCRIPTION of where today sits in the symbol's own
 * distribution — deliberately not a signal: nothing here says stretched
 * cannot get more stretched, and no forward edge has been measured.
 *
 * Percentile is the share of historical distances at or below today's, over
 * every bar where the average is defined. Signed on purpose: deep BELOW the
 * average reads as a low percentile, not as "also extended" — the selling
 * question is one-sided.
 */
export function extensionPercentile(bars, { ma_period = 50, min_history = 120 } = {}) {
  if (!Array.isArray(bars) || bars.length < ma_period + min_history) {
    return {
      available: false,
      why: `needs ${ma_period + min_history} bars (${ma_period}-bar average + ${min_history} of history to rank against), got ${bars?.length ?? 0}`,
    };
  }
  const closes = bars.map((b) => b.close);
  const distances = [];
  let sum = 0;
  for (let i = 0; i < closes.length; i++) {
    sum += closes[i];
    if (i >= ma_period) sum -= closes[i - ma_period];
    if (i >= ma_period - 1) {
      const sma = sum / ma_period;
      distances.push(((closes[i] - sma) / sma) * 100);
    }
  }
  const today = distances[distances.length - 1];
  const atOrBelow = distances.filter((d) => d <= today).length;
  const r = (x) => Math.round(x * 100) / 100;
  return {
    available: true,
    ma_period,
    distance_pct: r(today),
    percentile: r((atOrBelow / distances.length) * 100),
    n: distances.length,
    max_seen_pct: r(Math.max(...distances)),
    min_seen_pct: r(Math.min(...distances)),
    note: 'Descriptive rank of today\'s stretch within this symbol\'s own history — for the selling-into-strength '
      + 'side, never an entry signal. Stretched can get more stretched; no forward edge is measured here.',
  };
}
