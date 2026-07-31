/**
 * The pivot backbone — the properties, not a fixture.
 *
 * Three implementations of "what is a swing" used to coexist here
 * (`structure.findSwings`, `assessment_draw.windowPivots`, kernel extrema) and
 * could disagree about the same chart. `src/core/pivots.js` is the one that
 * survived. What is asserted below is what every consumer downstream — levels,
 * patterns, legs, Elliott, Wyckoff, divergence, liquidity, the drawn geometry —
 * is entitled to assume without checking.
 *
 * These are PROPERTY tests on generated series wherever possible. A fixture the
 * same author wrote to make the detector pass catches regressions and nothing
 * else, and the one property here that matters most is exactly the kind a
 * fixture cannot pin: that a reported price is a price that traded.
 *
 * Run: node --test tests/pivots.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  findPivots, findPivotsWithBandwidth, bandwidthForLookback,
  BANDWIDTH_PER_LOOKBACK, MIN_BANDWIDTH, PIVOT_DENSITY, PIVOT_EDGE_STABILITY,
} from '../src/core/pivots.js';
import { randomWalk, barsFromPath } from '../src/core/synthetic.js';

const walk = (n, s) => barsFromPath(randomWalk({ n, seed: 7000 + s }), { noise: 0.006, seed: 8000 + s });

const flat = (closes, t0 = 1_700_000_000) => closes.map((c, i) => ({
  time: t0 + i * 86400, open: c, close: c, high: c, low: c, volume: 1000,
}));

describe('the property the whole thing exists for: every price traded', () => {
  it('every pivot price is a REAL bar high or low, never a smoothed value', () => {
    /**
     * The CSCO wedge. The old detector reported converging 17.18 -> 9.02 while
     * the real pivots went 13.87 -> 14.08 — diverging. No wedge existed; the
     * convergence belonged to the detector's own fitted lines.
     *
     * LMW's step 3 is what makes that structurally impossible: smoothing decides
     * only WHERE TO LOOK, and the price handed to any pattern test is read back
     * off the bar. If this ever fails, the backbone has started reporting its own
     * curve as if it were the market.
     */
    let checked = 0;
    for (let s = 0; s < 60; s += 1) {
      const bars = walk(300, s);
      for (const lookback of [2, 5, 8]) {
        for (const p of findPivots(bars, { lookback })) {
          const real = p.kind === 'high' ? bars[p.index].high : bars[p.index].low;
          assert.equal(p.price, real,
            `pivot at index ${p.index} reported ${p.price}; the bar's ${p.kind} is ${real}`);
          assert.equal(p.time, bars[p.index].time, 'the pivot time must be the mapped bar\'s time');
          checked += 1;
        }
      }
    }
    assert.ok(checked > 5000, `only ${checked} pivots checked — the sweep is not exercising anything`);
  });

  it('the smoothed value is reported ALONGSIDE, so the two can be compared', () => {
    // A large gap between them means the smoothing did a lot of work and the
    // pivot is less trustworthy. Dropping the field would hide that.
    const pv = findPivots(walk(300, 3), { lookback: 5 });
    assert.ok(pv.length > 0);
    assert.ok(pv.every((p) => Number.isFinite(p.smoothed_price)));
    assert.ok(pv.some((p) => p.smoothed_price !== p.price),
      'if every smoothed price equals its bar price, nothing is being smoothed');
  });
});

describe('the invariants every consumer assumes without checking', () => {
  it('indices are STRICTLY increasing', () => {
    /**
     * `findKernelPivots` does not guarantee this and measurably breaks it — 23
     * inverted pairs over 200 walks of 300 bars at lookback 5, because two
     * adjacent smoothed extrema search overlapping bar windows in the map-back
     * step. Nothing downstream throws on an inversion: `classifyLegs` slices
     * `bars.slice(a.index + 1, b.index + 1)` and gets an empty leg,
     * `structuralPatterns` gets a negative bar separation. They measure nothing
     * and say so nowhere. `pivots.js` repairs it; this is the guard.
     */
    for (let s = 0; s < 200; s += 1) {
      const pv = findPivots(walk(300, s), { lookback: 5 });
      for (let i = 1; i < pv.length; i += 1) {
        assert.ok(pv[i].index > pv[i - 1].index,
          `seed ${s}: index went ${pv[i - 1].index} -> ${pv[i].index}`);
      }
    }
  });

  it('kinds strictly alternate high/low', () => {
    for (let s = 0; s < 200; s += 1) {
      const pv = findPivots(walk(300, s), { lookback: 5 });
      for (let i = 1; i < pv.length; i += 1) {
        assert.notEqual(pv[i].kind, pv[i - 1].kind, `seed ${s}: two ${pv[i].kind}s in a row`);
      }
    }
  });

  it('`type` and `kind` are the same string — the backbone publishes both', () => {
    // `type` is this module's name for it; `kind` is what the ~27 existing call
    // sites read. Emitting both is what lets findSwings stay a pass-through.
    const pv = findPivots(walk(300, 1), { lookback: 5 });
    assert.ok(pv.length > 0);
    assert.ok(pv.every((p) => p.type === p.kind && (p.kind === 'high' || p.kind === 'low')));
  });

  it('no pivot is reported on the final bar', () => {
    /**
     * Measured: a pivot mapped onto the last bar was revised in 100% of cases
     * once one more bar arrived. That is not a swing, it is the current bar
     * described as structure — and the derivative test at the final index has no
     * following bar to turn against.
     */
    for (let s = 0; s < 100; s += 1) {
      const bars = walk(200, s);
      for (const p of findPivots(bars, { lookback: 3 })) {
        assert.ok(p.index < bars.length - 1, `pivot on the last bar (index ${p.index})`);
      }
    }
  });

  it('a monotonic series has no pivots at all, at any density', () => {
    // A boundary artefact here would put a "swing high" at the first or last bar
    // of every trending chart in the repo.
    const up = flat(Array.from({ length: 120 }, (_, i) => 100 + i));
    const down = flat(Array.from({ length: 120 }, (_, i) => 300 - i * 1.5));
    for (const bars of [up, down]) {
      for (const lookback of [1, 2, 3, 5, 8, 20]) {
        assert.deepEqual(findPivots(bars, { lookback }), [],
          `a monotonic series produced a pivot at lookback ${lookback}`);
      }
    }
  });

  it('too few bars returns an empty array rather than throwing', () => {
    for (const n of [0, 1, 2, 3, 4]) {
      assert.deepEqual(findPivots(flat(Array.from({ length: n }, (_, i) => 100 + i))), []);
    }
    assert.deepEqual(findPivots(null), []);
    assert.deepEqual(findPivots(undefined, { lookback: 5 }), []);
  });
});

describe('the density control, and why it is not cross-validated', () => {
  it('bandwidth is lookback x the measured constant, with a floor', () => {
    assert.equal(bandwidthForLookback(5), 5 * BANDWIDTH_PER_LOOKBACK);
    assert.equal(bandwidthForLookback(10), 10 * BANDWIDTH_PER_LOOKBACK);
    // Below the floor the smoothed curve is the raw series and every wiggle is
    // an extremum. windowPivots had the same floor spelled `lookback: 1`.
    assert.equal(bandwidthForLookback(0), MIN_BANDWIDTH);
    assert.equal(bandwidthForLookback(0.1), MIN_BANDWIDTH);
    assert.equal(bandwidthForLookback(undefined), 5 * BANDWIDTH_PER_LOOKBACK);
  });

  it('the calibration is count-matched to the fractal detector it replaced', () => {
    /**
     * The recorded table is the justification for the constant. If someone
     * changes BANDWIDTH_PER_LOOKBACK without re-measuring, this catches the
     * table and the constant disagreeing.
     */
    for (const [lookback, row] of Object.entries(PIVOT_DENSITY.matched_counts_400_bars)) {
      const predicted = bandwidthForLookback(Number(lookback));
      assert.ok(Math.abs(predicted - row.bandwidth) <= 0.35,
        `lookback ${lookback}: constant predicts h=${predicted}, the measurement matched at h=${row.bandwidth}`);
      const err = Math.abs(row.kernel_at_mapping - row.fractal) / row.fractal;
      assert.ok(err < 0.25,
        `lookback ${lookback}: the mapping is ${(err * 100).toFixed(0)}% off the fractal count it claims to match`);
    }
  });

  it('a coarser lookback really does find fewer pivots', () => {
    // On real-shaped data. The ordering is the whole reason lookback survives as
    // a parameter — assessment.js sweeps 3/4/5/6/8 and calls a pattern STABLE
    // when it survives 3 of the 5.
    for (let s = 0; s < 25; s += 1) {
      const bars = walk(300, s);
      const counts = [2, 3, 5, 8, 12].map((lookback) => findPivots(bars, { lookback }).length);
      for (let i = 1; i < counts.length; i += 1) {
        assert.ok(counts[i] <= counts[i - 1], `seed ${s}: counts ${JSON.stringify(counts)} rose with lookback`);
      }
      assert.ok(counts[0] > counts[4], `seed ${s}: lookback 2 and 12 found the same number of pivots`);
    }
  });

  it('an explicit bandwidth overrides lookback', () => {
    const bars = walk(300, 5);
    assert.deepEqual(
      findPivots(bars, { lookback: 5 }),
      findPivots(bars, { bandwidth: bandwidthForLookback(5) }),
    );
    assert.notDeepEqual(findPivots(bars, { lookback: 5 }), findPivots(bars, { bandwidth: 0.8 }));
  });

  it('findPivotsWithBandwidth reports the bandwidth it used', () => {
    const r = findPivotsWithBandwidth(walk(300, 2), { lookback: 6 });
    assert.equal(r.bandwidth, bandwidthForLookback(6));
    assert.equal(r.lookback, 6);
    assert.deepEqual(r.pivots, findPivots(walk(300, 2), { lookback: 6 }));
  });
});

describe('the window slice — what windowPivots did', () => {
  const bars = walk(300, 11);

  it('restricts output to the window, inclusive of both bounds', () => {
    const from = bars[100].time, to = bars[180].time;
    const win = findPivots(bars, { lookback: 3, from_time: from, to_time: to });
    assert.ok(win.length > 0);
    assert.ok(win.every((p) => p.time >= from && p.time <= to));
    const all = findPivots(bars, { lookback: 3 });
    assert.deepEqual(win, all.filter((p) => p.time >= from && p.time <= to));
  });

  it('a window is filtered from the WHOLE-series smooth, not a re-smoothed slice', () => {
    /**
     * The old windowPivots restricted its scan range but read its comparison
     * window out of the full array, so a pivot near the window edge still had
     * real context on both sides. Preserved — and the check is that a pivot
     * inside the window is identical whether or not the window was asked for.
     * Re-smoothing a slice would move it, because the truncated end of a
     * Nadaraya-Watson window bends the curve.
     */
    const from = bars[120].time, to = bars[160].time;
    const win = findPivots(bars, { lookback: 3, from_time: from, to_time: to });
    const all = findPivots(bars, { lookback: 3 });
    for (const p of win) {
      const same = all.find((q) => q.index === p.index);
      assert.ok(same, `pivot at ${p.index} exists only when a window is asked for`);
      assert.equal(same.price, p.price);
    }
  });

  it('one open bound works', () => {
    const all = findPivots(bars, { lookback: 3 });
    const t = bars[150].time;
    assert.deepEqual(findPivots(bars, { lookback: 3, from_time: t }), all.filter((p) => p.time >= t));
    assert.deepEqual(findPivots(bars, { lookback: 3, to_time: t }), all.filter((p) => p.time <= t));
  });
});

describe('the `want` floor — the native pattern tools depend on it', () => {
  /**
   * A native TradingView pattern tool handed fewer points than it declares
   * places what it has and STAYS ARMED — measured on triangle_pattern, 2 of 5,
   * with the drawing cursor still live afterwards. So the floor is a hard one:
   * loosen until enough pivots exist, or draw nothing.
   */
  it('loosens the bandwidth until `want` is met', () => {
    const bars = walk(300, 21);
    const from = bars[200].time, to = bars[240].time;
    const base = findPivots(bars, { lookback: 8, from_time: from, to_time: to });
    const forced = findPivots(bars, { lookback: 8, from_time: from, to_time: to, want: base.length + 2 });
    assert.ok(forced.length > base.length,
      `want did not loosen anything: ${base.length} -> ${forced.length}`);
  });

  it('returns the COARSEST set that meets `want`, not the finest available', () => {
    // Loosening is a fallback, not a preference. A window that already has
    // enough pivots at the asked-for density must not be re-scanned finer.
    const bars = walk(300, 22);
    const plain = findPivots(bars, { lookback: 3 });
    assert.deepEqual(findPivots(bars, { lookback: 3, want: 2 }), plain);
  });

  it('never invents a pivot to satisfy `want`', () => {
    /**
     * The floor is allowed to fail. A monotonic series has no turns and must
     * come back empty however many are asked for; a two-turn zigzag must come
     * back with two. Anything else and the drawn geometry is fiction.
     */
    const mono = flat(Array.from({ length: 60 }, (_, i) => 100 + i * 0.5));
    assert.deepEqual(findPivots(mono, { lookback: 3, want: 7 }), []);

    const zig = flat([
      ...Array.from({ length: 20 }, (_, i) => 100 + i),
      ...Array.from({ length: 20 }, (_, i) => 120 - i),
      ...Array.from({ length: 20 }, (_, i) => 100 + i),
    ]);
    const got = findPivots(zig, { lookback: 3, want: 7 });
    assert.ok(got.length >= 1 && got.length < 7,
      `a two-turn series produced ${got.length} pivots when 7 were asked for`);
    for (const p of got) {
      const real = p.kind === 'high' ? zig[p.index].high : zig[p.index].low;
      assert.equal(p.price, real);
    }
  });

  it('returns the BEST attempt when `want` is never met, not the last', () => {
    // The finest rung can find FEWER than a coarser one once alternation
    // collapses a run, so "return whatever the last rung gave" would throw away
    // pivots that were found.
    const bars = walk(300, 23);
    const from = bars[250].time, to = bars[275].time;
    const asked = findPivots(bars, { lookback: 5, from_time: from, to_time: to, want: 99 });
    const rungs = [5, 3, 2, 1].map((lookback) => findPivots(bars, { lookback, from_time: from, to_time: to }).length);
    assert.ok(asked.length >= Math.max(...rungs) - 1,
      `best attempt returned ${asked.length}; individual densities gave ${JSON.stringify(rungs)}`);
  });
});

describe('memoisation must not leak state between callers', () => {
  it('repeat calls are equal in value but not the same array', () => {
    /**
     * `findSwings` has always returned a fresh array, and `findKeyLevels` sorts
     * a copy while other consumers filter. Handing the cached array out directly
     * would let one consumer's sort reorder every other consumer's view — the
     * kind of defect that produces plausible wrong numbers rather than an error.
     */
    const bars = walk(300, 31);
    const a = findPivots(bars, { lookback: 5 });
    const b = findPivots(bars, { lookback: 5 });
    assert.deepEqual(a, b);
    assert.notEqual(a, b, 'the same array object was handed to two callers');
    a.reverse();
    assert.deepEqual(findPivots(bars, { lookback: 5 }), b, 'a caller mutated the cache');
  });

  it('different options on the same bars do not collide in the cache', () => {
    const bars = walk(300, 32);
    const five = findPivots(bars, { lookback: 5 });
    const two = findPivots(bars, { lookback: 2 });
    assert.notDeepEqual(five, two);
    assert.deepEqual(findPivots(bars, { lookback: 5 }), five, 'lookback 2 overwrote lookback 5');
  });

  it('a different bars array with equal contents is computed independently', () => {
    // WeakMap keyed on identity. Two arrays holding the same bars are two keys,
    // which is correct: bars are never mutated in place here, and identity is
    // the only key that cannot go stale.
    const a = walk(300, 33);
    const b = a.slice();
    assert.deepEqual(findPivots(a, { lookback: 5 }), findPivots(b, { lookback: 5 }));
  });
});

describe('the recorded measurements travel with the code', () => {
  it('the density calibration says how it was measured', () => {
    assert.match(PIVOT_DENSITY.method, /random walks/);
    assert.match(PIVOT_DENSITY.status, /MEASURED/);
    assert.ok(PIVOT_DENSITY.caveat.includes('POSITIONS'),
      'the calibration must say the count is matched and the positions are not');
  });

  it('the edge-stability table is recorded, including the 100% last-bar figure', () => {
    assert.equal(PIVOT_EDGE_STABILITY.revised_pct_by_bars_back[0], 100);
    assert.equal(PIVOT_EDGE_STABILITY.revised_pct_by_bars_back['7+'], 0);
    assert.match(PIVOT_EDGE_STABILITY.vs_fractal, /guarantee/);
  });
});
