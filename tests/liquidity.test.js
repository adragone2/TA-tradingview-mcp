/**
 * Liquidity unit tests — no TradingView connection needed.
 *
 * The fair-value-gap tests matter most for a reason that is not about
 * detection accuracy: these things occur constantly, and the failure mode is
 * presenting one as though it were rare. So the count-before-filtering is
 * asserted, not just the gaps themselves.
 *
 * Run: node --test tests/liquidity.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { anchoredVwap, fairValueGaps, equalHighsLows } from '../src/core/liquidity.js';

const DAY = 86400;
let t = 1_700_000_000;
const bar = (o, h, l, c, v = 1000) => ({ time: (t += DAY), open: o, high: h, low: l, close: c, volume: v });
const reset = () => { t = 1_700_000_000; };
const flat = (n, p = 100, v = 1000) => Array.from({ length: n }, () => bar(p, p + 1, p - 1, p, v));

describe('anchoredVwap', () => {
  it('equals the typical price when every bar is identical', () => {
    reset();
    const r = anchoredVwap(flat(20, 100));
    assert.equal(r.available, true);
    assert.ok(Math.abs(r.vwap - 100) < 1e-9);
    assert.ok(r.std_dev < 1e-6, 'identical bars have no deviation');
  });

  it('weights by volume, not by bar count', () => {
    reset();
    const bars = [bar(10, 10, 10, 10, 1), bar(20, 20, 20, 20, 99)];
    assert.ok(anchoredVwap(bars).vwap > 19, 'the heavy bar should dominate');
  });

  it('respects the anchor — a later anchor gives a different VWAP', () => {
    reset();
    const bars = [...flat(10, 50), ...flat(10, 150)];
    const fromStart = anchoredVwap(bars, { anchor_index: 0 }).vwap;
    const fromMid = anchoredVwap(bars, { anchor_index: 10 }).vwap;
    assert.ok(fromMid > fromStart, 'anchoring past the cheap bars must lift the VWAP');
    assert.ok(Math.abs(fromMid - 150) < 1);
  });

  it('emits the requested standard-deviation bands, ordered outward', () => {
    reset();
    const bars = [...flat(10, 90), ...flat(10, 110)];
    const r = anchoredVwap(bars);
    assert.deepEqual(r.bands.map((b) => b.multiple), [1, 2, 3]);
    assert.ok(r.bands[2].upper > r.bands[0].upper);
    assert.ok(r.bands[2].lower < r.bands[0].lower);
  });

  it('reports who is in control from which side price sits', () => {
    reset();
    const up = [...flat(10, 90), ...flat(3, 200)];
    assert.equal(anchoredVwap(up).price_vs_vwap, 'above');
    reset();
    const down = [...flat(10, 200), ...flat(3, 90)];
    assert.equal(anchoredVwap(down).price_vs_vwap, 'below');
  });

  it('declines without volume rather than returning a plain average', () => {
    reset();
    assert.equal(anchoredVwap(flat(10, 100, 0)).available, false);
    assert.equal(anchoredVwap([]).available, false);
  });

  it('carries the context-not-a-trigger caveat', () => {
    reset();
    assert.match(anchoredVwap(flat(10, 100)).caveat, /not a trigger/i);
  });
});

describe('fairValueGaps', () => {
  it('detects a bullish gap where bar 1 high is below bar 3 low', () => {
    reset();
    const bars = [bar(100, 101, 99, 100), bar(101, 110, 100, 109), bar(110, 115, 105, 112), ...flat(3, 113)];
    const r = fairValueGaps(bars, { min_size_pct: 0.1 });
    const g = r.gaps.find((x) => x.direction === 'bullish');
    assert.ok(g, 'expected a bullish gap');
    assert.equal(g.bottom, 101);   // bar 1 high
    assert.equal(g.top, 105);      // bar 3 low
  });

  it('detects a bearish gap as the mirror', () => {
    reset();
    const bars = [bar(110, 111, 109, 110), bar(109, 110, 100, 101), bar(100, 105, 95, 97), ...flat(3, 96)];
    const g = fairValueGaps(bars, { min_size_pct: 0.1 }).gaps.find((x) => x.direction === 'bearish');
    assert.ok(g, 'expected a bearish gap');
    assert.equal(g.top, 109);
    assert.equal(g.bottom, 105);
  });

  it('does NOT report a gap when the bars overlap', () => {
    reset();
    const bars = [bar(100, 105, 99, 104), bar(104, 108, 103, 107), bar(107, 110, 104, 109), ...flat(3, 109)];
    assert.equal(fairValueGaps(bars).gaps.length, 0);
  });

  it('marks a gap price traded back through as filled and excludes it', () => {
    reset();
    const bars = [
      bar(100, 101, 99, 100), bar(101, 110, 100, 109), bar(110, 115, 105, 112),
      bar(112, 113, 100, 102),   // trades back down through the gap
      ...flat(2, 102),
    ];
    assert.equal(fairValueGaps(bars, { min_size_pct: 0.1 }).gaps.length, 0);
    const withFilled = fairValueGaps(bars, { min_size_pct: 0.1, include_filled: true });
    assert.ok(withFilled.gaps.some((g) => g.filled), 'it should still be findable, marked filled');
  });

  it('reports how many existed BEFORE filtering, so none looks rare', () => {
    reset();
    const bars = [bar(100, 101, 99, 100), bar(101, 110, 100, 109), bar(110, 115, 105, 112), ...flat(3, 113)];
    const r = fairValueGaps(bars, { min_size_pct: 0.1 });
    assert.ok(r.total_found >= 1);
    assert.match(r.reality_check, /common/i);
    assert.ok('filtered_too_small' in r && 'filtered_too_old' in r);
  });

  it('filters gaps below min_size_pct', () => {
    reset();
    const bars = [bar(100, 100.01, 99, 100), bar(100, 100.5, 100, 100.4), bar(100.4, 101, 100.02, 100.8), ...flat(3, 101)];
    const strict = fairValueGaps(bars, { min_size_pct: 5 });
    assert.equal(strict.gaps.length, 0);
    assert.ok(strict.filtered_too_small >= 1);
  });

  it('declines with fewer than three bars', () => {
    reset();
    assert.equal(fairValueGaps([bar(1, 2, 0, 1)]).gaps.length, 0);
  });
});

describe('equalHighsLows', () => {
  const sw = (kind, price, index = 0) => ({ kind, price, index, time: index });

  it('clusters swings at effectively one price into a pool', () => {
    const swings = [sw('high', 100, 1), sw('high', 100.05, 2), sw('high', 99.98, 3)];
    const r = equalHighsLows(swings, 95, { tolerance_pct: 0.15 });
    assert.equal(r.pools.length, 1);
    assert.equal(r.pools[0].kind, 'equal_highs');
    assert.equal(r.pools[0].touches, 3);
    assert.equal(r.pools[0].stops_rest, 'above');
  });

  it('does not cluster swings that are clearly apart', () => {
    const swings = [sw('high', 100, 1), sw('high', 120, 2)];
    assert.equal(equalHighsLows(swings, 95, { tolerance_pct: 0.15 }).pools.length, 0);
  });

  it('deepens the pool with each additional touch', () => {
    const two = equalHighsLows([sw('low', 50, 1), sw('low', 50.02, 2)], 60);
    const four = equalHighsLows([sw('low', 50, 1), sw('low', 50.02, 2), sw('low', 49.99, 3), sw('low', 50.01, 4)], 60);
    assert.equal(two.pools[0].depth, 'shallow');
    assert.equal(four.pools[0].depth, 'deep');
  });

  it('puts stops below equal lows and above equal highs', () => {
    const lows = equalHighsLows([sw('low', 50, 1), sw('low', 50.02, 2)], 60);
    assert.equal(lows.pools[0].stops_rest, 'below');
    assert.match(lows.pools[0].meaning, /long positions rest just below/i);
  });

  it('says which side of current price each pool sits on', () => {
    const swings = [sw('high', 120, 1), sw('high', 120.1, 2), sw('low', 80, 3), sw('low', 79.95, 4)];
    const r = equalHighsLows(swings, 100);
    assert.equal(r.pools.find((p) => p.kind === 'equal_highs').side, 'above price');
    assert.equal(r.pools.find((p) => p.kind === 'equal_lows').side, 'below price');
  });

  it('states that resting stops are inferred, not observed', () => {
    const r = equalHighsLows([sw('high', 100, 1), sw('high', 100.05, 2)], 95);
    assert.match(r.caveat, /not observed order data/i);
  });

  it('handles too few swings without inventing a pool', () => {
    assert.equal(equalHighsLows([sw('high', 100, 1)], 95).pools.length, 0);
  });
});
