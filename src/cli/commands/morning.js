import { register } from "../router.js";
import * as core from "../../core/morning.js";

register("brief", {
  description:
    "Run your morning brief — scan watchlist across timeframes, read indicators and levels",
  options: {
    rules: {
      type: "string",
      short: "r",
      description: "Path to rules.json (default: ./rules.json)",
    },
    symbols: {
      type: "string",
      short: "s",
      description: "Comma-separated symbols to scan instead of your watchlist",
    },
    timeframes: {
      type: "string",
      short: "t",
      description: 'Comma-separated timeframes, highest first (e.g. "240,60")',
    },
    "no-levels": {
      type: "boolean",
      description: "Skip Pine-drawn levels for a faster, smaller scan",
    },
    max: {
      type: "string",
      description: "Max symbols to scan (default 25)",
    },
  },
  handler: async (opts) => {
    const split = (v) =>
      v ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined;
    return core.runBrief({
      rules_path: opts.rules,
      symbols: split(opts.symbols),
      timeframes: split(opts.timeframes),
      include_levels: !opts["no-levels"],
      max_symbols: opts.max === undefined ? undefined : Number(opts.max),
    });
  },
});

register("session", {
  description: "Get or save a session brief",
  subcommands: new Map([
    [
      "get",
      {
        description:
          "Get today's saved session brief (or yesterday's if today not found)",
        options: {
          date: {
            type: "string",
            description: "Date YYYY-MM-DD (default: today)",
          },
        },
        handler: async ({ date }) => core.getSession({ date }),
      },
    ],
    [
      "save",
      {
        description: "Save a session brief to disk",
        options: {
          brief: {
            type: "string",
            short: "b",
            description: "Brief text to save",
          },
          date: {
            type: "string",
            description: "Date YYYY-MM-DD (default: today)",
          },
        },
        handler: async ({ brief, date }) => {
          if (!brief) throw new Error("--brief is required");
          return core.saveSession({ brief, date });
        },
      },
    ],
  ]),
});
