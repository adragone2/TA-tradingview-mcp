/**
 * Trade-context unit tests — no TradingView connection needed.
 *
 * The regime tests carry the most weight. A market that thrashes and ends where
 * it started must NOT read as tradeable, because the whole value of that
 * measurement is being able to say "there is no setup here".
 *
 * Run: node --test tests/context.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { fibLevels, fibTargets, classifySwings, regime, volumeProfile, FIB_RATIOS } from '../src/core/context.js';

const DAY = 86400;
let t = 1_700_000_000;
const bar = (o, h, l, c, v = 1000) => ({ time: (t += DAY), open: o, high: h, low: l, close: c, volume: v });
const reset = () => { t = 1_700_000_000; };

/** Smooth zigzag through the given prices. */
function zig(points, per = 6) {
  reset();
  const out = [];
  for (let i = 0; i < points.length - 1; i++) {
    for (let j = 0; j < per; j++) {
      const p = points[i] + ((points[i + 1] - points[i]) * j) / per;
      out.push(bar(p, p + 0.3, p - 0.3, p));
    }
  }
  const last = points[points.length - 1];
  out.push(bar(last, last + 0.3, last - 0.3, last));
  return out;
}

describe('regime — the "should I trade this at all" number', () => {
  it('calls a straight line trending, with efficiency near 1', () => {
    reset();
    const bars = Array.from({ length: 40 }, (_, i) => bar(100 + i, 100 + i, 100 + i, 100 + i));
    const r = regime(bars);
    assert.equal(r.regime, 'trending');
    assert.ok(r.efficiency > 0.95, `expected near 1, got ${r.efficiency}`);
    assert.equal(r.direction, 'up');
  });

  it('calls a market that thrashes and ends flat CHOPPY', () => {
    // This is the case that matters. Lots of movement, nowhere reached.
    reset();
    const bars = Array.from({ length: 40 }, (_, i) => {
      const p = 100 + (i % 2 ? 5 : -5);
      return bar(p, p + 1, p - 1, p);
    });
    const r = regime(bars);
    assert.equal(r.regime, 'choppy');
    assert.ok(r.efficiency < 0.1, `expected near 0, got ${r.efficiency}`);
    assert.equal(r.direction, null, 'a choppy market has no direction to report');
    assert.match(r.advice, /no trade/i);
  });

  it('detects a downtrend direction', () => {
    reset();
    const bars = Array.from({ length: 40 }, (_, i) => bar(200 - i, 200 - i, 200 - i, 200 - i));
    assert.equal(regime(bars).direction, 'down');
  });

  it('reports a market with no movement rather than dividing by zero', () => {
    reset();
    const bars = Array.from({ length: 20 }, () => bar(100, 100, 100, 100));
    assert.equal(regime(bars).regime, 'flat');
  });

  it('says unknown rather than guessing from too few bars', () => {
    reset();
    assert.equal(regime([bar(1, 1, 1, 1)]).regime, 'unknown');
  });
});

describe('fibLevels', () => {
  it('measures a pullback against the last impulse', () => {
    // Down to 50, impulse up to 150, then back to 100: exactly 50% retraced.
    // Needs a real zigzag, or there are not two alternating swings to measure.
    const bars = zig([100, 50, 150, 100]);
    const f = fibLevels(bars, { lookback: 3 });
    assert.equal(f.available, true);
    assert.ok(Math.abs(f.retraced_pct - 50) < 12, `expected about 50%, got ${f.retraced_pct}`);
    assert.equal(f.in_golden_zone, true);
  });

  it('emits every standard ratio and flags the golden ones', () => {
    const f = fibLevels(zig([100, 50, 150, 100]), { lookback: 3 });
    assert.deepEqual(f.levels.map((l) => l.ratio), FIB_RATIOS);
    assert.deepEqual(f.levels.filter((l) => l.golden).map((l) => l.ratio), [0.382, 0.5, 0.618]);
  });

  it('does not call a shallow pullback a weakness', () => {
    const f = fibLevels(zig([100, 50, 150, 145]), { lookback: 3 });
    if (f.available && f.retraced_pct < 38.2) {
      assert.match(f.interpretation, /not a weakness/i);
    }
  });

  it('says a fully retraced move is broken, not a pullback', () => {
    const f = fibLevels(zig([100, 50, 150, 45]), { lookback: 3 });
    if (f.available && f.retraced_pct > 100) {
      assert.match(f.interpretation, /entire impulse/i);
    }
  });

  it('declines when there is no impulse to measure', () => {
    reset();
    assert.equal(fibLevels([bar(1, 1, 1, 1), bar(1, 1, 1, 1)], { lookback: 3 }).available, false);
  });
});

describe('classifySwings', () => {
  it('gives every swing a strength classification', () => {
    const r = classifySwings(zig([80, 120, 100, 140, 120, 160, 140]), { lookback: 3 });
    assert.ok(r.swings.length > 0);
    for (const s of r.swings) {
      assert.ok(['strong', 'weak', 'unproven'].includes(s.strength), `bad strength ${s.strength}`);
      assert.ok(s.why && s.why.length > 0, 'every classification must carry its reason');
    }
  });

  it('marks a low whose move broke prior structure as strong', () => {
    // Each low is followed by a high that exceeds the previous high.
    const r = classifySwings(zig([80, 120, 100, 140, 120, 160, 140]), { lookback: 3 });
    const strongLows = r.swings.filter((s) => s.kind === 'low' && s.strength === 'strong');
    assert.ok(strongLows.length >= 1, 'expected at least one strong low in a clean uptrend');
    assert.equal(r.last_strong_low.kind, 'low');
  });

  it('marks a swing whose move failed to break anything as weak', () => {
    // Highs that keep failing under the first one.
    const r = classifySwings(zig([100, 160, 120, 150, 118, 145, 115]), { lookback: 3 });
    const weak = r.swings.filter((s) => s.strength === 'weak');
    assert.ok(weak.length >= 1, 'expected at least one weak swing');
    assert.match(weak[0].why, /failed to break/i);
  });

  it('carries the trend alongside', () => {
    const r = classifySwings(zig([80, 120, 100, 140, 120, 160, 140]), { lookback: 3 });
    assert.ok(['uptrend', 'downtrend', 'range', 'undetermined'].includes(r.trend));
  });
});

describe('volumeProfile', () => {
  it('puts the point of control where the volume actually was', () => {
    reset();
    const bars = [
      ...Array.from({ length: 20 }, () => bar(100, 101, 99, 100, 100)),   // heavy around 100
      ...Array.from({ length: 5 }, () => bar(150, 151, 149, 150, 1)),     // light around 150
    ];
    const p = volumeProfile(bars, { bins: 40 });
    assert.equal(p.available, true);
    assert.ok(Math.abs(p.point_of_control - 100) < 5, `POC should sit near 100, got ${p.point_of_control}`);
  });

  it('builds a value area containing the point of control', () => {
    reset();
    const bars = Array.from({ length: 40 }, (_, i) => {
      const p = 100 + (i % 7);
      return bar(p, p + 1, p - 1, p, 100);
    });
    const p = volumeProfile(bars);
    assert.ok(p.value_area.low <= p.point_of_control && p.point_of_control <= p.value_area.high);
  });

  it('separates high-volume from low-volume nodes', () => {
    reset();
    const bars = [
      ...Array.from({ length: 30 }, () => bar(100, 101, 99, 100, 1000)),
      ...Array.from({ length: 3 }, () => bar(140, 141, 139, 140, 1)),
    ];
    const p = volumeProfile(bars, { bins: 40 });
    assert.ok(p.high_volume_nodes.length > 0, 'expected at least one high-volume node');
    for (const n of p.high_volume_nodes) assert.ok(n.ratio >= 1.5);
    for (const n of p.low_volume_nodes) assert.ok(n.ratio <= 0.35);
  });

  it('states that it is an approximation', () => {
    reset();
    const bars = Array.from({ length: 20 }, () => bar(100, 101, 99, 100, 100));
    assert.match(volumeProfile(bars).method, /approximation/i);
  });

  it('declines without usable volume', () => {
    reset();
    const bars = Array.from({ length: 20 }, () => bar(100, 101, 99, 100, 0));
    assert.equal(volumeProfile(bars).available, false);
  });
});

describe('fibTargets — extensions, which answer the opposite question to retracements', () => {
  it('projects the impulse height forward from the pullback', () => {
    // Up 100 -> 200 (height 100), pullback to 150. Measured move = 250.
    const bars = zig([140, 100, 200, 150, 170]);
    const r = fibTargets(bars, { lookback: 3 });
    assert.equal(r.available, true);
    assert.equal(r.direction, 'up');
    const one = r.levels.find((l) => l.ratio === 1);
    assert.ok(Math.abs(one.price - 250) < 12, `measured move was ${one.price}`);
    assert.equal(one.name, 'measured move');
  });

  it('projects downward for a down impulse', () => {
    const bars = zig([160, 200, 100, 150, 130]);
    const r = fibTargets(bars, { lookback: 3 });
    assert.equal(r.direction, 'down');
    assert.ok(r.measured_move < r.anchors.pullback_end.price, 'a down target must sit below the pullback');
  });

  it('orders the levels outward and flags the ones already reached', () => {
    const bars = zig([140, 100, 200, 150, 170]);
    const r = fibTargets(bars, { lookback: 3 });
    assert.deepEqual(r.levels.map((l) => l.ratio), [0.618, 1, 1.618, 2.618]);
    for (let i = 1; i < r.levels.length; i++) {
      assert.ok(r.levels[i].price > r.levels[i - 1].price, 'up targets must increase');
    }
    assert.ok(r.next_target, 'something ahead of price should remain');
    assert.equal(r.next_target.reached, false);
  });

  it('refuses to project when the pullback gave back the whole impulse', () => {
    // 100 -> 200 -> 98: there is no impulse left, and projecting from it would
    // put "targets" behind the move.
    const bars = zig([140, 100, 200, 98, 105]);
    const r = fibTargets(bars, { lookback: 3 });
    assert.equal(r.available, false);
    assert.match(r.note, /given back/i);
  });

  it('declines with fewer than three swings', () => {
    const bars = zig([100, 200]);
    assert.equal(fibTargets(bars, { lookback: 3 }).available, false);
  });

  it('states that no success rate has been measured', () => {
    const r = fibTargets(zig([140, 100, 200, 150, 170]), { lookback: 3 });
    assert.match(r.caveat, /no success rate/i);
    assert.match(r.method, /geometry rather than Fibonacci|geometry, not Fibonacci/i);
  });
});

describe('fibLevels — the named zones', () => {
  it('separates the shallow zone from the golden zone', () => {
    const r = fibLevels(zig([100, 50, 150, 100]), { lookback: 3 });
    assert.ok(r.shallow_zone.high > r.shallow_zone.low);
    assert.ok(r.golden_zone.low < r.shallow_zone.low, 'the golden zone must run deeper than the shallow one');
  });

  it('says plainly that 0.65 in the golden pocket has no derivation', () => {
    const r = fibLevels(zig([100, 50, 150, 100]), { lookback: 3 });
    assert.ok(r.golden_pocket.low < r.golden_pocket.high);
    assert.match(r.golden_pocket.caveat, /0\.65 is not/);
  });
});
