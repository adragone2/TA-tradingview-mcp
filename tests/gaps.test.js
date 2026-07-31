import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  classifyGaps, describeGap, GAP_DEFAULTS, GAP_CITATIONS, GAP_BASE_RATES,
  GAP_NOISE_BASELINE, VERDICT_PRECEDENCE,
} from '../src/core/gaps.js';
import { randomWalkWithGaps, randomWalk, barsFromPath } from '../src/core/synthetic.js';

const bar = (t, o, h, l, c, v) => ({ time: 1000 + t, open: o, high: h, low: l, close: c, volume: v });

/**
 * A congestion: bars wandering inside roughly 98.6-101.4, each ~0.8 tall.
 *
 * Deliberately NOT a flat repeat. With identical highs every bar, an up gap
 * INSIDE the range is arithmetically impossible — the previous bar's high IS
 * the range high, so any gap above it clears the range by definition. The first
 * version of this fixture had that bug and made `common` look unreachable.
 */
function congestion(n = 60, { vol = 1_000_000, t0 = 0 } = {}) {
  const path = [100, 99.2, 100.4, 99.0, 100.8, 99.6, 101.0, 99.4, 100.2, 99.8];
  const out = [];
  for (let i = 0; i < n; i++) {
    const c = path[i % path.length];
    out.push(bar(t0 + i, c, c + 0.4, c - 0.4, c, vol));
  }
  return out;
}

/** A flat, gapless base: every bar overlaps its neighbour. */
function flat(n = 60, { px = 100, vol = 1_000_000, t0 = 0 } = {}) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const d = i % 2 ? 0.4 : -0.4;
    out.push(bar(t0 + i, px, px + 0.6, px - 0.6, px + d, vol));
  }
  return out;
}

/** A straight-line run with no gaps in it: the step is smaller than the bar. */
function run(from, bars, step, { vol = 1_000_000, t0 = 0, wick = 0.9 } = {}) {
  const out = [];
  let px = from;
  for (let i = 0; i < bars; i++) {
    out.push(bar(t0 + i, px, px + wick, px - wick, px + step, vol));
    px += step;
  }
  return out;
}

/**
 * The same NET advance, reached by zigzag: about half the closes are down, so
 * the prior move clears its ATR bar but the straight-line clause does not. The
 * wick is wide enough that the steps do not gap on their own.
 */
function choppyRun(from, pairs, { up = 2.4, down = -0.8, vol = 1_000_000, t0 = 0 } = {}) {
  const out = [];
  let px = from, t = t0;
  for (let i = 0; i < pairs; i++) {
    for (const step of [up, down]) {
      out.push(bar(t++, px, px + 1.5, px - 1.5, px + step, vol));
      px += step;
    }
  }
  return out;
}

/** A textbook breakaway: tight base, gap clears it on heavy volume, holds. */
function breakawayFixture({ gapVolume = 2_500_000, holds = true } = {}) {
  const b = flat(60);
  let t = 60;
  b.push(bar(t++, 104, 105, 103.5, 104.8, gapVolume));
  for (let k = 0; k < 8; k++) {
    b.push(holds
      ? bar(t++, 104.8 + k * 0.4, 105.4 + k * 0.4, 104.4 + k * 0.4, 105.2 + k * 0.4, 1_200_000)
      : bar(t++, 101.0, 101.4, 99.8, 100.2, 1_200_000));
  }
  return b;
}

/** A runaway: base, straight run, gap mid-trend, new highs, gap stays open. */
function runawayFixture() {
  const b = [...flat(30), ...run(100, 20, 0.8, { t0: 30 })];
  let t = 50;
  const last = b[b.length - 1];
  b.push(bar(t++, last.high + 1.2, last.high + 2.4, last.high + 1.0, last.high + 2.2, 1_100_000));
  for (let k = 0; k < 8; k++) {
    const p = b[b.length - 1];
    b.push(bar(t++, p.close, p.close + 1.0, p.close - 0.3, p.close + 0.8, 1_000_000));
  }
  return b;
}

/** An exhaustion: extended run, tall gap on huge volume, then it stalls. */
function exhaustionFixture({ gapVolume = 3_500_000 } = {}) {
  const b = [...flat(30), ...run(100, 25, 1.2, { t0: 30 })];
  let t = 55;
  const last = b[b.length - 1];
  b.push(bar(t++, last.high + 2.0, last.high + 4.5, last.high + 1.8, last.high + 4.0, gapVolume));
  for (let k = 0; k < 8; k++) {
    const p = b[b.length - 1];
    b.push(bar(t++, p.close - 0.5, p.close + 0.2, p.close - 1.6, p.close - 1.0, 1_000_000));
  }
  return b;
}

/** An area gap: inside the congestion, and filled the next bar. */
function commonFixture() {
  const b = congestion(60);
  let t = 60;
  b.push(bar(t++, 100.6, 101.0, 100.5, 100.9, 1_100_000));
  for (let k = 0; k < 8; k++) b.push(bar(t++, 100.0, 100.4, 99.2, 99.6, 1_000_000));
  return b;
}

const verdictsAt = (bars, index) => classifyGaps(bars).gaps.filter((g) => g.index === index);

describe('classifyGaps — the four classes, by construction', () => {
  test('a gap out of a tight base on heavy volume is a BREAKAWAY', () => {
    const [g] = verdictsAt(breakawayFixture(), 60);
    assert.ok(g, 'no gap found at the constructed index');
    assert.equal(g.verdict, 'breakaway');
    assert.equal(g.direction, 'up');
  });

  test('a gap mid-trend that extends without filling is a RUNAWAY', () => {
    const out = classifyGaps(runawayFixture()).gaps;
    assert.ok(out.some((g) => g.verdict === 'runaway'), JSON.stringify(out.map((g) => g.verdict)));
  });

  test('a tall gap ending an extended run is an EXHAUSTION', () => {
    const out = classifyGaps(exhaustionFixture()).gaps;
    assert.equal(out[out.length - 1].verdict, 'exhaustion',
      JSON.stringify(out[out.length - 1].failed_clauses));
  });

  test('a gap inside congestion that fills next bar is COMMON', () => {
    const out = classifyGaps(commonFixture()).gaps;
    assert.ok(out.length, 'no gaps found');
    assert.ok(out.every((g) => g.verdict === 'common'), JSON.stringify(out.map((g) => g.verdict)));
  });
});

describe('classifyGaps — the clauses that separate the classes', () => {
  test('the volume clause is load-bearing for a breakaway', () => {
    assert.equal(verdictsAt(breakawayFixture({ gapVolume: 2_500_000 }), 60)[0].verdict, 'breakaway');
    const quiet = verdictsAt(breakawayFixture({ gapVolume: 900_000 }), 60)[0];
    assert.notEqual(quiet.verdict, 'breakaway');
    assert.ok(quiet.failed_clauses.breakaway.includes('high_volume'));
  });

  test('a breakaway that fills inside the window is no longer a breakaway', () => {
    const filled = verdictsAt(breakawayFixture({ holds: false }), 60)[0];
    assert.ok(filled.failed_clauses.breakaway.includes('stays_open'));
    assert.notEqual(filled.verdict, 'breakaway');
  });

  test('runaway and exhaustion are separated by whether price extends', () => {
    // Same extended run; only the follow-through differs.
    const stalls = classifyGaps(exhaustionFixture()).gaps.slice(-1)[0];
    assert.equal(stalls.verdict, 'exhaustion');
    assert.ok(stalls.failed_clauses.runaway.includes('extends_without_closing'));

    const extends_ = classifyGaps(runawayFixture()).gaps.filter((g) => g.verdict === 'runaway').slice(-1)[0];
    assert.ok(extends_.failed_clauses.exhaustion.includes('fails_to_extend'));
  });

  test('the straight-line clause is what makes a run a run', () => {
    /**
     * Same net advance, reached by zigzag. The prior move still clears its ATR
     * bar, so only the straight-line clause can tell the two apart — and it
     * has to, because "occurs during a straight-line advance" is the whole
     * distinction between a continuation gap and a gap in a choppy uptrend.
     */
    const b = [...flat(30), ...choppyRun(100, 12, { t0: 30 })];
    let t = 54;
    const last = b[b.length - 1];
    b.push(bar(t++, last.high + 1.2, last.high + 2.6, last.high + 1.0, last.high + 2.4, 1_100_000));
    for (let k = 0; k < 8; k++) {
      const p = b[b.length - 1];
      b.push(bar(t++, p.close, p.close + 1.2, p.close - 0.3, p.close + 1.0, 1_000_000));
    }
    const g = classifyGaps(b).gaps.find((x) => x.index === 54);
    assert.ok(g, 'the constructed gap was not found');
    assert.ok(g.prior_move_atr >= GAP_DEFAULTS.runaway_min_prior_move_atr,
      `prior move ${g.prior_move_atr}x ATR is too small — the fixture is not testing the straight-line clause`);
    assert.ok(g.failed_clauses.runaway.includes('straight_line_run'),
      `expected the straight-line clause to fail, got ${JSON.stringify(g.failed_clauses.runaway)}`);
    assert.notEqual(g.verdict, 'runaway');
  });
});

describe('classifyGaps — the size gate', () => {
  test('a gap below min_gap_atr is not reported at all', () => {
    const bars = breakawayFixture();
    assert.equal(classifyGaps(bars, { min_gap_atr: 50 }).count, 0);
  });

  test('a gap below min_gap_pct is not reported at all', () => {
    const bars = breakawayFixture();
    assert.equal(classifyGaps(bars, { min_gap_pct: 99 }).count, 0);
  });

  test('the ATR excludes the gap bar, so a gap cannot inflate its own denominator', () => {
    // True range counts the gap and bar range does not. If bar i were in the
    // ATR window, a huge gap would raise the ATR and shrink its own size_atr —
    // which is the defect that made ignition.js's floor unmeasurable.
    const small = verdictsAt(breakawayFixture(), 60)[0];
    const bars = breakawayFixture();
    // Double the gap; size_atr must roughly double, not stay put.
    for (let i = 60; i < bars.length; i++) {
      bars[i] = { ...bars[i], open: bars[i].open + 2.55, high: bars[i].high + 2.55, low: bars[i].low + 2.55, close: bars[i].close + 2.55 };
    }
    const big = classifyGaps(bars).gaps.find((g) => g.index === 60);
    assert.ok(big.size_atr > small.size_atr * 1.7,
      `size_atr went ${small.size_atr} -> ${big.size_atr} for a doubled gap; the ATR is absorbing it`);
  });
});

describe('classifyGaps — what it refuses to decide', () => {
  test('a gap without enough forward bars is PENDING, never common', () => {
    const bars = breakawayFixture().slice(0, 63); // only 2 bars after the gap
    const [g] = classifyGaps(bars).gaps.filter((x) => x.index === 60);
    assert.equal(g.verdict, 'pending');
    assert.match(g.pending_reason, /5 bars after the gap/);
    assert.equal(g.follow_through.settled, false);
  });

  test('a pending gap reports every forward clause as NOT CHECKED, not as a pass', () => {
    const bars = breakawayFixture().slice(0, 63);
    const [g] = classifyGaps(bars).gaps.filter((x) => x.index === 60);
    assert.equal(g.classes.breakaway.stays_open.value, 'NOT CHECKED');
    assert.equal(g.classes.breakaway.stays_open.pass, false);
    assert.equal(g.classes.exhaustion.fails_to_extend.pass, false);
  });

  test('missing volume is NOT CHECKED and does NOT pass', () => {
    const bars = breakawayFixture().map((b) => ({ ...b, volume: null }));
    const [g] = classifyGaps(bars).gaps.filter((x) => x.index === 60);
    assert.equal(g.volume_ratio, null);
    assert.equal(g.classes.breakaway.high_volume.pass, false);
    assert.match(g.classes.breakaway.high_volume.note, /NOT CHECKED|Unknown is not satisfied/);
  });

  test('zero volume is not treated as a number — Number(null) is 0 and has bitten this repo three times', () => {
    const bars = breakawayFixture().map((b) => ({ ...b, volume: 0 }));
    const [g] = classifyGaps(bars).gaps.filter((x) => x.index === 60);
    assert.equal(g.volume_ratio, null);
    assert.equal(g.classes.breakaway.high_volume.pass, false);
  });

  test('a gap matching nothing is UNCLASSIFIED and names its nearest miss', () => {
    const quiet = verdictsAt(breakawayFixture({ gapVolume: 900_000 }), 60)[0];
    assert.equal(quiet.verdict, 'unclassified');
    assert.ok(quiet.near_miss);
    assert.equal(quiet.near_miss.class, 'breakaway');
    assert.deepEqual(quiet.near_miss.failed_clauses, ['high_volume']);
  });

  test('short input is reported, not crashed on', () => {
    const r = classifyGaps(flat(10));
    assert.equal(r.reason, 'insufficient_bars');
    assert.deepEqual(r.gaps, []);
  });

  test('junk input does not throw', () => {
    for (const junk of [null, undefined, [], [{}], [{ high: null, low: null }]]) {
      assert.doesNotThrow(() => classifyGaps(junk));
    }
  });

  test('non-numeric OHLC is skipped rather than coerced', () => {
    const bars = breakawayFixture();
    bars[60] = { ...bars[60], low: null };
    assert.equal(classifyGaps(bars).gaps.some((g) => g.index === 60), false);
  });
});

describe('classifyGaps — the output states what it rests on', () => {
  test('every clause of every class carries a value and a requirement', () => {
    const [g] = verdictsAt(breakawayFixture(), 60);
    for (const [cls, checks] of Object.entries(g.classes)) {
      for (const [name, c] of Object.entries(checks)) {
        assert.equal(typeof c.pass, 'boolean', `${cls}.${name} has no pass flag`);
        assert.ok('value' in c && 'required' in c, `${cls}.${name} does not show its value and requirement`);
      }
    }
  });

  test('the evidence names the bar and the numbers behind the verdict', () => {
    const [g] = verdictsAt(breakawayFixture(), 60);
    assert.match(g.evidence, /^Bar 60:/);
    assert.match(g.evidence, /x ATR/);
    assert.match(g.evidence, /volume/);
    assert.match(g.evidence, /forward bars/);
  });

  test('a runaway carries the measure rule AND the caution that comes with it', () => {
    const g = classifyGaps(runawayFixture()).gaps.find((x) => x.verdict === 'runaway');
    assert.ok(g.measure_rule);
    assert.ok(Number.isFinite(g.measure_rule.projected_target));
    assert.match(g.measure_rule.basis, /50% and 52%/);
    assert.match(g.measure_rule.caution, /ALREADY known to be continuations/);
  });

  test('the "unusually tall" clause is SUPPORTING, never required', () => {
    const [g] = verdictsAt(breakawayFixture(), 60);
    assert.ok('unusually_tall' in g.supporting);
    assert.ok(!('unusually_tall' in g.classes.exhaustion));
    assert.match(g.supporting.unusually_tall.note, /never required/);
  });

  test('every class that passed is reported, not just the winner', () => {
    const [g] = verdictsAt(breakawayFixture(), 60);
    assert.ok(Array.isArray(g.also_matches));
    assert.ok(Array.isArray(g.passed_classes));
    assert.ok(g.passed_classes.includes(g.verdict));
  });

  test('precedence is exported so a tie is inspectable rather than a coin flip', () => {
    assert.deepEqual(VERDICT_PRECEDENCE, ['exhaustion', 'breakaway', 'runaway', 'common']);
  });

  test('Bulkowski\'s base rate travels with the verdict', () => {
    const [g] = verdictsAt(breakawayFixture(), 60);
    assert.deepEqual(g.base_rate, GAP_BASE_RATES.closes_within_a_week_pct.breakaway);
    assert.match(GAP_BASE_RATES.read_as, /not this classifier's accuracy/i);
  });

  test('describeGap returns null where there is no gap', () => {
    assert.equal(describeGap(flat(80), 70), null);
  });
});

describe('every threshold is cited, and OURS is labelled as ours', () => {
  test('each cited clause carries a source URL or is explicitly ours', () => {
    for (const [k, c] of Object.entries(GAP_CITATIONS)) {
      assert.ok(c.source, `${k} has no source`);
      if (c.source === 'ours') assert.ok(c.why && c.why.length > 20, `${k} is ours with no justification`);
      else assert.match(c.source, /^https?:\/\//, `${k} has a source that is not a URL`);
    }
  });

  test('the numbers with no published value are marked ours, not smuggled in as findings', () => {
    for (const k of ['min_gap_atr', 'high_volume_ratio', 'congestion_max_atr', 'straight_line_pct', 'tall_gap_atr']) {
      assert.equal(GAP_CITATIONS[k].source, 'ours', `${k} is presented as published`);
    }
  });

  test('the clauses taken from the source quote it', () => {
    for (const k of ['gap_definition', 'common_in_congestion', 'breakaway_leaves_congestion',
      'runaway_straight_line', 'exhaustion_end_of_trend']) {
      assert.ok(GAP_CITATIONS[k].quote && GAP_CITATIONS[k].quote.length > 30, `${k} cites without quoting`);
    }
  });

  test('the defaults match the numbers the citations describe', () => {
    assert.equal(GAP_DEFAULTS.follow_bars, 5, 'Bulkowski quotes every closure rate "within a week"');
    assert.equal(GAP_DEFAULTS.exhaustion_min_prior_move_atr, GAP_DEFAULTS.runaway_min_prior_move_atr * 2);
  });
});

describe('GAP_NOISE_BASELINE — the floor, and what it cannot claim', () => {
  test('it is measured, with a walk count and the generator named', () => {
    assert.equal(GAP_NOISE_BASELINE.measured, true);
    assert.equal(GAP_NOISE_BASELINE.walks, 200);
    assert.match(GAP_NOISE_BASELINE.generator, /randomWalkWithGaps/);
  });

  test('the generator is calibrated to a REAL-DATA statistic, not guessed', () => {
    // The ignition.js investigation measured ATR/mean-range at 1.070 on real
    // daily bars. That anchor is the only real-data input this null has.
    assert.match(GAP_NOISE_BASELINE.calibration, /1\.070/);
    assert.equal(GAP_NOISE_BASELINE.generator_params.gap_rate, 0.06);
    assert.equal(GAP_NOISE_BASELINE.generator_params.gap_median_atr, 0.35);
  });

  test('the naive-null contrast is recorded — it is what justifies the generator', () => {
    const naive = GAP_NOISE_BASELINE.naive_null_contrast;
    assert.ok(naive.any_gap.per_walk < GAP_NOISE_BASELINE.by_class.any_gap.per_walk / 10,
      'the naive null is not dramatically gap-poor, so the new generator needs justifying differently');
    assert.equal(naive.breakaway.pct_of_walks, 0);
  });

  test('the two volume-gated classes carry the sweep bracket AND the measured-multiple floor', () => {
    const s = GAP_NOISE_BASELINE.volume_sensitivity;
    const ex = Object.values(s.exhaustion_pct_of_walks);
    assert.ok(Math.max(...ex) / Math.min(...ex) > 3,
      'if the exhaustion rate stopped moving with the volume model, the sensitivity note should change');
    // Reviewer update 2026-07-30: the real arm measured the free parameter
    // (gap-day volume multiple 1.21 vs the guessed 2.0) and re-ran the null at
    // it, so exhaustion graduated from "bracket only" to a floor AT the
    // measured value, with the bracket retained for sensitivity.
    assert.match(GAP_NOISE_BASELINE.by_class.exhaustion.status, /FLOOR 9\.5% .* MEASURED/);
    assert.match(GAP_NOISE_BASELINE.by_class.exhaustion.status, /4\.5-37\.0%/);
    assert.match(GAP_NOISE_BASELINE.by_class.breakaway.status, /BRACKETED/);
    assert.match(GAP_NOISE_BASELINE.by_class.breakaway.status, /MEASURED x1\.21/);
  });

  test('the two classes with no volume clause are marked ESTABLISHED', () => {
    assert.match(GAP_NOISE_BASELINE.by_class.common.status, /ESTABLISHED/);
    assert.match(GAP_NOISE_BASELINE.by_class.runaway.status, /ESTABLISHED/);
    // and they must genuinely not move with the volume model
    const c = GAP_NOISE_BASELINE.volume_mode_contrast.unchanged_across_all_three;
    assert.equal(c.common, GAP_NOISE_BASELINE.by_class.common.pct_of_walks);
    assert.equal(c.runaway, GAP_NOISE_BASELINE.by_class.runaway.pct_of_walks);
  });

  test('the real-data arm HAS been run, and the caveat says which way it came out', () => {
    // Reviewer update 2026-07-30: the arm the module shipped asking for.
    assert.match(GAP_NOISE_BASELINE.caveat, /real-data arm HAS been run/);
    assert.match(GAP_NOISE_BASELINE.caveat, /ignition\.js/);
  });

  test('the real arm is recorded with both sides of every comparison', () => {
    const ra = GAP_NOISE_BASELINE.real_arm;
    assert.ok(ra, 'real_arm block missing');
    assert.equal(ra.gap_day_volume_multiple.median, 1.21);
    assert.equal(ra.gap_day_volume_multiple.generator_guess_was, 2.0);
    // Every class must fire AT or ABOVE its null — the direction that means
    // the null is honest. ignition.js failed the other way.
    assert.ok(ra.per_200_bars.common.real >= ra.per_200_bars.common.null * 0.95);
    assert.ok(ra.per_200_bars.runaway.real > ra.per_200_bars.runaway.null);
    assert.ok(ra.per_200_bars.breakaway.real > ra.per_200_bars.breakaway.null_at_measured);
    assert.ok(ra.per_200_bars.exhaustion.real > ra.per_200_bars.exhaustion.null_at_measured);
    // The null-at-measured run must state its seed identity with the
    // published table, or the comparison is between different samples.
    assert.match(ra.null_at_measured_multiple.seeds, /reproduces it exactly/);
    assert.equal(ra.null_at_measured_multiple.exhaustion.pct_of_walks, 9.5);
    // PROVISIONAL: one universe, one period.
    assert.match(ra.still_missing, /one universe, one period/);
  });
});

describe('the numbers still hold', () => {
  /**
   * Regimes, not digits. A class drifting from "descriptive" to "selective" is
   * what matters; asserting the exact percentage would break on any threshold
   * change and teach nothing.
   */
  const N = 40;
  const gapWalk = (s, opts = {}) => randomWalkWithGaps({ n: 200, seed: 7000 + s, ...opts }).bars;

  test('the gap-aware null actually contains gaps and the naive one barely does', () => {
    let withGaps = 0, naive = 0;
    for (let s = 0; s < N; s++) {
      withGaps += classifyGaps(gapWalk(s)).count;
      naive += classifyGaps(barsFromPath(randomWalk({ n: 200, seed: 7000 + s }), { noise: 0.006, seed: 8000 + s })).count;
    }
    assert.ok(withGaps / N > 5, `only ${(withGaps / N).toFixed(2)} gaps per walk — the generator stopped injecting`);
    assert.ok(naive / N < 1, `the naive null produced ${(naive / N).toFixed(2)} gaps per walk — the contrast is gone`);
  });

  test('runaway stays DESCRIPTIVE in noise, which is why it may not be read alone', () => {
    let hit = 0;
    for (let s = 0; s < N; s++) if (classifyGaps(gapWalk(s)).gaps.some((g) => g.verdict === 'runaway')) hit++;
    assert.ok((hit / N) * 100 > 40, `runaway on only ${hit}/${N} — the 69.5% baseline is stale`);
  });

  test('breakaway stays selective', () => {
    let hit = 0;
    for (let s = 0; s < N; s++) if (classifyGaps(gapWalk(s)).gaps.some((g) => g.verdict === 'breakaway')) hit++;
    assert.ok((hit / N) * 100 < 20, `breakaway fired on ${hit}/${N} walks — the 3.5% baseline is stale`);
  });

  test('the volume clause is what floors breakaway — flat volume takes it to zero', () => {
    let hit = 0;
    for (let s = 0; s < N; s++) {
      if (classifyGaps(gapWalk(s, { volume_mode: 'flat' })).gaps.some((g) => g.verdict === 'breakaway')) hit++;
    }
    assert.equal(hit, 0, 'breakaway fired under flat volume — the fixture contrast no longer holds');
  });

  test('most gaps in noise are UNCLASSIFIED — the classifier declines to guess', () => {
    let gaps = 0, unclassified = 0;
    for (let s = 0; s < N; s++) {
      for (const g of classifyGaps(gapWalk(s)).gaps) {
        gaps++;
        if (g.verdict === 'unclassified') unclassified++;
      }
    }
    assert.ok(unclassified / gaps > 0.4,
      `only ${((unclassified / gaps) * 100).toFixed(0)}% unclassified — the classes have become permissive`);
  });
});

describe('the detector EARNED its tool surface — both arms run', () => {
  /**
   * This block used to assert the opposite: no tool may consume gaps.js while
   * its floor was half-measured. The real-data arm was then run (2026-07-30,
   * GAP_NOISE_BASELINE.real_arm — every class at or above its null, the free
   * volume parameter measured, exhaustion's bracket collapsed to a floor), so
   * the module met the bar the original test stated. The assertion flipped
   * WITH the evidence, which is the only direction it may ever flip.
   */
  test('gap_classify is registered, from evidence.js', async () => {
    const { readFileSync } = await import('node:fs');
    const t = readFileSync('src/tools/evidence.js', 'utf8');
    assert.match(t, /core\/gaps\.js/);
    assert.match(t, /'gap_classify'/);
    assert.match(t, /classifyGaps\(bars\)/);
  });

  test('the real_arm block the registration rests on still exists', () => {
    assert.ok(GAP_NOISE_BASELINE.real_arm, 'if the real arm is ever removed, the tool loses its justification');
    assert.match(GAP_NOISE_BASELINE.real_arm.still_missing, /one universe, one period/,
      'and the PROVISIONAL caveat must survive into the registration era');
  });
});

describe('the assess() projection — how the morning and Sunday reports see gaps', () => {
  /**
   * Wiring test (2026-07-30): the block is ADDITIVE in the Sunday schema and
   * compact by design. `verdict` is a STRING for every gap — 'unclassified'
   * and 'pending' are real values, not nulls — and the first live run showed
   * an 'unclassified' entry inside `last_classified` because the filter
   * assumed null. Pinned here.
   */
  test('by_class counts every verdict; last_classified carries only real classes', async () => {
    const { assess } = await import('../src/core/assessment.js');
    const { bars } = randomWalkWithGaps({ n: 300, seed: 7001 });
    const a = assess(bars, null);
    assert.ok(a.gaps, 'the gaps block must exist');
    assert.equal(typeof a.gaps.total, 'number');
    for (const g of a.gaps.last_classified) {
      assert.ok(!['unclassified', 'pending'].includes(g.verdict),
        `${g.verdict} is the classifier declining to guess — it is counted in by_class, never shown as classified`);
    }
  });
});
