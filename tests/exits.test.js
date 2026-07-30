import { test, describe } from 'node:test';
import assert from 'node:assert';
import { EXIT_REASONS, EXIT_KEYS, exitMix, isModellable, sliceTrades } from '../src/core/exits.js';

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

  test('carries Shannon\'s two exits that Bellafiore\'s ten do not cover', () => {
    /**
     * Both are PLANNED. Leaving them out pushed modellable exits into
     * discretionary_other, which understates the share of trading a backtest
     * can actually represent — the opposite of the error exit_mix exists to
     * catch.
     */
    for (const k of ['gap_against_trend', 'ma_crossover']) {
      assert.ok(EXIT_REASONS[k], `${k} missing`);
      assert.equal(EXIT_REASONS[k].planned, true, `${k} should be modellable`);
    }
    assert.match(EXIT_REASONS.gap_against_trend.note, /five percent/);
    // The gap exit must not promise the stop price — that is the gap_risk lesson.
    assert.match(EXIT_REASONS.gap_against_trend.note, /gap_risk|luld_band/);
    // The crossover is an EXIT here, never an entry.
    assert.match(EXIT_REASONS.ma_crossover.note, /INDECISION/);
  });

  test('the taxonomy now covers all twelve reasons plus the unknown', () => {
    assert.ok(EXIT_KEYS.length >= 13, `only ${EXIT_KEYS.length} reasons`);
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

describe('sliceTrades — Shannon Figure 16.2', () => {
  /** Reproduce the two net-negative buckets from his own broker report. */
  const trade = (o) => ({ pnl: 0, ...o });
  const many = (n, o) => Array.from({ length: n }, (_, i) => trade({ ...o, i }));

  test('finds a losing bucket inside a PROFITABLE book', () => {
    /**
     * The load-bearing case, and the reason the tool exists. Shannon's report
     * was net positive while stocks over $100 averaged -3.82 across 159 trades.
     * An aggregate win rate cannot show this.
     */
    const trades = [
      ...many(160, { pnl: -4, price: 150, direction: 'long' }),
      ...many(60, { pnl: 30, price: 20, direction: 'long' }),
    ];
    const r = sliceTrades(trades);
    assert.equal(r.available, true);
    assert.ok(r.overall.total_pnl > 0, 'the book must be net positive for the point to land');
    assert.ok(r.net_negative_buckets.length >= 1);
    assert.ok(r.net_negative_buckets.some((b) => b.dimension === 'price' && b.bucket.startsWith('> 100')));
    assert.match(r.headline, /net positive/);
    assert.match(r.headline, /−3\.82|-3\.82/);
  });

  test('slices holding time, where his other negative bucket was', () => {
    const trades = [
      ...many(44, { pnl: -18, minutes_held: 20 }),
      ...many(168, { pnl: 23, minutes_held: 3 }),
    ];
    const r = sliceTrades(trades);
    assert.ok(r.slices.minutes_held['15-30m']);
    assert.ok(r.slices.minutes_held['15-30m'].total_pnl < 0);
    assert.ok(r.slices.minutes_held['<= 5m'].total_pnl > 0);
  });

  test('reports direction separately, because shorts can beat longs', () => {
    // Shannon's shorts won 56.4% against his longs' 52.0%.
    const trades = [
      ...many(101, { pnl: 14.83, direction: 'short' }),
      ...many(256, { pnl: 17.68, direction: 'long' }),
    ];
    const r = sliceTrades(trades);
    assert.equal(r.slices.direction.short.n, 101);
    assert.equal(r.slices.direction.long.n, 256);
    assert.match(r.why_slice_at_all, /56\.4% vs 52\.0%/);
  });

  test('every bucket carries its own n, win rate and averages', () => {
    const r = sliceTrades(many(30, { pnl: 5, direction: 'long', shares: 300, price: 40, minutes_held: 10 }));
    const b = r.slices.direction.long;
    for (const k of ['n', 'total_pnl', 'avg_pnl', 'win_rate_pct']) {
      assert.ok(k in b, `bucket missing ${k}`);
    }
    assert.equal(b.n, 30);
    assert.equal(b.win_rate_pct, 100);
  });

  test('UNDERPOWERED buckets are flagged and never ranked as findings', () => {
    /**
     * The guard against fitting noise. Six losing trades is a coin landing
     * tails six times, and ranking it beside a 160-trade bucket would invite
     * exactly the error the rest of this repo measures against.
     */
    const trades = [
      ...many(6, { pnl: -50, price: 200 }),
      ...many(40, { pnl: 10, price: 20 }),
    ];
    const r = sliceTrades(trades, { min_n: 10 });
    assert.equal(r.slices.price['> 100'].underpowered, true);
    assert.ok(!r.net_negative_buckets.some((b) => b.bucket === '> 100'),
      'an underpowered losing bucket must not be reported as a finding');
  });

  test('states how many buckets were examined, so the comparison count is visible', () => {
    const r = sliceTrades(many(40, { pnl: 3, direction: 'long', shares: 400, price: 30, minutes_held: 20 }));
    assert.ok(r.buckets_examined > 1);
    assert.match(r.multiple_comparisons_warning, /buckets were examined/);
    assert.match(r.multiple_comparisons_warning, /HYPOTHESIS/);
    assert.match(r.multiple_comparisons_warning, /survives on later trades/);
  });

  test('splits planned from discretionary when a reason is supplied', () => {
    const r = sliceTrades([
      ...many(12, { pnl: 20, reason: 'target_hit' }),
      ...many(12, { pnl: -30, reason: 'tape_seller' }),
    ]);
    assert.equal(r.slices.exit_planned.planned.n, 12);
    assert.equal(r.slices.exit_planned.discretionary.n, 12);
    assert.ok(r.slices.exit_reason.target_hit);
  });

  test('an unrecognised reason does not create a phantom bucket', () => {
    const r = sliceTrades(many(12, { pnl: 5, reason: 'vibes' }));
    assert.equal(r.slices.exit_reason, undefined);
    assert.equal(r.slices.exit_planned, undefined);
  });

  test('trades without a numeric pnl are unusable, and it says so', () => {
    assert.equal(sliceTrades([{ direction: 'long' }]).available, false);
    assert.match(sliceTrades([{ direction: 'long' }]).note, /numeric pnl/);
    assert.equal(sliceTrades([]).available, false);
    assert.equal(sliceTrades(null).available, false);
  });

  test('a missing dimension is simply absent, not bucketed as zero', () => {
    // Trades with no `shares` must not all land in a "<= 200" bucket.
    const r = sliceTrades(many(20, { pnl: 5, direction: 'long' }));
    assert.equal(r.slices.shares, undefined);
    assert.equal(r.slices.minutes_held, undefined);
    assert.ok(r.slices.direction);
  });

  test('cites the figure it came from', () => {
    assert.match(sliceTrades(many(12, { pnl: 1 })).source, /Figure 16\.2/);
  });
});
