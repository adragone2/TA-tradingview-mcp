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

/* --------------------------- intraday values ------------------------- */

/**
 * Wall-clock time in US market time, as HHMM (935, 1200, 1530).
 *
 * Every intraday setup is specified in ET, and the bars carry UTC. The offset
 * is NOT constant — measured on this chart, the same session sat 52,200s from
 * midnight in February and 48,600s in May, which is the DST shift. So the
 * conversion goes through the IANA zone rather than a hardcoded offset, and
 * returns null if the runtime has no timezone data, which makes any criterion
 * using it UNKNOWN instead of silently an hour out.
 *
 * HHMM is monotonic within a day, so >= and <= order correctly. It is NOT
 * minutes — do not do arithmetic on it; use minutes_since_open for that.
 */
export function etTimeHHMM(unixSeconds) {
  if (!Number.isFinite(unixSeconds)) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(new Date(unixSeconds * 1000));
    const h = Number(parts.find((p) => p.type === 'hour')?.value);
    const m = Number(parts.find((p) => p.type === 'minute')?.value);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
    return (h % 24) * 100 + m;
  } catch {
    return null;
  }
}

/**
 * Session-anchored VWAP: cumulative (typical price x volume) / cumulative
 * volume, reset every session.
 *
 * Returns null on a chart whose bars ARE sessions — a daily chart has one bar
 * per session, so "VWAP so far today" is just that bar's typical price, which
 * looks like a number and means nothing. Null makes the criterion UNKNOWN,
 * which is the honest answer.
 */
export function sessionVwap(sessionBars) {
  if (!Array.isArray(sessionBars) || sessionBars.length < 2) return null;
  let pv = 0, vol = 0;
  for (const b of sessionBars) {
    const v = Number(b.volume);
    if (!Number.isFinite(v) || v <= 0) continue;
    pv += ((b.high + b.low + b.close) / 3) * v;
    vol += v;
  }
  return vol > 0 ? pv / vol : null;
}

/** High/low of the first `minutes` of a session. */
export function openingRange(sessionBars, minutes) {
  if (!Array.isArray(sessionBars) || !sessionBars.length || !(minutes > 0)) return null;
  const open = sessionBars[0].time;
  const window = sessionBars.filter((b) => b.time < open + minutes * 60);
  if (!window.length) return null;
  // The opening range is not established until the window has actually elapsed.
  const complete = sessionBars[sessionBars.length - 1].time >= open + minutes * 60;
  return {
    high: Math.max(...window.map((b) => b.high)),
    low: Math.min(...window.map((b) => b.low)),
    bars: window.length,
    complete,
  };
}

/**
 * Relative volume: this session's volume so far against the average volume
 * that prior sessions had accumulated BY THE SAME POINT in their session.
 *
 * The time-matched comparison is the whole point. Comparing a half-finished
 * session against prior full sessions would report every morning as low
 * volume, which is the naive version of this and is simply wrong.
 */
export function relativeVolume(sessions, lookback = 20) {
  if (!Array.isArray(sessions) || sessions.length < 2) return null;
  const today = sessions[sessions.length - 1];
  if (!today.bars.length) return null;

  const elapsed = today.bars[today.bars.length - 1].time - today.bars[0].time;
  const soFar = today.bars.reduce((s, b) => s + (Number(b.volume) || 0), 0);
  if (!(soFar > 0)) return null;

  const priors = sessions.slice(Math.max(0, sessions.length - 1 - lookback), sessions.length - 1);
  if (!priors.length) return null;

  const matched = [];
  for (const s of priors) {
    if (!s.bars.length) continue;
    const open = s.bars[0].time;
    const v = s.bars.filter((b) => b.time - open <= elapsed).reduce((sum, b) => sum + (Number(b.volume) || 0), 0);
    if (v > 0) matched.push(v);
  }
  if (!matched.length) return null;

  const avg = matched.reduce((a, b) => a + b, 0) / matched.length;
  return avg > 0 ? (soFar / avg) * 100 : null;
}

/* ------------------------------ operands ---------------------------- */

const FUNC = /^(sma|ema|rsi|atr|opening_range_high|opening_range_low|sma_slope|ema_slope|rsi_slope)\((\d+)\)$/i;
/** Cross operands: `ema(8) crosses_above ema(20)` is an EVENT, not a state. */
const CROSS = /^(.+?)\s+(crosses_above|crosses_below)\s+(.+)$/i;
// A trailing "<operator> <number>", e.g. "ema(8) * 0.98". Anchored on a numeric
// tail, so "sma(200)" — which ends in a paren — is never mistaken for one.
const ARITH = /^(.+?)\s*([*/+-])\s*(-?\d+(?:\.\d+)?)$/;

/** Every operand name the criteria language understands. */
export const OPERANDS = [
  'price', 'open', 'high', 'low', 'close', 'volume',
  'prev_day_open', 'prev_day_high', 'prev_day_low', 'prev_day_close',
  'high_of_day', 'low_of_day', 'session_volume', 'pct_change_today',
  'sma(N)', 'ema(N)', 'rsi(N)', 'atr(N)',
  // Intraday only — each is null (and so UNKNOWN) on a chart whose bars are sessions.
  'vwap', 'time_et', 'minutes_since_open', 'rvol',
  'opening_range_high(MINUTES)', 'opening_range_low(MINUTES)',
  // Slope in percent per bar — a level says nothing about direction.
  'sma_slope(N)', 'ema_slope(N)', 'rsi_slope(N)',
  // Structure, computed elsewhere and exposed here so criteria can use them.
  'pullback_pct', 'nearest_level_tests', 'nearest_level_distance_pct',
  'in_demand_zone', 'in_supply_zone', 'nearest_zone_distance_pct',
  // Events, not states. `<a> crosses_above <b>` / `<a> crosses_below <b>`.
  '<any> crosses_above <any>', '<any> crosses_below <any>',
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

  // A CROSS is an event, not a state. `rsi(14) > 50` fires on every bar of a
  // trend; `rsi(14) crosses_above 50` fires on the bar it actually happened.
  // Using the state where the rule means the event is the single commonest way
  // a scan quietly stops meaning what it says.
  const cross = raw.match(CROSS);
  if (cross) {
    const [, leftTok, op, rightTok] = cross;
    const prevCtx = ctx.previous;
    if (!prevCtx) {
      return { value: null, ok: false, reason: 'a cross needs the previous bar values, which this context does not carry' };
    }
    const nowL = resolveOperand(leftTok.trim(), ctx);
    const nowR = resolveOperand(rightTok.trim(), ctx);
    const wasL = resolveOperand(leftTok.trim(), prevCtx);
    const wasR = resolveOperand(rightTok.trim(), prevCtx);
    for (const [r, which] of [[nowL, 'left'], [nowR, 'right'], [wasL, 'previous left'], [wasR, 'previous right']]) {
      if (!r.ok) return { value: null, ok: false, reason: `${which} side of the cross: ${r.reason}` };
    }
    const above = op.toLowerCase() === 'crosses_above';
    const happened = above
      ? wasL.value <= wasR.value && nowL.value > nowR.value
      : wasL.value >= wasR.value && nowL.value < nowR.value;
    return { value: happened ? 1 : 0, ok: true, boolean: true };
  }

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

    if (name === 'opening_range_high' || name === 'opening_range_low') {
      if (!ctx.intraday) {
        return { value: null, ok: false, reason: 'opening range needs intraday bars — this chart has one bar per session' };
      }
      const or = openingRange(ctx.today_bars || [], len);
      if (!or) return { value: null, ok: false, reason: `no bars within the first ${len} minutes of the session` };
      if (!or.complete) {
        return { value: null, ok: false, reason: `the first ${len} minutes of the session have not elapsed yet — the opening range is not set` };
      }
      return { value: name === 'opening_range_high' ? or.high : or.low, ok: true };
    }

    // Slope: the current value against the value `len` bars ago, normalized to
    // percent per bar. "SMA20 sloping, not flat" needs this — the level of a
    // moving average says nothing about whether it is rising.
    if (name.endsWith('_slope')) {
      const base = name.replace('_slope', '');
      const fnOf = (arr) => (base === 'sma' ? sma(arr, len) : base === 'ema' ? ema(arr, len) : rsi(arr, len));
      const now = fnOf(closes);
      const back = closes.length > len ? fnOf(closes.slice(0, -len)) : null;
      if (now == null || back == null || !(Math.abs(back) > 0)) {
        return { value: null, ok: false, reason: `not enough bars to measure ${name}(${len}) — need at least ${len * 2 + 1}` };
      }
      return { value: ((now - back) / Math.abs(back)) * 100 / len, ok: true };
    }

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
    if (v == null || !Number.isFinite(v)) {
      // Say WHY, so "unknown" is diagnosable rather than mysterious.
      if (INTRADAY_ONLY.has(key) && !ctx.intraday) {
        return { value: null, ok: false, reason: `${key} needs intraday bars — this chart has one bar per session` };
      }
      if (key === 'rvol') return { value: null, ok: false, reason: 'rvol needs prior sessions with volume to compare against' };
      if (key === 'vwap') return { value: null, ok: false, reason: 'vwap needs intraday bars carrying volume' };
      if (STRUCTURE_KEYS.has(key)) {
        return { value: null, ok: false, reason: `${key} needs structure context — it is computed by levels_find/zones_find and passed in, not derived here` };
      }
      return { value: null, ok: false, reason: `${key} is not available on this chart` };
    }
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
export /** Values supplied by other modules rather than computed here. */
const STRUCTURE_KEYS = new Set([
  'pullback_pct', 'nearest_level_tests', 'nearest_level_distance_pct',
  'in_demand_zone', 'in_supply_zone', 'nearest_zone_distance_pct',
]);

const INTRADAY_ONLY = new Set(['vwap', 'time_et', 'minutes_since_open', 'rvol']);

export function buildContext(bars, { rvol_lookback = 20, structure = null, _depth = 0 } = {}) {
  const closes = bars.map((b) => b.close);
  const sessions = groupSessions(bars);
  const today = sessions[sessions.length - 1] || null;
  const prev = sessions.length > 1 ? sessions[sessions.length - 2] : null;
  const last = bars[bars.length - 1];

  // "Intraday" means the chart has more than one bar inside a session. On a
  // daily chart every session is a single bar, and VWAP, time-of-day and RVOL
  // are all undefined rather than merely awkward.
  const maxBarsInSession = sessions.reduce((m, s) => Math.max(m, s.bars.length), 0);
  const intraday = maxBarsInSession > 1;
  const todayBars = today?.bars || [];

  // A cross needs yesterday's answer as well as today's, so the context carries
  // one built from the bars up to the previous one. Depth-limited to a single
  // step: a cross of a cross is not a thing, and without the guard this recurses
  // once per bar and takes the process with it.
  const previous = _depth === 0 && bars.length > 1
    ? buildContext(bars.slice(0, -1), { rvol_lookback, structure, _depth: 1 })
    : null;

  return {
    bars, closes,
    sessions: sessions.length,
    intraday,
    today_bars: todayBars,
    previous,
    values: {
      // Structural values are computed by other modules and passed in, because
      // strategy.js must not grow its own copy of level or zone detection —
      // two implementations would drift and criteria would silently disagree
      // with levels_find. Absent structure they are null, and so UNKNOWN.
      pullback_pct: structure?.pullback_pct ?? null,
      nearest_level_tests: structure?.nearest_level_tests ?? null,
      nearest_level_distance_pct: structure?.nearest_level_distance_pct ?? null,
      in_demand_zone: structure?.in_demand_zone ?? null,
      in_supply_zone: structure?.in_supply_zone ?? null,
      nearest_zone_distance_pct: structure?.nearest_zone_distance_pct ?? null,
      vwap: intraday ? sessionVwap(todayBars) : null,
      time_et: intraday ? etTimeHHMM(last?.time) : null,
      minutes_since_open: intraday && todayBars.length
        ? Math.round((last.time - todayBars[0].time) / 60)
        : null,
      rvol: intraday ? relativeVolume(sessions, rvol_lookback) : null,
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
    intraday: ctx.intraday,
    ...result,
    values: Object.fromEntries(Object.entries(ctx.values).map(([k, v]) => [k, round(v)])),
    ...(ctx.intraday ? {} : { intraday_note: 'This chart has one bar per session, so vwap, time_et, minutes_since_open, rvol and opening_range_* are unavailable — any criterion using them is UNKNOWN, not failed. Switch to an intraday timeframe to evaluate them.' }),
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
