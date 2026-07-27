/**
 * Strategy-criteria unit tests — no TradingView connection needed.
 *
 * The property that matters most here is that an unresolvable criterion is
 * UNKNOWN and never a fail. A scanner that reports "could not check" as "did
 * not qualify" stops finding anything and looks like it is working correctly
 * while doing so.
 *
 * Run: node --test tests/strategy.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  sma, ema, rsi, atr, groupSessions, resolveOperand,
  validateStrategy, evaluateCriteria, buildContext,
  etTimeHHMM, sessionVwap, openingRange, relativeVolume,
} from '../src/core/strategy.js';

const bar = (t, o, h, l, c, v = 100) => ({ time: t, open: o, high: h, low: l, close: c, volume: v });
const DAY = 86400;
/** Bars at 15:00 UTC so each one sits inside its own UTC date. */
const seq = (closes, startDay = 1_700_000_000) =>
  closes.map((c, i) => bar(startDay + i * DAY + 54_000, c, c + 1, c - 1, c));

describe('indicators', () => {
  it('sma averages the last N values', () => {
    assert.equal(sma([1, 2, 3, 4, 5], 5), 3);
    assert.equal(sma([10, 20, 30], 2), 25);
  });

  it('sma returns null rather than a partial average', () => {
    assert.equal(sma([1, 2], 5), null);
    assert.equal(sma([], 3), null);
  });

  it('ema on a flat series equals the level', () => {
    // Float accumulation lands a few ulps off 7 — compare with a tolerance
    // rather than asserting exact equality on iterated arithmetic.
    assert.ok(Math.abs(ema(Array(50).fill(7), 10) - 7) < 1e-9);
  });

  it('ema tracks a rising series above its seed and below the last value', () => {
    const vals = Array.from({ length: 60 }, (_, i) => i + 1);
    const e = ema(vals, 10);
    assert.ok(e > 40 && e < 60, `ema out of expected band: ${e}`);
  });

  it('rsi is 100 when every move is up, and needs length+1 values', () => {
    assert.equal(rsi(Array.from({ length: 30 }, (_, i) => i + 1), 14), 100);
    assert.equal(rsi([1, 2, 3], 14), null);
  });

  it('rsi sits near 50 on an alternating series', () => {
    const vals = Array.from({ length: 80 }, (_, i) => 100 + (i % 2 ? 1 : -1));
    const r = rsi(vals, 14);
    assert.ok(r > 35 && r < 65, `expected mid-range RSI, got ${r}`);
  });

  it('atr on a constant-range series equals that range', () => {
    const bars = Array.from({ length: 40 }, (_, i) => bar(i * DAY, 100, 102, 98, 100));
    assert.equal(Math.round(atr(bars, 14)), 4);
  });

  it('atr returns null without enough bars', () => {
    assert.equal(atr([bar(1, 1, 2, 0, 1)], 14), null);
  });
});

describe('groupSessions', () => {
  it('groups bars by UTC date with correct session high and low', () => {
    const bars = [
      bar(1_700_000_000 + 50_000, 10, 12, 9, 11),
      bar(1_700_000_000 + 54_000, 11, 15, 10, 14),
      bar(1_700_000_000 + DAY + 50_000, 14, 16, 13, 15),
    ];
    const s = groupSessions(bars);
    assert.equal(s.length, 2);
    assert.equal(s[0].high, 15);
    assert.equal(s[0].low, 9);
    assert.equal(s[0].open, 10);
    assert.equal(s[0].close, 14);
    assert.equal(s[0].volume, 200);
  });

  it('returns sessions in chronological order', () => {
    const s = groupSessions(seq([1, 2, 3]));
    assert.deepEqual(s.map((x) => x.date), [...s.map((x) => x.date)].sort());
  });
});

describe('resolveOperand', () => {
  const ctx = buildContext(seq([10, 11, 12, 13, 14]));

  it('resolves a numeric literal, as number or string', () => {
    assert.deepEqual(resolveOperand(42, ctx), { value: 42, ok: true });
    assert.equal(resolveOperand('42.5', ctx).value, 42.5);
  });

  it('resolves named operands', () => {
    assert.equal(resolveOperand('price', ctx).value, 14);
    assert.equal(resolveOperand('prev_day_close', ctx).value, 13);
  });

  it('is case-insensitive on names', () => {
    assert.equal(resolveOperand('PRICE', ctx).value, 14);
  });

  it('resolves indicator functions', () => {
    assert.equal(resolveOperand('sma(5)', ctx).value, 12);
    assert.equal(resolveOperand('SMA(5)', ctx).value, 12);
  });

  it('fails with a reason when there are not enough bars', () => {
    const r = resolveOperand('sma(200)', ctx);
    assert.equal(r.ok, false);
    assert.match(r.reason, /not enough bars/i);
  });

  it('fails with a reason on an unknown operand, and lists what is valid', () => {
    const r = resolveOperand('moon_phase', ctx);
    assert.equal(r.ok, false);
    assert.match(r.reason, /unknown operand/i);
    assert.match(r.reason, /price/);
  });

  it('reports an operand that exists but has no value', () => {
    const single = buildContext(seq([10]));   // no previous session
    const r = resolveOperand('prev_day_close', single);
    assert.equal(r.ok, false);
    assert.match(r.reason, /not available/i);
  });
});

describe('validateStrategy', () => {
  const ok = { criteria: [{ left: 'price', op: '>', right: 100 }] };

  it('accepts a well-formed strategy', () => {
    assert.equal(validateStrategy(ok).valid, true);
  });

  it('rejects an empty or missing criteria list', () => {
    assert.equal(validateStrategy({ criteria: [] }).valid, false);
    assert.equal(validateStrategy({}).valid, false);
    assert.equal(validateStrategy(null).valid, false);
  });

  it('rejects an unknown operator and names the valid ones', () => {
    const r = validateStrategy({ criteria: [{ left: 'price', op: '=>', right: 1 }] });
    assert.equal(r.valid, false);
    assert.match(r.errors[0], /op must be one of/);
  });

  it('rejects a missing operand', () => {
    assert.equal(validateStrategy({ criteria: [{ op: '>', right: 1 }] }).valid, false);
  });

  it('rejects a bad direction', () => {
    assert.equal(validateStrategy({ ...ok, direction: 'sideways' }).valid, false);
  });
});

describe('evaluateCriteria', () => {
  const ctx = buildContext(seq([10, 11, 12, 13, 14]));

  it('passes when every criterion holds, and shows the actual values', () => {
    const r = evaluateCriteria({ criteria: [
      { id: 'above_prev_close', left: 'price', op: '>', right: 'prev_day_close' },
      { id: 'above_ten', left: 'price', op: '>', right: 10 },
    ] }, ctx);
    assert.equal(r.verdict, 'pass');
    assert.equal(r.passed, 2);
    assert.equal(r.criteria[0].left_value, 14);
    assert.equal(r.criteria[0].right_value, 13);
  });

  it('fails when one criterion fails, and names it', () => {
    const r = evaluateCriteria({ criteria: [
      { id: 'a', left: 'price', op: '>', right: 10 },
      { id: 'b', left: 'price', op: '>', right: 1000 },
    ] }, ctx);
    assert.equal(r.verdict, 'fail');
    assert.equal(r.failed, 1);
    assert.equal(r.criteria.find((c) => c.id === 'b').status, 'fail');
  });

  it('returns UNKNOWN — never fail — when a criterion cannot be evaluated', () => {
    // The property that stops a scanner silently finding nothing.
    const r = evaluateCriteria({ criteria: [
      { id: 'ok', left: 'price', op: '>', right: 1 },
      { id: 'unresolvable', left: 'sma(200)', op: '<', right: 'price' },
    ] }, ctx);
    assert.equal(r.verdict, 'unknown');
    assert.equal(r.unknown, 1);
    assert.equal(r.criteria.find((c) => c.id === 'unresolvable').status, 'unknown');
    assert.match(r.unknown_note, /not the same as failed/i);
  });

  it('an unknown criterion outranks passes, so a partial check is never a pass', () => {
    const r = evaluateCriteria({ criteria: [
      { left: 'price', op: '>', right: 1 },
      { left: 'sma(500)', op: '>', right: 1 },
    ] }, ctx);
    assert.equal(r.verdict, 'unknown');
    assert.notEqual(r.verdict, 'pass');
  });

  it('supports every comparison operator', () => {
    const c = (op, right) => evaluateCriteria({ criteria: [{ left: 'price', op, right }] }, ctx).verdict;
    assert.equal(c('>', 13), 'pass');
    assert.equal(c('>=', 14), 'pass');
    assert.equal(c('<', 15), 'pass');
    assert.equal(c('<=', 14), 'pass');
    assert.equal(c('==', 14), 'pass');
    assert.equal(c('!=', 14), 'fail');
  });

  it('falls back to a readable id when none is given', () => {
    const r = evaluateCriteria({ criteria: [{ left: 'price', op: '>', right: 10 }] }, ctx);
    assert.equal(r.criteria[0].id, 'price > 10');
  });

  it('throws on an invalid strategy rather than evaluating nonsense', () => {
    assert.throws(() => evaluateCriteria({ criteria: [] }, ctx), /Invalid strategy/);
  });
});

describe('buildContext', () => {
  it('separates today from the previous session', () => {
    const ctx = buildContext(seq([10, 11, 12]));
    assert.equal(ctx.values.price, 12);
    assert.equal(ctx.values.prev_day_close, 11);
    assert.equal(ctx.values.high_of_day, 13);
    assert.equal(ctx.sessions, 3);
  });

  it('leaves previous-session values null when there is only one session', () => {
    const ctx = buildContext([bar(1_700_000_000, 10, 11, 9, 10)]);
    assert.equal(ctx.values.prev_day_close, null);
    assert.equal(ctx.values.price, 10);
  });

  it('aggregates intraday bars into one session', () => {
    const base = 1_700_000_000;
    const ctx = buildContext([
      bar(base + 50_000, 10, 12, 9, 11, 50),
      bar(base + 51_000, 11, 15, 10, 14, 70),
    ]);
    assert.equal(ctx.sessions, 1);
    assert.equal(ctx.values.high_of_day, 15);
    assert.equal(ctx.values.low_of_day, 9);
    assert.equal(ctx.values.session_volume, 120);
  });
});

describe('arithmetic operands', () => {
  const ctx = buildContext(seq([10, 11, 12, 13, 14]));

  it('multiplies an indicator, so "within 2% of the 8 EMA" is expressible', () => {
    const base = resolveOperand('sma(5)', ctx).value;   // 12
    assert.equal(resolveOperand('sma(5) * 0.98', ctx).value, base * 0.98);
  });

  it('supports all four operators', () => {
    assert.equal(resolveOperand('price + 1', ctx).value, 15);
    assert.equal(resolveOperand('price - 4', ctx).value, 10);
    assert.equal(resolveOperand('price * 2', ctx).value, 28);
    assert.equal(resolveOperand('price / 2', ctx).value, 7);
  });

  it('does not mistake sma(200) for arithmetic', () => {
    // The digits inside the parens must not be read as a numeric tail.
    const r = resolveOperand('sma(5)', ctx);
    assert.equal(r.ok, true);
    assert.equal(r.value, 12);
  });

  it('propagates the reason when the base operand cannot be resolved', () => {
    const r = resolveOperand('sma(200) * 0.98', ctx);
    assert.equal(r.ok, false);
    assert.match(r.reason, /not enough bars/i);
  });

  it('refuses division by zero', () => {
    assert.equal(resolveOperand('price / 0', ctx).ok, false);
  });

  it('still parses a bare negative number as a literal', () => {
    assert.equal(resolveOperand('-5', ctx).value, -5);
  });
});

describe('pct_change_today', () => {
  it('measures the last close against the previous session close', () => {
    const ctx = buildContext(seq([100, 103]));
    assert.ok(Math.abs(ctx.values.pct_change_today - 3) < 1e-9);
  });

  it('is null with no previous session, so a criterion using it is UNKNOWN', () => {
    const ctx = buildContext(seq([100]));
    assert.equal(ctx.values.pct_change_today, null);
    const r = evaluateCriteria({ criteria: [{ left: 'pct_change_today', op: '>', right: 3 }] }, ctx);
    assert.equal(r.verdict, 'unknown');
  });
});

/* --------------------------- intraday values --------------------------- */

const MIN = 60;
/** One session of intraday bars starting at a given unix time. */
const intradaySession = (startUtc, n, { price = 100, vol = 1000, stepMin = 5 } = {}) =>
  Array.from({ length: n }, (_, i) => ({
    time: startUtc + i * stepMin * MIN,
    open: price + i, high: price + i + 1, low: price + i - 1, close: price + i,
    volume: vol,
  }));

describe('etTimeHHMM — DST is not optional', () => {
  it('converts a winter session open to 09:30 ET', () => {
    // 2026-02-02 14:30 UTC is 09:30 EST.
    assert.equal(etTimeHHMM(Date.UTC(2026, 1, 2, 14, 30) / 1000), 930);
  });

  it('converts a summer session open to 09:30 ET, an hour offset later', () => {
    // 2026-07-01 13:30 UTC is 09:30 EDT — a DIFFERENT UTC time, same ET time.
    // A hardcoded offset gets exactly one of these two right.
    assert.equal(etTimeHHMM(Date.UTC(2026, 6, 1, 13, 30) / 1000), 930);
  });

  it('is monotonic through the day, so >= and <= order correctly', () => {
    const t = (h, m) => etTimeHHMM(Date.UTC(2026, 6, 1, h + 4, m) / 1000);
    assert.ok(t(9, 30) < t(10, 0));
    assert.ok(t(10, 0) < t(15, 30));
  });

  it('returns null on nonsense rather than a wrong time', () => {
    assert.equal(etTimeHHMM(NaN), null);
    assert.equal(etTimeHHMM(null), null);
  });
});

describe('sessionVwap', () => {
  it('equals the typical price when every bar is identical', () => {
    const bars = Array.from({ length: 6 }, (_, i) => ({ time: i * 300, open: 10, high: 12, low: 8, close: 10, volume: 100 }));
    assert.ok(Math.abs(sessionVwap(bars) - 10) < 1e-9);   // (12+8+10)/3 = 10
  });

  it('weights by volume, not by bar count', () => {
    const bars = [
      { time: 0, open: 10, high: 10, low: 10, close: 10, volume: 1 },
      { time: 300, open: 20, high: 20, low: 20, close: 20, volume: 99 },
    ];
    const v = sessionVwap(bars);
    assert.ok(v > 19, `volume-weighted VWAP should sit near 20, got ${v}`);
  });

  it('returns null for a single bar — a daily bar has no intraday VWAP', () => {
    assert.equal(sessionVwap([{ time: 0, open: 10, high: 12, low: 8, close: 10, volume: 100 }]), null);
  });

  it('returns null when there is no volume to weight by', () => {
    const bars = Array.from({ length: 4 }, (_, i) => ({ time: i * 300, open: 10, high: 12, low: 8, close: 10, volume: 0 }));
    assert.equal(sessionVwap(bars), null);
  });
});

describe('openingRange', () => {
  const start = Date.UTC(2026, 6, 1, 13, 30) / 1000;

  it('takes the high and low of the first N minutes only', () => {
    const bars = [
      { time: start, open: 100, high: 105, low: 99, close: 104, volume: 10 },
      { time: start + 60, open: 104, high: 108, low: 103, close: 107, volume: 10 },
      { time: start + 600, open: 107, high: 200, low: 50, close: 120, volume: 10 },
    ];
    const or = openingRange(bars, 5);
    assert.equal(or.high, 108);
    assert.equal(or.low, 99);
    assert.equal(or.bars, 2);
    assert.equal(or.complete, true);
  });

  it('reports incomplete while the window is still running', () => {
    const bars = [{ time: start, open: 100, high: 105, low: 99, close: 104, volume: 10 }];
    assert.equal(openingRange(bars, 5).complete, false);
  });

  it('returns null for a bad window', () => {
    assert.equal(openingRange([], 5), null);
    assert.equal(openingRange([{ time: start, open: 1, high: 1, low: 1, close: 1, volume: 1 }], 0), null);
  });
});

describe('relativeVolume — matched to the same point in the session', () => {
  const day = (d, vol) => intradaySession(Date.UTC(2026, 6, d, 13, 30) / 1000, 6, { vol });

  it('reports 100% when today matches the prior average', () => {
    const sessions = groupSessions([...day(1, 1000), ...day(2, 1000), ...day(3, 1000)]);
    assert.ok(Math.abs(relativeVolume(sessions) - 100) < 1e-6);
  });

  it('reports 200% when today is running at double', () => {
    const sessions = groupSessions([...day(1, 1000), ...day(2, 1000), ...day(3, 2000)]);
    assert.ok(Math.abs(relativeVolume(sessions) - 200) < 1e-6);
  });

  it('does NOT report a half-finished session as low volume', () => {
    // The naive version compares a partial session against prior FULL sessions
    // and calls every morning quiet. Time-matching is the point of this.
    const partial = intradaySession(Date.UTC(2026, 6, 3, 13, 30) / 1000, 3, { vol: 1000 });
    const sessions = groupSessions([...day(1, 1000), ...day(2, 1000), ...partial]);
    const rv = relativeVolume(sessions);
    assert.ok(Math.abs(rv - 100) < 1e-6, `expected about 100 percent, got ${rv}`);
  });

  it('returns null without prior sessions to compare against', () => {
    assert.equal(relativeVolume(groupSessions(day(1, 1000))), null);
  });
});

describe('intraday operands in context', () => {
  const intradayBars = [
    ...intradaySession(Date.UTC(2026, 6, 1, 13, 30) / 1000, 6),
    ...intradaySession(Date.UTC(2026, 6, 2, 13, 30) / 1000, 6),
  ];

  it('detects an intraday chart and populates the values', () => {
    const ctx = buildContext(intradayBars);
    assert.equal(ctx.intraday, true);
    assert.ok(Number.isFinite(ctx.values.vwap));
    assert.equal(ctx.values.time_et, 955);           // 13:30 UTC + 25min = 09:55 EDT
    assert.equal(ctx.values.minutes_since_open, 25);
    assert.ok(Number.isFinite(ctx.values.rvol));
  });

  it('marks a daily chart as not intraday and nulls those values', () => {
    const ctx = buildContext(seq([10, 11, 12]));
    assert.equal(ctx.intraday, false);
    for (const k of ['vwap', 'time_et', 'minutes_since_open', 'rvol']) {
      assert.equal(ctx.values[k], null, `${k} should be null on a daily chart`);
    }
  });

  it('makes an intraday criterion UNKNOWN on a daily chart, and says why', () => {
    const ctx = buildContext(seq([10, 11, 12]));
    const r = evaluateCriteria({ criteria: [{ id: 'above_vwap', left: 'price', op: '>', right: 'vwap' }] }, ctx);
    assert.equal(r.verdict, 'unknown');
    assert.match(r.criteria[0].reason, /intraday/i);
  });

  it('evaluates a time window correctly', () => {
    const ctx = buildContext(intradayBars);
    const after = evaluateCriteria({ criteria: [{ left: 'time_et', op: '>=', right: 935 }] }, ctx);
    assert.equal(after.verdict, 'pass');
    const before = evaluateCriteria({ criteria: [{ left: 'time_et', op: '<', right: 935 }] }, ctx);
    assert.equal(before.verdict, 'fail');
  });

  it('resolves the opening range as a function operand', () => {
    const ctx = buildContext(intradayBars);
    const r = resolveOperand('opening_range_high(10)', ctx);
    assert.equal(r.ok, true);
    assert.ok(Number.isFinite(r.value));
  });

  it('refuses the opening range on a daily chart with a reason', () => {
    const r = resolveOperand('opening_range_high(5)', buildContext(seq([10, 11, 12])));
    assert.equal(r.ok, false);
    assert.match(r.reason, /intraday/i);
  });
});
