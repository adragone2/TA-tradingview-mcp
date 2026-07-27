/**
 * Backtest evaluation — trade statistics, drawn-trade resolution, and the
 * benchmark that stops a backtest flattering itself.
 *
 * Three sources of trades, matching the three ways a backtest actually gets
 * done here:
 *
 *   1. A Pine strategy on the chart      → evaluateStrategy()
 *   2. Trades the user DREW on the chart → evaluateDrawn()
 *   3. Bar Replay, trade by trade        → evaluateTrades() on a supplied list
 *
 * All three end at the same arithmetic: win rate, payoff, expectancy.
 *
 * The benchmark is not optional decoration. A strategy that returned 300% over
 * a decade sounds excellent until buy-and-hold returned 400% over the same
 * bars. Net profit alone cannot distinguish a good strategy from a rising
 * market, and that is the single easiest way to be fooled by a backtest — so
 * `buyAndHold` is computed from the same bars and reported alongside.
 *
 * Everything above the chart-facing wrappers is pure.
 */
import * as data from './data.js';
import { normalizeBars } from './structure.js';
import { readPosition } from './position_tool.js';

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  // TradingView sometimes hands back "1 234.56" or "$1,234.56" or "12.5%".
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[$,\s%]/g, ''));
  return Number.isFinite(n) ? n : null;
};
const round = (n, dp = 2) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10 ** dp) / 10 ** dp);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/**
 * Pull a profit figure out of whatever TradingView called it.
 *
 * The Strategy Tester's order objects are not a stable documented shape, so
 * this checks the spellings seen in practice rather than assuming one. A trade
 * whose profit cannot be found is reported as unusable rather than silently
 * scored as a scratch — a zero would quietly drag expectancy toward zero.
 */
export function normalizeTrades(raw) {
  const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.trades) ? raw.trades : []);
  const trades = [];
  const unusable = [];

  for (const t of list) {
    if (!t || typeof t !== 'object') { unusable.push({ reason: 'not an object' }); continue; }

    const pnl = num(t.profit ?? t.pnl ?? t.netProfit ?? t.net_profit ?? t.profitLoss ?? t.plNet ?? t.pl);
    const pnlPct = num(t.profitPercent ?? t.profit_percent ?? t.plPercent ?? t.percent);
    const entry = num(t.entryPrice ?? t.entry_price ?? t.priceIn ?? t.entry);
    const exit = num(t.exitPrice ?? t.exit_price ?? t.priceOut ?? t.exit ?? t.price);
    const dirRaw = String(t.direction ?? t.side ?? t.type ?? t.tradeType ?? '').toLowerCase();
    const direction = /short|sell/.test(dirRaw) ? 'short' : /long|buy/.test(dirRaw) ? 'long' : null;

    // A profit we can derive is as good as one we were given.
    const derived = pnl == null && entry != null && exit != null && direction
      ? (direction === 'long' ? exit - entry : entry - exit)
      : null;

    const profit = pnl ?? derived;
    if (profit == null) {
      unusable.push({ reason: 'no profit field found', keys: Object.keys(t).slice(0, 12) });
      continue;
    }

    trades.push({
      profit,
      profit_pct: pnlPct,
      entry, exit, direction,
      time: num(t.time ?? t.entryTime ?? t.date) ?? null,
    });
  }

  return { trades, unusable };
}

/**
 * Win rate, payoff, expectancy, profit factor, streaks.
 *
 * Expectancy is the number that matters and the one most often left out: what
 * an average trade is worth. A 30%-win-rate strategy can be excellent and an
 * 80% one can bleed — win rate alone cannot tell you which, because it says
 * nothing about the size of the wins relative to the losses.
 */
export function evaluateTrades(trades, { risk_per_trade = null } = {}) {
  const usable = (trades || []).filter((t) => t && Number.isFinite(t.profit));
  if (!usable.length) {
    return { trade_count: 0, note: 'No trades with a readable profit. Nothing to evaluate.' };
  }

  const wins = usable.filter((t) => t.profit > 0);
  const losses = usable.filter((t) => t.profit < 0);
  const scratches = usable.filter((t) => t.profit === 0);

  const grossProfit = wins.reduce((s, t) => s + t.profit, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.profit, 0));

  const avgWin = mean(wins.map((t) => t.profit));
  const avgLoss = losses.length ? Math.abs(mean(losses.map((t) => t.profit))) : 0;

  // Scratches are counted in the denominator. Excluding them would flatter the
  // win rate of a strategy that scratches often.
  const winRate = wins.length / usable.length;
  const lossRate = losses.length / usable.length;

  const expectancy = winRate * avgWin - lossRate * avgLoss;

  // Expectancy in R is only meaningful against a known risk. Prefer an explicit
  // risk_per_trade; fall back to average loss, and SAY which was used, because
  // the two mean different things.
  const rUnit = Number.isFinite(risk_per_trade) && risk_per_trade > 0 ? risk_per_trade : (avgLoss || null);
  const rBasis = Number.isFinite(risk_per_trade) && risk_per_trade > 0 ? 'risk_per_trade supplied' : 'average loss';

  let maxConsecLosses = 0, run = 0;
  let maxConsecWins = 0, winRun = 0;
  for (const t of usable) {
    if (t.profit < 0) { run++; maxConsecLosses = Math.max(maxConsecLosses, run); winRun = 0; }
    else if (t.profit > 0) { winRun++; maxConsecWins = Math.max(maxConsecWins, winRun); run = 0; }
    else { run = 0; winRun = 0; }
  }

  const longs = usable.filter((t) => t.direction === 'long');
  const shorts = usable.filter((t) => t.direction === 'short');

  return {
    trade_count: usable.length,
    wins: wins.length,
    losses: losses.length,
    scratches: scratches.length,
    win_rate_pct: round(winRate * 100, 1),
    avg_win: round(avgWin),
    avg_loss: round(avgLoss),
    payoff_ratio: avgLoss ? round(avgWin / avgLoss) : null,
    expectancy: round(expectancy),
    expectancy_r: rUnit ? round(expectancy / rUnit) : null,
    expectancy_r_basis: rUnit ? rBasis : null,
    profit_factor: grossLoss ? round(grossProfit / grossLoss) : null,
    gross_profit: round(grossProfit),
    gross_loss: round(grossLoss),
    net_profit: round(grossProfit - grossLoss),
    largest_win: round(Math.max(...usable.map((t) => t.profit))),
    largest_loss: round(Math.min(...usable.map((t) => t.profit))),
    max_consecutive_losses: maxConsecLosses,
    max_consecutive_wins: maxConsecWins,
    ...(longs.length || shorts.length
      ? { by_direction: { long: longs.length, short: shorts.length, long_net: round(longs.reduce((s, t) => s + t.profit, 0)), short_net: round(shorts.reduce((s, t) => s + t.profit, 0)) } }
      : {}),
    interpretation: expectancy > 0
      ? `Each trade was worth ${round(expectancy)} on average over this sample.`
      : `Each trade LOST ${round(Math.abs(expectancy))} on average over this sample.`,
  };
}

/**
 * Resolve one planned trade against the bars that followed it.
 *
 * The honest part: when a single bar's range contains BOTH the stop and the
 * target, OHLC data cannot say which was touched first. Those bars are marked
 * `ambiguous` and resolved as losses, because assuming the target came first
 * is how a backtest talks itself into an edge that was never there. The count
 * of ambiguous resolutions is reported so the reader can judge how much of the
 * result rests on that assumption.
 */
/**
 * Which bar does a drawing's anchor sit on?
 *
 * TradingView stores the anchor as midnight of the session date, while the bar
 * carries the session open — measured live at 48,600–52,200 seconds earlier
 * than its own bar, but only 34,200–37,800 seconds after the PREVIOUS one. So
 * "nearest timestamp" picks the wrong bar, every time, and the trade then gets
 * resolved a bar early.
 *
 * The anchor belongs to the session it opens, so the right bar is the first one
 * at or after it.
 */
export function anchorIndex(bars, from_time) {
  if (from_time == null || !bars.length) return -1;
  for (let i = 0; i < bars.length; i++) {
    if ((bars[i].time ?? 0) >= from_time) return i;
  }
  // Anchored past every loaded bar: nothing follows it to resolve against.
  return bars.length - 1;
}

export function resolveTrade(bars, { direction, entry, stop, target, from_time = null }) {
  const dir = String(direction || '').toLowerCase();
  if (dir !== 'long' && dir !== 'short') throw new Error('direction must be "long" or "short".');
  if (![entry, stop, target].every((v) => Number.isFinite(v))) {
    throw new Error('entry, stop and target must all be numbers.');
  }

  const risk = Math.abs(entry - stop);
  const reward = Math.abs(target - entry);
  if (!risk) throw new Error('Stop equals entry — risk is zero and R is undefined.');

  // Resolution starts at the bar AFTER the one the trade sits on, never on it.
  // Comparing `b.time > from_time` is not enough: TradingView normalizes a
  // drawing's anchor to midnight of the session date, while the bar carries the
  // session open, so the anchor reads as EARLIER than its own bar and that bar
  // slips back into the window. The trade would then be resolvable by price
  // action that preceded its own entry — lookahead, and it silently flatters
  // every result. Matching the nearest bar and starting past it removes that.
  const anchor = anchorIndex(bars, from_time);
  const after = anchor >= 0 ? bars.slice(anchor + 1) : bars;

  for (let i = 0; i < after.length; i++) {
    const b = after[i];
    const hitStop = dir === 'long' ? b.low <= stop : b.high >= stop;
    const hitTarget = dir === 'long' ? b.high >= target : b.low <= target;

    if (hitStop && hitTarget) {
      return {
        outcome: 'stop', ambiguous: true, exit_price: stop, bars_held: i + 1,
        r_multiple: -1, profit: -risk,
        note: 'Stop and target both fell inside one bar; resolved as a loss because OHLC cannot say which came first.',
      };
    }
    if (hitStop) return { outcome: 'stop', ambiguous: false, exit_price: stop, bars_held: i + 1, r_multiple: -1, profit: -risk };
    if (hitTarget) return { outcome: 'target', ambiguous: false, exit_price: target, bars_held: i + 1, r_multiple: round(reward / risk), profit: reward };
  }

  // Never resolved. Marked open and EXCLUDED from statistics rather than
  // counted as a scratch — an unresolved trade is missing data, not a result.
  const last = after[after.length - 1];
  return {
    outcome: 'open', ambiguous: false, exit_price: null, bars_held: after.length,
    r_multiple: null, profit: null,
    unrealized: last ? round(dir === 'long' ? last.close - entry : entry - last.close) : null,
  };
}

/**
 * Buy-and-hold over the same bars: the benchmark every backtest must clear.
 *
 * Reports max drawdown too, because that is frequently where a strategy earns
 * its keep — the same return with half the drawdown is a materially better
 * outcome, and net profit alone hides it entirely.
 */
export function buyAndHold(bars) {
  if (!bars || bars.length < 2) return { note: 'Not enough bars to compute a benchmark.' };

  const first = bars[0].close, last = bars[bars.length - 1].close;
  let peak = bars[0].close, maxDd = 0, maxDdPct = 0;
  for (const b of bars) {
    if (b.close > peak) peak = b.close;
    const dd = peak - b.close;
    if (dd > maxDd) { maxDd = dd; maxDdPct = (dd / peak) * 100; }
  }

  return {
    start_price: round(first, 6),
    end_price: round(last, 6),
    return_pct: round(((last - first) / first) * 100),
    max_drawdown_pct: round(maxDdPct),
    bars: bars.length,
    from: bars[0].time ?? null,
    to: bars[bars.length - 1].time ?? null,
  };
}

/**
 * Compare a strategy's headline numbers against buy-and-hold.
 *
 * Deliberately refuses to declare a winner on return alone: a strategy that
 * beats the benchmark on return while tripling the drawdown has not obviously
 * won, and saying so would be the same error the benchmark exists to prevent.
 */
export function compareToBenchmark({ strategy_return_pct, strategy_max_dd_pct, benchmark }) {
  if (!benchmark || benchmark.return_pct == null) return { note: 'No benchmark available to compare against.' };
  if (!Number.isFinite(strategy_return_pct)) {
    return { benchmark, note: 'Strategy return could not be read, so no comparison was made.' };
  }

  const diff = strategy_return_pct - benchmark.return_pct;
  const ratio = benchmark.return_pct !== 0 ? strategy_return_pct / benchmark.return_pct : null;
  const ddBetter = Number.isFinite(strategy_max_dd_pct) && Number.isFinite(benchmark.max_drawdown_pct)
    ? benchmark.max_drawdown_pct - strategy_max_dd_pct
    : null;

  const verdictParts = [];
  verdictParts.push(diff >= 0
    ? `Strategy returned ${round(diff)} percentage points MORE than buy-and-hold.`
    : `Strategy returned ${round(Math.abs(diff))} percentage points LESS than buy-and-hold.`);
  if (ddBetter != null) {
    verdictParts.push(ddBetter > 0
      ? `It did so with ${round(ddBetter)} points LESS drawdown.`
      : `It did so with ${round(Math.abs(ddBetter))} points MORE drawdown.`);
  }

  return {
    benchmark,
    strategy_return_pct: round(strategy_return_pct),
    strategy_max_dd_pct: round(strategy_max_dd_pct),
    excess_return_pct: round(diff),
    return_ratio: round(ratio),
    drawdown_improvement_pct: round(ddBetter),
    verdict: verdictParts.join(' '),
    caution: 'Return and drawdown are separate questions. Beating the benchmark on one while losing on the other is not a win — say which happened rather than reporting a single number.',
  };
}

/* ------------------------------------------------------------------ *
 * Chart-facing wrappers
 * ------------------------------------------------------------------ */

/** Pull metrics the Strategy Tester exposes under any of its spellings. */
function pickMetric(metrics, patterns) {
  for (const p of patterns) {
    for (const [k, v] of Object.entries(metrics || {})) {
      if (p.test(k)) {
        const n = num(v);
        if (n != null) return n;
      }
    }
  }
  return null;
}

/** Evaluate the Pine strategy currently on the chart, against buy-and-hold. */
export async function evaluateStrategy({ max_trades = 100, count = 500, risk_per_trade = null } = {}) {
  const [resultsRes, tradesRes, ohlcv] = await Promise.all([
    data.getStrategyResults(),
    data.getTrades({ max_trades }),
    data.getOhlcv({ count, summary: false }),
  ]);

  const bars = normalizeBars(ohlcv);
  const benchmark = buyAndHold(bars);

  const { trades, unusable } = normalizeTrades(tradesRes.trades);
  const stats = evaluateTrades(trades, { risk_per_trade });

  const metrics = resultsRes.metrics || {};
  const stratReturn = pickMetric(metrics, [/netProfitPercent/i, /net_profit_percent/i, /netProfit.*Pct/i]);
  const stratDd = pickMetric(metrics, [/maxDrawDownPercent/i, /max_drawdown_percent/i, /drawdown.*percent/i]);

  const comparison = compareToBenchmark({
    strategy_return_pct: stratReturn,
    strategy_max_dd_pct: stratDd,
    benchmark,
  });

  return {
    success: true,
    source: 'strategy_tester',
    ...(resultsRes.error ? { strategy_error: resultsRes.error } : {}),
    ...(tradesRes.error ? { trades_error: tradesRes.error } : {}),
    statistics: stats,
    tester_metrics: metrics,
    comparison,
    ...(unusable.length ? { unusable_trades: unusable.length, unusable_note: 'These trades had no readable profit field and were EXCLUDED, not counted as zero.' } : {}),
    ...(tradesRes.trade_count >= max_trades ? { truncated: `Read ${tradesRes.trade_count} trades, the cap. Statistics cover only those — raise max_trades for the full set.` } : {}),
    note: 'Statistics are computed from the trades read off the chart. Where the Strategy Tester reports its own figure, both are shown; they should agree, and a disagreement is worth investigating rather than averaging.',
  };
}

/**
 * Evaluate trades the user DREW on the chart, by resolving each against the
 * bars that followed it.
 *
 * This is the "backtest your own drawn trades" method: the plans are already
 * on the chart as Long/Short Position tools, and the price data says how each
 * one would have finished.
 */
export async function evaluateDrawn({ count = 1000, risk_per_trade = null } = {}) {
  const [posRes, ohlcv] = await Promise.all([
    readPosition({}),
    data.getOhlcv({ count, summary: false }),
  ]);

  const bars = normalizeBars(ohlcv);
  if (!bars.length) throw new Error('No price bars came back from the chart.');

  const positions = posRes.positions || [];
  if (!positions.length) {
    return {
      success: true, source: 'drawn', trade_count: 0,
      note: 'No Long/Short Position tools on this chart. Draw the trades first, or use position_draw.',
    };
  }

  const resolved = [];
  for (const p of positions) {
    try {
      const r = resolveTrade(bars, {
        direction: p.direction, entry: p.entry, stop: p.stop, target: p.target,
        from_time: p.anchor_time,
      });
      resolved.push({
        entity_id: p.entity_id, direction: p.direction,
        entry: p.entry, stop: p.stop, target: p.target,
        planned_rr: p.rr, created_by_mcp: p.created_by_mcp,
        ...r,
      });
    } catch (e) {
      resolved.push({ entity_id: p.entity_id, error: e.message });
    }
  }

  const closed = resolved.filter((r) => r.outcome === 'target' || r.outcome === 'stop');
  const open = resolved.filter((r) => r.outcome === 'open');
  const failed = resolved.filter((r) => r.error);
  const ambiguous = closed.filter((r) => r.ambiguous);

  const stats = evaluateTrades(closed.map((r) => ({ profit: r.profit, direction: r.direction })), { risk_per_trade });
  const rMultiples = closed.map((r) => r.r_multiple).filter((v) => Number.isFinite(v));

  return {
    success: true,
    source: 'drawn',
    resolved_count: closed.length,
    open_count: open.length,
    ...(failed.length ? { failed_count: failed.length } : {}),
    statistics: stats,
    expectancy_r: rMultiples.length ? round(mean(rMultiples)) : null,
    trades: resolved,
    benchmark: buyAndHold(bars),
    ...(open.length ? { open_note: `${open.length} trade(s) never reached stop or target within the loaded bars. They are EXCLUDED from the statistics — an unresolved trade is missing data, not a scratch.` } : {}),
    ...(ambiguous.length ? { ambiguous_note: `${ambiguous.length} of ${closed.length} trade(s) had stop and target inside the same bar and were resolved as LOSSES. OHLC cannot say which was hit first; on a lower timeframe some of these may have been wins.` } : {}),
    method: 'Each drawn plan was walked forward through subsequent bars until stop or target was touched. Entry is assumed filled at the drawing\'s anchor bar.',
  };
}

/** Buy-and-hold for the bars on the chart, on its own. */
export async function benchmark({ count = 500 } = {}) {
  const ohlcv = await data.getOhlcv({ count, summary: false });
  const bars = normalizeBars(ohlcv);
  if (bars.length < 2) throw new Error('Not enough bars on the chart to compute a benchmark.');
  return {
    success: true,
    buy_and_hold: buyAndHold(bars),
    note: 'Compare any strategy result against this. Net profit alone cannot distinguish a good strategy from a rising market.',
  };
}
