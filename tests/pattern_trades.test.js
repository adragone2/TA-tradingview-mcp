import { test, describe } from 'node:test';
import assert from 'node:assert';
import { tradePlan, tradePlans, PATTERN_FAMILY } from '../src/core/pattern_trades.js';

const ATR = 2;

/** A detected pattern, shaped the way patterns.js emits them. */
const p = (pattern, measurements = {}, extra = {}) => ({
  pattern, measurements, status: 'confirmed', ...extra,
});

describe('PATTERN_FAMILY — every detectable pattern has a construction', () => {
  test('the bilateral set is exactly the shapes that do not know their direction', () => {
    const bilateral = Object.entries(PATTERN_FAMILY)
      .filter(([, f]) => f === 'bilateral').map(([k]) => k).sort();
    assert.deepEqual(bilateral, [
      'ascending_triangle', 'bearish_rectangle', 'broadening_formation',
      'bullish_rectangle', 'descending_triangle', 'rectangle',
      'symmetrical_triangle',
    ]);
  });

  test('a typed rectangle is still bilateral — typing names a bias, not a break', () => {
    for (const r of ['rectangle', 'bullish_rectangle', 'bearish_rectangle']) {
      assert.equal(PATTERN_FAMILY[r], 'bilateral', `${r} stopped being bilateral`);
    }
  });

  test('pennants are continuation, and directional', () => {
    assert.equal(PATTERN_FAMILY.bullish_pennant, 'continuation_bull');
    assert.equal(PATTERN_FAMILY.bearish_pennant, 'continuation_bear');
  });

  test('a rising wedge is bearish and a falling wedge bullish — not the reverse', () => {
    // This one is inverted by intuition constantly: the wedge slopes UP and
    // breaks DOWN.
    assert.equal(PATTERN_FAMILY.rising_wedge, 'bear_boundary');
    assert.equal(PATTERN_FAMILY.falling_wedge, 'bull_boundary');
  });
});

describe('tradePlan — reversal patterns', () => {
  test('a double top shorts the neckline with the stop above the peak', () => {
    const plan = tradePlan(p('double_top', { trough: 100, peak_2: 120, height: 20 }), { atr: ATR });
    assert.equal(plan.family, 'reversal_bear');
    assert.equal(plan.legs.short.entry, 100);
    assert.ok(plan.legs.short.stop > 120, 'stop was not padded beyond the peak');
    assert.equal(plan.legs.short.target, 80);       // neckline minus the height
    assert.equal(plan.legs.long, undefined, 'a double top emitted a long leg');
  });

  test('a double bottom longs the neckline with the stop below the trough', () => {
    const plan = tradePlan(p('double_bottom', { peak: 120, trough_2: 100, height: 20 }), { atr: ATR });
    assert.equal(plan.family, 'reversal_bull');
    assert.equal(plan.legs.long.entry, 120);
    assert.ok(plan.legs.long.stop < 100);
    assert.equal(plan.legs.long.target, 140);
    assert.equal(plan.legs.short, undefined);
  });

  test('head and shoulders stops above the RIGHT shoulder, not the head', () => {
    const plan = tradePlan(
      p('head_and_shoulders', { trough: 100, right_shoulder: 115, head: 130, height: 30 }),
      { atr: ATR },
    );
    // The right shoulder is the live invalidation; stopping above the head is
    // a much wider risk than the pattern calls for.
    assert.ok(plan.legs.short.stop < 130, 'stop was placed above the head');
    assert.ok(plan.legs.short.stop > 115);
  });

  test('the completion note says a CLOSE is required', () => {
    const plan = tradePlan(p('double_top', { trough: 100, peak_2: 120, height: 20 }), { atr: ATR });
    assert.match(plan.legs.short.note, /CLOSE/);
  });
});

describe('tradePlan — wedges break against their slope', () => {
  test('a rising wedge is a SHORT through the lower boundary', () => {
    const plan = tradePlan(
      p('rising_wedge', { support_now: 100, resistance_now: 110 }, { target: 85 }),
      { atr: ATR },
    );
    assert.equal(plan.legs.short.entry, 100);
    assert.ok(plan.legs.short.stop > 110);
    assert.equal(plan.legs.long, undefined);
    assert.match(plan.legs.short.note, /breaks DOWN/);
  });

  test('a falling wedge is a LONG through the upper boundary', () => {
    const plan = tradePlan(
      p('falling_wedge', { support_now: 100, resistance_now: 110 }, { target: 125 }),
      { atr: ATR },
    );
    assert.equal(plan.legs.long.entry, 110);
    assert.ok(plan.legs.long.stop < 100);
    assert.equal(plan.legs.short, undefined);
  });
});

describe('tradePlan — continuation patterns', () => {
  test('a bull flag buys the consolidation high', () => {
    const plan = tradePlan(
      p('bull_flag', { flag_high: 110, flag_low: 104 }, { target: 130 }),
      { atr: ATR },
    );
    assert.equal(plan.legs.long.entry, 110);
    assert.ok(plan.legs.long.stop < 104);
    assert.equal(plan.legs.long.target, 130);
  });

  test('a bearish pennant sells the consolidation low', () => {
    const plan = tradePlan(
      p('bearish_pennant', { flag_high: 110, flag_low: 104 }, { target: 88 }),
      { atr: ATR },
    );
    assert.equal(plan.family, 'continuation_bear');
    assert.equal(plan.legs.short.entry, 104);
    assert.ok(plan.legs.short.stop > 110);
  });

  test('a bullish pennant buys the consolidation high', () => {
    const plan = tradePlan(
      p('bullish_pennant', { flag_high: 110, flag_low: 104 }, { target: 128 }),
      { atr: ATR },
    );
    assert.equal(plan.family, 'continuation_bull');
    assert.equal(plan.legs.long.entry, 110);
  });
});

describe('tradePlan — bilateral patterns emit BOTH legs', () => {
  const bi = p('symmetrical_triangle', { resistance_now: 110, support_now: 100, height: 10 });

  test('a symmetrical triangle plans the upside AND the downside', () => {
    const plan = tradePlan(bi, { atr: ATR });
    assert.equal(plan.bilateral, true);
    assert.ok(plan.legs.long, 'no long leg on a bilateral pattern');
    assert.ok(plan.legs.short, 'no short leg on a bilateral pattern');
  });

  test('the two legs are mirror images about the boundaries', () => {
    const plan = tradePlan(bi, { atr: ATR });
    assert.equal(plan.legs.long.entry, 110);
    assert.equal(plan.legs.long.target, 120);
    assert.equal(plan.legs.short.entry, 100);
    assert.equal(plan.legs.short.target, 90);
  });

  test('each leg stops beyond the OPPOSITE boundary', () => {
    const plan = tradePlan(bi, { atr: ATR });
    assert.ok(plan.legs.long.stop < 100, 'long leg did not stop below the lower boundary');
    assert.ok(plan.legs.short.stop > 110, 'short leg did not stop above the upper boundary');
  });

  test('every bilateral leg says it needs a CLOSE outside to become live', () => {
    const plan = tradePlan(bi, { atr: ATR });
    for (const l of Object.values(plan.legs)) assert.match(l.note, /CLOSE[Ss]?/);
  });

  test('ascending and descending triangles are bilateral too', () => {
    // Named for their slope, but neither guarantees its break direction.
    for (const name of ['ascending_triangle', 'descending_triangle']) {
      const plan = tradePlan(p(name, { resistance_now: 110, support_now: 100, height: 10 }), { atr: ATR });
      assert.equal(plan.bilateral, true, `${name} was not bilateral`);
      assert.equal(Object.keys(plan.legs).length, 2, `${name} did not emit two legs`);
    }
  });
});

describe('tradePlan — a typed rectangle names its continuation leg', () => {
  const rect = (name) => p(name, { resistance_now: 110, support_now: 100, height: 10 });

  test('a bullish rectangle makes the LONG leg primary', () => {
    const plan = tradePlan(rect('bullish_rectangle'), { atr: ATR });
    assert.equal(plan.primary_leg, 'long');
  });

  test('a bearish rectangle makes the SHORT leg primary', () => {
    const plan = tradePlan(rect('bearish_rectangle'), { atr: ATR });
    assert.equal(plan.primary_leg, 'short');
  });

  test('an untyped rectangle names no primary leg — there is no trend to continue', () => {
    const plan = tradePlan(rect('rectangle'), { atr: ATR });
    assert.equal(plan.primary_leg, undefined);
  });

  test('the non-primary leg is still fully planned', () => {
    // The whole failure mode of typing a bilateral pattern is quietly dropping
    // the other side. Both legs keep their entry, stop and target.
    const plan = tradePlan(rect('bullish_rectangle'), { atr: ATR });
    assert.equal(Object.keys(plan.legs).length, 2);
    for (const l of Object.values(plan.legs)) {
      assert.ok(l.entry != null && l.stop != null && l.target != null);
    }
  });

  test('the primary note says outright that the other leg is still live', () => {
    const plan = tradePlan(rect('bearish_rectangle'), { atr: ATR });
    assert.match(plan.primary_note, /not a one-way pattern/);
  });
});

describe('tradePlan — R:R is arithmetic, and is reported as such', () => {
  test('rr is reward over risk', () => {
    const plan = tradePlan(p('double_top', { trough: 100, peak_2: 110, height: 20 }), { atr: 0 });
    const l = plan.legs.short;
    assert.equal(l.risk, 10);
    assert.equal(l.reward, 20);
    assert.equal(l.rr, 2);
  });

  test('rr is null rather than Infinity when the stop sits on the entry', () => {
    const plan = tradePlan(p('double_top', { trough: 100, peak_2: 100, height: 20 }), { atr: 0 });
    assert.equal(plan.legs.short.rr, null);
  });

  test('a measured base rate travels with the plan when the detector supplies one', () => {
    const plan = tradePlan(
      p('double_top', { trough: 100, peak_2: 120, height: 20 },
        { measured: { break_even_failure_pct: 65, meeting_target_pct: 39 } }),
      { atr: ATR },
    );
    assert.equal(plan.base_rate.break_even_failure_pct, 65);
    assert.match(plan.base_rate.note, /not evidence/);
  });

  test('no base_rate block is invented when the detector has no figures', () => {
    const plan = tradePlan(p('double_top', { trough: 100, peak_2: 120, height: 20 }), { atr: ATR });
    assert.equal(plan.base_rate, undefined);
  });
});

describe('tradePlan — a FORMING pattern is not tradeable', () => {
  test('tradeable_now is false while the pattern is only forming', () => {
    const plan = tradePlan(
      p('double_top', { trough: 100, peak_2: 120, height: 20 }, { status: 'forming' }),
      { atr: ATR },
    );
    assert.equal(plan.tradeable_now, false);
    assert.match(plan.status_note, /hypothesis/);
  });

  test('tradeable_now is true only once confirmed', () => {
    const plan = tradePlan(p('double_top', { trough: 100, peak_2: 120, height: 20 }), { atr: ATR });
    assert.equal(plan.tradeable_now, true);
    assert.equal(plan.status_note, null);
  });

  test('a forming pattern still publishes its levels — they are what WOULD confirm it', () => {
    const plan = tradePlan(
      p('bull_flag', { flag_high: 110, flag_low: 104 }, { target: 130, status: 'forming' }),
      { atr: ATR },
    );
    assert.equal(plan.legs.long.entry, 110);
  });
});

describe('tradePlan — degenerate input', () => {
  test('an unknown pattern returns unknown rather than guessing levels', () => {
    const plan = tradePlan(p('not_a_pattern', {}));
    assert.equal(plan.family, 'unknown');
    assert.deepEqual(plan.legs, {});
  });

  test('missing measurements drop the leg instead of emitting nulls', () => {
    const plan = tradePlan(p('double_top', {}), { atr: ATR });
    assert.deepEqual(plan.legs, {});
  });

  test('without atr the stop sits exactly on the level, not NaN', () => {
    const plan = tradePlan(p('double_top', { trough: 100, peak_2: 120, height: 20 }));
    assert.equal(plan.legs.short.stop, 120);
  });
});

describe('tradePlans — the whole detection set', () => {
  const set = [
    p('double_top', { trough: 100, peak_2: 120, height: 20 }),
    p('symmetrical_triangle', { resistance_now: 110, support_now: 100, height: 10 }),
    p('not_a_pattern', {}),
  ];

  test('drops patterns with no construction rather than emitting empty plans', () => {
    const out = tradePlans(set, { atr: ATR });
    assert.equal(out.length, 2);
    assert.ok(!out.some((x) => x.pattern === 'not_a_pattern'));
  });

  test('each entry carries the pattern name and its status', () => {
    const out = tradePlans(set, { atr: ATR });
    for (const x of out) {
      assert.ok(x.pattern);
      assert.equal(x.status, 'confirmed');
    }
  });

  test('handles an empty or missing set', () => {
    assert.deepEqual(tradePlans([]), []);
    assert.deepEqual(tradePlans(null), []);
  });
});

// ---------------------------------------------------------------------------
// P2.1 review (2026-07-30). The cup had no family, so tradePlans silently
// filtered it out: detected, drawn, and planless. These pin the dedicated
// case — NOT continuation_bull, whose flag_high/flag_low the cup does not
// emit.
// ---------------------------------------------------------------------------
describe('cup_with_handle trade plan', () => {
  const CUP = {
    pattern: 'cup_with_handle', status: 'confirmed', direction: 'bullish',
    completion_level: 110,
    measurements: { left_rim: 109, right_rim: 110, cup_low: 90, handle_low: 104 },
  };

  test('long leg: entry at the right lip, stop under the handle low, HALF-height target', () => {
    const plan = tradePlan(CUP, { atr: 2 });
    assert.equal(plan.family, 'cup_bull');
    const l = plan.legs.long;
    assert.ok(l, 'the cup must produce a long leg');
    assert.equal(l.entry, 110);
    assert.equal(l.stop, 103); // handle_low 104 - 0.5*atr pad
    assert.equal(l.target, 120); // lip + (110-90)/2
    assert.match(l.note, /HALF the cup height/);
    assert.match(l.note, /76%/);
    assert.equal(plan.legs.short, undefined, 'a cup is a bullish construction only');
  });

  test('no handle low -> no leg, filtered like any incomplete plan, never a stop at zero', () => {
    const plan = tradePlan({ ...CUP, measurements: { right_rim: 110, cup_low: 90 } }, { atr: 2 });
    assert.equal(plan.legs.long, undefined);
  });
});
