/**
 * Morning brief core logic.
 * Reads rules.json, scans watchlist symbols, returns structured data
 * for Claude to apply bias criteria and generate a session brief.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as chart from "./chart.js";
import * as data from "./data.js";
import * as watchlistApi from "./watchlist.js";
import { resolveRules } from "./rules.js";

const SESSIONS_DIR = join(homedir(), ".tradingview-mcp", "sessions");

/**
 * Decide which symbols to scan.
 * rules.json watchlist wins; otherwise fall back to the watchlist actually
 * open in TradingView so a first run works with no configuration at all.
 */
async function resolveWatchlist(rulesWatchlist) {
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
    ]
      .filter(Boolean)
      .join(" "),
  );
}

export async function runBrief({ rules_path } = {}) {
  const resolved = resolveRules(rules_path);
  const { rules, path: loadedFrom, using_defaults } = resolved;
  const { default_timeframe = "240" } = rules;

  const { symbols: watchlist, source: watchlist_source } = await resolveWatchlist(
    rules.watchlist,
  );

  // Save current chart state so we can restore after scanning
  let originalSymbol, originalTimeframe;
  try {
    const currentState = await chart.getState();
    originalSymbol = currentState.symbol;
    originalTimeframe = currentState.resolution;
  } catch (_) {}

  const results = [];

  for (const symbol of watchlist) {
    try {
      await chart.setSymbol({ symbol });
      await new Promise((r) => setTimeout(r, 900));
      await chart.setTimeframe({ timeframe: default_timeframe });
      await new Promise((r) => setTimeout(r, 900));

      const [state, indicators, quote] = await Promise.all([
        chart.getState(),
        data.getStudyValues(),
        data.getQuote({}),
      ]);

      results.push({
        symbol,
        timeframe: default_timeframe,
        state,
        indicators,
        quote,
      });
    } catch (err) {
      results.push({ symbol, error: err.message });
    }
  }

  // Restore original chart state
  if (originalSymbol) {
    try {
      await chart.setSymbol({ symbol: originalSymbol });
      if (originalTimeframe)
        await chart.setTimeframe({ timeframe: originalTimeframe });
    } catch (_) {}
  }

  return {
    success: true,
    generated_at: new Date().toISOString(),
    rules_loaded_from: loadedFrom,
    using_defaults,
    ...(resolved.warning ? { warning: resolved.warning } : {}),
    watchlist_source,
    rules: {
      bias_criteria: rules.bias_criteria || null,
      risk_rules: rules.risk_rules || null,
      notes: rules.notes || null,
    },
    symbols_scanned: results,
    instruction: [
      using_defaults
        ? "NOTE: no rules.json was found, so these are generic bias criteria, not the user's own. Say so in one short line at the end and mention `tv rules init`."
        : null,
      "For each symbol in symbols_scanned, apply the bias_criteria from rules to the indicator readings.",
      "Output one line per symbol: SYMBOL | BIAS: [bullish/bearish/neutral] | KEY LEVEL: [price] | WATCH: [what to monitor]",
      "End with a one-sentence overall market read.",
      "Be direct. No preamble.",
    ]
      .filter(Boolean)
      .join(" "),
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

  // Fall back to yesterday
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
