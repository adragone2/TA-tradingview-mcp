import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  decileRank, madValue, movingAverageDistance, MAD_SPEC,
  trendSignals, trendFactor, TREND_LAGS,
  volumePremium, volatilityRegime, shortTermReversal, allFactors,
} from '../src/core/factors.js';

const row = (o = {}) => ({
  symbol: 'X', name: 'X', close: 100,
  SMA10: 101, SMA20: 102, SMA50: 100, SMA100: 98, SMA200: 95,
  relative_volume_10d_calc: 1.0, 'Perf.W': 1, ...o,
});
const many = (n, f) => Array.from({ length: n }, (_, i) => row(f(i)));

describe('decileRank — the sort every one of these depends on', () => {
  test('assigns 1 to the lowest and 10 to the highest', () => {
    const r = decileRank(many(100, (i) => ({ symbol: `S${i}`, 'Perf.W': i })), (x) => x['Perf.W']);
    assert.equal(r[0]._decile, 1);
    assert.equal(r.at(-1)._decile, 10);
  });

  test('rows with NO value are EXCLUDED, not sorted to an end', () => {
    // Sorting a missing signal to the bottom makes it read as a strong short,
    // which is how a data gap becomes a position.
    const rows = [row({ symbol: 'A', 'Perf.W': 5 }), row({ symbol: 'B', 'Perf.W': null }),
      row({ symbol: 'C', 'Perf.W': undefined }), row({ symbol: 'D', 'Perf.W': NaN })];
    const r = decileRank(rows, (x) => x['Perf.W']);
    assert.equal(r.length, 1);
    assert.equal(r[0].symbol, 'A');
  });

  test('a cross-section too small to decile gets null ranks, not fake ones', () => {
    const r = decileRank(many(4, (i) => ({ 'Perf.W': i })), (x) => x['Perf.W']);
    assert.ok(r.every((x) => x._decile === null));
  });

  test('percentile rank spans 0..1', () => {
    const r = decileRank(many(11, (i) => ({ 'Perf.W': i })), (x) => x['Perf.W']);
    assert.equal(r[0]._pct_rank, 0);
    assert.equal(r.at(-1)._pct_rank, 1);
  });
});

describe('Moving Average Distance — Tier A, and a STATE not an EVENT', () => {
  test('is the normalised distance between the two averages', () => {
    assert.equal(madValue(row({ SMA20: 110, SMA200: 100 })), 0.1);
    assert.equal(madValue(row({ SMA20: 90, SMA200: 100 })), -0.1);
  });

  test('is null when either average is missing — never zero', () => {
    // Zero means "at the long-run average", which is a real and different
    // statement from "we do not know".
    assert.equal(madValue(row({ SMA20: null })), null);
    assert.equal(madValue(row({ SMA200: null })), null);
    assert.equal(madValue(row({ SMA200: 0 })), null);
  });

  test('the long side is the TOP decile, and the spec says why that matters', () => {
    const r = movingAverageDistance(many(100, (i) => ({ symbol: `S${i}`, SMA20: 100 + i, SMA200: 100 })));
    assert.ok(r.long_side.every((x) => x._decile === 10));
    assert.ok(r.short_side.every((x) => x._decile === 1));
    assert.match(r.long_side_note, /cannot short cheaply/);
  });

  test('the spec records that it is NOT a crossover trigger', () => {
    // The single easiest way to implement this wrongly while believing the
    // evidence still applies.
    assert.match(MAD_SPEC.caution, /STATE, not an EVENT/);
    assert.match(MAD_SPEC.caution, /[Nn]ot a crossover/);
    assert.equal(MAD_SPEC.rebalance, 'monthly');
    assert.equal(MAD_SPEC.horizon, 'MONTHS');
  });

  test('the 20-vs-21-day substitution is declared, not hidden', () => {
    assert.equal(MAD_SPEC.paper_short_days, 21);
    assert.equal(MAD_SPEC.short_field, 'SMA20');
    assert.match(MAD_SPEC.substitution_note, /insensitive to lag/);
  });
});

describe('the trend factor — the weights are NOT invented', () => {
  test('produces the signal vector across lags', () => {
    const s = trendSignals(row({ close: 100, SMA50: 95 }));
    assert.equal(s.SMA50, 0.95);
    assert.deepEqual(Object.keys(s), TREND_LAGS);
  });

  test('a missing average is null rather than dropped from the vector', () => {
    assert.equal(trendSignals(row({ SMA200: null })).SMA200, null);
  });

  test('weights are null, and the output says why', () => {
    /**
     * The paper LEARNS coefficients by monthly cross-sectional regression. An
     * equal-weighted blend is a different object with none of the evidence, so
     * shipping one under this name would borrow credibility it has not earned.
     */
    const f = trendFactor([row()]);
    assert.equal(f.weights, null);
    assert.match(f.weights_note, /NOT IMPLEMENTED/);
    assert.match(f.weights_note, /DIFFERENT object/);
    assert.ok(f.to_enable, 'no path to completing it was recorded');
  });

  test('no composite score is emitted that could be mistaken for the factor', () => {
    const f = trendFactor([row()]);
    for (const k of ['score', 'composite', 'value', 'rank', 'decile']) {
      assert.ok(!(k in f), `trendFactor emitted "${k}" — that would read as the factor itself`);
    }
  });
});

describe('high-volume premium — measured as a MONTHLY sort, not a breakout filter', () => {
  test('ranks on relative volume, top decile long', () => {
    const r = volumePremium(many(100, (i) => ({ symbol: `S${i}`, relative_volume_10d_calc: i / 10 })));
    assert.ok(r.long_side.every((x) => x._decile === 10));
    assert.equal(r.hold, '~1 month');
  });

  test('carries the warning that it is not a same-day confirmation filter', () => {
    // This repo has used relative volume that way before. The effect size has
    // no basis for surviving that translation.
    assert.match(volumePremium([row()]).caution, /NOT a same-day breakout/);
  });
});

describe('short-term reversal — the conditioning is the result', () => {
  const rows = many(100, (i) => ({ symbol: `S${i}`, 'Perf.W': i - 50 }));

  test('is INACTIVE and returns an EMPTY long side when VIX is low', () => {
    /**
     * Nagel: reversal portfolios "earn essentially nothing unconditionally".
     * Running this unconditionally is not a weaker version of the result — it
     * is discarding it. So the long side must be empty, not merely flagged.
     */
    const r = shortTermReversal(rows, { vix: 12 });
    assert.equal(r.active, false);
    assert.deepEqual(r.long_side, []);
    assert.match(r.long_side_note, /EMPTY BY DESIGN/);
  });

  test('activates when VIX is elevated, and buys the LOSERS', () => {
    const r = shortTermReversal(rows, { vix: 30 });
    assert.equal(r.active, true);
    assert.ok(r.long_side.length > 0);
    // Decile 1 on prior-week return = the biggest losers.
    assert.ok(r.long_side.every((x) => x._decile === 1));
    assert.ok(Math.max(...r.long_side.map((x) => x._value)) < 0);
  });

  test('an UNKNOWN VIX is inactive, not assumed favourable', () => {
    for (const v of [null, undefined, NaN]) {
      const r = volatilityRegime(v);
      assert.equal(r.favourable, false);
      assert.equal(r.unknown, true);
    }
  });

  test('the threshold is reported alongside the level, so the call is visible', () => {
    const r = volatilityRegime(19.94, { threshold: 20 });
    assert.equal(r.favourable, false);
    assert.equal(r.vix, 19.94);
    assert.equal(r.threshold, 20);
    // A live run sat 0.06 below the line. The paper has returns rising
    // CONTINUOUSLY with VIX, so a hard edge here is a discretisation.
    assert.match(r.caution, /discretisation/);
  });

  test('the threshold is configurable, because it is a choice not a finding', () => {
    assert.equal(volatilityRegime(18, { threshold: 15 }).favourable, true);
    assert.equal(volatilityRegime(18, { threshold: 25 }).favourable, false);
  });
});

describe('allFactors — bucketed by horizon', () => {
  const rows = many(100, (i) => ({ symbol: `S${i}`, SMA20: 100 + i, SMA200: 100, 'Perf.W': i - 50, relative_volume_10d_calc: i / 10 }));

  test('three factors in MONTHS, one in WEEKS', () => {
    const f = allFactors(rows, { vix: 25 });
    assert.deepEqual(Object.keys(f.months).sort(), ['high_volume_premium', 'moving_average_distance', 'trend_factor']);
    assert.deepEqual(Object.keys(f.weeks), ['short_term_reversal']);
  });

  test('the cross-sectional caveat travels with the result', () => {
    // A decile is a statement about rank in a universe, not a forecast for the
    // name — which is what edge_breadth exists to quantify.
    assert.match(allFactors(rows, { vix: 25 }).note, /edge_breadth/);
  });

  test('every factor declares its horizon bucket', () => {
    const f = allFactors(rows, { vix: 25 });
    assert.equal(f.months.moving_average_distance.horizon, 'MONTHS');
    assert.equal(f.months.high_volume_premium.horizon, 'MONTHS');
    assert.equal(f.months.trend_factor.horizon, 'MONTHS');
    assert.equal(f.weeks.short_term_reversal.horizon, 'WEEKS');
  });
});
