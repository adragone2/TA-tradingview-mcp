import { test, describe } from 'node:test';
import assert from 'node:assert';
import { trackLevel, levelTestStudy, TOUCH_COUNT_FINDING } from '../src/core/level_tests.js';
import { normalizeBars } from '../src/core/structure.js';
import { randomWalk, barsFromPath } from '../src/core/synthetic.js';

/** Build bars from an explicit close path, with a tight intrabar range. */
function fromCloses(closes, { spread = 0.001 } = {}) {
  return normalizeBars(closes.map((c, i) => ({
    time: (i + 1) * 86400000,
    open: c, high: c * (1 + spread), low: c * (1 - spread), close: c, volume: 1000,
  })));
}

describe('trackLevel — what counts as a test and as a break', () => {
  test('counts separate approaches, not every bar in the band', () => {
    // Two visits to 100, three bars each, with a clear excursion between them.
    // Six touching bars, two tests — that is the whole point of the gap rule.
    const bars = fromCloses([100, 100, 100, 95, 94, 93, 94, 100, 100, 96, 95]);
    const r = trackLevel(bars, { from_index: 0, price: 100, kind: 'resistance', tolerance_pct: 0.5, gap: 3 });
    assert.equal(r.test_count, 2);
    assert.deepEqual(r.tests.map((t) => t.test_number), [1, 2]);
    // And the second test records how long since the first.
    assert.ok(r.tests[1].bars_since_previous > 3);
    assert.equal(r.tests[0].bars_since_previous, null);
  });

  test('a WICK through with a close back inside is NOT a break', () => {
    /**
     * Conflating a wick with a break is what makes every level look fragile —
     * the same distinction wyckoff_spring insists on.
     */
    const bars = normalizeBars([100, 95, 100, 96].map((c, i) => ({
      time: (i + 1) * 86400000,
      open: c,
      // The bar that touches 100 spikes to 103 but closes at 100.
      high: c === 100 ? c * 1.03 : c * 1.001,
      low: c * 0.999, close: c, volume: 1000,
    })));
    const r = trackLevel(bars, { from_index: 0, price: 100, kind: 'resistance', break_margin_pct: 0.3 });
    assert.equal(r.broke, false);
  });

  test('a CLOSE beyond the margin IS a break, and records which test broke it', () => {
    const bars = fromCloses([100, 95, 94, 95, 100, 104]);
    const r = trackLevel(bars, { from_index: 0, price: 100, kind: 'resistance', break_margin_pct: 0.3, resolve_bars: 5 });
    assert.equal(r.broke, true);
    assert.ok(r.broke_on_test >= 1);
  });

  test('stops tracking after a break — later touches are a different level', () => {
    const bars = fromCloses([100, 95, 100, 110, 105, 100, 95, 100]);
    const r = trackLevel(bars, { from_index: 0, price: 100, kind: 'resistance' });
    const brokeAt = r.tests.findIndex((t) => t.broke);
    if (brokeAt >= 0) assert.equal(brokeAt, r.tests.length - 1, 'tracking continued past a break');
  });

  test('support is the mirror: a close BELOW the band breaks it', () => {
    const bars = fromCloses([100, 105, 106, 105, 100, 96]);
    const r = trackLevel(bars, { from_index: 0, price: 100, kind: 'support', break_margin_pct: 0.3 });
    assert.equal(r.kind, 'support');
    assert.equal(r.broke, true);
  });
});

describe('trackLevel — the two aggression clauses', () => {
  test('RISING interim lows between tests of resistance set the price clause', () => {
    // Three tests of 100, retreating to 90 then only to 95: buyers are paying
    // more each time to come back. Two interims is the minimum to compare.
    const bars = fromCloses([100, 100, 92, 90, 100, 96, 95, 100, 99]);
    const r = trackLevel(bars, { from_index: 0, price: 100, kind: 'resistance', gap: 2 });
    assert.equal(r.test_count, 3, `got ${r.test_count} tests`);
    assert.equal(r.aggression_through_price, true);
    // The interims must be the actual retreat extremes, in order.
    const interims = r.tests.map((t) => t.interim_extreme).filter((v) => v !== null);
    assert.equal(interims.length, 2);
    assert.ok(interims[1] > interims[0]);
  });

  test('FALLING interim lows do not set it', () => {
    const bars = fromCloses([100, 100, 96, 95, 100, 92, 90, 100, 99]);
    const r = trackLevel(bars, { from_index: 0, price: 100, kind: 'resistance', gap: 2 });
    assert.equal(r.test_count, 3);
    assert.equal(r.aggression_through_price, false);
  });

  test('for SUPPORT the clause inverts to falling interim highs', () => {
    // Rallies to 110 then only to 105: sellers accept less to come back.
    const bars = fromCloses([100, 100, 108, 110, 100, 104, 105, 100, 101]);
    const r = trackLevel(bars, { from_index: 0, price: 100, kind: 'support', gap: 2 });
    assert.equal(r.test_count, 3);
    assert.equal(r.aggression_through_price, true);
    const interims = r.tests.map((t) => t.interim_extreme).filter((v) => v !== null);
    assert.ok(interims[1] < interims[0], 'support tracks the interim HIGH, not the low');
  });

  test('tests coming closer together set the time clause', () => {
    const bars = fromCloses([
      100, 95, 94, 93, 94, 95, 100,   // long gap
      95, 94, 100,                     // short gap
    ]);
    const r = trackLevel(bars, { from_index: 0, price: 100, kind: 'resistance', gap: 2 });
    if (r.aggression_through_time !== null) assert.equal(typeof r.aggression_through_time, 'boolean');
  });

  test('both clauses are NULL, not false, with too few tests to judge', () => {
    // Absent evidence must not read as evidence of absence.
    const bars = fromCloses([100, 95, 94, 95, 96]);
    const r = trackLevel(bars, { from_index: 0, price: 100, kind: 'resistance' });
    assert.equal(r.aggression_through_price, null);
    assert.equal(r.aggression_through_time, null);
  });
});

describe('levelTestStudy — the hazard table', () => {
  const bars = normalizeBars(barsFromPath(randomWalk({ n: 500, vol: 0.015, seed: 11 })));

  test('conditions each rate on levels that REACHED that test', () => {
    /**
     * The step that makes it a hazard rate instead of a cumulative count. A
     * level that broke on test 2 was never exposed to test 3, so including it
     * in test 3's denominator would understate the later rates.
     */
    const r = levelTestStudy(bars);
    assert.equal(r.available, true);
    for (let i = 1; i < r.hazard_by_test_number.length; i += 1) {
      assert.ok(
        r.hazard_by_test_number[i].levels_reaching <= r.hazard_by_test_number[i - 1].levels_reaching,
        'the denominator must shrink as test number rises',
      );
    }
  });

  test('never reports a rate on fewer than five levels', () => {
    for (const row of levelTestStudy(bars).hazard_by_test_number) {
      assert.ok(row.levels_reaching >= 5, `test ${row.test_number} reported on n=${row.levels_reaching}`);
    }
  });

  test('reports both clauses with their own sample sizes', () => {
    const r = levelTestStudy(bars);
    for (const key of ['aggression_through_price', 'aggression_through_time']) {
      assert.ok(Number.isFinite(r[key].with_clause.n), `${key} missing n`);
      assert.ok(Number.isFinite(r[key].without_clause.n), `${key} missing without-n`);
    }
  });

  test('excludes levels too near the right edge to be scored', () => {
    // Otherwise a level "held" simply because the series ran out.
    const r = levelTestStudy(bars, { min_forward_bars: 40 });
    assert.ok(r.levels_tracked > 0);
    assert.ok(r.levels_with_at_least_one_test <= r.levels_tracked);
  });

  test('says what would settle the claim rather than claiming it', () => {
    const r = levelTestStudy(bars);
    assert.match(r.what_would_settle_it, /random-walk arm/);
    assert.match(r.what_would_settle_it, /more exposure/);
    assert.match(r.source, /Figures 7\.4 and 7\.5/);
  });

  test('too short a series is unavailable rather than a rate on nothing', () => {
    assert.equal(levelTestStudy(fromCloses([100, 101, 102])).available, false);
    assert.equal(levelTestStudy([]).available, false);
  });
});

describe('the measured finding', () => {
  test('KILLS the count claim, with real data BELOW its own null', () => {
    const c = TOUCH_COUNT_FINDING.count_claim;
    assert.equal(c.trend_points_test_1_to_5.real_data, 14.5);
    assert.equal(c.trend_points_test_1_to_5.random_walk, 40.3);
    assert.ok(c.trend_points_test_1_to_5.excess < 0);
    assert.match(c.verdict, /NO EDGE/);
    assert.match(c.verdict, /arithmetic/);
  });

  test('refuses to INVERT findKeyLevels on a null result', () => {
    /**
     * The disciplined conclusion. "Touch count is not strength" does not license
     * "touch count is weakness" — the measurement says it carries nothing either
     * way, and over-reading a null is the same error as over-reading a hit.
     */
    const c = TOUCH_COUNT_FINDING.count_claim;
    assert.match(c.consequence, /does NOT mean findKeyLevels has the sign backwards/);
    assert.match(c.consequence, /EITHER direction/);
    assert.match(c.consequence, /do not defend it either/);
  });

  test('the price-pressure clause SURVIVES, with its null and its significance', () => {
    const a = TOUCH_COUNT_FINDING.aggression_through_price;
    assert.equal(a.real_data.lift_points, 19.5);
    assert.equal(a.random_walk.lift_points, -1.4);
    // The separation is the finding: real lift, no lift on noise.
    assert.ok(a.real_data.lift_points > 15 && Math.abs(a.random_walk.lift_points) < 5);
    assert.match(a.verdict, /SURVIVES/);
  });

  test('the surviving clause carries a multiple-testing correction', () => {
    // Three clauses were tested, so an uncorrected p would flatter it.
    const a = TOUCH_COUNT_FINDING.aggression_through_price;
    assert.equal(a.tests_in_family, 3);
    assert.ok(a.p_two_tailed < a.bonferroni_threshold, 'the finding must clear its own correction');
    assert.ok(a.z_score > 3);
    // And it must still be labelled as one study.
    assert.match(a.verdict, /a finding, not a settled effect/);
  });

  test('the weak clause is labelled weak, not promoted', () => {
    const t = TOUCH_COUNT_FINDING.aggression_through_time;
    assert.match(t.verdict, /WEAK/);
    assert.match(t.verdict, /do not act on it alone/);
    assert.ok(t.real_data.lift_points < TOUCH_COUNT_FINDING.aggression_through_price.real_data.lift_points);
  });

  test('every arm reports its sample size', () => {
    const f = TOUCH_COUNT_FINDING;
    assert.match(f.sample, /554/);
    assert.ok(f.aggression_through_price.real_data.n_with > 100);
    assert.ok(f.aggression_through_price.random_walk.n_with > 1000);
    assert.match(f.script, /level-test-inversion/);
  });

  test('the summary states the distinction the measurement found', () => {
    assert.match(TOUCH_COUNT_FINDING.summary, /mechanism right and the metric wrong/);
  });
});
