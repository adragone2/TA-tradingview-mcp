import { evaluate } from './connection.js';

const DEFAULT_TIMEOUT = 10000;
const POLL_INTERVAL = 200;

/** Strip the exchange prefix: "BITSTAMP:BTCUSD" -> "BTCUSD". */
function bareTicker(s) {
  return String(s || '').toUpperCase().replace(/^.*:/, '').trim();
}

/**
 * True when the chart legend is showing the symbol we asked for.
 *
 * Compared on the bare ticker in both directions. The legend renders the short
 * form ("BTCUSD") while callers routinely pass the fully-qualified symbol that
 * chart.symbol() returns ("BITSTAMP:BTCUSD"). A one-directional `includes`
 * never matched in that case, so every wait ran to its full timeout — 10s of
 * dead time on each set, which is what made watchlist scans crawl.
 */
function symbolMatches(expected, actual) {
  if (!expected) return true;
  if (!actual) return false;
  const a = bareTicker(expected);
  const b = bareTicker(actual);
  return a === b || a.includes(b) || b.includes(a);
}

/** "D" and "1D" are the same resolution; so are "W"/"1W" and "M"/"1M". */
function normalizeResolution(r) {
  const s = String(r ?? '').trim().toUpperCase();
  return /^1[DWM]$/.test(s) ? s.slice(1) : s;
}

function resolutionMatches(expected, actual) {
  if (!expected) return true;
  if (!actual) return false;
  return normalizeResolution(expected) === normalizeResolution(actual);
}

/**
 * Wait until the chart's main series has actually finished loading.
 *
 * This used to gate on a loading spinner plus the size of
 * `document.querySelectorAll('[class*="bar"]')` — which counts toolbars,
 * sidebars and scrollbars, not price bars, and is therefore constant no matter
 * what the data is doing. Sampling the live chart every 25ms through a symbol
 * change showed why that mattered:
 *
 *     t=61ms   chart.symbol() = the NEW symbol, bars = the OLD symbol's prices
 *     t=193ms  symbolInfo()   = the NEW symbol, bars = the OLD symbol's prices
 *     t=581ms  bars finally hold the new symbol
 *
 * So the old check cleared in ~400ms on a DOM count unrelated to the data,
 * while `chart.symbol()` — the thing it compared against — had flipped at 61ms.
 * Callers were told the chart was ready while it still held the previous
 * symbol. The series' own `isLoading()` clears exactly when the bars arrive,
 * which is the only signal here worth reading.
 */
export async function waitForChartReady(expectedSymbol = null, expectedTf = null, timeout = DEFAULT_TIMEOUT) {
  const start = Date.now();

  while (Date.now() - start < timeout) {
    const state = await evaluate(`
      (function() {
        try {
          var c = window.TradingViewApi._activeChartWidgetWV.value();
          var s = c._chartWidget.model().mainSeries();
          var out = {};
          try { out.isLoading = s.isLoading(); } catch (e) { out.isLoading = null; }
          try {
            var sl = s.seriesLoaded;
            if (typeof sl === 'function') sl = sl.call(s);
            out.seriesLoaded = (sl && typeof sl.value === 'function') ? sl.value() : sl;
          } catch (e) { out.seriesLoaded = null; }
          try { var si = s.symbolInfo(); out.currentSymbol = si ? (si.full_name || si.name || null) : null; } catch (e) { out.currentSymbol = null; }
          try { out.currentResolution = c.resolution(); } catch (e) { out.currentResolution = null; }
          try { out.barCount = s.bars().size(); } catch (e) { out.barCount = 0; }
          out.settled = out.isLoading === false && out.seriesLoaded === true && !!out.currentSymbol && out.barCount > 0;
          return out;
        } catch (e) { return null; }
      })()
    `);

    if (state && state.settled
        && symbolMatches(expectedSymbol, state.currentSymbol)
        && resolutionMatches(expectedTf, state.currentResolution)) {
      return true;
    }

    await new Promise(r => setTimeout(r, POLL_INTERVAL));
  }

  // Timed out. Callers report this as chart_ready:false; the bar read gates
  // itself independently, so a false here delays work rather than corrupting it.
  return false;
}
