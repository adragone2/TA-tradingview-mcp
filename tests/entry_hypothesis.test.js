import { test, describe } from 'node:test';
import assert from 'node:assert';
import { entryHypothesis, CHASE_PCT, MIN_STOP_ATR } from '../src/core/entry_hypothesis.js';

/** The real DLO picture: price 14.78, ATR 0.5895, two forming patterns pointing opposite ways. */
const DLO = {
  price: 14.78,
  atr: 0.5895,
  patterns: [
    { pattern: 'bull_flag', direction: 'bullish', status: 'forming', completion_level: 15.3699 },
    { pattern: 'rising_wedge', direction: 'bearish', status: 'forming', completion_level: 14.275627 },
  ],
  levels: [
    { price: 16.44 }, { price: 15.88 }, { price: 15.543333 }, { price: 15.19 }, { price: 14.84 },
    { price: 14.68 }, { price: 14.475 }, { price: 13.975 },
    { price: 13.83, reason: '15 tests + 1 swing low' }, { price: 13.503333 }, { price: 13.27 },
  ],
  swing_high: 15.51,
  swing_low: 13.83,
};

describe('entryHypothesis — both directions, always', () => {
  test('a forming pattern supplies the trigger, and is labelled as forming', () => {
    const r = entryHypothesis(DLO);
    assert.equal(r.long.trigger, 15.37);
    assert.match(r.long.trigger_basis, /bull_flag/);
    assert.match(r.long.trigger_basis, /FORMING/, 'a forming pattern must never read as a signal');
    assert.equal(r.short.trigger, 14.28);
    assert.match(r.short.trigger_basis, /rising_wedge/);
  });

  test('the trigger is an EVENT at a price, not a vague area', () => {
    const r = entryHypothesis(DLO);
    assert.equal(r.long.trigger_event, 'a daily CLOSE above 15.37');
    assert.equal(r.short.trigger_event, 'a daily CLOSE below 14.28');
  });

  test('each side invalidates on the OTHER pattern completing', () => {
    const r = entryHypothesis(DLO);
    assert.equal(r.long.invalidation.price, 14.275627);
    assert.match(r.long.invalidation.basis, /rising_wedge/);
    assert.equal(r.short.invalidation.price, 15.3699);
  });

  test('R:R is measured at the trigger, not at spot', () => {
    const r = entryHypothesis(DLO);
    const risk = r.long.risk_per_share;
    const t = r.long.targets[0];
    assert.ok(Math.abs(t.rr - Math.abs(t.price - r.long.trigger) / risk) < 0.01);
  });
});

describe('the stop is checked against ordinary bar range', () => {
  test('the chosen stop is at least 1x ATR from the trigger', () => {
    const r = entryHypothesis(DLO);
    for (const s of [r.long, r.short]) assert.ok(s.stop_in_atr >= MIN_STOP_ATR, `${s.direction} stop too tight`);
  });

  test('a level inside 1x ATR is skipped, and the skip is REPORTED', () => {
    /**
     * A stop closer than 1x ATR is hit by ordinary bar range rather than by the
     * idea being wrong. Silently widening would hide that the obvious level was
     * rejected, so the nearer one is named.
     */
    const r = entryHypothesis({
      ...DLO,
      levels: [{ price: 15.3 }, { price: 14.68 }, { price: 13.83 }],
    });
    assert.equal(r.long.stop_widened_from, 15.3);
    assert.match(r.long.stop_widened_note, /inside 1x ATR/);
    assert.ok(r.long.stop_in_atr >= MIN_STOP_ATR);
  });

  test('with no level far enough out it falls back to exactly 1x ATR and says so', () => {
    const r = entryHypothesis({ ...DLO, levels: [{ price: 15.3699 }, { price: 15.2 }] });
    assert.match(r.long.stop_basis, /1x ATR away/);
  });

  test('without an ATR the long side refuses rather than guessing a stop', () => {
    const r = entryHypothesis({ ...DLO, atr: null, levels: [{ price: 15.3699 }] });
    assert.equal(r.long.available, false);
    assert.match(r.long.why, /ATR/);
  });
});

describe('it refuses to invent a price', () => {
  test('a side with nothing to trigger on is unavailable, with a reason', () => {
    const r = entryHypothesis({
      price: 14.78, atr: 0.5895, patterns: [], levels: [{ price: 13.0 }], swing_low: 13.0,
    });
    assert.equal(r.long.available, false);
    assert.match(r.long.why, /no forming bullish pattern/);
    assert.equal(r.short.available, true, 'the side that HAS structure still works');
  });

  test('with no pattern it falls back to the swing, and names that as the basis', () => {
    const r = entryHypothesis({ ...DLO, patterns: [] });
    assert.equal(r.long.trigger, 15.51);
    assert.match(r.long.trigger_basis, /swing high/);
  });

  test('with no pattern and no swing it uses a level and calls that the WEAKEST basis', () => {
    const r = entryHypothesis({ ...DLO, patterns: [], swing_high: null });
    assert.match(r.long.trigger_basis, /weakest/);
  });
});

describe('the two warnings that stop a hypothesis being decorative', () => {
  test('a trigger far above price is flagged as chasing', () => {
    const r = entryHypothesis({
      ...DLO,
      patterns: [{ pattern: 'bull_flag', direction: 'bullish', status: 'forming', completion_level: 20 }],
    });
    assert.match(r.long.chasing_warning, new RegExp(`${CHASE_PCT}%`));
  });

  test('a catalyst inside the intended hold is named', () => {
    const r = entryHypothesis({ ...DLO, holding_days: 21, days_to_catalyst: 14 });
    assert.match(r.long.catalyst_conflict, /14 trading day/);
    assert.match(r.long.catalyst_conflict, /INTO the event/);
  });

  test('a catalyst beyond the hold is not flagged', () => {
    const r = entryHypothesis({ ...DLO, holding_days: 5, days_to_catalyst: 30 });
    assert.equal(r.long.catalyst_conflict, undefined);
  });
});

/**
 * WHEN the plan was written.
 *
 * The intraday tier is traded 10:15-14:30 ET and has said so in data since the tier
 * policy was written — nothing read it, so an intraday plan produced at 06:55, when
 * there is no VWAP and no opening range for the setup to be measured against, came
 * out of here looking identical to one produced at 11:00.
 */
describe('the execution-window annotation', () => {
  const PREOPEN = Date.parse('2026-07-15T10:55:00Z');   // Wed 06:55 EDT
  const MIDDAY = Date.parse('2026-07-15T14:20:00Z');    // Wed 10:20 EDT
  const LATE = Date.parse('2026-07-15T19:50:00Z');      // Wed 15:50 EDT

  test('an INTRADAY plan formed pre-open is annotated with how far outside it is', () => {
    const r = entryHypothesis({ ...DLO, tier: 'intraday', now: PREOPEN });
    assert.equal(r.execution_window.in_window, false);
    assert.equal(r.execution_window.window, '10:15-14:30 ET');
    assert.equal(r.execution_window.opens_in_minutes, 200);
    assert.match(r.execution_window.note, /Generated 06:55 ET/);
    assert.match(r.execution_window.note, /do not exist yet/);
  });

  test('the same plan formed at 15:50 is annotated the other way', () => {
    const r = entryHypothesis({ ...DLO, tier: 'intraday', now: LATE });
    assert.equal(r.execution_window.in_window, false);
    assert.equal(r.execution_window.closed_since_minutes, 80);
    assert.match(r.execution_window.note, /closed at 14:30 ET/);
  });

  test('inside the window it says in_window true — silence would be ambiguous', () => {
    const r = entryHypothesis({ ...DLO, tier: 'intraday', now: MIDDAY });
    assert.equal(r.execution_window.in_window, true);
    assert.equal(r.execution_window.status, 'in_window');
  });

  test('the annotation NEVER suppresses the plan', () => {
    /**
     * The whole point. Three market-alignment gates have been forward-tested in this
     * repo — level_pressure, the Stage 2 gate, Livermore's two-leader confirmation —
     * and all three failed. This is about honesty, not gating, so an out-of-window
     * hypothesis must be byte-identical to an in-window one apart from the added key.
     */
    const inside = entryHypothesis({ ...DLO, tier: 'intraday', now: MIDDAY });
    const outside = entryHypothesis({ ...DLO, tier: 'intraday', now: PREOPEN });
    const plain = entryHypothesis(DLO);
    for (const k of ['long', 'short']) {
      assert.deepEqual(outside[k], plain[k], `${k} must be untouched by the annotation`);
      assert.deepEqual(inside[k], plain[k], `${k} must be untouched by the annotation`);
    }
    assert.equal(outside.long.available, true);
    assert.equal(outside.short.available, true);
    assert.match(outside.execution_window.not_a_gate, /never a filter/);
  });

  test('weekly and monthly carry not_applicable, not a false "outside"', () => {
    for (const tier of ['weekly', 'monthly']) {
      const r = entryHypothesis({ ...DLO, tier, now: PREOPEN });
      assert.equal(r.execution_window.status, 'not_applicable', tier);
      assert.equal(r.execution_window.in_window, null, `${tier} has no window to be outside of`);
    }
  });

  test('no tier and no timestamp add NOTHING — unknown is not annotated', () => {
    /**
     * Additive keys only, and an `execution_window` block reading "unknown" on every
     * existing caller would be noise in the Sunday schema for no information. The
     * existing shape is untouched.
     */
    assert.equal(entryHypothesis(DLO).execution_window, undefined);
    assert.equal(entryHypothesis({ ...DLO, now: PREOPEN }).execution_window, undefined, 'no tier');
    assert.equal(entryHypothesis({ ...DLO, tier: 'intraday' }).execution_window, undefined, 'no timestamp');
    assert.equal(entryHypothesis({ ...DLO, tier: 'intraday', now: null }).execution_window, undefined);
    assert.equal(entryHypothesis({ ...DLO, tier: 'nonsense', now: PREOPEN }).execution_window, undefined);
  });

  test('the annotation is ADDITIVE — every pre-existing key is still there', () => {
    const plain = entryHypothesis(DLO);
    const annotated = entryHypothesis({ ...DLO, tier: 'intraday', now: PREOPEN });
    for (const k of Object.keys(plain)) assert.ok(k in annotated, `${k} was dropped`);
    assert.deepEqual(
      Object.keys(annotated).filter((k) => !(k in plain)), ['execution_window'],
      'exactly one new key',
    );
  });

  test('it stays PURE — no clock is read, so the same inputs give the same result', () => {
    // `now` is a parameter and is not defaulted to Date.now() anywhere on this path.
    const a = entryHypothesis({ ...DLO, tier: 'intraday', now: PREOPEN });
    const b = entryHypothesis({ ...DLO, tier: 'intraday', now: PREOPEN });
    assert.deepEqual(a, b);
  });
});

describe('guards', () => {
  test('no price is an error', () => {
    assert.throws(() => entryHypothesis({ atr: 1 }), /needs the current price/);
  });

  test('it never presents a forming pattern as a forecast', () => {
    const r = entryHypothesis(DLO);
    assert.match(r.not_a_forecast, /NOT a signal/);
  });
});
