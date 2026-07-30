import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  classifyStage, stageAction, stagePlan, MA_SETS, STAGES, ACTIONS, STAGE_NOISE_BASELINE, STAGE_FORWARD_TEST,
} from '../src/core/stages.js';
import { normalizeBars } from '../src/core/structure.js';
import { classifyPhase } from '../src/core/wyckoff.js';
import { randomWalk, barsFromPath } from '../src/core/synthetic.js';

/** A clean series: `pct` per bar, compounding, with modest intrabar range. */
function ramp({ n = 120, start = 100, pct = 0.5, vol = 0.006 } = {}) {
  const bars = [];
  let px = start;
  for (let i = 0; i < n; i += 1) {
    px *= 1 + pct / 100;
    bars.push({
      time: (i + 1) * 86400000,
      open: px, high: px * (1 + vol), low: px * (1 - vol), close: px, volume: 1000,
    });
  }
  return normalizeBars(bars);
}

/** Flat, so no slope and no stacking: the abstention case. */
function flat({ n = 120, start = 100, wobble = 0.004 } = {}) {
  const bars = [];
  for (let i = 0; i < n; i += 1) {
    const px = start * (1 + (i % 2 ? wobble : -wobble));
    bars.push({ time: (i + 1) * 86400000, open: px, high: px * 1.004, low: px * 0.996, close: px, volume: 1000 });
  }
  return normalizeBars(bars);
}

describe('classifyStage — Shannon\'s three clauses', () => {
  test('a clean advance is Stage 2, and the reason names all three clauses', () => {
    const r = classifyStage(ramp({ pct: 0.5 }));
    assert.equal(r.available, true);
    assert.equal(r.stage, 2);
    assert.equal(r.stage_name, 'uptrend');
    assert.equal(r.tradeable, true);
    assert.equal(r.clauses.price_above_all, true);
    assert.equal(r.clauses.all_rising, true);
    assert.equal(r.clauses.stacked_up, true);
    assert.match(r.why, /above all three/);
    assert.match(r.why, /stacked 10>20>50/);
  });

  test('a clean decline is Stage 4', () => {
    const r = classifyStage(ramp({ pct: -0.5 }));
    assert.equal(r.stage, 4);
    assert.equal(r.stage_name, 'decline');
    assert.equal(r.tradeable, true);
    assert.equal(r.clauses.price_below_all, true);
    assert.equal(r.clauses.all_falling, true);
    assert.equal(r.clauses.stacked_down, true);
  });

  test('ABSTAINS on a flat series rather than picking the nearest stage', () => {
    /**
     * The property the whole gate depends on. A classifier that always answers
     * cannot filter — which is exactly why this is not built on classifyPhase.
     */
    const r = classifyStage(flat());
    assert.equal(r.available, true);
    assert.equal(r.stage, null);
    assert.equal(r.tradeable, false);
    assert.match(r.why, /NO STAGE/);
    assert.match(r.why, /Abstaining is the answer, not a fallback/);
  });

  test('classifyPhase names a phase on the SAME flat bars, and that is the contrast', () => {
    // Documented in the repo already: classifyPhase fires on 100% of random
    // walks because it never abstains. This pins the difference in one test.
    const bars = flat();
    assert.equal(classifyStage(bars).stage, null);
    const w = classifyPhase(bars);
    assert.ok(w.phase && w.phase !== 'unclear', 'classifyPhase should have named something');
  });

  test('STACKING is a separate clause from slope — all rising but crossed is NOT Stage 2', () => {
    /**
     * The clause people collapse. Shannon states position, slope and stacking
     * separately: "trading above the RISING 10-, 20- and 50-day moving averages,
     * with the moving averages STACKED above each other 10>20>50."
     *
     * A long slow advance that has just accelerated has all three rising while
     * the fast average is still catching up from below.
     */
    const bars = [...ramp({ n: 60, pct: 0.05 }), ...ramp({ n: 8, start: 103, pct: 3 })]
      .map((b, i) => ({ ...b, time: (i + 1) * 86400000 }));
    const r = classifyStage(normalizeBars(bars));
    // Whatever the verdict, the two clauses must be reported independently.
    assert.equal(typeof r.clauses.all_rising, 'boolean');
    assert.equal(typeof r.clauses.stacked_up, 'boolean');
    // And Stage 2 must require BOTH.
    if (r.stage === 2) assert.ok(r.clauses.all_rising && r.clauses.stacked_up);
  });

  test('reports every average, every slope, and the clause map', () => {
    const r = classifyStage(ramp());
    assert.ok(Number.isFinite(r.averages.ma10));
    assert.ok(Number.isFinite(r.averages.ma50));
    assert.ok(Number.isFinite(r.slopes_pct.ma50));
    assert.equal(Object.keys(r.clauses).length, 6);
    assert.equal(r.slope_lookback, 5);
    assert.deepEqual(r.periods, [10, 20, 50]);
  });

  test('too few bars is unavailable and says how many were needed', () => {
    const r = classifyStage(ramp({ n: 20 }));
    assert.equal(r.available, false);
    assert.equal(r.stage, null);
    assert.match(r.note, /Need at least/);
  });

  test('accepts a different triple, e.g. Shannon\'s weekly 10/20/40', () => {
    const r = classifyStage(ramp({ n: 120 }), { periods: MA_SETS.weekly });
    assert.deepEqual(r.periods, [10, 20, 40]);
    assert.ok('ma40' in r.averages);
    assert.match(MA_SETS.source, /200 trading days/);
  });
});

describe('stageAction — the gate', () => {
  test('Stage 2 gate licenses the long side and maps all four short stages', () => {
    const expect = { 1: 'ANTICIPATE', 2: 'PARTICIPATE', 3: 'EXIT', 4: 'AVOID' };
    for (const [short, action] of Object.entries(expect)) {
      const r = stageAction({ long_stage: 2, short_stage: Number(short) });
      assert.equal(r.action, action, `short stage ${short}`);
      assert.equal(r.side, 'long');
      assert.equal(r.gate, 'OPEN');
    }
  });

  test('Stage 4 gate is the same wheel rotated by two', () => {
    const expect = { 3: 'ANTICIPATE', 4: 'PARTICIPATE', 1: 'EXIT', 2: 'AVOID' };
    for (const [short, action] of Object.entries(expect)) {
      const r = stageAction({ long_stage: 4, short_stage: Number(short) });
      assert.equal(r.action, action, `short stage ${short}`);
      assert.equal(r.side, 'short');
    }
  });

  test('Stages 1 and 3 CLOSE the gate — a universe restriction, not a preference', () => {
    /**
     * Shannon: "the only stocks which should be of ANY interest are those in an
     * established Stage 2 Uptrend or a Stage 4 Decline." Softening this into a
     * weaker signal is what turns the method into "trade whatever looks good".
     */
    for (const L of [1, 3]) {
      const r = stageAction({ long_stage: L, short_stage: 2 });
      assert.equal(r.action, 'NO_SETUP');
      assert.equal(r.gate, 'CLOSED');
      assert.equal(r.side, null);
      assert.match(r.gate_reason, /excludes/);
    }
  });

  test('a null gate stage also closes the gate', () => {
    const r = stageAction({ long_stage: null, short_stage: 2 });
    assert.equal(r.action, 'NO_SETUP');
    assert.equal(r.gate, 'CLOSED');
    assert.match(r.gate_reason, /no stage/);
  });

  test('a requested side contradicting the gate is REFUSED, not obliged', () => {
    const r = stageAction({ long_stage: 2, short_stage: 2, side: 'short' });
    assert.equal(r.action, 'NO_SETUP');
    assert.match(r.gate_reason, /contradicts/);
    // Shannon allows it but calls the risk much higher, so refusing is honest.
    assert.match(r.gate_reason, /much higher/);
  });

  test('an open gate with no short-TF stage WAITS rather than entering', () => {
    const r = stageAction({ long_stage: 2, short_stage: null });
    assert.equal(r.action, 'WAIT');
    assert.equal(r.gate, 'OPEN');
    assert.match(r.why, /mixed trend signals/);
  });

  test('AVOID says do not scale in — directional conflict means NO trade', () => {
    const r = stageAction({ long_stage: 2, short_stage: 4 });
    assert.match(r.do, /Do not scale in, do not average down/);
    assert.match(r.why, /immediate and unnecessary losing position/);
  });

  test('every action carries what to DO and WHY, quoting the source', () => {
    for (const [name, a] of Object.entries(ACTIONS)) {
      assert.ok(a.do && a.do.length > 20, `${name} has no instruction`);
      assert.ok(a.why && a.why.length > 20, `${name} has no reason`);
    }
    assert.match(ACTIONS.PARTICIPATE.why, /it is time to buy/);
    assert.match(ACTIONS.NO_SETUP.why, /ANY interest/);
  });

  test('every stage declares whether Shannon would trade it', () => {
    assert.equal(STAGES[2].tradeable, true);
    assert.equal(STAGES[4].tradeable, true);
    assert.equal(STAGES[1].tradeable, false);
    assert.equal(STAGES[3].tradeable, false);
    // Stage 1's note carries the sequencing claim a detector must respect.
    assert.match(STAGES[1].note, /Higher lows appear BEFORE higher highs/);
  });
});

describe('stagePlan — both halves together', () => {
  test('an uptrend on both timeframes is PARTICIPATE', () => {
    const p = stagePlan({ long_bars: ramp({ pct: 0.5 }), short_bars: ramp({ pct: 0.5 }) });
    assert.equal(p.available, true);
    assert.equal(p.action.action, 'PARTICIPATE');
    assert.equal(p.long_timeframe.stage, 2);
    assert.equal(p.short_timeframe.stage, 2);
  });

  test('an uptrend gate with a declining trigger is AVOID', () => {
    const p = stagePlan({ long_bars: ramp({ pct: 0.5 }), short_bars: ramp({ pct: -0.5 }) });
    assert.equal(p.action.action, 'AVOID');
  });

  test('a flat gate is NO_SETUP whatever the trigger does', () => {
    const p = stagePlan({ long_bars: flat(), short_bars: ramp({ pct: 0.5 }) });
    assert.equal(p.action.action, 'NO_SETUP');
    assert.equal(p.action.gate, 'CLOSED');
  });

  test('states that the long timeframe is a gate, not a forecast', () => {
    const p = stagePlan({ long_bars: ramp(), short_bars: ramp() });
    assert.match(p.how_to_read, /IDEA GENERATION, NOT FOR TIMING/);
    // And corrects Shannon's own overreach about short timeframes leading.
    assert.match(p.how_to_read, /aggregation identity, not\s+a forecast/);
    assert.match(p.how_to_read, /TIGHTER STOP/);
  });

  test('carries the noise baseline with every plan', () => {
    const p = stagePlan({ long_bars: ramp(), short_bars: ramp() });
    assert.equal(p.noise_baseline.status, 'MEASURED');
  });
});

describe('the measured noise floor', () => {
  test('records that the classifier abstains on most random walks', () => {
    const b = STAGE_NOISE_BASELINE;
    assert.equal(b.random_walk.abstain_pct, 54.0);
    assert.equal(b.random_walk.tradeable_pct, 36.0);
    assert.equal(b.random_walk.walks, 200);
  });

  test('records that classifyPhase abstains on NONE of the same walks', () => {
    // The measured justification for not reusing it as the gate.
    assert.equal(STAGE_NOISE_BASELINE.wyckoff_classify_phase_named_pct.random_walk, 100);
  });

  test('admits the gate finds no more tradeable structure in real data than in noise', () => {
    /**
     * 25% real against 36% noise. Reporting the selectivity without this would
     * be the flattering half of the result.
     */
    const b = STAGE_NOISE_BASELINE;
    assert.ok(b.real_data.tradeable_pct < b.random_walk.tradeable_pct);
    assert.match(b.verdict, /CONSISTENCY filter/);
    assert.match(b.verdict, /never as evidence/);
    assert.match(b.verdict, /too small to stand alone/);
  });

  test('the abstention rate reproduces on a fresh sample', () => {
    // If this drifts the recorded baseline is stale.
    let abstains = 0; let n = 0;
    for (let seed = 1; seed <= 60; seed += 1) {
      const bars = normalizeBars(barsFromPath(randomWalk({ n: 300, vol: 0.015, seed })));
      const r = classifyStage(bars);
      if (!r.available) continue;
      n += 1;
      if (r.stage === null) abstains += 1;
    }
    const rate = (abstains / n) * 100;
    assert.ok(Math.abs(rate - 54) < 15, `abstention drifted to ${rate.toFixed(1)}% from the recorded 54%`);
  });

  test('names the script that re-measures it', () => {
    assert.match(STAGE_NOISE_BASELINE.script, /stage-noise/);
  });
});

describe('insufficient data is not an abstention', () => {
  test('a too-short gate says INSUFFICIENT_DATA, not "clauses disagree"', () => {
    /**
     * Found by running stage_plan against a live 60-minute chart: a "week" gate
     * produced FIVE bars, and the result still read as a considered abstention.
     * "Not enough bars" and "the clauses disagree" both give stage === null and
     * are completely different statements.
     */
    const p = stagePlan({ long_bars: ramp({ n: 5 }), short_bars: ramp({ n: 120 }) });
    assert.equal(p.available, false);
    assert.equal(p.action.action, 'INSUFFICIENT_DATA');
    assert.match(p.action.do, /do not read this as an abstention/);
    assert.ok(p.insufficient_data.length >= 1);
    assert.match(p.insufficient_data[0], /^gate:/);
    assert.match(p.how_to_fix, /56 bars/);
  });

  test('a too-short trigger is reported separately from the gate', () => {
    const p = stagePlan({ long_bars: ramp({ n: 120 }), short_bars: ramp({ n: 5 }) });
    assert.equal(p.action.action, 'INSUFFICIENT_DATA');
    assert.match(p.insufficient_data[0], /^trigger:/);
  });

  test('a genuine abstention still reports available:true and NO_SETUP', () => {
    // The contrast: enough bars, clauses simply disagree.
    const p = stagePlan({ long_bars: flat(), short_bars: ramp({ n: 120 }) });
    assert.equal(p.available, true);
    assert.equal(p.action.action, 'NO_SETUP');
    assert.equal(p.insufficient_data, undefined);
  });
});

describe('the forward test — the gate does not improve outcomes', () => {
  test('records a WELL POWERED negative result on both sides', () => {
    /**
     * The measurement that matters most, and it went against the tool. Both
     * sides came out below a direction-matched baseline on adequate independent
     * samples, so this is not an underpowered shrug.
     */
    const f = STAGE_FORWARD_TEST;
    assert.match(f.status, /WELL POWERED, AND NEGATIVE/);
    assert.ok(f.long.lift_points < 0, `long lift ${f.long.lift_points} should be negative`);
    assert.ok(f.short.lift_points < 0, `short lift ${f.short.lift_points} should be negative`);
    assert.ok(f.long.independent_events >= 100);
    assert.ok(f.short.independent_events >= 100);
  });

  test('no configuration favoured the gate, and the count is recorded', () => {
    // One negative run is a run. Four out of four is a finding.
    const f = STAGE_FORWARD_TEST;
    assert.ok(f.configurations_run >= 4);
    assert.equal(f.configurations_favouring_the_gate, 0);
  });

  test('the verdict tells callers what the tool IS still for', () => {
    // Killing a claim is not the same as deleting a tool. It still imposes the
    // universe restriction and describes alignment.
    const v = STAGE_FORWARD_TEST.verdict;
    assert.match(v, /DOES NOT IMPROVE OUTCOMES/);
    assert.match(v, /universe restriction/);
    assert.match(v, /do NOT treat a PARTICIPATE reading as evidence/);
  });

  test('explains WHY, consistent with the repo\'s own horizon finding', () => {
    /**
     * A negative result with a mechanism is more trustworthy than one without.
     * Stage 2 describes a move that already happened, and below ~21 days the
     * documented effect is reversal.
     */
    const w = STAGE_FORWARD_TEST.why_it_is_coherent;
    assert.match(w, /already happened/);
    assert.match(w, /REVERSAL/);
    assert.match(w, /horizon_prior/);
    assert.match(w, /INVERTED/);
  });

  test('admits the z values are optimistic because events overlap', () => {
    const c = STAGE_FORWARD_TEST.caveats.join(' ');
    assert.match(c, /RAW overlapping counts and are optimistic/);
    assert.match(c, /DIRECTION is what carries/);
  });

  test('admits Shannon\'s OWN parameters could not be tested', () => {
    /**
     * The honest limit. A 5-bar gate with a 50-period average needs 280 base
     * bars of warm-up and the chart serves ~300. Reporting the 5/10/20 result as
     * if it refuted 10/20/50 would be the substitution error.
     */
    const c = STAGE_FORWARD_TEST.caveats.join(' ');
    assert.match(c, /UNTESTABLE on this/);
    assert.match(c, /not a refutation of his numbers specifically/);
  });

  test('admits it tests the GATE and not the method', () => {
    const c = STAGE_FORWARD_TEST.caveats.join(' ');
    assert.match(c, /tests the GATE, not his method/);
    assert.match(c, /scales out/);
    // And that a filter can pay through cost even with no win-rate gain.
    assert.match(c, /TRADE COUNT/);
    assert.match(c, /turnover_cost/);
  });

  test('the method statement rules out the two ways this could be faked', () => {
    const m = STAGE_FORWARD_TEST.method;
    assert.match(m, /No lookahead/);
    assert.match(m, /fixed origin/);
    assert.match(m, /SAME\s+direction/);
  });

  test('every plan carries the forward test, not just the noise floor', () => {
    const p = stagePlan({ long_bars: ramp(), short_bars: ramp() });
    assert.equal(p.forward_test.configurations_favouring_the_gate, 0);
    assert.match(p.forward_test.status, /NEGATIVE/);
  });

  test('names the script that re-measures it', () => {
    assert.match(STAGE_FORWARD_TEST.script, /stage-forward-test/);
  });
});
