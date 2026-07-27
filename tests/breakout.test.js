/**
 * Breakout quality unit tests — no TradingView connection needed.
 *
 * The point of this module is that "strong candle", "increased volume" and
 * "obvious level" become numbers. So the tests are mostly about the boundary
 * between a break that scores well and one that does not — including the case
 * that matters most, the break that is immediately reclaimed.
 *
 * Run: node --test tests/breakout.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { scoreBreakout, approachPressure } from '../src/core/breakout.js';

const DAY = 86400;
let t = 1_700_000_000;
const bar = (o, h, l, c, v = 1000) => ({ time: (t += DAY), open: o, high: h, low: l, close: c, volume: v });
const reset = () => { t = 1_700_000_000; };

/** Quiet bars oscillating just under `level`, with small bodies and flat volume. */
function approach(level, n = 25, { vol = 1000 } = {}) {
  reset();
  const out = [];
  for (let i = 0; i < n; i++) {
    const near = i % 5 === 0;                       // periodically test the level
    const c = near ? level - 0.2 : level - 4 + (i % 3);
    out.push(bar(c - 0.5, near ? level - 0.05 : c + 0.5, c - 1, c, vol));
  }
  return out;
}

describe('scoreBreakout', () => {
  it('scores a textbook breakout as strong', () => {
    const bars = [
      ...approach(100),
      bar(99.5, 104, 99.4, 103.5, 4000),   // big body, closes well beyond, heavy volume
      bar(103.5, 106, 103, 105.5, 3000),   // follow-through
    ];
    const r = scoreBreakout(bars, { level: 100, direction: 'up' });
    assert.equal(r.broken, true);
    assert.equal(r.verdict, 'strong');
    assert.ok(r.checks.find((c) => c.name === 'momentum').pass);
    assert.ok(r.checks.find((c) => c.name === 'volume').pass);
    assert.ok(r.checks.find((c) => c.name === 'follow_through').pass);
  });

  it('calls a break that is immediately reclaimed FAILED, whatever else it scored', () => {
    // This is the case that matters: everything looks good, then the next bar
    // closes back inside. A high score must not survive that.
    const bars = [
      ...approach(100),
      bar(99.5, 104, 99.4, 103.5, 4000),
      bar(103.5, 104, 97, 98, 3000),       // closed back below the level
    ];
    const r = scoreBreakout(bars, { level: 100, direction: 'up' });
    assert.equal(r.verdict, 'failed');
    assert.match(r.failed_reason, /reclaimed/i);
  });

  it('marks a marginal close as failing the close check', () => {
    const bars = [
      ...approach(100),
      bar(99.5, 100.3, 99.4, 100.05, 1100),   // barely beyond
      bar(100.05, 100.4, 99.9, 100.1, 1000),
    ];
    const r = scoreBreakout(bars, { level: 100, direction: 'up' });
    assert.equal(r.checks.find((c) => c.name === 'close_beyond_level').pass, false);
    assert.notEqual(r.verdict, 'strong');
  });

  it('flags a long rejection wick even when the close held', () => {
    const bars = [
      ...approach(100),
      bar(99.8, 108, 99.7, 100.6, 4000),   // huge wick beyond, small body
      bar(100.6, 101, 100, 100.7, 1000),
    ];
    const r = scoreBreakout(bars, { level: 100, direction: 'up' });
    assert.ok(r.rejection_wick, 'expected the rejection wick to be reported');
    assert.match(r.rejection_wick, /pushed back/i);
  });

  it('scores a downside break symmetrically', () => {
    const bars = [
      ...approach(100).map((b) => ({ ...b, open: 200 - b.open, high: 200 - b.low, low: 200 - b.high, close: 200 - b.close })),
      bar(100.5, 100.6, 96, 96.5, 4000),
      bar(96.5, 97, 94, 94.5, 3000),
    ];
    const r = scoreBreakout(bars, { level: 100, direction: 'down' });
    assert.equal(r.broken, true);
    assert.equal(r.direction, 'down');
    assert.notEqual(r.verdict, 'failed');
  });

  it('reports no break rather than inventing one', () => {
    const r = scoreBreakout(approach(100), { level: 100, direction: 'up' });
    assert.equal(r.broken, false);
    assert.match(r.note, /No bar has closed/i);
  });

  it('does not treat a level price was already beyond as a fresh break', () => {
    reset();
    const bars = Array.from({ length: 30 }, (_, i) => bar(110 + i, 111 + i, 109 + i, 110 + i));
    const r = scoreBreakout(bars, { level: 100, direction: 'up' });
    assert.equal(r.broken, false);
  });

  it('leaves follow-through unscored when the break is the last bar', () => {
    const bars = [...approach(100), bar(99.5, 104, 99.4, 103.5, 4000)];
    const r = scoreBreakout(bars, { level: 100, direction: 'up' });
    assert.equal(r.checks.find((c) => c.name === 'follow_through').pass, null);
    assert.equal(r.unscored, 1);
  });

  it('validates its inputs', () => {
    assert.throws(() => scoreBreakout(approach(100), { level: 'x', direction: 'up' }), /level must be a number/);
    assert.throws(() => scoreBreakout(approach(100), { level: 100, direction: 'sideways' }), /direction must be/);
    assert.throws(() => scoreBreakout([bar(1, 2, 0, 1)], { level: 1, direction: 'up' }), /Need at least/);
  });
});

describe('approachPressure', () => {
  it('detects lower highs into support as pressure building', () => {
    reset();
    // Bounces off 100 that each peak lower: 112, then 108, then 104.
    // Each peak is a single distinct bar, or ties produce duplicate pivots.
    const bars = [];
    for (const p of [112, 108, 104]) {
      bars.push(bar(100.5, 101, 100.1, 100.8));
      bars.push(bar(100.8, p - 4, 100.7, p - 5));
      bars.push(bar(p - 5, p, 100.9, p - 1));      // the peak
      bars.push(bar(p - 1, p - 2, 100.4, 100.9));
      bars.push(bar(100.9, 101, 100.2, 100.6));
    }
    const r = approachPressure(bars, { level: 100, side: 'support', lookback: 40, swing_lookback: 2 });
    assert.equal(r.pressure, 'building');
    assert.match(r.interpretation, /descending triangle/i);
  });

  it('detects higher lows into resistance as pressure building', () => {
    reset();
    const bars = [];
    for (const p of [88, 92, 96]) {
      bars.push(bar(99.5, 99.9, 99.2, 99.4));
      bars.push(bar(99.4, 99.3, p + 4, p + 5));
      bars.push(bar(p + 5, 99.1, p, p + 1));       // the trough
      bars.push(bar(p + 1, 99.6, p + 2, 99.1));
      bars.push(bar(99.1, 99.8, 99.0, 99.4));
    }
    const r = approachPressure(bars, { level: 100, side: 'resistance', lookback: 40, swing_lookback: 2 });
    assert.equal(r.pressure, 'building');
    assert.match(r.interpretation, /ascending triangle/i);
  });

  it('reports no pressure when the pivots are not converging', () => {
    reset();
    const bars = [];
    for (const p of [104, 112, 106]) {
      bars.push(bar(100.5, 101, 100.1, 100.8));
      bars.push(bar(100.8, p - 4, 100.7, p - 5));
      bars.push(bar(p - 5, p, 100.9, p - 1));
      bars.push(bar(p - 1, p - 2, 100.4, 100.9));
      bars.push(bar(100.9, 101, 100.2, 100.6));
    }
    const r = approachPressure(bars, { level: 100, side: 'support', lookback: 40, swing_lookback: 2 });
    assert.equal(r.pressure, 'not building');
  });

  it('says unknown rather than guessing from too little data', () => {
    reset();
    const r = approachPressure([bar(1, 2, 0, 1), bar(1, 2, 0, 1)], { level: 1, side: 'support' });
    assert.equal(r.pressure, 'unknown');
  });

  it('validates its inputs', () => {
    assert.throws(() => approachPressure([], { level: 1, side: 'sideways' }), /side must be/);
    assert.throws(() => approachPressure([], { level: null, side: 'support' }), /level must be a number/);
  });
});
