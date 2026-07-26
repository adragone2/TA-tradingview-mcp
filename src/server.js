import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerHealthTools } from "./tools/health.js";
import { registerDoctorTools } from "./tools/doctor.js";
import { registerTaApiTools } from "./tools/ta_api.js";
import { registerTaWallsTools } from "./tools/ta_walls.js";
import { registerWatchlistSyncTools } from "./tools/watchlist_sync.js";
import { registerTaDecisionTools } from "./tools/ta_decisions.js";
import { registerPositionToolTools } from "./tools/position_tool.js";
import { registerChartTools } from "./tools/chart.js";
import { registerPineTools } from "./tools/pine.js";
import { registerDataTools } from "./tools/data.js";
import { registerCaptureTools } from "./tools/capture.js";
import { registerDrawingTools } from "./tools/drawing.js";
import { registerAlertTools } from "./tools/alerts.js";
import { registerBatchTools } from "./tools/batch.js";
import { registerReplayTools } from "./tools/replay.js";
import { registerIndicatorTools } from "./tools/indicators.js";
import { registerWatchlistTools } from "./tools/watchlist.js";
import { registerUiTools } from "./tools/ui.js";
import { registerPaneTools } from "./tools/pane.js";
import { registerTabTools } from "./tools/tab.js";
import { registerMorningTools } from "./tools/morning.js";

const server = new McpServer(
  {
    name: "tradingview",
    version: "2.0.0",
    description:
      "AI-assisted TradingView chart analysis and Pine Script development via Chrome DevTools Protocol",
  },
  {
    instructions: `TradingView MCP — 111 tools. A live TradingView Desktop chart, plus the
Tactical Alpha (TA) API for the investing context a chart cannot show.

FIRST: read docs/START-HERE.md in this repo. It is the entry point and explains
the layers, the daily routines, and which tool answers which question. This
block is only a summary.

THE LAYERS — do not confuse them:
- TradingView MCP (here): charts, levels, entries, drawings. TRADING.
- Tactical Alpha via ta_* tools: portfolio, earnings, regime, walls. INVESTING,
  and the master system. It holds the databases and watchlists.
- WRDS (separate wrds-mcp server): historical research and signal validation.
  Not real time — CRSP daily ends 2024.

WHEN ANYTHING IS BROKEN: tv_doctor first. It checks every precondition and each
failing check carries the exact command to fix it.

TOOL SELECTION GUIDE — use this to pick the right tool:

Reading your chart:
- chart_get_state → get symbol, timeframe, all indicator names + entity IDs (call first)
- data_get_study_values → get current numeric values from ALL visible indicators (RSI, MACD, BB, EMA, etc.)
- quote_get → get real-time price snapshot (last, OHLC, volume)
- data_get_ohlcv → get price bars. ALWAYS pass summary=true unless you need individual bars

Reading custom Pine indicator output (line.new/label.new/table.new/box.new drawings):
- data_get_pine_lines → horizontal price levels from custom indicators (deduplicated, sorted)
- data_get_pine_labels → text annotations with prices ("PDH 24550", "Bias Long", etc.)
- data_get_pine_tables → table data as formatted rows (session stats, analytics dashboards)
- data_get_pine_boxes → price zones as {high, low} pairs
- ALWAYS pass study_filter to target a specific indicator by name (e.g., study_filter="Profiler")
- Indicators must be VISIBLE on chart for these to work

Changing the chart:
- chart_set_symbol, chart_set_timeframe, chart_set_type → change ticker/resolution/style
- chart_manage_indicator → add/remove studies. USE FULL NAMES: "Relative Strength Index" not "RSI"
- chart_scroll_to_date → jump to a date (ISO format)
- indicator_set_inputs → change indicator settings (length, source, etc.)

Pine Script development:
- pine_set_source → inject code, pine_smart_compile → compile + check errors
- pine_get_errors → read errors, pine_get_console → read log output
- WARNING: pine_get_source can return 200KB+ for complex scripts — avoid unless editing

Marking up a trade:
- draw_trade_plan → entry/stop/targets/break-even in ONE call, colour-coded,
  returns R:R per target. Never hand-build a plan from several draw_shape calls.
- draw_shape → single shapes. point.price required; point.time optional and
  accepts "now", "last_bar", or an ISO date.
- draw_list (include_points:true) → read back what is drawn, including a trade
  the user drew by hand. Each entry is flagged created_by_mcp.
- draw_clear → defaults to scope "mcp": removes ONLY what these tools drew.
  NEVER pass scope:"all" without asking — it deletes the user's own drawings.
- position_draw → TradingView's native Long/Short Position tool: draggable,
  with sizing TradingView recomputes live. Use for a single-target plan the
  user will adjust; draw_trade_plan for multiple targets and partials.
- position_read → read a position tool the user drew BY HAND as plain prices.
  Levels are stored as tick offsets, so they are unreadable without this.
- position_size → how much to buy for a given account and risk, from the
  levels already on the chart.

Gamma walls (TA → the Institutional Matrix indicator):
- walls_coverage → which tickers TA has walls for (~44, equities and ETFs)
- walls_apply → write TA walls into the Institutional Matrix indicator (needs
  the TA-Trading layout; keeps the LAST symbol applied)
- walls_draw → same data as native chart lines; works on any layout, readable
  back via draw_list, cleared by group
- Requires the TA-Trading layout. Check age_hours: past ~30h on a trading day
  TA's scan did not run, and the levels are stale positioning.

Trading decisions from TA — walls, gamma, entry, exit are the TRADING layer:
- ta_actionable → what TA flags right now: exits by urgency, entries by score.
  Start a trading session here. CRITICAL exits are positions past their stop.
- ta_entry / ta_exit → one symbol's decision, with the levels behind it
- ta_draw_decision → draw those levels on the chart, grouped and colour-coded
- walls_apply → gamma walls into the Institutional Matrix indicator
These are TA's decisions. Report them as TA's output, not as your own call.

Investing context from TA (portfolio-level, NOT trade selection):
- ta_trading_context → for given tickers: do I already hold this, does it report
  soon, what regime are we in. Call BEFORE acting on a chart setup.
- ta_portfolio, ta_earnings, ta_regime, ta_alerts, ta_get (any endpoint)
- ta_regime carries position sizing (max_new_position_pct, position_multiplier)

Morning routine: morning_brief → grade against rules.json → session_save.
  KEY LEVEL must come from the data returned, never invented.
Setup/config: tv_doctor, rules_init, rules_status
Screenshots: capture_screenshot → regions: "full", "chart", "strategy_tester"
Replay: replay_start → replay_step → replay_trade → replay_status → replay_stop
  Pass an explicit recent date; the default first-available date can wedge the chart.
Batch: batch_run → run action across multiple symbols/timeframes, restores the chart
Alerts: alert_list, alert_create, alert_delete
  alert_create makes a REAL alert that can fire. Check the price is on the
  correct side of spot. alert_delete needs explicit alert_ids.
Launch: tv_launch → auto-detect and start TradingView with CDP on any platform
Panes: pane_list, pane_set_layout (s, 2h, 2v, 4, 6, 8), pane_focus, pane_set_symbol
Layouts: layout_list, layout_switch ("TA-Trading" has the Institutional Matrix)
Watchlist: watchlist_read (sections), watchlist_sync_plan, watchlist_sync
  Sync from TA is ADDITIVE ONLY — never removes. Plan before applying.
Tabs: tab_list, tab_switch. tab_new/tab_close do NOT work on TradingView Desktop —
  the tab strip is application chrome that CDP input cannot reach.

CONTEXT MANAGEMENT:
- ALWAYS use summary=true on data_get_ohlcv
- ALWAYS use study_filter on pine tools when you know which indicator you want
- NEVER use verbose=true unless user specifically asks for raw data
- Prefer capture_screenshot for visual context over pulling large datasets
- Call chart_get_state ONCE at start, reuse entity IDs

HONESTY RULES — these exist because tools here have historically claimed success
while doing nothing:
- Report what a tool actually returned. If it reports a warning or a partial
  result, say so rather than summarising it as success.
- Never state a price level that did not come from the data. If nothing supports
  it, say n/a.
- Freshness is not implied by a successful call. TA stamps age on its responses;
  read it and say how old the data is.
- These tools drive the user's live chart and can create real alerts. Confirm
  before anything destructive or account-visible.
- Nothing here is trade advice. It renders the user's own criteria and TA's own
  output; present it as context, not as a recommendation.`,
  },
);

// Register all tool groups
registerHealthTools(server);
registerDoctorTools(server);
registerTaApiTools(server);
registerTaWallsTools(server);
registerWatchlistSyncTools(server);
registerTaDecisionTools(server);
registerPositionToolTools(server);
registerChartTools(server);
registerPineTools(server);
registerDataTools(server);
registerCaptureTools(server);
registerDrawingTools(server);
registerAlertTools(server);
registerBatchTools(server);
registerReplayTools(server);
registerIndicatorTools(server);
registerWatchlistTools(server);
registerUiTools(server);
registerPaneTools(server);
registerTabTools(server);
registerMorningTools(server);

// Startup notice (stderr so it doesn't interfere with MCP stdio protocol)
process.stderr.write(
  "⚠  tradingview-mcp  |  Unofficial tool. Not affiliated with TradingView Inc. or Anthropic.\n",
);
process.stderr.write(
  "   Ensure your usage complies with TradingView's Terms of Use.\n\n",
);

// Start stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
