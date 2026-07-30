import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  findTimeCorrections, TIME_CORRECTION_NOISE_BASELINE,
  normalizeBars, findSwings, alternateSwings, classifyLegs,
} from '../src/core/structure.js';
import { randomWalk, barsFromPath } from '../src/core/synthetic.js';

/**
 * Build a series with an explicit shape: a rise, then a flat quiet stretch, then
 * whatever comes next. `flatVol` controls how quiet the digestion is.
 */
function riseThenFlat({ riseBars = 20, risePct = 12, flatBars = 14, flatVol = 0.0015, after = 0, start = 100 } = {}) {
  const bars = [];
  let px = start;
  const step = (start * (risePct / 100)) / riseBars;
  const push = (p, vol) => {
    const h = p * (1 + vol); const l = p * (1 - vol);
    bars.push({ time: (bars.length + 1) * 86400000, open: p, high: h, low: l, close: p, volume: 1000 });
  };
  for (let i = 0; i < riseBars; i += 1) { px += step; push(px, 0.012); }
  // Flat: alternate tiny up/down so drift ~0 and path > net (low efficiency).
  const base = px;
  for (let i = 0; i < flatBars; i += 1) {
    px = base * (1 + (i % 2 === 0 ? flatVol : -flatVol));
    push(px, flatVol);
  }
  for (let i = 0; i < after; i += 1) { px *= 1.015; push(px, 0.012); }
  return normalizeBars(bars);
}

describe('findTimeCorrections — the correction depth cannot see', () => {
  test('detects a horizontal quiet stretch after a move', () => {
    const r = findTimeCorrections(riseThenFlat({ after: 15 }), { window: 8, prior_window: 15 });
    assert.equal(r.available, true);
    assert.ok(r.count >= 1, `found ${r.count}`);
    assert.equal(r.corrections[0].kind, 'time_correction');
    assert.equal(r.corrections[0].digesting.direction, 'up');
    assert.ok(r.corrections[0].digesting.move_pct > 4);
  });

  test('the same stretch produces NO pullback leg, which is the whole point', () => {
    /**
     * The load-bearing case. classifyLegs measures bar quality between swings,
     * so a flat digestion yields no leg with meaningful depth — a depth-based
     * pullback rule concludes "no pullback" and skips a live setup.
     */
    const bars = riseThenFlat({ after: 15 });
    const legs = classifyLegs(bars, alternateSwings(findSwings(bars, { lookback: 3 })));
    const deepPullbacks = legs.legs.filter((l) => l.kind === 'pullback' && Math.abs(l.move_pct) > 2);
    assert.equal(deepPullbacks.length, 0, 'a depth rule should see no meaningful pullback here');
    // But the time-correction detector does see it.
    assert.ok(findTimeCorrections(bars, { window: 8, prior_window: 15 }).count >= 1);
  });

  test('requires a prior move — a quiet stretch with nothing to digest is not one', () => {
    const flatOnly = riseThenFlat({ riseBars: 20, risePct: 0.2, flatBars: 20 });
    assert.equal(findTimeCorrections(flatOnly, { window: 8, prior_window: 15 }).count, 0);
  });

  test('rejects a stretch that drifts too far to be horizontal', () => {
    // Keep the volatility low but let it trend: drift disqualifies it.
    const drifting = riseThenFlat({ flatBars: 14, flatVol: 0.001 });
    const bars = drifting.map((b, i) => {
      if (i < 20) return b;
      const k = 1 + (i - 20) * 0.01; // 1% per bar of drift through the "flat"
      return { ...b, open: b.open * k, high: b.high * k, low: b.low * k, close: b.close * k };
    });
    const r = findTimeCorrections(normalizeBars(bars), { window: 8, prior_window: 15, max_drift_pct: 3 });
    assert.equal(r.count, 0);
  });

  test('rejects a stretch whose volatility did not contract', () => {
    const noisy = riseThenFlat({ flatBars: 14, flatVol: 0.03 });
    const r = findTimeCorrections(noisy, { window: 8, prior_window: 15, max_vol_ratio: 0.7 });
    assert.equal(r.count, 0);
  });

  test('every correction reports all four measurements against their thresholds', () => {
    const r = findTimeCorrections(riseThenFlat({ after: 15 }), { window: 8, prior_window: 15 });
    const c = r.corrections[0];
    for (const k of ['drift_pct', 'range_pct', 'vol_ratio', 'efficiency']) {
      assert.ok(Number.isFinite(c.measurements[k]), `${k} missing`);
    }
    for (const k of ['max_drift_pct', 'max_vol_ratio', 'max_efficiency', 'min_prior_impulse_pct']) {
      assert.ok(Number.isFinite(c.thresholds[k]), `${k} threshold missing`);
    }
    // A near miss must be diagnosable, so the evidence names the numbers.
    assert.match(c.evidence, /drift/);
    assert.match(c.evidence, /efficiency/);
  });

  test('overlapping windows merge into ONE correction, not one per position', () => {
    const r = findTimeCorrections(riseThenFlat({ flatBars: 30, after: 15 }), { window: 8, prior_window: 15 });
    assert.equal(r.count, 1);
    assert.ok(r.corrections[0].windows_merged > 1, 'should have merged several sliding windows');
    // And the merged stretch must be LONGER than the scan window, or the merge
    // did nothing useful.
    assert.ok(r.corrections[0].bars > 8, `merged span was only ${r.corrections[0].bars} bars`);
  });
});

describe('findTimeCorrections — resolution is measured, not asserted', () => {
  test('reports which way a completed correction broke', () => {
    const r = findTimeCorrections(riseThenFlat({ after: 20 }), { window: 8, prior_window: 15, resolution_bars: 10 });
    const c = r.corrections[0];
    assert.ok(['up', 'down', 'still_inside'].includes(c.resolution.broke));
    assert.equal(c.resolution.broke, 'up');
    assert.equal(c.resolution.with_prior_trend, true);
  });

  test('an unresolved correction says so rather than being scored', () => {
    // Ending the series inside the correction must not produce a verdict.
    const r = findTimeCorrections(riseThenFlat({ after: 0 }), { window: 8, prior_window: 15, resolution_bars: 10 });
    assert.ok(r.corrections.length);
    assert.ok(r.corrections.at(-1).resolution_pending);
    assert.equal(r.corrections.at(-1).resolution, undefined);
  });

  test('the resolution summary states the coin-flip baseline beside its own count', () => {
    const r = findTimeCorrections(riseThenFlat({ after: 20 }), { window: 8, prior_window: 15 });
    assert.match(r.resolution_summary.note, /50% is the coin-flip baseline/);
    assert.match(r.resolution_summary.note, /proves nothing/);
  });
});

describe('the measured baseline — detector descriptive, claim untested', () => {
  test('records BOTH arms with their sample sizes and the timeframe', () => {
    const b = TIME_CORRECTION_NOISE_BASELINE;
    assert.match(b.status, /DETECTOR DESCRIPTIVE, RESOLUTION CLAIM UNTESTED/);
    assert.equal(b.detection.random_walk.fires_pct, 88.0);
    assert.equal(b.detection.real_data.fires_pct, 91.7);
    // The timeframe must be recorded, because an unlabelled one caused the
    // earlier version of this constant to be wrong.
    assert.equal(b.detection.real_data.timeframe, '1D');
  });

  test('calls the detector descriptive — it fires on nearly everything', () => {
    const d = TIME_CORRECTION_NOISE_BASELINE.detection;
    assert.ok(d.random_walk.fires_pct > 80 && d.real_data.fires_pct > 80);
    assert.match(d.verdict, /DESCRIPTIVE ONLY/);
    assert.match(d.verdict, /no pullback/);
  });

  test('the resolution claim is UNTESTED, not refuted — and the signs disagree', () => {
    /**
     * The correction. An earlier version read "NO EDGE, real data BELOW its own
     * null". That was the 60-minute arm mislabelled as daily, and n=14 never
     * supported the confidence. On daily the lift is POSITIVE. Opposite signs on
     * samples of 18 and 14 is what a null looks like.
     */
    const r = TIME_CORRECTION_NOISE_BASELINE.resolution_claim;
    assert.match(r.verdict, /NOT SETTLED/);
    assert.ok(r.real_data_1D.lift_points > 0, 'daily lift is positive');
    assert.ok(r.real_data_60min.lift_points < 0, '60-minute lift is negative');
    assert.ok(Math.abs(r.real_data_1D.z) < 1.96, 'and neither is significant');
  });

  test('both real arms are tiny against a well-estimated null', () => {
    const r = TIME_CORRECTION_NOISE_BASELINE.resolution_claim;
    assert.ok(r.real_data_1D.resolved < 40);
    assert.ok(r.real_data_60min.resolved < 40);
    assert.ok(r.random_walk.resolved > 200, 'the null is the only well-estimated number here');
  });

  test('says what WOULD settle it rather than leaving a shrug', () => {
    const r = TIME_CORRECTION_NOISE_BASELINE.resolution_claim;
    assert.match(r.what_would_settle_it, /hundred resolved corrections/);
    assert.match(r.what_would_settle_it, /UNTESTED here, not because it is refuted/);
  });

  test('keeps the record of the earlier wrong version', () => {
    // A repo that silently rewrites its failed claims cannot be audited.
    const r = TIME_CORRECTION_NOISE_BASELINE.resolution_claim;
    assert.match(r.correction_history, /60-minute resolution and labelled daily/);
    assert.match(r.correction_history, /n=14 never supported/);
  });

  test('the detector reproduces its own measured noise rate', () => {
    // If this drifts the recorded baseline is stale and must be re-measured.
    let hits = 0;
    for (let seed = 1; seed <= 60; seed += 1) {
      const bars = normalizeBars(barsFromPath(randomWalk({ n: 300, vol: 0.015, seed })));
      if (findTimeCorrections(bars).count > 0) hits += 1;
    }
    const rate = (hits / 60) * 100;
    assert.ok(Math.abs(rate - 88) < 12, `noise rate drifted to ${rate}% from the recorded 88%`);
  });

  test('names the script and says the timeframe is pinnable', () => {
    assert.match(TIME_CORRECTION_NOISE_BASELINE.script, /time-correction-noise/);
    assert.match(TIME_CORRECTION_NOISE_BASELINE.script, /--timeframe/);
  });
});

describe('honesty and edges', () => {
  test('says outright it is a state and not a direction', () => {
    const r = findTimeCorrections(riseThenFlat({ after: 15 }), { window: 8, prior_window: 15 });
    assert.match(r.what_this_is, /STATE, never a direction/);
    assert.match(r.what_this_is, /100% of random walks/);
    assert.match(r.why_it_matters, /no pullback/);
    assert.match(r.source, /ch\. 8/);
  });

  test('too few bars is unavailable, and says how many it needed', () => {
    const r = findTimeCorrections(riseThenFlat({ riseBars: 3, flatBars: 3 }), { window: 10, prior_window: 20 });
    assert.equal(r.available, false);
    assert.match(r.note, /Need at least/);
    assert.deepEqual(r.corrections, []);
  });

  test('handles an empty or bad series without throwing', () => {
    for (const bad of [[], null, undefined]) {
      const r = findTimeCorrections(bad);
      assert.equal(r.available, false);
    }
  });

  test('works on a downtrend digestion too', () => {
    const bars = riseThenFlat({ risePct: -12, after: 15 });
    const r = findTimeCorrections(bars, { window: 8, prior_window: 15 });
    assert.ok(r.count >= 1);
    assert.equal(r.corrections[0].digesting.direction, 'down');
  });
});
