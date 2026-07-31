/**
 * The cup with handle — clause by clause, against constructed truth.
 *
 * Ground truth comes from CONSTRUCTION: the bars are built to contain (or to
 * deliberately break) the shape, and nothing about the detector was consulted in
 * building them. The negative fixtures are the point — a detector that finds a
 * cup is easy, one that names WHICH clause a near miss failed is what makes a
 * rejection diagnosable.
 *
 * Run: node --test tests/cup.test.js
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';

import {
  detectCup, cupPatterns, CUP_DEFAULTS, CUP_CITATIONS, CUP_BASE_RATES,
  CUP_NOISE_BASELINE, CUP_LOOKBACK_OFFSET, U_SHAPE_ARITHMETIC, CUP_SECOND_SOURCE,
} from '../src/core/cup.js';
import {
  detectPatterns, STRUCTURAL_PATTERNS, STRUCTURAL_STATS, NOISE_BASELINE, statsFor,
} from '../src/core/patterns.js';
import { assess } from '../src/core/assessment.js';
import { barsFromPath, legs, randomWalk } from '../src/core/synthetic.js';
import { normalizeBars } from '../src/core/structure.js';
import { MCP_TEXT_SIGNATURES } from '../src/core/orphans.js';

/**
 * A textbook cup: a rise into the left rim, a PARABOLIC turn (the U), a recovery
 * to the same price, then a shallow handle in the upper half.
 *
 * The cup is a parabola on purpose — U_SHAPE_ARITHMETIC predicts a parabola
 * spends 50% of its bars in the bottom quarter and a straight-sided V spends 25%,
 * and `vBottomPath` below is the same fixture with the parabola swapped for two
 * straight legs so the prediction can be checked against both.
 */
function cupPath({
  rimLeft = 100, rimRight = 100, depth = 25, cupBars = 70,
  handleBars = 14, handleFrac = 0.28, run = 25, start = 76, tail = 0,
} = {}) {
  const out = [];
  for (let i = 0; i < run; i++) out.push(start + ((rimLeft - start) * i) / run);
  const low = Math.max(rimLeft, rimRight) - depth;
  for (let t = 0; t <= cupBars; t++) {
    const u = (2 * t) / cupBars - 1;
    const side = u <= 0 ? rimLeft : rimRight;
    out.push(low + (side - low) * u * u);
  }
  if (handleBars > 0) {
    const hLow = rimRight - depth * handleFrac;
    const half = Math.max(2, Math.floor(handleBars / 2));
    out.push(...legs([rimRight, hLow], half));
    out.push(...legs([hLow, rimRight * 0.995], Math.max(1, handleBars - half)));
  }
  if (tail > 0) out.push(...legs([rimRight * 0.995, rimRight * 1.2], tail));
  return out;
}

/** The same shape with a SPIKE bottom instead of a rounded one. */
function vBottomPath({ rim = 100, depth = 25, leg = 35, handleBars = 14, handleFrac = 0.28 } = {}) {
  const hLow = rim - depth * handleFrac;
  const half = Math.floor(handleBars / 2);
  return [
    ...legs([76, rim], 25),
    ...legs([rim, rim - depth], leg),
    ...legs([rim - depth, rim], leg),
    ...legs([rim, hLow], half),
    ...legs([hLow, rim * 0.995], handleBars - half),
  ];
}

const build = (path, { noise = 0.005, seed = 11 } = {}) => barsFromPath(path, { noise, seed });

describe('detectCup — a textbook cup', () => {
  test('qualifies at every realistic noise level', () => {
    for (const noise of [0, 0.01, 0.02]) {
      const r = detectCup(build(cupPath(), { noise }));
      assert.equal(r.qualifies, true,
        `noise ${noise}: failed ${(r.failed_checks || []).join(', ') || r.reason}`);
      assert.equal(r.status, 'forming', 'price has not closed above the right lip yet');
    }
  });

  test('every clause carries a pass, a value and what was required', () => {
    const r = detectCup(build(cupPath()));
    const expected = [
      'duration_in_range', 'rims_near_same_price', 'u_shaped_not_v',
      'cup_contains_no_higher_high', 'cup_depth_in_range',
      'handle_present', 'handle_in_upper_half', 'handle_is_a_pullback',
    ];
    assert.deepEqual(Object.keys(r.checks), expected, 'the clause set is a contract');
    for (const [k, c] of Object.entries(r.checks)) {
      assert.equal(typeof c.pass, 'boolean', `${k}.pass`);
      assert.ok(c.value !== undefined && c.value !== null, `${k}.value is missing`);
      assert.ok(c.required && String(c.required).length > 3, `${k}.required is missing`);
    }
  });

  test('reports the rims, the bottom, the handle and the midpoint as numbers', () => {
    const m = detectCup(build(cupPath())).measurements;
    for (const k of ['left_rim', 'right_rim', 'cup_low', 'depth', 'depth_pct', 'cup_bars',
      'handle_bars', 'handle_low', 'handle_retrace_pct_of_cup', 'cup_midpoint', 'base_time_pct']) {
      assert.ok(Number.isFinite(m[k]), `${k} is not a number: ${m[k]}`);
    }
    assert.ok(m.handle_low > m.cup_midpoint, 'the handle must sit above the cup midpoint');
    assert.ok(m.cup_low < Math.min(m.left_rim, m.right_rim), 'the bottom must be below both rims');
  });

  test('completes on a CLOSE above the right cup lip, not on a touch', () => {
    const forming = detectCup(build(cupPath()));
    assert.equal(forming.status, 'forming');
    assert.equal(forming.completion_level, forming.measurements.right_rim,
      "Bulkowski's breakout price A is the right cup lip");

    // Same cup, then a run beyond the lip.
    const broken = detectCup(build(cupPath({ tail: 12 }), { seed: 4 }));
    assert.equal(broken.qualifies, true, (broken.failed_checks || []).join(', '));
    assert.equal(broken.status, 'confirmed');
  });

  test('the handle window is right lip -> breakout, which is Bulkowskis own definition', () => {
    const r = detectCup(build(cupPath({ tail: 12 }), { seed: 4 }));
    // The handle ends AT the breakout, so it cannot run to the end of the series.
    assert.ok(r.measurements.handle_bars < 26,
      `handle ran to ${r.measurements.handle_bars} bars — it should stop at the breakout`);
    assert.match(CUP_CITATIONS.handle_duration_and_position.handle_window,
      /distance from the right cup lip to the breakout/);
  });
});

describe('detectCup — the three targets, which are three different claims', () => {
  const r = detectCup(build(cupPath()));

  test('target is the full cup height projected from the right lip', () => {
    const m = r.measurements;
    assert.ok(Math.abs(r.target - (m.right_rim + m.depth)) < 0.01,
      `target ${r.target} is not right_rim ${m.right_rim} + depth ${m.depth}`);
  });

  test("Bulkowski's site rule discounts the height by the meeting-target rate", () => {
    const m = r.measurements;
    const want = m.right_rim + m.depth * (CUP_BASE_RATES.meeting_target_pct / 100);
    assert.ok(Math.abs(r.target_bulkowski_measure_rule - want) < 0.01);
    assert.ok(r.target_bulkowski_measure_rule < r.target, 'the discounted target must be nearer');
  });

  test("his book's half-height target is nearer still, and carries the better hit rate", () => {
    assert.ok(r.target_half_height < r.target_bulkowski_measure_rule);
    const hits = CUP_BASE_RATES.measure_rule_hit_rates;
    assert.equal(hits.full_height_reached_pct.bull, 50);
    assert.equal(hits.half_height_reached_pct.bull, 76);
    assert.match(hits.authors_own_verdict, /shy of the 80% number/);
  });

  test('the 54% average rise is stated NOT to be a target', () => {
    assert.match(r.target_note, /average rise/);
    assert.match(r.target_note, /ultimate high/);
    assert.match(CUP_BASE_RATES.average_rise_is_not_a_target, /never be used as one/);
  });
});

describe('detectCup — a near miss names the clause that failed', () => {
  test('a V-bottom fails u_shaped_not_v and NOTHING else', () => {
    const r = detectCup(build(vBottomPath(), { seed: 3 }));
    assert.equal(r.qualifies, false);
    assert.deepEqual(r.failed_checks, ['u_shaped_not_v'],
      'the V fixture differs from the cup ONLY in the shape of its bottom');
    assert.equal(r.checks.rims_near_same_price.pass, true);
    assert.equal(r.checks.handle_in_upper_half.pass, true);
  });

  test('the U/V clause behaves as U_SHAPE_ARITHMETIC predicts on both shapes', () => {
    // The whole justification for the 35% threshold, checked rather than asserted.
    const u = detectCup(build(cupPath())).measurements.base_time_pct;
    const v = detectCup(build(vBottomPath(), { seed: 3 })).measurements.base_time_pct;
    assert.ok(Math.abs(u - U_SHAPE_ARITHMETIC.u_bottom_expected_pct) < 8,
      `parabola scored ${u}%, predicted ~${U_SHAPE_ARITHMETIC.u_bottom_expected_pct}%`);
    assert.ok(Math.abs(v - U_SHAPE_ARITHMETIC.v_bottom_expected_pct) < 8,
      `V scored ${v}%, predicted ~${U_SHAPE_ARITHMETIC.v_bottom_expected_pct}%`);
    assert.ok(v < U_SHAPE_ARITHMETIC.threshold_pct && u > U_SHAPE_ARITHMETIC.threshold_pct,
      'the threshold must sit BETWEEN the two shapes it separates');
  });

  test('a handle below the cup midpoint fails handle_in_upper_half', () => {
    const r = detectCup(build(cupPath({ handleFrac: 0.72 }), { seed: 5 }));
    assert.equal(r.qualifies, false);
    assert.ok(r.failed_checks.includes('handle_in_upper_half'));
    assert.ok(r.measurements.handle_low < r.measurements.cup_midpoint,
      'the fixture must actually drop below the midpoint');
    assert.match(r.checks.handle_in_upper_half.required, /UPPER HALF/);
  });

  test('a handle that is no pullback at all fails handle_is_a_pullback', () => {
    const r = detectCup(build(cupPath({ handleFrac: 0.01 }), { seed: 21 }));
    assert.equal(r.qualifies, false);
    assert.ok(r.failed_checks.includes('handle_is_a_pullback'),
      `failed ${r.failed_checks.join(', ')} — expected handle_is_a_pullback`);
  });

  test('mismatched rims fail rims_near_same_price', () => {
    const r = detectCup(build(cupPath({ rimRight: 84 }), { seed: 7 }));
    assert.equal(r.qualifies, false);
    assert.ok(r.failed_checks.includes('rims_near_same_price'));
    assert.ok(r.measurements.rim_difference_pct > CUP_DEFAULTS.rim_tolerance_pct);
  });

  test('a cup shorter than 7 weeks fails duration_in_range BY NAME', () => {
    /**
     * The clause has to be reachable, not merely present. If the duration bound
     * were a candidate pre-filter a short cup would come back as the useless
     * "no_candidate_pair" and `duration_in_range` would report `pass` on every
     * result it ever appeared in — a clause that cannot fail.
     */
    const r = detectCup(build(cupPath({ cupBars: 24, depth: 20 }), { seed: 9 }));
    assert.equal(r.qualifies, false);
    assert.ok(r.failed_checks?.includes('duration_in_range'),
      `expected duration_in_range; got ${r.failed_checks?.join(', ') ?? r.reason}`);
    assert.ok(r.measurements.cup_bars < CUP_DEFAULTS.min_cup_bars);
  });

  test('a cup longer than 65 weeks fails duration_in_range BY NAME', () => {
    const r = detectCup(build(cupPath({ cupBars: 360, depth: 30 }), { seed: 17 }));
    assert.equal(r.qualifies, false);
    assert.ok(r.failed_checks?.includes('duration_in_range'),
      `expected duration_in_range; got ${r.failed_checks?.join(', ') ?? r.reason}`);
    assert.ok(r.measurements.cup_bars > CUP_DEFAULTS.max_cup_bars);
  });

  test('the handle_present clause rejects a handle shorter than a week', () => {
    // Bulkowski's floor is "1 week minimum", which is 5 daily bars. Raising the
    // floor above the fixture's 14-bar handle exercises the clause directly.
    const r = detectCup(build(cupPath()), { min_handle_bars: 20 });
    assert.equal(r.qualifies, false);
    assert.deepEqual(r.failed_checks, ['handle_present']);
    assert.equal(CUP_DEFAULTS.min_handle_bars, 5, "1 week at 5 trading days — his own conversion");
  });

  test('a rounding bottom with NO handle is not a cup, and the refusal says why', () => {
    /**
     * Bulkowski: "A cup without a handle is a rounding bottom."
     *
     * The refusal comes back as `too_few_pivot_highs` rather than as a failing
     * clause, and that is correct rather than a gap: if price recovers to the rim
     * and keeps going, there is no turn at the right lip, so the sparse pivot
     * finder never produces a second rim and there is no SHAPE to score. A named
     * clause failure would require inventing the rim first.
     */
    const r = detectCup(build(cupPath({ handleBars: 0, tail: 30 }), { seed: 23 }));
    assert.equal(r.qualifies, false);
    assert.equal(r.status, null);
    assert.ok(['too_few_pivot_highs', 'no_candidate_pair'].includes(r.reason), r.reason);
    assert.match(r.note, /rims|shape to score/);
    assert.match(CUP_CITATIONS.handle_required.second_source, /rounding bottom/);
  });

  test('a flat drift is not a cup — cup_depth_in_range rejects it', () => {
    const r = detectCup(build(cupPath({ depth: 3 }), { seed: 29, noise: 0.002 }));
    assert.equal(r.qualifies, false);
    assert.ok((r.failed_checks || []).includes('cup_depth_in_range')
      || r.reason === 'no_candidate_pair',
    `expected cup_depth_in_range; got ${r.failed_checks?.join(', ') ?? r.reason}`);
  });
});

describe('detectCup — degenerate input never throws and never invents', () => {
  for (const [label, input] of [
    ['null', null], ['undefined', undefined], ['empty', []], ['a string', 'nope'],
    ['three empty objects', [{}, {}, {}]],
    ['bars with null prices', Array.from({ length: 80 }, (_, i) => ({ time: i, open: null, high: null, low: null, close: null, volume: null }))],
    ['bars with NaN', Array.from({ length: 80 }, (_, i) => ({ time: i, open: NaN, high: NaN, low: NaN, close: NaN }))],
  ]) {
    test(`${label} returns a refusal with a reason`, () => {
      const r = detectCup(input);
      assert.equal(r.qualifies, false);
      assert.equal(r.pattern, 'cup_with_handle');
      assert.ok(r.reason, 'a refusal must say why');
      assert.equal(r.status, null, 'no status without a qualifying shape');
      assert.equal(cupPatterns(input).length, 0);
    });
  }

  test('a monotonic series has no rims and says so rather than inventing one', () => {
    const bars = build(legs([10, 200], 120), { noise: 0 });
    const r = detectCup(bars);
    assert.equal(r.qualifies, false);
    assert.ok(['too_few_pivot_highs', 'no_candidate_pair'].includes(r.reason), r.reason);
  });

  test('Number(null) cannot become a finding — a missing volume leaves the clause NOT CHECKED', () => {
    const bars = build(cupPath()).map(({ volume, ...b }) => b);
    const r = detectCup(bars);
    assert.equal(r.qualifies, true, 'volume is not part of the verdict');
    assert.equal(r.supporting.handle_volume_dryup.pass, false);
    assert.equal(r.supporting.handle_volume_dryup.value, 'NOT CHECKED');
    assert.match(r.supporting.handle_volume_dryup.note, /Unknown is not satisfied/);
  });
});

describe('volume is SUPPORTING evidence and never reaches the verdict', () => {
  test('stripping volume changes nothing about qualifies or the clauses', () => {
    const withVol = build(cupPath());
    const without = withVol.map(({ volume, ...b }) => b);
    const a = detectCup(withVol);
    const b = detectCup(without);
    assert.equal(a.qualifies, b.qualifies);
    assert.deepEqual(Object.keys(a.checks).map((k) => a.checks[k].pass),
      Object.keys(b.checks).map((k) => b.checks[k].pass));
  });

  test('multiplying every volume by 100 changes nothing about the verdict', () => {
    const a = detectCup(build(cupPath()));
    const b = detectCup(build(cupPath()).map((x) => ({ ...x, volume: x.volume * 100 })));
    assert.equal(a.qualifies, b.qualifies);
    assert.equal(a.completion_level, b.completion_level);
  });

  test('no clause name in `checks` mentions volume', () => {
    const r = detectCup(build(cupPath()));
    for (const k of Object.keys(r.checks)) assert.ok(!/volume/i.test(k), `${k} is a volume clause in the verdict`);
    assert.ok(Object.keys(r.supporting).some((k) => /volume/i.test(k)), 'volume must still be reported');
  });

  test('the reason is stated where a reader will find it', () => {
    assert.match(CUP_NOISE_BASELINE.volume_note, /flat volume/);
    assert.match(CUP_CITATIONS.volume.and_bulkowski_agrees, /None/);
  });
});

describe('pivot density — sparse, and still able to disagree with itself', () => {
  test('cupPatterns maps the callers lookback through the offset', () => {
    assert.equal(CUP_LOOKBACK_OFFSET, 4);
    assert.equal(CUP_DEFAULTS.lookback, 5 + CUP_LOOKBACK_OFFSET,
      'the default must equal what the default caller lookback maps to');
  });

  test('the assessment sweep genuinely varies the cup density', () => {
    /**
     * assessment.js sweeps lookback 3/4/5/6/8 and calls a pattern STABLE when it
     * survives 3 of 5. A cup that ignored the sweep would survive 5 of 5 always
     * and the stability reading would silently be 100% — the failure pivots.js
     * refuses cross-validated bandwidth for.
     */
    const mapped = [3, 4, 5, 6, 8].map((l) => l + CUP_LOOKBACK_OFFSET);
    assert.deepEqual(mapped, [7, 8, 9, 10, 12]);
    assert.equal(new Set(mapped).size, 5, 'every sweep rung must map to a DIFFERENT density');
    assert.ok(Math.min(...mapped) >= 7,
      'even the finest rung must stay sparse enough for a 35-325 bar pattern');
  });

  test('the density choice is justified in the source, not merely set', () => {
    const src = detectCup(build(cupPath()));
    assert.equal(src.pivot_lookback, CUP_DEFAULTS.lookback);
    assert.ok(src.candidates_scored >= 1, 'candidates_scored is the trial count and must be reported');
    assert.ok(Number.isFinite(src.pivot_highs_found));
  });
});

describe('registration — patterns_detect and assess() surface the cup', () => {
  const bars = normalizeBars(build(cupPath()));

  test('cup_with_handle is in STRUCTURAL_PATTERNS', () => {
    assert.ok(STRUCTURAL_PATTERNS.includes('cup_with_handle'));
  });

  test('it carries Bulkowskis measured statistics, as the coverage test requires', () => {
    assert.ok(STRUCTURAL_STATS.cup_with_handle);
    const s = statsFor('cup_with_handle', { direction: 'upward' });
    assert.equal(s.rank, '3/39');
    assert.equal(s.break_even_failure_pct, 5);
    assert.equal(s.average_move_pct, 54);
    assert.equal(s.meeting_target_pct, 61);
    assert.equal(s.throwback_pullback_pct, 62);
    assert.match(s.source, /thepatternsite\.com/);
  });

  test('detectPatterns returns it in `structural`', () => {
    const out = detectPatterns(bars, { lookback: 5, max_age_bars: 300 });
    const cup = out.structural.find((p) => p.pattern === 'cup_with_handle');
    assert.ok(cup, `not found; got ${out.structural.map((p) => p.pattern).join(', ')}`);
    assert.equal(cup.direction, 'bullish');
    assert.equal(cup.type, 'continuation');
    assert.ok(['forming', 'confirmed'].includes(cup.status));
    assert.ok(Number.isFinite(cup.completion_level));
    assert.ok(Number.isFinite(cup.target));
    assert.equal(cup.bars_ago, 0, 'a live cup runs to the last bar');
  });

  test('it has a NOISE FLOOR entry, so vsNoise can compare against it', () => {
    // A pattern with no floor reads as a pattern with a good one.
    assert.ok(Number.isFinite(NOISE_BASELINE.per_walk.cup_with_handle));
  });

  test('it reaches assess().chart_patterns.detected with the projected fields', () => {
    const a = assess(bars, null);
    const row = a.chart_patterns.detected.find((p) => p.pattern === 'cup_with_handle');
    assert.ok(row, `not projected; got ${a.chart_patterns.detected.map((p) => p.pattern).join(', ')}`);
    for (const k of ['pattern', 'status', 'direction', 'target', 'completion_level', 'bars_ago']) {
      assert.ok(k in row, `the projection dropped ${k}`);
    }
    assert.equal(row.neckline_slope, null, 'a cup has no neckline; the key must be present and null');
  });
});

describe('drawing — the cup degrades into existing geometry with no new label format', () => {
  test('it exposes peak_1/peak_2 so drawPatternGeometry draws the RIM LINE', () => {
    const m = detectCup(build(cupPath())).measurements;
    assert.equal(m.peak_1, m.left_rim);
    assert.equal(m.peak_2, m.right_rim);
  });

  test('it does NOT expose keys that would route it into the wrong branch', () => {
    /**
     * `resistance_now`/`support_now` route to the trendline branch; `pole_pct`
     * plus `flag_bars` to the flag branch; and `neckline`/`trough`/`peak` would
     * make the drawn break level the cup BOTTOM instead of the right lip.
     */
    const m = detectCup(build(cupPath())).measurements;
    for (const k of ['resistance_now', 'support_now', 'pole_pct', 'flag_bars',
      'pennant_bars', 'neckline', 'trough', 'peak', 'left_shoulder']) {
      assert.ok(!(k in m), `measurements.${k} would hijack the drawing branch`);
    }
  });

  test('its label formats are already registered, so it cannot leak an orphan', () => {
    // drawPatternGeometry writes "<pattern> <status>" and "... — completes <n>".
    // PAT is built from STRUCTURAL_PATTERNS, so registration covers this for free —
    // but only while the name is in that list, which this asserts.
    const matches = (t) => MCP_TEXT_SIGNATURES.some((re) => re.test(t));
    assert.ok(matches('cup_with_handle forming'));
    assert.ok(matches('cup_with_handle confirmed'));
    assert.ok(matches('cup_with_handle forming — completes 101.03'));
    assert.ok(matches('cup_with_handle confirmed — breaks at 101.03'));
    assert.ok(matches('cup_with_handle forming target 127.74'));
  });
});

describe('the noise floor is measured, published, and unflattering', () => {
  test('it is a measurement and not a placeholder', () => {
    assert.equal(CUP_NOISE_BASELINE.measured, true);
    assert.equal(CUP_NOISE_BASELINE.walks, 200);
    assert.ok(CUP_NOISE_BASELINE.measured_on);
    assert.ok(CUP_NOISE_BASELINE.reproduce.includes('detector-noise.js'));
  });

  test('it records the LENGTH DEPENDENCE rather than a single number', () => {
    /**
     * The floor climbs with series length because the detector reports the best
     * of every rim PAIR. Recording one number would hide a trial count.
     */
    const d = CUP_NOISE_BASELINE.length_dependence;
    const rates = [d.bars_150, d.bars_200, d.bars_300, d.bars_400].map((x) => x.qualifying_pct);
    for (let i = 1; i < rates.length; i++) {
      assert.ok(rates[i] > rates[i - 1], `the rate must be monotone in length: ${rates}`);
    }
    const pairs = [d.bars_150, d.bars_200, d.bars_300, d.bars_400].map((x) => x.rim_pairs_scored_per_walk);
    assert.ok(pairs[3] > pairs[0] * 5, 'the trial count must be shown to grow with it');
    assert.equal(CUP_NOISE_BASELINE.qualifying_pct_of_walks, d.bars_300.qualifying_pct,
      'the headline must be the operational length, not the flattering one');
  });

  test('it says which clause earns the selectivity', () => {
    const f = CUP_NOISE_BASELINE.failing_clause_pct_of_walks_at_300;
    assert.ok(f.rims_near_same_price > f.u_shaped_not_v);
    assert.match(f.reading, /OURS/);
  });

  test('it publishes the bracket across the two unpublished thresholds', () => {
    const s = CUP_NOISE_BASELINE.sensitivity_at_300_bars;
    assert.ok(s.rim_tolerance_pct[8] > s.rim_tolerance_pct[3] * 3, 'the answer travels a long way');
    assert.ok(s.min_base_time_pct[25] > s.min_base_time_pct[45] * 3);
    assert.match(s.reading, /BEFORE this sweep was run/);
  });

  test('the reading says NOT SELECTIVE rather than leaning on the 3/39 rank', () => {
    assert.match(CUP_NOISE_BASELINE.reading, /NOT SELECTIVE/);
    assert.match(CUP_NOISE_BASELINE.reading, /confluence/);
    assert.ok(CUP_NOISE_BASELINE.qualifying_pct_of_walks > 10,
      'if this ever drops near zero, re-measure before believing it');
  });
});

describe('provenance — his numbers are labelled his, ours are labelled ours', () => {
  test('every citation names a source', () => {
    for (const [k, c] of Object.entries(CUP_CITATIONS)) {
      assert.ok(c.source, `${k} has no source`);
      if (c.source !== 'ours' && !String(c.source).startsWith('ours')) {
        assert.ok(c.quote || c.second_source, `${k} claims a source but quotes nothing`);
      } else {
        assert.ok(c.why, `${k} is ours and gives no justification`);
      }
    }
  });

  test('the numbers Bulkowski did NOT give are marked ours', () => {
    assert.equal(CUP_CITATIONS.u_shaped_not_v.number_is, 'ours');
    assert.equal(CUP_CITATIONS.rim_tolerance.number_is, 'ours');
    assert.match(CUP_CITATIONS.rim_tolerance.second_source, /no hard percentages/);
    assert.match(CUP_CITATIONS.cup_depth.source, /^ours/);
  });

  test('the two sources DISAGREE about the prior rise, and the site wins', () => {
    const d = CUP_CITATIONS.prior_trend.sources_disagree;
    assert.match(d, /30%/);
    assert.match(d, /SITE wins/i);
    // And the disagreement is visible in the output, not just in a comment.
    const s = detectCup(build(cupPath())).supporting.prior_rise_into_cup;
    assert.match(s.required, /30%/);
    assert.match(s.source, /DISAGREE/);
  });

  test('the 2005 edition is used for guidelines only, never for statistics', () => {
    assert.match(CUP_SECOND_SOURCE.NOT_used_for, /performance statistics/);
    assert.ok(CUP_SECOND_SOURCE.bulkowski_applies_none_of.includes('cup depth bounds'));
    assert.match(CUP_SECOND_SOURCE.u_shape_caveat, /not sure about the performance effect/);
  });

  test('it admits the detector is stricter than the sample the base rates came from', () => {
    assert.match(CUP_CITATIONS.cup_depth.stricter_than_his_sample, /different population/);
  });

  test('the horizon warning is attached, because a cup breakout is a continuation bet', () => {
    const r = detectCup(build(cupPath()));
    assert.match(r.horizon_warning, /CONTINUATION/);
    assert.match(r.horizon_warning, /REVERSAL/);
    assert.match(r.horizon_warning, /horizon_prior/);
  });
});
