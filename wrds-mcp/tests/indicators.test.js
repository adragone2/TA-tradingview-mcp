/**
 * Indicator and signal tests — no WRDS connection needed.
 *
 * These matter more than they look: a look-ahead bug or an off-by-one in
 * forwardReturn would invent edge that isn't there, and the backtest would
 * report it confidently.
 *
 * Run: node --test tests/indicators.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  sma, ema, rsi, forwardReturn, summarize, evaluateCondition, evaluateSignal,
} from '../src/indicators.js';

const approx = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) < tol, `${a} !== ${b}`);

describe('sma', () => {
  it('is null during warm-up, then correct', () => {
    const r = sma([1, 2, 3, 4, 5], 3);
    assert.deepEqual(r.slice(0, 2), [null, null]);
    approx(r[2], 2); approx(r[3], 3); approx(r[4], 4);
  });

  it('returns all null when shorter than the period', () => {
    assert.deepEqual(sma([1, 2], 5), [null, null]);
  });

  it('rejects a non-positive period', () => {
    assert.throws(() => sma([1, 2, 3], 0), /positive integer/);
  });
});

describe('ema', () => {
  it('seeds from the SMA of the first period', () => {
    const r = ema([1, 2, 3, 4, 5], 3);
    assert.equal(r[1], null);
    approx(r[2], 2);            // seed = mean(1,2,3)
    approx(r[3], 4 * 0.5 + 2 * 0.5);   // k = 2/(3+1) = 0.5
    approx(r[4], 5 * 0.5 + 3 * 0.5);
  });

  it('tracks a constant series exactly', () => {
    const r = ema(new Array(20).fill(7), 5);
    approx(r[19], 7);
  });
});

describe('rsi', () => {
  it('is 100 when the series only rises', () => {
    const r = rsi([...Array(30).keys()].map((i) => 100 + i), 14);
    approx(r[29], 100);
  });

  it('is 0 when the series only falls', () => {
    const r = rsi([...Array(30).keys()].map((i) => 200 - i), 14);
    approx(r[29], 0);
  });

  it('sits near 50 for a symmetric zigzag', () => {
    const v = [];
    for (let i = 0; i < 60; i++) v.push(100 + (i % 2 ? 1 : 0));
    const r = rsi(v, 14);
    assert.ok(r[59] > 40 && r[59] < 60, `expected ~50, got ${r[59]}`);
  });

  it('is null through the warm-up', () => {
    const r = rsi([1, 2, 3, 4, 5], 14);
    assert.ok(r.every((x) => x === null));
  });
});

describe('forwardReturn', () => {
  it('measures from the NEXT bar, not the signal bar', () => {
    // A signal at index 0 must not capture the 100 -> 110 move on its own bar.
    const closes = [100, 110, 121];
    const r = forwardReturn(closes, 1);
    approx(r[0], 121 / 110 - 1); // enters at 110, exits at 121
  });

  it('is null when the window runs past the end', () => {
    const r = forwardReturn([1, 2, 3], 5);
    assert.ok(r.every((x) => x === null));
  });

  it('computes a multi-bar horizon correctly', () => {
    const closes = [10, 10, 11, 12, 13];
    const r = forwardReturn(closes, 2);
    approx(r[0], 12 / 10 - 1);  // entry at index 1, exit at index 3
  });

  it('never reads the signal bar itself — a spike at i is invisible to out[i]', () => {
    const flat = [100, 100, 100, 100, 100];
    const spiked = [999, 100, 100, 100, 100];
    assert.deepEqual(forwardReturn(flat, 2), forwardReturn(spiked, 2));
  });
});

describe('summarize', () => {
  it('returns null for an empty set rather than NaN', () => {
    assert.equal(summarize([]), null);
    assert.equal(summarize([null, null]), null);
  });

  it('computes mean, median and hit rate', () => {
    const s = summarize([0.01, -0.01, 0.02, 0.04]);
    assert.equal(s.n, 4);
    approx(s.mean_pct, 1.5, 1e-9);
    assert.equal(s.hit_rate_pct, 75);
  });

  it('ignores nulls in the input', () => {
    assert.equal(summarize([0.01, null, 0.03]).n, 2);
  });
});

describe('conditions', () => {
  const rising = [...Array(60).keys()].map((i) => 100 + i);

  it('price_above is true when price leads its average', () => {
    const f = evaluateCondition(rising, { indicator: 'sma', period: 20, op: 'price_above' });
    assert.equal(f[59], true);
    assert.equal(f[0], false, 'warm-up bars must not count as signals');
  });

  it('price_below is false on a rising series', () => {
    const f = evaluateCondition(rising, { indicator: 'sma', period: 20, op: 'price_below' });
    assert.equal(f[59], false);
  });

  it('compares an indicator against a constant', () => {
    const f = evaluateCondition(rising, { indicator: 'rsi', period: 14, op: 'above', value: 60 });
    assert.equal(f[59], true);
  });

  it('compares two indicators', () => {
    const f = evaluateCondition(rising, {
      indicator: 'sma', period: 10, op: 'above', compare: { indicator: 'sma', period: 50 },
    });
    assert.equal(f[59], true);
  });

  it('rejects an unknown indicator or op', () => {
    assert.throws(() => evaluateCondition(rising, { indicator: 'wat', op: 'above', value: 1 }), /Unknown indicator/);
    assert.throws(() => evaluateCondition(rising, { indicator: 'sma', period: 5, op: 'sideways' }), /Unknown op/);
  });

  it('requires value or compare for a relational op', () => {
    assert.throws(
      () => evaluateCondition(rising, { indicator: 'rsi', period: 14, op: 'above' }),
      /needs either value or compare/,
    );
  });
});

describe('evaluateSignal', () => {
  const rising = [...Array(60).keys()].map((i) => 100 + i);

  it('ANDs its conditions', () => {
    const both = evaluateSignal(rising, [
      { indicator: 'sma', period: 20, op: 'price_above' },
      { indicator: 'rsi', period: 14, op: 'below', value: 60 },
    ]);
    // Price leads the average but RSI is pinned high, so the pair never fires.
    assert.equal(both[59], false);
  });

  it('fires when every condition holds', () => {
    const f = evaluateSignal(rising, [
      { indicator: 'sma', period: 20, op: 'price_above' },
      { indicator: 'rsi', period: 14, op: 'above', value: 60 },
    ]);
    assert.equal(f[59], true);
  });

  it('requires at least one condition', () => {
    assert.throws(() => evaluateSignal(rising, []), /At least one condition/);
  });
});
