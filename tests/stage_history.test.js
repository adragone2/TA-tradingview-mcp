/**
 * THE OWNER'S CYCLE MACHINE — its transition table, its drawn labels, and the
 * things it must never do.
 *
 * Every assertion here guards a failure that would be SILENT. A machine that
 * merged with `classifyStage` would drift from a frozen construct with nothing
 * saying so. A threshold buried as a literal would be invisible to the parameter
 * sweep the owner has asked for. And a label matching no signature leaks an
 * orphan that can never be cleaned up, because TradingView entity ids die with
 * the desktop session and the text is the only handle left.
 *
 * The transition table is tested against SYNTHETIC COLUMNS rather than against
 * price fixtures. A state machine's rules are the thing under test; feeding it
 * handcrafted clause values pins one rule per test and cannot pass for the wrong
 * reason because a fixture happened to satisfy something else. The constructed
 * price series then proves the whole chain end to end.
 *
 * Run: node --test tests/stage_history.test.js
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  stageHistory, cycleColumns, runCycle, segmentsFrom, transitionsFrom,
  stageDrawPlan, drawStageHistory,
  transitionText, currentText, stateStage, isoDay, resolveParams,
  CYCLE_PARAMS, CYCLE_TRANSITIONS, CYCLE_STATES, CYCLE_NOISE_BASELINE, CYCLE_LABEL_GRAMMAR,
  CYCLE_COLORS, COLUMN_PARAMS, THRESHOLD_PARAMS, MAX_TRANSITIONS_DRAWN, STATE_NAMES, UNDETERMINED,
} from '../src/core/stage_history.js';
import { classifyStage } from '../src/core/stages.js';
import {
  bbBandwidthSeries, bbBandwidthPercentile, volumeRatio, resolveOperand, buildContext, OPERANDS,
} from '../src/core/strategy.js';
import { isMcpText, SIGNATURES_BY_SOURCE } from '../src/core/orphans.js';

const T0 = Date.parse('2021-01-04T00:00:00Z') / 1000;

// ── fixtures ────────────────────────────────────────────────────────────────

/**
 * Handcrafted COLUMNS. `cycleColumns` returns numbers, never verdicts, so a test
 * can hand `runCycle` exactly the clause values it wants to exercise.
 *
 * `spec` is a per-bar array of shorthand: which clauses should be TRUE on that bar.
 */
function columnsFor(spec) {
  const n = spec.length;
  const col = (f) => spec.map(f);
  return {
    bars: n,
    // <= 33 is sideways; 90 is decidedly not.
    bandwidth_pctile: col((s) => (s.includes('sideways') ? 10 : 90)),
    // >= 1.5 is a spike; the direction comes from closed_up.
    vol_ratio: col((s) => (s.includes('buy_spike') || s.includes('sell_spike') ? 3 : 1)),
    // < 0.8 is fading.
    fade_ratio: col((s) => (s.includes('fading') ? 0.5 : 1)),
    sma: col(() => 100),
    /**
     * |slope| < 0.05 is flat; the sign gives rising/falling. The DEFAULT is null —
     * "the slope is unavailable", so rising, falling and flat are all false. A
     * default of 0.5 would make `rising` true on every bar that did not ask for it,
     * and half these tests would then pass for the wrong reason.
     */
    /**
     * `falling_flat` is a SMALL NEGATIVE slope: both `falling` and `flat` are true
     * of it, because they are overlapping predicates on one number — exactly as
     * they are in the real columns, and exactly the case the table's ordering has
     * to resolve.
     */
    slope_pct: col((s) => (s.includes('falling_flat') ? -0.001
      : s.includes('flat') ? 0.001
        : s.includes('falling') ? -0.5
          : s.includes('rising') ? 0.5 : null)),
    closed_up: col((s) => (s.includes('sell_spike') ? -1 : 1)),
    params: {},
  };
}

/** Bars whose closes rise by 1 a bar, so `breakout` is satisfied whenever a base high exists. */
const risingBars = (n) => Array.from({ length: n }, (_, i) => ({
  time: T0 + i * 86400, open: 100 + i, high: 100.4 + i, low: 99.6 + i, close: 100 + i, volume: 1e6,
}));

/** Bars whose closes never exceed the first bar's high, so `breakout` can never fire. */
const flatBars = (n) => Array.from({ length: n }, (_, i) => ({
  time: T0 + i * 86400, open: 100, high: 101, low: 99, close: 100, volume: 1e6,
}));

const states = (readings) => {
  const out = [];
  for (const r of readings) {
    const l = out[out.length - 1];
    if (l && l.state === r.state) l.bars += 1; else out.push({ state: r.state, from: r.index, bars: 1 });
  }
  return out;
};

/**
 * A constructed full cycle: wide chop, a prior advance, a tight base, a breakout
 * bar on 4x volume, an advance, DECAYING volume into a flattening average, a
 * decline with a selling spike, then quiet.
 *
 * The volume DECAYS rather than stepping down, and that is load-bearing: the
 * owner's fade clause compares a 20-bar mean to a 120-bar mean, so a step down
 * self-normalises after ~120 bars and `fading` stops firing. A steady decay keeps
 * it live, which is what "volume drying up" actually looks like.
 */
function cycleFixture() {
  const bars = []; let p = 100; let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const push = (close, vol) => bars.push({
    time: T0 + bars.length * 86400, open: close, high: close + 0.4, low: close - 0.4, close, volume: Math.round(vol),
  });
  for (let i = 0; i < 200; i += 1) { p += (rnd() - 0.5) * 4; push(p, 1e6 * (0.85 + rnd() * 0.3)); }
  for (let i = 0; i < 150; i += 1) { p += 0.25 + (rnd() - 0.5) * 0.8; push(p, 1e6 * (0.85 + rnd() * 0.3)); }
  for (let i = 0; i < 60; i += 1) { p += (rnd() - 0.5) * 0.3; push(p, 950000 * (0.95 + rnd() * 0.1)); }
  const baseHigh = Math.max(...bars.slice(-60).map((b) => b.high));
  p = baseHigh + 3; push(p, 4e6);                                     // the breakout bar
  for (let i = 0; i < 40; i += 1) { p += 0.5; push(p, 1.1e6 * (0.95 + rnd() * 0.1)); }
  for (let i = 0; i < 200; i += 1) { p += (rnd() - 0.5) * 0.3; push(p, 1e6 * Math.exp(-0.008 * i) * (0.97 + rnd() * 0.06)); }
  for (let i = 0; i < 200; i += 1) { p -= 0.7; push(p, i === 40 ? 3e6 : 200000 * (0.95 + rnd() * 0.1)); }
  for (let i = 0; i < 260; i += 1) { p += (rnd() - 0.5) * 0.2; push(p, 250000 * Math.exp(-0.008 * i) * (0.97 + rnd() * 0.06)); }
  return bars;
}

/** Records what each `put` was handed AND what `drawShape` was called with. */
function recorder() {
  const calls = [];
  return {
    calls,
    drawShape: async (args) => ({ success: true, entity_id: `id-${calls.length + 1}`, ...args }),
    put: async (fn, label) => { const r = await fn(); calls.push({ label, ...r }); return r; },
  };
}

// ── this is the OWNER'S machine, and it is NOT classifyStage ───────────────

describe('the owner\'s machine is its own construct — classifyStage is cross-referenced, never merged', () => {
  const src = readFileSync(`${process.cwd()}/src/core/stage_history.js`, 'utf8');

  test('none of classifyStage\'s clause names appear here', () => {
    /**
     * Shannon's classifier builds its verdict from three clause groups whose names
     * are distinctive. If any appears in this file somebody has started merging two
     * frozen constructs, and two copies of a definition drift silently — the failure
     * assessment.js opens by forbidding.
     */
    for (const clause of ['price_above_all', 'price_below_all', 'all_rising', 'all_falling', 'stacked_up', 'stacked_down']) {
      assert.ok(!src.includes(clause), `stage_history.js mentions "${clause}" — those clauses belong to stages.js`);
    }
    assert.ok(!/function\s+classifyStage/.test(src), 'a second classifyStage would shadow the frozen one');
  });

  test('classifyStage is called ONCE, for the cross-reference, and never swept', () => {
    const calls = (src.match(/classifyStage\(/g) || []).length;
    assert.equal(calls, 1, `classifyStage is called ${calls} times — the cross-reference needs exactly one, at the last bar`);
    assert.ok(!/for\s*\([^)]*\)\s*\{[^}]*classifyStage/.test(src), 'and it must not sit inside a loop');
    assert.match(src, /shannon_cross_reference/, 'the reading must be reported in its own labelled block');
  });

  test('BEHAVIOURALLY: the cycle state and Shannon\'s stage are computed independently', () => {
    /**
     * A source contract can be satisfied by an import that is never called, and by
     * a call whose result is thrown away. This is the one that cannot: on a fixture
     * where the two constructs DISAGREE, both readings must still be present and
     * both must be correct.
     */
    const bars = cycleFixture();
    const h = stageHistory(bars);
    const direct = classifyStage(bars);
    assert.equal(h.shannon_cross_reference.stage, direct.stage,
      'the cross-reference must be exactly what the frozen classifier says');
    assert.equal(h.shannon_cross_reference.available, direct.available);
    assert.ok(h.current.state, 'and the cycle must have its own answer beside it');
    assert.equal(h.shannon_cross_reference.cycle_stage, h.current.stage);
    // `agrees` is NULL when either side has no stage — "they disagree" and "one of
    // them declined to answer" are different facts.
    assert.equal(
      h.shannon_cross_reference.agrees,
      direct.stage != null && h.current.stage != null ? direct.stage === h.current.stage : null,
    );
    assert.match(h.shannon_cross_reference.construct, /DIFFERENT machine/);
    assert.match(h.shannon_cross_reference.forward_tested_negative, /33\.5% vs a 36\.4%/);
  });

  test('the vocabulary clash is stated where it will be read', () => {
    // The owner's ACCUMULATION is the ADVANCE (Weinstein stage 2). Wyckoff and
    // Weinstein both use that word for the BASE. It is the one misreading this
    // module can cause, so it is written on the state itself.
    assert.equal(CYCLE_STATES.base.stage, 1);
    assert.equal(CYCLE_STATES.accumulation.stage, 2);
    assert.equal(CYCLE_STATES.distribution.stage, 3);
    assert.equal(CYCLE_STATES.declining.stage, 4);
    assert.match(CYCLE_STATES.base.note, /Weinstein and Wyckoff both call this phase ACCUMULATION/);
    for (const s of STATE_NAMES) {
      assert.equal(CYCLE_STATES[s].weinstein_equivalent, `stage ${CYCLE_STATES[s].stage}`);
    }
    assert.equal(stateStage(UNDETERMINED), null);
  });
});

// ── every threshold is a named knob ────────────────────────────────────────

describe('every threshold is an option with a named default — nothing buried in a condition', () => {
  test('the owner\'s four numbers are present, labelled, and are the defaults', () => {
    const p = resolveParams({});
    assert.equal(p.base_pctile_max, 33);
    assert.equal(p.spike_mult, 1.5);
    assert.equal(p.fade_ratio, 0.8);
    assert.equal(p.fade_trailing_window, 120);
    assert.equal(p.sma_period, 150);
    for (const k of ['base_pctile_max', 'spike_mult', 'fade_ratio', 'fade_trailing_window', 'sma_period']) {
      assert.equal(CYCLE_PARAMS[k].source, 'owner', `${k} is the owner's number and must be labelled so`);
    }
  });

  test('every knob we chose is labelled OURS, and the flat threshold is the HOUSE one', () => {
    for (const k of ['bb_length', 'bb_mult', 'pctile_window', 'pctile_min_samples',
      'spike_avg_window', 'fade_recent_window', 'slope_lookback']) {
      assert.equal(CYCLE_PARAMS[k].source, 'ours', `${k} is our operationalisation and must say so`);
    }
    // The two ambiguity knobs graduated from 'ours' to 'owner' when the owner
    // ruled on both (2026-07-31): base breakdown is an exit/short signal, and
    // the heartbeat reading makes compression part of distribution.
    for (const k of ['allow_base_to_declining', 'distribution_requires_sideways']) {
      assert.equal(CYCLE_PARAMS[k].source, 'owner', `${k} carries the owner's ruling and must say so`);
    }
    assert.equal(CYCLE_PARAMS.flat_slope_pct.source, 'house');
    assert.equal(CYCLE_PARAMS.flat_slope_pct.value, 0.05);
    // The same number patterns.js uses, and it must stay the same number.
    const patterns = readFileSync(`${process.cwd()}/src/core/patterns.js`, 'utf8');
    assert.match(patterns, /flat_slope_pct = 0\.05/,
      'the house flat convention moved — re-derive it here rather than letting two numbers drift');
  });

  test('no threshold is a literal inside a condition', () => {
    /**
     * The owner has said their numbers are defaults, not settled, and a sweep will
     * move them. A literal in a comparison is invisible to that sweep, so the state
     * machine is asserted to compare only against `p.<knob>`.
     */
    const src = readFileSync(`${process.cwd()}/src/core/stage_history.js`, 'utf8');
    const machine = src.slice(src.indexOf('function clausesAt'), src.indexOf('export function segmentsFrom'));
    for (const literal of ['33', '1.5', '0.8', '0.05']) {
      assert.ok(!new RegExp(`[<>=]=?\\s*${literal.replace('.', '\\.')}\\b`).test(machine),
        `the state machine compares against the literal ${literal} — a sweep cannot move it`);
    }
    for (const knob of ['spike_mult', 'base_pctile_max', 'fade_ratio', 'flat_slope_pct']) {
      assert.ok(machine.includes(`p.${knob}`), `${knob} must be read from the resolved params`);
    }
  });

  test('every knob is enumerable, and split by whether it invalidates the columns', () => {
    // This is what lets a grid script hold the expensive series fixed.
    assert.deepEqual([...COLUMN_PARAMS, ...THRESHOLD_PARAMS].sort(), Object.keys(CYCLE_PARAMS).sort());
    assert.equal(COLUMN_PARAMS.length + THRESHOLD_PARAMS.length, Object.keys(CYCLE_PARAMS).length);
    for (const k of THRESHOLD_PARAMS) assert.equal(CYCLE_PARAMS[k].affects, 'thresholds');
    for (const k of COLUMN_PARAMS) assert.equal(CYCLE_PARAMS[k].affects, 'columns');
    assert.ok(COLUMN_PARAMS.includes('sma_period') && THRESHOLD_PARAMS.includes('spike_mult'));
  });

  test('THE SWEEP SPLIT IS REAL: threshold knobs change the answer without touching the columns', () => {
    /**
     * The property the sweep interface rests on. If a threshold leaked into
     * `cycleColumns` this would silently stop being true and a grid would compute
     * one config's columns and evaluate another's rules against them.
     */
    const bars = cycleFixture();
    const cols = cycleColumns(bars);
    const loose = states(runCycle(bars, cols, { spike_mult: 1.2 }).readings);
    const tight = states(runCycle(bars, cols, { spike_mult: 9 }).readings);
    assert.notDeepEqual(loose, tight, 'a threshold change must move the state path over FIXED columns');
    assert.ok(!tight.some((s) => s.state === 'accumulation'), 'a 9x spike requirement must block the entry');
    // and the columns really are threshold-free
    const a = cycleColumns(bars, { spike_mult: 1.2 });
    const b = cycleColumns(bars, { spike_mult: 9 });
    assert.deepEqual(a.vol_ratio, b.vol_ratio, 'spike_mult must not reach cycleColumns');
    assert.deepEqual(a.bandwidth_pctile, b.bandwidth_pctile);
  });

  test('a column knob DOES change the columns, which is why it is grouped separately', () => {
    const bars = cycleFixture();
    assert.notDeepEqual(
      cycleColumns(bars, { sma_period: 150 }).slope_pct,
      cycleColumns(bars, { sma_period: 50 }).slope_pct,
    );
  });
});

// ── the transition table, one rule at a time, over synthetic columns ───────

describe('the transition table — the owner\'s rules, one per test', () => {
  /** Run the machine over a per-bar clause spec and return the state at each bar. */
  const run = (spec, bars, opts = {}) => runCycle(bars, columnsFor(spec), opts).readings.map((r) => r.state);

  test('a series opens in UNDETERMINED and enters BASE on the sideways clause alone', () => {
    /**
     * The owner gave BASE a STATE definition — "sideways, bandwidth percentile
     * <= 33" — where accumulation and distribution are given as SIGNALS. So the
     * opening entry to base needs only that clause.
     */
    const s = run([[], [], ['sideways'], ['sideways']], flatBars(4));
    assert.deepEqual(s, [UNDETERMINED, UNDETERMINED, 'base', 'base']);
  });

  test('UNDETERMINED can also open straight into DECLINING — a chart can arrive already falling', () => {
    const s = run([[], ['falling', 'sell_spike']], flatBars(2));
    assert.deepEqual(s, [UNDETERMINED, 'declining']);
  });

  test('ACCUMULATION and DISTRIBUTION are NOT reachable from UNDETERMINED', () => {
    /**
     * Both are defined relative to something the machine must have SEEN:
     * accumulation needs a breakout above the base's own high, and there is no base
     * yet; distribution is an exit from an advance that was never observed.
     */
    assert.deepEqual(Object.keys(CYCLE_TRANSITIONS.undetermined ? {} : {}), []);
    assert.deepEqual(CYCLE_TRANSITIONS.undetermined.map((r) => r.to), ['base', 'declining']);
    const s = run([['buy_spike', 'rising'], ['fading', 'flat'], ['buy_spike', 'rising']], risingBars(3));
    assert.deepEqual(s, [UNDETERMINED, UNDETERMINED, UNDETERMINED]);
  });

  test('BASE -> ACCUMULATION needs ALL THREE of buy_spike, breakout and rising', () => {
    const bars = risingBars(6);
    // all three: fires
    assert.equal(run([['sideways'], ['buy_spike', 'rising']], bars)[1], 'accumulation');
    // each one missing: does not
    assert.equal(run([['sideways'], ['rising']], bars)[1], 'base', 'no spike, no entry');
    assert.equal(run([['sideways'], ['buy_spike']], bars)[1], 'base', 'no rising average, no entry');
    assert.equal(run([['sideways'], ['buy_spike', 'falling']], bars)[1], 'base', 'a falling average blocks it');
    assert.equal(run([['sideways'], ['sell_spike', 'rising']], bars)[1], 'base',
      'a SELLING spike is not a buying one — the sign convention is the clause');
    // and with no breakout available at all
    assert.equal(run([['sideways'], ['buy_spike', 'rising']], flatBars(6))[1], 'base',
      'no close above the base\'s own high, no entry');
  });

  test('the BREAKOUT is above the base\'s OWN high, measured to the PREVIOUS bar', () => {
    /**
     * A close cannot exceed a high that includes it, so an inclusive running max
     * would make `breakout` unreachable and the machine would never leave BASE. The
     * consequence: the bar that ESTABLISHES a base has no level yet, and the level
     * available on the next bar is the running max up to the previous one.
     */
    const bars = risingBars(5);
    const s = run([['sideways', 'buy_spike', 'rising'], ['buy_spike', 'rising']], bars);
    assert.equal(s[0], 'base', 'the bar that establishes the base has no base high to clear');
    assert.equal(s[1], 'accumulation', 'the next one clears bar 0\'s high');
    const { readings } = runCycle(bars, columnsFor([['sideways', 'buy_spike', 'rising'], ['buy_spike', 'rising']]), {});
    assert.equal(readings[1].broke_above, bars[0].high, 'the running max of the base up to the previous bar');
    assert.equal(readings[0].broke_above, undefined, 'and nothing is reported when nothing was cleared');
  });

  test('ACCUMULATION -> DISTRIBUTION on fading AND flat AND sideways (the heartbeat ruling)', () => {
    const bars = risingBars(6);
    const spec = [['sideways'], ['buy_spike', 'rising'], [], ['fading', 'flat', 'sideways']];
    assert.deepEqual(run(spec, bars), ['base', 'accumulation', 'accumulation', 'distribution']);
    assert.equal(run([['sideways'], ['buy_spike', 'rising'], [], ['fading', 'flat']], bars)[3],
      'accumulation', 'without compression the exit does not fire under the ruling');
    assert.equal(run([['sideways'], ['buy_spike', 'rising'], [], ['fading']], bars)[3],
      'accumulation', 'fading alone is not the exit');
    assert.equal(run([['sideways'], ['buy_spike', 'rising'], [], ['flat']], bars)[3],
      'accumulation', 'and neither is a flat average alone');
  });

  test('DECLINING is checked BEFORE the softer exit, and the order is load-bearing', () => {
    /**
     * "fading and flat" and "falling with a selling spike" are NOT exclusive: `flat`
     * and `falling` are overlapping predicates on ONE slope number — a small
     * negative slope is both — and a single heavy down bar inside a quiet stretch
     * supplies the rest. So the table order decides, and a confirmed decline is the
     * more specific statement.
     */
    const bars = risingBars(6);
    // 'sideways' present in both specs so the softer exit is live under the
    // heartbeat ruling — the ordering, not clause availability, decides.
    const both = [['sideways'], ['buy_spike', 'rising'], [], ['fading', 'falling_flat', 'sell_spike', 'sideways']];
    assert.equal(run(both, bars)[3], 'declining');
    // and the same bar WITHOUT the spike takes the softer exit, proving the two
    // rows really were both live.
    assert.equal(run([['sideways'], ['buy_spike', 'rising'], [], ['fading', 'falling_flat', 'sideways']], bars)[3], 'distribution');
    assert.equal(CYCLE_TRANSITIONS.accumulation[0].to, 'declining', 'and the table must keep that order');
    assert.equal(CYCLE_TRANSITIONS.distribution[0].to, 'declining');
  });

  test('DISTRIBUTION and DECLINING both return to BASE on fading AND flat AND sideways', () => {
    const bars = risingBars(8);
    // Under the heartbeat ruling distribution's entry needs sideways too, so it
    // becomes the 1-bar waypoint the module documents: exit event, then base.
    const viaDist = [['sideways'], ['buy_spike', 'rising'], [], ['fading', 'flat', 'sideways'], ['fading', 'flat', 'sideways']];
    assert.deepEqual(run(viaDist, bars).slice(3), ['distribution', 'base']);
    const viaDecl = [['falling', 'sell_spike'], ['fading', 'flat'], ['fading', 'flat', 'sideways']];
    assert.deepEqual(run(viaDecl, bars), ['declining', 'declining', 'base']);
    assert.equal(run([['falling', 'sell_spike'], ['fading', 'flat']], bars)[1], 'declining',
      'the return to base needs the sideways clause too — that is what keeps it stronger than DISTRIBUTION');
  });

  test('HYSTERESIS: a bar matching no transition KEEPS its state', () => {
    // Without it a machine of instantaneous clauses flaps every quiet bar, and the
    // owner's states are meant to describe stretches.
    const s = run([[], ['sideways'], [], [], []], flatBars(5));
    assert.deepEqual(s, [UNDETERMINED, 'base', 'base', 'base', 'base']);
  });

  test('WEAKENING marks a partly-satisfied exit, and names which one', () => {
    const bars = risingBars(6);
    const { readings } = runCycle(bars, columnsFor([['sideways'], ['buy_spike', 'rising'], ['fading']]), {});
    assert.equal(readings[1].state, 'accumulation');
    assert.equal(readings[2].state, 'accumulation', 'still accumulation');
    assert.equal(readings[2].weakening, true, 'but under pressure');
    assert.equal(readings[2].weakening_toward, 'distribution');
  });

  test('a bar that TAKES a transition is never also weakening', () => {
    const bars = risingBars(6);
    const { readings } = runCycle(bars, columnsFor([['sideways'], ['buy_spike', 'rising']]), {});
    assert.equal(readings[1].entered, true);
    assert.equal(readings[1].weakening, undefined);
    assert.deepEqual(readings[1].entered_clauses, ['buy_spike', 'breakout', 'rising']);
  });

  test('a state with NO satisfied exit clause is not weakening either', () => {
    const { readings } = runCycle(flatBars(4), columnsFor([['sideways'], [], [], []]), {});
    assert.equal(readings[2].weakening, undefined, 'zero of three is holding, not weakening');
  });

  test('UNDETERMINED is never re-entered once a state is established', () => {
    const s = run([['sideways'], [], [], [], []], flatBars(5));
    assert.ok(!s.slice(1).includes(UNDETERMINED), 'the machine must not reset to ignorance');
  });
});

// ── the two exposed ambiguities ────────────────────────────────────────────

describe('the two ambiguities are OPTIONS with stated defaults, not silent decisions', () => {
  const run = (spec, bars, opts) => runCycle(bars, columnsFor(spec), opts).readings.map((r) => r.state);

  test('allow_base_to_declining is ON by the owner ruling, and off restores the literal dead end', () => {
    /**
     * RULED 2026-07-31: "a base that breaks down is either an exit or a short
     * signal." The literal arrow list had no exit from BASE except the entry —
     * measured on the constructed fixture, a decline with a selling spike out
     * of a base left the machine reading "base" throughout. The option remains
     * so the literal reading is one flag away, never lost.
     */
    assert.equal(CYCLE_PARAMS.allow_base_to_declining.value, true);
    assert.equal(CYCLE_PARAMS.allow_base_to_declining.source, 'owner');
    const spec = [['sideways'], ['falling', 'sell_spike'], ['falling', 'sell_spike']];
    assert.deepEqual(run(spec, flatBars(4)), ['base', 'declining', 'declining']);
    assert.deepEqual(run(spec, flatBars(4), { allow_base_to_declining: false }),
      ['base', 'base', 'base'], 'off restores the literal arrow list, dead end and all');
    assert.match(CYCLE_PARAMS.allow_base_to_declining.note, /exit or a short signal/);

    // End to end on the price fixture: DECLINING is reachable by default now.
    const bars = cycleFixture();
    const dflt = states(runCycle(bars, cycleColumns(bars)).readings).map((s) => s.state);
    const literal = states(runCycle(bars, cycleColumns(bars), { allow_base_to_declining: false }).readings).map((s) => s.state);
    assert.ok(dflt.includes('declining'));
    assert.ok(!literal.includes('declining'), 'the literal cycle strands the machine in base through a decline');
  });

  test('a disabled row is absent from the WEAKENING test too, not only from the transition', () => {
    // A state cannot be "weakening toward" an exit the machine is not allowed to
    // take. The row defaults ON now, so the disabled arm is the explicit false.
    const spec = [['sideways'], ['falling']];
    assert.equal(runCycle(flatBars(3), columnsFor(spec), { allow_base_to_declining: false }).readings[1].weakening, undefined);
    assert.equal(
      runCycle(flatBars(3), columnsFor(spec), {}).readings[1].weakening_toward,
      'declining',
    );
  });

  test('distribution_requires_sideways is ON by the owner heartbeat ruling', () => {
    /**
     * RULED 2026-07-31: the cycle is "like a heartbeat" — compression is part
     * of DISTRIBUTION's signature, so the parenthetical in their text IS the
     * definition. fading + flat alone no longer qualifies; add sideways and it
     * does. Off restores the slope-only reading.
     */
    assert.equal(CYCLE_PARAMS.distribution_requires_sideways.value, true);
    assert.equal(CYCLE_PARAMS.distribution_requires_sideways.source, 'owner');
    const bars = risingBars(6);
    const spec = [['sideways'], ['buy_spike', 'rising'], [], ['fading', 'flat']];
    assert.equal(run(spec, bars)[3], 'accumulation', 'fading + flat without compression is not distribution now');
    assert.equal(run(spec, bars, { distribution_requires_sideways: false })[3], 'distribution',
      'the slope-only reading is one flag away');
    const spec2 = [['sideways'], ['buy_spike', 'rising'], [], ['fading', 'flat', 'sideways']];
    assert.equal(run(spec2, bars)[3], 'distribution', 'with compression the exit fires by default');
    assert.match(CYCLE_PARAMS.distribution_requires_sideways.note, /heartbeat/i);
  });
});

// ── the columns: the numbers, and where they come from ────────────────────

describe('cycleColumns returns NUMBERS, and shares one definition with the DSL', () => {
  const bars = cycleFixture();

  test('the bandwidth percentile is the SAME function the operand uses', () => {
    /**
     * `bb_bandwidth_pctile(N)` and this machine must not disagree about what they
     * measure, so both go through strategy.js's series. A private copy here would
     * drift and a criterion would silently stop meaning the same thing as the
     * detector it was written for.
     */
    const cols = cycleColumns(bars);
    const closes = bars.map((b) => b.close);
    assert.equal(cols.bandwidth_pctile.at(-1), bbBandwidthPercentile(closes, { window: 252 }));
    assert.equal(cols.vol_ratio.at(-1), volumeRatio(bars, 20));
  });

  test('bandwidth is (upper - lower) / middle on POPULATION sd, and null before warm-up', () => {
    const flat = new Array(30).fill(100);
    assert.equal(bbBandwidthSeries(flat).at(-1), 0, 'a constant series has zero bandwidth');
    assert.equal(bbBandwidthSeries(flat)[18], null, 'null before the 20-bar window fills');
    // 2 * mult * sd / mid, with sd the population deviation.
    const v = [...new Array(19).fill(100), 120];
    const win = v.slice(-20);
    const mid = win.reduce((a, b) => a + b, 0) / 20;
    const sd = Math.sqrt(win.reduce((a, b) => a + (b - mid) ** 2, 0) / 20);
    assert.ok(Math.abs(bbBandwidthSeries(v).at(-1) - (4 * sd) / mid) < 1e-12);
  });

  test('volume_ratio EXCLUDES the current bar from its own baseline', () => {
    // Including it lets a spike lift the average it is compared against: a bar at
    // 4x would read 3.24x at length 20 instead of 4x.
    const b = [...new Array(20).fill(0).map(() => ({ close: 1, volume: 100 })), { close: 1, volume: 400 }];
    assert.equal(volumeRatio(b, 20), 4);
  });

  test('the spike SIGN convention: up is buying, down is selling, unchanged is NEITHER', () => {
    const cols = cycleColumns([
      { time: T0, close: 10, high: 10, low: 10, volume: 1 },
      { time: T0 + 1, close: 11, high: 11, low: 11, volume: 1 },
      { time: T0 + 2, close: 10, high: 10, low: 10, volume: 1 },
      { time: T0 + 3, close: 10, high: 10, low: 10, volume: 1 },
    ]);
    assert.deepEqual(cols.closed_up, [null, 1, -1, 0],
      'an unchanged close is a real volume event with no direction — calling it one would invent the clause');
  });

  test('a missing value is NULL, never 0 — Number(null) is 0 and 0 reads as maximal compression', () => {
    const cols = cycleColumns(flatBars(10));
    assert.ok(cols.bandwidth_pctile.every((v) => v === null), 'ten bars cannot produce a 252-bar percentile');
    assert.ok(cols.slope_pct.every((v) => v === null));
    assert.equal(cycleColumns([]).bars, 0);
    assert.equal(cycleColumns(null).bars, 0);
  });

  test('the columns depend only on the column knobs', () => {
    const keys = Object.keys(cycleColumns(bars).params);
    assert.deepEqual(keys.sort(), [...COLUMN_PARAMS].sort());
  });
});

// ── segments, transitions, the current state ──────────────────────────────

describe('segments and transitions', () => {
  const bars = cycleFixture();
  const h = stageHistory(bars);

  test('the constructed cycle walks the FULL heartbeat under the owner rulings', () => {
    /**
     * Updated with the rulings (2026-07-31): the fixture's final decline —
     * previously invisible from base, the dead end — now reads base ->
     * declining -> base, which is the allow_base_to_declining ruling doing
     * exactly what the owner said: a base that breaks down is a signal.
     */
    assert.deepEqual(h.segments.map((s) => s.state),
      [UNDETERMINED, 'base', 'accumulation', 'distribution', 'base', 'declining', 'base']);
    assert.equal(h.current.state, 'base');
    assert.ok(h.segments.find((s) => s.state === 'accumulation').broke_above > 0,
      'the entry segment must carry the base high it cleared');
  });

  test('segments are contiguous, ordered, and account for every bar', () => {
    let expected = 0;
    for (const s of h.segments) {
      assert.equal(s.from_index, expected, 'a gap or an overlap between segments');
      assert.equal(s.to_index, s.from_index + s.bars - 1);
      assert.equal(s.from_time, bars[s.from_index].time, 'segment times must be real bar times');
      assert.equal(s.to_time, bars[s.to_index].time);
      expected += s.bars;
    }
    assert.equal(expected, bars.length);
  });

  test('every transition sits on the FIRST bar of the segment it opens', () => {
    assert.equal(h.transitions.length, h.segments.length - 1);
    h.transitions.forEach((t, i) => {
      assert.equal(t.from, h.segments[i].state);
      assert.equal(t.to, h.segments[i + 1].state);
      assert.equal(t.index, h.segments[i + 1].from_index);
      assert.equal(t.time, h.segments[i + 1].from_time);
      assert.equal(t.prior_segment_bars, h.segments[i].bars);
      assert.ok(Array.isArray(t.clauses) && t.clauses.length, 'and it must carry the clauses that fired');
    });
  });

  test('the FIRST segment opening is not reported as a transition', () => {
    // Nothing was observed before it.
    assert.ok(!h.transitions.some((t) => t.index === 0));
    assert.equal(transitionsFrom([{ state: 'base', from_index: 5 }]).length, 0);
    assert.deepEqual(transitionsFrom(), []);
    assert.deepEqual(segmentsFrom(), []);
  });

  test('the current segment carries its state, its start and its bar count', () => {
    const last = h.segments.at(-1);
    assert.equal(h.current.since, last.from_time);
    assert.equal(h.current.since_date, isoDay(last.from_time));
    assert.equal(h.current.bars, last.bars);
    assert.equal(h.current.stage, stateStage(last.state));
    assert.equal(h.current.weinstein_equivalent, `stage ${h.current.stage}`);
    assert.equal(h.current.text, currentText(h.current));
  });

  test('occupancy covers every state and sums to the bar count', () => {
    const total = Object.values(h.occupancy).reduce((n, o) => n + o.bars, 0);
    assert.equal(total, bars.length);
    for (const s of [UNDETERMINED, ...STATE_NAMES]) assert.ok(h.occupancy[s], `${s} missing from occupancy`);
    assert.equal(h.undetermined_bars, h.occupancy[UNDETERMINED].bars);
  });

  test('one-bar segments are REPORTED as flickers, never smoothed away', () => {
    // Under the owner's defaults DISTRIBUTION is routinely a one-bar waypoint,
    // because the return to BASE fires on the very next bar whenever sideways also
    // holds. Smoothing it would delete a real reading.
    assert.equal(h.segments.find((s) => s.state === 'distribution').bars, 1);
    assert.ok(h.flicker_segments >= 1);
  });

  test('too few bars establishes nothing, and says so rather than claiming a state', () => {
    const h2 = stageHistory(flatBars(30));
    assert.equal(h2.available, false);
    assert.match(h2.why, /Too few bars is NOT a verdict about the cycle/);
    assert.equal(h2.current.state, UNDETERMINED);
    for (const input of [null, undefined, []]) {
      assert.equal(stageHistory(input).available, false);
      assert.match(stageHistory(input).why, /nothing to classify/);
    }
  });

  test('the gate is resampled with the partial bar dropped, and its emptiness is EXPLAINED', () => {
    // The machine's windows are in bars OF THAT SERIES, so a 150-period average of
    // weekly bars is ~3 years. An empty gate with no explanation reads as a finding.
    assert.equal(h.gate.grouped_by, 'week');
    assert.equal(typeof h.gate.partial_bar_dropped, 'boolean');
    if (h.gate.bars - h.gate.undetermined_bars === 0) {
      assert.match(h.gate_too_short, /windows are in BARS OF THAT SERIES/);
    }
  });
});

// ── the honesty rails carried in the output ───────────────────────────────

describe('the output carries the noise floor and the descriptive framing', () => {
  const h = stageHistory(cycleFixture());

  test('the ENTRY signal\'s noise floor travels with every reading', () => {
    assert.equal(CYCLE_NOISE_BASELINE.status, 'MEASURED');
    assert.equal(CYCLE_NOISE_BASELINE.entry_signal_walks_reaching_pct.lognormal, 43.0);
    assert.equal(CYCLE_NOISE_BASELINE.entry_signal_walks_reaching_pct.gap_elevated, 52.5);
    assert.equal(h.noise_baseline, CYCLE_NOISE_BASELINE);
    assert.match(CYCLE_NOISE_BASELINE.verdict, /close to a coin flip/);
  });

  test('the FLAT volume arm is reported as degenerate rather than as a 0% floor', () => {
    /**
     * The ignition.js lesson: the plain harness emits near-constant volume, so every
     * volume-gated clause fires on 0% of it and a floor read there would be a number
     * about the generator. Reported, with the reason, instead of quoted.
     */
    const flat = CYCLE_NOISE_BASELINE.by_volume_mode.flat;
    assert.equal(flat.clause_fire_pct.buy_spike, 0);
    assert.equal(flat.clause_fire_pct.fading, 0);
    assert.equal(flat.walks_reaching_pct.accumulation, 0);
    assert.match(flat.note, /DEGENERATE/);
    assert.match(flat.note, /ignition\.js/);
  });

  test('DISTRIBUTION\'s near-zero floor is explained, not sold as selectivity', () => {
    assert.ok(CYCLE_NOISE_BASELINE.by_volume_mode.lognormal.walks_reaching_pct.distribution < 5);
    assert.ok(CYCLE_NOISE_BASELINE.by_volume_mode.lognormal.clause_fire_pct.fading < 1);
    assert.match(CYCLE_NOISE_BASELINE.verdict, /NOT the same finding|not the same finding/i);
  });

  test('the BASE occupancy is explained by the hysteresis, not read as "the chart is sideways"', () => {
    const m = CYCLE_NOISE_BASELINE.by_volume_mode.lognormal;
    assert.ok(m.occupancy_pct.base > m.clause_fire_pct.sideways * 2);
    assert.match(CYCLE_NOISE_BASELINE.what_the_occupancy_does_not_mean, /HYSTERESIS plus the dead end/);
  });

  test('the descriptive framing and the transition rules ship with the reading', () => {
    assert.match(h.descriptive_only, /forecasts nothing/);
    assert.match(h.descriptive_only, /ENTRY signal belongs to the strategy/);
    assert.equal(h.transition_rules, CYCLE_TRANSITIONS);
    assert.equal(h.params, CYCLE_PARAMS);
    assert.match(h.method, /cycleColumns computes the numbers/);
  });
});

// ── the labels ────────────────────────────────────────────────────────────

describe('the label grammar round-trips, and cannot claim a person\'s own text', () => {
  test('every form the emitter can write is REGISTERED', () => {
    const vocab = [UNDETERMINED, ...STATE_NAMES];
    for (const from of vocab) {
      for (const to of vocab) {
        const text = transitionText({ from, to, time: T0 });
        assert.equal(isMcpText(text, { sources: ['stage'] }), true, `unregistered: "${text}"`);
        assert.equal(isMcpText(text), true, `the flat union must reach it too: "${text}"`);
      }
    }
    for (const state of vocab) {
      for (const bars of [1, 2, 34, 1000]) {
        const text = currentText({ state, since: T0, bars });
        assert.equal(isMcpText(text, { sources: ['stage'] }), true, `unregistered: "${text}"`);
        assert.equal(isMcpText(text), true);
      }
    }
  });

  test('the singular is written and matched — "(1 bar)", not "(1 bars)"', () => {
    assert.equal(currentText({ state: 'base', since: T0, bars: 1 }), 'cycle base since 2021-01-04 (1 bar)');
    assert.equal(currentText({ state: 'base', since: T0, bars: 2 }), 'cycle base since 2021-01-04 (2 bars)');
    assert.equal(isMcpText('cycle base since 2021-01-04 (1 bar)', { sources: ['stage'] }), true);
  });

  test('NEAR MISSES ARE REFUSED — the cost of a false match is deleting the user\'s analysis', () => {
    /**
     * Missing an orphan leaves a stale line; a false match deletes somebody's own
     * work. Not symmetric, which is why both signatures are anchored end to end and
     * why every plausible hand-typed neighbour below must fail.
     */
    const THEIRS = [
      'cycle', 'cycle base', 'Cycle base>accumulation 2021-01-04',
      'cycle base -> accumulation 2021-01-04', 'cycle base > accumulation 2021-01-04',
      'cycle base to accumulation 2021-01-04', 'base>accumulation 2021-01-04',
      'cycle bull>bear 2021-01-04', 'cycle base>stage2 2021-01-04',
      'cycle base>accumulation 2021-1-4', 'cycle base>accumulation',
      'note: cycle base>accumulation 2021-01-04', 'cycle base>accumulation 2021-01-04 watch',
      'cycle accumulation since 2021-01-04', 'cycle accumulation since 2021-01-04 (34)',
      'cycle accumulation since 2021-01-04 (34 days)',
      'CYCLE ACCUMULATION SINCE 2021-01-04 (34 BARS)',
      // the first draft's grammar, which never reached a chart and is not kept
      'stage 1>2 2021-01-04', 'stage 2 since 2021-01-04 (34 bars)',
      '', '   ',
    ];
    for (const t of THEIRS) {
      assert.equal(isMcpText(t, { sources: ['stage'] }), false, `"${t}" would have been deleted`);
    }
  });

  test('the two sources cannot claim each other\'s drawings', () => {
    /**
     * `stage_draw` sweeps with sources:['stage'] so it can clear its own prior
     * output without touching the review's levels or a walls overlay the user
     * applied deliberately. That only holds if the groups are disjoint.
     */
    assert.equal(isMcpText('cycle base>accumulation 2021-01-04', { sources: ['review'] }), false);
    assert.equal(isMcpText('cycle base since 2021-01-04 (34 bars)', { sources: ['walls'] }), false);
    assert.equal(isMcpText('S 14.84 (0.07%)', { sources: ['stage'] }), false);
    assert.equal(isMcpText('D Call Wall 1250', { sources: ['stage'] }), false);
    assert.equal(isMcpText('TA stop 1862.51 (exit)', { sources: ['stage'] }), false);
  });

  test('the signatures are anchored at both ends, like every other one', () => {
    for (const re of SIGNATURES_BY_SOURCE.stage) {
      assert.ok(re.source.startsWith('^') && re.source.endsWith('$'), `not anchored: ${re.source}`);
    }
    assert.equal(SIGNATURES_BY_SOURCE.stage.length, 2, 'one signature per emitted format');
  });

  test('the grammar is documented beside the emitter, with worked examples', () => {
    assert.match(CYCLE_LABEL_GRAMMAR.registered_in, /orphans\.js/);
    for (const ex of CYCLE_LABEL_GRAMMAR.examples) {
      assert.equal(isMcpText(ex, { sources: ['stage'] }), true, `the documented example "${ex}" does not match`);
    }
  });
});

// ── the draw plan ─────────────────────────────────────────────────────────

describe('stageDrawPlan — pure, and everything withheld is reported', () => {
  const bars = cycleFixture();
  const h = stageHistory(bars);
  const base = { price: bars.at(-1).close, last_bar_time: bars.at(-1).time, bar_seconds: 86400, atr: 2 };

  test('one vertical_line per transition, plus ONE callout for the current segment', () => {
    const p = stageDrawPlan(h, base);
    const lines = p.shapes.filter((s) => s.shape === 'vertical_line');
    const callouts = p.shapes.filter((s) => s.shape === 'callout');
    assert.equal(lines.length, h.transitions.length);
    assert.equal(callouts.length, 1);
    assert.equal(callouts[0].text, h.current.text);
    assert.equal(p.drawn, lines.length + 1);
  });

  test('every drawn text is a registered signature', () => {
    // The single most important property in this file.
    for (const s of stageDrawPlan(h, base).shapes) {
      assert.equal(isMcpText(s.text, { sources: ['stage'] }), true,
        `"${s.text}" matches no stage signature — it would leak a permanent orphan`);
    }
  });

  test('a vertical_line is anchored to the transition bar\'s OWN time and price', () => {
    for (const s of stageDrawPlan(h, base).shapes.filter((x) => x.kind === 'transition')) {
      const t = h.transitions.find((x) => x.text === s.text);
      assert.equal(s.point.time, t.time, 'a boundary drawn at the wrong bar describes nothing');
      assert.equal(s.point.price, Math.round(t.price * 1e4) / 1e4, 'the drawn price is the bar\'s, at 4dp');
      assert.ok(bars.some((b) => b.time === s.point.time), 'and the time must be a real bar');
    }
  });

  test('the transition count is BOUNDED, most recent kept, the rest reported', () => {
    const many = {
      ...h,
      transitions: h.transitions.concat(Array.from({ length: 30 }, (_, i) => ({
        time: T0 + i * 86400, price: 100 + i, from: 'base', to: 'accumulation',
        text: transitionText({ from: 'base', to: 'accumulation', time: T0 + i * 86400 }),
      }))),
    };
    const p = stageDrawPlan(many, { ...base, max_transitions: 5 });
    assert.equal(p.transitions_drawn, 5);
    assert.equal(p.skipped.length, many.transitions.length - 5);
    assert.equal(p.transitions_available, many.transitions.length);
    assert.match(p.skipped[0].why, /5 most recent/);
    assert.deepEqual(
      p.shapes.filter((s) => s.kind === 'transition').map((s) => s.point.time),
      many.transitions.slice(-5).map((t) => t.time),
    );
  });

  test('the default bound is declared, not buried', () => {
    assert.equal(MAX_TRANSITIONS_DRAWN, 12);
    assert.equal(stageDrawPlan(h, base).max_transitions, 12);
  });

  test('only ONE series is drawn, and the gate is reachable', () => {
    // Two sets of vertical lines through the same bars is overprinting.
    const g = stageDrawPlan(h, { ...base, series: 'gate' });
    assert.equal(g.series, 'gate');
    assert.equal(g.shapes.filter((s) => s.kind === 'transition').length, h.gate.transitions.length);
    assert.match(stageDrawPlan(h, { ...base, series: 'nonsense' }).why, /no "nonsense" series/);
  });

  test('the callout offset is ATR-SCALED, and says so when it is not', () => {
    /**
     * A percentage is not a distance a chart can read: the fixed 0.4% the hline
     * merge used was 0.11 ATR on a median daily chart and 1.21 ATR on a 5-minute
     * one, and the INTRADAY tier analyses 5-minute charts.
     */
    const withAtr = stageDrawPlan(h, { ...base, atr: 2 });
    assert.equal(withAtr.callout_offset.basis, 'atr');
    assert.equal(withAtr.callout_offset.value, 4);
    for (const atr of [null, undefined, 0, NaN, -1]) {
      const p = stageDrawPlan(h, { ...base, atr });
      assert.equal(p.callout_offset.basis, 'fallback_pct', `atr ${String(atr)} must not be read as a real distance`);
      assert.match(p.callout_offset.note, /A percentage is not a distance/);
    }
  });

  test('the callout box steps LEFT, into the chart', () => {
    // The space right of the last bar carries TradingView's own labels.
    const p = stageDrawPlan(h, { ...base, callout_bars_left: 8, bar_seconds: 86400 });
    assert.ok(p.current.point2.time < p.current.point.time);
    assert.equal(p.current.point.time - p.current.point2.time, 8 * 86400);
    assert.ok(p.current.point2.price > p.current.point.price, 'and above it, clear of the price');
  });

  test('draw_current: false leaves the callout out entirely', () => {
    const p = stageDrawPlan(h, { ...base, draw_current: false });
    assert.equal(p.current, null);
    assert.equal(p.shapes.filter((s) => s.kind === 'current').length, 0);
    assert.equal(p.current_not_drawn, undefined, 'not drawing what was not asked for is not an omission');
  });

  test('a missing last bar time or price refuses the callout and SAYS SO', () => {
    for (const over of [{ last_bar_time: null }, { price: null, last_bar_time: null }]) {
      const p = stageDrawPlan(h, { ...base, ...over });
      assert.equal(p.current, null);
      assert.match(p.current_not_drawn, /last bar time|current segment/);
    }
  });

  test('colour comes from the DESTINATION state, and undetermined is grey', () => {
    // Grey, deliberately: an unestablished state must not look like a verdict.
    const fake = { available: true, transitions: [], current: null, gate: { transitions: [], current: null } };
    for (const to of [...STATE_NAMES, UNDETERMINED]) {
      const p = stageDrawPlan({
        ...fake,
        transitions: [{ time: T0, price: 10, from: 'base', to, text: transitionText({ from: 'base', to, time: T0 }) }],
      }, base);
      assert.equal(p.shapes[0].overrides.linecolor, CYCLE_COLORS[to]);
      assert.equal(p.shapes[0].overrides.textcolor, CYCLE_COLORS[to]);
    }
    assert.equal(CYCLE_COLORS[UNDETERMINED], '#787B86');
  });

  test('an unavailable history draws NOTHING and carries the reason through', () => {
    const p = stageDrawPlan(stageHistory(flatBars(30)), base);
    assert.deepEqual(p.shapes, []);
    assert.equal(p.drawn, 0);
    assert.match(p.why, /Too few bars is NOT a verdict/);
    assert.deepEqual(stageDrawPlan(null).shapes, []);
    assert.deepEqual(stageDrawPlan(undefined).shapes, []);
  });

  test('it says what it is NOT', () => {
    assert.match(stageDrawPlan(h, base).what_this_is_not, /Boundaries, not signals/);
    assert.match(stageDrawPlan(h, base).what_this_is_not, /UNTESTED/);
  });
});

// ── the injected-put wiring ───────────────────────────────────────────────

describe('drawStageHistory — the wiring, with put and drawShape injected', () => {
  const bars = cycleFixture();
  const h = stageHistory(bars);
  const plan = stageDrawPlan(h, {
    price: bars.at(-1).close, last_bar_time: bars.at(-1).time, bar_seconds: 86400, atr: 2,
  });

  test('every planned shape becomes exactly one drawShape call, in order', async () => {
    const r = recorder();
    const out = await drawStageHistory(plan, 'stage-TEST', r.put, r.drawShape);
    assert.equal(r.calls.length, plan.shapes.length);
    assert.equal(out.count, plan.shapes.length);
    assert.deepEqual(r.calls.map((c) => c.text), plan.shapes.map((s) => s.text));
    assert.deepEqual(r.calls.map((c) => c.shape), plan.shapes.map((s) => s.shape));
  });

  test('the GROUP reaches every shape — a shape outside the group can never be cleared', async () => {
    const r = recorder();
    await drawStageHistory(plan, 'stage-TEST', r.put, r.drawShape);
    for (const c of r.calls) assert.equal(c.group, 'stage-TEST');
  });

  test('overrides are passed as a JSON STRING, which is what drawShape parses', async () => {
    const r = recorder();
    await drawStageHistory(plan, 'g', r.put, r.drawShape);
    for (const c of r.calls) {
      assert.equal(typeof c.overrides, 'string');
      assert.ok(JSON.parse(c.overrides).linecolor || JSON.parse(c.overrides).color);
    }
  });

  test('the callout is the only shape given a second point', async () => {
    const r = recorder();
    await drawStageHistory(plan, 'g', r.put, r.drawShape);
    for (const c of r.calls) {
      if (c.shape === 'callout') assert.ok(c.point2, 'a callout is a TWO-point shape and keeps its text');
      else assert.equal(c.point2, undefined, 'a vertical_line takes ONE point');
    }
  });

  test('every text handed to drawShape is sweepable', async () => {
    const r = recorder();
    await drawStageHistory(plan, 'g', r.put, r.drawShape);
    for (const c of r.calls) {
      assert.equal(isMcpText(c.text, { sources: ['stage'] }), true, `unsweepable label reached the chart: "${c.text}"`);
    }
  });

  test('an empty plan draws nothing and does not throw', async () => {
    const r = recorder();
    assert.equal((await drawStageHistory({ shapes: [] }, 'g', r.put, r.drawShape)).count, 0);
    assert.equal((await drawStageHistory(null, 'g', r.put, r.drawShape)).count, 0);
    assert.equal(r.calls.length, 0);
  });
});

// ── the DSL operands ──────────────────────────────────────────────────────

describe('the two new DSL operands, and the one definition they share with the machine', () => {
  const bars = cycleFixture();
  const ctx = buildContext(bars);

  test('both are in the OPERANDS vocabulary, so the catalogue can validate them', () => {
    assert.ok(OPERANDS.includes('bb_bandwidth_pctile(N)'));
    assert.ok(OPERANDS.includes('volume_ratio(N)'));
  });

  test('they resolve to the same numbers the machine\'s columns carry', () => {
    const cols = cycleColumns(bars);
    assert.equal(resolveOperand('bb_bandwidth_pctile(252)', ctx).value, cols.bandwidth_pctile.at(-1));
    assert.equal(resolveOperand('volume_ratio(20)', ctx).value, cols.vol_ratio.at(-1));
  });

  test('an unavailable operand is UNKNOWN with a reason, never a silent false', () => {
    /**
     * An unresolved operand reading as a failed criterion is how a scan quietly
     * stops finding anything — the failure evaluateCriteria was written to avoid.
     */
    const thin = buildContext(flatBars(10));
    const bb = resolveOperand('bb_bandwidth_pctile(252)', thin);
    assert.equal(bb.ok, false);
    assert.match(bb.reason, /at least 60 bandwidth readings/);
    const vr = resolveOperand('volume_ratio(20)', buildContext(flatBars(5)));
    assert.equal(vr.ok, false);
    assert.match(vr.reason, /current bar is excluded from its own baseline/);
  });

  test('volume_ratio is NOT rvol — rvol is intraday-only and this is the daily operand', () => {
    // On a daily chart rvol is null by construction, so a daily volume clause had
    // no operand at all before this.
    assert.equal(ctx.intraday, false);
    assert.equal(ctx.values.rvol, null);
    assert.equal(resolveOperand('rvol', ctx).ok, false);
    assert.equal(resolveOperand('volume_ratio(20)', ctx).ok, true);
  });
});

// ── the tools ─────────────────────────────────────────────────────────────

describe('the registered tools carry the forward test and clear their own group', () => {
  const src = readFileSync(`${process.cwd()}/src/tools/mtf.js`, 'utf8');

  test('both tools exist', () => {
    assert.match(src, /server\.tool\(\s*'stage_history'/);
    assert.match(src, /server\.tool\(\s*'stage_draw'/);
  });

  test('each description quotes Shannon\'s negative forward test VERBATIM', () => {
    /**
     * A tool that surfaces stage machinery with the caveat quietly dropped is how a
     * refuted idea gets rediscovered — and the whole point of keeping
     * REJECTED_stage_gate_as_edge is that nobody should.
     */
    const blocks = src.split('server.tool(').filter((b) => /^\s*'stage_(history|draw)'/.test(b));
    assert.equal(blocks.length, 2);
    for (const b of blocks) {
      for (const n of ['33.5%', '36.4%', '21.2%', '28.9%', '198 independent events', '103 independent events']) {
        assert.ok(b.includes(n), `a stage tool description omits "${n}"`);
      }
      assert.ok(/NONE favoured the gate|NONE favoured/.test(b));
      assert.ok(/NOT stage_plan|not stage_plan/.test(b),
        'and it must say the two are different constructs, or a reader will merge them');
    }
  });

  test('each description quotes the CYCLE\'s own noise floor', () => {
    // The entry signal fires on roughly half of pure noise. A description that
    // omits that is selling a coin flip.
    const blocks = src.split('server.tool(').filter((b) => /^\s*'stage_(history|draw)'/.test(b));
    for (const b of blocks) {
      assert.ok(b.includes('43.0%') && b.includes('52.5%'), 'a stage tool omits the measured entry-signal floor');
    }
  });

  test('stage_draw clears its own group in BOTH passes', () => {
    /**
     * `clearAll` only removes what the registry still tracks, and TradingView entity
     * ids are SESSION-scoped — so anything drawn before the app last restarted is
     * invisible to it. `removeOrphans` alone is the mirror failure: it removes only
     * UNTRACKED shapes. The morning screen's cleanup logged "removed 0" for weeks
     * with 97 orphans on 13 charts because it ran only one of the two.
     */
    const block = src.slice(src.indexOf("'stage_draw'"));
    assert.match(block, /drawing\.clearAll\(\{ scope: 'mcp', group: groupName \}\)/);
    assert.match(block, /removeOrphans\(\{ dry_run: false, sources: \['stage'\] \}\)/);
  });

  test('stage_draw never clears scope "all" — it is an overlay, not an analysis', () => {
    const block = src.slice(src.indexOf("'stage_draw'"));
    assert.ok(!/scope: 'all'/.test(block),
      "scope 'all' deletes the user's own hand-drawn work. drawFindings uses it for an ANALYSIS "
      + 'because the owner asked for it there; an overlay must not.');
  });

  test('both tools STAMP the symbol they read', () => {
    // A read that cannot be attributed to a symbol is not evidence.
    const blocks = src.split('server.tool(').filter((b) => /^\s*'stage_(history|draw)'/.test(b));
    for (const b of blocks) {
      assert.ok(/raw\?\.symbol/.test(b) && /raw\?\.resolution/.test(b),
        'a stage tool drops its symbol/timeframe stamp');
    }
  });

  test('the owner\'s knobs are exposed on the tool, labelled OWNER and OURS', () => {
    const block = src.slice(src.indexOf("'stage_history'"), src.indexOf("'stage_draw'"));
    for (const k of ['base_pctile_max', 'spike_mult', 'fade_ratio', 'sma_period', 'pctile_window', 'slope_lookback']) {
      assert.ok(block.includes(k), `${k} is not reachable from the tool — a sweep would need a code change`);
    }
    assert.ok(block.includes('OWNER:') && block.includes('OURS:') && block.includes('HOUSE:'),
      'each default must say whose number it is');
  });
});
