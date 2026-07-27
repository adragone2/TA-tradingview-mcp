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
