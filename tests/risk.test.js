/**
 * Risk arithmetic unit tests — no TradingView connection needed.
 *
 * The tests that matter most here are the ones asserting the arithmetic REFUSES
 * to flatter:
 *
 *   - an 80% win rate with big losses must come back NEGATIVE. That case is the
 *     entire reason break-even win rate is reported, and a bug that reported it
 *     as profitable would be worse than having no tool.
 *   - risk_of_ruin must be deterministic. A risk figure that changes each time
 *     it is asked is not one anyone can act on, so the same seed is asserted to
 *     give the same answer.
 *
 * Run: node --test tests/risk.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { tradeMath, riskOfRuin, recoveryRequired, recoveryTable, sizeByVolatility } from '../src/core/risk.js';

describe('tradeMath — expectancy and break-even', () => {
  it('computes expectancy in R from a win rate and payoff', () => {
    // 50% at 2:1 -> 0.5*2 - 0.5*1 = 0.5R
    const r = tradeMath({ win_rate_pct: 50, risk_reward: 2 });
    assert.equal(r.available, true);
    assert.equal(r.expectancy_r, 0.5);
    assert.equal(r.profitable, true);
  });

  it('calls an 80% win rate with huge losses UNPROFITABLE', () => {
    // The case the whole tool exists for: 80% winning $100, 20% losing $1000.
    const r = tradeMath({ win_rate_pct: 80, avg_win: 100, avg_loss: 1000 });
    assert.equal(r.profitable, false);
    assert.ok(r.expectancy_r < 0, `expected negative, got ${r.expectancy_r}`);
    assert.equal(r.expectancy_cash, -120);   // 0.8*100 - 0.2*1000
    assert.match(r.verdict, /NEGATIVE/);
    assert.match(r.verdict, /No position size fixes this/i);
  });

  it('calls a 35% win rate at 3:1 profitable', () => {
    const r = tradeMath({ win_rate_pct: 35, risk_reward: 3 });
    assert.equal(r.profitable, true);
    assert.ok(r.break_even_win_rate_pct < 35);
  });

  it('gets the break-even win rate right', () => {
    // 1/(1+R): at 3:1 that is 25%, at 1:1 it is 50%.
    assert.equal(tradeMath({ win_rate_pct: 50, risk_reward: 3 }).break_even_win_rate_pct, 25);
    assert.equal(tradeMath({ win_rate_pct: 50, risk_reward: 1 }).break_even_win_rate_pct, 50);
  });

  it('reports edge as the gap between actual and break-even', () => {
    const r = tradeMath({ win_rate_pct: 40, risk_reward: 3 });
    assert.equal(r.edge_pct, 15);   // 40 - 25
  });

  it('prefers avg_win/avg_loss over risk_reward when both are given', () => {
    const r = tradeMath({ win_rate_pct: 50, risk_reward: 99, avg_win: 200, avg_loss: 100 });
    assert.equal(r.risk_reward, 2);
    assert.match(r.payoff_basis, /average win/i);
  });

  it('computes Kelly and always offers the fractions', () => {
    // 60% at 1:1 -> 0.6 - 0.4/1 = 0.20
    const r = tradeMath({ win_rate_pct: 60, risk_reward: 1 });
    assert.equal(r.kelly_pct, 20);
    assert.equal(r.half_kelly_pct, 10);
    assert.equal(r.quarter_kelly_pct, 5);
  });

  it('never returns a negative Kelly as a position size', () => {
    const r = tradeMath({ win_rate_pct: 20, risk_reward: 1 });
    assert.equal(r.kelly_pct, 0);
    assert.match(r.kelly_warning, /do not take this trade/i);
  });

  it('warns that Kelly assumes the inputs are exact', () => {
    const r = tradeMath({ win_rate_pct: 60, risk_reward: 2 });
    assert.match(r.kelly_warning, /exact and constant/i);
    assert.match(r.kelly_warning, /ruinous/i);
  });

  it('distrusts itself on a small sample, and says so', () => {
    const small = tradeMath({ win_rate_pct: 60, risk_reward: 2, sample_size: 20 });
    assert.match(small.confidence, /only 20 trades/i);
    assert.match(small.confidence, /unusable/i);
    const big = tradeMath({ win_rate_pct: 60, risk_reward: 2, sample_size: 500 });
    assert.match(big.confidence, /Based on 500 trades/);
  });

  it('flags a missing sample size rather than assuming the numbers are measured', () => {
    assert.match(tradeMath({ win_rate_pct: 60, risk_reward: 2 }).confidence, /arithmetic on a guess/i);
  });

  it('always says a win rate needs its payoff to be read', () => {
    assert.match(tradeMath({ win_rate_pct: 60, risk_reward: 2 }).win_rate_note, /never to 50%/);
  });

  it('rejects bad inputs instead of returning a number', () => {
    assert.equal(tradeMath({ win_rate_pct: 150, risk_reward: 2 }).available, false);
    assert.equal(tradeMath({ win_rate_pct: 50 }).available, false);
    assert.equal(tradeMath({ win_rate_pct: 50, avg_win: 100, avg_loss: 0 }).available, false);
  });
});

describe('riskOfRuin', () => {
  it('is deterministic — the same seed gives the same answer', () => {
    const a = riskOfRuin({ win_rate_pct: 50, risk_reward: 2, simulations: 500, seed: 7 });
    const b = riskOfRuin({ win_rate_pct: 50, risk_reward: 2, simulations: 500, seed: 7 });
    assert.equal(a.risk_of_ruin_pct, b.risk_of_ruin_pct);
    assert.equal(a.median_final_multiple, b.median_final_multiple);
  });

  it('finds more ruin at larger risk per trade', () => {
    const small = riskOfRuin({ win_rate_pct: 45, risk_reward: 1.5, risk_per_trade_pct: 1, simulations: 2000 });
    const large = riskOfRuin({ win_rate_pct: 45, risk_reward: 1.5, risk_per_trade_pct: 20, simulations: 2000 });
    assert.ok(large.risk_of_ruin_pct > small.risk_of_ruin_pct,
      `20% risk (${large.risk_of_ruin_pct}%) should ruin more often than 1% (${small.risk_of_ruin_pct}%)`);
  });

  it('finds more ruin at a worse edge', () => {
    const good = riskOfRuin({ win_rate_pct: 60, risk_reward: 2, risk_per_trade_pct: 5, simulations: 2000 });
    const bad = riskOfRuin({ win_rate_pct: 30, risk_reward: 2, risk_per_trade_pct: 5, simulations: 2000 });
    assert.ok(bad.risk_of_ruin_pct > good.risk_of_ruin_pct);
  });

  it('grows the account when the edge is real and the size is sane', () => {
    const r = riskOfRuin({ win_rate_pct: 60, risk_reward: 2, risk_per_trade_pct: 1, trades: 200, simulations: 2000 });
    assert.ok(r.median_final_multiple > 1, `expected growth, got ${r.median_final_multiple}`);
    assert.ok(r.risk_of_ruin_pct < 5);
  });

  it('reports the worst 5% outcome, not just the median', () => {
    const r = riskOfRuin({ win_rate_pct: 55, risk_reward: 2, simulations: 1000 });
    assert.ok(r.worst_5pct_final_multiple <= r.median_final_multiple);
    assert.ok(Number.isFinite(r.longest_losing_streak_seen));
  });

  it('states that trades are modelled as independent', () => {
    const r = riskOfRuin({ win_rate_pct: 55, simulations: 200 });
    assert.match(r.caveat, /independent/i);
    assert.match(r.caveat, /cluster/i);
    assert.match(r.method, /seeded/i);
  });

  it('rejects impossible inputs', () => {
    assert.equal(riskOfRuin({ win_rate_pct: -1 }).available, false);
    assert.equal(riskOfRuin({ win_rate_pct: 50, risk_per_trade_pct: 100 }).available, false);
    assert.equal(riskOfRuin({ win_rate_pct: 50, risk_reward: 0 }).available, false);
  });
});

describe('recoveryRequired — the asymmetry', () => {
  it('gets the textbook figures right', () => {
    assert.equal(recoveryRequired(50).gain_required_pct, 100);
    assert.equal(recoveryRequired(80).gain_required_pct, 400);
    assert.equal(recoveryRequired(10).gain_required_pct, 11.11);
  });

  it('refuses a 100% loss rather than dividing by zero', () => {
    assert.equal(recoveryRequired(100).available, false);
    assert.equal(recoveryRequired(0).available, false);
    assert.match(recoveryRequired(100).note, /cannot be recovered/i);
  });

  it('produces a curve that accelerates', () => {
    const rows = recoveryTable().rows;
    for (let i = 1; i < rows.length; i++) {
      assert.ok(rows[i].gain_required_pct > rows[i - 1].gain_required_pct);
    }
    // The gap between successive levels must widen — that is the whole point.
    const first = rows[1].gain_required_pct - rows[0].gain_required_pct;
    const last = rows[rows.length - 1].gain_required_pct - rows[rows.length - 2].gain_required_pct;
    assert.ok(last > first * 10, 'the curve must accelerate, not run straight');
  });
});

describe('sizeByVolatility', () => {
  it('sizes so the ATR stop costs exactly the risk amount', () => {
    // 100k account, 1% risk = 1000. ATR 5, 2x = 10 wide. 100 shares.
    const r = sizeByVolatility({ account_size: 100000, risk_percent: 1, entry: 200, atr: 5 });
    assert.equal(r.available, true);
    assert.equal(r.risk_amount, 1000);
    assert.equal(r.stop_distance, 10);
    assert.equal(r.stop_price, 190);
    assert.equal(r.shares, 100);
  });

  it('puts a short stop above the entry', () => {
    const r = sizeByVolatility({ account_size: 100000, risk_percent: 1, entry: 200, atr: 5, direction: 'short' });
    assert.equal(r.stop_price, 210);
  });

  it('takes fewer shares when volatility rises', () => {
    const calm = sizeByVolatility({ account_size: 100000, risk_percent: 1, entry: 200, atr: 2 });
    const wild = sizeByVolatility({ account_size: 100000, risk_percent: 1, entry: 200, atr: 10 });
    assert.ok(wild.shares < calm.shares, 'a more volatile instrument must get a smaller position');
  });

  it('warns when a manual stop sits inside the ordinary bar range', () => {
    const r = sizeByVolatility({ account_size: 100000, risk_percent: 1, entry: 200, atr: 5, manual_stop: 197 });
    assert.equal(r.manual_stop.atr_multiples_away, 0.6);
    assert.match(r.manual_stop.comparison, /normal noise will hit it/i);
  });

  it('compares a wider manual stop without calling it wrong', () => {
    const r = sizeByVolatility({ account_size: 100000, risk_percent: 1, entry: 200, atr: 5, manual_stop: 180 });
    assert.match(r.manual_stop.comparison, /Wider than/);
    assert.ok(r.manual_stop.shares < r.shares, 'a wider stop must mean fewer shares');
  });

  it('rejects bad inputs instead of guessing', () => {
    assert.equal(sizeByVolatility({ account_size: 0, risk_percent: 1, entry: 100, atr: 2 }).available, false);
    assert.equal(sizeByVolatility({ account_size: 1000, risk_percent: 1, entry: 100, atr: 0 }).available, false);
    assert.match(sizeByVolatility({ account_size: 1000, risk_percent: 1, entry: 100, atr: 0 }).note, /data_get_study_values/);
  });
});
