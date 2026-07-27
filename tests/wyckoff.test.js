/**
 * Wyckoff unit tests — no TradingView connection needed.
 *
 * The spring tests carry the most weight. The difference between a spring and
 * a breakdown is one thing — whether price CLOSED back inside the range — and
 * getting that wrong means buying straight into a decline. There is a test for
 * exactly that case.
 *
 * Run: node --test tests/wyckoff.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { effortVsResult, classifyPhase, findSpringsUpthrusts, causeAndEffect } from '../src/core/wyckoff.js';

const DAY = 86400;
let t = 1_700_000_000;
const bar = (o, h, l, c, v = 1000) => ({ time: (t += DAY), open: o, high: h, low: l, close: c, volume: v });
const reset = () => { t = 1_700_000_000; };

/** Bars oscillating between `lo` and `hi` — a range with real swing structure. */
function range(lo, hi, cycles = 6, vol = 1000) {
  const out = [];
  const mid = (lo + hi) / 2;
  for (let c = 0; c < cycles; c++) {
    out.push(bar(mid, hi, mid - 1, hi - 1, vol));
    out.push(bar(hi - 1, hi, mid, mid, vol));
    out.push(bar(mid, mid + 1, lo, lo + 1, vol));
    out.push(bar(lo + 1, mid, lo, mid, vol));
  }
  return out;
}

const trendDown = (n = 40, from = 200, step = 2, vol = 1000) =>
  Array.from({ length: n }, (_, i) => { const p = from - i * step; return bar(p, p + 1, p - step - 1, p - step, vol); });
const trendUp = (n = 40, from = 100, step = 2, vol = 1000) =>
  Array.from({ length: n }, (_, i) => { const p = from + i * step; return bar(p, p + step + 1, p - 1, p + step, vol); });

describe('effortVsResult — the 2x2', () => {
  it('price up on rising volume is bullish convergence', () => {
    reset();
    const bars = [...trendUp(30, 100, 1, 1000), ...trendUp(10, 130, 2, 3000)];
    const r = effortVsResult(bars, { window: 10, baseline: 30 });
    assert.equal(r.verdict, 'bullish');
    assert.equal(r.kind, 'convergence');
  });

  it('price up on FALLING volume is bearish divergence — a rally nobody is backing', () => {
    reset();
    const bars = [...trendUp(30, 100, 1, 3000), ...trendUp(10, 130, 2, 500)];
    const r = effortVsResult(bars, { window: 10, baseline: 30 });
    assert.equal(r.verdict, 'bearish');
    assert.equal(r.kind, 'divergence');
    assert.match(r.meaning, /fewer and fewer participants/i);
  });

  it('price down on falling volume is bullish divergence — selling drying up', () => {
    reset();
    const bars = [...trendDown(30, 200, 1, 3000), ...trendDown(10, 170, 2, 500)];
    const r = effortVsResult(bars, { window: 10, baseline: 30 });
    assert.equal(r.verdict, 'bullish');
    assert.equal(r.kind, 'divergence');
  });

  it('price down on rising volume is bearish convergence', () => {
    reset();
    const bars = [...trendDown(30, 200, 1, 1000), ...trendDown(10, 170, 2, 4000)];
    const r = effortVsResult(bars, { window: 10, baseline: 30 });
    assert.equal(r.verdict, 'bearish');
    assert.equal(r.kind, 'convergence');
  });

  it('says inconclusive when volume is unremarkable', () => {
    reset();
    const bars = trendUp(45, 100, 1, 1000);
    const r = effortVsResult(bars, { window: 10, baseline: 30 });
    assert.equal(r.kind, 'inconclusive');
  });

  it('declines without enough bars or volume', () => {
    reset();
    assert.equal(effortVsResult([bar(1, 1, 1, 1)], {}).available, false);
    reset();
    const noVol = trendUp(45, 100, 1, 0);
    assert.equal(effortVsResult(noVol, { window: 10, baseline: 30 }).available, false);
  });
});

describe('classifyPhase', () => {
  it('calls a range after a decline accumulation', () => {
    reset();
    const bars = [...trendDown(40, 200, 2), ...range(118, 130, 10)];
    const p = classifyPhase(bars, { range_window: 40, prior_window: 40 });
    assert.equal(p.phase, 'accumulation');
    assert.match(p.watch_for, /SPRING/i);
    assert.ok(p.evidence.prior_move_pct < 0);
  });

  it('calls a range after an advance distribution', () => {
    reset();
    const bars = [...trendUp(40, 100, 2), ...range(175, 187, 10)];
    const p = classifyPhase(bars, { range_window: 40, prior_window: 40 });
    assert.equal(p.phase, 'distribution');
    assert.match(p.watch_for, /UPTHRUST/i);
  });

  it('calls a clean advance markup', () => {
    reset();
    const bars = [...trendUp(40, 60, 1), ...trendUp(40, 100, 2)];
    assert.equal(classifyPhase(bars, { range_window: 40, prior_window: 40 }).phase, 'markup');
  });

  it('calls a clean decline markdown', () => {
    reset();
    const bars = [...trendDown(40, 300, 1), ...trendDown(40, 260, 2)];
    assert.equal(classifyPhase(bars, { range_window: 40, prior_window: 40 }).phase, 'markdown');
  });

  it('refuses to guess a phase from too few bars', () => {
    reset();
    assert.equal(classifyPhase([bar(1, 1, 1, 1)]).phase, 'unclear');
  });

  it('always returns the evidence behind the label', () => {
    reset();
    const bars = [...trendDown(40, 200, 2), ...range(118, 130, 10)];
    const p = classifyPhase(bars, { range_window: 40, prior_window: 40 });
    for (const k of ['recent_efficiency', 'prior_move_pct', 'range_high', 'range_low']) {
      assert.ok(k in p.evidence, `missing evidence: ${k}`);
    }
    assert.equal(p.confidence, 'interpretive');
  });
});

describe('findSpringsUpthrusts', () => {
  it('detects a spring: below support, closes back inside', () => {
    reset();
    const bars = [...range(100, 120, 12), bar(102, 104, 96, 106, 3000), bar(106, 112, 105, 110)];
    const r = findSpringsUpthrusts(bars, { range_window: 40, lookback: 2 });
    assert.ok(r.springs.length >= 1, 'expected a spring');
    const s = r.springs[0];
    assert.equal(s.direction, 'bullish');
    assert.ok(s.low < s.support, 'must have traded below support');
    assert.ok(Number.isFinite(s.stop_below));
  });

  it('does NOT call a breakdown a spring', () => {
    // Trades below support and stays below. This is the case that matters:
    // treating it as a spring means buying straight into a decline.
    reset();
    const bars = [...range(100, 120, 12), bar(102, 103, 90, 91, 3000), bar(91, 92, 85, 86)];
    const r = findSpringsUpthrusts(bars, { range_window: 40, lookback: 2 });
    assert.equal(r.springs.length, 0, 'a close still below support is a breakdown, not a spring');
    assert.ok(r.unconfirmed && r.unconfirmed.length >= 1, 'it must be reported as unconfirmed');
    assert.match(r.unconfirmed[0].why_not, /did not close back inside/i);
  });

  it('detects an upthrust: above resistance, closes back inside', () => {
    reset();
    const bars = [...range(100, 120, 12), bar(118, 126, 117, 114, 3000), bar(114, 116, 110, 112)];
    const r = findSpringsUpthrusts(bars, { range_window: 40, lookback: 2 });
    assert.ok(r.upthrusts.length >= 1, 'expected an upthrust');
    assert.equal(r.upthrusts[0].direction, 'bearish');
  });

  it('does NOT call a breakout an upthrust', () => {
    reset();
    const bars = [...range(100, 120, 12), bar(118, 130, 117, 129, 3000), bar(129, 135, 128, 134)];
    const r = findSpringsUpthrusts(bars, { range_window: 40, lookback: 2 });
    assert.equal(r.upthrusts.length, 0);
  });

  it('reports the range it tested against', () => {
    reset();
    const bars = [...range(100, 120, 12), bar(102, 104, 96, 106, 3000), bar(106, 112, 105, 110)];
    const r = findSpringsUpthrusts(bars, { range_window: 40, lookback: 2 });
    assert.ok(r.range.resistance > r.range.support);
    assert.match(r.method, /median swing/i);
  });

  it('finds nothing when there is no range to test', () => {
    reset();
    const r = findSpringsUpthrusts(trendUp(50, 100, 3), { range_window: 40, lookback: 2 });
    assert.equal(r.springs.length + r.upthrusts.length, 0);
  });

  it('attaches the reminder only when something was found', () => {
    reset();
    const withSpring = findSpringsUpthrusts(
      [...range(100, 120, 12), bar(102, 104, 96, 106, 3000), bar(106, 112, 105, 110)],
      { range_window: 40, lookback: 2 },
    );
    assert.ok(withSpring.reminder, 'a detection must carry the confirm-independently reminder');
  });
});

describe('causeAndEffect', () => {
  it('projects the range width from both boundaries', () => {
    reset();
    const bars = range(100, 120, 12);
    const c = causeAndEffect(bars, { range_window: 40, lookback: 2 });
    assert.equal(c.available, true);
    const width = c.range.resistance - c.range.support;
    assert.ok(Math.abs(c.projections.upside - (c.range.resistance + width)) < 0.01);
    assert.ok(Math.abs(c.projections.downside - (c.range.support - width)) < 0.01);
  });

  it('states plainly that the projection has no measured support', () => {
    reset();
    const c = causeAndEffect(range(100, 120, 12), { range_window: 40, lookback: 2 });
    assert.match(c.caveat, /NO measured success rate/i);
  });

  it('declines when there is no range', () => {
    reset();
    assert.equal(causeAndEffect([bar(1, 1, 1, 1)], {}).available, false);
  });
});
