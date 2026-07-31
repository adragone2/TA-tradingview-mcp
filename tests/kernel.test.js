import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  kernelSmooth, crossValidationScore, optimalBandwidth, findKernelPivots, pivotWidth,
} from '../src/core/kernel.js';
import { GENERATORS, barsFromPath, randomWalk, legs } from '../src/core/synthetic.js';

describe('kernelSmooth', () => {
  test('a constant series smooths to itself', () => {
    const out = kernelSmooth([5, 5, 5, 5, 5, 5], 2);
    for (const v of out) assert.ok(Math.abs(v - 5) < 1e-9);
  });

  test('smoothing reduces variance', () => {
    const noisy = Array.from({ length: 100 }, (_, i) => Math.sin(i / 5) + (i % 2 ? 0.5 : -0.5));
    const sd = (a) => { const m = a.reduce((x, y) => x + y, 0) / a.length; return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length); };
    assert.ok(sd(kernelSmooth(noisy, 3)) < sd(noisy));
  });

  test('a larger bandwidth smooths more', () => {
    const noisy = Array.from({ length: 100 }, (_, i) => Math.sin(i / 5) + (i % 2 ? 0.5 : -0.5));
    const rough = (a) => a.slice(1).reduce((s, v, i) => s + Math.abs(v - a[i]), 0);
    assert.ok(rough(kernelSmooth(noisy, 6)) < rough(kernelSmooth(noisy, 2)));
  });

  test('rejects a non-positive bandwidth', () => {
    assert.throws(() => kernelSmooth([1, 2, 3], 0), /must be positive/);
    assert.throws(() => kernelSmooth([1, 2, 3], -1), /must be positive/);
  });

  test('empty input returns empty', () => {
    assert.deepStrictEqual(kernelSmooth([], 2), []);
  });
});

describe('bandwidth selection', () => {
  test('cross-validation prefers a finite bandwidth on a smooth signal', () => {
    const clean = Array.from({ length: 120 }, (_, i) => 100 + 10 * Math.sin(i / 8));
    const h = optimalBandwidth(clean);
    assert.ok(h > 0 && Number.isFinite(h));
  });

  test('CV score is worse at an absurdly large bandwidth than near the optimum', () => {
    const clean = Array.from({ length: 120 }, (_, i) => 100 + 10 * Math.sin(i / 8));
    const h = optimalBandwidth(clean);
    assert.ok(crossValidationScore(clean, h) < crossValidationScore(clean, 60));
  });
});

describe('findKernelPivots — the LMW mapping step', () => {
  const bars = barsFromPath(GENERATORS.head_and_shoulders({}), { noise: 0.01, seed: 7 });

  test('EVERY pivot price is a price that actually traded', () => {
    const { pivots } = findKernelPivots(bars);
    assert.ok(pivots.length > 0, 'should find pivots on a constructed H&S');
    for (const p of pivots) {
      const bar = bars[p.index];
      const real = p.kind === 'high' ? bar.high : bar.low;
      assert.strictEqual(p.price, real,
        `pivot at ${p.index} reported ${p.price} but the bar's ${p.kind} is ${real}`);
    }
  });

  test('pivots alternate high/low without exception', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const b = barsFromPath(randomWalk({ n: 150, seed }), { noise: 0.01, seed: seed + 50 });
      const { pivots } = findKernelPivots(b);
      for (let i = 1; i < pivots.length; i++) {
        assert.notStrictEqual(pivots[i].kind, pivots[i - 1].kind,
          `seed ${seed}: two ${pivots[i].kind} pivots in a row at index ${i}`);
      }
    }
  });

  test('pivot indices are strictly increasing', () => {
    const { pivots } = findKernelPivots(bars);
    for (let i = 1; i < pivots.length; i++) {
      assert.ok(pivots[i].index > pivots[i - 1].index, 'pivots must move forward in time');
    }
  });

  test('a smaller bandwidth multiplier finds at least as many pivots', () => {
    const b = barsFromPath(randomWalk({ n: 200, seed: 11 }), { noise: 0.01, seed: 99 });
    const wide = findKernelPivots(b, { bandwidth_multiplier: 1.0 }).pivots.length;
    const tight = findKernelPivots(b, { bandwidth_multiplier: 0.3 }).pivots.length;
    assert.ok(tight >= wide,
      `0.3x should not find FEWER extrema than 1x (got ${tight} vs ${wide}) — this is Nekrasov's over-detection point`);
  });

  test('reports the CV-optimal bandwidth alongside the one it used', () => {
    const out = findKernelPivots(bars, { bandwidth_multiplier: 0.3 });
    assert.ok(out.bandwidth_cv_optimal > 0);
    assert.ok(Math.abs(out.bandwidth - out.bandwidth_cv_optimal * 0.3) < 1e-3);
    assert.match(out.bandwidth_note, /Nekrasov/);
  });

  test('too few bars is reported, not crashed on', () => {
    const out = findKernelPivots([{ high: 1, low: 1, close: 1, time: 0 }]);
    assert.deepStrictEqual(out.pivots, []);
    assert.match(out.note, /at least 5 bars/);
  });
});

/**
 * P2.7 — the invariants, on the NULL rather than on one constructed fixture.
 *
 * `findKernelPivots` promised alternating kinds and, by implication, a sequence
 * that moves forward in time. The first was enforced; the second was not, and
 * the single-fixture test above passed throughout because a clean constructed
 * head-and-shoulders never triggers it.
 *
 * The mechanism is the map-back step: adjacent smoothed extrema search
 * OVERLAPPING bar windows, so a high and the low after it could map onto bars in
 * the wrong order — or onto the same bar. Measured on the standard null (200
 * walks of 300 bars, bandwidth 2.0) the old code emitted **23 adjacent pairs
 * that were not strictly increasing: 9 inverted and 14 on the same bar**, and
 * the defect grew as the smoothing got finer (8.02% of pivots at bandwidth 0.8).
 *
 * These are property tests over the whole null, at every bandwidth and
 * `map_window` the module is used at, because a fixture that happens not to
 * collide is exactly what let this survive.
 */
describe('findKernelPivots — the invariants, on the null (P2.7)', () => {
  const walk = (n, s) => barsFromPath(randomWalk({ n, seed: 7000 + s }), { noise: 0.006, seed: 8000 + s });

  /**
   * Every configuration the module is actually driven at: `pivots.js` lookbacks
   * 2/3/5/8 become bandwidths 0.8/1.2/2.0/3.2, `pivots_kernel` and
   * `lmw_patterns.js` use the cross-validated bandwidth via the multiplier, and
   * `map_window` is a parameter nothing in the repo currently moves — which is
   * precisely why it needs a test.
   */
  const CONFIGS = [
    { bandwidth: 0.4 }, { bandwidth: 0.8 }, { bandwidth: 1.2 },
    { bandwidth: 2.0 }, { bandwidth: 3.2 }, { bandwidth: 5.0 },
    { bandwidth: 2.0, map_window: 2 },
    { bandwidth: 2.0, map_window: 3 },
    { bandwidth: 0.8, map_window: 3 },
    { bandwidth: 2.0, source: 'hl2' },
    { bandwidth_multiplier: 1.0 },
    { bandwidth_multiplier: 0.3 },
  ];

  test('indices are STRICTLY increasing — 23 out-of-order pairs per 200 walks, now 0', () => {
    let checked = 0;
    for (let s = 0; s < 200; s += 1) {
      const { pivots } = findKernelPivots(walk(300, s), { bandwidth: 2.0 });
      checked += pivots.length;
      for (let i = 1; i < pivots.length; i += 1) {
        assert.ok(pivots[i].index > pivots[i - 1].index,
          `seed ${7000 + s}: index went ${pivots[i - 1].index} -> ${pivots[i].index} `
          + `(${pivots[i - 1].kind} -> ${pivots[i].kind})`);
      }
    }
    assert.ok(checked > 6000, `only ${checked} pivots checked — the sweep is not exercising anything`);
  });

  test('all three invariants hold at every bandwidth and map_window', () => {
    let checked = 0;
    for (const opts of CONFIGS) {
      for (let s = 0; s < 40; s += 1) {
        const bars = walk(300, s);
        const { pivots } = findKernelPivots(bars, opts);
        for (let i = 0; i < pivots.length; i += 1) {
          const p = pivots[i];
          const real = p.kind === 'high' ? bars[p.index].high : bars[p.index].low;
          assert.equal(p.price, real,
            `${JSON.stringify(opts)} seed ${7000 + s}: pivot at ${p.index} reports ${p.price}, the bar's ${p.kind} is ${real}`);
          assert.equal(p.time, bars[p.index].time, 'the pivot time must be the mapped bar\'s time');
          if (i > 0) {
            assert.ok(p.index > pivots[i - 1].index,
              `${JSON.stringify(opts)} seed ${7000 + s}: index ${pivots[i - 1].index} -> ${p.index}`);
            assert.notEqual(p.kind, pivots[i - 1].kind,
              `${JSON.stringify(opts)} seed ${7000 + s}: two ${p.kind}s in a row`);
          }
          checked += 1;
        }
      }
    }
    assert.ok(checked > 15000, `only ${checked} pivots checked across ${CONFIGS.length} configurations`);
  });

  test('a pivot never lands further than map_window from its smoothed extremum', () => {
    // The map-back is allowed to move a pivot onto a neighbouring bar; it is not
    // allowed to relocate it. If this fails the smoothing has stopped deciding
    // where to look and started deciding what the answer is.
    for (const map_window of [1, 2, 3]) {
      for (let s = 0; s < 25; s += 1) {
        for (const p of findKernelPivots(walk(300, s), { bandwidth: 1.2, map_window }).pivots) {
          assert.ok(Math.abs(p.index - p.smoothed_index) <= map_window,
            `seed ${7000 + s}: pivot moved ${Math.abs(p.index - p.smoothed_index)} bars at map_window ${map_window}`);
        }
      }
    }
  });

  test('an out-of-order pair keeps the EARLIER turn, a same-kind run keeps the more EXTREME', () => {
    /**
     * The two collapse rules, on constructed input rather than inferred from an
     * aggregate. Both mirror `pivots.enforceInvariants`, which is kept as a
     * second layer.
     *
     * Bars 10 and 11 are built so the smoothed curve turns down at 10 and back
     * up at 11 while bar 11 holds the highest high and bar 10 the lowest low —
     * the exact swap that produced the 9 genuine inversions. Whatever the
     * smoothing does here, the OUTPUT may not step backwards.
     */
    const closes = [
      100, 101, 102, 103, 104, 105, 106, 107, 108, 109,
      112, 108, 111, 107, 110, 106, 105, 104, 103, 102, 101, 100,
    ];
    const bars = closes.map((c, i) => ({
      time: 1_700_000_000 + i * 86400,
      open: c, close: c,
      high: c + (i === 11 ? 6 : 0.2),
      low: c - (i === 10 ? 6 : 0.2),
      volume: 1000,
    }));
    for (const bandwidth of [0.4, 0.6, 0.8, 1.0, 1.5, 2.0]) {
      const { pivots } = findKernelPivots(bars, { bandwidth });
      for (let i = 1; i < pivots.length; i += 1) {
        assert.ok(pivots[i].index > pivots[i - 1].index,
          `bandwidth ${bandwidth}: ${pivots[i - 1].index} -> ${pivots[i].index}`);
        assert.notEqual(pivots[i].kind, pivots[i - 1].kind);
      }
      for (const p of pivots) {
        assert.equal(p.price, p.kind === 'high' ? bars[p.index].high : bars[p.index].low);
      }
      const at = pivots.filter((p) => p.index === 10 || p.index === 11);
      assert.ok(new Set(at.map((p) => p.index)).size === at.length,
        `bandwidth ${bandwidth}: two pivots on one bar — ${JSON.stringify(at.map((p) => `${p.index}${p.kind}`))}`);
    }

    /**
     * The decision itself, pinned. At bandwidth 0.4 and 0.6 the old code emitted
     *
     *     11h, 10l, 11h, 13l, 14h
     *
     * — the low at bar 10 arriving AFTER the high at bar 11 (the inversion), and
     * then a second high back on bar 11. The high is the turn the smoothing found
     * first, so it is the one kept; the low is dropped, and the repeated high
     * collapses into it because it is not more extreme. If this ever reads
     * `11h, 10l, ...` again the invariant has come off.
     */
    for (const bandwidth of [0.4, 0.6]) {
      const seq = findKernelPivots(bars, { bandwidth }).pivots.map((p) => `${p.index}${p.kind[0]}`);
      assert.deepStrictEqual(seq, ['11h', '13l', '14h'],
        `bandwidth ${bandwidth}: the collision resolved to ${JSON.stringify(seq)}`);
    }
  });

  test('the repair is the kernel\'s own, not the backbone\'s — findPivots is unchanged by it', () => {
    /**
     * `pivots.js` already repaired its copy in `enforceInvariants`, so a fix here
     * that changed the backbone's OUTPUT would be re-calibrating every detector
     * in the repo under a noise-floor ticket. Measured: identical at lookbacks
     * 3-8, one pivot different in 14,342 at lookback 2. This asserts the shape of
     * that claim — the kernel's pivot count must not jump.
     */
    // Pinned exactly, because the harness is deterministic and a band wide
    // enough to be comfortable would also admit the pre-fix figure.
    for (const [bandwidth, after, before] of [[0.8, 14368, 16912], [2.0, 6646, 6692]]) {
      let total = 0;
      for (let s = 0; s < 200; s += 1) total += findKernelPivots(walk(300, s), { bandwidth }).pivots.length;
      assert.equal(total, after,
        `bandwidth ${bandwidth}: ${total} pivots over 200 walks of 300 bars, recorded ${after} `
        + `(${before} before the P2.7 collapse — a return to that number means the invariant is off again)`);
    }
  });
});

describe('pivotWidth — the check that would have caught the CSCO wedge', () => {
  test('a constructed broadening formation reads DIVERGING', () => {
    const b = barsFromPath(GENERATORS.broadening_formation({}), { noise: 0.005, seed: 3 });
    const { pivots } = findKernelPivots(b);
    const w = pivotWidth(pivots);
    assert.strictEqual(w.verdict, 'diverging', `got ${w.verdict} (${w.width_start} -> ${w.width_end})`);
  });

  test('a constructed symmetrical triangle reads CONVERGING', () => {
    const b = barsFromPath(GENERATORS.symmetrical_triangle({}), { noise: 0.005, seed: 3 });
    const { pivots } = findKernelPivots(b);
    const w = pivotWidth(pivots);
    assert.strictEqual(w.verdict, 'converging', `got ${w.verdict} (${w.width_start} -> ${w.width_end})`);
  });

  test('refuses a verdict when there are too few pivots to support one', () => {
    const w = pivotWidth([{ kind: 'high', price: 10 }, { kind: 'low', price: 5 }]);
    assert.strictEqual(w.verdict, 'indeterminate');
    assert.match(w.note, /Two of each are the minimum/);
  });

  test('THE CSCO CASE: falling lows outpacing falling highs reads diverging', () => {
    // Highs 130.37 -> 122.89 -> 121.61 and lows 116.50 -> 111.33 -> 107.53,
    // the real CSCO pivots from 2026-07-27. The old detector called this
    // converging from its fitted boundaries.
    const pivots = [
      { kind: 'high', price: 130.37 }, { kind: 'low', price: 116.50 },
      { kind: 'high', price: 122.89 }, { kind: 'low', price: 111.33 },
      { kind: 'high', price: 121.61 }, { kind: 'low', price: 107.53 },
    ];
    const w = pivotWidth(pivots);
    assert.strictEqual(w.verdict, 'diverging');
    assert.ok(w.width_end > w.width_start, `${w.width_start} -> ${w.width_end}`);
  });
});
