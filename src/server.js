import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerHealthTools } from "./tools/health.js";
import { registerDoctorTools } from "./tools/doctor.js";
import { registerTaApiTools } from "./tools/ta_api.js";
import { registerTaWallsTools } from "./tools/ta_walls.js";
import { registerWatchlistSyncTools } from "./tools/watchlist_sync.js";
import { registerTaDecisionTools } from "./tools/ta_decisions.js";
import { registerPositionToolTools } from "./tools/position_tool.js";
import { registerStructureTools } from "./tools/structure.js";
import { registerBacktestTools } from "./tools/backtest.js";
import { registerStrategyTools } from "./tools/strategy.js";
import { registerPatternTools } from "./tools/patterns.js";
import { registerBreakoutTools } from "./tools/breakout.js";
import { registerContextTools } from "./tools/context.js";
import { registerWyckoffTools } from "./tools/wyckoff.js";
import { registerLiquidityTools } from "./tools/liquidity.js";
import { registerZoneTools } from "./tools/zones.js";
import { registerRiskTools } from "./tools/risk.js";
import { registerElliottTools } from "./tools/elliott.js";
import { registerDivergenceTools } from "./tools/divergence.js";
import { registerCostTools } from "./tools/costs.js";
import { registerMtfTools } from "./tools/mtf.js";
import { registerRelativeTools } from "./tools/relative.js";
import { registerExportTools } from "./tools/export.js";
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
    instructions: `TradingView MCP — 157 tools. A live TradingView Desktop chart, plus the
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

Structure and levels — computed from the bars, never eyeballed:
- structure_analyze → swing highs/lows labelled HH/HL/LH/LL, trend, BOS, CHoCH.
  Use this before describing a trend. Do not read structure off a screenshot.
- levels_find → support/resistance with the EVIDENCE for each: separate tests,
  swings formed, volume traded there, round numbers. Wide clusters come back
  as zones, not lines.
- levels_draw → draws them, labelled with that evidence, grouped for clearing.
- Quote a level's reason when you report it. A level without evidence is a
  guess with a price attached, and looks identical once drawn.

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

Strategies — criteria as DATA, so they can be scanned and tested:
- strategy_list → what is defined in rules.json, and whether it validates
- strategy_check → evaluate one against the chart, showing the ACTUAL value
  on each side of every comparison
- strategy_scan → check it across symbols; restores the chart afterwards
rules.json's bias_criteria are PROSE a model grades by judgement — fine for a
brief, but not reproducible and not backtestable. A strategy block is. When the
user states a rule with numbers in it, offer to write it there.
An unresolvable criterion is UNKNOWN, never a fail. Report unresolved symbols
as "not checked", not "did not qualify".

Patterns:
- patterns_detect → candlestick and chart patterns computed from the bars,
  with the measurements behind each one
A structural pattern is "forming" until price CLOSES through its completion
level. Never report a forming pattern as a signal — that is the single most
common error with patterns. Candlestick reversals need a prior trend; the tool
says so when there is none.

Context — ask these BEFORE hunting for a setup:
- market_regime → efficiency ratio: is this trending or is it chop? In a
  choppy market structure breaks are noise and patterns appear that are not
  there. "No trade" is a real answer and this is how to say it with a number.
- fib_levels → pullback depth against the last impulse, and the golden zone.
  A shallow pullback is normal in a steep trend, not a weakness.
- swing_strength → which swings are STRONG (their move broke structure) vs
  WEAK (it failed). Stops belong beyond strong swings; weak ones get run.
- volume_profile → point of control, value area, high/low volume nodes,
  computed from the bars. An approximation, and it says so.
- fib_targets → Fibonacci EXTENSIONS. Retracements find entries, extensions
  find EXITS, and the two get confused constantly. The 1.0 level is the
  measured move — geometry, not Fibonacci. No success rate is attached
  because none has been measured; run backtest_evaluate if you want one.

Supply and demand zones — a DIFFERENT question from levels_find:
- levels_find asks where price REVERSED repeatedly. Evidence is the tests.
- zones_find asks where price DEPARTED from, fast. Evidence is the departure.
  A chart usually answers the two at different prices; use both.
- zones_draw → the same zones as shaded rectangles, grouped for clearing.
The unfilled-institutional-orders story is NOT observable in OHLCV and nothing
here depends on it. What is measured is that price left fast, how far it got,
and whether it has reacted there since. Zones are common — the count before
filtering always comes back. "Fresh beats tested" is convention, not a
measurement made here.

Divergence — the most over-claimed signal in TA:
- divergence_survey → runs RSI, MACD histogram, OBV and MFI and reports where
  they AGREE. Prefer this over divergence_find: one indicator diverging out of
  four is far weaker than a reader shown only that one would assume.
- divergence_find → one indicator, with hidden (continuation) divergences too.
In a STRONG TREND divergence is normal, not a warning — a bounded oscillator
cannot keep making higher highs while price does. It can persist for months and
is not a timing tool. total_found always comes back so none looks rare.

Legs — the unit a trend is built from:
- legs_classify → each leg between swings as IMPULSE or PULLBACK, from three
  measurements: body share, colour agreement, closes near the extreme. Also
  marks a pullback simple or complex, and flags a "pullback" that moved further
  than the impulse before it — that shape is a trend change, not a retracement.
- ALWAYS read since_last_leg. Swings need bars to their right to confirm, so
  the last leg ends some way back; when price has run since, the warning says
  so. Never describe the last leg as what price is doing now.

Costs — a backtest without them flatters itself exactly as one without a
benchmark does, and resolveTrade fills at the exact stop price:
- trade_cost → commission, spread, slippage, borrow, in currency AND in R.
  Preset "ibkr_pro_fixed" is the real schedule: $0.005/share, $1.00 MINIMUM
  per order, 1% cap. The minimum is the point — a 100-share order pays double
  the per-share rate and a 50-share order quadruple.
- costs_vs_edge → what fraction of the edge the costs consume. An edge smaller
  than its costs is a losing strategy however good the backtest looked.
- gap_risk → how often price GAPPED past a stop distance. Backtests here fill
  at the stop price; a stop is a market order once touched, so every backtest
  in this toolchain understates its worst losses. This measures that, it does
  not fix it.

Portfolio — per-trade sizing is the wrong unit for what ends accounts:
- portfolio_heat → total risk if every stop is hit at once
- position_correlation → six positions at r=0.8 are about 1.4 independent
  bets. Pairs without data are UNKNOWN, never zero.
- position_concentration → open risk by sector or any tag, measured by RISK
  rather than notional
Six positions risking 1% each is not 1% of risk. Correlations also rise in a
selloff, which is when the diversification is being relied on.

Risk — ask these BEFORE sizing anything:
- risk_expectancy → expectancy, BREAK-EVEN win rate, and Kelly, from a win rate
  and a payoff. A win rate is meaningless without its payoff: 80% loses money
  if the losses are big enough. Never compare a win rate to 50% — compare it to
  break_even_win_rate_pct. Pass sample_size; it decides how far to trust Kelly.
- risk_of_ruin → whether the account survives the edge. Seeded Monte Carlo.
  Report the ruin probability and the worst 5%, never the median alone.
- drawdown_recovery → down 50% needs +100%, down 80% needs +400%.
- position_size_atr → sizing from volatility, and a check on whether a chosen
  stop sits inside the instrument's ordinary bar range.
Full Kelly is almost never the answer — it assumes the win rate is exact. If
expectancy is negative, say so and stop: no size fixes a negative edge.
Martingale is deliberately not implemented; explain why rather than building it.

Elliott wave — enumerated, never chosen:
- elliott_count → EVERY rule-valid five-wave count, with the total stated.
- elliott_survey → the same at several sensitivities, reporting whether they
  agree. Disagreement IS the finding — it is the method's subjectivity made
  concrete for this chart.
Never present one count as "the" count. The four Fibonacci relationships are
measured against their typical bands, so a rule-valid count that fits none is
visibly weak. No peer-reviewed support; use it as a road map, not a signal.

Candles:
- candle_read → classify recent candles as momentum / reaction / indecision.
  Always answers, unlike patterns_detect which answers only for named patterns.
  On a reaction candle the WICK carries the information, not the body colour,
  and it only means something at a level price has already tested.

Liquidity and VWAP:
- anchored_vwap → VWAP from any bar (a swing low, an earnings gap) with
  standard-deviation bands. Says who is in control and how extended price is.
  Context, NOT a trigger — a flat VWAP gives the weakest signals of all.
- fair_value_gaps → three-bar imbalances. These occur CONSTANTLY; the tool
  reports how many existed before filtering so none looks rare.
- liquidity_pools → equal highs/lows where stops cluster. More touches means
  a deeper pool, which is why a thrice-tested level breaks harder.
A "liquidity sweep" or "grab" is a failed break — use wyckoff_spring or
breakout_check. A "liquidity run" is a real breakout — breakout_check scores
it. Do not treat the vocabulary as new capability.

Wyckoff — phases and the two setups the method actually trades:
- wyckoff_phase → accumulation / markup / distribution / markdown, with the
  measurements behind the label. Accumulation and distribution differ ONLY by
  what preceded the range. Returns "unclear" freely.
- wyckoff_spring → springs and upthrusts. A spring needs price to trade BELOW
  support and CLOSE back inside. A wick below with a close still below is a
  breakdown, and buying it is how people buy into a decline. Unconfirmed
  candidates come back in their own list.
- effort_vs_result → volume is effort, price is result. Price up on FALLING
  volume is a rally nobody is backing.
Wyckoff has NO measured performance data of the Bulkowski kind. Report it as
interpretive, not as statistics.

Breakouts — score them, do not eyeball them:
- breakout_check → scores a break of a level on five measurements: momentum,
  how far beyond it CLOSED, volume, how established the level was, and
  follow-through. The same five inverted are the signs of a false breakout.
  A break reclaimed on the next bar is FAILED regardless of the other four.
- level_pressure → lower highs into support (or higher lows into resistance)
  mean the level is weakening and more likely to break than hold.

Backtesting — three methods, one rule:
- backtest_strategy → the Pine strategy on the chart: win rate, payoff,
  expectancy, profit factor, streaks, AND buy-and-hold over the same bars
- backtest_drawn → trades the user DREW, each walked forward through later
  bars to see whether stop or target came first
- backtest_evaluate → score a list of trades you supply (Bar Replay, imports)
- backtest_benchmark → buy-and-hold on its own
ALWAYS report the benchmark. Net profit cannot distinguish a good strategy
from a rising market, and a strategy can earn its keep purely by avoiding a
drawdown while returning less. Report return AND drawdown, never one number.
Expectancy is the headline, not win rate: a 30% win rate can be excellent and
an 80% one can bleed.

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
registerStructureTools(server);
registerBacktestTools(server);
registerStrategyTools(server);
registerPatternTools(server);
registerBreakoutTools(server);
registerContextTools(server);
registerWyckoffTools(server);
registerLiquidityTools(server);
registerZoneTools(server);
registerRiskTools(server);
registerElliottTools(server);
registerDivergenceTools(server);
registerCostTools(server);
registerMtfTools(server);
registerRelativeTools(server);
registerExportTools(server);
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
