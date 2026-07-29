import { test, describe } from 'node:test';
import assert from 'node:assert';
import { EXIT_REASONS, EXIT_KEYS, exitMix, isModellable } from '../src/core/exits.js';

describe('the exit taxonomy', () => {
  test('covers all ten Reasons2Sell plus an honest unknown', () => {
    assert.ok(EXIT_KEYS.length >= 11, `only ${EXIT_KEYS.length} reasons`);
    assert.ok(EXIT_KEYS.includes('discretionary_other'),
      'without an explicit unknown, reasons get forced into a wrong bucket');
  });

  test('every reason declares whether a backtest can model it', () => {
    for (const [k, r] of Object.entries(EXIT_REASONS)) {
      assert.equal(typeof r.planned, 'boolean', `${k} does not say if it is modellable`);
      assert.ok(r.driver, `${k} does not say what it was watching`);
      assert.ok(r.label && r.note, `${k} is missing label or note`);
    }
  });

  test('the three barriers the journal already had are all PLANNED', () => {
    // target / stop / time were the whole prior taxonomy. They are exactly the
    // modellable subset, which is why three categories taught nothing.
    for (const k of ['target_hit', 'stop_hit', 'time_elapsed']) {
      assert.equal(EXIT_REASONS[k].planned, true);
    }
  });

  test('market-driven exits are marked unmodellable', () => {
    // A single-symbol backtest cannot see the index at all.
    for (const k of ['market_at_level', 'market_news']) {
      assert.equal(EXIT_REASONS[k].driver, 'market');
      assert.equal(EXIT_REASONS[k].planned, false);
    }
  });

  test('isModellable returns null for an unknown reason, not a guess', () => {
    assert.equal(isModellable('target_hit'), true);
    assert.equal(isModellable('tape_seller'), false);
    assert.equal(isModellable('nonsense'), null);
  });

  test('trend_broken is planned only conditionally, and says so', () => {
    // Picking the timeframe after the fact is the justification trap.
    assert.match(EXIT_REASONS.trend_broken.note, /consistent/);
    assert.match(EXIT_REASONS.trend_broken.note, /timeframe-justification/);
  });
});

describe('exitMix', () => {
  const many = (k, n) => Array(n).fill(k);

  test('counts by reason and by driver', () => {
    const r = exitMix([...many('target_hit', 3), ...many('tape_seller', 2)]);
    assert.equal(r.exits_counted, 5);
    assert.equal(r.by_reason.target_hit, 3);
    assert.equal(r.by_driver.tape, 2);
  });

  test('a mostly-planned book is told its backtest is fair', () => {
    const r = exitMix([...many('target_hit', 8), ...many('stop_hit', 6), 'tape_seller']);
    assert.ok(r.planned_pct > 90);
    assert.match(r.verdict, /fair test/);
  });

  test('a mostly-discretionary book is told the backtest CANNOT represent it', () => {
    /**
     * The load-bearing case. Every honesty rule here about benchmarks and trial
     * counts is void if the exit in the test is not the exit in the account.
     */
    const r = exitMix([...many('tape_seller', 6), ...many('too_steep', 4), ...many('target_hit', 3)]);
    assert.ok(r.discretionary_pct >= 50);
    assert.match(r.verdict, /CANNOT REPRESENT/);
  });

  test('the middle band gets "indicative only" rather than a pass or a fail', () => {
    const r = exitMix([...many('target_hit', 7), ...many('tape_seller', 3)]);
    assert.equal(r.discretionary_pct, 30);
    assert.match(r.verdict, /indicative only/);
  });

  test('market-driven exits are counted separately', () => {
    // They deserve their own number: no single-symbol backtest sees them.
    const r = exitMix([...many('market_at_level', 4), ...many('target_hit', 6)]);
    assert.equal(r.market_driven, 4);
    assert.equal(r.market_driven_pct, 40);
    assert.match(r.why_it_matters, /4 of these exits were driven by the INDEX/);
  });

  test('accepts objects with a reason field as well as bare keys', () => {
    const r = exitMix([{ reason: 'target_hit' }, { reason: 'stop_hit' }]);
    assert.equal(r.exits_counted, 2);
  });

  test('unrecognised reasons are REPORTED, never silently dropped', () => {
    // Dropping them would make the distribution look cleaner than the journal is.
    const r = exitMix([...many('target_hit', 3), 'vibes', 'vibes']);
    assert.equal(r.exits_counted, 3);
    assert.deepEqual(r.unrecognised, ['vibes']);
    assert.equal(r.unrecognised_count, 2);
  });

  test('nothing usable is unavailable, with the bad keys listed', () => {
    const r = exitMix(['vibes', 'hunch']);
    assert.equal(r.available, false);
    assert.deepEqual(r.unrecognised.sort(), ['hunch', 'vibes']);
  });

  test('an empty set is not an error and claims nothing', () => {
    const r = exitMix([]);
    assert.equal(r.available, false);
    assert.match(r.note, /No exits/);
  });

  test('the threshold is presented as a choice, not a measurement', () => {
    // Nobody has measured where a backtest stops being informative.
    const src = EXIT_REASONS.target_hit.note;
    assert.ok(src.length > 0);
    const r = exitMix([...many('target_hit', 10)]);
    assert.match(r.source, /Bellafiore/);
  });
});
