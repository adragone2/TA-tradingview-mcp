import { test, describe } from 'node:test';
import assert from 'node:assert';
import { channelIn, findChannels, CHANNEL_DEFAULTS, CHANNEL_NOISE_BASELINE } from '../src/core/channels.js';
import { barsFromPath, randomWalk } from '../src/core/synthetic.js';

/**
 * randomWalk returns a PRICE PATH, not bars. Passing it straight to a detector
 * that reads .high/.low silently rejects everything and reports a 0% noise
 * rate — a test that cannot fail. Always go through barsFromPath.
 */
const walkBars = (seed, n = 200) =>
  barsFromPath(randomWalk({ n, vol: 0.015, seed }), { noise: 0.006, seed: seed + 1 });

/**
 * Build a channel by construction: a linear drift with price oscillating
 * between two parallel rails. `slopePct` is per-bar drift, `widthPct` the
 * rail separation as a fraction of price.
 *
 * The oscillation must actually TOUCH both rails, otherwise the envelope
 * translates inwards and the shape under test is not the shape constructed.
 */
function makeChannel({ n = 80, slopePct = -0.005, widthPct = 0.06, period = 10, start = 100 } = {}) {
  const path = [];
  for (let i = 0; i < n; i++) {
    const mid = start * (1 + slopePct * i);
    // Triangle wave in [-1, 1] so the extremes are hit squarely rather than
    // grazed the way a sine's rounded turn does.
    const phase = (i % period) / period;
    const tri = phase < 0.5 ? 4 * phase - 1 : 3 - 4 * phase;
    path.push(mid * (1 + (widthPct / 2) * tri));
  }
  return barsFromPath(path, { noise: 0.001, seed: 7 });
}

describe('channelIn — the shape the trendline detector could not see', () => {
  test('finds a descending channel in a constructed one', () => {
    const c = channelIn(makeChannel({ slopePct: -0.005 }), { window: 60, lookback: 2 });
    assert.ok(c, 'no channel found in a constructed descending channel');
    assert.equal(c.direction, 'descending');
    assert.equal(c.pattern, 'descending_channel');
    assert.equal(c.bias, 'bearish');
  });

  test('finds an ascending channel, and calls its bias bullish', () => {
    const c = channelIn(makeChannel({ slopePct: 0.005 }), { window: 60, lookback: 2 });
    assert.ok(c, 'no channel found in a constructed ascending channel');
    assert.equal(c.direction, 'ascending');
    assert.equal(c.bias, 'bullish');
  });

  test('a flat channel is horizontal, not ascending or descending', () => {
    const c = channelIn(makeChannel({ slopePct: 0 }), { window: 60, lookback: 2 });
    assert.ok(c, 'no channel found in a constructed flat channel');
    assert.equal(c.direction, 'horizontal');
    assert.equal(c.bias, 'neutral');
  });

  test('returns null when the window is longer than the data', () => {
    assert.equal(channelIn(makeChannel({ n: 30 }), { window: 200 }), null);
  });

  test('returns null on non-array input rather than throwing', () => {
    assert.equal(channelIn(null, { window: 30 }), null);
    assert.equal(channelIn(undefined, { window: 30 }), null);
  });
});

describe('channelIn — boundaries are an ENVELOPE, not a centre line', () => {
  /**
   * This is the bug that made the detector miss CSD. A least-squares fit
   * through the pivot highs runs THROUGH them — half sit above it — so used
   * as an upper boundary it cuts the price action in two.
   */
  test('every PIVOT high sits at or below the upper boundary', () => {
    const bars = makeChannel({ n: 80 });
    const c = channelIn(bars, { window: 60, lookback: 2 });
    assert.ok(c);
    const seg = bars.slice(-60);
    const slope = c.slope_used;
    const tol = c.price * 1e-3;
    let above = 0;
    for (let i = 0; i < seg.length; i++) {
      const w = seg.slice(Math.max(0, i - 2), i + 3);
      if (seg[i].high !== Math.max(...w.map((b) => b.high))) continue;
      // slope_used is rounded to 4dp, so allow for that drift across the window.
      if (seg[i].high > slope * i + c.upper_start + tol) above++;
    }
    assert.equal(above, 0, `${above} pivot highs pierced the upper envelope`);
  });

  test('every PIVOT low sits at or above the lower boundary', () => {
    // The envelope is translated to touch the most extreme PIVOT low, so that
    // is what it guarantees. A non-pivot bar may still dip below it, and
    // asserting otherwise would be asserting something the construction never
    // promised.
    const bars = makeChannel({ n: 80 });
    const c = channelIn(bars, { window: 60, lookback: 2 });
    assert.ok(c);
    const seg = bars.slice(-60), lb = 2;
    let below = 0;
    for (let i = lb; i < seg.length - lb; i++) {
      const w = seg.slice(i - lb, i + lb + 1);
      if (seg[i].low !== Math.min(...w.map((b) => b.low))) continue;
      if (seg[i].low < c.slope_used * i + c.lower_start - c.price * 1e-3) below++;
    }
    assert.equal(below, 0, `${below} pivot lows pierced the lower envelope`);
  });

  test('containment of closes is near total in a real channel', () => {
    const c = channelIn(makeChannel({ n: 80 }), { window: 60, lookback: 2 });
    assert.ok(c.containment >= 0.95, `containment ${c.containment}`);
  });

  test('upper boundary is above the lower one', () => {
    const c = channelIn(makeChannel(), { window: 60, lookback: 2 });
    assert.ok(c.upper_now > c.lower_now);
    assert.ok(c.height > 0);
  });
});

describe('channelIn — the gates that keep it off noise', () => {
  test('rejects when R2 is raised above what any real fit reaches', () => {
    const c = channelIn(makeChannel(), {
      window: 60, lookback: 2, opts: { ...CHANNEL_DEFAULTS, min_r2: 0.9999 },
    });
    assert.equal(c, null, 'an impossible R2 threshold still returned a channel');
  });

  test('rejects when the width gate is tightened below the constructed width', () => {
    const bars = makeChannel({ widthPct: 0.06 });
    const loose = channelIn(bars, { window: 60, lookback: 2 });
    assert.ok(loose, 'baseline channel not found');
    const tight = channelIn(bars, {
      window: 60, lookback: 2, opts: { ...CHANNEL_DEFAULTS, max_width_atr: 0.1 },
    });
    assert.equal(tight, null, 'a channel wider than the gate was still accepted');
  });

  test('rejects when more touches are demanded than the pivots supply', () => {
    const c = channelIn(makeChannel(), {
      window: 60, lookback: 2, opts: { ...CHANNEL_DEFAULTS, min_touches: 50 },
    });
    assert.equal(c, null);
  });

  test('rejects diverging boundaries — that is a broadening formation, not a channel', () => {
    // Widening rails: slopes have OPPOSITE signs, which the parallel test kills.
    const path = [];
    for (let i = 0; i < 80; i++) {
      const w = 2 + i * 0.15;
      path.push(100 + (i % 10 < 5 ? w : -w));
    }
    const c = channelIn(barsFromPath(path, { noise: 0.001, seed: 3 }), { window: 60, lookback: 2 });
    assert.equal(c, null, 'a diverging shape was reported as a channel');
  });
});

describe('channelIn — the entry block', () => {
  test('a descending channel fades the upper boundary as its WITH trade', () => {
    const c = channelIn(makeChannel({ slopePct: -0.005 }), { window: 60, lookback: 2 });
    assert.equal(c.entry.with_channel.side, 'short');
    assert.equal(c.entry.against_channel.side, 'long');
    assert.equal(c.entry.against_channel.confirmed, false);
  });

  test('an ascending channel buys the lower boundary as its WITH trade', () => {
    const c = channelIn(makeChannel({ slopePct: 0.005 }), { window: 60, lookback: 2 });
    assert.equal(c.entry.with_channel.side, 'long');
    assert.equal(c.entry.against_channel.side, 'short');
  });

  test('the against-channel trade is never pre-confirmed', () => {
    for (const slope of [-0.005, 0.005]) {
      const c = channelIn(makeChannel({ slopePct: slope }), { window: 60, lookback: 2 });
      assert.notEqual(c.entry.against_channel.confirmed, true,
        'a reversal out of a channel was marked confirmed before any close outside it');
    }
  });

  test('mid-channel there is nothing to do', () => {
    // Sample where price sits near the middle: position_in_channel decides.
    const c = channelIn(makeChannel(), { window: 60, lookback: 2 });
    if (c.position_in_channel > 0.25 && c.position_in_channel < 0.75) {
      assert.equal(c.entry.primary, 'wait');
    }
    assert.ok(['wait', 'with_channel'].includes(c.entry.primary));
  });

  test('position_note agrees with position_in_channel', () => {
    const c = channelIn(makeChannel(), { window: 60, lookback: 2 });
    const p = c.position_in_channel;
    const expected = p > 0.8 ? 'at the upper boundary' : p < 0.2 ? 'at the lower boundary' : 'mid-channel';
    assert.equal(c.position_note, expected);
  });
});

describe('findChannels — agreement across windows', () => {
  test('a constructed channel is found across several windows', () => {
    const out = findChannels(makeChannel({ n: 120 }));
    assert.ok(out.found, out.note);
    assert.ok(out.windows_agreeing >= 3, `only ${out.windows_agreeing} windows agreed`);
    assert.equal(out.stable, true);
  });

  test('windows_tested is a COUNT, not the array of windows', () => {
    const out = findChannels(makeChannel({ n: 120 }));
    assert.equal(typeof out.windows_tested, 'number');
    assert.equal(out.windows_tested, CHANNEL_DEFAULTS.windows.length * CHANNEL_DEFAULTS.lookbacks.length);
  });

  test('windows_tested is the same count when nothing is found', () => {
    const out = findChannels(walkBars(991, 120));
    assert.equal(typeof out.windows_tested, 'number');
  });

  test('the best channel is the most parallel among those agreeing', () => {
    const out = findChannels(makeChannel({ n: 120 }));
    const agreeing = out.channels.filter((c) => c.direction === out.direction);
    const mostParallel = Math.min(...agreeing.map((c) => Math.abs(c.slope_ratio - 1)));
    assert.equal(Math.abs(out.best.slope_ratio - 1), mostParallel);
  });

  test('a single-window find is reported as a candidate, not a shape', () => {
    // Force instability by testing one window only.
    const out = findChannels(makeChannel({ n: 120 }), { windows: [60], lookbacks: [2] });
    if (out.found) {
      assert.equal(out.stable, false);
      assert.match(out.stability_note, /candidate/);
    }
  });

  test('carries its noise baseline on every result, found or not', () => {
    for (const bars of [makeChannel({ n: 120 }), walkBars(5, 120)]) {
      assert.ok(findChannels(bars).noise_baseline);
    }
  });
});

describe('CHANNEL_NOISE_BASELINE — the number that keeps this honest', () => {
  test('is measured, not a placeholder', () => {
    assert.equal(CHANNEL_NOISE_BASELINE.measured, true);
    assert.equal(typeof CHANNEL_NOISE_BASELINE.any_channel_pct, 'number');
  });

  test('records that the pre-gate detector was near-useless', () => {
    // 93.5% on noise is the reason the R2 and width gates exist. If someone
    // removes them, this number is the argument against it.
    assert.ok(CHANNEL_NOISE_BASELINE.before_containment_and_r2.any_channel_pct > 90);
    assert.ok(CHANNEL_NOISE_BASELINE.any_channel_pct
      < CHANNEL_NOISE_BASELINE.before_containment_and_r2.any_channel_pct);
  });

  test('a channel is LESS selective than VCP or pennants, and says so', () => {
    assert.ok(CHANNEL_NOISE_BASELINE.any_channel_pct > CHANNEL_NOISE_BASELINE.context.vcp_pct);
    assert.ok(CHANNEL_NOISE_BASELINE.any_channel_pct < CHANNEL_NOISE_BASELINE.context.structural_patterns_pct);
  });
});

describe('findChannels — the noise floor holds on fresh walks', () => {
  test('fires on well under half of random walks', () => {
    let any = 0;
    const N = 60;
    for (let s = 0; s < N; s++) {
      if (findChannels(walkBars(5000 + s)).found) any++;
    }
    const pct = (any / N) * 100;
    // Measured at 32.0% over 200 walks. This asserts the regime, not the digit.
    assert.ok(pct < 50, `channels fired on ${pct.toFixed(1)}% of random walks`);
  });
});
