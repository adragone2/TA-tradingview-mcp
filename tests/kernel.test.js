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
