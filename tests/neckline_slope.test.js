/**
 * Neckline slope on head-and-shoulders detections.
 *
 * Bulkowski measures head-and-shoulders performance BY NECKLINE SLOPE, and the
 * detector already computed both armpits to place the neckline and then threw
 * the slope away. These tests cover the three directions on both variants, the
 * flat threshold at its boundary, and — carrying most of the weight — the
 * degenerate cases.
 *
 * The degenerate cases matter more than the happy path here. `Number(null)` is
 * 0, a 0 slope reads as a FLAT neckline, and a flat neckline earns the best
 * base rate of the three on a head-and-shoulders top. So missing data must
 * return null and must never return a number, or the toolchain conjures the
 * best-performing configuration out of an armpit it could not measure.
 *
 * Run: node --test tests/neckline_slope.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  detectPatterns, necklineSlope, NECKLINE_SLOPE_STATS,
} from '../src/core/patterns.js';

const DAY = 86400;
let t = 1_700_000_000;
const bar = (o, h, l, c) => ({ time: (t += DAY), open: o, high: h, low: l, close: c, volume: 100 });

/** Build a zigzag through the given prices with smooth legs. */
function zig(points, per = 6) {
  t = 1_700_000_000;
  const out = [];
  for (let i = 0; i < points.length - 1; i++) {
    const from = points[i], to = points[i + 1];
    for (let j = 0; j < per; j++) {
      const p = from + ((to - from) * j) / per;
      out.push(bar(p, p + 0.3, p - 0.3, p));
    }
  }
  const lastP = points[points.length - 1];
  out.push(bar(lastP, lastP + 0.3, lastP - 0.3, lastP));
  return out;
}

const structural = (bars, name) =>
  detectPatterns(bars, { lookback: 3, peak_tolerance_pct: 2 }).structural.find((p) => p.pattern === name);

/**
 * Fixtures. The middle number of each armpit pair is what moves: on a top the
 * armpits are the two TROUGHS either side of the head, on a bottom the two
 * PEAKS. Everything else is held constant so only the slope changes.
 */
const TOP = {
  flat: [80, 110, 95, 130, 95, 110, 100],
  down: [80, 110, 95, 130, 88, 110, 100],
  up: [80, 110, 88, 130, 95, 110, 100],
};
const BOTTOM = {
  flat: [130, 100, 115, 80, 115, 100, 110],
  down: [130, 100, 122, 80, 115, 100, 110],
  up: [130, 100, 115, 80, 122, 100, 110],
};

describe('neckline_slope — direction on both variants', () => {
  for (const [want, points] of Object.entries(TOP)) {
    it(`reads a ${want}-sloping neckline on a head-and-shoulders top`, () => {
      const p = structural(zig(points), 'head_and_shoulders');
      assert.ok(p, 'expected a head and shoulders');
      assert.ok(p.neckline_slope, 'expected a neckline_slope object');
      assert.equal(p.neckline_slope.direction, want);
    });
  }

  for (const [want, points] of Object.entries(BOTTOM)) {
    it(`reads a ${want}-sloping neckline on an inverse head-and-shoulders`, () => {
      const p = structural(zig(points), 'inverse_head_and_shoulders');
      assert.ok(p, 'expected an inverse head and shoulders');
      assert.ok(p.neckline_slope, 'expected a neckline_slope object');
      assert.equal(p.neckline_slope.direction, want);
    });
  }

  it('signs the slope the same way it names the direction', () => {
    assert.ok(structural(zig(TOP.down), 'head_and_shoulders').neckline_slope.slope_per_bar < 0);
    assert.ok(structural(zig(TOP.up), 'head_and_shoulders').neckline_slope.slope_per_bar > 0);
    assert.equal(structural(zig(TOP.flat), 'head_and_shoulders').neckline_slope.slope_per_bar, 0);
  });
});

describe('neckline_slope — the claim is checkable on a chart', () => {
  it('anchors a top to the two real trough bars', () => {
    const bars = zig(TOP.down);
    const ns = structural(bars, 'head_and_shoulders').neckline_slope;
    // Armpits on a TOP are troughs, so each anchor price is a real bar LOW.
    assert.ok(Math.abs(bars[ns.left_armpit.index].low - ns.left_armpit.price) < 1e-6,
      `left armpit ${ns.left_armpit.price} is not the low of bar ${ns.left_armpit.index}`);
    assert.ok(Math.abs(bars[ns.right_armpit.index].low - ns.right_armpit.price) < 1e-6,
      `right armpit ${ns.right_armpit.price} is not the low of bar ${ns.right_armpit.index}`);
  });

  it('anchors an inverse to the two real peak bars', () => {
    const bars = zig(BOTTOM.down);
    const ns = structural(bars, 'inverse_head_and_shoulders').neckline_slope;
    // Armpits on a BOTTOM are peaks, so each anchor price is a real bar HIGH.
    assert.ok(Math.abs(bars[ns.left_armpit.index].high - ns.left_armpit.price) < 1e-6);
    assert.ok(Math.abs(bars[ns.right_armpit.index].high - ns.right_armpit.price) < 1e-6);
  });

  it('reports a slope that reconstructs from its own two anchors', () => {
    for (const points of [TOP.up, TOP.down, BOTTOM.up, BOTTOM.down]) {
      const name = points === TOP.up || points === TOP.down
        ? 'head_and_shoulders' : 'inverse_head_and_shoulders';
      const ns = structural(zig(points), name).neckline_slope;
      const rebuilt = (ns.right_armpit.price - ns.left_armpit.price)
        / (ns.right_armpit.index - ns.left_armpit.index);
      assert.ok(Math.abs(rebuilt - ns.slope_per_bar) < 1e-6,
        `slope_per_bar ${ns.slope_per_bar} does not match the anchors (${rebuilt})`);
      assert.equal(ns.bars_between, ns.right_armpit.index - ns.left_armpit.index);
      assert.equal(ns.units, 'price per bar');
    }
  });

  it('states the flat threshold it applied, rather than leaving it implicit', () => {
    const ns = structural(zig(TOP.flat), 'head_and_shoulders').neckline_slope;
    assert.equal(ns.flat_threshold_pct_per_bar, 0.05);
    assert.match(ns.flat_rule, /0\.05/);
  });

  it('honours a caller-supplied flat threshold and reports THAT number', () => {
    // 0.6396 %/bar on the down fixture — a threshold above it must read flat.
    const p = detectPatterns(zig(TOP.down), { lookback: 3, peak_tolerance_pct: 2, flat_slope_pct: 5 })
      .structural.find((x) => x.pattern === 'head_and_shoulders');
    assert.equal(p.neckline_slope.direction, 'flat');
    assert.equal(p.neckline_slope.flat_threshold_pct_per_bar, 5);
  });
});

describe('neckline_slope — the flat threshold boundary', () => {
  const at = (leftPrice, rightPrice, bars, opts) =>
    necklineSlope({ index: 0, price: leftPrice }, { index: bars, price: rightPrice }, opts);

  it('is FLAT just inside the threshold', () => {
    // mean 100, 10 bars, total rise 0.498 → 0.0498 %/bar, below 0.05.
    assert.equal(at(99.751, 100.249, 10).direction, 'flat');
  });

  it('is SLOPED just outside the threshold', () => {
    // mean 100, 10 bars, total rise 0.52 → 0.052 %/bar, above 0.05.
    assert.equal(at(99.74, 100.26, 10).direction, 'up');
    assert.equal(at(100.26, 99.74, 10).direction, 'down');
  });

  it('treats a slope EXACTLY at the threshold as sloped, not flat', () => {
    /**
     * The comparison is `<`, matching trendlinePatterns. Tested with values
     * whose arithmetic is bit-exact in binary floating point: mean 1.0, one
     * bar, rise 1.0 → exactly 100 %/bar, against a threshold of exactly 100.
     * The realistic 0.05 threshold cannot be hit exactly, so it is bracketed
     * above and below instead.
     */
    const exact = at(0.5, 1.5, 1, { flat_slope_pct: 100 });
    assert.equal(exact.slope_pct_per_bar, 100);
    assert.equal(exact.direction, 'up');
    assert.equal(at(0.5, 1.5, 1, { flat_slope_pct: 100.0001 }).direction, 'flat');
  });

  it('falls back to the default threshold when handed a nonsense one, and says which it used', () => {
    for (const bad of [null, undefined, NaN, 'wide', -1]) {
      const ns = at(99.751, 100.249, 10, { flat_slope_pct: bad });
      assert.equal(ns.flat_threshold_pct_per_bar, 0.05,
        `threshold ${String(bad)} should fall back to the default`);
      assert.equal(ns.direction, 'flat');
    }
  });
});

describe('neckline_slope — degenerate armpits return null, never a number', () => {
  const ok = { index: 10, price: 100 };

  const cases = {
    'a null left armpit': [null, ok],
    'a null right armpit': [ok, null],
    'an undefined armpit': [undefined, ok],
    'a non-object armpit': [42, ok],
    'a missing price': [{ index: 0 }, ok],
    'a missing index': [{ price: 90 }, ok],
    'a NaN price': [{ index: 0, price: NaN }, ok],
    'an Infinite price': [{ index: 0, price: Infinity }, ok],
    'a NaN index': [{ index: NaN, price: 90 }, ok],
    'a string price': [{ index: 0, price: '90' }, ok],
    'both armpits on the SAME bar': [{ index: 10, price: 90 }, { index: 10, price: 100 }],
    'armpits handed over reversed': [{ index: 20, price: 90 }, { index: 10, price: 100 }],
    'a zero mean price': [{ index: 0, price: -100 }, { index: 10, price: 100 }],
    'a negative mean price': [{ index: 0, price: -100 }, { index: 10, price: -80 }],
  };

  for (const [label, [l, r]] of Object.entries(cases)) {
    it(`returns null for ${label}`, () => {
      const ns = necklineSlope(l, r, { pattern: 'head_and_shoulders' });
      assert.equal(ns, null, `expected null, got ${JSON.stringify(ns)}`);
    });
  }

  it('never returns a zero that would be read as a flat neckline', () => {
    /**
     * This is the whole point of the block above. A flat neckline is the
     * BEST-performing configuration on a head-and-shoulders top, so a
     * degenerate case silently returning 0 would not merely be wrong — it
     * would award the best base rate of the three to an unmeasurable pattern.
     */
    for (const [l, r] of Object.values(cases)) {
      const ns = necklineSlope(l, r, { pattern: 'head_and_shoulders' });
      assert.notEqual(ns?.direction, 'flat');
      assert.notEqual(ns?.slope_per_bar, 0);
    }
  });

  it('never returns NaN in any numeric field on a valid reading', () => {
    for (const points of Object.values(TOP)) {
      const ns = structural(zig(points), 'head_and_shoulders').neckline_slope;
      for (const [k, v] of Object.entries(ns)) {
        if (typeof v === 'number') assert.ok(Number.isFinite(v), `${k} is not finite: ${v}`);
      }
    }
  });
});

describe('neckline_slope — Bulkowski base rates', () => {
  it('gives a head-and-shoulders top the figure for its own slope', () => {
    const want = { flat: -24, up: -23, down: -21 };
    for (const [slope, points] of Object.entries(TOP)) {
      const br = structural(zig(points), 'head_and_shoulders').neckline_slope.base_rate;
      assert.equal(br.slope, slope);
      assert.equal(br.average_move_pct, want[slope]);
    }
  });

  it('gives an inverse head-and-shoulders the figure for its own slope', () => {
    const want = { flat: 34, up: 34, down: 42 };
    for (const [slope, points] of Object.entries(BOTTOM)) {
      const br = structural(zig(points), 'inverse_head_and_shoulders').neckline_slope.base_rate;
      assert.equal(br.slope, slope);
      assert.equal(br.average_move_pct, want[slope]);
    }
  });

  it('names the best slope, and it differs between the two variants', () => {
    const top = structural(zig(TOP.flat), 'head_and_shoulders').neckline_slope.base_rate;
    const bottom = structural(zig(BOTTOM.down), 'inverse_head_and_shoulders').neckline_slope.base_rate;
    assert.equal(top.best_slope, 'flat');
    assert.equal(top.is_best, true);
    assert.equal(bottom.best_slope, 'down');
    assert.equal(bottom.is_best, true);
    // A down-sloping neckline is the WORST case on a top and the BEST on a
    // bottom. Reusing one rule for both variants would get this backwards.
    assert.equal(structural(zig(TOP.down), 'head_and_shoulders').neckline_slope.base_rate.is_best, false);
  });

  it('cites the source with a URL on every reading', () => {
    for (const [points, name] of [[TOP.up, 'head_and_shoulders'], [BOTTOM.up, 'inverse_head_and_shoulders']]) {
      const br = structural(zig(points), name).neckline_slope.base_rate;
      assert.match(br.url, /^https:\/\/www\.thepatternsite\.com\//);
      assert.match(br.source, /Bulkowski/);
      assert.ok(br.quote.length > 40, 'the verbatim quote must travel with the number');
    }
  });

  it('warns that the figures are measured from the breakout onward', () => {
    const p = structural(zig(TOP.down), 'head_and_shoulders');
    assert.equal(p.status, 'forming');
    assert.match(p.neckline_slope.base_rate.applies_from_breakout, /breakout/i);
  });

  it('warns that the slope figures do not reconcile with the headline stats', () => {
    const br = structural(zig(TOP.down), 'head_and_shoulders').neckline_slope.base_rate;
    assert.match(br.not_comparable_to_headline, /HSTExplained/);
    assert.match(br.no_sample_published, /no noise floor|sample size/i);
  });

  it('flags that the measured ranking contradicts the structure_confirms prose', () => {
    // A down-sloping neckline is what `structure_confirms` calls the stronger
    // version, and it is Bulkowski's WORST of the three. Both claims are on the
    // same object, so the disagreement has to be stated rather than left to be
    // discovered by a reader who believes whichever they read first.
    const p = structural(zig(TOP.down), 'head_and_shoulders');
    assert.ok(p.structure_confirms, 'fixture should be the down-sloping variant');
    assert.match(p.neckline_slope.base_rate.contradiction_note, /structure_confirms/);
    assert.equal(p.neckline_slope.base_rate.rank_of_3, 3);
  });

  it('keeps the stats table self-consistent', () => {
    for (const [pattern, s] of Object.entries(NECKLINE_SLOPE_STATS)) {
      const slopes = Object.entries(s.by_slope);
      assert.equal(slopes.length, 3, `${pattern} must cover up, down and flat`);
      assert.deepEqual(new Set(Object.keys(s.by_slope)), new Set(['up', 'down', 'flat']));
      assert.ok(s.by_slope[s.best_slope], `${pattern} best_slope must be one of the three`);
      // The best slope must actually hold rank 1.
      assert.equal(s.by_slope[s.best_slope].rank_of_3, 1, `${pattern} best_slope is not ranked first`);
      const moves = slopes.map(([, v]) => v.average_move_pct);
      assert.equal(Math.max(...moves) - Math.min(...moves), s.spread_pct_points,
        `${pattern} spread_pct_points does not match its own figures`);
      assert.ok(s.quote.length > 40 && s.url.startsWith('https://'));
    }
  });
});

describe('neckline_slope — additive only', () => {
  it('leaves every pre-existing head-and-shoulders key in place', () => {
    const p = structural(zig(TOP.down), 'head_and_shoulders');
    for (const k of ['pattern', 'type', 'direction', 'bars', 'status', 'completion_level',
      'target', 'measurements', 'from_time', 'to_time', 'note']) {
      assert.ok(k in p, `${k} went missing`);
    }
    for (const k of ['left_shoulder', 'head', 'right_shoulder', 'neckline',
      'shoulder_difference_pct', 'height', 'trough_1', 'trough_2', 'downsloping_neckline']) {
      assert.ok(k in p.measurements, `measurements.${k} went missing`);
    }
    assert.ok(p.structure_confirms || p.structure_caveat);
  });

  it('leaves every pre-existing inverse head-and-shoulders key in place', () => {
    const p = structural(zig(BOTTOM.down), 'inverse_head_and_shoulders');
    for (const k of ['left_shoulder', 'head', 'right_shoulder', 'neckline',
      'shoulder_difference_pct', 'height']) {
      assert.ok(k in p.measurements, `measurements.${k} went missing`);
    }
  });

  it('does not attach a neckline to patterns that have no armpits', () => {
    for (const [points, name] of [
      [[80, 120, 100, 120, 108], 'double_top'],
      [[120, 80, 100, 80, 92], 'double_bottom'],
      [[80, 120, 100, 120, 100, 120, 108], 'triple_top'],
    ]) {
      const p = structural(zig(points), name);
      assert.ok(p, `expected a ${name}`);
      assert.equal(p.neckline_slope, undefined, `${name} should carry no neckline_slope`);
    }
  });

  it('keeps `downsloping_neckline` as the bare sign test it always was', () => {
    /**
     * The legacy boolean has no threshold, so on a neckline the new field calls
     * FLAT it can still read true. They are answering different questions and
     * must not be reconciled — this pins the difference so a future change to
     * one is not quietly applied to the other.
     */
    const p = detectPatterns(zig(TOP.down), { lookback: 3, peak_tolerance_pct: 2, flat_slope_pct: 5 })
      .structural.find((x) => x.pattern === 'head_and_shoulders');
    assert.equal(p.measurements.downsloping_neckline, true);
    assert.equal(p.neckline_slope.direction, 'flat');
  });

  it('reports the slope on a FORMING pattern, which is when it is used to choose', () => {
    // Bulkowski's stated use is picking which head-and-shoulders to trade, so
    // withholding the geometry until confirmation would remove it exactly when
    // it is wanted. The timing caveat rides along instead.
    const p = structural(zig(TOP.up), 'head_and_shoulders');
    assert.equal(p.status, 'forming');
    assert.equal(p.neckline_slope.direction, 'up');
    assert.ok(p.neckline_slope.base_rate);
  });
});

// ---------------------------------------------------------------------------
// The field must reach the Sunday review. assessment.js projects each pattern
// to a fixed compact subset for `chart_patterns.detected`, and a field that
// exists only in patterns_detect output is a field the weekly review of real
// money never sees. Source contract, same mechanism as symbol_stamp.test.js:
// the projection map in assessment.js must carry neckline_slope, compactly —
// the reading and the base rate, never the provenance essays.
// ---------------------------------------------------------------------------
import { readFileSync } from 'node:fs';

describe('neckline_slope — projected to the Sunday review', () => {
  const src = readFileSync(new URL('../src/core/assessment.js', import.meta.url), 'utf8');
  const detStart = src.indexOf('detected: (pats.structural');
  const detEnd = src.indexOf('sensitivity_sweep:', detStart);
  const projection = src.slice(detStart, detEnd);

  it('the chart_patterns.detected projection exists where expected', () => {
    assert.ok(detStart > -1 && detEnd > detStart, 'projection block not found — assessment.js reshaped; move this contract with it');
  });

  it('projects neckline_slope with its base rate', () => {
    assert.match(projection, /neckline_slope/);
    assert.match(projection, /base_rate/);
    assert.match(projection, /average_move_pct/);
    assert.match(projection, /is_best/);
  });

  it('projects the reading, not the essays', () => {
    for (const heavy of ['quote', 'assignment_note', 'contradiction_note', 'no_sample_published']) {
      assert.ok(!projection.includes(heavy), `${heavy} belongs in patterns_detect output, not the weekly report projection`);
    }
  });
});
