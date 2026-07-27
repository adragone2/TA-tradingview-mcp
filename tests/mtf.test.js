/**
 * Multi-timeframe, relative strength, and Nison context tests.
 *
 * The assertions that matter:
 *   - a PARTIAL higher-timeframe bar must be flagged. A half-finished weekly
 *     bar showing a reversal that has not happened is the commonest way
 *     multi-timeframe analysis misleads.
 *   - a setup opposing its context timeframe must be named COUNTERTREND.
 *   - leadership must not be read off the shortest window alone.
 *   - an unconfirmed hanging man must not read as confirmed — Nison requires
 *     confirmation for it and not for the hammer.
 *
 * Run: node --test tests/mtf.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { resampleBars, alignment, checkSpacing, TIMEFRAME_PLANS } from '../src/core/mtf.js';
import { relativeStrength, alignSeries } from '../src/core/relative.js';
import { nisonCheck, NISON_RULES, detectPatterns } from '../src/core/patterns.js';

const DAY = 86400;
const bar = (t, o, h, l, c, v = 1000) => ({ time: t, open: o, high: h, low: l, close: c, volume: v });
/** Daily bars starting on a Monday. */
const days = (n, fn) => Array.from({ length: n }, (_, i) => {
  const t = 1_704_412_800 + i * DAY;   // 2024-01-05, a Friday
  return fn ? fn(i, t) : bar(t, 100 + i, 101 + i, 99 + i, 100.5 + i);
});

describe('resampleBars', () => {
  it('aggregates daily bars into weeks with correct OHLC', () => {
    const bars = days(14);
    const r = resampleBars(bars, 'week');
    assert.ok(r.bars.length >= 2 && r.bars.length <= 4, `expected a few weeks, got ${r.bars.length}`);
    for (const w of r.bars) {
      assert.ok(w.high >= w.open && w.high >= w.close);
      assert.ok(w.low <= w.open && w.low <= w.close);
      assert.ok(w.source_bars >= 1);
    }
  });

  it('sums volume across the group', () => {
    const bars = days(10, (i, t) => bar(t, 100, 101, 99, 100, 500));
    const r = resampleBars(bars, 'week');
    const total = r.bars.reduce((s, b) => s + b.volume, 0);
    assert.equal(total, 5000);
  });

  it('groups by a fixed bar count for intraday', () => {
    const bars = days(20);
    const r = resampleBars(bars, 4);
    assert.equal(r.bars.length, 5);
    assert.match(r.grouped_by, /4 bars/);
  });

  it('FLAGS a partial newest bar for CALENDAR grouping', () => {
    // Ends mid-week, so the newest weekly bar is still forming.
    const bars = days(14);
    const r = resampleBars(bars, 'week');
    assert.equal(r.partial_last_bar, true);
    assert.match(r.partial_warning, /still forming/i);
    assert.match(r.partial_warning, /reversal that has not happened/i);
  });

  it('does NOT claim to detect a partial bar for bar-count grouping', () => {
    // Anchored at the newest bar, every group is full by construction. Claiming
    // otherwise would be inventing information.
    const r = resampleBars(days(22), 4);
    assert.equal(r.partial_last_bar, false);
    assert.match(r.partial_note, /cannot be determined from bars alone/i);
  });

  it('puts any remainder at the OLDEST edge for bar-count grouping', () => {
    const r = resampleBars(days(22), 4);
    assert.ok(r.bars[0].source_bars < r.bars[r.bars.length - 1].source_bars,
      'the short group must be the start of history, not a bar still forming');
  });

  it('handles an empty series', () => {
    assert.equal(resampleBars([], 'week').bars.length, 0);
  });
});

describe('checkSpacing', () => {
  it('accepts the conventional 4-6x steps for an equity session', () => {
    assert.equal(checkSpacing(['1W', '1D', '1H']).ok, true);
  });

  it('flags 1W/1D/4H for EQUITIES but accepts it for a 24-hour instrument', () => {
    // A 6.5-hour session makes a 4H bar only ~1.6x a daily — too close to be a
    // separate screen. The same plan is fine on crypto or FX.
    assert.equal(checkSpacing(['1W', '1D', '4H']).ok, false);
    assert.equal(checkSpacing(['1W', '1D', '4H'], { session_hours: 24 }).ok, true);
  });

  it('flags timeframes too close together', () => {
    const r = checkSpacing(['1H', '30m', '15m']);
    assert.equal(r.ok, false);
    assert.match(r.note, /outside the usual 4-6x/);
  });

  it('rejects an unknown timeframe rather than guessing', () => {
    assert.equal(checkSpacing(['1W', 'banana']).ok, false);
  });

  it('every built-in plan is sanely spaced for its own session length', () => {
    for (const [name, p] of Object.entries(TIMEFRAME_PLANS)) {
      const r = checkSpacing([p.context, p.structure, p.trigger], { session_hours: p.session_hours ?? 6.5 });
      assert.equal(r.ok, true, `plan ${name} (${[p.context, p.structure, p.trigger].join('/')}) spaced ${JSON.stringify(r.ratios)}`);
    }
  });
});

describe('alignment — Elder\'s permission rule', () => {
  const s = (label, trend, regime = 'trending') => ({ label, trend, regime });

  it('calls matching trends ALIGNED', () => {
    const a = alignment([s('1W', 'uptrend'), s('1D', 'uptrend'), s('4H', 'uptrend')]);
    assert.equal(a.state, 'aligned');
    assert.equal(a.permitted_direction, 'long');
  });

  it('names a setup against its context COUNTERTREND', () => {
    const a = alignment([s('1W', 'downtrend'), s('1D', 'uptrend')]);
    assert.equal(a.state, 'opposed');
    assert.match(a.verdict, /COUNTERTREND/);
    assert.equal(a.permitted_direction, 'short');
  });

  it('grants no permission when the context is a range', () => {
    const a = alignment([s('1W', 'range'), s('1D', 'uptrend')]);
    assert.equal(a.state, 'context_unclear');
    assert.match(a.permitted_direction, /neither/);
  });

  it('reads a consolidating structure inside a trend as a pullback, with the caveat', () => {
    const a = alignment([s('1W', 'uptrend'), s('1D', 'range')]);
    assert.equal(a.state, 'structure_consolidating');
    assert.match(a.verdict, /also what a top looks like/i);
  });

  it('names the choppy timeframes', () => {
    const a = alignment([s('1W', 'uptrend', 'choppy'), s('1D', 'uptrend', 'trending')]);
    assert.deepEqual(a.choppy_timeframes, ['1W']);
  });

  it('declines with fewer than two timeframes', () => {
    assert.equal(alignment([s('1D', 'uptrend')]).available, false);
  });
});

describe('relativeStrength', () => {
  const mk = (n, fn) => Array.from({ length: n }, (_, i) => {
    const t = 1_704_412_800 + i * DAY;
    const c = fn(i);
    return bar(t, c, c, c, c);
  });

  it('aligns on shared timestamps only, never interpolating', () => {
    const a = mk(50, (i) => 100 + i);
    const b = mk(50, (i) => 200 + i).filter((_, i) => i % 2 === 0);
    assert.equal(alignSeries(a, b).length, 25);
  });

  it('finds outperformance', () => {
    const r = relativeStrength(mk(200, (i) => 100 * 1.01 ** i), mk(200, (i) => 100 * 1.002 ** i));
    assert.equal(r.available, true);
    assert.equal(r.leadership, 'outperforming');
    assert.ok(r.performance.every((p) => p.excess_pct > 0));
  });

  it('finds underperformance', () => {
    const r = relativeStrength(mk(200, (i) => 100 * 1.001 ** i), mk(200, (i) => 100 * 1.01 ** i));
    assert.equal(r.leadership, 'lagging');
  });

  it('does NOT call a recent bounce inside long underperformance "outperforming"', () => {
    // Falls for 150 bars, rallies hard for 50. Short window is ahead, long is behind.
    const sym = mk(200, (i) => (i < 170 ? 100 - i * 0.5 : 15 + (i - 170) * 1.5));
    const bench = mk(200, (i) => 100 + i * 0.5);
    const r = relativeStrength(sym, bench);
    assert.equal(r.leadership, 'mixed', `expected mixed, got ${r.leadership}`);
    assert.match(r.leadership_note, /do not read the short window alone/i);
  });

  it('flags price at a high while RS is not', () => {
    // Price grinds to a new high; benchmark rises faster, so RS does not.
    const sym = mk(200, (i) => 100 + i * 0.2);
    const bench = mk(200, (i) => 100 + i * 0.9);
    const r = relativeStrength(sym, bench);
    assert.equal(r.at_price_high, true);
    assert.equal(r.at_rs_high, false);
    assert.match(r.high_warning, /rising with the market rather than leading it/i);
  });

  it('states that it is not the RSI', () => {
    const r = relativeStrength(mk(200, (i) => 100 + i), mk(200, (i) => 100 + i * 0.5));
    assert.match(r.not_rsi, /NOT the RSI/);
    assert.match(r.caveat, /outperform all the way down/i);
  });

  it('declines rather than comparing too few aligned bars', () => {
    const r = relativeStrength(mk(10, (i) => 100 + i), mk(10, (i) => 100 + i));
    assert.equal(r.available, false);
    assert.match(r.note, /never interpolated/);
  });
});

describe('nisonCheck — context and confirmation', () => {
  let t = 1_700_000_000;
  const b = (o, h, l, c) => ({ time: (t += DAY), open: o, high: h, low: l, close: c, volume: 1000 });
  const rally = () => { t = 1_700_000_000; return Array.from({ length: 10 }, (_, i) => b(100 + i * 3, 103 + i * 3, 99 + i * 3, 102 + i * 3)); };
  const decline = () => { t = 1_700_000_000; return Array.from({ length: 10 }, (_, i) => b(120 - i * 3, 121 - i * 3, 118 - i * 3, 119 - i * 3)); };

  it('requires no confirmation for a hammer, but does for a hanging man', () => {
    assert.equal(NISON_RULES.hammer.confirmation_required, false);
    assert.equal(NISON_RULES.hanging_man.confirmation_required, true);
  });

  it('accepts a hammer after a decline', () => {
    const bars = [...decline(), b(96, 97.2, 90, 97)];
    const p = detectPatterns(bars, { recent_bars: 3 }).candlestick.find((x) => x.pattern === 'hammer');
    assert.ok(p, 'expected a hammer');
    assert.equal(p.nison.context_ok, true);
    assert.equal(p.nison.confirmation_required, false);
  });

  it('marks a hanging man AWAITING confirmation when no next bar exists', () => {
    const bars = [...rally(), b(128, 129.2, 122, 129)];
    const p = detectPatterns(bars, { recent_bars: 3 }).candlestick.find((x) => x.pattern === 'hanging_man');
    assert.ok(p, 'expected a hanging man');
    assert.equal(p.nison.confirmation_status, 'awaiting_confirmation');
    assert.match(p.nison.confirmation_warning, /hypothesis, not a signal/i);
  });

  it('marks it NOT confirmed when the next bar closes higher', () => {
    const bars = [...rally(), b(128, 129.2, 122, 129), b(129, 133, 128, 132)];
    const p = detectPatterns(bars, { recent_bars: 4 }).candlestick.find((x) => x.pattern === 'hanging_man');
    assert.equal(p.nison.confirmation_status, 'not_confirmed');
    assert.match(p.nison.confirmation_warning, /no signal/i);
  });

  it('marks it confirmed when the next bar closes beneath it', () => {
    const bars = [...rally(), b(128, 129.2, 122, 129), b(128, 129, 120, 121)];
    const p = detectPatterns(bars, { recent_bars: 4 }).candlestick.find((x) => x.pattern === 'hanging_man');
    assert.equal(p.nison.confirmation_status, 'confirmed');
    assert.equal(p.nison.confirmation_warning, undefined);
  });

  it('warns when the required prior trend is absent', () => {
    const n = nisonCheck('hammer', [
      ...Array.from({ length: 8 }, () => b(100, 101, 99, 100)),
      b(96, 97, 90, 97),
    ], 8);
    assert.equal(n.context_ok, false);
    assert.match(n.context_warning, /the shape without the context|Not enough prior bars/);
  });

  it('returns null for a pattern Nison has no rule for', () => {
    assert.equal(nisonCheck('NR7', [], 0), null);
  });
});
