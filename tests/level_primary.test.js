import { test, describe } from 'node:test';
import assert from 'node:assert';
import { selectPrimary } from '../src/core/level_display.js';

/**
 * The real DLO set, price 14.815, last swing high 15.51, last swing low 13.83.
 * `through_pct` is the measured fraction of the last 60 bars whose range crossed
 * the level — the number that exposed why proximity was picking the wrong ones.
 */
const DLO = [
  { price: 16.44, through_pct: 0 }, { price: 15.88, through_pct: 0 },
  { price: 15.543333, through_pct: 0 }, { price: 15.19, through_pct: 8.3 },
  { price: 14.84, through_pct: 21.7 }, { price: 14.68, through_pct: 16.7 },
  { price: 14.475, through_pct: 16.7 }, { price: 13.975, through_pct: 10 },
  { price: 13.83, through_pct: 6.7 }, { price: 13.503333, through_pct: 5 },
  { price: 13.27, through_pct: 5 }, { price: 13.016667, through_pct: 3.3 },
];
const OPTS = { price: 14.815, swing_high: 15.51, swing_low: 13.83 };
const priced = (r) => r.shown.map((l) => l.price);

describe('selectPrimary — the levels that BOUND the range', () => {
  test('tier 1 is one support and one resistance, on the swing extremes', () => {
    const r = selectPrimary(DLO, OPTS);
    assert.deepEqual(priced(r), [15.543333, 13.83]);
    assert.equal(r.shown.length, 2, 'exactly two lines by default');
    assert.ok(r.shown.every((l) => l.role === 'primary'));
  });

  test('both sides report that they are anchored, and to what', () => {
    const r = selectPrimary(DLO, OPTS);
    for (const l of r.shown) {
      assert.equal(l.anchored, true);
      assert.match(l.anchor, /sits on the last swing (high|low)/);
    }
    assert.equal(r.anchor_warning, undefined);
  });

  test('it does NOT pick the nearest levels — that was the bug', () => {
    /**
     * 14.84 is 0.17% above price and 14.68 is 0.91% below: by proximity they win
     * outright. Measured, price traded THROUGH them 21.7% and 16.7% of the last 60
     * bars. They are congestion, not boundaries.
     */
    const r = selectPrimary(DLO, OPTS);
    for (const p of [14.84, 14.68, 14.475]) {
      assert.ok(!priced(r).includes(p), `${p} is interior chop and must not be drawn`);
      assert.ok(r.interior.some((i) => i.price === p), `${p} must be reported as interior`);
    }
  });

  test('the interior report carries the through-rate that condemns them', () => {
    const r = selectPrimary(DLO, OPTS);
    const worst = r.interior.find((i) => i.price === 14.84);
    assert.equal(worst.traded_through_pct, 21.7);
    assert.match(worst.why, /INTERIOR/);
  });

  test('nothing is lost: every level is drawn, interior, or beyond', () => {
    const r = selectPrimary(DLO, OPTS);
    const seen = new Set([...priced(r), ...r.interior.map((i) => i.price), ...r.beyond.map((b) => b.price)]);
    assert.equal(seen.size, DLO.length);
    assert.match(r.suppressed_note, /Listed rather than silently dropped/);
  });
});

describe('tiers — "show me the next one"', () => {
  test('tier 2 steps one level OUTWARD on each side', () => {
    const r = selectPrimary(DLO, { ...OPTS, tier: 2 });
    assert.deepEqual(priced(r), [15.88, 13.503333]);
    assert.ok(r.shown.every((l) => l.role === 'tier 2'));
  });

  test('tier 3 steps out again', () => {
    assert.deepEqual(priced(selectPrimary(DLO, { ...OPTS, tier: 3 })), [16.44, 13.27]);
  });

  test('tiers never step INWARD past the boundary', () => {
    for (const tier of [2, 3, 4]) {
      for (const l of selectPrimary(DLO, { ...OPTS, tier }).shown) {
        if (l.side === 'resistance') assert.ok(l.price > 15.543333);
        else assert.ok(l.price < 13.83);
      }
    }
  });

  test('the ladder reports how far it goes, and stops', () => {
    const r = selectPrimary(DLO, OPTS);
    assert.equal(r.next_tier, 2);
    // Above 15.543 sit 15.88 and 16.44; below 13.83 sit 13.503, 13.27 and 13.017.
    assert.deepEqual(r.tiers_available, { resistance: 3, support: 4 });
    assert.equal(selectPrimary(DLO, { ...OPTS, tier: 5 }).next_tier, null);
  });

  test('a side that runs out simply drops off, leaving the other', () => {
    // Resistance has 3 tiers, support 4. At tier 4 only support remains.
    const r = selectPrimary(DLO, { ...OPTS, tier: 4 });
    assert.deepEqual(priced(r), [13.016667]);
    assert.equal(r.shown[0].side, 'support');
  });
});

describe('when structure cannot anchor it, it says so', () => {
  test('no level near the swing high falls back and WARNS', () => {
    const r = selectPrimary(DLO, { ...OPTS, swing_high: 25 });
    assert.equal(r.shown.find((l) => l.side === 'resistance').anchored, false);
    assert.match(r.anchor_warning, /NOT anchored to a swing extreme/);
    assert.match(r.shown.find((l) => l.side === 'resistance').anchor, /Fell back to the nearest/);
  });

  test('no swings at all still returns something, labelled as unanchored', () => {
    const r = selectPrimary(DLO, { price: 14.815 });
    assert.equal(r.shown.length, 2);
    assert.ok(r.shown.every((l) => l.anchored === false));
    assert.match(r.shown[0].anchor, /no swing (high|low) available/);
  });

  test('the tolerance is what decides anchored vs not', () => {
    // 15.543 is 0.21% from the 15.51 swing high.
    assert.equal(selectPrimary(DLO, { ...OPTS, anchor_tolerance_pct: 0.5 })
      .shown.find((l) => l.side === 'resistance').anchored, true);
    assert.equal(selectPrimary(DLO, { ...OPTS, anchor_tolerance_pct: 0.1 })
      .shown.find((l) => l.side === 'resistance').anchored, false);
  });
});

describe('guards', () => {
  test('no price is an error', () => {
    assert.throws(() => selectPrimary(DLO, {}), /needs the current price/);
  });

  test('an empty list draws nothing rather than throwing', () => {
    const r = selectPrimary([], OPTS);
    assert.deepEqual(r.shown, []);
    assert.equal(r.next_tier, null);
  });

  test('a side with no levels at all is reported, not faked', () => {
    const r = selectPrimary([{ price: 13.83 }], OPTS);
    assert.deepEqual(priced(r), [13.83]);
    assert.equal(r.tiers_available.resistance, 1, 'no resistance exists above price');
  });
});
