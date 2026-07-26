/**
 * Morning brief core logic.
 *
 * Scans a watchlist and returns structured per-symbol data for Claude to grade
 * against the user's own rules.
 *
 * Design notes:
 *  - Scanning necessarily drives the live chart (there is no way to pull another
 *    symbol's studies without loading it), so the caller's symbol/timeframe are
 *    always restored, including when the scan throws part-way through.
 *  - Readiness is polled against the chart API rather than slept on. Fixed
 *    sleeps were both slower and less reliable: 1.8s per symbol regardless of
 *    whether the data had arrived.
 *  - Key levels come from real data (OHLCV summary + any levels drawn by Pine
 *    indicators), so a brief citing "KEY LEVEL: 94,200" is grounded in
 *    something rather than invented.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { evaluate, KNOWN_PATHS } from "../connection.js";
import * as chart from "./chart.js";
import * as data from "./data.js";
import * as watchlistApi from "./watchlist.js";
import { resolveRules } from "./rules.js";

const SESSIONS_DIR = join(homedir(), ".tradingview-mcp", "sessions");

// Guard against a 200-symbol watchlist turning into a 20-minute chart takeover.
const DEFAULT_MAX_SYMBOLS = 25;
const READY_TIMEOUT_MS = 12000;
const READY_POLL_MS = 150;

function normalizeTicker(s) {
  return String(s || "").toUpperCase().replace(/^.*:/, "").trim();
}

/**
 * Wait until the chart is actually showing `symbol` with bars loaded.
 * Returns { ready, waited_ms, bars, symbol }.
 */
async function waitForChart(symbol, timeoutMs = READY_TIMEOUT_MS) {
  const started = Date.now();
  let lastCount = -1;
  let stable = 0;

  while (Date.now() - started < timeoutMs) {
    const snap = await evaluate(`
      (function() {
        var out = { symbol: null, bars: -1 };
        try {
          var c = ${KNOWN_PATHS.chartApi};
          out.symbol = c.symbol();
        } catch(e) { return out; }
        try {
          var b = ${KNOWN_PATHS.mainSeriesBars};
          out.bars = (b && typeof b.size === 'function') ? b.size() : -1;
        } catch(e) {}
        return out;
      })()
    `).catch(() => null);

    if (snap && snap.bars > 0) {
      const symbolOk = !symbol
        || normalizeTicker(snap.symbol) === normalizeTicker(symbol)
        || String(snap.symbol || "").toUpperCase().includes(String(symbol).toUpperCase());

      if (symbolOk) {
        // Two identical bar counts in a row means the feed has settled.
        stable = snap.bars === lastCount ? stable + 1 : 0;
        lastCount = snap.bars;
        if (stable >= 1) {
          return { ready: true, waited_ms: Date.now() - started, bars: snap.bars, symbol: snap.symbol };
        }
      } else {
        stable = 0;
      }
    }

    await new Promise((r) => setTimeout(r, READY_POLL_MS));
  }

  return { ready: false, waited_ms: Date.now() - started, bars: lastCount, symbol: null };
}

/**
 * Decide which symbols to scan.
 * Explicit argument wins, then rules.json, then the watchlist open in
 * TradingView — so a first run works with no configuration at all.
 */
async function resolveWatchlist(explicit, rulesWatchlist) {
  if (Array.isArray(explicit) && explicit.length) {
    return { symbols: explicit, source: "argument" };
  }
  if (Array.isArray(rulesWatchlist) && rulesWatchlist.length) {
    return { symbols: rulesWatchlist, source: "rules.json" };
  }

  let live = [];
  let liveError = null;
  try {
    const wl = await watchlistApi.get();
    live = (wl.symbols || []).map((s) => s.symbol).filter(Boolean);
  } catch (err) {
    liveError = err.message;
  }
  if (live.length) return { symbols: live, source: "tradingview_watchlist" };

  throw new Error(
    [
      "No symbols to scan.",
      'Add a "watchlist" array to rules.json (run "tv rules init" to create one),',
      "or open the watchlist panel in TradingView so it can be read from the chart.",
      liveError ? `Watchlist read failed: ${liveError}` : null,
    ].filter(Boolean).join(" "),
  );
}

function resolveTimeframes(explicit, rules) {
  if (Array.isArray(explicit) && explicit.length) return explicit.map(String);
  if (Array.isArray(rules.timeframes) && rules.timeframes.length) return rules.timeframes.map(String);
  return [String(rules.default_timeframe || "240")];
}

/** Read everything worth knowing about the symbol currently on the chart. */
async function readCurrentTimeframe({ timeframe, include_levels }) {
  const out = { timeframe };

  const [state, indicators, ohlcv] = await Promise.all([
    chart.getState().catch((e) => ({ error: e.message })),
    data.getStudyValues().catch((e) => ({ error: e.message })),
    data.getOhlcv({ summary: true, count: 100 }).catch((e) => ({ error: e.message })),
  ]);

  out.indicators = indicators;
  out.price_action = ohlcv;
  if (state && !state.error) {
    out.studies = (state.studies || state.indicators || []).map?.((s) => s.name || s) ?? undefined;
  }

  if (include_levels) {
    // Levels drawn by Pine indicators are invisible to the normal data tools,
    // and are usually where a user's real support/resistance lives.
    const [lines, labels] = await Promise.all([
      data.getPineLines({}).catch(() => null),
      data.getPineLabels({ max_labels: 15 }).catch(() => null),
    ]);
    const levels = lines?.levels || lines?.lines || null;
    if (levels && (!Array.isArray(levels) || levels.length)) out.drawn_levels = levels;
    const lbls = labels?.labels || null;
    if (lbls && (!Array.isArray(lbls) || lbls.length)) out.drawn_labels = lbls;
  }

  return out;
}

export async function runBrief({
  rules_path,
  symbols: symbolsArg,
  timeframes: timeframesArg,
  include_levels = true,
  max_symbols,
} = {}) {
  const resolved = resolveRules(rules_path);
  const { rules, path: loadedFrom, using_defaults } = resolved;

  const { symbols: allSymbols, source: watchlist_source } = await resolveWatchlist(
    symbolsArg, rules.watchlist,
  );
  const timeframes = resolveTimeframes(timeframesArg, rules);

  const cap = Number(max_symbols ?? rules.max_symbols ?? DEFAULT_MAX_SYMBOLS);
  const watchlist = allSymbols.slice(0, cap);
  const skipped = allSymbols.slice(cap);

  // Remember where the user was so the chart can be handed back unchanged.
  let originalSymbol = null;
  let originalTimeframe = null;
  try {
    const current = await chart.getState();
    originalSymbol = current.symbol;
    originalTimeframe = current.resolution;
  } catch { /* restore becomes best-effort */ }

  const results = [];
  const startedAt = Date.now();

  try {
    for (const symbol of watchlist) {
      const entry = { symbol, timeframes: [] };
      try {
        await chart.setSymbol({ symbol });
        const ready = await waitForChart(symbol);
        if (!ready.ready) {
          entry.warning = `Chart did not settle on ${symbol} within ${READY_TIMEOUT_MS}ms — readings may be stale or from the previous symbol.`;
        }
        entry.resolved_symbol = ready.symbol || symbol;
        entry.quote = await data.getQuote({}).catch((e) => ({ error: e.message }));

        for (const timeframe of timeframes) {
          await chart.setTimeframe({ timeframe });
          const tfReady = await waitForChart(symbol);
          const tf = await readCurrentTimeframe({ timeframe, include_levels });
          if (!tfReady.ready) tf.warning = "timeframe did not settle; readings may be stale";
          entry.timeframes.push(tf);
        }
      } catch (err) {
        entry.error = err.message;
      }
      results.push(entry);
    }
  } finally {
    // Always hand the chart back, even if the scan threw.
    if (originalSymbol) {
      try {
        await chart.setSymbol({ symbol: originalSymbol });
        if (originalTimeframe) await chart.setTimeframe({ timeframe: originalTimeframe });
        await waitForChart(originalSymbol, 6000);
      } catch { /* nothing more we can do */ }
    }
  }

  const failed = results.filter((r) => r.error).map((r) => r.symbol);

  return {
    success: true,
    generated_at: new Date().toISOString(),
    scan_seconds: Math.round((Date.now() - startedAt) / 100) / 10,
    rules_loaded_from: loadedFrom,
    using_defaults,
    ...(resolved.warning ? { warning: resolved.warning } : {}),
    watchlist_source,
    timeframes,
    symbols_requested: allSymbols.length,
    symbols_scanned_count: results.length,
    ...(skipped.length
      ? { skipped_symbols: skipped, skipped_note: `Capped at ${cap} symbols. Pass max_symbols to raise it.` }
      : {}),
    ...(failed.length ? { failed_symbols: failed } : {}),
    chart_restored_to: originalSymbol
      ? { symbol: originalSymbol, timeframe: originalTimeframe }
      : null,
    rules: {
      bias_criteria: rules.bias_criteria || null,
      risk_rules: rules.risk_rules || null,
      notes: rules.notes || null,
    },
    symbols_scanned: results,
    instruction: [
      using_defaults
        ? "NOTE: no rules.json was found, so bias_criteria are generic defaults, not the user's own. Say so in one line at the end and mention `tv rules init`."
        : null,
      "Grade each symbol in symbols_scanned against rules.bias_criteria using its indicator readings across every timeframe present.",
      timeframes.length > 1
        ? `Timeframes are ordered ${timeframes.join(" then ")} — treat the first as the higher-level bias and later ones as timing. Call out disagreement between them explicitly.`
        : null,
      "KEY LEVEL must come from the data provided: drawn_levels, drawn_labels, or the high/low in price_action. If none supports a level, write KEY LEVEL: n/a rather than inventing a number.",
      "Output one line per symbol: SYMBOL | BIAS: [bullish/bearish/neutral] | KEY LEVEL: [price or n/a] | WATCH: [what to monitor]",
      "Then group the symbols into tiers: A (criteria clearly met, worth attention today), B (partial or needs confirmation), C (no setup — list names only).",
      "End with a one-sentence overall market read.",
      "If a symbol carries an error or warning field, say its reading is unreliable instead of grading it.",
      "Be direct. No preamble. This is analysis against the user's own criteria, not trade advice.",
    ].filter(Boolean).join(" "),
  };
}

export function saveSession({ brief, date } = {}) {
  mkdirSync(SESSIONS_DIR, { recursive: true });

  const dateStr = date || new Date().toISOString().split("T")[0];
  const filePath = join(SESSIONS_DIR, `${dateStr}.json`);

  const existing = existsSync(filePath)
    ? JSON.parse(readFileSync(filePath, "utf8"))
    : {};
  const record = {
    ...existing,
    date: dateStr,
    saved_at: new Date().toISOString(),
    brief,
  };

  writeFileSync(filePath, JSON.stringify(record, null, 2));
  return { success: true, path: filePath, date: dateStr };
}

export function getSession({ date } = {}) {
  const dateStr = date || new Date().toISOString().split("T")[0];
  const filePath = join(SESSIONS_DIR, `${dateStr}.json`);

  if (existsSync(filePath)) {
    return { success: true, ...JSON.parse(readFileSync(filePath, "utf8")) };
  }

  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().split("T")[0];
  const yesterdayPath = join(SESSIONS_DIR, `${yesterdayStr}.json`);

  if (existsSync(yesterdayPath)) {
    return {
      success: true,
      note: "No session for today — returning yesterday",
      ...JSON.parse(readFileSync(yesterdayPath, "utf8")),
    };
  }

  return {
    success: false,
    error: `No session found for ${dateStr} or ${yesterdayStr}`,
    sessions_dir: SESSIONS_DIR,
  };
}
