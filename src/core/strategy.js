/**
 * Machine-evaluable strategy criteria.
 *
 * `rules.json` has always held criteria as prose — "Price is above the 20 EMA
 * on the 4H". A model reads that and grades it, which means three things go
 * wrong: two sessions can grade the same chart differently, the criteria cannot
 * be scanned across a watchlist deterministically, and they cannot be
 * backtested at all. A rule you cannot test is a preference, not a strategy.
 *
 * This module makes criteria data. Each one is {left, op, right}, resolved
 * against values computed from the bars — so the same specification can be
 * checked live, scanned across symbols, and (with the same operands) measured
 * historically, instead of three descriptions that silently drift apart.
 *
 * Indicators are computed here rather than read off the chart. Reading them
 * would require the study to be present and visible on every symbol scanned,
 * and would make the result depend on chart state that the specification does
 * not mention.
 *
 * Everything above `buildContext` is pure.
 */
import * as data from './data.js';
import { normalizeBars } from './structure.js';

const round = (n, dp = 6) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10 ** dp) / 10 ** dp);

/* ---------------------------- indicators ---------------------------- */

export function sma(values, length) {
  if (!Array.isArray(values) || values.length < length || length < 1) return null;
  const slice = values.slice(-length);
  return slice.reduce((a, b) => a + b, 0) / length;
}

/** EMA seeded with the SMA of the first `length` values — the convention charts use. */
export function ema(values, length) {
  if (!Array.isArray(values) || values.length < length || length < 1) return null;
  const k = 2 / (length + 1);
  let e = values.slice(0, length).reduce((a, b) => a + b, 0) / length;
  for (let i = length; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

/** Wilder's RSI — the smoothing TradingView's built-in uses. */
export function rsi(values, length = 14) {
  if (!Array.isArray(values) || values.length < length + 1) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= length; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  let avgGain = gain / length, avgLoss = loss / length;
  for (let i = length + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    avgGain = (avgGain * (length - 1) + (d > 0 ? d : 0)) / length;
    avgLoss = (avgLoss * (length - 1) + (d < 0 ? -d : 0)) / length;
  }
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

/** Wilder's ATR. */
export function atr(bars, length = 14) {
  if (!Array.isArray(bars) || bars.length < length + 1) return null;
  const tr = [];
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i], p = bars[i - 1];
    tr.push(Math.max(b.high - b.low, Math.abs(b.high - p.close), Math.abs(b.low - p.close)));
  }
  if (tr.length < length) return null;
  let a = tr.slice(0, length).reduce((x, y) => x + y, 0) / length;
  for (let i = length; i < tr.length; i++) a = (a * (length - 1) + tr[i]) / length;
  return a;
}

/* ------------------------------ sessions ---------------------------- */

/**
 * Group bars into sessions by UTC date.
 *
 * Sound for US equities and most instruments whose session sits inside one UTC
 * date. It is NOT sound for instruments whose session crosses midnight UTC —
 * futures and FX — where "previous day" here means previous UTC date, not
 * previous trading session. Callers get `session_basis` so this shows up in the
 * output rather than being assumed away.
 */
export function groupSessions(bars) {
  const days = new Map();
  for (const b of bars) {
    if (!Number.isFinite(b.time)) continue;
    const key = new Date(b.time * 1000).toISOString().slice(0, 10);
    if (!days.has(key)) days.set(key, []);
    days.get(key).push(b);
  }
  return [...days.entries()].map(([date, list]) => ({
    date,
    bars: list,
    open: list[0].open,
    close: list[list.length - 1].close,
    high: Math.max(...list.map((b) => b.high)),
    low: Math.min(...list.map((b) => b.low)),
    volume: list.reduce((s, b) => s + (b.volume || 0), 0),
  })).sort((a, b) => (a.date < b.date ? -1 : 1));
}

/* ------------------------------ operands ---------------------------- */

const FUNC = /^(sma|ema|rsi|atr)\((\d+)\)$/i;
// A trailing "<operator> <number>", e.g. "ema(8) * 0.98". Anchored on a numeric
// tail, so "sma(200)" — which ends in a paren — is never mistaken for one.
const ARITH = /^(.+?)\s*([*/+-])\s*(-?\d+(?:\.\d+)?)$/;

/** Every operand name the criteria language understands. */
export const OPERANDS = [
  'price', 'open', 'high', 'low', 'close', 'volume',
  'prev_day_open', 'prev_day_high', 'prev_day_low', 'prev_day_close',
  'high_of_day', 'low_of_day', 'session_volume', 'pct_change_today',
  'sma(N)', 'ema(N)', 'rsi(N)', 'atr(N)',
  '<any of the above> <* / + -> <number>, e.g. "ema(8) * 0.98"',
];

/**
 * Resolve one side of a criterion to a number.
 *
 * Returns {value, ok, reason} rather than throwing or coercing: an operand that
 * cannot be computed (not enough bars for a 200-period average, say) must make
 * the criterion UNKNOWN, never false. A missing value silently reading as false
 * would turn "I could not check this" into "this failed", which is how a
 * scanner quietly stops finding anything.
 */
export function resolveOperand(token, ctx) {
  if (typeof token === 'number') return { value: token, ok: true };
  if (token == null) return { value: null, ok: false, reason: 'operand is null' };

  const raw = String(token).trim();

  const asNumber = Number(raw);
  if (raw !== '' && Number.isFinite(asNumber)) return { value: asNumber, ok: true };

  // "ema(8) * 0.98" — enough arithmetic to express "within 2% of the 8 EMA"
  // or "above yesterday's high by a tick", without inventing an expression
  // language nobody asked for.
  const arith = raw.match(ARITH);
  if (arith) {
    const base = resolveOperand(arith[1], ctx);
    if (!base.ok) return base;
    const n = Number(arith[3]);
    const op = arith[2];
    if (op === '/' && n === 0) return { value: null, ok: false, reason: 'division by zero' };
    const value = op === '*' ? base.value * n
      : op === '/' ? base.value / n
      : op === '+' ? base.value + n
      : base.value - n;
    return { value, ok: true };
  }

  const fn = raw.match(FUNC);
  if (fn) {
    const name = fn[1].toLowerCase(), len = Number(fn[2]);
    if (len < 1) return { value: null, ok: false, reason: `${name} needs a positive length` };
    const closes = ctx.closes || [];
    let v = null;
    if (name === 'sma') v = sma(closes, len);
    else if (name === 'ema') v = ema(closes, len);
    else if (name === 'rsi') v = rsi(closes, len);
    else if (name === 'atr') v = atr(ctx.bars || [], len);
    if (v == null) {
      return { value: null, ok: false, reason: `not enough bars to compute ${name}(${len}) — have ${closes.length}` };
    }
    return { value: v, ok: true };
  }

  const key = raw.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(ctx.values || {}, key)) {
    const v = ctx.values[key];
    if (v == null || !Number.isFinite(v)) return { value: null, ok: false, reason: `${key} is not available on this chart` };
    return { value: v, ok: true };
  }

  return { value: null, ok: false, reason: `unknown operand "${raw}". Known: ${OPERANDS.join(', ')}` };
}

const OPS = {
  '>': (a, b) => a > b,
  '>=': (a, b) => a >= b,
  '<': (a, b) => a < b,
  '<=': (a, b) => a <= b,
  '==': (a, b) => a === b,
  '!=': (a, b) => a !== b,
};

/**
 * Validate a strategy specification.
 *
 * Runs before anything is evaluated, so a malformed strategy fails once with a
 * clear message rather than producing a scan whose every symbol mysteriously
 * fails one criterion.
 */
export function validateStrategy(spec) {
  const errors = [];
  if (!spec || typeof spec !== 'object') return { valid: false, errors: ['strategy must be an object'] };

  if (spec.direction && !['long', 'short'].includes(String(spec.direction).toLowerCase())) {
    errors.push(`direction must be "long" or "short" (got "${spec.direction}")`);
  }
  if (!Array.isArray(spec.criteria) || spec.criteria.length === 0) {
    errors.push('criteria must be a non-empty array');
    return { valid: false, errors };
  }

  spec.criteria.forEach((c, i) => {
    const at = `criteria[${i}]`;
    if (!c || typeof c !== 'object') { errors.push(`${at} must be an object`); return; }
    if (!Object.prototype.hasOwnProperty.call(OPS, c.op)) {
      errors.push(`${at}.op must be one of ${Object.keys(OPS).join(' ')} (got "${c.op}")`);
    }
    if (c.left === undefined || c.left === null) errors.push(`${at}.left is required`);
    if (c.right === undefined || c.right === null) errors.push(`${at}.right is required`);
  });

  return { valid: errors.length === 0, errors };
}

/**
 * Evaluate a strategy's criteria against a context.
 *
 * A criterion whose operands cannot be resolved is `unknown`, and any unknown
 * makes the whole strategy `unknown` rather than a pass or a fail. Reporting
 * "3 of 5 passed, 2 unresolved" as a fail would be wrong; reporting it as a
 * pass would be worse.
 */
export function evaluateCriteria(spec, ctx) {
  const check = validateStrategy(spec);
  if (!check.valid) throw new Error(`Invalid strategy: ${check.errors.join('; ')}`);

  const results = spec.criteria.map((c, i) => {
    const L = resolveOperand(c.left, ctx);
    const R = resolveOperand(c.right, ctx);
    const id = c.id || `${c.left} ${c.op} ${c.right}`;

    if (!L.ok || !R.ok) {
      return {
        id, left: c.left, op: c.op, right: c.right,
        status: 'unknown',
        reason: [L.ok ? null : L.reason, R.ok ? null : R.reason].filter(Boolean).join('; '),
      };
    }

    const pass = OPS[c.op](L.value, R.value);
    return {
      id, left: c.left, op: c.op, right: c.right,
      left_value: round(L.value), right_value: round(R.value),
      status: pass ? 'pass' : 'fail',
      ...(c.note ? { note: c.note } : {}),
    };
  });

  const passed = results.filter((r) => r.status === 'pass').length;
  const failed = results.filter((r) => r.status === 'fail').length;
  const unknown = results.filter((r) => r.status === 'unknown').length;

  const verdict = unknown > 0 ? 'unknown' : (failed === 0 ? 'pass' : 'fail');

  return {
    verdict,
    passed, failed, unknown,
    total: results.length,
    criteria: results,
    ...(unknown > 0
      ? { unknown_note: `${unknown} criterion/criteria could not be evaluated, so the verdict is UNKNOWN rather than a pass or a fail. Unresolved is not the same as failed.` }
      : {}),
  };
}

/* --------------------------- chart-facing --------------------------- */

/** Build the value context for a symbol from its bars. */
export function buildContext(bars) {
  const closes = bars.map((b) => b.close);
  const sessions = groupSessions(bars);
  const today = sessions[sessions.length - 1] || null;
  const prev = sessions.length > 1 ? sessions[sessions.length - 2] : null;
  const last = bars[bars.length - 1];

  return {
    bars, closes,
    sessions: sessions.length,
    values: {
      price: last?.close ?? null,
      open: last?.open ?? null,
      high: last?.high ?? null,
      low: last?.low ?? null,
      close: last?.close ?? null,
      volume: last?.volume ?? null,
      prev_day_open: prev?.open ?? null,
      prev_day_high: prev?.high ?? null,
      prev_day_low: prev?.low ?? null,
      prev_day_close: prev?.close ?? null,
      high_of_day: today?.high ?? null,
      low_of_day: today?.low ?? null,
      session_volume: today?.volume ?? null,
      pct_change_today: prev?.close && last?.close != null
        ? ((last.close - prev.close) / prev.close) * 100
        : null,
    },
  };
}

async function contextForChart(count) {
  const bars = normalizeBars(await data.getOhlcv({ count, summary: false }));
  if (!bars.length) throw new Error('No price bars came back from the chart.');
  return { bars, ctx: buildContext(bars) };
}

/** Check one strategy against the symbol currently on the chart. */
export async function checkStrategy({ strategy, count = 400 } = {}) {
  const { bars, ctx } = await contextForChart(count);
  const result = evaluateCriteria(strategy, ctx);

  return {
    success: true,
    strategy: strategy.name || null,
    direction: strategy.direction || null,
    bars_analyzed: bars.length,
    sessions_available: ctx.sessions,
    ...result,
    values: Object.fromEntries(Object.entries(ctx.values).map(([k, v]) => [k, round(v)])),
    session_basis: 'Sessions are grouped by UTC date. Sound for US equities; NOT sound for futures or FX whose session crosses midnight UTC — there "previous day" means previous UTC date.',
    note: 'Criteria are evaluated from the bars, not from indicators on the chart, so the result does not depend on which studies happen to be loaded.',
  };
}

/**
 * Check a strategy across several symbols.
 *
 * Drives the chart through each symbol and restores it afterwards — the chart
 * is the user's workspace, and a scan must not leave them somewhere unexpected.
 */
export async function scanStrategy({ strategy, symbols, timeframe = null, count = 400 } = {}) {
  const check = validateStrategy(strategy);
  if (!check.valid) throw new Error(`Invalid strategy: ${check.errors.join('; ')}`);
  if (!Array.isArray(symbols) || !symbols.length) throw new Error('symbols must be a non-empty array.');

  const chart = await import('./chart.js');
  const before = await chart.getState();
  const originalSymbol = before?.symbol || null;
  const originalTf = before?.timeframe || before?.resolution || null;

  const hits = [], misses = [], unresolved = [];

  try {
    for (const symbol of symbols) {
      try {
        await chart.setSymbol({ symbol });
        if (timeframe) await chart.setTimeframe({ timeframe });
        await new Promise((r) => setTimeout(r, 350));

        const { ctx } = await contextForChart(count);
        const r = evaluateCriteria(strategy, ctx);
        const row = {
          symbol,
          verdict: r.verdict,
          passed: r.passed, failed: r.failed, unknown: r.unknown,
          failing: r.criteria.filter((c) => c.status === 'fail').map((c) => c.id),
          ...(r.unknown ? { unresolved: r.criteria.filter((c) => c.status === 'unknown').map((c) => ({ id: c.id, reason: c.reason })) } : {}),
          price: round(ctx.values.price),
        };
        if (r.verdict === 'pass') hits.push(row);
        else if (r.verdict === 'unknown') unresolved.push(row);
        else misses.push(row);
      } catch (e) {
        unresolved.push({ symbol, verdict: 'unknown', error: e.message });
      }
    }
  } finally {
    // Restore whatever the user had, even if the scan threw partway.
    if (originalSymbol) {
      try {
        await chart.setSymbol({ symbol: originalSymbol });
        if (originalTf) await chart.setTimeframe({ timeframe: originalTf });
      } catch { /* leave the chart where it is rather than masking the real error */ }
    }
  }

  return {
    success: true,
    strategy: strategy.name || null,
    scanned: symbols.length,
    hit_count: hits.length,
    hits,
    misses,
    ...(unresolved.length ? { unresolved, unresolved_note: 'These could not be evaluated — treat as "not checked", not as "did not qualify".' } : {}),
    restored_to: originalSymbol,
    note: 'A hit means every criterion passed at this moment on this timeframe. It is the user\'s own specification being checked, not a recommendation.',
  };
}
