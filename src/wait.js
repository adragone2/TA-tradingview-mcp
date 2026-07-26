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

export async function waitForChartReady(expectedSymbol = null, expectedTf = null, timeout = DEFAULT_TIMEOUT) {
  const start = Date.now();
  let lastBarCount = -1;
  let stableCount = 0;

  while (Date.now() - start < timeout) {
    const state = await evaluate(`
      (function() {
        // Check for loading spinner
        var spinner = document.querySelector('[class*="loader"]')
          || document.querySelector('[class*="loading"]')
          || document.querySelector('[data-name="loading"]');
        var isLoading = spinner && spinner.offsetParent !== null;

        // Try to get bar count from data window or chart
        var barCount = -1;
        try {
          var bars = document.querySelectorAll('[class*="bar"]');
          barCount = bars.length;
        } catch {}

        // Get current symbol from header
        var symbolEl = document.querySelector('[data-name="legend-source-title"]')
          || document.querySelector('[class*="title"] [class*="apply-common-tooltip"]');
        var currentSymbol = symbolEl ? symbolEl.textContent.trim() : '';

        // Prefer the chart API for symbol/resolution — the legend is a rendering
        // detail and shows the short form, while the API is authoritative.
        var currentResolution = null;
        try {
          var c = window.TradingViewApi._activeChartWidgetWV.value();
          currentSymbol = c.symbol() || currentSymbol;
          currentResolution = c.resolution();
        } catch (e) { /* fall back to the legend text */ }

        return { isLoading: !!isLoading, barCount: barCount, currentSymbol: currentSymbol, currentResolution: currentResolution };
      })()
    `);

    if (!state) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL));
      continue;
    }

    // Not ready if still loading
    if (state.isLoading) {
      stableCount = 0;
      await new Promise(r => setTimeout(r, POLL_INTERVAL));
      continue;
    }

    // Check symbol match if expected
    if (state.currentSymbol && !symbolMatches(expectedSymbol, state.currentSymbol)) {
      stableCount = 0;
      await new Promise(r => setTimeout(r, POLL_INTERVAL));
      continue;
    }

    // Check resolution match if expected. expectedTf was previously accepted
    // and silently ignored, so setTimeframe only ever waited on bar stability.
    if (expectedTf && state.currentResolution
        && String(state.currentResolution) !== String(expectedTf)) {
      stableCount = 0;
      await new Promise(r => setTimeout(r, POLL_INTERVAL));
      continue;
    }

    // Check bar count stability
    if (state.barCount === lastBarCount && state.barCount > 0) {
      stableCount++;
    } else {
      stableCount = 0;
    }
    lastBarCount = state.barCount;

    if (stableCount >= 2) {
      return true;
    }

    await new Promise(r => setTimeout(r, POLL_INTERVAL));
  }

  // Timeout — return true anyway, caller should verify
  return false;
}
