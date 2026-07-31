/**
 * Supply/demand zone unit tests — no TradingView connection needed.
 *
 * Two of these carry more weight than the rest:
 *
 *   - the doji-cluster case. Momentum is defined relative to the previous
 *     candles' bodies, and after a run of dojis that average approaches zero,
 *     which would make every ordinary candle a momentum candle. There is a
 *     second condition guarding it and a test that fails if it is removed.
 *   - the broken-zone case. A zone price has closed through is spent. Reporting
 *     it as live is how someone buys support that is no longer there.
 *
 * Run: node --test tests/zones.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { findZones, nearestZones } from '../src/core/zones.js';

const DAY = 86400;
let t = 1_700_000_000;
const bar = (o, h, l, c, v = 1000) => ({ time: (t += DAY), open: o, high: h, low: l, close: c, volume: v });
const reset = () => { t = 1_700_000_000; };

/** Quiet candles with real bodies — the baseline a momentum candle is measured against. */
const quiet = (n, p = 100) => Array.from({ length: n }, () => bar(p, p + 1, p - 1, p + 0.4));
/** Candles with essentially no body — the case that breaks a body-only test. */
const dojis = (n, p = 100) => Array.from({ length: n }, () => bar(p, p + 1, p - 1, p + 0.001));

describe('findZones — detection', () => {
  it('finds a demand zone at the base of a sharp move up', () => {
    reset();
    const bars = [...quiet(5), bar(100, 101, 99, 100.4), bar(100, 112, 100, 111), ...quiet(5, 112)];
    const r = findZones(bars, { momentum_multiple: 2, base_candles: 1 });
    const z = r.zones.find((x) => x.kind === 'demand');
    assert.ok(z, 'expected a demand zone');
    assert.equal(z.top, 101);   // the base candle's high
    assert.equal(z.bottom, 99); // and its low
  });

  it('finds a supply zone as the mirror', () => {
    reset();
    const bars = [...quiet(5), bar(100, 101, 99, 99.6), bar(100, 100, 88, 89), ...quiet(5, 88)];
    const z = findZones(bars, { momentum_multiple: 2 }).zones.find((x) => x.kind === 'supply');
    assert.ok(z, 'expected a supply zone');
    assert.equal(z.top, 101);
    assert.equal(z.bottom, 99);
  });

  it('does NOT call an ordinary candle after a doji run a momentum candle', () => {
    // The average body of a doji cluster is ~0, so a body-only test would score
    // any normal candle as infinitely larger. The second condition — body at
    // least the prior average RANGE — is what stops it.
    reset();
    const bars = [...dojis(5), bar(100, 101, 99, 100.5), ...quiet(5)];
    assert.equal(findZones(bars, { momentum_multiple: 2 }).total_found, 0);
  });

  it('finds nothing in a market with no sharp departures', () => {
    reset();
    assert.equal(findZones(quiet(30), { momentum_multiple: 2 }).total_found, 0);
  });

  it('declines with too few bars rather than guessing', () => {
    reset();
    assert.equal(findZones([bar(1, 2, 0, 1)], {}).zones.length, 0);
  });
});

describe('findZones — the 1-candle vs 3-candle convention', () => {
  it('widens the zone when three base candles are used', () => {
    reset();
    const base = [bar(100, 104, 96, 100.4), bar(100, 102, 98, 100.4), bar(100, 101, 99, 100.4)];
    const make = () => [...quiet(5), ...base.map((b) => ({ ...b })), bar(100, 112, 100, 111), ...quiet(5, 112)];

    reset();
    const one = findZones(make(), { momentum_multiple: 2, base_candles: 1 }).zones[0];
    reset();
    const three = findZones(make(), { momentum_multiple: 2, base_candles: 3 }).zones[0];

    assert.equal(one.top, 101);
    assert.equal(three.top, 104, 'three candles must reach the widest of them');
    assert.equal(three.bottom, 96);
  });

  it('says which convention produced the zones', () => {
    reset();
    const r = findZones(quiet(30), { base_candles: 3 });
    assert.equal(r.base_candles, 3);
    assert.match(r.method, /3 candles/);
    assert.match(r.method, /neither has a measured advantage/i);
  });
});

describe('findZones — status', () => {
  it('marks a zone price never returned to as fresh', () => {
    reset();
    const bars = [...quiet(5), bar(100, 101, 99, 100.4), bar(100, 112, 100, 111), ...quiet(8, 115)];
    assert.equal(findZones(bars, { momentum_multiple: 2 }).zones[0].status, 'fresh');
  });

  it('marks a zone price came back into as tested, and counts visits not bars', () => {
    reset();
    const bars = [
      ...quiet(5), bar(100, 101, 99, 100.4), bar(100, 112, 100, 111),
      ...quiet(3, 112),
      bar(112, 112, 100, 100.5), bar(100, 101, 99.5, 100.8),  // one visit, two bars
      ...quiet(4, 112),
    ];
    const z = findZones(bars, { momentum_multiple: 2 }).zones.find((x) => x.kind === 'demand');
    assert.equal(z.status, 'tested');
    assert.equal(z.tests, 1, 'two consecutive bars in the zone are one test');
  });

  it('excludes a zone price has CLOSED through, and says how many it dropped', () => {
    reset();
    const bars = [
      ...quiet(5), bar(100, 101, 99, 100.4), bar(100, 112, 100, 111),
      ...quiet(3, 112),
      bar(112, 112, 90, 91),   // closes below the zone — spent
      ...quiet(4, 90),
    ];
    const r = findZones(bars, { momentum_multiple: 2 });
    assert.equal(r.zones.filter((z) => z.kind === 'demand').length, 0);
    assert.ok(r.filtered_broken >= 1);
    const withBroken = findZones(bars, { momentum_multiple: 2, include_broken: true });
    assert.ok(withBroken.zones.some((z) => z.broken), 'it must still be findable when asked for');
  });

  it('does not treat a wick through the zone as broken', () => {
    reset();
    const bars = [
      ...quiet(5), bar(100, 101, 99, 100.4), bar(100, 112, 100, 111),
      ...quiet(3, 112),
      bar(105, 106, 90, 104),   // wicks below, closes back above
      ...quiet(4, 108),
    ];
    const z = findZones(bars, { momentum_multiple: 2 }).zones.find((x) => x.kind === 'demand');
    assert.ok(z, 'a wick through is not a break');
    assert.equal(z.broken, false);
  });
});

describe('findZones — grading and evidence', () => {
  it('grades a zone aggressive only with engulfing AND follow-through', () => {
    reset();
    const bars = [...quiet(5), bar(100, 101, 99, 100.4), bar(99.5, 112, 99.5, 111), bar(111, 120, 111, 119), ...quiet(4, 120)];
    const z = findZones(bars, { momentum_multiple: 2 }).zones[0];
    assert.equal(z.engulfing, true);
    assert.ok(z.follow_through_x >= 0.5);
    assert.equal(z.grade, 'aggressive');
  });

  it('grades a sharp move with no follow-through as plain', () => {
    reset();
    const bars = [...quiet(5), bar(100, 101, 99, 100.4), bar(99.5, 112, 99.5, 111), ...quiet(5, 111)];
    assert.equal(findZones(bars, { momentum_multiple: 2 }).zones[0].grade, 'plain');
  });

  it('assembles evidence from the measurements, not from adjectives', () => {
    reset();
    const bars = [...quiet(5), bar(100, 101, 99, 100.4), bar(100, 112, 100, 111), ...quiet(5, 112)];
    const z = findZones(bars, { momentum_multiple: 2 }).zones[0];
    assert.match(z.evidence, /x the prior average body/);
    assert.match(z.evidence, /never revisited/);
    assert.ok(z.momentum_x > 2);
  });

  it('reports an unmeasurable momentum multiple in words, never as String(null)', () => {
    // A base of zero-body candles makes mBody/avgBody undefined — momentum_x is
    // null — yet the zone still qualifies through the range condition. The
    // evidence must say that, not interpolate null ("price left it at nullx…").
    // zones_draw's rectangle label has the same rule, pinned in orphans.test.js.
    reset();
    const zeroBody = (n, p = 100) => Array.from({ length: n }, () => bar(p, p + 1, p - 1, p));
    const bars = [...zeroBody(5), bar(100, 106, 100, 106), ...quiet(5, 112)];
    const z = findZones(bars, { momentum_multiple: 2 }).zones.find((x) => x.kind === 'demand');
    assert.ok(z, 'expected the zero-body base to yield a demand zone via the range condition');
    assert.equal(z.momentum_x, null);
    assert.doesNotMatch(z.evidence, /null/);
    assert.match(z.evidence, /unmeasurable/);
  });

  it('tags a zone sitting on a proven swing', () => {
    reset();
    const bars = [...quiet(5), bar(100, 101, 99, 100.4), bar(100, 112, 100, 111), ...quiet(5, 112)];
    const strong = [{ kind: 'low', price: 99.5, strength: 'strong' }];
    assert.equal(findZones(bars, { momentum_multiple: 2, strong_swings: strong }).zones[0].at_strong_swing, 'strong_low');
  });

  it('does not tag against a swing the market never proved', () => {
    reset();
    const bars = [...quiet(5), bar(100, 101, 99, 100.4), bar(100, 112, 100, 111), ...quiet(5, 112)];
    const weak = [{ kind: 'low', price: 99.5, strength: 'weak' }];
    assert.equal(findZones(bars, { momentum_multiple: 2, strong_swings: weak }).zones[0].at_strong_swing, null);
  });
});

describe('findZones — honesty', () => {
  it('reports how many existed before filtering', () => {
    reset();
    const bars = [...quiet(5), bar(100, 101, 99, 100.4), bar(100, 112, 100, 111), ...quiet(5, 112)];
    const r = findZones(bars, { momentum_multiple: 2 });
    assert.ok(r.total_found >= 1);
    assert.match(r.reality_check, /common/i);
    for (const k of ['filtered_too_old', 'filtered_weak_departure', 'filtered_broken']) {
      assert.ok(k in r, `missing filter count: ${k}`);
    }
  });

  it('refuses the unfilled-orders story as evidence', () => {
    reset();
    const r = findZones(quiet(30), {});
    assert.match(r.caveat, /not observable/i);
    assert.match(r.fresh_vs_tested, /convention, not a measurement/i);
  });
});

describe('nearestZones', () => {
  it('picks the closest zone on each side of price', () => {
    const zones = [
      { kind: 'demand', top: 95, bottom: 93 },
      { kind: 'demand', top: 90, bottom: 88 },
      { kind: 'supply', top: 112, bottom: 110 },
      { kind: 'supply', top: 120, bottom: 118 },
    ];
    const n = nearestZones(zones, 100);
    assert.equal(n.below.top, 95);
    assert.equal(n.above.bottom, 110);
    assert.ok(n.below.distance_pct < 0 && n.above.distance_pct > 0);
  });

  it('returns null on a side with nothing on it', () => {
    const n = nearestZones([{ kind: 'demand', top: 95, bottom: 93 }], 100);
    assert.equal(n.above, null);
    assert.ok(n.below);
  });
});
