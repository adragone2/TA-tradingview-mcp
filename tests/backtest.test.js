/**
 * Backtest unit tests — no TradingView connection needed.
 *
 * The arithmetic here is exactly where a backtest quietly lies: an expectancy
 * that treats unreadable trades as scratches, a drawn-trade resolver that
 * assumes the target was hit first, a comparison that declares victory on
 * return while ignoring drawdown. Each of those is tested for explicitly.
 *
 * Run: node --test tests/backtest.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeTrades, evaluateTrades, resolveTrade, buyAndHold, compareToBenchmark, anchorIndex,
} from '../src/core/backtest.js';

const bar = (t, o, h, l, c) => ({ time: t, open: o, high: h, low: l, close: c, volume: 100 });

describe('normalizeTrades', () => {
  it('reads profit under any of its spellings', () => {
    const { trades } = normalizeTrades([
      { profit: 10 }, { pnl: 20 }, { netProfit: 30 }, { net_profit: 40 }, { plNet: 50 },
    ]);
    assert.deepEqual(trades.map((t) => t.profit), [10, 20, 30, 40, 50]);
  });

  it('strips currency formatting TradingView returns as text', () => {
    const { trades } = normalizeTrades([{ profit: '$1,234.56' }, { profit: '-2 500' }]);
    assert.deepEqual(trades.map((t) => t.profit), [1234.56, -2500]);
  });

  it('derives profit from entry and exit when no profit field exists', () => {
    const { trades } = normalizeTrades([
      { entryPrice: 100, exitPrice: 110, direction: 'long' },
      { entryPrice: 100, exitPrice: 90, direction: 'short' },
    ]);
    assert.deepEqual(trades.map((t) => t.profit), [10, 10]);
  });

  it('excludes a trade whose profit cannot be read, rather than scoring it zero', () => {
    // A zero would silently drag expectancy toward zero and inflate the count.
    const { trades, unusable } = normalizeTrades([{ profit: 10 }, { somethingElse: 5 }]);
    assert.equal(trades.length, 1);
    assert.equal(unusable.length, 1);
  });

  it('reads direction from several key names', () => {
    const { trades } = normalizeTrades([
      { profit: 1, direction: 'Long' }, { profit: 1, side: 'sell' }, { profit: 1, type: 'buy' },
    ]);
    assert.deepEqual(trades.map((t) => t.direction), ['long', 'short', 'long']);
  });

  it('survives junk input', () => {
    const { trades, unusable } = normalizeTrades([null, 'nope', 42, { profit: 5 }]);
    assert.equal(trades.length, 1);
    assert.ok(unusable.length >= 1);
  });
});

describe('evaluateTrades', () => {
  it('computes win rate, payoff and expectancy from a known set', () => {
    // 3 wins of 100, 2 losses of 50. Win rate 60%, payoff 2.0.
    // Expectancy = 0.6*100 - 0.4*50 = 40.
    const s = evaluateTrades([
      { profit: 100 }, { profit: 100 }, { profit: 100 }, { profit: -50 }, { profit: -50 },
    ]);
    assert.equal(s.trade_count, 5);
    assert.equal(s.win_rate_pct, 60);
    assert.equal(s.avg_win, 100);
    assert.equal(s.avg_loss, 50);
    assert.equal(s.payoff_ratio, 2);
    assert.equal(s.expectancy, 40);
  });

  it('computes profit factor as gross profit over gross loss', () => {
    const s = evaluateTrades([{ profit: 300 }, { profit: -100 }]);
    assert.equal(s.profit_factor, 3);
    assert.equal(s.net_profit, 200);
  });

  it('reports a negative expectancy plainly when the system loses', () => {
    // 80% win rate, still negative: wins of 10, losses of 100.
    const trades = [...Array(8).fill({ profit: 10 }), ...Array(2).fill({ profit: -100 })];
    const s = evaluateTrades(trades);
    assert.equal(s.win_rate_pct, 80);
    assert.ok(s.expectancy < 0, `expectancy should be negative, got ${s.expectancy}`);
    assert.match(s.interpretation, /LOST/);
  });

  it('counts scratches in the denominator rather than dropping them', () => {
    const s = evaluateTrades([{ profit: 100 }, { profit: 0 }]);
    assert.equal(s.trade_count, 2);
    assert.equal(s.scratches, 1);
    assert.equal(s.win_rate_pct, 50);
  });

  it('tracks the longest losing streak', () => {
    const s = evaluateTrades([
      { profit: -1 }, { profit: -1 }, { profit: 5 }, { profit: -1 }, { profit: -1 }, { profit: -1 },
    ]);
    assert.equal(s.max_consecutive_losses, 3);
    assert.equal(s.max_consecutive_wins, 1);
  });

  it('expresses expectancy in R against a supplied risk, and says so', () => {
    const s = evaluateTrades([{ profit: 200 }, { profit: -100 }], { risk_per_trade: 100 });
    // Expectancy = 0.5*200 - 0.5*100 = 50 → 0.5R on 100 risk.
    assert.equal(s.expectancy_r, 0.5);
    assert.match(s.expectancy_r_basis, /supplied/);
  });

  it('falls back to average loss for R and names that basis', () => {
    const s = evaluateTrades([{ profit: 200 }, { profit: -100 }]);
    assert.match(s.expectancy_r_basis, /average loss/);
  });

  it('splits performance by direction when known', () => {
    const s = evaluateTrades([
      { profit: 100, direction: 'long' }, { profit: -50, direction: 'short' },
    ]);
    assert.deepEqual(s.by_direction, { long: 1, short: 1, long_net: 100, short_net: -50 });
  });

  it('says nothing to evaluate rather than dividing by zero', () => {
    const s = evaluateTrades([]);
    assert.equal(s.trade_count, 0);
    assert.match(s.note, /Nothing to evaluate/i);
  });

  it('handles an all-wins set without a divide-by-zero payoff', () => {
    const s = evaluateTrades([{ profit: 10 }, { profit: 20 }]);
    assert.equal(s.losses, 0);
    assert.equal(s.payoff_ratio, null);
    assert.equal(s.profit_factor, null);
    assert.equal(s.expectancy, 15);
  });
});

describe('resolveTrade', () => {
  // Long from 100, stop 90, target 120. Risk 10, reward 20 → 2R.
  const long = { direction: 'long', entry: 100, stop: 90, target: 120 };

  it('resolves a long that reached its target', () => {
    const bars = [bar(1, 100, 105, 98, 102), bar(2, 102, 121, 101, 120)];
    const r = resolveTrade(bars, long);
    assert.equal(r.outcome, 'target');
    assert.equal(r.r_multiple, 2);
    assert.equal(r.profit, 20);
    assert.equal(r.bars_held, 2);
  });

  it('resolves a long that hit its stop', () => {
    const bars = [bar(1, 100, 105, 98, 102), bar(2, 102, 103, 89, 91)];
    const r = resolveTrade(bars, long);
    assert.equal(r.outcome, 'stop');
    assert.equal(r.r_multiple, -1);
    assert.equal(r.profit, -10);
  });

  it('resolves a short symmetrically', () => {
    const short = { direction: 'short', entry: 100, stop: 110, target: 80 };
    const bars = [bar(1, 100, 102, 79, 80)];
    const r = resolveTrade(bars, short);
    assert.equal(r.outcome, 'target');
    assert.equal(r.r_multiple, 2);
  });

  it('resolves a bar containing BOTH stop and target as a loss, and flags it', () => {
    // This is the assumption that decides whether a backtest finds a fake edge.
    const bars = [bar(1, 100, 125, 85, 110)];
    const r = resolveTrade(bars, long);
    assert.equal(r.outcome, 'stop');
    assert.equal(r.ambiguous, true);
    assert.match(r.note, /cannot say which came first/i);
  });

  it('takes whichever came first across separate bars', () => {
    const stopFirst = [bar(1, 100, 105, 89, 92), bar(2, 92, 125, 91, 124)];
    assert.equal(resolveTrade(stopFirst, long).outcome, 'stop');
    const targetFirst = [bar(1, 100, 121, 95, 120), bar(2, 120, 122, 85, 88)];
    assert.equal(resolveTrade(targetFirst, long).outcome, 'target');
  });

  it('marks an unresolved trade open with no profit, so it cannot be scored', () => {
    const bars = [bar(1, 100, 105, 98, 102), bar(2, 102, 106, 99, 104)];
    const r = resolveTrade(bars, long);
    assert.equal(r.outcome, 'open');
    assert.equal(r.profit, null);
    assert.equal(r.r_multiple, null);
  });

  it('only considers bars after the anchor time', () => {
    // Bar 1 reaches the target, but it happened BEFORE the trade was drawn.
    // Bar 2 hits the stop. Anchored at bar 1, the only honest answer is "stop".
    const bars = [bar(1, 100, 130, 99, 125), bar(2, 125, 126, 89, 91)];
    assert.equal(resolveTrade(bars, long).outcome, 'target');           // unanchored: bar 1 counts
    assert.equal(resolveTrade(bars, { ...long, from_time: 1 }).outcome, 'stop'); // anchored: it does not
  });

  it('rejects a zero-risk trade rather than returning Infinity R', () => {
    assert.throws(() => resolveTrade([bar(1, 100, 101, 99, 100)], { direction: 'long', entry: 100, stop: 100, target: 120 }), /risk is zero/i);
  });

  it('rejects a bad direction and missing prices', () => {
    assert.throws(() => resolveTrade([], { direction: 'sideways', entry: 1, stop: 2, target: 3 }), /direction/i);
    assert.throws(() => resolveTrade([], { direction: 'long', entry: 1, stop: null, target: 3 }), /must all be numbers/i);
  });
});

describe('buyAndHold', () => {
  it('computes return over the bars', () => {
    const b = [bar(1, 100, 100, 100, 100), bar(2, 150, 150, 150, 150)];
    assert.equal(buyAndHold(b).return_pct, 50);
  });

  it('computes max drawdown from peak to trough', () => {
    const b = [bar(1, 0, 0, 0, 100), bar(2, 0, 0, 0, 200), bar(3, 0, 0, 0, 100), bar(4, 0, 0, 0, 150)];
    // Peak 200, trough 100 → 50% drawdown.
    assert.equal(buyAndHold(b).max_drawdown_pct, 50);
  });

  it('reports a negative return without special-casing it', () => {
    const b = [bar(1, 0, 0, 0, 200), bar(2, 0, 0, 0, 100)];
    assert.equal(buyAndHold(b).return_pct, -50);
  });

  it('declines to compute from too few bars', () => {
    assert.match(buyAndHold([bar(1, 1, 1, 1, 1)]).note, /Not enough bars/i);
    assert.match(buyAndHold([]).note, /Not enough bars/i);
  });
});

describe('compareToBenchmark', () => {
  const benchmark = { return_pct: 100, max_drawdown_pct: 60 };

  it('reports excess return when the strategy wins', () => {
    const c = compareToBenchmark({ strategy_return_pct: 180, strategy_max_dd_pct: 20, benchmark });
    assert.equal(c.excess_return_pct, 80);
    assert.equal(c.return_ratio, 1.8);
    assert.match(c.verdict, /MORE than buy-and-hold/);
  });

  it('says plainly when the strategy LOSES to buy-and-hold', () => {
    const c = compareToBenchmark({ strategy_return_pct: 40, strategy_max_dd_pct: 10, benchmark });
    assert.equal(c.excess_return_pct, -60);
    assert.match(c.verdict, /LESS than buy-and-hold/);
  });

  it('surfaces the drawdown improvement, which is often the real edge', () => {
    const c = compareToBenchmark({ strategy_return_pct: 180, strategy_max_dd_pct: 20, benchmark });
    assert.equal(c.drawdown_improvement_pct, 40);
    assert.match(c.verdict, /LESS drawdown/);
  });

  it('does not hide a worse drawdown behind a better return', () => {
    const c = compareToBenchmark({ strategy_return_pct: 150, strategy_max_dd_pct: 90, benchmark });
    assert.match(c.verdict, /MORE than buy-and-hold/);
    assert.match(c.verdict, /MORE drawdown/);
    assert.ok(c.caution, 'a mixed result must carry the caution');
  });

  it('refuses to compare when the strategy return is unreadable', () => {
    const c = compareToBenchmark({ strategy_return_pct: null, benchmark });
    assert.match(c.note, /could not be read/i);
    assert.equal(c.excess_return_pct, undefined);
  });

  it('handles a missing benchmark', () => {
    assert.match(compareToBenchmark({ strategy_return_pct: 10, benchmark: null }).note, /No benchmark/i);
  });
});

describe('anchor handling (no same-bar lookahead)', () => {
  const long = { direction: 'long', entry: 100, stop: 90, target: 120 };

  it('matches the nearest bar when the anchor is earlier than its own bar', () => {
    // TradingView normalizes a drawing's anchor to midnight of the session date
    // while the bar carries the session open — verified live at a 52,200s gap.
    // A naive `b.time > from_time` puts the entry bar back in the window.
    const bars = [
      bar(1_769_783_400, 0, 0, 0, 100),   // previous session
      bar(1_770_042_600, 0, 130, 85, 100), // the anchor bar: would resolve either way
      bar(1_770_129_000, 0, 105, 89, 91),  // the bar that should actually resolve it
    ];
    const anchoredAtMidnight = 1_769_990_400;
    assert.equal(anchorIndex(bars, anchoredAtMidnight), 1, 'nearest bar should be the anchor bar');

    const r = resolveTrade(bars, { ...long, from_time: anchoredAtMidnight });
    assert.equal(r.outcome, 'stop');
    assert.equal(r.bars_held, 1, 'resolution must start at the bar AFTER the anchor bar');
    assert.equal(r.ambiguous, false, 'the anchor bar must not contribute its own ambiguity');
  });

  it('does not resolve a trade on the bar it was entered on', () => {
    // The anchor bar alone reaches the target. Nothing after it does.
    const bars = [bar(100, 0, 130, 99, 125), bar(200, 0, 105, 98, 102)];
    const r = resolveTrade(bars, { ...long, from_time: 100 });
    assert.equal(r.outcome, 'open', 'the entry bar must not resolve the trade');
  });

  it('still counts every bar when no anchor is given', () => {
    const bars = [bar(100, 0, 130, 99, 125)];
    assert.equal(resolveTrade(bars, long).outcome, 'target');
  });
});

describe('anchorIndex — the midnight-anchor trap', () => {
  it('picks the bar the anchor OPENS, not the nearest timestamp', () => {
    // Measured live: the anchor is ~48,600s before its own bar but only
    // ~37,800s after the previous one, so "nearest" is wrong every time.
    const bars = [bar(1_772_461_800, 0, 0, 0, 1), bar(1_772_548_200, 0, 0, 0, 1)];
    const anchor = 1_772_496_000;
    assert.ok(Math.abs(anchor - bars[0].time) < Math.abs(anchor - bars[1].time), 'precondition: bar 0 IS nearer');
    assert.equal(anchorIndex(bars, anchor), 1, 'must still pick bar 1, the session the anchor opens');
  });

  it('matches an anchor that equals a bar time exactly', () => {
    assert.equal(anchorIndex([bar(100, 0, 0, 0, 1), bar(200, 0, 0, 0, 1)], 100), 0);
  });

  it('returns the last bar when anchored past every bar, leaving nothing to resolve', () => {
    const bars = [bar(100, 0, 0, 0, 1), bar(200, 0, 0, 0, 1)];
    assert.equal(anchorIndex(bars, 999), bars.length - 1);
    const r = resolveTrade(bars, { direction: 'long', entry: 100, stop: 90, target: 120, from_time: 999 });
    assert.equal(r.outcome, 'open');
  });

  it('returns -1 for no anchor, so every bar counts', () => {
    assert.equal(anchorIndex([bar(100, 0, 0, 0, 1)], null), -1);
  });
});
