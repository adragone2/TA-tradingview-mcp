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
