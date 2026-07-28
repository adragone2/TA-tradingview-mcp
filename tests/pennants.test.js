import { test, describe } from 'node:test';
import assert from 'node:assert';
import { detectPatterns, STRUCTURAL_PATTERNS, NOISE_BASELINE, trendBefore } from '../src/core/patterns.js';
import { GENERATORS, barsFromPath, randomWalk } from '../src/core/synthetic.js';

const names = (bars) => (detectPatterns(bars).structural || []).map((p) => p.pattern);
const find = (bars, name) => (detectPatterns(bars).structural || []).find((p) => p.pattern === name);

/**
 * The constructed truth for a pennant, from the synthetic generators.
 *
 * GENERATORS already return a PRICE PATH — they call legs() internally — so
 * wrapping them in legs() again produces a path of paths and detects nothing.
 */
const truth = (kind, { noise = 0.002, seed = 5 } = {}) =>
  barsFromPath(GENERATORS[kind]({}), { noise, seed });

/**
 * randomWalk returns a PRICE PATH, not bars. Feeding it straight to a detector
 * that reads .high/.low rejects everything and reports a 0% noise rate that
 * means nothing.
 */
const walkBars = (seed, n = 200) =>
  barsFromPath(randomWalk({ n, vol: 0.015, seed }), { noise: 0.006, seed: seed + 1 });

describe('pennants — detected on constructed truth', () => {
  test('a bullish pennant is found', () => {
    assert.ok(names(truth('bullish_pennant')).includes('bullish_pennant'));
  });

  test('a bearish pennant is found', () => {
    assert.ok(names(truth('bearish_pennant')).includes('bearish_pennant'));
  });

  test('found across a range of noise levels, not just the clean case', () => {
    for (const noise of [0, 0.002, 0.005]) {
      assert.ok(
        names(truth('bullish_pennant', { noise })).includes('bullish_pennant'),
        `missed at noise ${noise}`,
      );
    }
  });

  test('the direction is not inverted', () => {
    assert.equal(find(truth('bullish_pennant'), 'bullish_pennant').direction, 'bullish');
    assert.equal(find(truth('bearish_pennant'), 'bearish_pennant').direction, 'bearish');
  });

  test('registered as a continuation pattern, not a reversal', () => {
    assert.equal(find(truth('bullish_pennant'), 'bullish_pennant').type, 'continuation');
  });

  test('both pennants are in STRUCTURAL_PATTERNS', () => {
    assert.ok(STRUCTURAL_PATTERNS.includes('bullish_pennant'));
    assert.ok(STRUCTURAL_PATTERNS.includes('bearish_pennant'));
  });
});

describe('pennants — the pause CONVERGES, which is what a flag does not', () => {
  test('the second half of the pause is narrower than the first', () => {
    const m = find(truth('bullish_pennant'), 'bullish_pennant').measurements;
    assert.ok(m.range_second_half < m.range_first_half,
      `second half ${m.range_second_half} was not narrower than ${m.range_first_half}`);
  });

  test('convergence is reported and sits below the 0.7 threshold', () => {
    const m = find(truth('bullish_pennant'), 'bullish_pennant').measurements;
    assert.ok(m.convergence <= 0.7, `convergence ${m.convergence}`);
  });

  test('a PARALLEL pause is a flag, and is not reported as a pennant', () => {
    // The bull_flag generator gives a pole plus a parallel drift. If the
    // convergence test were absent, this would come back as a pennant too —
    // which is exactly the bug the test exists to catch.
    const flagBars = truth('bull_flag');
    const found = names(flagBars);
    assert.ok(found.includes('bull_flag'), 'the flag itself was not detected');
    assert.ok(!found.includes('bullish_pennant'),
      'a parallel-pause flag was misreported as a pennant');
  });

  test('a pennant carries a POLE, which is what separates it from a triangle', () => {
    const m = find(truth('bullish_pennant'), 'bullish_pennant').measurements;
    assert.ok(Math.abs(m.pole_pct) >= 15, `pole only ${m.pole_pct}%`);
    assert.ok(m.pole_bars >= 5);
  });
});

describe('pennants — measurements and levels', () => {
  const pat = () => find(truth('bullish_pennant'), 'bullish_pennant');

  test('the pause bounds bracket the completion level', () => {
    const p = pat();
    const m = p.measurements;
    assert.ok(m.flag_high >= m.flag_low);
    assert.equal(p.completion_level, m.flag_high);   // bullish breaks the high
  });

  test('a bearish pennant completes on the pause LOW', () => {
    const p = find(truth('bearish_pennant'), 'bearish_pennant');
    assert.equal(p.completion_level, p.measurements.flag_low);
  });

  test('the target is the pole projected from the breakout', () => {
    const p = pat();
    assert.ok(p.target > p.completion_level, 'a bullish target sat below its breakout');
    assert.match(p.target_basis, /pole/);
  });

  test('the retrace is bounded — a deep pullback is not a pennant', () => {
    const m = pat().measurements;
    assert.ok(m.retrace_pct >= 0 && m.retrace_pct <= 50, `retrace ${m.retrace_pct}%`);
  });

  test('status is forming or confirmed, never anything else', () => {
    for (const kind of ['bullish_pennant', 'bearish_pennant']) {
      assert.ok(['forming', 'confirmed'].includes(find(truth(kind), kind).status));
    }
  });
});

describe('pennants — the base rate is honest about not existing', () => {
  test('the pattern says outright that no pennant-specific statistics exist', () => {
    const p = find(truth('bullish_pennant'), 'bullish_pennant');
    assert.match(p.base_rate_warning, /No pennant-specific measured statistics/);
  });

  test('the flag proxy it borrows is quoted with its failure rate', () => {
    const p = find(truth('bullish_pennant'), 'bullish_pennant');
    assert.match(p.note, /44%/);
  });
});

describe('pennants — the noise floor', () => {
  test('never fires on a random walk', () => {
    let hits = 0;
    const N = 120;
    for (let s = 0; s < N; s++) {
      if (names(walkBars(6000 + s)).some((x) => x.endsWith('_pennant'))) hits++;
    }
    // Measured at 0 over 200 walks — tied with VCP as the most selective
    // detector here. Any regression away from that is worth knowing about.
    assert.equal(hits, 0, `pennants fired on ${hits}/${N} random walks`);
  });

  test('the recorded baseline says zero, and the truth rate says 100', () => {
    assert.equal(NOISE_BASELINE.pennants_per_walk, 0);
    assert.equal(NOISE_BASELINE.pennant_detection_on_truth_pct, 100);
  });
});

describe('pennants — degenerate input', () => {
  test('too few bars returns no pennant rather than throwing', () => {
    const short = barsFromPath([100, 101, 102, 103, 104], { seed: 1 });
    assert.doesNotThrow(() => detectPatterns(short));
    assert.ok(!names(short).some((x) => x.endsWith('_pennant')));
  });

  test('a flat series produces no pennant — there is no pole', () => {
    const flat = barsFromPath(Array(60).fill(100), { noise: 0.001, seed: 2 });
    assert.ok(!names(flat).some((x) => x.endsWith('_pennant')));
  });
});

describe('rectangles are typed by the trend they interrupt', () => {
  const rectNames = (kind) => names(truth(kind)).filter((n) => n.includes('rectangle'));

  test('a range entered from an uptrend is a bullish rectangle', () => {
    assert.ok(rectNames('bullish_rectangle').includes('bullish_rectangle'));
  });

  test('a range entered from a downtrend is a bearish rectangle', () => {
    assert.ok(rectNames('bearish_rectangle').includes('bearish_rectangle'));
  });

  test('a range with no trend into it stays untyped', () => {
    // The important negative. Typing every rectangle would manufacture a
    // continuation bet out of a drift, and "no clear trend" is a real answer.
    const found = rectNames('rectangle');
    assert.ok(found.includes('rectangle'), 'the plain rectangle was not detected');
    assert.ok(!found.includes('bullish_rectangle') && !found.includes('bearish_rectangle'),
      `an untrended range was typed: ${found.join(', ')}`);
  });

  test('a typed rectangle is a continuation, an untyped one is uncertain', () => {
    assert.equal(find(truth('bullish_rectangle'), 'bullish_rectangle').type, 'continuation');
    assert.equal(find(truth('rectangle'), 'rectangle').type, 'uncertain');
  });

  test('all three are registered as structural patterns', () => {
    for (const r of ['rectangle', 'bullish_rectangle', 'bearish_rectangle']) {
      assert.ok(STRUCTURAL_PATTERNS.includes(r), `${r} is not in STRUCTURAL_PATTERNS`);
    }
  });

  test('the note says the other break is still open', () => {
    const p = find(truth('bullish_rectangle'), 'bullish_rectangle');
    assert.match(p.note, /not planned away|still open/);
  });
});

describe('trendBefore — the blunt instrument behind rectangle typing', () => {
  const rise = barsFromPath(Array.from({ length: 60 }, (_, i) => 100 + i), { noise: 0.001, seed: 3 });
  const fall = barsFromPath(Array.from({ length: 60 }, (_, i) => 160 - i), { noise: 0.001, seed: 3 });
  const flat = barsFromPath(Array.from({ length: 60 }, () => 100), { noise: 0.001, seed: 3 });

  test('reads a rise as up and a fall as down', () => {
    assert.equal(trendBefore(rise, 50), 'up');
    assert.equal(trendBefore(fall, 50), 'down');
  });

  test('a flat run has no trend', () => {
    assert.equal(trendBefore(flat, 50), null);
  });

  test('a move below the threshold does not count', () => {
    const drift = barsFromPath(Array.from({ length: 60 }, (_, i) => 100 + i * 0.02), { noise: 0.001, seed: 3 });
    assert.equal(trendBefore(drift, 50), null);   // ~1% over 50 bars
  });

  test('too few bars before the pattern returns null rather than guessing', () => {
    assert.equal(trendBefore(rise, 5), null);
    assert.equal(trendBefore(rise, 0), null);
  });

  test('degenerate input returns null rather than throwing', () => {
    assert.equal(trendBefore(null, 50), null);
    assert.equal(trendBefore([], 50), null);
  });
});
