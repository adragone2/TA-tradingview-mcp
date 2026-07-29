import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  barMinutes, scaleTimeframe, scalingExponent, SESSION_MINUTES,
} from '../src/core/timeframe.js';
import { randomWalk, barsFromPath, rng } from '../src/core/synthetic.js';

/**
 * An AR(1) return series: r_t = phi * r_{t-1} + eps.
 *
 * The exponent measures how the STANDARD DEVIATION of returns grows with
 * horizon, so only serial correlation moves it. A constant drift shifts the
 * mean and leaves the variance alone — the first version of this file tried to
 * make a trending fixture with `drift` and got 0.5, which was the code being
 * right and the fixture being wrong.
 */
function ar1Bars(phi, { n = 600, seed = 1, vol = 0.01 } = {}) {
  const r = rng(seed);
  let prev = 0;
  let px = 100;
  const path = [px];
  for (let i = 1; i < n; i++) {
    const eps = (r() - 0.5) * 2 * vol;
    const ret = phi * prev + eps;
    prev = ret;
    px = Math.max(1, px * (1 + ret));
    path.push(px);
  }
  return barsFromPath(path, { noise: 0.002, seed: seed + 1 });
}
const meanExponent = (phi) => {
  const es = [97, 194, 291, 388, 485].map((s) => scalingExponent(ar1Bars(phi, { seed: s })).exponent);
  return es.reduce((a, b) => a + b, 0) / es.length;
};

describe('bar duration', () => {
  test('a bare number is minutes', () => {
    assert.equal(barMinutes('5'), 5);
    assert.equal(barMinutes('60'), 60);
  });

  test('a day is the SESSION, not 24 hours', () => {
    /**
     * The whole load-bearing convention. Shannon's table only balances under a
     * 390-minute session: 65 x 30min = 1950 = 5 x 390. Using 1440 would put
     * every daily-to-intraday translation out by a factor of 3.7.
     */
    assert.equal(barMinutes('1D'), 390);
    assert.equal(SESSION_MINUTES, 390);
    assert.notEqual(barMinutes('1D'), 1440);
  });

  test('weeks and months are multiples of the session', () => {
    assert.equal(barMinutes('1W'), 390 * 5);
    assert.equal(barMinutes('1M'), 390 * 21);
  });

  test('unparseable resolutions are null, not a guess', () => {
    assert.equal(barMinutes('banana'), null);
    assert.equal(barMinutes(''), null);
    assert.equal(barMinutes(null), null);
  });
});

describe("the two laws, checked against their sources' own arithmetic", () => {
  test("Grimes: a 1.5pt stop on 5min becomes 5.2 on hourly", () => {
    // Waverly Advisors 2013, slide 6. He states 5.2; sqrt(60/5) = 3.4641.
    const r = scaleTimeframe({ from: '5', to: '60', price_distance: 1.5 });
    assert.equal(r.volatility_factor, 3.4641);
    assert.ok(Math.abs(r.price_distance.to - 5.2) < 0.01,
      `expected ~5.2, got ${r.price_distance.to}`);
  });

  test("Shannon: 65 bars on 30min becomes 195 on 10min", () => {
    // Fig. 10.4 confirmation column. Both span 5 trading days.
    const r = scaleTimeframe({ from: '30', to: '10', lookback_bars: 65 });
    assert.equal(r.lookback.to_bars_rounded, 195);
    assert.equal(r.lookback.spans_sessions, 5);
  });

  test('a lookback keeps its calendar span, which is the point', () => {
    const a = scaleTimeframe({ from: '1D', to: '60', lookback_bars: 20 });
    // 20 daily bars = 20 sessions. The hourly equivalent must span the same.
    assert.equal(a.lookback.spans_sessions, 20);
    assert.equal(a.lookback.to_bars_rounded, 130); // 20 x 390/60
  });

  test('the two factors DIFFER — conflating them is the error being prevented', () => {
    const r = scaleTimeframe({ from: '5', to: '60' });
    assert.notEqual(r.volatility_factor, r.timeframe_ratio);
    // Linear would give 12x on a stop where the correct answer is ~3.46x.
    assert.equal(r.timeframe_ratio, 12);
    assert.equal(r.volatility_factor, 3.4641);
    assert.match(r.laws.why_they_differ, /common error/);
  });
});

describe('the 3-5 spread guidance is symmetric', () => {
  test('daily to hourly reads as 6.5x apart, not 0.15', () => {
    /**
     * Regression. The signed ratio for daily->hourly is 0.1538, and judging the
     * band on that reported "below 3 — adds little information" for two views
     * that are actually 6.5x apart, i.e. the opposite advice.
     */
    const r = scaleTimeframe({ from: '1D', to: '60' });
    assert.equal(r.timeframe_spread, 6.5);
    assert.match(r.ratio_guidance, /above 5/);
    assert.match(r.ratio_guidance, /intermediate timeframe/);
  });

  test('the reading is the same in both directions', () => {
    const down = scaleTimeframe({ from: '1D', to: '60' });
    const up = scaleTimeframe({ from: '60', to: '1D' });
    assert.equal(down.timeframe_spread, up.timeframe_spread);
    assert.equal(down.ratio_guidance, up.ratio_guidance);
  });

  test('a 3-5 spread is reported as useful', () => {
    assert.match(scaleTimeframe({ from: '5', to: '15' }).ratio_guidance, /useful 3-5 band/);
  });

  test('too close together is flagged too', () => {
    assert.match(scaleTimeframe({ from: '5', to: '10' }).ratio_guidance, /below 3/);
  });

  test('unparseable input is unavailable, not a plausible number', () => {
    assert.equal(scaleTimeframe({ from: 'x', to: '60' }).available, false);
  });
});

describe('the scaling exponent', () => {
  const walk = (seed) => barsFromPath(randomWalk({ n: 500, seed }), { noise: 0.006, seed: seed + 1 });

  test('a random walk sits near 0.5 — the law it assumes', () => {
    /**
     * The calibration test. If a random walk did NOT come out near 0.5 the
     * estimator would be measuring its own construction rather than the series.
     */
    const es = [11, 22, 33, 44, 55].map((s) => scalingExponent(walk(s)).exponent);
    const mean = es.reduce((a, b) => a + b, 0) / es.length;
    assert.ok(Math.abs(mean - 0.5) < 0.08, `random walks averaged ${mean.toFixed(3)}, expected ~0.5`);
  });

  test('positive serial correlation reads ABOVE 0.5, negative BELOW', () => {
    assert.ok(meanExponent(0.5) > 0.58, `phi=+0.5 read ${meanExponent(0.5).toFixed(3)}`);
    assert.ok(meanExponent(-0.5) < 0.42, `phi=-0.5 read ${meanExponent(-0.5).toFixed(3)}`);
  });

  test('the reading is MONOTONIC in the autocorrelation, which is the real check', () => {
    // Any estimator can hit one number. Ordering across five values of phi is
    // what shows it is measuring persistence rather than its own construction.
    const es = [0.5, 0.3, 0, -0.3, -0.5].map(meanExponent);
    for (let i = 1; i < es.length; i++) {
      assert.ok(es[i] < es[i - 1], `not monotonic: ${es.map((e) => e.toFixed(3)).join(' > ')}`);
    }
  });

  test('a constant DRIFT does not move it — drift is not persistence', () => {
    /**
     * The distinction that broke the first draft of this test. Drift shifts the
     * mean; the exponent is about the variance. A tool that read drift as
     * persistence would call every bull market "trending" by construction.
     */
    const bars = barsFromPath(randomWalk({ n: 600, seed: 7, drift: 0.004 }), { noise: 0.002, seed: 8 });
    assert.ok(Math.abs(scalingExponent(bars).exponent - 0.5) < 0.15);
  });

  test('non-overlapping increments are used, and it says why', () => {
    // Overlapping windows share data, shrink apparent variance and manufacture
    // mean reversion — a bias that would flatter the reversal side.
    assert.match(scalingExponent(walk(3)).caution, /[Nn]on-overlapping/);
    assert.match(scalingExponent(walk(3)).caution, /bias the slope downward/);
  });

  test('no standard error is quoted, deliberately', () => {
    const r = scalingExponent(walk(4));
    for (const k of ['stderr', 'standard_error', 'p_value', 'confidence']) {
      assert.ok(!(k in r), `"${k}" would look far tighter than 4-6 points can support`);
    }
    assert.match(r.caution, /not a test/);
  });

  test('each horizon reports its own sample count', () => {
    const r = scalingExponent(walk(5));
    assert.ok(r.by_horizon.length >= 3);
    for (const h of r.by_horizon) assert.ok(h.samples >= 8, `horizon ${h.horizon} had ${h.samples} samples`);
  });

  test('too few bars is unavailable rather than a fitted slope', () => {
    assert.equal(scalingExponent(barsFromPath(randomWalk({ n: 40, seed: 1 }))).available, false);
    assert.equal(scalingExponent([]).available, false);
    assert.equal(scalingExponent(null).available, false);
  });
});
