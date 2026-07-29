/**
 * TradingView's own screener, as a coarse filter over the whole US market.
 *
 * ── Why this exists ──
 *
 * Stage 1 of the morning screen. TradingView computes 3,771 fields across
 * 19,672 US symbols server-side and returns a filtered slice in about 300ms.
 * Doing the same by loading charts would be 19,672 chart loads. This repo's
 * detectors then run on the survivors — which is the division of labour: TV has
 * breadth, this repo has the noise floors, horizon priors and deflation.
 *
 * ── Two things that cost time to establish ──
 *
 * 1. IT MUST BE CALLED FROM NODE, NOT THE PAGE. A fetch from the chart page is
 *    blocked by CSP (`Failed to fetch`) because the scanner is a different
 *    origin. From Node it needs no auth and no chart, which is better: morning
 *    screening has no dependency on TradingView Desktop running at all.
 *
 * 2. INDEX MEMBERSHIP IS NOT A FILTER. `indexes` rejects every operation with
 *    HTTP 400; `index_id` accepts them and matches nothing — a silent zero, the
 *    most expensive kind of wrong. Membership is a top-level `symbols.symbolset`.
 *
 * All network. Pure helpers are marked.
 */

const SCANNER = 'https://scanner.tradingview.com/america/scan';

/**
 * Index universes, by `symbolset` id. Counts measured 2026-07-29.
 *
 * SPX + IXIC + RUT deduplicates to 4,505 — the union is smaller than the sum
 * because the large caps sit in several at once.
 */
export const UNIVERSES = {
  sp500: { id: 'SYML:SP;SPX', name: 'S&P 500', approx: 503 },
  nasdaq: { id: 'SYML:NASDAQ;IXIC', name: 'Nasdaq Composite', approx: 3381 },
  nasdaq100: { id: 'SYML:NASDAQ;NDX', name: 'Nasdaq 100', approx: 103 },
  russell2000: { id: 'SYML:TVC;RUT', name: 'Russell 2000', approx: 1977 },
};

/** The configured default: S&P 500 + Nasdaq Composite + Russell 2000. */
export const DEFAULT_UNIVERSE = ['sp500', 'nasdaq', 'russell2000'];

/**
 * Liquidity and investability, applied to every screen.
 *
 * Not a preference. A name that cannot be traded at size without moving is one
 * where `trade_cost` eats the edge before it exists, so it is excluded at stage
 * 1 rather than found and then vetoed.
 */
export const LIQUIDITY_FILTER = [
  { left: 'type', operation: 'equal', right: 'stock' },
  { left: 'close', operation: 'greater', right: 10 },
  { left: 'average_volume_10d_calc', operation: 'greater', right: 1_000_000 },
];

/** Columns every screen returns, so the merge and the veto have what they need. */
export const BASE_COLUMNS = [
  'name', 'close', 'change', 'volume', 'average_volume_10d_calc', 'market_cap_basic',
  'Perf.W', 'Perf.1M', 'Perf.3M', 'Perf.6M', 'Perf.Y', 'Perf.YTD',
  'RSI', 'ATR', 'Volatility.D',
  'price_52_week_high', 'price_52_week_low',
  'earnings_release_next_date', 'sector',
];

/**
 * Columns the Tier A factors need, on top of BASE_COLUMNS.
 *
 * These are a CROSS-SECTIONAL sort's inputs, so the scan that fetches them must
 * be broad and barely filtered — a decile computed over a screen's survivors is
 * a decile of an already-selected population, which is not what any of these
 * papers measured.
 */
export const FACTOR_COLUMNS = [
  'name', 'close', 'market_cap_basic',
  'SMA10', 'SMA20', 'SMA50', 'SMA100', 'SMA200',
  'relative_volume_10d_calc', 'average_volume_10d_calc',
  'Perf.W',
];

/**
 * Run one scan.
 *
 * `universe` is a list of UNIVERSES keys; pass null to search all US symbols.
 * Returns rows keyed by column name rather than the raw positional array,
 * because a positional array silently misaligns the moment a column is added.
 */
/**
 * One column for one named ticker, straight from the scanner.
 *
 * Exists for VIX, which is not a stock and so never appears in a universe
 * scan, but which decides whether the short-term reversal factor is active at
 * all. Returns null rather than throwing: `shortTermReversal` treats an unknown
 * VIX as NOT favourable, which is the safe reading, and a screen that dies
 * because an index quote was slow would be a worse outcome than one factor
 * standing down.
 */
export async function tickerQuote(ticker, column = 'close', { timeout_ms = 10_000 } = {}) {
  try {
    const res = await fetch(SCANNER, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbols: { tickers: [ticker], query: { types: [] } }, columns: [column] }),
      signal: AbortSignal.timeout(timeout_ms),
    });
    if (!res.ok) return null;
    const json = await res.json();
    const v = json?.data?.[0]?.d?.[0];
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

export async function scan({
  filter = [],
  columns = BASE_COLUMNS,
  universe = DEFAULT_UNIVERSE,
  sort = { sortBy: 'market_cap_basic', sortOrder: 'desc' },
  range = [0, 200],
  timeout_ms = 20_000,
} = {}) {
  const body = { filter, columns, sort, range, markets: ['america'] };
  if (universe?.length) {
    const ids = universe.map((u) => UNIVERSES[u]?.id).filter(Boolean);
    if (ids.length !== universe.length) {
      throw new Error(`Unknown universe key. Known: ${Object.keys(UNIVERSES).join(', ')}`);
    }
    body.symbols = { symbolset: ids };
  }

  const ctl = AbortSignal.timeout(timeout_ms);
  const res = await fetch(SCANNER, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: ctl,
  });
  if (!res.ok) throw new Error(`Scanner returned HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();

  const rows = (json.data || []).map((d) => {
    const row = { symbol: d.s };
    columns.forEach((c, i) => { row[c] = d.d[i]; });
    return row;
  });
  return {
    total: json.totalCount ?? rows.length,
    returned: rows.length,
    rows,
    universe: universe?.length ? universe.map((u) => UNIVERSES[u].name) : 'all US',
  };
}

/** How many symbols a universe holds, with no other filter. PURE-ish: one request. */
export async function universeSize(universe = DEFAULT_UNIVERSE) {
  const r = await scan({ filter: [], columns: ['name'], universe, range: [0, 1] });
  return r.total;
}

/* --------------------------- pure helpers --------------------------- */

/** Distance below the 52-week high, as a positive percentage. */
export function offHighPct(row) {
  const hi = row['price_52_week_high'], c = row.close;
  if (!(hi > 0) || !(c > 0)) return null;
  return Math.round((1 - c / hi) * 1000) / 10;
}

/**
 * Trading days until the next scheduled earnings.
 *
 * `earnings_release_next_date` is a unix timestamp. Calendar days are used
 * rather than trading days: the veto only needs "is this close", and calendar
 * days never overstate the gap.
 */
export function daysToEarnings(row, now = null) {
  const ts = row['earnings_release_next_date'];
  if (!ts) return null;
  const nowMs = now ?? Date.now();
  return Math.round((ts * 1000 - nowMs) / 86_400_000);
}

/**
 * The premarket move against the last close, if the caller supplies a price.
 *
 * Stage 2 reads a bar that CLOSED YESTERDAY. A company reporting overnight has
 * already moved and no detector can see it, because every one of them is
 * reading a bar from before the news. This is reported so the gap is visible,
 * never as a signal.
 */
export function movedSinceBar(row, live_price, atr = null) {
  if (!(live_price > 0) || !(row.close > 0)) return null;
  const pct = ((live_price - row.close) / row.close) * 100;
  const inAtr = atr > 0 ? Math.abs(live_price - row.close) / atr : null;
  return {
    pct: Math.round(pct * 100) / 100,
    atr_multiple: inAtr == null ? null : Math.round(inAtr * 100) / 100,
    material: inAtr != null ? inAtr >= 0.5 : Math.abs(pct) >= 2,
    note: 'Price has moved since the bar every detector below is reading. Not a signal — a warning '
      + 'that the analysis predates the move.',
  };
}
