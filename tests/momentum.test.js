import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  timeSeriesMomentum, momentumProfile, persistenceBaseline, versusBaseline, HORIZONS,
} from '../src/core/momentum.js';
import { barsFromPath, randomWalk, legs } from '../src/core/synthetic.js';

const upTrend = (n = 300) => barsFromPath(
  Array.from({ length: n }, (_, i) => 100 * (1 + 0.002 * i)), { noise: 0.004, seed: 1 });
const downTrend = (n = 300) => barsFromPath(
  Array.from({ length: n }, (_, i) => 300 * (1 - 0.0015 * i)), { noise: 0.004, seed: 2 });

describe('timeSeriesMomentum', () => {
  test('reads long on a sustained advance', () => {
    const m = timeSeriesMomentum(upTrend(), { lookback: 252 });
    assert.ok(m.available);
    assert.strictEqual(m.direction, 'long');
    assert.strictEqual(m.signal, 1);
    assert.ok(m.lookback_return_pct > 0);
  });

  test('reads short on a sustained decline', () => {
    const m = timeSeriesMomentum(downTrend(), { lookback: 252 });
    assert.strictEqual(m.direction, 'short');
    assert.strictEqual(m.signal, -1);
  });

  test('REFUSES rather than returning neutral when history is short', () => {
    const m = timeSeriesMomentum(upTrend(100), { lookback: 252 });
    assert.strictEqual(m.available, false);
    assert.strictEqual(m.bars_required, 253);
    assert.match(m.note, /do not read this as a neutral signal/);
  });

  test('signal is the SIGN only — magnitude is not blended in', () => {
    const mild = timeSeriesMomentum(
      barsFromPath(Array.from({ length: 300 }, (_, i) => 100 * (1 + 0.0001 * i)), { noise: 0.001, seed: 3 }),
      { lookback: 252 });
    const strong = timeSeriesMomentum(upTrend(), { lookback: 252 });
    assert.strictEqual(mild.signal, strong.signal, 'signal must not scale with strength');
    assert.ok(strong.lookback_return_pct > mild.lookback_return_pct, 'but the return should differ');
  });

  test('volatility scalar shrinks as volatility rises', () => {
    const calm = timeSeriesMomentum(
      barsFromPath(Array.from({ length: 300 }, (_, i) => 100 * (1 + 0.002 * i)), { noise: 0.001, seed: 4 }),
      { lookback: 252 });
    const wild = timeSeriesMomentum(
      barsFromPath(Array.from({ length: 300 }, (_, i) => 100 * (1 + 0.002 * i) * (1 + (i % 2 ? 0.05 : -0.05))), { noise: 0.02, seed: 5 }),
      { lookback: 252 });
    assert.ok(wild.annualized_volatility_pct > calm.annualized_volatility_pct);
    assert.ok(wild.volatility_scalar < calm.volatility_scalar);
  });

  test('carries the futures-not-equities caveat and the reversal warning', () => {
    const m = timeSeriesMomentum(upTrend(), { lookback: 252 });
    assert.match(m.evidence, /DIVERSIFIED FUTURES, not single equities/);
    assert.match(m.caveat, /partially REVERSES/);
  });
});

describe('momentumProfile', () => {
  test('a clean trend agrees across every horizon', () => {
    const p = momentumProfile(upTrend(400));
    assert.strictEqual(p.agreement, 'all long');
    assert.strictEqual(p.direction, 'long');
    assert.strictEqual(p.horizons_read, Object.keys(HORIZONS).length);
  });

  test('a rally that rolls over reads MIXED rather than picking a side', () => {
    // Twelve months up, then a sharp month down.
    const path = [...legs([100, 200], 260), ...legs([200, 165], 25)];
    const p = momentumProfile(barsFromPath(path, { noise: 0.004, seed: 6 }));
    assert.strictEqual(p.agreement, 'mixed');
    assert.strictEqual(p.direction, null);
    assert.match(p.interpretation, /disagree/);
  });

  test('unreadable horizons are NOT silently counted as neutral', () => {
    const p = momentumProfile(upTrend(150));
    assert.ok(p.horizons_read < p.horizons_requested);
    assert.match(p.warning, /NOT counted as neutral/);
  });

  test('no readable horizon is reported as missing data, not as no signal', () => {
    const p = momentumProfile(upTrend(25));
    assert.strictEqual(p.agreement, 'none');
    assert.match(p.note, /missing data, not a neutral signal/);
  });
});

describe('persistenceBaseline — the floor every forecast must clear', () => {
  test('scores the inflated accuracy the literature reports', () => {
    const b = persistenceBaseline(upTrend(300));
    assert.ok(b.accuracy_pct > 90,
      `daily persistence should look impressive on this metric, got ${b.accuracy_pct}`);
  });

  test('says out loud that a high score here is not skill', () => {
    const b = persistenceBaseline(upTrend(300));
    assert.match(b.how_to_read, /not skill/);
    assert.match(b.why_this_exists, /85\.25 against 85\.21/);
  });

  test('error grows with the forecast horizon', () => {
    const one = persistenceBaseline(upTrend(300), { horizon: 1 });
    const twenty = persistenceBaseline(upTrend(300), { horizon: 20 });
    assert.ok(twenty.mean_abs_pct_error > one.mean_abs_pct_error);
  });
});

describe('versusBaseline', () => {
  test('a perfect oracle beats the coin flip outright', () => {
    const bars = upTrend(200);
    const oracle = (i) => (bars[i + 1] && bars[i + 1].close > bars[i].close ? 1 : -1);
    const out = versusBaseline(bars, oracle, { horizon: 1 });
    assert.ok(out.signal_hit_rate_pct > 90, `oracle scored ${out.signal_hit_rate_pct}`);
    assert.match(out.verdict, /beats a coin flip/);
  });

  test('a signal that never fires is reported as such, not as a failure', () => {
    const out = versusBaseline(upTrend(100), () => 0);
    assert.strictEqual(out.signal_taken, 0);
    assert.match(out.verdict, /never fired/);
  });

  test('a constant signal on a random walk lands near 50%', () => {
    const bars = barsFromPath(randomWalk({ n: 400, seed: 12 }), { noise: 0.005, seed: 13 });
    const out = versusBaseline(bars, () => 1, { horizon: 1 });
    assert.ok(Math.abs(out.signal_hit_rate_pct - 50) < 12,
      `always-long on noise should be near 50%, got ${out.signal_hit_rate_pct}`);
  });

  test('always reports the persistence baseline alongside', () => {
    const out = versusBaseline(upTrend(200), () => 1);
    assert.ok(out.persistence_baseline.available);
    assert.ok(out.persistence_baseline.accuracy_pct > 0);
  });

  test('warns that hit rate ignores the size of the moves', () => {
    const out = versusBaseline(upTrend(200), () => 1);
    assert.match(out.caveat, /ignores the SIZE of the moves/);
  });

  test('rejects a non-function signal', () => {
    assert.throws(() => versusBaseline(upTrend(100), 'nope'), /must be a function/);
  });
});
