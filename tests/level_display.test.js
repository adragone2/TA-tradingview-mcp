import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  selectForDisplay, nextAtrMultiple, atrFromBars, ATR_LADDER,
} from '../src/core/level_display.js';

/** The real DLO level set that motivated this, price 14.815, ATR 0.5895. */
const DLO = [
  { price: 16.44, side: 'resistance', score: 7, bars_since_last_test: 196 },
  { price: 15.88, side: 'resistance', score: 9, bars_since_last_test: 188 },
  { price: 15.543333, side: 'resistance', score: 15, bars_since_last_test: 17 },
  { price: 15.19, side: 'resistance', score: 17, bars_since_last_test: 2 },
  { price: 14.84, side: 'resistance', score: 21, bars_since_last_test: 0 },
  { price: 14.68, side: 'support', score: 21, bars_since_last_test: 0 },
  { price: 14.475, side: 'support', score: 28, bars_since_last_test: 0 },
  { price: 13.975, side: 'support', score: 36, bars_since_last_test: 4 },
  { price: 13.83, side: 'support', score: 33, bars_since_last_test: 5 },
  { price: 13.503333, side: 'support', score: 35, bars_since_last_test: 20 },
  { price: 13.27, side: 'support', score: 31, bars_since_last_test: 22 },
  { price: 13.016667, side: 'support', score: 25, bars_since_last_test: 21 },
  { price: 12.6, side: 'support', score: 17, bars_since_last_test: 21 },
  { price: 12.3675, side: 'support', score: 17, bars_since_last_test: 23 },
  { price: 12.16, side: 'support', score: 17, bars_since_last_test: 23 },
  { price: 11.9475, side: 'support', score: 18, bars_since_last_test: 26 },
  { price: 11.78, side: 'support', score: 13, bars_since_last_test: 33 },
  { price: 11.675, side: 'support', score: 13, bars_since_last_test: 33 },
  { price: 11.145, side: 'support', score: 16, bars_since_last_test: 36 },
];
const PRICE = 14.815;
const ATR = 0.5895;
const at = (r) => r.shown.map((l) => l.price);

describe('selectForDisplay — the DLO case this was built for', () => {
  test('1.5x ATR with a 3-per-side quota gives exactly 6, balanced', () => {
    const r = selectForDisplay(DLO, { price: PRICE, atr: ATR });
    assert.deepEqual(at(r), [15.543333, 15.19, 14.84, 14.68, 14.475, 13.975]);
    assert.deepEqual(r.counts, { resistance: 3, support: 3 });
    assert.equal(r.suppressed.length, 13);
  });

  test('a side can never be crowded out, which is the bug it exists for', () => {
    /**
     * 14 supports against 5 resistances. Ranking by score or distance alone
     * returned six supports and NO resistance on a name under overhead supply,
     * hiding the only levels that mattered for a position held at a loss.
     */
    const r = selectForDisplay(DLO, { price: PRICE, atr: ATR, per_side: 6 });
    assert.ok(r.counts.resistance > 0, 'resistance must always survive the filter');
    assert.equal(r.counts.resistance, 3, 'only 3 resistances are inside the band');
  });

  test('every suppressed level is named with a reason', () => {
    const r = selectForDisplay(DLO, { price: PRICE, atr: ATR });
    assert.equal(r.shown.length + r.suppressed.length, DLO.length, 'nothing may vanish');
    for (const s of r.suppressed) assert.match(s.why, /outside the|quota|bars ago/);
    assert.match(r.suppressed_note, /listed rather than silently dropped/);
  });

  test('the recency filter is off by default, and would barely help', () => {
    // Measured: a 63-bar cut removes 2 of 19 levels, and BOTH are resistances.
    const cut = DLO.filter((l) => l.bars_since_last_test > 63);
    assert.equal(cut.length, 2);
    assert.ok(cut.every((l) => l.side === 'resistance'),
      'the quarter filter deletes only resistances — it makes the asymmetry worse');

    const r = selectForDisplay(DLO, { price: PRICE, atr: ATR, max_bars_since_test: 63 });
    assert.deepEqual(at(r), at(selectForDisplay(DLO, { price: PRICE, atr: ATR })),
      'on this chart the recency cut changes nothing inside the band');
  });
});

describe('pins — a filter that hides your stop hides the decision', () => {
  test('a pinned level survives being far outside the band', () => {
    const r = selectForDisplay(DLO, {
      price: PRICE, atr: ATR, pins: [{ price: 13.84, label: 'TA stop' }],
    });
    const pinned = r.shown.find((l) => l.price === 13.83);
    assert.ok(pinned, '13.83 is 6.6% away and must still be drawn');
    assert.equal(pinned.pinned, true);
    assert.deepEqual(pinned.pinned_by, ['TA stop']);
    /**
     * TWO, not one. At the default 1% tolerance a 13.84 stop on a $14 stock spans
     * a 14-cent window, and 13.975 sits 0.98% above it — so the level and the
     * shelf just above the stop are both flagged. That is the intended reading of
     * "at the stop", and it is worth pinning down because the obvious guess is 1.
     */
    assert.equal(r.pinned_count, 2);
    assert.ok(r.shown.some((l) => l.price === 13.975 && l.pinned));
  });

  test('a bare number works as a pin too', () => {
    const r = selectForDisplay(DLO, { price: PRICE, atr: ATR, pins: [13.84] });
    assert.ok(r.shown.some((l) => l.price === 13.83 && l.pinned));
  });

  test('a pin only catches levels within its tolerance', () => {
    const r = selectForDisplay(DLO, { price: PRICE, atr: ATR, pins: [13.84], pin_tolerance_pct: 0.01 });
    assert.ok(!r.shown.some((l) => l.price === 13.83), '13.83 is 0.07% from 13.84, outside a 0.01% window');
  });
});

describe('side is derived from price, not trusted from the level', () => {
  test('a level the price has crossed flips, and says so', () => {
    // DLO's 14.68 was resistance at 14.59 and support at 14.78 — same line.
    const r = selectForDisplay(
      [{ price: 14.68, side: 'resistance', score: 21 }],
      { price: 14.78, atr: ATR },
    );
    const lvl = r.shown[0];
    assert.equal(lvl.side, 'support');
    assert.equal(lvl.side_flipped, true);
    assert.equal(lvl.side_was, 'resistance');
    assert.match(lvl.flip_note, /price has since crossed it/);
  });

  test('a level whose side still agrees is not flagged', () => {
    const r = selectForDisplay([{ price: 14.84, side: 'resistance' }], { price: 14.78, atr: ATR });
    assert.equal(r.shown[0].side_flipped, undefined);
  });
});

describe('the band, and saying which rule was used', () => {
  test('without an ATR it falls back to a fixed percent and SAYS so', () => {
    const r = selectForDisplay(DLO, { price: PRICE });
    assert.equal(r.band.atr_used, false);
    assert.match(r.band.basis, /NO ATR SUPPLIED/);
    assert.match(r.band.basis, /does not adjust for how volatile/);
  });

  test('with an ATR the band is reported in both absolute and percent terms', () => {
    const r = selectForDisplay(DLO, { price: PRICE, atr: ATR });
    assert.equal(r.band.atr_used, true);
    assert.equal(r.band.band_abs, Number((ATR * 1.5).toFixed(4)));
    assert.ok(Math.abs(r.band.band_pct - 5.97) < 0.02);
  });

  test('a shortfall is reported so "2 shown" cannot be mistaken for "2 exist"', () => {
    const r = selectForDisplay(DLO, { price: PRICE, atr: 0.2 });   // a very tight band
    const res = r.shortfalls.find((s) => s.side === 'resistance');
    assert.ok(res, 'a side with fewer than the quota must be reported');
    assert.ok(res.found < res.quota);
    assert.match(res.note, /the quota of 3 was not/);
  });
});

describe('progressive disclosure', () => {
  test('the ladder widens and then stops', () => {
    assert.deepEqual([...ATR_LADDER], [1.5, 3, 6]);
    assert.equal(nextAtrMultiple(1.5), 3);
    assert.equal(nextAtrMultiple(3), 6);
    assert.equal(nextAtrMultiple(6), null, 'the end of the ladder is null, not a repeat');
  });

  test('widening strictly adds levels, never removes one', () => {
    const near = selectForDisplay(DLO, { price: PRICE, atr: ATR, atr_multiple: 1.5, per_side: 99 });
    const far = selectForDisplay(DLO, { price: PRICE, atr: ATR, atr_multiple: 6, per_side: 99 });
    for (const p of at(near)) assert.ok(at(far).includes(p), `${p} vanished when the band widened`);
    assert.ok(far.shown.length > near.shown.length);
  });

  test('the next step is handed back with the result', () => {
    assert.equal(selectForDisplay(DLO, { price: PRICE, atr: ATR }).next_atr_multiple, 3);
  });
});

describe('guards', () => {
  test('no price is an error, not a silent empty list', () => {
    assert.throws(() => selectForDisplay(DLO, { atr: ATR }), /needs the current price/);
  });

  test('an empty level list is a no-op', () => {
    const r = selectForDisplay([], { price: PRICE, atr: ATR });
    assert.deepEqual(r.shown, []);
    assert.deepEqual(r.counts, { resistance: 0, support: 0 });
  });

  test('levels without a finite price are ignored rather than drawn at NaN', () => {
    const r = selectForDisplay([{ price: null }, { price: 14.84 }], { price: PRICE, atr: ATR });
    assert.deepEqual(at(r), [14.84]);
  });
});

describe('atrFromBars', () => {
  const bars = Array.from({ length: 40 }, (_, i) => ({
    high: 100 + i + 1, low: 100 + i - 1, close: 100 + i,
  }));

  test('returns a positive scalar on enough bars', () => {
    const a = atrFromBars(bars, 14);
    assert.ok(a > 0 && Number.isFinite(a));
  });

  test('returns null rather than a wrong number when there are too few bars', () => {
    assert.equal(atrFromBars(bars.slice(0, 10), 14), null);
    assert.equal(atrFromBars(null, 14), null);
  });
});
