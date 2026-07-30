/**
 * Which of TA's portfolio tickers this toolchain can chart, and which it cannot.
 *
 * ── The trap, and why this is not a string concat ──
 *
 * TA's book holds crypto as `BTC-USD`, `SOL-USD`, `ARB11841-USD`. Handing those
 * straight to the chart does NOT fail — which is the dangerous part. Measured live:
 *
 *   BTC-USD   ->  CRYPTOCAP:BTC-BATS:USD    300 bars
 *   ETH-USD   ->  CRYPTOCAP:ETH-BATS:USD    300 bars
 *   USDC-USD  ->  CRYPTOCAP:USDC-BATS:USD   300 bars
 *
 * TradingView reads the hyphen as a SPREAD operator and silently builds a synthetic
 * series — CRYPTOCAP's market-cap feed for BTC against a dollar quote. It returns
 * bars, it has a price, every detector runs on it, and the result would be filed
 * under "BTC". It is not the Bitcoin chart and never was. It does not fail; it lies.
 *
 * ── The decision ──
 *
 * Crypto is EXCLUDED from the chart review. The owner's call, and it is the right
 * one: this is the TRADING layer, built for US equities. TA is the investing layer
 * and owns the crypto book — the positions are real and tracked there, they are just
 * not analysed here.
 *
 * The exclusion is recorded per ticker with its reason, so a name absent from the
 * review is explained rather than missing. That distinction is the whole point:
 * "not analysed, and here is why" is a fact; a silently shorter list is a bug.
 *
 * Pure.
 */

/** TA writes crypto as `<BASE>-USD`, sometimes with a CoinMarketCap id on the base. */
const CRYPTO_RE = /^([A-Z]+?)(\d+)?-USD$/i;

/**
 * @param {string} taTicker  Whatever TA has in its portfolio or actionable list.
 * @returns {{symbol: string, kind: string, expect: string, chartable: boolean, why: string|null}}
 */
export function resolveTaSymbol(taTicker) {
  const raw = String(taTicker || '').trim();
  if (!raw) {
    return { symbol: raw, kind: 'unknown', expect: raw, chartable: false, why: 'empty ticker' };
  }

  const m = raw.match(CRYPTO_RE);
  if (m) {
    const base = m[1].toUpperCase();
    return {
      symbol: raw,
      kind: 'crypto',
      expect: raw,
      chartable: false,
      why: `crypto — TA owns the crypto book on the investing layer; this is the equity trading `
        + `layer. Charting it here is also unsafe: "${raw}" passed to TradingView resolves to the `
        + `SPREAD CRYPTOCAP:${base}-BATS:USD, which returns bars that are not the price of ${base}.`,
    };
  }

  // Equities and ETFs: TradingView resolves a bare ticker to its primary listing
  // (ANET -> BATS:ANET), which is what every other caller here already relies on.
  return { symbol: raw, kind: 'equity', expect: raw.replace(/^.*:/, ''), chartable: true, why: null };
}

/** Split a list of TA tickers into the ones this layer charts and the ones it does not. */
export function partitionTaTickers(tickers = []) {
  const chartable = [];
  const excluded = [];
  for (const t of tickers) {
    const r = resolveTaSymbol(t);
    (r.chartable ? chartable : excluded).push({ ticker: t, ...r });
  }
  return { chartable, excluded };
}
