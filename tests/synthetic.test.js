/**
 * Detector measurement against constructed ground truth.
 *
 * Every other test here checks a detector against a fixture written to make it
 * pass. These check the two things that decide whether pattern detection is
 * worth having: how often a real shape is found, and how often one is reported
 * in pure noise.
 *
 * The second number is the one that matters and it is bad — see NOISE_BASELINE.
 * These tests LOCK IN the measurement so that a change to detection thresholds
 * shows up as a changed number rather than passing silently.
 *
 * Run: node --test tests/synthetic.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { GENERATORS, barsFromPath, randomWalk, measure, rng } from '../src/core/synthetic.js';
import { detectPatterns, NOISE_BASELINE, vsNoise } from '../src/core/patterns.js';

const detect = (bars) => detectPatterns(bars, { lookback: 4, window_bars: 90, max_age_bars: 400 })
  .structural.map((p) => p.pattern);

describe('synthetic generators', () => {
  it('is deterministic for a given seed', () => {
    const a = barsFromPath(GENERATORS.double_top({}), { noise: 0.01, seed: 42 });
    const b = barsFromPath(GENERATORS.double_top({}), { noise: 0.01, seed: 42 });
    assert.deepEqual(a, b);
    const c = barsFromPath(GENERATORS.double_top({}), { noise: 0.01, seed: 43 });
    assert.notDeepEqual(a, c);
  });

  it('produces valid OHLC bars', () => {
    for (const [name, gen] of Object.entries(GENERATORS)) {
      for (const b of barsFromPath(gen({}), { noise: 0.02, seed: 7 })) {
        assert.ok(b.high >= b.open && b.high >= b.close, `${name}: high below body`);
        assert.ok(b.low <= b.open && b.low <= b.close, `${name}: low above body`);
      }
    }
  });

  it('covers every structural pattern the detector claims to find', () => {
    // Except the flags, which the measurement shows are never detected — see
    // the failing-detector test below.
    for (const p of ['double_top', 'double_bottom', 'head_and_shoulders', 'ascending_triangle', 'rising_wedge']) {
      assert.ok(GENERATORS[p], `no generator for ${p}`);
    }
  });

  it('random walks are reproducible and actually random-looking', () => {
    const w = randomWalk({ n: 300, seed: 11 });
    assert.equal(w.length, 300);
    assert.deepEqual(w, randomWalk({ n: 300, seed: 11 }));
    assert.notDeepEqual(w, randomWalk({ n: 300, seed: 12 }));
  });
});

describe('detection rate against constructed shapes', () => {
  const found = (name, noise, seed) =>
    detect(barsFromPath(GENERATORS[name]({}), { noise, seed })).includes(name);

  for (const name of ['double_top', 'double_bottom', 'head_and_shoulders',
                      'inverse_head_and_shoulders', 'triple_top', 'triple_bottom']) {
    it(`finds a constructed ${name}`, () => {
      assert.ok(found(name, 0.01, 1001), `${name} was not detected in a chart built to contain one`);
    });
  }

  it('DOES NOT find flags — a known broken detector', () => {
    // Measured at 0% across every noise level. Recorded rather than hidden so
    // that fixing it turns this test red and forces the assertion to change.
    const bull = found('bull_flag', 0.01, 1001);
    const bear = found('bear_flag', 0.01, 1001);
    assert.equal(bull, false, 'bull_flag now detects — fix the detector, then flip this assertion');
    assert.equal(bear, false, 'bear_flag now detects — fix the detector, then flip this assertion');
  });
});

describe('false positives on pure noise — the number that matters', () => {
  it('reports far too many patterns in a random walk, and the baseline records it', () => {
    const r = measure(detect, { patterns: ['double_top'], noise_levels: [0.01], trials: 2, walk_trials: 20 });
    const w = r.random_walk;
    // This is not an aspiration, it is a measurement of current behaviour.
    assert.ok(w.detections_per_walk > 10,
      `expected the known-bad rate; got ${w.detections_per_walk} per walk. If detection was tightened, update NOISE_BASELINE.`);
    assert.equal(w.any_pattern_rate_pct, 100);
  });

  it('NOISE_BASELINE matches the order of magnitude actually measured', () => {
    assert.ok(NOISE_BASELINE.detections_per_walk > 10);
    assert.ok(NOISE_BASELINE.per_walk.double_bottom > 3);
    assert.match(NOISE_BASELINE.note, /indistinguishable from noise/);
  });
});

describe('vsNoise', () => {
  it('calls a count below the noise floor exactly that', () => {
    const v = vsNoise('double_bottom', 2, 200);
    assert.equal(v.above_noise, false);
    assert.match(v.verdict, /PURE NOISE/);
    assert.match(v.verdict, /should not be read as a finding/);
  });

  it('scales the expectation with the number of bars', () => {
    const short = vsNoise('double_top', 3, 100);
    const long = vsNoise('double_top', 3, 400);
    assert.ok(long.expected_in_noise > short.expected_in_noise);
  });

  it('calls a count well above the floor clearly above it', () => {
    assert.match(vsNoise('head_and_shoulders', 12, 200).verdict, /clearly above the noise floor/);
  });

  it('returns null for a pattern with no baseline', () => {
    assert.equal(vsNoise('rectangle', 5, 200), null);
  });
});
