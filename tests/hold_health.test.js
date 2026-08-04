import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { holdHealth, HOLD_HEALTH_NOISE_BASELINE } from '../src/core/hold_health.js';
import { extensionPercentile } from '../src/core/momentum.js';

/** Deterministic bars: closes given, volume given, low = close - 0.5, high = close + 0.5. */
const mk = (closes, volumes = null) => closes.map((c, i) => ({
  time: 1_700_000_000 + i * 86400,
  open: c, close: c, high: c + 0.5, low: c - 0.5,
  volume: volumes ? volumes[i] : 1000,
}));

describe('holdHealth — Minervini violations as numbers (MPA podcast, 2026-08-03)', () => {
  test('a collapsing tail after entry fires the deterioration set', () => {
    // 80 quiet bars, entry, then 20 bars grinding DOWN on rising volume with
    // a record down day at the end.
    const closes = [...Array.from({ length: 80 }, (_, i) => 100 + Math.sin(i / 5)),
      ...Array.from({ length: 19 }, (_, i) => 100 - i * 0.8), 80];
    const vols = [...Array(80).fill(1000), ...Array(19).fill(3000), 9000];
    const h = holdHealth(mk(closes, vols), { entry_bars_ago: 20 });
    assert.ok(h.available);
    const fired = new Set(h.violations.filter((v) => v.fired).map((v) => v.key));
    assert.ok(fired.has('biggest_down_day_since_entry'), 'the -13% final bar dwarfs the pre-entry worst');
    assert.ok(fired.has('biggest_down_volume_since_entry'));
    assert.ok(fired.has('more_down_days_than_up'));
    assert.ok(fired.has('more_volume_down_than_up'));
    assert.ok(fired.has('three_plus_lower_lows'));
    assert.ok(h.violation_count >= 5);
  });

  test('a grinding advance fires confirmations, not violations', () => {
    const closes = Array.from({ length: 100 }, (_, i) => 100 + i * 0.4);
    const h = holdHealth(mk(closes), { entry_bars_ago: 20 });
    assert.equal(h.violations.filter((v) => v.fired && v.key !== 'close_below_entry').length, 0);
    const conf = new Set(h.confirmations.filter((c) => c.fired).map((c) => c.key));
    assert.ok(conf.has('more_up_days_than_down'));
    assert.ok(conf.has('above_ma20'));
    assert.ok(conf.has('new_high_since_entry'));
  });

  test('entry_price omitted reports NOT CHECKED — unknown is not satisfied', () => {
    const h = holdHealth(mk(Array.from({ length: 60 }, (_, i) => 100 + i * 0.1)), { entry_bars_ago: 10 });
    assert.deepEqual(h.not_checked, ['close_below_entry']);
    const clause = h.violations.find((v) => v.key === 'close_below_entry');
    assert.equal(clause.fired, false);
    assert.match(clause.requirement, /NOT CHECKED/);
  });

  test('entry_price supplied and breached fires the clause', () => {
    const closes = [...Array.from({ length: 55 }, () => 100), ...Array.from({ length: 5 }, () => 95)];
    const h = holdHealth(mk(closes), { entry_bars_ago: 10, entry_price: 100 });
    assert.ok(h.violations.find((v) => v.key === 'close_below_entry').fired);
  });

  test('too little history is a refusal, never a clean bill of health', () => {
    const h = holdHealth(mk(Array.from({ length: 20 }, () => 100)), { entry_bars_ago: 18 });
    assert.equal(h.available, false);
    assert.match(h.why, /NOT a clean bill of health/);
  });

  test('the measured floor rides in every result, and its shape is the warning', () => {
    const h = holdHealth(mk(Array.from({ length: 100 }, () => 100)), { entry_bars_ago: 20 });
    assert.equal(h.noise_baseline.walks, 200);
    assert.equal(h.noise_baseline.walks_with_3plus_pct, 51,
      'half of random walks show 3+ violations — the bare count is noise');
    assert.ok(h.noise_baseline.per_clause_pct.three_plus_lower_lows < 15,
      'lower-lows is the selective clause worth weighting');
    assert.match(h.reading, /not a measured exit signal/i);
  });
});

describe('extensionPercentile — the selling-side stretch rank (MPA "historical extension levels")', () => {
  test('an unprecedented surge ranks at the top of its own history', () => {
    const closes = [...Array.from({ length: 200 }, (_, i) => 100 + Math.sin(i / 7) * 2), 140];
    const e = extensionPercentile(mk(closes));
    assert.ok(e.available);
    assert.ok(e.percentile === 100, `a +40% jump over a flat history must rank 100th percentile, got ${e.percentile}`);
    assert.ok(e.distance_pct > 30);
  });

  test('sitting on the average ranks mid-distribution, and deep below ranks LOW — signed on purpose', () => {
    const flat = extensionPercentile(mk(Array.from({ length: 200 }, (_, i) => 100 + Math.sin(i / 7) * 2)));
    assert.ok(flat.percentile > 20 && flat.percentile < 80, `flat close should sit mid-pack, got ${flat.percentile}`);
    const dumped = extensionPercentile(mk([...Array.from({ length: 200 }, () => 100), 70]));
    assert.ok(dumped.percentile < 5, 'far below the average is a LOW percentile, not "also extended"');
  });

  test('too little history refuses with the arithmetic', () => {
    const e = extensionPercentile(mk(Array.from({ length: 100 }, () => 100)));
    assert.equal(e.available, false);
    assert.match(e.why, /needs 170 bars/);
  });
});
