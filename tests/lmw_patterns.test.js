import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  classifyFive, findDoubles, detectLmwPatterns, LMW_TOLERANCES, LMW_REPLICATION,
  LMW_NOISE_PROFILE,
} from "../src/core/lmw_patterns.js";
import { GENERATORS, barsFromPath, randomWalk } from '../src/core/synthetic.js';

const ext = (kinds, prices, indices = null) => kinds.map((k, i) => ({
  kind: k, price: prices[i], index: indices ? indices[i] : i * 10, time: i * 86400,
}));

describe('classifyFive — the definitions, verbatim', () => {
  test('head and shoulders: middle peak highest, shoulders within 1.5%', () => {
    const e = ext(['high', 'low', 'high', 'low', 'high'], [100, 80, 115, 80.5, 100.5]);
    assert.ok(classifyFive(e).includes('head_and_shoulders'));
  });

  test('rejects H&S when the shoulders differ by more than 1.5%', () => {
    const e = ext(['high', 'low', 'high', 'low', 'high'], [100, 80, 115, 80.5, 110]);
    assert.ok(!classifyFive(e).includes('head_and_shoulders'));
  });

  test('rejects H&S when the head is not the highest', () => {
    const e = ext(['high', 'low', 'high', 'low', 'high'], [100, 80, 99, 80.5, 100.5]);
    assert.ok(!classifyFive(e).includes('head_and_shoulders'));
  });

  test('inverse H&S is the mirror', () => {
    const e = ext(['low', 'high', 'low', 'high', 'low'], [100, 120, 85, 119.5, 100.5]);
    assert.ok(classifyFive(e).includes('inverse_head_and_shoulders'));
  });

  test('broadening top: highs rising, lows falling', () => {
    const e = ext(['high', 'low', 'high', 'low', 'high'], [100, 95, 105, 90, 110]);
    assert.ok(classifyFive(e).includes('broadening_top'));
  });

  test('triangle top: highs falling, lows rising — the exact mirror of broadening', () => {
    const e = ext(['high', 'low', 'high', 'low', 'high'], [110, 90, 105, 95, 100]);
    const hits = classifyFive(e);
    assert.ok(hits.includes('triangle_top'));
    assert.ok(!hits.includes('broadening_top'), 'a shape cannot be both');
  });

  test('a shape is never simultaneously a triangle and a broadening formation', () => {
    for (let t = 0; t < 200; t++) {
      const p = [100 + t % 7, 90 - t % 5, 100 + (t * 3) % 11, 90 - (t * 2) % 6, 100 + (t * 5) % 13];
      const hits = classifyFive(ext(['high', 'low', 'high', 'low', 'high'], p));
      assert.ok(!(hits.includes('triangle_top') && hits.includes('broadening_top')));
    }
  });

  test('rectangle top: flat tops and flat bottoms within 0.75%', () => {
    const e = ext(['high', 'low', 'high', 'low', 'high'], [100, 90, 100.4, 90.3, 100.2]);
    assert.ok(classifyFive(e).includes('rectangle_top'));
  });

  test('rejects a rectangle whose tops wander more than 0.75%', () => {
    const e = ext(['high', 'low', 'high', 'low', 'high'], [100, 90, 103, 90.3, 100.2]);
    assert.ok(!classifyFive(e).includes('rectangle_top'));
  });

  test('rejects a rectangle whose lowest top sits below its highest bottom', () => {
    const e = ext(['high', 'low', 'high', 'low', 'high'], [100, 100.2, 100.4, 100.3, 100.2]);
    assert.ok(!classifyFive(e).includes('rectangle_top'));
  });

  test('anything but exactly five extrema returns nothing', () => {
    assert.deepStrictEqual(classifyFive(ext(['high', 'low', 'high'], [1, 2, 3])), []);
    assert.deepStrictEqual(classifyFive(null), []);
  });
});

describe('findDoubles — Definition 5', () => {
  test('finds a double top 22+ bars apart and within 1.5%', () => {
    const pivots = ext(['high', 'low', 'high'], [100, 80, 100.8], [0, 15, 30]);
    const d = findDoubles(pivots);
    assert.strictEqual(d.length, 1);
    assert.strictEqual(d[0].pattern, 'double_top');
    assert.strictEqual(d[0].separation_bars, 30);
  });

  test('rejects tops closer together than 22 trading days', () => {
    const pivots = ext(['high', 'low', 'high'], [100, 80, 100.8], [0, 5, 12]);
    assert.strictEqual(findDoubles(pivots).length, 0);
  });

  test('rejects tops further apart than 1.5% in price', () => {
    const pivots = ext(['high', 'low', 'high'], [100, 80, 110], [0, 15, 30]);
    assert.strictEqual(findDoubles(pivots).length, 0);
  });

  test('finds a double bottom symmetrically', () => {
    const pivots = ext(['low', 'high', 'low'], [100, 130, 99.5], [0, 15, 30]);
    const d = findDoubles(pivots);
    assert.strictEqual(d[0].pattern, 'double_bottom');
  });

  test('the separation threshold is exactly the documented 22', () => {
    assert.strictEqual(LMW_TOLERANCES.double_min_separation, 22);
  });
});

describe('detectLmwPatterns', () => {
  test('finds a head and shoulders in a constructed one', () => {
    const bars = barsFromPath(GENERATORS.head_and_shoulders({}), { noise: 0.005, seed: 5 });
    const out = detectLmwPatterns(bars, { window: null });
    assert.ok(out.patterns.some((p) => p.pattern === 'head_and_shoulders'),
      `found: ${out.patterns.map((p) => p.pattern).join(', ') || 'nothing'}`);
  });

  test('finds a broadening formation in a constructed one', () => {
    const bars = barsFromPath(GENERATORS.broadening_formation({}), { noise: 0.005, seed: 5 });
    const out = detectLmwPatterns(bars, { window: null });
    assert.ok(out.patterns.some((p) => p.pattern.startsWith('broadening')),
      `found: ${out.patterns.map((p) => p.pattern).join(', ') || 'nothing'}`);
  });

  test('every reported extremum price traded on its bar', () => {
    const bars = barsFromPath(GENERATORS.double_top({}), { noise: 0.01, seed: 9 });
    const out = detectLmwPatterns(bars, { window: null });
    for (const p of out.patterns) {
      for (const e of p.extrema) {
        const bar = bars[e.index];
        const real = e.kind === 'high' ? bar.high : bar.low;
        assert.strictEqual(e.price, real, `${p.pattern} extremum ${e.price} != bar ${e.kind} ${real}`);
      }
    }
  });

  test('carries the replication failure with every result', () => {
    const bars = barsFromPath(randomWalk({ n: 100, seed: 4 }), { noise: 0.005, seed: 4 });
    const out = detectLmwPatterns(bars, { window: null });
    assert.match(out.replication.reproduction, /not anymore reproducible/);
    assert.match(out.replication.read_as, /not evidence of an edge/);
  });

  test('short input is reported, not crashed on', () => {
    const out = detectLmwPatterns([{ high: 1, low: 1, close: 1, time: 0 }]);
    assert.deepStrictEqual(out.patterns, []);
    assert.match(out.note, /at least 10 bars/);
    assert.strictEqual(out.replication, LMW_REPLICATION);
  });

  test('rolling windows do not emit duplicate detections', () => {
    const bars = barsFromPath(GENERATORS.head_and_shoulders({}), { noise: 0.005, seed: 5 });
    const out = detectLmwPatterns(bars, { window: 38 });
    const keys = out.patterns.map((p) => `${p.pattern}:${p.from_index}:${p.to_index}`);
    assert.strictEqual(new Set(keys).size, keys.length, 'overlapping windows leaked duplicates');
  });
});

describe('LMW_NOISE_PROFILE — the measured permissiveness', () => {
  test('carries the noise profile and health warning on every result', () => {
    const bars = barsFromPath(randomWalk({ n: 120, seed: 8 }), { noise: 0.005, seed: 8 });
    const out = detectLmwPatterns(bars, { window: null });
    assert.strictEqual(out.noise_profile.any_definition_pct, 37.9);
    assert.match(out.health_warning, /PURE RANDOM WALKS/);
  });

  test('records that the tolerance definitions are far more permissive than the inequality chains', () => {
    /**
     * This used to assert "rectangle is the MOST permissive definition", at
     * 13.6% against head-and-shoulders' 9.2%. That ordering was an artefact:
     * this module consumed the RAW kernel sequence, which emitted adjacent
     * pivots mapped onto the SAME BAR, and a bar's high and low read as an
     * extremely flat top and bottom — exactly what rectangle's 0.75% tolerance
     * rewards. With the kernel fixed (P2.7) rectangle_top is 8.8% and
     * head_and_shoulders is 9.7%, so rectangle is no longer the outlier.
     *
     * What survives, and what the module's argument actually rests on, is the
     * SHAPE of the ordering: the two definitions with a percentage tolerance
     * term fire four times as often as the four pure inequality chains.
     */
    const p = LMW_NOISE_PROFILE.by_pattern_pct;
    const tolerance = [p.rectangle_top, p.rectangle_bottom, p.head_and_shoulders, p.inverse_head_and_shoulders];
    const chains = [p.triangle_top, p.triangle_bottom, p.broadening_top, p.broadening_bottom];
    assert.ok(Math.min(...tolerance) > 3 * Math.max(...chains),
      `tolerance definitions ${JSON.stringify(tolerance)} vs inequality chains ${JSON.stringify(chains)}`);
    assert.ok(Math.max(...chains) < 5);
  });

  test('the pre-P2.7 profile is kept, so the size of the correction stays visible', () => {
    const prev = LMW_NOISE_PROFILE.previously;
    assert.strictEqual(prev.any_definition_pct, 43.4);
    assert.strictEqual(prev.by_pattern_pct.rectangle_top, 13.6);
    assert.ok(prev.any_definition_pct > LMW_NOISE_PROFILE.any_definition_pct,
      'the floor came DOWN when the kernel stopped emitting two pivots on one bar');
    assert.match(prev.why, /same-bar|index-inverted/);
  });

  test('the synthetic double_top is correctly REJECTED for being too short', () => {
    // The generator's peaks are ~20 bars apart; Edwards & Magee require 22.
    // This asserts the definition is enforced, so nobody loosens it later.
    const bars = barsFromPath(GENERATORS.double_top({}), { noise: 0.005, seed: 1 });
    const out = detectLmwPatterns(bars, { window: null });
    assert.ok(!out.patterns.some((p) => p.pattern === 'double_top'),
      'a 20-bar-separated double must not satisfy a 22-bar rule');
  });
});
