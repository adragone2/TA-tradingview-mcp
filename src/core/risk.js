/**
 * Risk arithmetic: expectancy, break-even win rate, Kelly, risk of ruin,
 * drawdown recovery, volatility-based sizing.
 *
 * `evaluateTrades` in backtest.js already computes expectancy — but only
 * BACKWARD, from trades that happened. This module works FORWARD, from a win
 * rate and a payoff the user supplies, which is the question actually being
 * asked before a trade: given what I think my edge is, how much should I risk
 * and what happens if I'm wrong about it.
 *
 * Two things worth stating up front, because both are ways this arithmetic
 * misleads:
 *
 *   1. **Win rate alone is meaningless.** An 80% win rate loses money if the
 *      losses are large enough, and a 30% win rate can be excellent. The number
 *      that decides it is expectancy, and the number that makes a win rate
 *      interpretable at all is the break-even win rate for that payoff. Both
 *      come back with every result here.
 *
 *   2. **Everything here is arithmetic on assumptions.** If the win rate came
 *      from twenty backtested trades it is noise, and Kelly computed on noise
 *      will size a position that ruins an account. `sample_size` is accepted
 *      precisely so the answer can say how much to trust itself.
 *
 * All pure. Nothing here places an order or advises a trade — it is arithmetic
 * on numbers the user supplied.
 */
const round = (n, dp = 4) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10 ** dp) / 10 ** dp);

/* --------------------------- expectancy & Kelly ------------------------- */

/**
 * The core trade arithmetic, from a win rate and a payoff.
 *
 * Payoff can be given either as `risk_reward` (reward ÷ risk) or as an explicit
 * `avg_win` / `avg_loss` pair. The pair is preferred when it is available,
 * because a strategy's real average win is rarely its target.
 *
 * Kelly answers "what fraction maximises long-run growth", and the answer it
 * gives is almost always far larger than anyone should trade. The reason is in
 * the assumption: Kelly takes the win rate and payoff as EXACT and CONSTANT.
 * Overestimate the win rate by a few points — trivially easy on a small sample —
 * and full Kelly stops being growth-optimal and starts being ruinous. So the
 * fractions are reported alongside, and the full figure carries its warning.
 */
export function tradeMath({
  win_rate_pct,
  risk_reward = null,
  avg_win = null,
  avg_loss = null,
  sample_size = null,
} = {}) {
  const W = Number(win_rate_pct);
  if (!Number.isFinite(W) || W < 0 || W > 100) {
    return { available: false, note: 'win_rate_pct must be a number between 0 and 100.' };
  }
  const win = W / 100;
  const loss = 1 - win;

  // Work out the payoff from whichever input was supplied.
  let R, avgWin = null, avgLoss = null, basis;
  if (Number.isFinite(avg_win) && Number.isFinite(avg_loss) && avg_loss > 0) {
    avgWin = avg_win; avgLoss = avg_loss;
    R = avg_win / avg_loss;
    basis = 'average win and average loss';
  } else if (Number.isFinite(risk_reward) && risk_reward > 0) {
    R = risk_reward;
    basis = 'risk:reward ratio';
  } else {
    return { available: false, note: 'Supply either risk_reward, or both avg_win and avg_loss (avg_loss positive).' };
  }

  // Expectancy in R units — the only comparable form across strategies.
  const expectancyR = win * R - loss * 1;
  const expectancyCash = avgWin != null ? win * avgWin - loss * avgLoss : null;

  const breakEven = 1 / (1 + R);
  const edge = win - breakEven;

  // Kelly for a two-outcome bet: W - L/R.
  const kelly = win - loss / R;

  const trustworthy = Number.isFinite(sample_size) && sample_size >= 100;

  return {
    available: true,
    win_rate_pct: round(W, 2),
    risk_reward: round(R, 3),
    payoff_basis: basis,
    ...(avgWin != null ? { avg_win: round(avgWin), avg_loss: round(avgLoss) } : {}),

    expectancy_r: round(expectancyR, 4),
    expectancy_cash: expectancyCash == null ? null : round(expectancyCash),
    profitable: expectancyR > 0,

    break_even_win_rate_pct: round(breakEven * 100, 2),
    edge_pct: round(edge * 100, 2),

    kelly_pct: round(Math.max(0, kelly) * 100, 2),
    half_kelly_pct: round(Math.max(0, kelly / 2) * 100, 2),
    quarter_kelly_pct: round(Math.max(0, kelly / 4) * 100, 2),

    verdict: expectancyR > 0
      ? `Positive expectancy: ${round(expectancyR, 3)}R per trade. At a ${round(R, 2)}:1 payoff you need to win ${round(breakEven * 100, 1)}% to break even and you are winning ${round(W, 1)}%.`
      : expectancyR === 0
        ? 'Exactly break-even. Costs and slippage make this a losing strategy in practice.'
        : `NEGATIVE expectancy: ${round(expectancyR, 3)}R per trade. At a ${round(R, 2)}:1 payoff you need ${round(breakEven * 100, 1)}% and you are winning ${round(W, 1)}%. No position size fixes this — sizing a losing edge only changes how fast it loses.`,

    win_rate_note: 'A win rate is uninterpretable without its payoff. Compare it to break_even_win_rate_pct, never to 50%.',

    kelly_warning: kelly > 0
      ? `Full Kelly here is ${round(kelly * 100, 1)}% of the account per trade. Kelly assumes the win rate and payoff above are exact and constant; they are neither. Overstating the win rate by a few points turns full Kelly from growth-optimal into ruinous. Half or quarter Kelly is the usual practice, and 1-2% is the usual practice for anyone whose numbers are not measured over hundreds of trades.`
      : 'Kelly is zero or negative — the arithmetic says do not take this trade at any size.',

    confidence: trustworthy
      ? `Based on ${sample_size} trades.`
      : Number.isFinite(sample_size)
        ? `Based on only ${sample_size} trades. A win rate from a sample this small carries an error bar wide enough to flip the sign of the edge. Treat the Kelly figures as unusable and size at 1-2%.`
        : 'No sample size given. If these numbers are estimates rather than measurements, the Kelly figures are arithmetic on a guess — size at 1-2% instead.',
  };
}

/* ------------------------------ risk of ruin ---------------------------- */

/** Deterministic PRNG, so the same inputs always give the same answer. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * How often a drawdown this deep happens, by simulation.
 *
 * The "survive first" number. Expectancy says whether the edge is positive;
 * this says whether the account lives long enough to collect it. A strategy
 * with a real edge still ruins an account if it is sized so that an ordinary
 * losing streak ends it.
 *
 * Fixed-fractional sizing is modelled — risking a percentage of the CURRENT
 * balance, which is why the account asymptotes toward zero rather than reaching
 * it exactly, and why ruin is defined as a drawdown threshold rather than as
 * hitting zero.
 *
 * Seeded, so the same question always gets the same answer. A risk figure that
 * moves each time it is asked is not one anybody can act on.
 */
export function riskOfRuin({
  win_rate_pct,
  risk_reward = 2,
  risk_per_trade_pct = 1,
  ruin_drawdown_pct = 50,
  trades = 200,
  simulations = 5000,
  seed = 12345,
} = {}) {
  const W = Number(win_rate_pct);
  const R = Number(risk_reward);
  const f = Number(risk_per_trade_pct) / 100;
  const ruinAt = 1 - Number(ruin_drawdown_pct) / 100;

  if (!Number.isFinite(W) || W < 0 || W > 100) return { available: false, note: 'win_rate_pct must be between 0 and 100.' };
  if (!Number.isFinite(R) || R <= 0) return { available: false, note: 'risk_reward must be positive.' };
  if (!Number.isFinite(f) || f <= 0 || f >= 1) return { available: false, note: 'risk_per_trade_pct must be between 0 and 100 (exclusive).' };
  if (!(ruinAt > 0 && ruinAt < 1)) return { available: false, note: 'ruin_drawdown_pct must be between 0 and 100 (exclusive).' };

  const win = W / 100;
  const rand = mulberry32(seed);

  let ruined = 0;
  let worstSum = 0;
  const finals = [];
  let longestLosing = 0;

  for (let s = 0; s < simulations; s++) {
    let equity = 1, peak = 1, worst = 0, streak = 0, hit = false;
    for (let t = 0; t < trades; t++) {
      const won = rand() < win;
      equity *= won ? 1 + f * R : 1 - f;
      if (won) streak = 0; else { streak++; if (streak > longestLosing) longestLosing = streak; }
      if (equity > peak) peak = equity;
      const dd = 1 - equity / peak;
      if (dd > worst) worst = dd;
      // Ruin measured from the peak, not the start — an account that doubled
      // and then halved has had the same experience as one that halved.
      if (equity / peak <= ruinAt) { hit = true; break; }
    }
    if (hit) ruined++;
    worstSum += worst;
    finals.push(equity);
  }

  finals.sort((a, b) => a - b);
  const median = finals[Math.floor(finals.length / 2)];
  const p05 = finals[Math.floor(finals.length * 0.05)];

  const ruinPct = (ruined / simulations) * 100;

  return {
    available: true,
    risk_of_ruin_pct: round(ruinPct, 2),
    inputs: {
      win_rate_pct: round(W, 2),
      risk_reward: round(R, 3),
      risk_per_trade_pct: round(risk_per_trade_pct, 3),
      ruin_drawdown_pct: round(ruin_drawdown_pct, 2),
      trades, simulations,
    },
    avg_worst_drawdown_pct: round((worstSum / simulations) * 100, 2),
    median_final_multiple: round(median, 4),
    worst_5pct_final_multiple: round(p05, 4),
    longest_losing_streak_seen: longestLosing,
    interpretation: ruinPct >= 10
      ? `A ${round(ruin_drawdown_pct, 0)}% drawdown happened in ${round(ruinPct, 1)}% of ${simulations} runs. That is not a tail risk, it is a likely outcome — cut risk per trade.`
      : ruinPct >= 1
        ? `A ${round(ruin_drawdown_pct, 0)}% drawdown happened in ${round(ruinPct, 1)}% of runs. Survivable, but not comfortable.`
        : `A ${round(ruin_drawdown_pct, 0)}% drawdown happened in ${round(ruinPct, 2)}% of runs. The sizing leaves room to survive a bad streak.`,
    method: `Monte Carlo over ${simulations} runs of ${trades} trades, fixed-fractional sizing on the current balance, seeded so the same inputs always give the same answer.`,
    caveat: 'Every trade is modelled as independent with a fixed payoff. Real trades cluster — losses arrive together in the regime that causes them — and real payoffs vary. This understates the tail rather than overstating it.',
  };
}

/* ---------------------------- drawdown recovery ------------------------- */

/**
 * What a drawdown costs to recover.
 *
 * The asymmetry is the single most useful fact in risk management and the one
 * most easily felt as smaller than it is: down 50% needs +100%, down 80% needs
 * +400%. It is why avoiding the large loss matters more than catching the large
 * win, and it is one line of arithmetic.
 */
export function recoveryRequired(drawdown_pct) {
  const d = Number(drawdown_pct) / 100;
  if (!Number.isFinite(d) || d <= 0 || d >= 1) {
    return { available: false, note: 'drawdown_pct must be between 0 and 100 (exclusive). A 100% loss cannot be recovered.' };
  }
  return {
    available: true,
    drawdown_pct: round(drawdown_pct, 2),
    gain_required_pct: round((d / (1 - d)) * 100, 2),
    remaining_pct: round((1 - d) * 100, 2),
  };
}

/** The recovery curve at a standard set of drawdowns, for showing the shape. */
export function recoveryTable(levels = [5, 10, 20, 30, 40, 50, 60, 70, 80, 90]) {
  const rows = levels
    .map((l) => recoveryRequired(l))
    .filter((r) => r.available)
    .map((r) => ({ drawdown_pct: r.drawdown_pct, gain_required_pct: r.gain_required_pct }));
  return {
    rows,
    note: 'The curve is not linear. Losses compound against you faster than gains compound for you, which is why capping the loss matters more than maximising the win.',
  };
}

/* --------------------------- volatility sizing -------------------------- */

/**
 * Position size from volatility rather than from a fixed price stop.
 *
 * Fixed-fractional sizing answers "how many shares for this stop". This answers
 * "where should the stop be, given how much this instrument moves, and then how
 * many shares" — so the position shrinks automatically when volatility rises
 * and the stop is not sitting inside the instrument's ordinary daily range.
 *
 * Both are reported when a manual stop is also supplied, because the difference
 * between them is the useful part: a manual stop far tighter than the ATR stop
 * is one the instrument's normal noise will hit.
 */
/* ------------------- sizing: three constraints, not one ----------------- */

/**
 * Shannon's caps (ch. 16). The risk figure is his and widely shared; the
 * concentration cap is his and much less often stated; the liquidity cap is
 * OURS, and labelled as such below because he gives no number for it.
 */
export const SIZING_CAPS = Object.freeze({
  risk_pct_default: 1,
  risk_pct_max: 2,
  /**
   * "exposing more than 15 to 20 percent of your account equity to any one
   * position can result in disastrous effects on your account balance if
   * something unexpected goes wrong."
   */
  max_position_pct_default: 20,
  /**
   * Shannon raises liquidity as a constraint — 6,666 shares of a 300,000-ADV
   * stock, "would you feel comfortable buying 6,000 shares?" — but never names
   * a threshold. 2% of average daily volume is a conventional low-impact
   * participation rate, not a figure from the book, and it is the default only
   * so the constraint is present rather than absent.
   */
  max_adv_pct_default: 2,
  source: 'Shannon, Technical Analysis Using Multiple Timeframes (2008), ch. 16. The ADV cap is this repo\'s choice.',
});

/**
 * Position size under ALL THREE constraints, returning the binding one.
 *
 * A fixed-risk formula on its own is unsafe, and Shannon's own worked example
 * is the demonstration. A $50 stock with a stop just below support at 49.25 has
 * $0.75 of risk per share. A $1,000 risk budget on a $100,000 account therefore
 * buys 1,333 shares — $66,650, or **65% of the account** in one idea. His own
 * comment: "But would you really want to commit 65% of your trading capital to
 * just one idea?"
 *
 * The mechanism is worth stating because it is counterintuitive: under fixed
 * risk, a TIGHTER stop buys MORE shares. So the better the entry, the more
 * likely the concentration cap binds — exactly when a trader feels most
 * justified in sizing up.
 *
 * His second example shows the third constraint binding instead: a $2.50 stock
 * with support 15 cents away gives 6,666 shares on the same $1,000 risk, which
 * is 2.2% of a 300,000-share ADV.
 *
 * So the answer is the MINIMUM of the three, and which one bound is the useful
 * part of the output. `sizePosition` already reported notional_pct_of_account
 * and then returned the risk-derived quantity anyway — reporting a constraint
 * is not applying it.
 *
 * `adv` is optional: without it the liquidity constraint is reported as
 * unavailable rather than silently passing.
 */
export function sizeWithConstraints({
  account_size,
  risk_percent = SIZING_CAPS.risk_pct_default,
  entry,
  stop,
  adv = null,
  max_position_pct = SIZING_CAPS.max_position_pct_default,
  max_adv_pct = SIZING_CAPS.max_adv_pct_default,
} = {}) {
  const acct = Number(account_size);
  const riskPct = Number(risk_percent);
  const px = Number(entry);
  const sl = Number(stop);

  if (!(acct > 0)) return { available: false, note: 'account_size must be positive.' };
  if (!(riskPct > 0 && riskPct <= 100)) return { available: false, note: 'risk_percent must be between 0 and 100.' };
  if (!(px > 0)) return { available: false, note: 'entry must be positive.' };
  if (!(sl > 0)) return { available: false, note: 'stop must be positive.' };

  const perUnit = Math.abs(px - sl);
  if (!(perUnit > 0)) {
    return { available: false, note: 'Entry and stop are the same price, so risk per share is zero and size is undefined.' };
  }

  const riskAmount = acct * (riskPct / 100);
  const constraints = [];

  // 1. Risk budget.
  const byRisk = riskAmount / perUnit;
  constraints.push({
    name: 'risk_budget',
    shares: byRisk,
    limit: `${round(riskPct, 3)}% of ${round(acct, 2)} = ${round(riskAmount, 2)} at risk, over ${round(perUnit, 6)}/share`,
  });

  // 2. Concentration cap.
  const maxNotional = acct * (Number(max_position_pct) / 100);
  const byConcentration = maxNotional / px;
  constraints.push({
    name: 'concentration_cap',
    shares: byConcentration,
    limit: `${round(Number(max_position_pct), 2)}% of account = ${round(maxNotional, 2)} notional, at ${round(px, 6)}/share`,
  });

  // 3. Liquidity. Absent ADV this is unknown, and unknown is not a pass.
  const advNum = Number(adv);
  const liquidityKnown = Number.isFinite(advNum) && advNum > 0;
  if (liquidityKnown) {
    constraints.push({
      name: 'liquidity',
      shares: advNum * (Number(max_adv_pct) / 100),
      limit: `${round(Number(max_adv_pct), 2)}% of ${round(advNum, 0)} average daily volume`,
    });
  }

  const binding = constraints.reduce((a, b) => (b.shares < a.shares ? b : a));
  const shares = binding.shares;
  const notional = shares * px;
  const actualRisk = shares * perUnit;

  // What the naive answer would have been, so the difference is visible.
  const suppressedBy = binding.name === 'risk_budget' ? null : round(byRisk - shares, 4);

  return {
    available: true,
    direction: px > sl ? 'long' : 'short',
    account_size: round(acct, 2),
    entry: round(px, 6),
    stop: round(sl, 6),
    risk_per_share: round(perUnit, 6),

    shares: round(shares, 4),
    shares_rounded: Math.floor(shares),
    notional: round(notional, 2),
    notional_pct_of_account: round((notional / acct) * 100, 2),
    risk_amount: round(actualRisk, 2),
    risk_pct_of_account: round((actualRisk / acct) * 100, 3),

    binding_constraint: binding.name,
    constraints: constraints
      .map((c) => ({
        name: c.name,
        shares: round(c.shares, 4),
        notional: round(c.shares * px, 2),
        limit: c.limit,
        binding: c.name === binding.name,
      }))
      .sort((a, b) => a.shares - b.shares),

    ...(liquidityKnown
      ? { pct_of_adv: round((shares / advNum) * 100, 3) }
      : {
          liquidity_constraint: 'NOT CHECKED — no adv supplied. This is unknown, not satisfied. Pass adv (from '
            + 'data_get_ohlcv or short_interest) to apply it.',
        }),

    ...(suppressedBy
      ? {
          risk_budget_would_have_bought: round(byRisk, 4),
          suppressed_shares: suppressedBy,
          why: binding.name === 'concentration_cap'
            ? `The ${round(riskPct, 3)}% risk budget alone would have bought ${round(byRisk, 4)} shares — `
              + `${round(((byRisk * px) / acct) * 100, 1)}% of the account in one position. Under fixed risk a TIGHTER stop `
              + 'buys MORE shares, so the concentration cap binds precisely when the entry looks best. '
              + 'Shannon\'s own example produced 65% of capital this way.'
            : `The ${round(riskPct, 3)}% risk budget alone would have bought ${round(byRisk, 4)} shares, which is `
              + `${round(((byRisk / advNum) * 100), 2)}% of average daily volume. A position that size moves the price `
              + 'it is trying to get, and it is harder to exit than to enter.',
        }
      : {
          why: 'The risk budget is the tightest of the three constraints here, so it sets the size.',
        }),

    caps_applied: {
      risk_percent: round(riskPct, 3),
      max_position_pct: round(Number(max_position_pct), 2),
      ...(liquidityKnown ? { max_adv_pct: round(Number(max_adv_pct), 2) } : {}),
    },
    source: SIZING_CAPS.source,
    note: 'Arithmetic on numbers supplied. The answer is the MINIMUM across constraints — reporting a constraint is not '
      + 'applying it. Not advice, and it places no order.',
  };
}

export function sizeByVolatility({
  account_size,
  risk_percent,
  entry,
  atr,
  atr_multiple = 2,
  direction = 'long',
  manual_stop = null,
} = {}) {
  const acct = Number(account_size), riskPct = Number(risk_percent);
  const px = Number(entry), a = Number(atr), mult = Number(atr_multiple);

  if (!(acct > 0)) return { available: false, note: 'account_size must be positive.' };
  if (!(riskPct > 0 && riskPct <= 100)) return { available: false, note: 'risk_percent must be between 0 and 100.' };
  if (!(px > 0)) return { available: false, note: 'entry must be positive.' };
  if (!(a > 0)) return { available: false, note: 'atr must be positive. Read it from the chart with data_get_study_values.' };
  if (!(mult > 0)) return { available: false, note: 'atr_multiple must be positive.' };

  const long = direction !== 'short';
  const riskAmount = acct * (riskPct / 100);
  const stopDistance = a * mult;
  const atrStop = long ? px - stopDistance : px + stopDistance;
  const shares = riskAmount / stopDistance;

  const out = {
    available: true,
    direction: long ? 'long' : 'short',
    account_size: round(acct, 2),
    risk_percent: round(riskPct, 3),
    risk_amount: round(riskAmount, 2),
    entry: round(px, 6),
    atr: round(a, 6),
    atr_multiple: round(mult, 2),
    stop_distance: round(stopDistance, 6),
    stop_price: round(atrStop, 6),
    shares: round(shares, 4),
    shares_rounded: Math.floor(shares),
    position_value: round(shares * px, 2),
    stop_distance_pct: round((stopDistance / px) * 100, 2),
    note: 'The stop is placed a multiple of ATR away, so the position shrinks when the instrument gets more volatile and the stop stays outside its ordinary range.',
  };

  if (Number.isFinite(manual_stop) && manual_stop > 0) {
    const manualDistance = Math.abs(px - manual_stop);
    if (manualDistance > 0) {
      const manualShares = riskAmount / manualDistance;
      out.manual_stop = {
        stop_price: round(manual_stop, 6),
        stop_distance: round(manualDistance, 6),
        atr_multiples_away: round(manualDistance / a, 2),
        shares: round(manualShares, 4),
        shares_rounded: Math.floor(manualShares),
        comparison: manualDistance < a
          ? `That stop is only ${round(manualDistance / a, 2)}x ATR from entry — inside this instrument's ordinary bar range. Normal noise will hit it.`
          : manualDistance < stopDistance
            ? `Tighter than the ${mult}x ATR stop: more shares, but a higher chance of being stopped out by noise rather than by being wrong.`
            : `Wider than the ${mult}x ATR stop: fewer shares, and more room before the trade is proven wrong.`,
      };
    }
  }

  return out;
}
