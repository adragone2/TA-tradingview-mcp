/**
 * Transaction costs, and what they do to an edge.
 *
 * The rule this repo enforces everywhere else is that a backtest without a
 * benchmark flatters itself. A backtest without COSTS does the same thing and
 * this one had none: `resolveTrade` fills at the exact stop or target price,
 * with no spread, no slippage, no commission and no borrow. Those are free
 * money that does not exist.
 *
 * The effect is not small and it is not uniform. Costs are charged per trade,
 * so they scale with turnover: a strategy taking 200 trades a year at 1R each
 * pays a hundred times what a strategy taking 2 trades pays for the same gross
 * edge. That is why a high-frequency strategy with a thin edge can backtest
 * beautifully and lose money live, and it is the single most common way a
 * backtest lies.
 *
 * ── What is modelled, and what cannot be ──
 *
 * Modelled: commission (per share or per trade), spread, slippage as a fraction
 * of ATR, and borrow cost for shorts held over days.
 *
 * NOT modelled, and no amount of arithmetic fixes it: gaps THROUGH a stop.
 * `resolveTrade` fills at the stop price, but a stop is a market order once
 * touched — an overnight gap fills far below it, and that is where the real
 * tail lives. `gapRisk` measures how often the bars actually gapped past a stop
 * distance so the size of the unmodelled risk can at least be stated.
 *
 * All pure.
 */
const round = (n, dp = 6) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10 ** dp) / 10 ** dp);

/**
 * Cost presets.
 *
 * `ibkr_pro_fixed` is the real published schedule for US stocks and ETFs, taken
 * from Interactive Brokers' commissions page (July 2026): USD 0.005 per share,
 * minimum USD 1.00 per order, maximum 1% of trade value. Regulatory fees pass
 * through on top and are not modelled here.
 *
 * The minimum is the part that matters and the part a naive model omits. A
 * 100-share order is USD 0.50 of per-share commission and USD 1.00 of actual
 * charge — double. At 50 shares it is quadruple. Small orders are where cost
 * assumptions break, and they break in the direction that flatters a backtest.
 *
 * Everything else here is an ORDER-OF-MAGNITUDE starting point, not a quoted
 * schedule. Override them with real numbers from a real broker.
 */
export const COST_PRESETS = {
  ibkr_pro_fixed: {
    commission_per_share: 0.005, commission_min_per_order: 1.00, commission_max_pct_of_trade: 1,
    spread_pct: 0.02, slippage_atr: 0.05, borrow_apr_pct: 8,
    source: 'Interactive Brokers, IBKR Pro Fixed, US stocks/ETFs (published schedule, July 2026). Regulatory fees pass through on top and are not modelled.',
  },
  ibkr_pro_tiered: {
    commission_per_share: 0.0035, commission_min_per_order: 0.35, commission_max_pct_of_trade: 1,
    spread_pct: 0.02, slippage_atr: 0.05, borrow_apr_pct: 8,
    source: 'Interactive Brokers, IBKR Pro Tiered, US stocks/ETFs at the lowest volume tier. Exchange, clearing and pass-through fees are ADDITIONAL and not modelled — tiered is not simply cheaper than fixed.',
  },
  us_equity_zero_commission: { commission_per_share: 0, spread_pct: 0.03, slippage_atr: 0.07, borrow_apr_pct: 10 },
  crypto: { commission_pct: 0.10, spread_pct: 0.05, slippage_atr: 0.10, borrow_apr_pct: 15 },
  forex_major: { spread_pct: 0.015, slippage_atr: 0.03, borrow_apr_pct: 0 },
  futures: { commission_per_trade: 4.0, spread_pct: 0.005, slippage_atr: 0.05, borrow_apr_pct: 0 },
};

/**
 * The round-trip cost of one trade, in currency and in R.
 *
 * R is the useful unit. A strategy's edge is quoted in R, so a cost of 0.15R
 * per trade is immediately comparable to an expectancy of 0.35R — and makes it
 * obvious that the edge just shrank by 43%.
 */
export function tradeCost({
  entry,
  stop = null,
  shares = 1,
  bars_held = 1,
  direction = 'long',
  bars_per_year = 252,
  preset = null,
  commission_per_share = 0,
  commission_per_trade = 0,
  commission_pct = 0,
  spread_pct = 0,
  slippage_atr = 0,
  atr = null,
  borrow_apr_pct = 0,
  commission_min_per_order = null,
  commission_max_pct_of_trade = null,
} = {}) {
  const px = Number(entry);
  if (!(px > 0)) return { available: false, note: 'entry must be a positive price.' };
  const qty = Number(shares);
  if (!(qty > 0)) return { available: false, note: 'shares must be positive.' };

  const p = preset && COST_PRESETS[preset] ? COST_PRESETS[preset] : {};
  const cps = commission_per_share || p.commission_per_share || 0;
  const cpt = commission_per_trade || p.commission_per_trade || 0;
  const cpc = commission_pct || p.commission_pct || 0;
  const sprd = spread_pct || p.spread_pct || 0;
  const slipA = slippage_atr || p.slippage_atr || 0;
  const borrow = borrow_apr_pct || p.borrow_apr_pct || 0;

  const minOrder = commission_min_per_order ?? p.commission_min_per_order ?? 0;
  const maxPct = commission_max_pct_of_trade ?? p.commission_max_pct_of_trade ?? null;

  const notional = px * qty;

  // Commission PER LEG, so the minimum and maximum apply per order the way a
  // broker actually charges them. Applying them to the round trip would halve
  // the effect of the minimum, which is the whole reason small orders hurt.
  let perLeg = (cps * qty) + cpt + (notional * (cpc / 100));
  const rawPerLeg = perLeg;
  if (minOrder > 0) perLeg = Math.max(perLeg, minOrder);
  if (maxPct != null) perLeg = Math.min(perLeg, notional * (maxPct / 100));
  const commission = perLeg * 2;
  const minimumBinding = minOrder > 0 && rawPerLeg < minOrder;

  // Crossing the spread costs half of it on each leg — one full spread round trip.
  const spread = notional * (sprd / 100);

  // Slippage as a fraction of ATR, per leg. Expressed in ATR because that is
  // how much the instrument actually moves; a fixed cent value is meaningless
  // across a $3 stock and a $600 one.
  const slippage = Number.isFinite(atr) && atr > 0 ? atr * slipA * qty * 2 : 0;
  const slippageEstimated = !(Number.isFinite(atr) && atr > 0) && slipA > 0;

  // Borrow only applies to shorts, and only for the days actually held.
  const days = Math.max(0, bars_held) * (252 / bars_per_year);
  const borrowCost = direction === 'short' && borrow > 0
    ? notional * (borrow / 100) * (days / 252)
    : 0;

  const total = commission + spread + slippage + borrowCost;
  const riskPerShare = Number.isFinite(stop) ? Math.abs(px - stop) : null;
  const rValue = riskPerShare ? riskPerShare * qty : null;

  return {
    available: true,
    total: round(total, 4),
    breakdown: {
      commission: round(commission, 4),
      spread: round(spread, 4),
      slippage: round(slippage, 4),
      borrow: round(borrowCost, 4),
    },
    notional: round(notional, 2),
    cost_pct_of_notional: round((total / notional) * 100, 4),
    cost_in_r: rValue ? round(total / rValue, 4) : null,
    ...(slippageEstimated
      ? { slippage_warning: 'Slippage was NOT included: it is expressed as a fraction of ATR and no ATR was supplied. The total is therefore optimistic. Read ATR from the chart with data_get_study_values.' }
      : {}),
    ...(rValue ? {} : { r_note: 'Pass `stop` to get the cost in R, which is the unit that makes it comparable to expectancy.' }),
    ...(minimumBinding ? {
      minimum_binding: true,
      minimum_note: `The per-order MINIMUM is what you pay, not the per-share rate. ${qty} shares would be ${round(rawPerLeg, 4)} per leg on rate alone; the minimum of ${minOrder} applies instead, so this order costs ${round((minOrder / Math.max(rawPerLeg, 1e-9)), 1)}x the naive figure. Small orders are where cost assumptions break.`,
    } : {}),
    ...(p.source ? { preset_source: p.source } : {}),
    note: 'A round trip: both legs are charged. Costs scale with turnover, so the same per-trade figure hurts a 200-trade strategy a hundred times more than a 2-trade one.',
  };
}

/**
 * What costs do to a stated edge.
 *
 * The number that matters is not the cost per trade, it is the fraction of the
 * edge the cost consumes. An 0.35R edge paying 0.15R per trade has lost 43% of
 * itself, and a strategy whose edge is smaller than its costs is a losing
 * strategy no matter how good the backtest looked.
 */
export function applyCostsToEdge({ expectancy_r, cost_in_r, trades_per_year = null } = {}) {
  const e = Number(expectancy_r), c = Number(cost_in_r);
  if (!Number.isFinite(e)) return { available: false, note: 'expectancy_r is required.' };
  if (!Number.isFinite(c) || c < 0) return { available: false, note: 'cost_in_r must be zero or positive.' };

  const net = e - c;
  const consumed = e > 0 ? (c / e) * 100 : null;

  return {
    available: true,
    gross_expectancy_r: round(e, 4),
    cost_in_r: round(c, 4),
    net_expectancy_r: round(net, 4),
    edge_consumed_pct: consumed == null ? null : round(consumed, 1),
    still_profitable: net > 0,
    ...(Number.isFinite(trades_per_year)
      ? {
          gross_r_per_year: round(e * trades_per_year, 2),
          net_r_per_year: round(net * trades_per_year, 2),
          cost_r_per_year: round(c * trades_per_year, 2),
        }
      : {}),
    verdict: net <= 0
      ? `Costs eat the entire edge. Gross ${round(e, 3)}R per trade against ${round(c, 3)}R of costs leaves ${round(net, 3)}R — this strategy loses money in practice however the backtest looked.`
      : consumed >= 50
        ? `Costs consume ${round(consumed, 0)}% of the edge. ${round(net, 3)}R survives per trade. An edge this thin relative to its costs is fragile: a modest worsening in spread or fills turns it negative.`
        : `Costs consume ${round(consumed, 0)}% of the edge, leaving ${round(net, 3)}R per trade.`,
    note: 'Cost per trade scales with turnover. Halving the number of trades for the same gross R per trade halves the cost drag.',
  };
}

/**
 * How often price GAPPED past a given stop distance.
 *
 * The cost model above cannot fix this and neither can any other: a stop is a
 * market order once touched, so a gap fills wherever the open lands, not at the
 * stop. `resolveTrade` fills at the stop price exactly, which means every
 * backtest here understates its worst losses.
 *
 * This does not correct that — it measures how often it would have happened, so
 * the size of the unmodelled risk can be stated instead of ignored.
 */
export function gapRisk(bars, { stop_distance_pct = 2 } = {}) {
  if (!Array.isArray(bars) || bars.length < 2) {
    return { available: false, note: 'Need at least two bars.' };
  }
  const d = Number(stop_distance_pct) / 100;
  if (!(d > 0)) return { available: false, note: 'stop_distance_pct must be positive.' };

  let gapsDown = 0, gapsThrough = 0, worst = 0, worstTime = null;
  const overnight = [];

  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1].close, open = bars[i].open;
    if (!Number.isFinite(prev) || !Number.isFinite(open) || prev <= 0) continue;
    const move = (open - prev) / prev;
    overnight.push(Math.abs(move));
    if (move < 0) gapsDown++;
    // A long stop `d` below the prior close is jumped when the open is lower.
    if (-move > d) {
      gapsThrough++;
      if (-move > worst) { worst = -move; worstTime = bars[i].time; }
    }
  }

  const n = overnight.length;
  const mean = n ? overnight.reduce((a, b) => a + b, 0) / n : 0;
  const sorted = [...overnight].sort((a, b) => a - b);
  const p95 = n ? sorted[Math.floor(n * 0.95)] : 0;

  return {
    available: true,
    bars_examined: n,
    stop_distance_pct: round(stop_distance_pct, 3),
    gapped_through_count: gapsThrough,
    gapped_through_pct: n ? round((gapsThrough / n) * 100, 2) : 0,
    worst_gap_pct: round(worst * 100, 2),
    worst_gap_time: worstTime,
    average_overnight_move_pct: round(mean * 100, 3),
    p95_overnight_move_pct: round(p95 * 100, 3),
    gaps_down_pct: n ? round((gapsDown / n) * 100, 1) : 0,
    interpretation: gapsThrough === 0
      ? `No bar in this sample opened more than ${round(stop_distance_pct, 2)}% beyond the prior close. A stop that far away would not have been gapped in this window — which is not a promise about the next one.`
      : `${gapsThrough} of ${n} bars (${round((gapsThrough / n) * 100, 1)}%) opened more than ${round(stop_distance_pct, 2)}% past the prior close. A stop that far out would have been JUMPED that often, filling worse than its price. The worst was ${round(worst * 100, 1)}%.`,
    caveat: 'Backtests here fill at the stop price exactly. A stop is a market order once touched, so a gap fills at the open instead — every backtest in this toolchain understates its worst losses by roughly this much. This measures the exposure; it does not correct it.',
  };
}

/**
 * Limit Up-Limit Down bands — the INTRADAY twin of overnight gap risk.
 *
 * `gapRisk` measures how often price jumped a stop between sessions. This is
 * the same exposure inside the session: when a stock hits its LULD band and
 * stays there 15 seconds, trading pauses for at least five minutes, and a stop
 * resting in that range does not get its price. It gets the resumption
 * auction, which is exactly where the move continued.
 *
 * That matters for the rule this repo already carries from Kaminski & Lo — a
 * stop is a bet on persistence, not free insurance. A halt is the case where
 * it is not insurance at all.
 *
 * The tier is the part practitioners get wrong. Retail material routinely
 * quotes 10% above $3, which is TIER 2 — correct for the small caps that
 * material is about, and twice the real band for anything in the S&P 500 or
 * Russell 1000.
 */
export const LULD_TIERS = Object.freeze({
  1: { label: 'Tier 1 — S&P 500, Russell 1000 and selected ETPs', above_3: 5 },
  2: { label: 'Tier 2 — all other NMS securities', above_3: 10 },
});

/** Bands double in the opening and closing periods, when discovery is widest. */
export const LULD_DOUBLING_WINDOWS = Object.freeze([
  { from: '09:30', to: '09:45', why: 'opening price discovery' },
  { from: '15:35', to: '16:00', why: 'closing auction run-up — and where stop-driven exits cluster' },
]);

/**
 * The band around the reference price, as a percentage.
 *
 * The reference price is the mean of eligible trades over the preceding five
 * minutes, so it MOVES: a stock cannot be pinned by one print, but a fast run
 * outpaces its own reference and halts. That is why a halt is a volatility
 * event, not a price level you can plan around.
 */
export function luldBand({ price, tier = 2, in_doubling_window = false } = {}) {
  const p = Number(price);
  if (!(p > 0)) return { available: false, note: 'price must be positive.' };
  if (!LULD_TIERS[tier]) return { available: false, note: `tier must be 1 or 2, got ${tier}.` };

  let pct;
  let basis;
  if (p > 3) {
    pct = LULD_TIERS[tier].above_3;
    basis = `${LULD_TIERS[tier].label}, above $3.00`;
  } else if (p >= 0.75) {
    pct = 20;
    basis = '$0.75 to $3.00 — 20% for both tiers';
  } else {
    // Below $0.75 the band is the LESSER of 75% and $0.15, expressed as a %.
    pct = Math.min(75, (0.15 / p) * 100);
    basis = 'below $0.75 — lesser of 75% and $0.15';
  }
  const effective = in_doubling_window ? pct * 2 : pct;

  return {
    available: true,
    tier,
    price: round(p, 4),
    band_pct: round(pct, 3),
    effective_band_pct: round(effective, 3),
    in_doubling_window,
    band_abs: round((effective / 100) * p, 4),
    basis,
    doubling_windows: LULD_DOUBLING_WINDOWS,
    what_it_means:
      `A move of ${round(effective, 2)}% from the five-minute reference price triggers a limit state; `
      + 'holding it for 15 seconds pauses trading for at least five minutes. A stop inside that range '
      + 'does not fill at its price — it fills at the resumption auction.',
    stop_implication:
      'This is the intraday counterpart to gapRisk. Both describe the same failure: a stop is a market '
      + 'order once touched, and neither an overnight gap nor a halt lets it be anything else. Size the '
      + 'position so the loss is survivable at the band, not at the stop.',
    common_error:
      'Retail sources usually quote 10% above $3. That is TIER 2. An S&P 500 or Russell 1000 name is '
      + 'Tier 1 at 5% — half the room before it halts.',
    source: 'LULD Plan (luldplan.com); Nasdaq and Cboe LULD FAQs.',
  };
}

/**
 * Cost drag as a function of holding period — the arithmetic that decides
 * whether a swing strategy can exist at all.
 *
 * Cost sensitivity scales roughly with the inverse of holding period. At a
 * five-day hold a strategy trades about fifty times a year, and a 20bp
 * round-trip consumes ~10% annually. Very few of the documented effects in
 * this literature are large enough to absorb that.
 *
 * Two numbers, and it should be run before designing anything at swing horizon
 * rather than after.
 */
export function turnoverDrag({ holding_days = 5, round_trip_bps = 20, trading_days_per_year = 252 } = {}) {
  if (!(holding_days > 0)) throw new Error('holding_days must be positive.');
  if (!(round_trip_bps >= 0)) throw new Error('round_trip_bps must be non-negative.');

  const tradesPerYear = trading_days_per_year / holding_days;
  const annualDragPct = (tradesPerYear * round_trip_bps) / 100;

  return {
    holding_days,
    round_trip_bps,
    trades_per_year: round(tradesPerYear, 1),
    annual_cost_drag_pct: round(annualDragPct, 2),
    what_it_means: `A ${holding_days}-day holding period is roughly ${Math.round(tradesPerYear)} round trips a year. `
      + `At ${round_trip_bps}bps each, costs consume ${round(annualDragPct, 2)}% annually before any edge exists. `
      + 'Each trade must beat the round-trip cost; the annual figure is what the strategy must out-earn to break even.',
    verdict: annualDragPct >= 10
      ? 'SEVERE. Very few documented effects are large enough to absorb this. Lengthen the hold, cut the cost, or abandon it.'
      : annualDragPct >= 5
        ? 'HEAVY. Needs an unusually strong edge to survive.'
        : 'Manageable, provided the edge is real.',
    source: 'Bajgrowicz & Scaillet (2012): rules selected before costs trade too frequently to be viable. The failure '
      + 'is economic, not statistical — they genuinely outperform on gross returns.',
  };
}

/**
 * Hysteresis exits — the cheapest turnover reduction in this literature.
 *
 * Most systems exit the moment the entry condition is negated. That is the
 * MAXIMUM-turnover choice available. De Groot, Huij & Zhou (2012) showed that
 * waiting until a name crosses to the opposite half of the ranking, instead of
 * selling the instant it stops qualifying, more than halved turnover and
 * trading costs while INCREASING net returns — 30-50bps per week after costs
 * in large-cap universes, for a strategy widely believed to be destroyed by
 * costs.
 *
 * It is close to free, and almost no discretionary swing system does it.
 *
 * Setting `exit_rank_pct` equal to `entry_rank_pct` reproduces the naive rule,
 * which is what this function exists to argue against.
 */
export function hysteresisExit({ entry_rank_pct = 20, exit_rank_pct = 50, round_trip_bps = 20, holding_days = 5 } = {}) {
  if (!(entry_rank_pct > 0 && entry_rank_pct < 100)) throw new Error('entry_rank_pct must be between 0 and 100.');
  if (!(exit_rank_pct > 0 && exit_rank_pct <= 100)) throw new Error('exit_rank_pct must be between 0 and 100.');
  if (exit_rank_pct < entry_rank_pct) {
    throw new Error(`exit_rank_pct (${exit_rank_pct}) is tighter than entry_rank_pct (${entry_rank_pct}) — that is the `
      + 'opposite of hysteresis and raises turnover rather than cutting it.');
  }

  const band = exit_rank_pct - entry_rank_pct;
  const naive = turnoverDrag({ holding_days, round_trip_bps });
  // Widening the band holds names through noise around the entry boundary, so
  // the effective holding period lengthens roughly in proportion to it.
  const stretch = 1 + band / entry_rank_pct;
  const withHyst = turnoverDrag({ holding_days: holding_days * stretch, round_trip_bps });

  return {
    entry_rank_pct,
    exit_rank_pct,
    hysteresis_band_pct: band,
    is_hysteresis: band > 0,
    naive_exit: { trades_per_year: naive.trades_per_year, annual_cost_drag_pct: naive.annual_cost_drag_pct },
    with_hysteresis: {
      implied_holding_days: round(holding_days * stretch, 1),
      trades_per_year: withHyst.trades_per_year,
      annual_cost_drag_pct: withHyst.annual_cost_drag_pct,
    },
    cost_saved_pct_per_year: round(naive.annual_cost_drag_pct - withHyst.annual_cost_drag_pct, 2),
    ...(band === 0
      ? { warning: 'Entry and exit thresholds are identical — this IS the naive maximum-turnover rule. Widening the exit '
          + 'threshold is the cheapest turnover reduction available.' }
      : {}),
    source: 'De Groot, Huij & Zhou (2012), Journal of Banking & Finance 36(2).',
    caveat: 'A first-order approximation from the width of the band, not a simulation. Measure it on real rankings '
      + 'before relying on the figure.',
  };
}

/**
 * The delay between a close-based signal and the fill that follows it.
 *
 * Zakamulin documents systematically ADVERSE slippage from this gap. For any
 * system that signals on the close and executes at or after the next open it
 * is a real, negative, estimable component of return — not a rounding error to
 * be assumed away.
 *
 * Measured from the actual bars: the signed close-to-next-open move, in the
 * direction the trade would have taken.
 */
export function signalToFillSlippage(bars, { direction = 'long', lookback = 250 } = {}) {
  if (!Array.isArray(bars) || bars.length < 20) {
    return { available: false, note: `Need at least 20 bars, have ${bars?.length ?? 0}.` };
  }
  const seg = bars.slice(-Math.min(lookback, bars.length));
  const gaps = [];
  for (let i = 1; i < seg.length; i++) {
    const g = ((seg[i].open - seg[i - 1].close) / seg[i - 1].close) * 100;
    gaps.push(direction === 'long' ? g : -g);   // a long pays an up-gap, a short pays a down-gap
  }
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const sorted = [...gaps].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const adverse = gaps.filter((g) => g > 0).length;
  const adversePct = (adverse / gaps.length) * 100;

  return {
    available: true,
    direction,
    bars_measured: gaps.length,
    mean_slippage_pct: round(mean, 4),
    median_slippage_pct: round(median, 4),
    adverse_share_pct: round(adversePct, 1),
    worst_pct: round(sorted[sorted.length - 1], 2),
    what_it_means: `Signalling on the close and filling at the next open cost an average of ${round(mean, 4)}% per entry `
      + `on these bars, with ${round(adversePct, 1)}% of gaps moving against the trade. This is SEPARATE from spread and `
      + 'commission and must be added to them.',
    source: 'Zakamulin documents systematically adverse slippage between a close-based signal and the actual execution.',
    caveat: 'Measures the OVERNIGHT gap only. Intraday slippage between decision and fill is additional and cannot be '
      + 'measured from daily bars.',
  };
}
