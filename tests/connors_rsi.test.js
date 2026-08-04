import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  connorsRsi, connorsRsiSeries, streakSeries, percentRankSeries, CONNORS_RSI_NOISE,
} from '../src/core/connors_rsi.js';
import { positionCorrelation } from '../src/core/portfolio.js';

const mkBars = (closes) => closes.map((c, i) => ({
  time: 1_700_000_000 + i * 86400, open: c, close: c, high: c + 0.1, low: c - 0.1, volume: 1000,
}));

describe('ConnorsRSI — the published formula, component by component', () => {
  test('streaks count consecutive closes, signed, reset on flat', () => {
    assert.deepEqual(streakSeries([1, 2, 3, 2, 1, 1, 2]), [0, 1, 2, -1, -2, 0, 1]);
  });

  test('percent rank is the share of prior returns strictly below today, x100', () => {
    // 102 closes of +1% steps, then one -5% day: today's return is below all
    // 100 in the window -> rank 0. A +10% day would be above all -> 100.
    const up = Array.from({ length: 103 }, (_, i) => 100 * 1.01 ** i);
    const crash = [...up.slice(0, 102), up[101] * 0.95];
    const rank = percentRankSeries(crash, 100);
    assert.equal(rank[rank.length - 1], 0);
    const surge = [...up.slice(0, 102), up[101] * 1.10];
    assert.equal(percentRankSeries(surge, 100).at(-1), 100);
  });

  test('a persistent decline reads deep fear, a persistent advance reads the opposite', () => {
    const base = Array.from({ length: 120 }, (_, i) => 100 + Math.sin(i / 5));
    const dumped = connorsRsi(mkBars([...base, ...Array.from({ length: 5 }, (_, i) => 98 - i * 2)]));
    assert.ok(dumped.current < 20, `5 straight heavy down closes should read <20, got ${dumped.current}`);
    const ripped = connorsRsi(mkBars([...base, ...Array.from({ length: 5 }, (_, i) => 102 + i * 2)]));
    assert.ok(ripped.current > 80, `5 straight heavy up closes should read >80, got ${ripped.current}`);
  });

  test('too little history refuses with the arithmetic — the rank window is the binding term', () => {
    const r = connorsRsi(mkBars(Array.from({ length: 80 }, () => 100)));
    assert.equal(r.available, false);
    assert.match(r.why, /needs 102 bars/);
  });

  test('the floor rides in every result, and the lift null is the yardstick', () => {
    const r = connorsRsi(mkBars(Array.from({ length: 120 }, (_, i) => 100 + Math.sin(i / 5))));
    assert.equal(r.noise_baseline.walks, 200);
    assert.equal(r.noise_baseline.occupancy_pct.lt10, 2.3,
      'pure noise reads oversold ~7 times per 300-bar chart — quote this beside any reading');
    assert.ok(Math.abs(r.noise_baseline.lift_null.mean_pp) < 0.1, 'the null is centred on zero');
    assert.match(r.reading, /NO screen|no screen|feeds no screen/i);
  });

  test('the series is null until every component is defined, never a partial average', () => {
    const closes = Array.from({ length: 150 }, (_, i) => 100 + Math.sin(i / 3));
    const s = connorsRsiSeries(closes);
    assert.equal(s[50], null, 'inside the rank warm-up the reading must be null');
    assert.ok(s[120] != null && s[120] >= 0 && s[120] <= 100);
  });
});

describe('positionCorrelation — dynamic windows (Connors, 2026-08-03)', () => {
  /**
   * Two series, 300 points: independent for 237, then IDENTICAL for the last
   * 63 — the selloff shape, where co-movement appears at the short end first.
   */
  const a = [], b = [];
  for (let i = 0; i < 237; i++) { a.push(Math.sin(i * 1.7) * 0.01); b.push(Math.cos(i * 2.3) * 0.01); }
  for (let i = 0; i < 63; i++) { const v = Math.sin(i) * 0.02; a.push(v); b.push(v); }

  test('the short window sees the regime change the full window dilutes', () => {
    const r = positionCorrelation({ A: a, B: b });
    const p = r.pairs[0];
    assert.ok(p.by_window.w63 > 0.99, `last-63 correlation should read ~1, got ${p.by_window.w63}`);
    assert.ok(p.by_window.w252 < p.by_window.w63, 'the long window must dilute the recent co-movement');
    assert.equal(p.worst_window, p.by_window.w63, 'worst_window is the largest absolute reading');
  });

  test('effective_positions_conservative sizes against the worst window, not the average', () => {
    const r = positionCorrelation({ A: a, B: b });
    assert.ok(r.effective_positions_conservative < r.effective_positions,
      'the conservative bet count must be lower when any window shows tighter co-movement');
    assert.ok(r.effective_positions_conservative < 1.1,
      'two positions moving identically over the last quarter are ~1 bet');
  });

  test('windows a pair cannot fill are omitted, never zero-filled', () => {
    const short = { A: a.slice(-70), B: b.slice(-70) };
    const r = positionCorrelation(short);
    const p = r.pairs[0];
    assert.ok(p.by_window.w63 != null);
    assert.equal(p.by_window.w126, undefined, 'a 70-point series has no 126-point window');
    assert.equal(p.by_window.w252, undefined);
  });

  test('single-window behaviour is unchanged — the additions are additive', () => {
    const r = positionCorrelation({ A: a, B: b });
    assert.ok(r.available && r.pairs[0].correlation != null && r.effective_positions != null);
    assert.match(r.dynamic_windows_note, /worst_window/);
  });
});
