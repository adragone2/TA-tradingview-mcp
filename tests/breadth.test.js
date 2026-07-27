import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  impliedIC, informationRatio, translateEdge, singleNameExpectation, PUBLISHED_EDGES,
} from '../src/core/breadth.js';
import { fiftyTwoWeekHigh } from '../src/core/momentum.js';
import { barsFromPath } from '../src/core/synthetic.js';

describe('the Fundamental Law', () => {
  test('IC and IR invert each other', () => {
    const ic = impliedIC(1.0, 100);
    assert.ok(Math.abs(informationRatio(ic, 100) - 1.0) < 1e-12);
  });

  test('IR = IC * sqrt(BR), exactly', () => {
    assert.ok(Math.abs(informationRatio(0.05, 400) - 1.0) < 1e-12);
  });

  test('rejects a breadth below 1', () => {
    assert.throws(() => impliedIC(1, 0), /at least 1/);
    assert.throws(() => informationRatio(0.1, 0.5), /at least 1/);
  });
});

describe('translateEdge — the division nobody wants to do', () => {
  test('an IR of 1.0 across 500 names is worth ~0.045 on one', () => {
    const t = translateEdge({ published_ir: 1.0, study_breadth: 500, your_positions: 1 });
    assert.ok(Math.abs(t.your_expected_ir - 0.0447) < 0.002, `got ${t.your_expected_ir}`);
    assert.ok(t.shrinkage_factor < 0.05);
  });

  test('shrinkage scales with the square root of the position ratio', () => {
    const one = translateEdge({ published_ir: 1.0, study_breadth: 100, your_positions: 1 });
    const twentyFive = translateEdge({ published_ir: 1.0, study_breadth: 100, your_positions: 25 });
    assert.ok(Math.abs(twentyFive.your_expected_ir / one.your_expected_ir - 5) < 1e-6,
      '25 positions should be 5x one position, not 25x');
  });

  test('matching the study breadth retains the published figure', () => {
    const t = translateEdge({ published_ir: 1.28, study_breadth: 58, your_positions: 58 });
    assert.ok(Math.abs(t.shrinkage_factor - 1) < 1e-9);
    assert.match(t.interpretation, /roughly applicable/);
  });

  test('says the published figure does NOT apply at low breadth', () => {
    const t = translateEdge({ published_ir: 1.28, study_breadth: 58, your_positions: 1 });
    assert.match(t.interpretation, /NOT applicable/);
  });

  test('reports how many years before the edge is distinguishable from luck', () => {
    const t = translateEdge({ published_ir: 1.0, study_breadth: 500, your_positions: 1 });
    assert.ok(t.years_to_significance > 100,
      `a 0.045 IR needs a very long record; got ${t.years_to_significance} years`);
  });

  test('accepts published_sharpe as an alias', () => {
    const a = translateEdge({ published_ir: 1.28, study_breadth: 58 });
    const b = translateEdge({ published_sharpe: 1.28, study_breadth: 58 });
    assert.strictEqual(a.your_expected_ir, b.your_expected_ir);
  });

  test('warns that correlated positions reduce effective breadth below the count', () => {
    const t = translateEdge({ published_ir: 1, study_breadth: 100, your_positions: 10 });
    assert.match(t.caveat, /INDEPENDENT bets/);
    assert.match(t.caveat, /optimistic/);
  });

  test('rejects missing or nonsensical inputs', () => {
    assert.throws(() => translateEdge({ study_breadth: 100 }), /published_ir or published_sharpe/);
    assert.throws(() => translateEdge({ published_ir: 1, study_breadth: 0 }), /study_breadth/);
    assert.throws(() => translateEdge({ published_ir: 1, study_breadth: 10, your_positions: 0 }), /your_positions/);
  });
});

describe('PUBLISHED_EDGES', () => {
  test('momentum records its 58-instrument breadth, not just its Sharpe', () => {
    const e = PUBLISHED_EDGES.time_series_momentum;
    assert.strictEqual(e.breadth, 58);
    assert.strictEqual(e.sharpe, 1.28);
    assert.strictEqual(e.benchmark_sharpe, 0.38);
  });

  test('PEAD carries the firm-level dissolution finding', () => {
    const w = PUBLISHED_EDGES.post_earnings_drift.firm_level_warning;
    assert.match(w, /does NOT persist/);
    assert.match(w, /16\.1% of quarters drifted\s+NEGATIVE/);
    assert.match(w, /28\.0% of quarters drifted\s+POSITIVE/);
  });

  test('the 52-week high records that its profits do not reverse', () => {
    assert.match(PUBLISHED_EDGES.fifty_two_week_high.note, /do NOT reverse/);
  });
});

describe('singleNameExpectation', () => {
  test('translates momentum to one position and shows the damage', () => {
    const s = singleNameExpectation('time_series_momentum');
    assert.ok(s.your_expected_ir < 0.2, `1.28 across 58 names is small on one: ${s.your_expected_ir}`);
    assert.match(s.interpretation, /NOT applicable/);
  });

  test('handles an edge with no published IR without inventing one', () => {
    const s = singleNameExpectation('fifty_two_week_high');
    assert.match(s.note, /No published information ratio/);
    assert.match(s.note, /measured across roughly/);
  });

  test('rejects an unknown edge and lists the known ones', () => {
    assert.throws(() => singleNameExpectation('magic_beans'), /Known: time_series_momentum/);
  });
});

describe('fiftyTwoWeekHigh — the ratio we were already computing', () => {
  const up = barsFromPath(Array.from({ length: 300 }, (_, i) => 100 * (1 + 0.003 * i)), { noise: 0.002, seed: 1 });

  test('a stock at its high scores near 1.0', () => {
    const f = fiftyTwoWeekHigh(up);
    assert.ok(f.ratio > 0.98, `got ${f.ratio}`);
    assert.ok(f.at_new_high);
  });

  test('ratio and off_high_pct are the same number stated two ways', () => {
    const f = fiftyTwoWeekHigh(up);
    assert.ok(Math.abs((1 - f.ratio) * 100 - f.off_high_pct) < 0.011);
  });

  test('a stock well below its high scores low and is not at a new high', () => {
    const down = barsFromPath(
      [...Array.from({ length: 150 }, (_, i) => 100 + i), ...Array.from({ length: 150 }, (_, i) => 250 - i * 0.8)],
      { noise: 0.002, seed: 2 });
    const f = fiftyTwoWeekHigh(down);
    assert.ok(f.ratio < 0.75, `got ${f.ratio}`);
    assert.strictEqual(f.at_new_high, false);
  });

  test('warns when there is not a full 52 weeks of history', () => {
    const f = fiftyTwoWeekHigh(up.slice(-100));
    assert.match(f.warning, /not a 52-week high/);
  });

  test('states the counter-intuition explicitly', () => {
    const f = fiftyTwoWeekHigh(up);
    assert.match(f.counter_intuition, /PREDICTS CONTINUATION/);
  });

  test('refuses to assign a percentile it cannot know', () => {
    const f = fiftyTwoWeekHigh(up);
    assert.strictEqual(f.percentile, undefined);
    assert.match(f.breadth_caveat, /deliberately does NOT assign a percentile/);
  });

  test('short input is reported, not crashed on', () => {
    assert.strictEqual(fiftyTwoWeekHigh([]).available, false);
  });
});
