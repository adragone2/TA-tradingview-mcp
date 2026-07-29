import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  BUCKETS, SCREEN_BUCKET, DEFAULT_BUCKET_SLOTS, MONTHS_EXIT,
  exchangeMonth, rebalanceDue, applyHysteresis, routeToBuckets,
} from '../src/core/cadence.js';
import { SCREENS } from '../src/core/screens.js';

const AT = (iso) => Date.parse(iso);

describe('the rebalance clock', () => {
  test('WEEKS rebalances on every run', () => {
    const r = rebalanceDue('WEEKS', { now: AT('2026-07-29T12:00:00Z'), last_run_iso: '2026-07-29T11:00:00Z' });
    assert.equal(r.due, true);
  });

  test('MONTHS does NOT rebalance twice in the same month', () => {
    // The whole fix. A daily run must leave the Months section alone.
    const r = rebalanceDue('MONTHS', { now: AT('2026-07-29T12:00:00Z'), last_run_iso: '2026-07-02T12:00:00Z' });
    assert.equal(r.due, false);
    assert.match(r.reason, /already rebalanced in 2026-07/);
  });

  test('MONTHS rebalances when the calendar month advances', () => {
    const r = rebalanceDue('MONTHS', { now: AT('2026-08-03T12:00:00Z'), last_run_iso: '2026-07-29T12:00:00Z' });
    assert.equal(r.due, true);
    assert.match(r.reason, /2026-07 -> 2026-08/);
  });

  test('a missed month does not shift the schedule', () => {
    // Skipping September must not make October "not due" — the test is on the
    // month CHANGING, not on elapsed days.
    const r = rebalanceDue('MONTHS', { now: AT('2026-10-01T12:00:00Z'), last_run_iso: '2026-08-03T12:00:00Z' });
    assert.equal(r.due, true);
  });

  test('no prior run means due', () => {
    assert.equal(rebalanceDue('MONTHS', { now: AT('2026-07-29T12:00:00Z'), last_run_iso: null }).due, true);
  });

  test('an unreadable timestamp rebalances rather than guessing', () => {
    // Failing closed here would silently freeze the Months bucket forever.
    const r = rebalanceDue('MONTHS', { now: AT('2026-07-29T12:00:00Z'), last_run_iso: 'not a date' });
    assert.equal(r.due, true);
    assert.match(r.reason, /unreadable/);
  });

  test('force overrides the schedule', () => {
    const r = rebalanceDue('MONTHS', { now: AT('2026-07-29T12:00:00Z'), last_run_iso: '2026-07-02T12:00:00Z', force: true });
    assert.equal(r.due, true);
  });

  test('an unknown bucket throws instead of defaulting', () => {
    assert.throws(() => rebalanceDue('QUARTERS', {}), /unknown bucket/);
  });

  test('the month boundary is read at the exchange, not in UTC', () => {
    // 2026-08-01T02:00Z is still 31 July, 22:00 in New York.
    assert.equal(exchangeMonth(AT('2026-08-01T02:00:00Z')), '2026-07');
    assert.equal(exchangeMonth(AT('2026-08-01T12:00:00Z')), '2026-08');
  });
});

describe('hysteresis', () => {
  const ranked = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];

  test('FILLS THE SLOTS regardless of how long the incoming list is', () => {
    /**
     * Regression, found by running the screen live with --top 6: it filled 1 of
     * 12 Months slots.
     *
     * The band was a PERCENTILE of `ranked`, but `ranked` is already a top-N
     * selection. "Top 20%" of 5 survivors is one name. Expressed in rank
     * POSITIONS the cut is invariant to list length, which is the whole point.
     */
    const short = applyHysteresis({ ranked: ['a', 'b', 'c', 'd', 'e'], held: [], slots: 12 });
    assert.equal(short.selected.length, 5, 'a short candidate list must still fill what it can');

    const long = applyHysteresis({ ranked: Array.from({ length: 400 }, (_, i) => `s${i}`), held: [], slots: 12 });
    assert.equal(long.selected.length, 12, 'a long candidate list must not overfill');
  });

  test('a held name between the two cuts SURVIVES but would not be bought', () => {
    /**
     * The entire mechanism. With slots 3 and exit_multiple 2.5 the entry cut is
     * rank 3 and the exit cut is rank 8. "e" sits at index 4 — past entry,
     * inside exit. Held, it stays; not held, it is not bought.
     */
    const held = applyHysteresis({ ranked, held: ['e'], slots: 3, exit_multiple: 2.5 });
    assert.ok(held.selected.includes('e'), 'held name inside the exit band was ejected');

    const notHeld = applyHysteresis({ ranked, held: [], slots: 3, exit_multiple: 2.5 });
    assert.ok(!notHeld.selected.includes('e'), 'a name past the entry cut was bought anyway');
  });

  test('a held name past the exit cut is ejected', () => {
    const r = applyHysteresis({ ranked, held: ['j'], slots: 3, exit_multiple: 2.5 });
    assert.ok(!r.selected.includes('j'));
    assert.deepEqual(r.ejected, ['j']);
  });

  test('a held name that fell out of the universe entirely is ejected', () => {
    const r = applyHysteresis({ ranked, held: ['ZZZZ'], slots: 5 });
    assert.deepEqual(r.ejected, ['ZZZZ']);
    assert.ok(!r.selected.includes('ZZZZ'));
  });

  test('the turnover saved is MEASURED, not asserted', () => {
    const r = applyHysteresis({ ranked, held: ['c', 'd', 'e'], slots: 3, exit_multiple: 2.5 });
    // Naive would take a,b,c — selling d and e and buying a and b.
    assert.ok(r.turnover.naive_rerank > r.turnover.with_hysteresis,
      'hysteresis did not reduce turnover on a case constructed to show it');
    assert.equal(r.turnover.names_saved, r.turnover.naive_rerank - r.turnover.with_hysteresis);
  });

  test('an exit_multiple below 1 throws — it would raise turnover, not cut it', () => {
    assert.throws(() => applyHysteresis({ ranked, held: [], exit_multiple: 0.5 }), /raises turnover/);
  });

  test('never returns more names than the slots allow', () => {
    const r = applyHysteresis({ ranked, held: ranked.slice(0, 8), slots: 4, exit_multiple: 2.5 });
    assert.equal(r.selected.length, 4);
  });

  test('reports a short fill rather than padding it', () => {
    const r = applyHysteresis({ ranked: ['a', 'b'], held: [], slots: 10 });
    assert.equal(r.short_by, 8);
  });

  test('exit_multiple 1 is a plain top-N rerank, which is what WEEKS wants', () => {
    const r = applyHysteresis({ ranked, held: ['e', 'f'], slots: 3, exit_multiple: 1 });
    assert.deepEqual(r.selected, ['a', 'b', 'c']);
    assert.equal(BUCKETS.WEEKS.exit_multiple, 1);
    assert.equal(BUCKETS.WEEKS.rebalance, 'daily');
  });

  test('the band reports positions AND the percentile equivalent', () => {
    // costs.hysteresisExit prices a band in percentiles; selection uses ranks.
    const r = applyHysteresis({ ranked, held: [], slots: 2, exit_multiple: 2.5 });
    assert.equal(r.band.entry_rank, 2);
    assert.equal(r.band.exit_rank, 5);
    assert.deepEqual(r.band.implied_pct, { entry: 20, exit: 50 });
  });
});

describe('the Months exit rule', () => {
  const ranked = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];

  test('distinguishes rank deterioration from leaving the universe', () => {
    /**
     * Two different events that look the same in a plain list of dropped
     * tickers. A name ranked 10th of 10 has deteriorated; a name that vanished
     * from the scan may just have failed the liquidity filter, which is not a
     * statement about the factor at all.
     */
    const r = applyHysteresis({ ranked, held: ['j', 'GONE'], slots: 3, exit_multiple: 2 });
    const by = Object.fromEntries(r.exits.map((e) => [e.symbol, e]));
    assert.equal(by.j.reason, 'rank deteriorated past the exit cut');
    assert.equal(by.j.rank, 10);
    assert.equal(by.GONE.reason, 'left the ranked universe');
    assert.equal(by.GONE.rank, null);
  });

  test('a surviving name produces no exit record', () => {
    const r = applyHysteresis({ ranked, held: ['b'], slots: 3, exit_multiple: 2 });
    assert.deepEqual(r.exits, []);
  });

  test('the price-trail alternative is recorded as MEASURED and rejected', () => {
    /**
     * Guards against quietly adopting the 8-EMA trail later on a practitioner's
     * say-so. It was tested with stoppingPremium against the names actually
     * held: 9 of 12 showed no persistence, 1 was mean-reverting. Kaminski & Lo
     * make the premium negative in both cases.
     */
    assert.match(MONTHS_EXIT.rejected_alternative, /8 EMA/);
    assert.match(MONTHS_EXIT.why_not_a_price_stop, /Kaminski & Lo/);
    assert.match(MONTHS_EXIT.why_not_a_price_stop, /9 showed no measurable persistence/);
    // Rejected as edge, explicitly NOT rejected as a solvency constraint.
    assert.match(MONTHS_EXIT.why_not_a_price_stop, /solvency constraint/);
  });

  test('the exit is cross-sectional, matching the evidence behind the bucket', () => {
    assert.match(MONTHS_EXIT.rule, /rank deterioration/);
    assert.match(MONTHS_EXIT.detail, /cross-sectional/);
  });
});

describe('bucket routing', () => {
  test('every screen has a bucket', () => {
    /**
     * Contract test. Add a screen without bucketing it and its candidates go
     * to `unrouted`, i.e. silently vanish from the watchlist. This fails first.
     */
    for (const s of SCREENS) {
      assert.ok(SCREEN_BUCKET[s.key], `screen "${s.key}" has no bucket in SCREEN_BUCKET`);
      assert.ok(BUCKETS[SCREEN_BUCKET[s.key]], `screen "${s.key}" maps to an unknown bucket`);
    }
  });

  test('no bucket entry refers to a screen that no longer exists', () => {
    const keys = new Set(SCREENS.map((s) => s.key));
    for (const k of Object.keys(SCREEN_BUCKET)) {
      assert.ok(keys.has(k), `SCREEN_BUCKET names "${k}", which is not a screen`);
    }
  });

  test('a name surfaced by both buckets goes to MONTHS', () => {
    // The slower bucket has the stronger evidence and the lower cost, and
    // holding the same name in both would double the position silently.
    const r = routeToBuckets([{ symbol: 'X', screens: ['structural_reversal', 'near_52w_high'] }]);
    assert.equal(r.MONTHS.length, 1);
    assert.equal(r.WEEKS.length, 0);
  });

  test('a weeks-only name goes to WEEKS', () => {
    const r = routeToBuckets([{ symbol: 'X', screens: ['structural_reversal'] }]);
    assert.equal(r.WEEKS.length, 1);
    assert.equal(r.MONTHS.length, 0);
  });

  test('an unknown screen leaves the candidate unrouted rather than guessing', () => {
    const r = routeToBuckets([{ symbol: 'X', screens: ['some_new_screen'] }]);
    assert.equal(r.unrouted.length, 1);
  });

  test('slots split across the two buckets and total the usual 20', () => {
    assert.equal(DEFAULT_BUCKET_SLOTS.MONTHS + DEFAULT_BUCKET_SLOTS.WEEKS, 20);
    assert.ok(DEFAULT_BUCKET_SLOTS.MONTHS > DEFAULT_BUCKET_SLOTS.WEEKS,
      'Months should carry the larger share — it is where the replicated evidence is');
  });
});
