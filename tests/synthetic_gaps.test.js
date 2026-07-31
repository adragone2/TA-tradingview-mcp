import { test, describe } from 'node:test';
import assert from 'node:assert';
import { randomWalkWithGaps, randomWalk, barsFromPath } from '../src/core/synthetic.js';

/**
 * The gap-aware null is not a convenience — it IS the measurement for
 * src/core/gaps.js, so a defect in it is indistinguishable from a finding. Two
 * were caught by exactly the checks below during development:
 *
 *   1. A first version DISCARDED any injected offset too small to separate the
 *      bars, which achieved 1.6% of bars gapping while reporting gap_rate 0.10.
 *   2. The fix then added the running shift to itself, compounding a price of
 *      100 into 79,600 over 200 bars.
 *
 * Neither threw. Both would have produced a confident, wrong noise floor.
 */

const gapsIn = (bars) => {
  let n = 0;
  for (let i = 1; i < bars.length; i++) {
    if (bars[i].low > bars[i - 1].high || bars[i].high < bars[i - 1].low) n++;
  }
  return n;
};

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

function atrOverRange(bars) {
  const tr = [], rg = [];
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i], p = bars[i - 1];
    tr.push(Math.max(b.high - b.low, Math.abs(b.high - p.close), Math.abs(b.low - p.close)));
    rg.push(b.high - b.low);
  }
  return mean(tr) / mean(rg);
}

describe('randomWalkWithGaps — the shape of what it returns', () => {
  test('it returns BARS, not a path — the whole reason it has a different shape', () => {
    /**
     * randomWalk and every GENERATORS entry return an array of closes. A
     * detector reading open/high/low/volume fed one of those measures nothing
     * and reports a 0% floor, which reads as a perfect detector. Returning an
     * object makes that mistake a crash instead.
     */
    const r = randomWalkWithGaps({ n: 50 });
    assert.ok(!Array.isArray(r), 'it returns a bare array again — the fixture trap is back');
    assert.ok(Array.isArray(r.bars));
    for (const k of ['open', 'high', 'low', 'close', 'volume', 'time']) {
      assert.ok(k in r.bars[0], `bars are missing ${k}`);
    }
  });

  test('it reports what it injected and what it was asked for', () => {
    const r = randomWalkWithGaps({ n: 200, seed: 3 });
    assert.ok(Array.isArray(r.injected_gaps));
    assert.equal(r.params.gap_rate, 0.06);
    assert.match(r.note, /BARS, not a path/);
  });

  test('bars are internally consistent: high >= max(open, close) >= min(open, close) >= low', () => {
    const { bars } = randomWalkWithGaps({ n: 200, seed: 11 });
    for (const b of bars) {
      assert.ok(b.high >= Math.max(b.open, b.close) - 1e-9, 'high below the body');
      assert.ok(b.low <= Math.min(b.open, b.close) + 1e-9, 'low above the body');
    }
  });

  test('it is deterministic for a seed', () => {
    const a = randomWalkWithGaps({ n: 100, seed: 42 }).bars;
    const b = randomWalkWithGaps({ n: 100, seed: 42 }).bars;
    assert.deepEqual(a, b);
    const c = randomWalkWithGaps({ n: 100, seed: 43 }).bars;
    assert.notDeepEqual(a, c);
  });
});

describe('randomWalkWithGaps — the gaps are the ones it says they are', () => {
  test('the achieved gap rate matches gap_rate', () => {
    for (const rate of [0.04, 0.06, 0.12]) {
      let gaps = 0, bars = 0;
      for (let s = 0; s < 30; s++) {
        const r = randomWalkWithGaps({ n: 200, seed: 100 + s, gap_rate: rate });
        gaps += gapsIn(r.bars);
        bars += r.bars.length - 1;
      }
      const achieved = gaps / bars;
      assert.ok(Math.abs(achieved - rate) < rate * 0.5,
        `asked for ${rate}, achieved ${achieved.toFixed(3)} — a null whose stated frequency is wrong answers a different question`);
    }
  });

  test('every injected gap is actually visible to the gap definition', () => {
    const r = randomWalkWithGaps({ n: 200, seed: 7 });
    const visible = new Set();
    for (let i = 1; i < r.bars.length; i++) {
      if (r.bars[i].low > r.bars[i - 1].high || r.bars[i].high < r.bars[i - 1].low) visible.add(i);
    }
    for (const g of r.injected_gaps) {
      assert.ok(visible.has(g.index), `injected gap at ${g.index} produced no visible discontinuity`);
    }
  });

  test('the median gap size matches gap_median_atr, in mean-bar-range units', () => {
    const sizes = [];
    for (let s = 0; s < 30; s++) {
      for (const g of randomWalkWithGaps({ n: 200, seed: 200 + s, gap_median_atr: 0.35 }).injected_gaps) {
        sizes.push(g.size_in_ref_ranges);
      }
    }
    sizes.sort((a, b) => a - b);
    const median = sizes[Math.floor(sizes.length / 2)];
    assert.ok(Math.abs(median - 0.35) < 0.08, `median gap ${median.toFixed(3)} ref ranges, expected ~0.35`);
  });

  test('gap direction is symmetric, so the null carries no drift', () => {
    let up = 0, total = 0, netReturn = 0;
    for (let s = 0; s < 60; s++) {
      const r = randomWalkWithGaps({ n: 200, seed: 300 + s });
      for (const g of r.injected_gaps) { if (g.direction === 'up') up++; total++; }
      netReturn += (r.bars[r.bars.length - 1].close - r.bars[0].close) / r.bars[0].close;
    }
    assert.ok(Math.abs(up / total - 0.5) < 0.06, `${((up / total) * 100).toFixed(1)}% of gaps were up`);
    assert.ok(Math.abs(netReturn / 60) < 0.10, `mean net return ${(netReturn / 60).toFixed(3)} — the null has acquired a drift`);
  });

  test('prices stay sane — the compounding bug turned 100 into 79,600', () => {
    for (let s = 0; s < 40; s++) {
      const { bars } = randomWalkWithGaps({ n: 200, seed: 400 + s });
      const closes = bars.map((b) => b.close);
      assert.ok(Math.min(...closes) > 1, `price fell to ${Math.min(...closes)}`);
      assert.ok(Math.max(...closes) < 1000, `price ran to ${Math.max(...closes)} from a start of 100`);
    }
  });
});

describe('randomWalkWithGaps — the calibration that makes it a null and not a guess', () => {
  test('the defaults hit the ATR-to-range ratio measured on real daily bars', () => {
    /**
     * ATR counts overnight gaps, bar range does not, so this ratio is what any
     * gap-gated rule actually keys on. The ignition.js investigation measured
     * 1.070 on real daily bars against 1.001 for a reconstructed gapless path.
     * Anything far from 1.070 gates differently from real data and the floor
     * measured with it describes the fixture.
     */
    const ratios = [];
    for (let s = 0; s < 40; s++) ratios.push(atrOverRange(randomWalkWithGaps({ n: 200, seed: 500 + s }).bars));
    const r = mean(ratios);
    assert.ok(Math.abs(r - 1.070) < 0.03, `ATR/range is ${r.toFixed(3)}, real daily bars are 1.070`);
  });

  test('the gapless harness path sits at ~1.00, which is the problem being solved', () => {
    const ratios = [];
    for (let s = 0; s < 40; s++) {
      ratios.push(atrOverRange(barsFromPath(randomWalk({ n: 200, seed: 500 + s }), { noise: 0.006, seed: 600 + s })));
    }
    const r = mean(ratios);
    assert.ok(r < 1.03, `the gapless path now reads ${r.toFixed(3)} — the contrast that motivates this generator is gone`);
  });

  test('more or larger gaps push the ratio away from real data, which is why it was swept', () => {
    const at = (p) => mean(Array.from({ length: 20 }, (_, s) => atrOverRange(randomWalkWithGaps({ n: 200, seed: 700 + s, ...p }).bars)));
    assert.ok(at({ gap_rate: 0.10, gap_median_atr: 0.5 }) > at({ gap_rate: 0.06, gap_median_atr: 0.35 }));
    assert.ok(at({ gap_rate: 0.02, gap_median_atr: 0.15 }) < at({ gap_rate: 0.06, gap_median_atr: 0.35 }));
  });
});

describe('randomWalkWithGaps — the volume modes, and why there are three', () => {
  const volsOf = (mode, extra = {}) => randomWalkWithGaps({ n: 200, seed: 9, volume_mode: mode, ...extra });

  test('flat leaves the harness volume alone — near-constant, and a fixture artefact', () => {
    const { bars } = volsOf('flat');
    const v = bars.map((b) => b.volume);
    const spread = (Math.max(...v) - Math.min(...v)) / mean(v);
    assert.ok(spread < 1, `flat volume spread ${spread.toFixed(2)} is no longer flat`);
  });

  test('lognormal disperses volume but does NOT elevate gap bars', () => {
    const r = volsOf('lognormal');
    const gapIdx = new Set(r.injected_gaps.map((g) => g.index));
    const onGaps = mean(r.bars.filter((_, i) => gapIdx.has(i)).map((b) => b.volume));
    const off = mean(r.bars.filter((_, i) => !gapIdx.has(i)).map((b) => b.volume));
    assert.ok(Math.abs(onGaps / off - 1) < 0.35, `gap bars carry ${(onGaps / off).toFixed(2)}x volume under 'lognormal'`);
  });

  test('gap_elevated multiplies gap-bar volume by the stated factor', () => {
    for (const mult of [2.0, 3.0]) {
      const r = volsOf('gap_elevated', { gap_volume_multiple: mult });
      const gapIdx = new Set(r.injected_gaps.map((g) => g.index));
      const onGaps = mean(r.bars.filter((_, i) => gapIdx.has(i)).map((b) => b.volume));
      const off = mean(r.bars.filter((_, i) => !gapIdx.has(i)).map((b) => b.volume));
      assert.ok(onGaps / off > mult * 0.6, `asked for x${mult}, gap bars carry ${(onGaps / off).toFixed(2)}x`);
    }
  });

  test('the volume mode changes ONLY volume — the price path is identical', () => {
    const strip = (bars) => bars.map(({ volume, ...rest }) => rest);
    assert.deepEqual(strip(volsOf('flat').bars), strip(volsOf('gap_elevated').bars));
    assert.deepEqual(strip(volsOf('flat').bars), strip(volsOf('lognormal').bars));
  });
});
