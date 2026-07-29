/**
 * Transaction-cost and portfolio-risk tests.
 *
 * The important assertions here are the ones that stop the arithmetic
 * flattering a strategy:
 *
 *   - costs must be charged on BOTH legs, or a round trip costs half what it
 *     should and every thin edge survives that should not.
 *   - an edge smaller than its costs must come back as unprofitable.
 *   - portfolio heat must not treat correlated positions as independent, and
 *     unknown correlation must read UNKNOWN rather than zero.
 *
 * Run: node --test tests/costs.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { tradeCost, applyCostsToEdge, gapRisk, luldBand, LULD_DOUBLING_WINDOWS, COST_PRESETS } from '../src/core/costs.js';
import { portfolioHeat, positionCorrelation, concentration } from '../src/core/portfolio.js';

describe('tradeCost', () => {
  it('charges commission on both legs', () => {
    const r = tradeCost({ entry: 100, shares: 100, commission_per_share: 0.01 });
    assert.equal(r.breakdown.commission, 2, '100 shares x $0.01 x 2 legs = $2');
  });

  it('charges one full spread for the round trip', () => {
    const r = tradeCost({ entry: 100, shares: 100, spread_pct: 0.05 });
    assert.equal(r.breakdown.spread, 5, '0.05% of $10,000 notional');
  });

  it('expresses slippage in ATR, not in cents', () => {
    const cheap = tradeCost({ entry: 100, shares: 100, slippage_atr: 0.05, atr: 1 });
    const wild = tradeCost({ entry: 100, shares: 100, slippage_atr: 0.05, atr: 5 });
    assert.ok(wild.breakdown.slippage > cheap.breakdown.slippage,
      'a more volatile instrument must cost more to get filled in');
  });

  it('warns rather than silently omitting slippage when ATR is missing', () => {
    const r = tradeCost({ entry: 100, shares: 100, slippage_atr: 0.05 });
    assert.equal(r.breakdown.slippage, 0);
    assert.match(r.slippage_warning, /optimistic/i);
  });

  it('charges borrow only on shorts, and only for the days held', () => {
    const long = tradeCost({ entry: 100, shares: 100, direction: 'long', bars_held: 30, borrow_apr_pct: 10 });
    const short1 = tradeCost({ entry: 100, shares: 100, direction: 'short', bars_held: 1, borrow_apr_pct: 10 });
    const short30 = tradeCost({ entry: 100, shares: 100, direction: 'short', bars_held: 30, borrow_apr_pct: 10 });
    assert.equal(long.breakdown.borrow, 0, 'a long position does not pay borrow');
    assert.ok(short30.breakdown.borrow > short1.breakdown.borrow);
  });

  it('reports the cost in R, which is what makes it comparable to an edge', () => {
    // Risk $2/share x 100 shares = $200 of R. $20 of cost = 0.1R.
    const r = tradeCost({ entry: 100, stop: 98, shares: 100, spread_pct: 0.2 });
    assert.equal(r.cost_in_r, 0.1);
  });

  it('says how to get the R figure when no stop was given', () => {
    const r = tradeCost({ entry: 100, shares: 100, spread_pct: 0.1 });
    assert.equal(r.cost_in_r, null);
    assert.match(r.r_note, /Pass `stop`/);
  });

  it('applies a preset and still lets an explicit value override it', () => {
    const preset = tradeCost({ entry: 100, shares: 1000, preset: 'ibkr_pro_fixed' });
    assert.ok(preset.breakdown.commission > 0);
    const override = tradeCost({ entry: 100, shares: 1000, preset: 'ibkr_pro_fixed', spread_pct: 1 });
    assert.ok(override.breakdown.spread > preset.breakdown.spread);
  });

  it('offers presets for the common asset classes', () => {
    for (const k of ['ibkr_pro_fixed', 'ibkr_pro_tiered', 'us_equity_zero_commission', 'crypto', 'forex_major', 'futures']) {
      assert.ok(COST_PRESETS[k], `missing preset ${k}`);
    }
  });

  it('rejects nonsense inputs rather than returning a number', () => {
    assert.equal(tradeCost({ entry: 0, shares: 10 }).available, false);
    assert.equal(tradeCost({ entry: 100, shares: 0 }).available, false);
  });
});

describe('applyCostsToEdge', () => {
  it('subtracts costs from the gross edge', () => {
    const r = applyCostsToEdge({ expectancy_r: 0.35, cost_in_r: 0.15 });
    assert.equal(r.net_expectancy_r, 0.2);
    assert.equal(r.edge_consumed_pct, 42.9);
    assert.equal(r.still_profitable, true);
  });

  it('calls an edge smaller than its costs a LOSING strategy', () => {
    // The case the module exists for: a backtest that looked fine and is not.
    const r = applyCostsToEdge({ expectancy_r: 0.08, cost_in_r: 0.12 });
    assert.equal(r.still_profitable, false);
    assert.ok(r.net_expectancy_r < 0);
    assert.match(r.verdict, /loses money in practice however the backtest looked/i);
  });

  it('flags a surviving-but-fragile edge', () => {
    const r = applyCostsToEdge({ expectancy_r: 0.2, cost_in_r: 0.12 });
    assert.equal(r.still_profitable, true);
    assert.match(r.verdict, /fragile/i);
  });

  it('scales the drag by turnover when trades per year is given', () => {
    const few = applyCostsToEdge({ expectancy_r: 0.3, cost_in_r: 0.1, trades_per_year: 10 });
    const many = applyCostsToEdge({ expectancy_r: 0.3, cost_in_r: 0.1, trades_per_year: 200 });
    assert.equal(few.cost_r_per_year, 1);
    assert.equal(many.cost_r_per_year, 20);
    assert.ok(many.net_r_per_year > few.net_r_per_year, 'more trades still means more net R at a positive edge');
  });

  it('requires the inputs rather than assuming zero cost', () => {
    assert.equal(applyCostsToEdge({ cost_in_r: 0.1 }).available, false);
    assert.equal(applyCostsToEdge({ expectancy_r: 0.3, cost_in_r: -1 }).available, false);
  });
});

describe('gapRisk', () => {
  let t = 1_700_000_000;
  const bar = (o, h, l, c) => ({ time: (t += 86400), open: o, high: h, low: l, close: c, volume: 1000 });
  const reset = () => { t = 1_700_000_000; };

  it('counts bars that opened beyond the stop distance', () => {
    reset();
    const bars = [bar(100, 101, 99, 100), bar(90, 91, 89, 90), bar(90, 91, 89, 90)];
    const r = gapRisk(bars, { stop_distance_pct: 2 });
    assert.equal(r.available, true);
    assert.ok(r.gapped_through_count >= 1);
    assert.ok(r.worst_gap_pct >= 9);
  });

  it('finds nothing when the stop sits outside every gap', () => {
    reset();
    const bars = Array.from({ length: 40 }, () => bar(100, 101, 99, 100));
    const r = gapRisk(bars, { stop_distance_pct: 5 });
    assert.equal(r.gapped_through_count, 0);
    assert.match(r.interpretation, /not a promise about the next one/i);
  });

  it('finds more gaps as the stop gets tighter', () => {
    reset();
    const bars = Array.from({ length: 60 }, (_, i) => {
      const drift = i % 3 === 0 ? -3 : 1;
      const p = 100 + i * 0.1;
      return bar(p + drift, p + drift + 1, p + drift - 1, p);
    });
    const tight = gapRisk(bars, { stop_distance_pct: 0.5 });
    const wide = gapRisk(bars, { stop_distance_pct: 10 });
    assert.ok(tight.gapped_through_count >= wide.gapped_through_count);
  });

  it('states that backtests here understate their worst losses', () => {
    reset();
    const bars = Array.from({ length: 10 }, () => bar(100, 101, 99, 100));
    assert.match(gapRisk(bars).caveat, /understates its worst losses/i);
  });

  it('declines on too little data', () => {
    reset();
    assert.equal(gapRisk([bar(1, 1, 1, 1)]).available, false);
  });
});

describe('portfolioHeat', () => {
  const pos = (symbol, entry, stop, shares, extra = {}) => ({ symbol, entry, stop, shares, ...extra });

  it('sums the risk if every stop is hit', () => {
    const r = portfolioHeat([pos('A', 100, 98, 100), pos('B', 50, 49, 200)], { account_size: 100000 });
    assert.equal(r.total_risk, 400);
    assert.equal(r.heat_pct, 0.4);
  });

  it('counts a stop at break-even as no risk', () => {
    const r = portfolioHeat([pos('A', 100, 100, 100), pos('B', 50, 49, 100)], { account_size: 100000 });
    assert.equal(r.total_risk, 100);
    assert.equal(r.risk_free_positions, 1);
  });

  it('handles shorts with the stop above entry', () => {
    const r = portfolioHeat([pos('A', 100, 102, 100, { direction: 'short' })], { account_size: 100000 });
    assert.equal(r.total_risk, 200);
  });

  it('flags heat over the limit', () => {
    const many = Array.from({ length: 8 }, (_, i) => pos(`S${i}`, 100, 99, 1000));
    const r = portfolioHeat(many, { account_size: 100000, max_heat_pct: 6 });
    assert.equal(r.within_limit, false);
    assert.match(r.verdict, /stops tend to be hit together/i);
  });

  it('skips malformed positions instead of counting them as zero', () => {
    const r = portfolioHeat([pos('A', 100, 98, 100), { symbol: 'B' }], { account_size: 100000 });
    assert.equal(r.open_positions, 1);
    assert.equal(r.skipped.length, 1);
  });

  it('says heat assumes stops fill at their price', () => {
    const r = portfolioHeat([pos('A', 100, 98, 100)], { account_size: 100000 });
    assert.match(r.caveat, /Gaps fill worse/i);
    assert.match(r.caveat, /treats positions as independent/i);
  });
});

describe('positionCorrelation', () => {
  const n = 60;
  const base = Array.from({ length: n }, (_, i) => Math.sin(i / 3) / 100);

  it('finds a high correlation between series that move together', () => {
    const r = positionCorrelation({ A: base, B: base.map((v) => v * 1.1) });
    assert.equal(r.available, true);
    assert.ok(r.average_correlation > 0.95);
    assert.match(r.interpretation, /mostly nominal/i);
  });

  it('finds a negative correlation between series that move opposite', () => {
    const r = positionCorrelation({ A: base, B: base.map((v) => -v) });
    assert.ok(r.average_correlation < -0.95);
  });

  it('collapses effective positions when everything is correlated', () => {
    const r = positionCorrelation({ A: base, B: base.map((v) => v * 1.05), C: base.map((v) => v * 0.95) });
    assert.equal(r.position_count, 3);
    assert.ok(r.effective_positions < 1.5, `3 correlated positions are not 3 bets, got ${r.effective_positions}`);
  });

  it('reports UNKNOWN rather than zero when there is too little data', () => {
    // Assuming independence is exactly the error this measures.
    const r = positionCorrelation({ A: [0.01, 0.02], B: [0.01, 0.02] });
    assert.equal(r.available, false);
    assert.match(r.note, /UNKNOWN — which is not the same as zero/i);
  });

  it('counts unknown pairs separately when some pairs do resolve', () => {
    const r = positionCorrelation({ A: base, B: base.map((v) => v * 1.1), C: [0.01] });
    assert.ok(r.unknown_pairs >= 1);
    assert.match(r.unknown_note, /not zero/i);
  });

  it('warns that correlation rises exactly when it matters', () => {
    const r = positionCorrelation({ A: base, B: base.map((v) => v * 1.1) });
    assert.match(r.caveat, /rise sharply in a selloff/i);
  });
});

describe('concentration', () => {
  const pos = (symbol, sector, entry, stop, shares) => ({ symbol, sector, entry, stop, shares });

  it('groups open risk by bucket, measured in risk not notional', () => {
    const r = concentration([
      pos('A', 'semis', 100, 98, 100),
      pos('B', 'semis', 100, 98, 100),
      pos('C', 'energy', 100, 99, 100),
    ], { key: 'sector' });
    assert.equal(r.largest_bucket.bucket, 'semis');
    assert.equal(r.largest_bucket.risk, 400);
    assert.equal(r.total_risk, 500);
  });

  it('calls out a book that is one bet in several names', () => {
    const r = concentration([
      pos('A', 'semis', 100, 98, 100),
      pos('B', 'semis', 100, 98, 100),
      pos('C', 'energy', 100, 99.9, 10),
    ], { key: 'sector' });
    assert.ok(r.largest_bucket.share_pct >= 50);
    assert.match(r.interpretation, /one bet in several names/i);
  });

  it('reports untagged positions rather than hiding them', () => {
    const r = concentration([pos('A', 'semis', 100, 98, 100), { symbol: 'B', entry: 100, stop: 98, shares: 100 }]);
    assert.equal(r.untagged_positions, 1);
    assert.match(r.untagged_note, /cannot be judged/i);
  });

  it('groups by any key, not just sector', () => {
    const r = concentration([
      { symbol: 'A', direction: 'long', entry: 100, stop: 98, shares: 100 },
      { symbol: 'B', direction: 'long', entry: 100, stop: 98, shares: 100 },
    ], { key: 'direction' });
    assert.equal(r.largest_bucket.bucket, 'long');
    assert.equal(r.largest_bucket.share_pct, 100);
  });

  it('declines when every stop is at break-even', () => {
    const r = concentration([pos('A', 'semis', 100, 100, 100)]);
    assert.equal(r.available, false);
  });
});

describe('tradeCost — the IBKR schedule, where the minimum is the point', () => {
  it('charges the per-order minimum, not the per-share rate, on a small order', () => {
    // 100 shares x $0.005 = $0.50, but IBKR Pro Fixed has a $1.00 minimum.
    // A model without the minimum understates this order by half.
    const r = tradeCost({ entry: 100, shares: 100, preset: 'ibkr_pro_fixed' });
    assert.equal(r.breakdown.commission, 2, '$1.00 minimum x 2 legs');
    assert.equal(r.minimum_binding, true);
    assert.match(r.minimum_note, /Small orders are where cost assumptions break/);
  });

  it('charges the per-share rate once the order is large enough', () => {
    const r = tradeCost({ entry: 100, shares: 1000, preset: 'ibkr_pro_fixed' });
    assert.equal(r.breakdown.commission, 10, '1000 x $0.005 x 2 legs');
    assert.notEqual(r.minimum_binding, true);
  });

  it('caps commission at 1% of trade value', () => {
    // 10,000 shares of a $0.10 stock: rate says $50/leg, the cap says $10/leg.
    const r = tradeCost({ entry: 0.10, shares: 10000, preset: 'ibkr_pro_fixed' });
    assert.equal(r.breakdown.commission, 20, '1% of $1,000 notional, both legs');
  });

  it('applies the minimum PER LEG, not per round trip', () => {
    const r = tradeCost({ entry: 100, shares: 10, preset: 'ibkr_pro_fixed' });
    assert.equal(r.breakdown.commission, 2, 'the minimum is charged on entry and on exit');
  });

  it('cites where the schedule came from', () => {
    const r = tradeCost({ entry: 100, shares: 100, preset: 'ibkr_pro_fixed' });
    assert.match(r.preset_source, /Interactive Brokers/);
    assert.match(r.preset_source, /Regulatory fees pass through/);
  });

  it('warns that tiered is not simply cheaper than fixed', () => {
    const r = tradeCost({ entry: 100, shares: 1000, preset: 'ibkr_pro_tiered' });
    assert.match(r.preset_source, /ADDITIONAL and not modelled/);
  });

  it('lets an explicit minimum override the preset', () => {
    const r = tradeCost({ entry: 100, shares: 100, preset: 'ibkr_pro_fixed', commission_min_per_order: 0 });
    assert.equal(r.breakdown.commission, 1, '100 x $0.005 x 2 legs with no minimum');
  });

  it('makes the small-order penalty visible in R', () => {
    const small = tradeCost({ entry: 100, stop: 98, shares: 50, preset: 'ibkr_pro_fixed', atr: 2 });
    const large = tradeCost({ entry: 100, stop: 98, shares: 5000, preset: 'ibkr_pro_fixed', atr: 2 });
    assert.ok(small.cost_in_r > large.cost_in_r,
      `a small order must cost proportionally more: ${small.cost_in_r}R vs ${large.cost_in_r}R`);
  });
});

describe('LULD bands — the intraday twin of gap risk', () => {
  it('Tier 1 above $3 is 5%, Tier 2 is 10%', () => {
    assert.equal(luldBand({ price: 200, tier: 1 }).band_pct, 5);
    assert.equal(luldBand({ price: 200, tier: 2 }).band_pct, 10);
  });

  it('the tier error practitioners actually make is called out', () => {
    /**
     * Retail material routinely quotes "10% above $3", which is Tier 2. Applied
     * to an S&P 500 name that is twice the real band — it says a stock can run
     * 10% before halting when it halts at 5%.
     */
    assert.match(luldBand({ price: 200, tier: 1 }).common_error, /TIER 2/);
    assert.equal(luldBand({ price: 200, tier: 1 }).band_pct * 2,
      luldBand({ price: 200, tier: 2 }).band_pct);
  });

  it('bands DOUBLE in the opening and closing windows', () => {
    const normal = luldBand({ price: 200, tier: 1 });
    const doubled = luldBand({ price: 200, tier: 1, in_doubling_window: true });
    assert.equal(doubled.effective_band_pct, normal.effective_band_pct * 2);
    // The closing window matters most: it is where stop-driven exits cluster.
    assert.ok(LULD_DOUBLING_WINDOWS.some((w) => w.from === '15:35' && w.to === '16:00'));
  });

  it('the $0.75-$3.00 band is 20% and does not depend on tier', () => {
    assert.equal(luldBand({ price: 2, tier: 1 }).band_pct, 20);
    assert.equal(luldBand({ price: 2, tier: 2 }).band_pct, 20);
  });

  it('below $0.75 the band is the LESSER of 75% and $0.15', () => {
    // At $0.40, $0.15 is 37.5% — the binding constraint. At $0.10 it would be
    // 150%, so 75% binds instead.
    assert.equal(luldBand({ price: 0.40 }).band_pct, 37.5);
    assert.equal(luldBand({ price: 0.10 }).band_pct, 75);
  });

  it('the absolute band is returned, not just a percentage', () => {
    // A stop is placed in dollars. A percentage alone leaves the arithmetic to
    // the reader at exactly the moment it matters.
    assert.equal(luldBand({ price: 200, tier: 1 }).band_abs, 10);
  });

  it('it says a stop does not get its price in a halt', () => {
    const r = luldBand({ price: 50, tier: 1 });
    assert.match(r.what_it_means, /resumption auction/);
    assert.match(r.stop_implication, /gapRisk/);
  });

  it('bad input returns unavailable rather than a plausible number', () => {
    assert.equal(luldBand({ price: 0 }).available, false);
    assert.equal(luldBand({ price: -5 }).available, false);
    assert.equal(luldBand({ price: 10, tier: 3 }).available, false);
  });
});
