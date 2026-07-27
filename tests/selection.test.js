import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  netOfCosts, estimatePi0, fdrSelect, breakEvenCost, persistenceTest,
} from '../src/core/selection.js';
import { rng } from '../src/core/synthetic.js';

/** Deterministic gaussian draws. */
function gaussians(n, seed, mean = 0, sd = 0.01) {
  const r = rng(seed);
  return Array.from({ length: n }, () => {
    const u1 = Math.max(r(), 1e-12), u2 = r();
    return mean + sd * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  });
}

describe('netOfCosts', () => {
  test('charges per signal and spreads it across the periods', () => {
    const out = netOfCosts({ returns: [0.01, 0.01, 0.01, 0.01], signals: 4, cost_bps: 25 });
    assert.ok(Math.abs(out.cost_total - 0.01) < 1e-12);      // 4 * 25bps = 1%
    assert.ok(Math.abs(out.net_total - 0.03) < 1e-12);       // 4% gross - 1%
    assert.strictEqual(out.net_returns.length, 4);
  });

  test('a high-turnover rule is penalised more than a low-turnover one with the same gross', () => {
    const rets = [0.02, 0.02];
    const churn = netOfCosts({ returns: rets, signals: 50, cost_bps: 20 });
    const patient = netOfCosts({ returns: rets, signals: 2, cost_bps: 20 });
    assert.strictEqual(churn.gross_total, patient.gross_total);
    assert.ok(churn.net_total < patient.net_total, 'turnover must change the net ranking');
  });

  test('rejects bad inputs', () => {
    assert.throws(() => netOfCosts({ returns: [], signals: 1, cost_bps: 1 }), /non-empty/);
    assert.throws(() => netOfCosts({ returns: [0.01], signals: -1, cost_bps: 1 }), /non-negative/);
    assert.throws(() => netOfCosts({ returns: [0.01], signals: 1, cost_bps: -5 }), /non-negative/);
  });
});

describe('estimatePi0', () => {
  test('uniform p-values give pi0 near 1 — nothing real in the set', () => {
    const p = Array.from({ length: 500 }, (_, i) => (i + 0.5) / 500);
    assert.ok(estimatePi0(p) > 0.9, 'a uniform p-value distribution is all null');
  });

  test('p-values concentrated near zero give a low pi0', () => {
    const p = Array.from({ length: 500 }, () => 0.001);
    assert.ok(estimatePi0(p) < 0.1);
  });

  test('rejects a lambda outside (0,1)', () => {
    assert.throws(() => estimatePi0([0.5], { lambda: 1 }), /strictly between/);
  });
});

describe('fdrSelect — costs enter BEFORE the test', () => {
  test('a genuinely profitable low-turnover rule survives cost', () => {
    const cands = [
      { name: 'good', returns: gaussians(300, 1, 0.002, 0.008), signals: 10 },
      ...Array.from({ length: 20 }, (_, i) => ({ name: `noise${i}`, returns: gaussians(300, 100 + i, 0, 0.01), signals: 10 })),
    ];
    const out = fdrSelect(cands, { cost_bps: 5 });
    assert.ok(out.selected.some((s) => s.name === 'good'), `expected "good" selected, got ${out.selected.map((s) => s.name)}`);
  });

  test('THE POINT: a high-turnover rule that wins on gross loses on net', () => {
    // Built by construction rather than by sampling, so the gross ranking is
    // guaranteed and the test measures the cost logic instead of luck.
    const base = gaussians(300, 7, 0, 0.006);
    const churn = { name: 'churner', returns: base.map((r) => r + 0.0030), signals: 300 };
    const patient = { name: 'patient', returns: base.map((r) => r + 0.0022), signals: 6 };
    const cands = [churn, patient,
      ...Array.from({ length: 15 }, (_, i) => ({ name: `n${i}`, returns: gaussians(300, 200 + i, 0, 0.01), signals: 50 }))];

    const free = fdrSelect(cands, { cost_bps: 0 });
    const costed = fdrSelect(cands, { cost_bps: 20 });

    // Gross: the churner earns more per period, so it ranks first.
    assert.strictEqual(free.selected[0]?.name, 'churner', 'the churner should win on gross');

    // Net: 300 signals * 20bps = 6% of cost against 6 * 20bps = 0.12%.
    const costedNames = costed.selected.map((s) => s.name);
    assert.ok(!costedNames.includes('churner'),
      'the churner must NOT survive once costs are inside the selection');
    assert.ok(costedNames.includes('patient'), 'the patient rule should be what survives');
  });

  test('reports FDR+ and says so when the apparent performance is pure snooping', () => {
    const cands = Array.from({ length: 60 }, (_, i) => ({
      name: `r${i}`, returns: gaussians(200, 500 + i, 0, 0.01), signals: 20,
    }));
    const out = fdrSelect(cands, { cost_bps: 0 });
    assert.ok(out.pi0 > 0.7, `a set of pure noise rules should give a high pi0, got ${out.pi0}`);
    if (out.selected_count > 0) {
      assert.ok(out.fdr_plus > 0.4, `noise selections should carry a high FDR+, got ${out.fdr_plus}`);
    }
  });

  test('states that costs are applied before the statistic', () => {
    const out = fdrSelect([{ name: 'a', returns: gaussians(100, 3, 0.001), signals: 5 }], { cost_bps: 10 });
    assert.match(out.method, /BEFORE its test statistic/);
    assert.match(out.p_value_note, /studentized bootstrap/);
  });

  test('rejects an empty candidate set and a bad gamma', () => {
    assert.throws(() => fdrSelect([]), /non-empty array/);
    assert.throws(() => fdrSelect([{ name: 'a', returns: [0.1, 0.1, 0.1], signals: 1 }], { gamma: 0 }), /between 0 and 1/);
  });
});

describe('breakEvenCost — the ex-ante answer', () => {
  test('finds the cost at which nothing survives', () => {
    // FDR needs a large candidate set — see the underpowered warning. And the
    // turnover has to be realistic: an edge that trades 20 times in 300
    // periods is untouchable by any plausible cost, which makes it a useless
    // fixture. 100 signals over 300 periods at an edge of 0.1%/period implies
    // an analytic break-even near 30bps.
    const cands = [
      ...Array.from({ length: 12 }, (_, i) => ({ name: `good${i}`, returns: gaussians(300, 11 + i, 0.001, 0.008), signals: 100 })),
      ...Array.from({ length: 200 }, (_, i) => ({ name: `n${i}`, returns: gaussians(300, 3000 + i, 0, 0.01), signals: 100 })),
    ];
    const out = breakEvenCost(cands, { max_bps: 300, step_bps: 5 });
    assert.ok(out.break_even_bps > 0, 'a real edge should survive some cost');
    assert.ok(out.break_even_bps <= 300);
    assert.match(out.interpretation, /ex-ante break-even cost/);
  });

  test('a set of pure noise breaks even at or near zero', () => {
    const cands = Array.from({ length: 30 }, (_, i) => ({
      name: `n${i}`, returns: gaussians(200, 700 + i, 0, 0.01), signals: 40,
    }));
    const out = breakEvenCost(cands, { max_bps: 100, step_bps: 5 });
    assert.ok(out.break_even_bps != null && out.break_even_bps <= 30,
      `noise should not survive meaningful costs, got ${out.break_even_bps}`);
  });

  test('detects when the identity of the winners changes with cost', () => {
    const cands = [
      { name: 'churner', returns: gaussians(300, 21, 0.0025, 0.008), signals: 300 },
      { name: 'patient', returns: gaussians(300, 22, 0.0020, 0.008), signals: 6 },
      ...Array.from({ length: 15 }, (_, i) => ({ name: `n${i}`, returns: gaussians(300, 800 + i, 0, 0.01), signals: 50 })),
    ];
    const out = breakEvenCost(cands, { max_bps: 200, step_bps: 5 });
    assert.strictEqual(out.top_rule_at_zero_cost, 'churner');
    assert.ok(out.winners_changed_with_cost,
      'the winner at zero cost should not be the winner at break-even — that is the whole finding');
  });

  test('carries the quote that justifies the ordering', () => {
    const out = breakEvenCost([{ name: 'a', returns: gaussians(100, 31, 0.001), signals: 5 }], { max_bps: 20, step_bps: 5 });
    assert.match(out.why_this_ordering, /not among\s+those that perform best before costs/);
  });

  test('rejects nonsensical sweep parameters', () => {
    assert.throws(() => breakEvenCost([{ name: 'a', returns: [0.01, 0.01, 0.01], signals: 1 }], { max_bps: 0 }), /must be positive/);
  });
});

describe('persistenceTest — testing the procedure, not the rule', () => {
  test('a persistently good rule produces positive out-of-sample selection', () => {
    const cands = [
      { name: 'good', returns: gaussians(600, 41, 0.0025, 0.008), signals: 30 },
      ...Array.from({ length: 12 }, (_, i) => ({ name: `n${i}`, returns: gaussians(600, 900 + i, 0, 0.01), signals: 30 })),
    ];
    const out = persistenceTest(cands, { train: 120, test: 40, cost_bps: 2 });
    assert.ok(out.available);
    assert.ok(out.windows > 1);
    assert.ok(out.mean_out_of_sample_return > 0, `expected positive OOS, got ${out.mean_out_of_sample_return}`);
  });

  test('pure noise gives a selection procedure that does not persist', () => {
    const cands = Array.from({ length: 25 }, (_, i) => ({
      name: `n${i}`, returns: gaussians(600, 1000 + i, 0, 0.01), signals: 60,
    }));
    const out = persistenceTest(cands, { train: 120, test: 40, cost_bps: 10 });
    assert.ok(out.available);
    if (out.top_rule_reselected_pct != null) {
      assert.ok(out.top_rule_reselected_pct < 70,
        `a noise winner should rarely be reselected, got ${out.top_rule_reselected_pct}%`);
    }
  });

  test('compares the selection against the best possible rule each window', () => {
    const cands = Array.from({ length: 10 }, (_, i) => ({
      name: `r${i}`, returns: gaussians(400, 1100 + i, 0.0005, 0.01), signals: 20,
    }));
    const out = persistenceTest(cands, { train: 100, test: 30 });
    for (const w of out.detail) assert.ok(typeof w.best_possible_next_period === 'number');
  });

  test('refuses when there is not enough history for one window', () => {
    const out = persistenceTest([{ name: 'a', returns: gaussians(50, 51), signals: 5 }], { train: 60, test: 21 });
    assert.strictEqual(out.available, false);
  });

  test('rejects misaligned candidate series', () => {
    assert.throws(() => persistenceTest([
      { name: 'a', returns: gaussians(100, 61), signals: 1 },
      { name: 'b', returns: gaussians(90, 62), signals: 1 },
    ]), /same length, aligned in time/);
  });

  test('says plainly what is being tested', () => {
    const cands = Array.from({ length: 8 }, (_, i) => ({ name: `r${i}`, returns: gaussians(300, 1200 + i, 0, 0.01), signals: 20 }));
    const out = persistenceTest(cands, { train: 100, test: 40 });
    assert.match(out.what_is_being_tested, /The PROCEDURE, not a rule/);
  });
});

describe('the small-candidate-set limitation, surfaced rather than hidden', () => {
  test('warns that FDR has no power below ~50 candidates', () => {
    const cands = [
      { name: 'good', returns: gaussians(300, 11, 0.002, 0.008), signals: 20 },
      ...Array.from({ length: 20 }, (_, i) => ({ name: `n${i}`, returns: gaussians(300, 300 + i, 0, 0.01), signals: 20 })),
    ];
    const out = fdrSelect(cands, { cost_bps: 0 });
    assert.strictEqual(out.underpowered, true);
    assert.match(out.power_warning, /7,846 rules/);
    assert.match(out.power_warning, /deflated_sharpe/);
    assert.strictEqual(out.detects_positive_performance, false,
      'one selection against ~1 expected false positive is not a detection');
  });

  test('the same edge IS detected once the candidate set is large', () => {
    const many = [
      { name: 'good', returns: gaussians(300, 11, 0.002, 0.008), signals: 20 },
      ...Array.from({ length: 200 }, (_, i) => ({ name: `n${i}`, returns: gaussians(300, 3000 + i, 0, 0.01), signals: 20 })),
    ];
    const out = fdrSelect(many, { cost_bps: 0 });
    assert.ok(!out.underpowered);
    assert.strictEqual(out.detects_positive_performance, true);
  });
});

describe('at_your_cost — the practical form of the question', () => {
  test('names the gross winner and the net winner side by side', () => {
    const base = gaussians(300, 42, 0, 0.007);
    const cands = [
      { name: 'churner', returns: base.map((r) => r + 0.0030), signals: 280 },
      { name: 'patient', returns: base.map((r) => r + 0.0016), signals: 15 },
      ...Array.from({ length: 200 }, (_, i) => ({ name: `n${i}`, returns: gaussians(300, 5000 + i, 0, 0.01), signals: 120 })),
    ];
    const out = breakEvenCost(cands, { max_bps: 200, step_bps: 2, compare_at_bps: 20 });
    assert.strictEqual(out.at_your_cost.top_rule_gross, 'churner');
    assert.strictEqual(out.at_your_cost.top_rule_net, 'patient');
    assert.strictEqual(out.at_your_cost.winner_changes_at_your_cost, true);
    assert.match(out.at_your_cost.note, /would have picked the wrong rule/);
  });

  test('flags when the comparison sits beyond the break-even', () => {
    const base = gaussians(300, 42, 0, 0.007);
    const cands = [
      { name: 'churner', returns: base.map((r) => r + 0.0030), signals: 280 },
      { name: 'patient', returns: base.map((r) => r + 0.0016), signals: 15 },
      ...Array.from({ length: 200 }, (_, i) => ({ name: `n${i}`, returns: gaussians(300, 5000 + i, 0, 0.01), signals: 120 })),
    ];
    const out = breakEvenCost(cands, { max_bps: 200, step_bps: 2, compare_at_bps: 100 });
    assert.match(out.at_your_cost.beyond_break_even, /no longer detects genuine performance/);
  });

  test('omitted when compare_at_bps is not supplied', () => {
    const cands = Array.from({ length: 60 }, (_, i) => ({ name: `r${i}`, returns: gaussians(200, 60 + i, 0, 0.01), signals: 30 }));
    assert.strictEqual(breakEvenCost(cands, { max_bps: 40, step_bps: 10 }).at_your_cost, undefined);
  });
});
