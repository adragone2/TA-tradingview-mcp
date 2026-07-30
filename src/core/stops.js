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
/* ----------------------- the pivot ratchet (Shannon) --------------------- */

/**
 * Shannon's HARD TRAILING STOP (ch. 16, Figures 16.4 and 16.5), as an algorithm.
 *
 * Every trailing stop in common use is a distance rule — an ATR multiple, a
 * percentage, a moving average. This one is not. It is a *definition* rule:
 *
 *   "A hard trailing stop is based on the very definition of the trends from
 *    which you are attempting to extract money. As we know, the definition of
 *    an uptrend is 'a series of higher highs and higher lows.' This implies
 *    that breaking the series of higher lows is a violation of the trend, and
 *    that is a reason to sell."
 *
 * So the mechanic, from his own figure caption: "the trailing stop is raised to
 * a level just below the higher low (even numbers) after the stock establishes
 * new highs (odd numbers). For example, as the stock clears point 5, the stop
 * is raised from point 4 to point 6. This process is repeated until the stock
 * establishes a lower low." Shorts mirror it: a new lower LOW promotes the stop
 * to just above the most recent lower HIGH.
 *
 * Two properties that matter and are easy to get wrong:
 *
 *   1. **A new extreme is the trigger, not the pullback itself.** The stop moves
 *      only once a higher high CONFIRMS that the prior higher low held. Moving
 *      it on every new low would be a distance rule wearing a pivot costume.
 *
 *   2. **It is a one-directional ratchet.** Shannon: "the ONLY time stops should
 *      be changed on short trades is when the market moves in your favor and you
 *      are reducing risk." A step that would loosen the stop is refused and
 *      counted, because a loosening trail is the failure mode this replaces.
 *
 * ── The honest caveat ──
 *
 * A trailing stop is a bet on PERSISTENCE. Kaminski & Lo prove the stopping
 * premium is always negative under a random walk, and `stoppingPremium` in this
 * same module measures whether a given series has any. On 9 of 12 of this
 * account's real holdings it found none. So this function computes where the
 * stop goes; it makes no claim that trailing pays. Shannon's justification is
 * definitional rather than empirical — the stop moves to where the trend
 * definition would break — which is a cleaner argument than "protect profits"
 * and is worth keeping distinct from an edge claim.
 *
 * `swings` is an alternating high/low sequence from `alternateSwings`, ideally
 * already labelled by `classifyStructure`. Only CONFIRMED pivots exist, so the
 * stop necessarily lags the last few bars — that lag is the cost of not
 * inventing structure that has not happened.
 *
 * Pure.
 */
export function pivotTrail(swings, { direction = 'long', initial_stop = null, buffer_pct = 0 } = {}) {
  const long = direction !== 'short';
  const alt = Array.isArray(swings) ? swings.filter((s) => s && Number.isFinite(s.price)) : [];
  if (alt.length < 3) {
    return {
      available: false,
      note: `Need at least 3 alternating swings to trail; got ${alt.length}. `
        + 'A pivot stop cannot exist before the structure it is defined by.',
    };
  }

  const buf = Math.max(0, Number(buffer_pct) || 0) / 100;
  // "Just below" the higher low for a long; "just above" the lower high for a
  // short. Zero buffer sits exactly on the pivot, which is a real choice — a
  // stop AT the low is hit by a tick that equals it.
  const place = (price) => (long ? price * (1 - buf) : price * (1 + buf));

  const steps = [];
  let stop = Number.isFinite(initial_stop) ? Number(initial_stop) : null;
  let bestExtreme = null;   // highest high so far (long) / lowest low (short)
  let anchor = null;        // the pullback pivot the stop would move to
  let refusedLoosenings = 0;
  let invalidated = null;

  for (const s of alt) {
    const isExtremeKind = long ? s.kind === 'high' : s.kind === 'low';

    if (isExtremeKind) {
      const extends_ = bestExtreme === null
        || (long ? s.price > bestExtreme.price : s.price < bestExtreme.price);
      if (extends_) {
        bestExtreme = s;
        // A new extreme CONFIRMS the prior pullback pivot held, so promote to it.
        if (anchor) {
          const candidate = place(anchor.price);
          const tighter = stop === null || (long ? candidate > stop : candidate < stop);
          if (tighter) {
            steps.push({
              trigger: { kind: s.kind, price: round(s.price, 6), time: s.time ?? null, label: s.label ?? null },
              stop_moved_to: round(candidate, 6),
              from_pivot: { kind: anchor.kind, price: round(anchor.price, 6), time: anchor.time ?? null },
              ...(stop === null ? {} : { previous_stop: round(stop, 6) }),
            });
            stop = candidate;
          } else {
            // Refusing this is the ratchet. Counted rather than hidden, because
            // a trail that ever loosens is not the rule Shannon states.
            refusedLoosenings += 1;
          }
        }
      }
    } else {
      // A pullback pivot. It becomes the next anchor only while the trend holds.
      const breaks = anchor !== null
        && (long ? s.price < anchor.price : s.price > anchor.price);
      if (breaks && bestExtreme) {
        // A lower low in an uptrend: "This process is repeated UNTIL the stock
        // establishes a lower low."
        invalidated = invalidated || {
          at: { kind: s.kind, price: round(s.price, 6), time: s.time ?? null },
          reason: long
            ? 'A LOWER LOW broke the series of higher lows, so the uptrend definition is violated and the trail stops here.'
            : 'A HIGHER HIGH broke the series of lower highs, so the downtrend definition is violated and the trail stops here.',
        };
      }
      anchor = s;
    }
  }

  const lastPivotHeld = anchor && stop !== null
    ? (long ? place(anchor.price) <= stop : place(anchor.price) >= stop)
    : null;

  return {
    available: stop !== null,
    direction: long ? 'long' : 'short',
    stop: round(stop, 6),
    ...(stop === null
      ? {
          note: 'No new extreme confirmed a pullback pivot, so the stop never moved. Hold the initial protective stop — '
            + 'Shannon places that "just under the most recent higher low" for a long, "just above the most recent lower high" for a short.',
        }
      : {}),
    steps,
    steps_taken: steps.length,
    buffer_pct: round(buf * 100, 4),
    ...(Number.isFinite(initial_stop) ? { initial_stop: round(Number(initial_stop), 6) } : {}),
    anchor_pivot: anchor ? { kind: anchor.kind, price: round(anchor.price, 6), time: anchor.time ?? null } : null,
    best_extreme: bestExtreme ? { kind: bestExtreme.kind, price: round(bestExtreme.price, 6), time: bestExtreme.time ?? null } : null,
    // A pending pivot the trail has not yet promoted: the next new extreme will.
    ...(anchor && stop !== null && !lastPivotHeld
      ? {
          pending_promotion: {
            to: round(place(anchor.price), 6),
            waiting_for: long ? 'a new higher high to confirm this higher low held' : 'a new lower low to confirm this lower high held',
          },
        }
      : {}),
    ratchet_refusals: refusedLoosenings,
    ...(refusedLoosenings
      ? {
          ratchet_note: `${refusedLoosenings} candidate step(s) would have LOOSENED the stop and were refused. `
            + 'Shannon: the only time a stop should change is when the market moves in your favour.',
        }
      : {}),
    ...(invalidated ? { trend_invalidated: invalidated } : {}),
    persistence_caveat:
      'A trailing stop is a bet on persistence. Kaminski & Lo prove the stopping premium is always NEGATIVE under a '
      + 'random walk — run stoppingPremium on this series before treating the trail as an edge. Shannon\'s own '
      + 'justification is definitional, not empirical: the stop sits where the trend definition would break.',
    source: 'Shannon, Technical Analysis Using Multiple Timeframes (2008), ch. 16, Figures 16.4 and 16.5.',
  };
}

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
