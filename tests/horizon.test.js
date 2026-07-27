import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  horizonZone, setupFamily, horizonPrior, reversalConditioning, HORIZON_ZONES,
} from '../src/core/horizon.js';
import { turnoverDrag, hysteresisExit, signalToFillSlippage } from '../src/core/costs.js';
import { barsFromPath, randomWalk } from '../src/core/synthetic.js';

describe('horizonZone — the boundary the swing window straddles', () => {
  test('under 21 days is the reversal zone', () => {
    assert.strictEqual(horizonZone(2).zone, 'reversal');
    assert.strictEqual(horizonZone(10).zone, 'reversal');
    assert.strictEqual(horizonZone(21).zone, 'reversal');
  });

  test('22 to 62 days is contested — the stretch momentum skips', () => {
    assert.strictEqual(horizonZone(22).zone, 'contested');
    assert.strictEqual(horizonZone(45).zone, 'contested');
  });

  test('63 days and beyond is the continuation zone', () => {
    assert.strictEqual(horizonZone(63).zone, 'continuation');
    assert.strictEqual(horizonZone(252).zone, 'continuation');
  });

  test('rejects a non-positive holding period', () => {
    assert.throws(() => horizonZone(0), /must be positive/);
  });

  test('each zone cites its source', () => {
    assert.match(HORIZON_ZONES.reversal.sources, /Jegadeesh \(1990\)/);
    assert.match(HORIZON_ZONES.continuation.sources, /Jegadeesh & Titman \(1993\)/);
  });
});

describe('setupFamily', () => {
  test('our detectors are overwhelmingly continuation-flavoured', () => {
    for (const s of ['bull_flag', 'vcp', 'ascending_triangle', 'rectangle', 'breakout']) {
      assert.strictEqual(setupFamily(s), 'continuation', `${s} should be continuation`);
    }
  });

  test('classic tops and bottoms are reversal', () => {
    for (const s of ['double_top', 'head_and_shoulders', 'wyckoff_spring', 'divergence']) {
      assert.strictEqual(setupFamily(s), 'reversal', `${s} should be reversal`);
    }
  });

  test('an unknown setup is unclassified, not guessed', () => {
    assert.strictEqual(setupFamily('mystery_pattern'), 'unclassified');
  });
});

describe('horizonPrior — the finding this module exists for', () => {
  test('a bull flag held 10 days runs AGAINST the documented effect', () => {
    const p = horizonPrior('bull_flag', { holding_days: 10 });
    assert.strictEqual(p.setup_family, 'continuation');
    assert.strictEqual(p.horizon_zone, 'reversal');
    assert.match(p.alignment, /AGAINST/);
    assert.match(p.guidance, /materially LOWER/);
  });

  test('the same bull flag held 6 months runs WITH it', () => {
    const p = horizonPrior('bull_flag', { holding_days: 126 });
    assert.strictEqual(p.horizon_zone, 'continuation');
    assert.match(p.alignment, /with the documented effect/);
  });

  test('a reversal setup at swing horizon is the favourable case', () => {
    const p = horizonPrior('double_bottom', { holding_days: 8 });
    assert.match(p.alignment, /with the documented effect/);
  });

  test('the contested zone is reported as the literature declining to take a side', () => {
    const p = horizonPrior('bull_flag', { holding_days: 40 });
    assert.strictEqual(p.horizon_zone, 'contested');
    assert.match(p.guidance, /deliberately SKIPS/);
  });

  test('an unclassified setup refuses to produce a prior', () => {
    const p = horizonPrior('mystery_pattern', { holding_days: 10 });
    assert.strictEqual(p.alignment, 'unknown');
    assert.match(p.note, /Classify it before reading a prior/);
  });

  test('states plainly that it is a prior, not a forecast', () => {
    const p = horizonPrior('vcp', { holding_days: 5 });
    assert.match(p.caveat, /a PRIOR, not a forecast/);
    assert.match(p.the_boundary, /skip-month/);
  });
});

describe('reversalConditioning — Nagel', () => {
  test('reports a volatility percentile and a regime', () => {
    const b = barsFromPath(randomWalk({ n: 400, seed: 3 }), { noise: 0.008, seed: 4 });
    const r = reversalConditioning(b);
    assert.ok(r.available);
    assert.ok(r.volatility_percentile >= 0 && r.volatility_percentile <= 100);
    assert.ok(['elevated', 'calm', 'ordinary'].includes(r.regime));
  });

  test('elevated volatility gives the favourable mean-reversion reading', () => {
    // Calm history, then a violent tail.
    const calm = Array.from({ length: 320 }, (_, i) => 100 + Math.sin(i / 9) * 0.4);
    const wild = Array.from({ length: 30 }, (_, i) => 100 + (i % 2 ? 9 : -9));
    const b = barsFromPath([...calm, ...wild], { noise: 0.002, seed: 5 });
    const r = reversalConditioning(b);
    assert.strictEqual(r.regime, 'elevated');
    assert.match(r.mean_reversion_expectation, /^FAVOURABLE/);
  });

  test('names the mechanism as liquidity provision, not a free anomaly', () => {
    const b = barsFromPath(randomWalk({ n: 400, seed: 6 }), { noise: 0.008, seed: 7 });
    const r = reversalConditioning(b);
    assert.match(r.mechanism, /SUPPLYING LIQUIDITY/);
    assert.match(r.mechanism, /not a free anomaly/);
  });

  test('admits it is proxying for VIX', () => {
    const b = barsFromPath(randomWalk({ n: 400, seed: 8 }), { noise: 0.008, seed: 9 });
    assert.match(reversalConditioning(b).proxy_warning, /cannot see VIX/);
  });

  test('refuses without enough history to build a percentile', () => {
    assert.strictEqual(reversalConditioning(barsFromPath(randomWalk({ n: 50 }), {})).available, false);
  });
});

describe('turnoverDrag — the arithmetic that kills most swing systems', () => {
  test('a 5-day hold at 20bps consumes about 10% a year', () => {
    const d = turnoverDrag({ holding_days: 5, round_trip_bps: 20 });
    assert.strictEqual(d.trades_per_year, 50.4);
    assert.ok(Math.abs(d.annual_cost_drag_pct - 10.08) < 0.01);
    assert.match(d.verdict, /^SEVERE/);
  });

  test('drag falls as the holding period lengthens', () => {
    const short = turnoverDrag({ holding_days: 3, round_trip_bps: 20 });
    const long = turnoverDrag({ holding_days: 60, round_trip_bps: 20 });
    assert.ok(short.annual_cost_drag_pct > long.annual_cost_drag_pct * 10);
    assert.match(long.verdict, /Manageable/);
  });

  test('rejects nonsensical inputs', () => {
    assert.throws(() => turnoverDrag({ holding_days: 0 }), /must be positive/);
    assert.throws(() => turnoverDrag({ round_trip_bps: -1 }), /non-negative/);
  });
});

describe('hysteresisExit — the cheapest turnover reduction available', () => {
  test('a 20/50 band cuts cost drag substantially', () => {
    const h = hysteresisExit({ entry_rank_pct: 20, exit_rank_pct: 50, holding_days: 5 });
    assert.ok(h.is_hysteresis);
    assert.ok(h.cost_saved_pct_per_year > 0);
    assert.ok(h.with_hysteresis.trades_per_year < h.naive_exit.trades_per_year);
  });

  test('identical thresholds are flagged as the naive maximum-turnover rule', () => {
    const h = hysteresisExit({ entry_rank_pct: 20, exit_rank_pct: 20 });
    assert.strictEqual(h.is_hysteresis, false);
    assert.match(h.warning, /naive maximum-turnover rule/);
  });

  test('rejects an exit threshold tighter than the entry — that is anti-hysteresis', () => {
    assert.throws(() => hysteresisExit({ entry_rank_pct: 50, exit_rank_pct: 20 }), /opposite of hysteresis/);
  });

  test('calls its own estimate an approximation', () => {
    assert.match(hysteresisExit({}).caveat, /first-order approximation/);
  });
});

describe('signalToFillSlippage', () => {
  test('measures the overnight gap in the direction of the trade', () => {
    const b = barsFromPath(randomWalk({ n: 300, seed: 11 }), { noise: 0.01, seed: 12 });
    const long = signalToFillSlippage(b, { direction: 'long' });
    const short = signalToFillSlippage(b, { direction: 'short' });
    assert.ok(long.available);
    assert.ok(Math.abs(long.mean_slippage_pct + short.mean_slippage_pct) < 1e-6,
      'long and short slippage must be exact opposites');
  });

  test('reports what share of gaps moved against the trade', () => {
    const b = barsFromPath(randomWalk({ n: 300, seed: 13 }), { noise: 0.01, seed: 14 });
    const s = signalToFillSlippage(b);
    assert.ok(s.adverse_share_pct >= 0 && s.adverse_share_pct <= 100);
  });

  test('says it is separate from spread and commission', () => {
    const b = barsFromPath(randomWalk({ n: 200, seed: 15 }), { noise: 0.01, seed: 16 });
    assert.match(signalToFillSlippage(b).what_it_means, /SEPARATE from spread and commission/);
  });

  test('short input is reported, not crashed on', () => {
    assert.strictEqual(signalToFillSlippage([]).available, false);
  });
});
