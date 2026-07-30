import { test, describe } from 'node:test';
import assert from 'node:assert';
import { planPatternDrawings } from '../src/core/patterns_draw.js';

/**
 * The regression this guards against, in the owner's words: "yesterday on this
 * ticker you drew a channel, on other tickers you drew wedges, triangles etc. It
 * seems you are not doing this anymore."
 *
 * It was true. `patterns_draw` shipped drawing ONE horizontal completion line per
 * pattern and no geometry — quietly dropping the wedge boundaries, flag poles and
 * head-and-shoulders that `drawPatternGeometry` had been rendering for months.
 * Selecting which patterns to draw and drawing them are different jobs; this
 * module does the first and must hand whole patterns to the second.
 */
const wedge = {
  pattern: 'rising_wedge', direction: 'bearish', status: 'confirmed',
  completion_level: 97.410044, target: 70.2,
  measurements: { resistance_now: 102.61, support_now: 97.41, touches_high: 3, touches_low: 4 },
};
const flag = {
  pattern: 'bull_flag', direction: 'bullish', status: 'forming',
  completion_level: 100.75, target: 115.24,
  measurements: { pole_pct: 17.32, pole_bars: 25, flag_bars: 12, retrace_pct: 45.9, flag_high: 100.75, flag_low: 91.51 },
};
/** The same shape read a second way — TIGO reported both, identical in every measurement. */
const pennant = {
  pattern: 'bullish_pennant', direction: 'bullish', status: 'forming',
  completion_level: 100.75, target: 115.24,
  measurements: { pole_pct: 17.32, pole_bars: 25, pennant_bars: 12, retrace_pct: 45.9, flag_high: 100.75, flag_low: 91.51 },
};

describe('it hands whole PATTERNS to the geometry drawer', () => {
  test('the output carries the pattern objects, not pre-baked lines', () => {
    const p = planPatternDrawings([wedge, flag]);
    assert.equal(p.patterns.length, 2);
    // measurements must survive — the geometry is reconstructed from them.
    assert.ok(p.patterns[0].measurements, 'measurements were stripped, so no shape can be drawn');
    assert.equal(p.patterns[0].measurements.support_now, 97.41);
    assert.equal(p.patterns[1].measurements.pole_bars, 25);
  });

  test('it says the geometry comes from drawPatternGeometry', () => {
    const p = planPatternDrawings([wedge]);
    assert.match(p.geometry_note, /triangle_pattern/);
    assert.match(p.geometry_note, /pole plus box for flags/);
    assert.match(p.geometry_note, /head and\s+shoulders/);
  });

  test('a pattern with measurements but no completion level is still drawable', () => {
    // Channels report boundaries and no break price — geometry is the whole point.
    const channel = { pattern: 'ascending_channel', direction: 'bullish', status: 'forming', measurements: { resistance_now: 50, support_now: 45 } };
    assert.equal(planPatternDrawings([channel]).patterns.length, 1);
  });

  test('a pattern with NEITHER is skipped with a reason', () => {
    const p = planPatternDrawings([{ pattern: 'broadening_formation', direction: 'bullish', status: 'forming' }]);
    assert.equal(p.patterns.length, 0);
    assert.match(p.skipped[0].why, /nothing to anchor a shape or a break level to/);
  });
});

describe('duplicate shapes are collapsed', () => {
  test('a flag and a pennant with identical geometry count ONCE', () => {
    /**
     * TIGO returned both with the same completion (100.75), target (115.24), pole
     * (17.32% over 25 bars) and retrace (45.9%). Drawing both put two labels on one
     * price and counted one setup as two.
     */
    const p = planPatternDrawings([flag, pennant]);
    assert.equal(p.patterns.length, 1);
    assert.equal(p.patterns[0].pattern, 'bull_flag', 'the first one seen is kept');
    const dupe = p.skipped.find((x) => x.pattern === 'bullish_pennant');
    assert.equal(dupe.duplicate_of, 'bull_flag');
    assert.match(dupe.why, /one setup, not two/);
  });

  test('patterns differing in direction or status are NOT collapsed', () => {
    const bear = { ...flag, pattern: 'bear_flag', direction: 'bearish' };
    assert.equal(planPatternDrawings([flag, bear]).patterns.length, 2);
    const confirmed = { ...flag, pattern: 'bull_flag_confirmed', status: 'confirmed' };
    assert.equal(planPatternDrawings([flag, confirmed]).patterns.length, 2);
  });

  test('the same pattern at a different level is NOT collapsed', () => {
    assert.equal(planPatternDrawings([flag, { ...pennant, completion_level: 104 }]).patterns.length, 2);
  });
});

describe('selection rules', () => {
  test('opposite-direction patterns are reported as the finding', () => {
    assert.match(planPatternDrawings([wedge, flag]).conflict, /not a problem\s+to resolve by picking one/);
  });

  test('forming patterns are never presented as signals', () => {
    const p = planPatternDrawings([wedge, flag]);
    assert.equal(p.counts.forming, 1);
    assert.equal(p.counts.confirmed, 1);
    assert.match(p.forming_note, /have not completed/);
  });

  test('forming_only drops confirmed ones with a reason', () => {
    const p = planPatternDrawings([wedge, flag], { forming_only: true });
    assert.deepEqual(p.patterns.map((x) => x.pattern), ['bull_flag']);
    assert.match(p.skipped[0].why, /forming_only/);
  });

  test('the cap is applied and the overflow named', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({
      pattern: 'rectangle', direction: 'bullish', status: 'forming',
      completion_level: 10 + i, measurements: { resistance_now: 11 + i, support_now: 9 + i },
    }));
    const p = planPatternDrawings(many, { max_patterns: 3 });
    assert.equal(p.patterns.length, 3);
    assert.match(p.skipped[0].why, /3-pattern cap/);
  });

  test('an empty list is a no-op', () => {
    const p = planPatternDrawings([]);
    assert.deepEqual(p.patterns, []);
    assert.equal(p.conflict, undefined);
  });
});
