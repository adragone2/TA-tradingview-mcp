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
 * ── The same trap, wearing an equity's clothes ──
 *
 * Crypto is not the only hyphen TA writes. A SHARE CLASS is written `BRK-B`, `BF-B`,
 * `MOG-A` — and the hyphen is the same spread operator, so `BRK-B` would not fail
 * either. It would build BRK against whatever `B` resolves to, hand back bars with a
 * price on them, and every level, pattern and stop drawn from that series would be
 * filed under "BRK-B". The only reason this has never fired is that no TA holding is
 * currently a class share; it is latent, not absent.
 *
 * TradingView's own spelling for a share class is the DOT — `NYSE:BRK.B` — so this
 * one is MAPPED rather than excluded: it is an equity, on the equity layer, and it
 * charts correctly the moment it is spelled the way TradingView spells it. The mapped
 * form goes out in `expect` so the caller can check the series it actually loaded is
 * the one it asked for, which is the same guard that catches the crypto spread.
 *
 * Pure.
 */

/** TA writes crypto as `<BASE>-USD`, sometimes with a CoinMarketCap id on the base. */
const CRYPTO_RE = /^([A-Z]+?)(\d+)?-USD$/i;

/**
 * A share class: exactly ONE letter after the hyphen. BRK-B, BF-B, MOG-A.
 *
 * Matched AFTER the crypto test, never before — `ARB11841-USD` has to reach the
 * crypto branch, and a rule this narrow must not get first refusal on a book it
 * does not own.
 */
const CLASS_SHARE_RE = /^([A-Z]{1,5})-([A-Z])$/i;

/**
 * @param {string} taTicker  Whatever TA has in its portfolio or actionable list.
 * @returns {{symbol: string, kind: string, expect: string, chartable: boolean, mapped: boolean, why: string|null}}
 */
export function resolveTaSymbol(taTicker) {
  const raw = String(taTicker || '').trim();
  if (!raw) {
    return { symbol: raw, kind: 'unknown', expect: raw, chartable: false, mapped: false, why: 'empty ticker' };
  }

  // CRYPTO FIRST. `ARB11841-USD` ends in a letter and would otherwise be a
  // candidate for anything matching on a trailing hyphen group; the crypto book
  // is excluded outright, so it must be decided before any mapping is attempted.
  const m = raw.match(CRYPTO_RE);
  if (m) {
    const base = m[1].toUpperCase();
    return {
      symbol: raw,
      kind: 'crypto',
      expect: raw,
      chartable: false,
      mapped: false,
      why: `crypto — TA owns the crypto book on the investing layer; this is the equity trading `
        + `layer. Charting it here is also unsafe: "${raw}" passed to TradingView resolves to the `
        + `SPREAD CRYPTOCAP:${base}-BATS:USD, which returns bars that are not the price of ${base}.`,
    };
  }

  /**
   * Share classes: the crypto trap again, on an instrument this layer DOES trade.
   *
   * The hyphen cannot be passed through. TradingView reads it as the SPREAD
   * operator, so `BRK-B` resolves to BRK against whatever `B` resolves to — it
   * returns bars, it has a price, every detector runs, and the wrong instrument is
   * filed under the right name. It does not fail; it lies, exactly as `BTC-USD`
   * does. The dot is TradingView's own spelling for a class (`NYSE:BRK.B`), so the
   * mapping is a translation rather than a guess, and `expect` carries the mapped
   * form for the caller's identity check.
   */
  const cls = raw.match(CLASS_SHARE_RE);
  if (cls) {
    const base = cls[1].toUpperCase();
    const klass = cls[2].toUpperCase();
    const symbol = `${base}.${klass}`;
    return {
      symbol,
      kind: 'equity',
      expect: symbol,
      chartable: true,
      mapped: true,
      why: `share class — "${raw}" passed to TradingView is read as the SPREAD ${base} minus ${klass}, `
        + `which returns bars that are not ${symbol}. Charted as ${symbol}, TradingView's own dot form `
        + `for a share class.`,
    };
  }

  // Equities and ETFs: TradingView resolves a bare ticker to its primary listing
  // (ANET -> BATS:ANET), which is what every other caller here already relies on.
  //
  // EVERY OTHER HYPHEN FORM FALLS THROUGH HERE UNTOUCHED, deliberately. `ABC-XY` is
  // not a share class — two letters after the hyphen is a preferred series, a unit,
  // or a foreign listing convention, and each of those has its own TradingView
  // spelling. Rewriting it to `ABC.XY` would be inventing a symbol, which is the same
  // class of error as the spread it was trying to avoid. Left as-is it stays a spread
  // risk, and `expect` is what catches it: a spread comes back as a different series,
  // so the caller's identity check fails LOUDLY instead of filing another instrument's
  // bars. Map a form here only once it has been verified on the chart.
  return { symbol: raw, kind: 'equity', expect: raw.replace(/^.*:/, ''), chartable: true, mapped: false, why: null };
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
