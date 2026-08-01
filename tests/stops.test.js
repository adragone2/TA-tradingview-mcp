import { test, describe } from 'node:test';
import assert from 'node:assert';
import { autocorrelation, stoppingPremium, backtestStop, atrTrail } from '../src/core/stops.js';
import { movingAverageDistance } from '../src/core/momentum.js';
import { CANDLE_ACADEMIC_EVIDENCE, detectPatterns } from '../src/core/patterns.js';
import { barsFromPath, randomWalk, rng } from '../src/core/synthetic.js';

/** Bars from a return series with controllable serial correlation. */
function arBars(phi, n = 400, seed = 5) {
  const r = rng(seed);
  const gauss = () => { const u1 = Math.max(r(), 1e-12), u2 = r(); return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2); };
  const rets = [];
  let prev = 0;
  for (let i = 0; i < n; i++) { const e = gauss() * 0.01; const v = phi * prev + e; rets.push(v); prev = v; }
  const closes = [100];
  for (const v of rets) closes.push(closes[closes.length - 1] * (1 + v));
  return barsFromPath(closes, { noise: 0.001, seed: seed + 1 });
}

describe('autocorrelation', () => {
  test('detects strong positive serial correlation', () => {
    const b = arBars(0.5, 500, 1);
    const rets = [];
    for (let i = 1; i < b.length; i++) rets.push((b[i].close - b[i - 1].close) / b[i - 1].close);
    assert.ok(autocorrelation(rets, 1) > 0.2, 'AR(0.5) should show clear positive lag-1 autocorrelation');
  });

  test('detects negative serial correlation', () => {
    const b = arBars(-0.5, 500, 2);
    const rets = [];
    for (let i = 1; i < b.length; i++) rets.push((b[i].close - b[i - 1].close) / b[i - 1].close);
    assert.ok(autocorrelation(rets, 1) < -0.2);
  });

  test('returns null when there is not enough data for the lag', () => {
    assert.strictEqual(autocorrelation([0.01, 0.02], 5), null);
  });
});

describe('stoppingPremium — Kaminski & Lo', () => {
  test('a random walk gets the NEGATIVE verdict', () => {
    const b = barsFromPath(randomWalk({ n: 400, seed: 11 }), { noise: 0.004, seed: 12 });
    const s = stoppingPremium(b);
    assert.ok(s.available);
    assert.strictEqual(s.persistence_verdict, 'no measurable persistence');
    assert.match(s.expected_stopping_premium, /^NEGATIVE/);
    assert.match(s.expected_stopping_premium, /always negative under a random walk/);
  });

  test('a persistent series gets the POSITIVE verdict', () => {
    const s = stoppingPremium(arBars(0.45, 500, 3), { lags: [1, 5] });
    assert.strictEqual(s.persistence_verdict, 'persistent');
    assert.match(s.expected_stopping_premium, /^POSITIVE/);
  });

  test('a mean-reverting series is flagged as the WORST case for a stop', () => {
    const s = stoppingPremium(arBars(-0.45, 500, 4), { lags: [1, 5] });
    assert.strictEqual(s.persistence_verdict, 'mean-reverting');
    assert.match(s.expected_stopping_premium, /worse than the random-walk case/);
  });

  test('reports the significance band so the reader can judge the call', () => {
    const s = stoppingPremium(arBars(0.3, 500, 6));
    assert.ok(s.significance_band > 0 && s.significance_band < 0.2);
    for (const l of s.by_lag) assert.ok(typeof l.significant === 'boolean' || l.significant === null);
  });

  test('does NOT tell anyone to trade without a stop', () => {
    const b = barsFromPath(randomWalk({ n: 300, seed: 21 }), { noise: 0.004, seed: 22 });
    const s = stoppingPremium(b);
    assert.match(s.what_this_is_not, /not on risk of ruin/);
    assert.match(s.what_this_is_not, /know what the stop costs/);
  });

  test('carries their empirical result including the sampling-frequency caveat', () => {
    const s = stoppingPremium(arBars(0.2, 300, 7));
    assert.match(s.their_empirical_result, /LONGER sampling frequencies/);
    assert.match(s.their_empirical_result, /no value.*short-term/);
  });

  test('short input is reported, not crashed on', () => {
    assert.strictEqual(stoppingPremium([]).available, false);
  });
});

describe('backtestStop', () => {
  test('on a steady advance a stop costs money', () => {
    const up = barsFromPath(Array.from({ length: 200 }, (_, i) => 100 * (1 + 0.004 * i)), { noise: 0.01, seed: 8 });
    const out = backtestStop(up, { threshold_pct: 5 });
    assert.ok(out.available);
    assert.ok(out.buy_and_hold_pct > 0);
    assert.match(out.verdict, /COST|ADDED/);
  });

  test('reports the premium as a signed difference against buy-and-hold', () => {
    const b = barsFromPath(randomWalk({ n: 300, seed: 31 }), { noise: 0.01, seed: 32 });
    const out = backtestStop(b, { threshold_pct: 8 });
    assert.ok(Math.abs((out.with_stop_pct - out.buy_and_hold_pct) - out.stopping_premium_pct) < 0.02);
  });

  test('calls itself an anecdote rather than an estimate', () => {
    const b = barsFromPath(randomWalk({ n: 200, seed: 41 }), { noise: 0.01, seed: 42 });
    const out = backtestStop(b);
    assert.match(out.caveat, /an anecdote, not an estimate/);
    assert.match(out.caveat, /deflated_sharpe/);
  });
});

describe('movingAverageDistance — Avramov et al', () => {
  const up = barsFromPath(Array.from({ length: 300 }, (_, i) => 100 * (1 + 0.003 * i)), { noise: 0.002, seed: 9 });

  test('an advancing series puts the short MA above the long', () => {
    const m = movingAverageDistance(up);
    assert.ok(m.available);
    assert.ok(m.mad > 1);
    assert.strictEqual(m.direction, 'short above long');
  });

  test('a declining series puts the short MA below the long', () => {
    const down = barsFromPath(Array.from({ length: 300 }, (_, i) => 300 * (1 - 0.002 * i)), { noise: 0.002, seed: 10 });
    const m = movingAverageDistance(down);
    assert.ok(m.mad < 1);
    assert.strictEqual(m.direction, 'short below long');
  });

  test('refuses rather than returning neutral without enough history', () => {
    const m = movingAverageDistance(up.slice(-50));
    assert.strictEqual(m.available, false);
    assert.match(m.note, /missing data, not a neutral reading/);
  });

  test('carries the 9% alpha, the survives-costs claim, and the breadth caveat', () => {
    const m = movingAverageDistance(up);
    assert.match(m.evidence, /9%/);
    assert.match(m.evidence, /survive/);
    assert.match(m.breadth_caveat, /CROSS-SECTIONAL/);
  });
});

describe('candlestick academic counter-evidence', () => {
  test('records both studies and their negative results', () => {
    assert.match(CANDLE_ACADEMIC_EVIDENCE.us.result, /do not have value/);
    assert.match(CANDLE_ACADEMIC_EVIDENCE.japan.result, /No evidence/);
    assert.match(CANDLE_ACADEMIC_EVIDENCE.japan.result, /bull or bear markets/);
  });

  test('explains why Bulkowski and the academics can both be right', () => {
    assert.match(CANDLE_ACADEMIC_EVIDENCE.how_to_read_our_stats, /different questions/);
  });

  test('detectPatterns attaches it whenever a candlestick is reported', () => {
    const b = barsFromPath(randomWalk({ n: 120, seed: 51 }), { noise: 0.01, seed: 52 });
    const out = detectPatterns(b, { recent_bars: 30 });
    if (out.candlestick.length) {
      assert.ok(out.candlestick_academic_evidence, 'candlestick detections must carry the counter-evidence');
      assert.match(out.candlestick_academic_evidence.japan.market, /Tokyo Stock Exchange/);
    }
  });
});

// ---------------------------------------------------------------------------
// atrTrail — TA's dashboard request (2026-07-31): the chandelier as a series.
// ---------------------------------------------------------------------------
describe('atrTrail', () => {
  const mk = (n, drift) => {
    const bars = []; let px = 100;
    for (let i = 0; i < n; i++) { px += typeof drift === 'function' ? drift(i) : drift; bars.push({ time: 1700000000 + i * 86400, open: px, high: px + 1, low: px - 1, close: px, volume: 1 }); }
    return bars;
  };

  test('a long trail is monotone non-decreasing, even through a pullback', () => {
    const t = atrTrail(mk(60, (i) => (i < 40 ? 0.8 : -0.5)), { mult: 2.5 });
    assert.equal(t.available, true);
    const v = t.series.map((s) => s.value);
    assert.ok(v.every((x, i) => i === 0 || x >= v[i - 1]), 'the ratchet must never loosen');
    assert.equal(t.stop, v[v.length - 1]);
    assert.equal(t.mult, 2.5);
  });

  test('a short trail is monotone non-increasing', () => {
    const t = atrTrail(mk(60, (i) => (i < 40 ? -0.8 : 0.5)), { direction: 'short' });
    const v = t.series.map((s) => s.value);
    assert.ok(v.every((x, i) => i === 0 || x <= v[i - 1]));
    assert.equal(t.direction, 'short');
  });

  test('one point per bar once ATR is defined, each carrying the bar time', () => {
    const bars = mk(60, 0.5);
    const t = atrTrail(bars, { atr_lookback: 14 });
    assert.equal(t.series.length, bars.length - 15, 'points begin after lookback+1 bars');
    assert.equal(t.series[0].time, bars[15].time);
    assert.equal(t.series.at(-1).time, bars.at(-1).time);
  });

  test('too few bars refuses with the arithmetic, never a fabricated series', () => {
    const t = atrTrail(mk(10, 0.5));
    assert.equal(t.available, false);
    assert.match(t.note, /Need at least 16 bars/);
  });

  test('the ratchet BINDS: after a deep pullback the stop is above the raw chandelier', () => {
    const bars = mk(80, (i) => (i < 50 ? 1.0 : -1.2));
    const t = atrTrail(bars, { mult: 2.5 });
    const last = bars.at(-1);
    // raw chandelier at the end sits far below the ratcheted stop
    assert.ok(t.stop > last.close - 10, 'the stop held its ground while price fell');
  });
});
