/**
 * Signal validation against CRSP daily data.
 *
 * Answers one question: when this signal fired historically, what happened
 * next — and was it better than doing nothing?
 *
 * The baseline is the point. A 58% hit rate sounds like edge until you see the
 * unconditional rate over the same names and dates was 57%. Every result here
 * is reported against that baseline.
 */
import { query } from './wrds.js';
import { evaluateSignal, forwardReturn, summarize, round } from './indicators.js';

// Swing-trading horizons by default. Day-trading horizons are not meaningful
// on a daily file — the shortest honest measurement is next-day close.
const DEFAULT_HORIZONS = [5, 10, 20];
const MAX_TICKERS = 100;

/**
 * Map tickers to CRSP permnos.
 *
 * Tickers get reused across companies, so a match is only valid inside the
 * name record's date window. Resolving without that produces a series that
 * silently splices two different companies together.
 */
export async function resolveTickers({ tickers, start, end } = {}) {
  const list = (tickers || []).map((t) => String(t).toUpperCase().trim()).filter(Boolean);
  if (!list.length) throw new Error('tickers is required.');
  if (list.length > MAX_TICKERS) {
    throw new Error(`Too many tickers (${list.length}). Cap is ${MAX_TICKERS} — split the run.`);
  }

  const res = await query({
    sql: `
      SELECT ticker, permno, comnam, shrcd, exchcd,
             MIN(namedt)::date AS from_date, MAX(nameenddt)::date AS to_date
      FROM crsp.stocknames
      WHERE ticker = ANY($1)
        AND nameenddt >= $2::date
        AND namedt   <= $3::date
      GROUP BY ticker, permno, comnam, shrcd, exchcd
      ORDER BY ticker, to_date DESC
    `,
    params: [list, start, end],
    limit: 2000,
  });

  const byTicker = new Map();
  for (const row of res.rows) {
    // Keep the most recent name record per ticker in the window.
    if (!byTicker.has(row.ticker)) byTicker.set(row.ticker, row);
  }

  const resolved = [...byTicker.values()];
  const missing = list.filter((t) => !byTicker.has(t));
  // Several permnos for one ticker in-window means the ticker changed hands.
  const ambiguous = [...new Set(res.rows.map((r) => r.ticker))]
    .filter((t) => res.rows.filter((r) => r.ticker === t).length > 1);

  return { resolved, missing, ambiguous };
}

/** Split-adjusted daily closes per permno, oldest first. */
export async function fetchDaily({ permnos, start, end } = {}) {
  const res = await query({
    sql: `
      SELECT permno, date::date AS date,
             (ABS(prc) / NULLIF(cfacpr, 0))::float8 AS close
      FROM crsp.dsf
      WHERE permno = ANY($1)
        AND date BETWEEN $2::date AND $3::date
        AND prc IS NOT NULL
      ORDER BY permno, date
    `,
    params: [permnos, start, end],
    limit: 50000,
  });

  const series = new Map();
  for (const row of res.rows) {
    if (!series.has(row.permno)) series.set(row.permno, { dates: [], closes: [] });
    const s = series.get(row.permno);
    s.dates.push(row.date);
    s.closes.push(Number(row.close));
  }
  return { series, row_count: res.row_count, truncated: res.row_count >= 50000 };
}

/**
 * Run a signal over a set of tickers and compare its forward returns to the
 * unconditional baseline over the same names and dates.
 */
export async function backtestSignal({
  tickers,
  conditions,
  start = '2005-01-01',
  end = '2024-12-31',
  horizons = DEFAULT_HORIZONS,
} = {}) {
  if (!Array.isArray(conditions) || !conditions.length) {
    throw new Error('conditions is required — describe the signal, e.g. [{indicator:"ema",period:20,op:"price_above"}].');
  }
  const hs = (horizons || DEFAULT_HORIZONS).map(Number).filter((h) => Number.isInteger(h) && h > 0);
  if (!hs.length) throw new Error('horizons must be positive integers, e.g. [5,10,20].');

  const { resolved, missing, ambiguous } = await resolveTickers({ tickers, start, end });
  if (!resolved.length) {
    throw new Error(`None of the tickers resolved in CRSP for ${start}..${end}. Checked: ${(tickers || []).join(', ')}`);
  }

  const permnos = resolved.map((r) => r.permno);
  const { series, truncated } = await fetchDaily({ permnos, start, end });

  const signalReturns = Object.fromEntries(hs.map((h) => [h, []]));
  const baselineReturns = Object.fromEntries(hs.map((h) => [h, []]));
  const perSymbol = [];
  let totalBars = 0;
  let totalSignals = 0;
  let firstDate = null;
  let lastDate = null;

  for (const meta of resolved) {
    const s = series.get(meta.permno);
    if (!s || s.closes.length < 60) {
      perSymbol.push({ ticker: meta.ticker, bars: s?.closes.length || 0, signals: 0, note: 'too little history to evaluate' });
      continue;
    }

    if (!firstDate || s.dates[0] < firstDate) firstDate = s.dates[0];
    if (!lastDate || s.dates[s.dates.length - 1] > lastDate) lastDate = s.dates[s.dates.length - 1];

    const flags = evaluateSignal(s.closes, conditions);
    const fwd = Object.fromEntries(hs.map((h) => [h, forwardReturn(s.closes, h)]));

    let hits = 0;
    for (let i = 0; i < s.closes.length; i++) {
      totalBars++;
      for (const h of hs) {
        const r = fwd[h][i];
        if (r === null) continue;
        baselineReturns[h].push(r);
        if (flags[i]) signalReturns[h].push(r);
      }
      if (flags[i]) { hits++; totalSignals++; }
    }

    perSymbol.push({
      ticker: meta.ticker,
      company: meta.comnam,
      permno: meta.permno,
      bars: s.closes.length,
      signals: hits,
      signal_rate_pct: round((hits / s.closes.length) * 100, 1),
    });
  }

  const byHorizon = hs.map((h) => {
    const sig = summarize(signalReturns[h]);
    const base = summarize(baselineReturns[h]);
    if (!sig || !base) return { horizon_days: h, insufficient_data: true };

    const edge = round(sig.mean_pct - base.mean_pct, 3);
    // Difference in means over the standard error of the signal set. A rough
    // signal-to-noise read, not a significance test — the observations overlap.
    const tLike = sig.stderr_pct ? round(edge / sig.stderr_pct, 2) : null;

    return {
      horizon_days: h,
      signal: sig,
      baseline: base,
      edge_mean_pct: edge,
      edge_hit_rate_pct: round(sig.hit_rate_pct - base.hit_rate_pct, 1),
      edge_over_stderr: tLike,
    };
  });

  const warnings = [];
  if (totalSignals < 100) {
    warnings.push(`Only ${totalSignals} signal observations. Too few to conclude anything — widen the date range or loosen the conditions.`);
  }
  if (missing.length) warnings.push(`Not found in CRSP for this window: ${missing.join(', ')}.`);
  if (ambiguous.length) warnings.push(`Ticker reused by more than one company in this window: ${ambiguous.join(', ')}. Results may mix companies — narrow the dates.`);
  if (truncated) warnings.push('Hit the 50,000-row cap — the price history is incomplete. Use fewer tickers or a shorter window.');
  if (hs.some((h) => h > 1)) {
    warnings.push('Forward windows overlap because signals are sampled daily, so observations are not independent. Treat edge_over_stderr as indicative, not a p-value.');
  }
  warnings.push('Testing your current watchlist is survivorship-biased: these are names you already hold or follow, selected with hindsight. Edge here is an upper bound.');

  return {
    success: true,
    period: { requested: { start, end }, observed: { first: firstDate, last: lastDate } },
    universe: { requested: (tickers || []).length, resolved: resolved.length, missing },
    conditions,
    horizons: hs,
    totals: {
      symbol_bars: totalBars,
      signal_bars: totalSignals,
      signal_rate_pct: totalBars ? round((totalSignals / totalBars) * 100, 2) : 0,
    },
    by_horizon: byHorizon,
    per_symbol: perSymbol,
    warnings,
    interpretation: [
      'Compare signal to baseline at each horizon; the raw signal number alone means nothing.',
      'edge_mean_pct is the excess mean forward return over doing nothing in the same names and dates.',
      'A positive edge with edge_over_stderr below roughly 2 is not distinguishable from noise.',
      'Returns are gross: no commission, slippage, or borrow costs.',
    ].join(' '),
  };
}
