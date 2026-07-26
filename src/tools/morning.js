import { z } from "zod";
import { jsonResult } from "./_format.js";
import * as core from "../core/morning.js";

export function registerMorningTools(server) {
  server.tool(
    "morning_brief",
    "Scan a watchlist across one or more timeframes and return structured per-symbol data for a session brief: indicator readings, a price-action summary, and any levels drawn by Pine indicators. Uses rules.json for bias criteria, watchlist and timeframes when present; otherwise falls back to the watchlist open in TradingView. Drives the live chart while scanning and restores the user's symbol and timeframe afterwards.",
    {
      rules_path: z
        .string()
        .optional()
        .describe(
          "Optional path to rules.json. Defaults to rules.json in the project root.",
        ),
      symbols: z
        .array(z.string())
        .optional()
        .describe("Scan these symbols instead of the watchlist in rules.json."),
      timeframes: z
        .array(z.string())
        .optional()
        .describe(
          'Timeframes to read per symbol, highest first (e.g. ["240","60"]). Defaults to rules.timeframes, then rules.default_timeframe.',
        ),
      include_levels: z
        .coerce.boolean()
        .optional()
        .describe(
          "Include levels and labels drawn by Pine indicators (default true). Set false for a faster, smaller scan.",
        ),
      max_symbols: z
        .coerce.number()
        .optional()
        .describe("Cap how many symbols are scanned (default 25). Skipped symbols are reported."),
    },
    async ({ rules_path, symbols, timeframes, include_levels, max_symbols } = {}) => {
      try {
        return jsonResult(
          await core.runBrief({ rules_path, symbols, timeframes, include_levels, max_symbols }),
        );
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    },
  );

  server.tool(
    "session_save",
    "Save today's morning brief to ~/.tradingview-mcp/sessions/YYYY-MM-DD.json for future reference.",
    {
      brief: z
        .string()
        .describe(
          "The brief text to save (output from morning_brief after Claude applies the rules).",
        ),
      date: z
        .string()
        .optional()
        .describe("Date string YYYY-MM-DD. Defaults to today."),
    },
    async ({ brief, date } = {}) => {
      try {
        return jsonResult(core.saveSession({ brief, date }));
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    },
  );

  server.tool(
    "session_get",
    "Retrieve a saved session brief. Returns today's if available, otherwise yesterday's.",
    {
      date: z
        .string()
        .optional()
        .describe("Date string YYYY-MM-DD. Defaults to today."),
    },
    async ({ date } = {}) => {
      try {
        return jsonResult(core.getSession({ date }));
      } catch (err) {
        return jsonResult({ success: false, error: err.message }, true);
      }
    },
  );
}
