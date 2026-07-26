/**
 * Indicators, computed in JS rather than SQL so they are unit-testable without
 * a database connection and match the definitions a chart uses.
 *
 * Every function returns an array the same length as the input, with `null`
 * for bars where the indicator is not yet defined. That alignment matters:
 * a backtest must never treat a warm-up bar as a real reading.
 *
 * All are strictly causal — index i uses only values at or before i. Any
 * look-ahead here would silently invent edge.
 */

export function sma(values, period) {
  if (!Number.isInteger(period) || period < 1) throw new Error('sma: period must be a positive integer');
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v === null || Number.isNaN(v)) return out; // a gap invalidates the running sum
    sum += v;
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/**
 * Exponential moving average, seeded with the SMA of the first `period` bars —
 * the convention charting platforms use.
 */
export function ema(values, period) {
  if (!Number.isInteger(period) || period < 1) throw new Error('ema: period must be a positive integer');
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;

  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  let prev = seed / period;
  out[period - 1] = prev;

  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/**
 * Wilder's RSI. Uses Wilder smoothing (not a simple average of gains/losses),
 * which is what TradingView's built-in RSI does — a simple-average variant
 * gives visibly different values and would not match the chart.
 */
export function rsi(values, period = 14) {
  if (!Number.isInteger(period) || period < 1) throw new Error('rsi: period must be a positive integer');
  const out = new Array(values.length).fill(null);
  if (values.length <= period) return out;

  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i] - values[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < values.length; i++) {
    const d = values[i] - values[i - 1];
    const g = d > 0 ? d : 0;
    const l = d < 0 ? -d : 0;
    avgGain = (avgGain * (period - 1) + g) / period;
    avgLoss = (avgLoss * (period - 1) + l) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

/**
 * Forward return over `horizon` bars, as a fraction.
 *
 * Deliberately measured from the NEXT bar's close: a signal seen at the close
 * of bar i can only be acted on afterwards. Measuring from bar i itself would
 * bake in a same-bar fill nobody gets.
 *
 * out[i] = close[i + 1 + horizon] / close[i + 1] - 1
 */
export function forwardReturn(values, horizon) {
  if (!Number.isInteger(horizon) || horizon < 1) throw new Error('forwardReturn: horizon must be a positive integer');
  const out = new Array(values.length).fill(null);
  for (let i = 0; i < values.length; i++) {
    const entry = i + 1;
    const exit = i + 1 + horizon;
    if (exit >= values.length) break;
    const e = values[entry];
    if (!e) continue;
    out[i] = values[exit] / e - 1;
  }
  return out;
}

/** Summary statistics for a set of returns. Returns null for an empty set rather than NaN. */
export function summarize(returns) {
  const xs = returns.filter((r) => r !== null && Number.isFinite(r));
  if (!xs.length) return null;

  const n = xs.length;
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const sorted = [...xs].sort((a, b) => a - b);
  const median = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  const variance = n > 1 ? xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) : 0;
  const sd = Math.sqrt(variance);
  const wins = xs.filter((x) => x > 0).length;

  return {
    n,
    mean_pct: round(mean * 100, 3),
    median_pct: round(median * 100, 3),
    hit_rate_pct: round((wins / n) * 100, 1),
    sd_pct: round(sd * 100, 3),
    // Standard error of the mean, so a difference can be judged against noise
    // instead of eyeballed.
    stderr_pct: round((sd / Math.sqrt(n)) * 100, 3),
    best_pct: round(sorted[n - 1] * 100, 2),
    worst_pct: round(sorted[0] * 100, 2),
  };
}

export function round(x, dp) {
  const f = 10 ** dp;
  return Math.round(x * f) / f;
}

/**
 * Evaluate one condition at every bar.
 * Returns a boolean array; bars where inputs are undefined are false.
 *
 * Supported shapes:
 *   { indicator: 'rsi',  period: 14, op: 'below'|'above', value: 60 }
 *   { indicator: 'ema',  period: 20, op: 'price_above'|'price_below' }
 *   { indicator: 'sma',  period: 50, op: 'above'|'below', compare: { indicator:'sma', period:200 } }
 */
export function evaluateCondition(closes, cond) {
  const series = computeIndicator(closes, cond);
  const n = closes.length;
  const out = new Array(n).fill(false);

  if (cond.op === 'price_above' || cond.op === 'price_below') {
    for (let i = 0; i < n; i++) {
      if (series[i] === null) continue;
      out[i] = cond.op === 'price_above' ? closes[i] > series[i] : closes[i] < series[i];
    }
    return out;
  }

  if (cond.op === 'above' || cond.op === 'below') {
    let rhs;
    if (cond.compare) {
      rhs = computeIndicator(closes, cond.compare);
    } else {
      if (typeof cond.value !== 'number') {
        throw new Error(`Condition on ${cond.indicator} with op "${cond.op}" needs either value or compare.`);
      }
      rhs = new Array(n).fill(cond.value);
    }
    for (let i = 0; i < n; i++) {
      if (series[i] === null || rhs[i] === null || rhs[i] === undefined) continue;
      out[i] = cond.op === 'above' ? series[i] > rhs[i] : series[i] < rhs[i];
    }
    return out;
  }

  throw new Error(`Unknown op "${cond.op}". Use above, below, price_above, or price_below.`);
}

function computeIndicator(closes, spec) {
  const period = spec.period ?? 14;
  switch (String(spec.indicator || '').toLowerCase()) {
    case 'sma': return sma(closes, period);
    case 'ema': return ema(closes, period);
    case 'rsi': return rsi(closes, period);
    case 'close': return closes.slice();
    default:
      throw new Error(`Unknown indicator "${spec.indicator}". Use sma, ema, rsi, or close.`);
  }
}

/** A bar passes only when every condition holds — conditions are ANDed. */
export function evaluateSignal(closes, conditions) {
  if (!Array.isArray(conditions) || !conditions.length) {
    throw new Error('At least one condition is required.');
  }
  const parts = conditions.map((c) => evaluateCondition(closes, c));
  return closes.map((_, i) => parts.every((p) => p[i]));
}
