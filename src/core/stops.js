/**
 * When a stop-loss helps, and when it is just a tax on your returns.
 *
 * After Kaminski & Lo (2014), "When do stop-loss rules stop losses?",
 * Journal of Financial Markets 18, 234-254.
 *
 * ── The result ──
 *
 * They define the STOPPING PREMIUM: the marginal effect of a stop-loss rule on
 * expected return. Their central finding is uncomfortable and precise:
 *
 *   "If the portfolio follows a random walk the stopping premium is ALWAYS
 *    NEGATIVE... stop-loss rules simply force the portfolio out of
 *    higher-yielding assets on occasion, thereby lowering the overall expected
 *    return without adding any benefits. In such cases, stop-loss rules never
 *    stop losses."
 *
 * But under positive serial correlation — momentum — the stopping premium
 * "can be positive and is directly proportional to the magnitude of return
 * persistence."
 *
 * So a stop-loss is not universally prudent. It is a bet on persistence. In a
 * market with no persistence it is a guaranteed drag, and the more often it
 * triggers the larger the drag.
 *
 * ── Why this repo can act on it ──
 *
 * The condition is a property of the return process, and we already measure
 * it. `market_regime` reports an efficiency ratio; this module measures serial
 * correlation directly. Both are estimates of exactly the persistence
 * Kaminski & Lo require.
 *
 * That turns "always use a stop" from a slogan into a testable claim about the
 * chart in front of you.
 *
 * ── What this does NOT say ──
 *
 * It does not say "trade without a stop". Kaminski & Lo measure the effect on
 * EXPECTED RETURN, not on ruin. A stop is also a solvency constraint, and a
 * negative stopping premium is a price many traders should rationally pay to
 * bound a loss. This module quantifies the price; it does not tell anyone to
 * stop paying it.
 *
 * Their own empirical result is the other side: on stocks-versus-bonds futures
 * (Jan 1993 - Nov 2011), a monthly-interval stop raised return by 1.5%, cut
 * volatility by 5%, and lifted the Sharpe ratio by as much as 20% — which they
 * call "a remarkable feat for a buy-high/sell-low strategy". The premium was
 * positive over LONGER sampling frequencies, not short ones.
 *
 * All pure.
 */

const round = (n, dp = 4) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10 ** dp) / 10 ** dp);

/**
 * Lag-k autocorrelation of returns — the quantity the stopping premium is
 * proportional to.
 */
export function autocorrelation(returns, lag = 1) {
  const n = returns.length;
  if (n < lag + 3) return null;
  const mean = returns.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) den += (returns[i] - mean) ** 2;
  for (let i = lag; i < n; i++) num += (returns[i] - mean) * (returns[i - lag] - mean);
  return den === 0 ? null : num / den;
}

/** Simple returns from bars. */
function returnsOf(bars) {
  const r = [];
  for (let i = 1; i < bars.length; i++) r.push((bars[i].close - bars[i - 1].close) / bars[i - 1].close);
  return r;
}

/**
 * Is there enough persistence here for a stop-loss to pay for itself?
 *
 * Reports the measured autocorrelation at several lags with an approximate
 * significance band, and translates it into Kaminski & Lo's terms.
 */
export function stoppingPremium(bars, { lags = [1, 5, 10, 20], sampling_note = null } = {}) {
  if (!Array.isArray(bars) || bars.length < 40) {
    return { available: false, note: `Need at least 40 bars, have ${bars?.length ?? 0}.` };
  }
  const rets = returnsOf(bars);
  const n = rets.length;
  // Under the null of no autocorrelation, the standard error is ~1/sqrt(n).
  const se = 1 / Math.sqrt(n);
  const band = 1.96 * se;

  const measured = lags.map((lag) => {
    const ac = autocorrelation(rets, lag);
    return {
      lag,
      autocorrelation: round(ac),
      significant: ac == null ? null : Math.abs(ac) > band,
      sign: ac == null ? null : ac > 0 ? 'persistent (momentum)' : 'mean-reverting',
    };
  });

  const usable = measured.filter((m) => m.autocorrelation != null);
  const sig = usable.filter((m) => m.significant);
  const positiveSig = sig.filter((m) => m.autocorrelation > 0);
  const negativeSig = sig.filter((m) => m.autocorrelation < 0);

  let verdict, expectation;
  if (!sig.length) {
    verdict = 'no measurable persistence';
    expectation = 'NEGATIVE — this series is statistically indistinguishable from a random walk at these lags, and '
      + 'Kaminski & Lo show the stopping premium is always negative under a random walk. A stop here is expected to '
      + 'REDUCE return without adding return benefit. It may still be worth having as a solvency constraint; it is '
      + 'not worth having as a source of edge.';
  } else if (positiveSig.length && !negativeSig.length) {
    verdict = 'persistent';
    expectation = 'POSITIVE — significant positive serial correlation at '
      + positiveSig.map((m) => `lag ${m.lag}`).join(', ')
      + '. The stopping premium is proportional to persistence, so a stop-loss can add expected return here, not just cap losses.';
  } else if (negativeSig.length && !positiveSig.length) {
    verdict = 'mean-reverting';
    expectation = 'NEGATIVE and worse than the random-walk case — significant NEGATIVE serial correlation means losses '
      + 'tend to be followed by recoveries, so a stop systematically exits at the worst moment. This is the regime in '
      + 'which stops hurt most.';
  } else {
    verdict = 'mixed across horizons';
    expectation = 'AMBIGUOUS — persistence has different signs at different lags. The stop\'s holding horizon decides '
      + 'which one applies: match the lag to how long you intend the stop to be live.';
  }

  return {
    available: true,
    bars: bars.length,
    returns_used: n,
    significance_band: round(band),
    by_lag: measured,
    persistence_verdict: verdict,
    expected_stopping_premium: expectation,
    source: 'Kaminski & Lo (2014), Journal of Financial Markets 18, 234-254.',
    their_empirical_result: 'On stocks-vs-bonds futures 1993-2011 a monthly-interval stop raised return 1.5%, cut '
      + 'volatility 5% and lifted the Sharpe ratio by up to 20%. Crucially, the premium was positive over LONGER '
      + 'sampling frequencies — they found stops "of no value" at short-term sampling frequencies.',
    ...(sampling_note ? { sampling_note } : {}),
    what_this_is_not: 'This measures the effect on EXPECTED RETURN, not on risk of ruin. A negative stopping premium is '
      + 'a price, and bounding a loss is often worth paying it. Nothing here says trade without a stop — it says know '
      + 'what the stop costs.',
  };
}

/**
 * Compare a stop-loss policy against buy-and-hold over the SAME bars.
 *
 * The direct empirical version of the question, run on the actual series
 * rather than inferred from autocorrelation. `threshold_pct` is the drawdown
 * from entry that triggers the exit; after stopping out the policy stays in
 * cash for `cooldown_bars` before re-entering.
 */
export function backtestStop(bars, { threshold_pct = 8, cooldown_bars = 5, entry_index = 0 } = {}) {
  if (!Array.isArray(bars) || bars.length < entry_index + 10) {
    return { available: false, note: 'Not enough bars after the entry index.' };
  }
  const seg = bars.slice(entry_index);
  const start = seg[0].close;
  const end = seg[seg.length - 1].close;
  const buyHold = ((end - start) / start) * 100;

  let inMarket = true, entry = start, cash = 0, cooldown = 0, stops = 0;
  const stopReturns = [];
  for (let i = 1; i < seg.length; i++) {
    if (!inMarket) {
      if (--cooldown <= 0) { inMarket = true; entry = seg[i].close; }
      continue;
    }
    const dd = ((seg[i].low - entry) / entry) * 100;
    if (dd <= -threshold_pct) {
      const exit = entry * (1 - threshold_pct / 100);
      stopReturns.push(-threshold_pct);
      cash += (exit - entry) / entry;
      inMarket = false; cooldown = cooldown_bars; stops++;
    }
  }
  if (inMarket) {
    cash += (seg[seg.length - 1].close - entry) / entry;
    stopReturns.push(((seg[seg.length - 1].close - entry) / entry) * 100);
  }
  const stopped = cash * 100;

  return {
    available: true,
    bars: seg.length,
    threshold_pct,
    cooldown_bars,
    stops_triggered: stops,
    buy_and_hold_pct: round(buyHold, 2),
    with_stop_pct: round(stopped, 2),
    stopping_premium_pct: round(stopped - buyHold, 2),
    verdict: stopped > buyHold
      ? `The stop ADDED ${round(stopped - buyHold, 2)} points over buy-and-hold on these bars.`
      : `The stop COST ${round(buyHold - stopped, 2)} points against buy-and-hold on these bars.`,
    caveat: 'One path, one threshold, one symbol — this is an anecdote, not an estimate. It ignores the cost of each '
      + 'round trip, and it is exactly the kind of single-parameter result that deflated_sharpe exists to discount. '
      + 'Use stoppingPremium() for the structural answer and this only to see the mechanics on a specific chart.',
  };
}
