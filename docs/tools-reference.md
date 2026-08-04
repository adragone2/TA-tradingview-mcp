# Tools Reference

All **194 tools** exposed by this MCP server, generated from the live server so it cannot drift from what is actually registered.

Grouped by prefix. For *when* to use these rather than *what they are*, see
[START-HERE.md](START-HERE.md) and [routines.md](routines.md).

> **Before acting on anything that changes state**, read the guardrails in
> [START-HERE.md](START-HERE.md). Several of these tools drive the user's live
> chart or create real account objects.

## The ones that matter most

| Tool | Why |
|---|---|
| `tv_doctor` | First stop for any failure; every failing check carries its fix |
| `ta_trading_context` | Position + catalyst + regime for a ticker, in one call, before you act on a setup |
| `draw_trade_plan` | Entry/stop/targets in one call with R:R — never hand-build from `draw_shape` |
| `walls_apply` | TA's gamma walls into the Institutional Matrix indicator |
| `morning_brief` | Multi-timeframe technical scan graded against the user's own rules |
| `ta_regime` | Regime **and** position sizing (`max_new_position_pct`, `position_multiplier`) |

## Full inventory

### tv_* (5)

- **`tv_health_check`** — Check CDP connection to TradingView and return current chart state
- **`tv_discover`** — Report which known TradingView API paths are available and their methods
- **`tv_ui_state`** — Get current UI state: which panels are open, what buttons are visible/enabled/disabled
- **`tv_launch`** — Launch TradingView Desktop with Chrome DevTools Protocol (remote debugging) enabled
- **`tv_doctor`** — Run all setup checks at once: node version, TradingView install, CDP port, MCP server load, live chart read, and rules.json

### rules_* (2)

- **`rules_init`** — Create rules.json from the bundled template so morning_brief can use your own watchlist, bias criteria, and risk rules
- **`rules_status`** — Show which rules.json would be used, and where it was searched for.

### chart_* (9)

- **`chart_get_state`** — Get current chart state (symbol, timeframe, chart type, indicators)
- **`chart_set_symbol`** — Change the chart symbol
- **`chart_set_timeframe`** — Change the chart timeframe/resolution
- **`chart_set_type`** — Change chart type
- **`chart_manage_indicator`** — Add or remove an indicator/study on the chart
- **`chart_get_visible_range`** — Get the visible date range (unix timestamps) and bars range on the chart
- **`chart_set_visible_range`** — Zoom the chart to a specific date range (unix timestamps)
- **`chart_scroll_to_date`** — Jump the chart view to center on a specific date
- **`chart_indicators_for_strategy`** — Put a strategy's TradingView indicators on the chart, from the catalogue's own `indicators` field

### data_* (10)

- **`data_get_ohlcv`** — Get OHLCV bar data from the chart
- **`data_get_indicator`** — Get indicator/study info and input values
- **`data_get_strategy_results`** — Get strategy performance metrics from Strategy Tester
- **`data_get_trades`** — Get trade list from Strategy Tester
- **`data_get_equity`** — Get equity curve data from Strategy Tester
- **`data_get_pine_lines`** — Read horizontal price levels drawn by Pine Script indicators (line.new)
- **`data_get_pine_labels`** — Read text labels drawn by Pine Script indicators (label.new)
- **`data_get_pine_tables`** — Read table data drawn by Pine Script indicators (table.new)
- **`data_get_pine_boxes`** — Read box/zone boundaries drawn by Pine Script indicators (box.new)
- **`data_get_study_values`** — Get current indicator values from the data window for all visible studies (RSI, MACD, Bollinger Bands, EMAs, custom indicators with plot()).

### quote_* (1)

- **`quote_get`** — Get real-time quote data for a symbol (price, OHLC, volume)

### depth_* (1)

- **`depth_get`** — Get order book / DOM (Depth of Market) data from the chart

### symbol_* (2)

- **`symbol_info`** — Get detailed metadata about the current symbol (name, exchange, type, description)
- **`symbol_search`** — Search for symbols by name or keyword

### indicator_* (2)

- **`indicator_set_inputs`** — Change indicator/study input values (e.g., length, source, period)
- **`indicator_toggle_visibility`** — Show or hide an indicator/study on the chart

### draw_* (9)

- **`draw_shape`** — Draw a shape/line on the chart
- **`draw_trade_plan`** — Draw a complete trade plan — entry, stop, targets with optional partial percentages, and optional break-even — as labelled, colour-coded, non-overlapp
- **`draw_list`** — List drawings on the chart
- **`draw_clear`** — Remove drawings
- **`draw_list_groups`** — List the drawing groups this tool has created, so you can clear or reference a specific trade plan.
- **`draw_remove_one`** — Remove a specific drawing by entity ID
- **`draw_get_properties`** — Get properties and points of a specific drawing
- **`draw_toggle`** — Hide or show MCP drawings WITHOUT deleting them — by category (levels, patterns, plans, zones, cycle, earnings, fib, elliott, walls...), by registry g
- **`draw_organize`** — Organize MCP drawings into NATIVE TradingView groups — one row per category ("MCP levels", "MCP patterns", "MCP cycle"...) in the chart's Object Tree 

### walls_* (5)

- **`walls_coverage`** — List the tickers TA has gamma-wall data for, and the date of the latest snapshot
- **`walls_get`** — Build the Institutional Matrix JSON for a symbol from TA's latest wall snapshot, without writing it to the chart
- **`walls_apply`** — Write TA's latest gamma walls into the Institutional Matrix indicator on the current chart, replacing the hand-pasted JSON
- **`walls_draw`** — Draw TA's gamma walls as native chart lines instead of writing them into the Institutional Matrix indicator
- **`walls_apply_many`** — Apply walls across several symbols, switching the chart to each in turn and restoring it afterwards

### ta_* (14)

- **`ta_health`** — Check whether the Tactical Alpha API is reachable and whether an API key is configured
- **`ta_status`** — Show which TA base URL is in use and whether a key is configured
- **`ta_trading_context`** — For specific tickers, pull the two things a chart cannot tell you: whether you already hold the name, and whether it reports soon — plus the current m
- **`ta_portfolio`** — Current portfolio positions from Tactical Alpha
- **`ta_earnings`** — The TA earnings calendar
- **`ta_regime`** — Current market regime from TA
- **`ta_alerts`** — Active alerts from Tactical Alpha.
- **`ta_investing_brief`** — TA's own morning brief
- **`ta_digest`** — TA's AI digest feed.
- **`ta_get`** — GET any Tactical Alpha API endpoint
- **`ta_actionable`** — Everything Tactical Alpha currently flags for action — exits ordered by urgency, entries by score
- **`ta_entry`** — TA's entry decision for a symbol: action, conviction, suggested size, and the levels behind it (put wall, BB lower, PIF support, distance to stop).
- **`ta_exit`** — TA's exit decision for a held position: urgency, action, how much to exit, and the levels behind it (stop, call wall, BB upper, PIF resistance)
- **`ta_draw_decision`** — Draw TA's entry and/or exit levels for a symbol on the current chart, colour-coded (stops red, resistance green, support blue) and grouped so they cle

### morning_* (1)

- **`morning_brief`** — Scan a watchlist across one or more timeframes and return structured per-symbol data for a session brief: indicator readings, a price-action summary, 

### session_* (2)

- **`session_save`** — Save today's morning brief to ~/.tradingview-mcp/sessions/YYYY-MM-DD.json for future reference.
- **`session_get`** — Retrieve a saved session brief

### watchlist_* (5)

- **`watchlist_read`** — Read the active TradingView watchlist split into its sections
- **`watchlist_sync_plan`** — Show what syncing from Tactical Alpha would change, without writing anything
- **`watchlist_sync`** — Sync the TradingView watchlist from Tactical Alpha
- **`watchlist_get`** — Get all symbols from the current TradingView watchlist with last price, change, and change%
- **`watchlist_add`** — Add a symbol to the TradingView watchlist

### layout_* (2)

- **`layout_list`** — List saved chart layouts
- **`layout_switch`** — Switch to a saved chart layout by name or ID

### pane_* (4)

- **`pane_list`** — List all chart panes in the current layout with their symbols and active state
- **`pane_set_layout`** — Change the chart grid layout (e.g., single, 2x2, 2h, 3v)
- **`pane_focus`** — Focus a specific chart pane by index (0-based)
- **`pane_set_symbol`** — Set the symbol on a specific pane by index

### tab_* (4)

- **`tab_list`** — List all open TradingView chart tabs
- **`tab_new`** — Open a new chart tab
- **`tab_close`** — Close the current chart tab
- **`tab_switch`** — Switch to a chart tab by index

### pine_* (12)

- **`pine_get_source`** — Get current Pine Script source code from the editor
- **`pine_set_source`** — Set Pine Script source code in the editor
- **`pine_compile`** — Compile / add the current Pine Script to the chart
- **`pine_get_errors`** — Get Pine Script compilation errors from Monaco markers
- **`pine_save`** — Save the current Pine Script (Ctrl+S)
- **`pine_get_console`** — Read Pine Script console/log output (compile messages, log.info(), errors)
- **`pine_smart_compile`** — Intelligent compile: detects button, compiles, checks errors, reports study changes
- **`pine_new`** — Create a new blank Pine Script
- **`pine_open`** — Open a saved Pine Script by name
- **`pine_list_scripts`** — List saved Pine Scripts
- **`pine_analyze`** — Run static analysis on Pine Script code WITHOUT compiling — catches array out-of-bounds, unguarded array.first()/last(), bad loop bounds, and implicit
- **`pine_check`** — Compile Pine Script via TradingView's server API without needing the chart open

### replay_* (6)

- **`replay_start`** — Start bar replay mode, optionally at a specific date
- **`replay_step`** — Advance one bar in replay mode
- **`replay_autoplay`** — Toggle autoplay in replay mode, optionally set speed
- **`replay_stop`** — Stop replay and return to realtime
- **`replay_trade`** — Execute a trade action in replay mode (buy, sell, or close position)
- **`replay_status`** — Get current replay mode status

### alert_* (3)

- **`alert_create`** — Create a price alert on the user's TradingView account, through the same REST API the alert dialog uses
- **`alert_list`** — List the alerts on the account, with their ids, symbols, conditions and active state
- **`alert_delete`** — Delete alerts by id

### batch_* (1)

- **`batch_run`** — Run an action across multiple symbols and/or timeframes

### capture_* (1)

- **`capture_screenshot`** — Take a screenshot of the TradingView chart

### ui_* (10)

- **`ui_click`** — Click a UI element by aria-label, data-name, text content, or class substring
- **`ui_open_panel`** — Open, close, or toggle TradingView panels (pine-editor, strategy-tester, watchlist, alerts, trading)
- **`ui_fullscreen`** — Toggle TradingView fullscreen mode
- **`ui_keyboard`** — Press keyboard keys or shortcuts (e.g., Enter, Escape, Alt+S, Ctrl+Z)
- **`ui_type_text`** — Type text into the currently focused input/textarea element
- **`ui_hover`** — Hover over a UI element by aria-label, data-name, or text content
- **`ui_scroll`** — Scroll the chart or page up/down/left/right
- **`ui_mouse_click`** — Click at specific x,y coordinates on the TradingView window
- **`ui_find_element`** — Find UI elements by text, aria-label, or CSS selector and return their positions
- **`ui_evaluate`** — Execute JavaScript code in the TradingView page context for advanced automation

### position_* (7)

- **`position_draw`** — Draw TradingView's native Long/Short Position tool — shaded risk and reward boxes with entry, stop and target, and a size TradingView computes from ac
- **`position_read`** — Read Long/Short Position tools off the chart as plain prices — entry, stop, target, R:R and quantity
- **`position_size`** — Position size for a trade already drawn on the chart, under ALL THREE constraints — risk budget, concentration cap, and liquidity — returning the MINI
- **`position_size_atr`** — Position size from volatility instead of from a fixed price stop
- **`position_size_constrained`** — Position size under all THREE constraints at once — risk budget, concentration cap, and liquidity — returning the MINIMUM and naming which one bound
- **`position_correlation`** — How much open positions actually move together, from their return series
- **`position_concentration`** — How open RISK is distributed across a bucket — sector, direction, or any tag on the positions

### structure_* (1)

- **`structure_analyze`** — Market structure from the chart's own price data: swing highs and lows, each labelled HH/HL/LH/LL, the resulting trend, and every break of structure (

### levels_* (2)

- **`levels_find`** — Support and resistance levels computed from price history, each carrying the evidence that earned it: how many SEPARATE times price tested it, how man
- **`levels_draw`** — Draw the key levels on the chart, labelled with the evidence behind each one, grouped so draw_clear removes them cleanly

### level_* (2)

- **`level_test_history`** — The full test-by-test history of a level: every separate approach, where price RETREATED TO between them, and whether the level eventually broke
- **`level_pressure`** — Is a level weakening as price approaches it? Lower highs into support (or higher lows into resistance) mean each attempt is failing earlier

### backtest_* (4)

- **`backtest_strategy`** — Evaluate the Pine strategy on the chart: win rate, payoff, expectancy, profit factor and streaks, computed from its trades — AND compared against buy-
- **`backtest_drawn`** — Backtest the trades the user DREW on the chart
- **`backtest_benchmark`** — Buy-and-hold return and max drawdown for the bars on the chart
- **`backtest_evaluate`** — Win rate, payoff, expectancy, profit factor and streaks for a list of trades you supply — the way to score trades taken manually in Bar Replay, or imp

### strategy_* (3)

- **`strategy_list`** — Every strategy in the catalogue (strategies.json, tracked in git) plus any in rules.json, with criteria, execution tier, evidence tier and validation 
- **`strategy_check`** — Evaluate a strategy against the symbol on the chart, criterion by criterion, showing the ACTUAL value on each side of every comparison
- **`strategy_scan`** — Check a strategy across several symbols and return the ones where every criterion passes

### patterns_* (3)

- **`patterns_draw`** — Draw the detected patterns on the chart — the COMPLETION LEVEL of each, which is the price at which a shape stops being a shape and becomes a fact, an
- **`patterns_detect`** — Detect candlestick and chart patterns on the chart from the bars themselves
- **`patterns_lmw`** — The Lo/Mamaysky/Wang pattern definitions verbatim (head-and-shoulders, broadening, triangle, rectangle, double top/bottom) as a SECOND OPINION on patt

### candle_* (1)

- **`candle_read`** — Classify the most recent candles into the only three families that exist — momentum (one side held control), reaction (one side pushed, the other took

### breakout_* (1)

- **`breakout_check`** — Score a breakout of a price level against five measurable criteria, and report its THROWBACK — whether price came back to the level afterwards

### market_* (1)

- **`market_regime`** — Is this market trending cleanly or is it chop? Returns an efficiency ratio — net distance travelled divided by the total path walked

### fib_* (2)

- **`fib_levels`** — Fibonacci retracement levels for the most recent impulse, with where price currently sits in them and whether it is in the 38.2-61.8% golden zone
- **`fib_targets`** — Fibonacci EXTENSION targets — where a move projects to, not where a pullback might end

### swing_* (1)

- **`swing_strength`** — Classify each swing high and low as strong, weak or unproven

### volume_* (1)

- **`volume_profile`** — Where volume actually traded, by price: point of control, value area, and high/low volume nodes

### wyckoff_* (2)

- **`wyckoff_phase`** — Classify the chart into a Wyckoff phase — accumulation, markup, distribution, markdown, or a plain range — with the measurements behind the label
- **`wyckoff_spring`** — Find springs and upthrusts — false breaks of a range boundary that get reclaimed

### effort_* (1)

- **`effort_vs_result`** — Wyckoff's third law as a measurement: volume is effort, price movement is result

### anchored_* (1)

- **`anchored_vwap`** — VWAP anchored to any bar, with standard-deviation bands

### fair_* (1)

- **`fair_value_gaps`** — Three-bar imbalances where bar 1 and bar 3 do not overlap — price moved so fast it left a band nothing traded in

### liquidity_* (1)

- **`liquidity_pools`** — Equal highs and equal lows — swing points stacked at effectively one price, where stop orders cluster

### zones_* (2)

- **`zones_find`** — Supply and demand zones — the base a move DEPARTED from, which is a different question from levels_find (where price repeatedly reversed)
- **`zones_draw`** — Draw supply and demand zones on the chart as shaded rectangles, grouped so they clear in one call without touching your own drawings

### risk_* (2)

- **`risk_expectancy`** — Expectancy, break-even win rate and Kelly from a win rate and a payoff
- **`risk_of_ruin`** — How often a drawdown this deep happens, by seeded Monte Carlo

### drawdown_* (1)

- **`drawdown_recovery`** — What a drawdown costs to recover: down 50% needs +100%, down 80% needs +400%

### exit_* (1)

- **`exit_mix`** — Split a set of journalled exits into PLANNED versus DISCRETIONARY, using the fifteen-key taxonomy (Bellafiore's Reasons2Sell plus Shannon's gap-agains

### journal_* (1)

- **`journal_slice`** — Slice closed trades by direction, share size, share price and holding time, and report P&L per bucket

### elliott_* (2)

- **`elliott_count`** — Every rule-valid five-wave Elliott count in the bars — not "the" count
- **`elliott_survey`** — Run the Elliott enumeration at several swing sensitivities and report whether they agree

### divergence_* (2)

- **`divergence_find`** — Divergence between price and one indicator — RSI, MACD, OBV, MFI or raw volume
- **`divergence_survey`** — Run divergence across RSI, MACD histogram, OBV and MFI at once and report where they AGREE

### legs_* (1)

- **`legs_classify`** — Classify each leg between swings as an IMPULSE or a PULLBACK, with the measurements behind it — body share, colour agreement, and where bars closed in

### trade_* (1)

- **`trade_cost`** — The round-trip cost of a trade — commission, spread, slippage and borrow — in currency and in R

### costs_* (1)

- **`costs_vs_edge`** — What transaction costs do to a stated edge

### gap_* (2)

- **`gap_risk`** — How often price GAPPED past a given stop distance on this chart
- **`gap_classify`** — Classify every gap on the chart — common, breakaway, runaway (measuring), exhaustion — as numbered clauses with the failing ones named, in the Edwards

### luld_* (1)

- **`luld_band`** — The Limit Up-Limit Down band around a price — how far it can run before trading halts

### portfolio_* (1)

- **`portfolio_heat`** — Total open risk across positions if every stop is hit at once

### timeframe_* (2)

- **`timeframe_plan`** — Which timeframes to use for a trading style, and why
- **`timeframe_scale`** — Translate a method from one timeframe to another

### mtf_* (1)

- **`mtf_analyze`** — Trend and regime across three timeframes at once, and whether they AGREE

### scaling_* (1)

- **`scaling_exponent`** — The realised volatility scaling exponent on this chart

### stage_* (3)

- **`stage_plan`** — Shannon's four-stage ACTION machine: what to DO right now, from two timeframes
- **`stage_history`** — THE OWNER'S OWN FOUR-STATE CYCLE, run bar by bar: base / accumulation / distribution / declining
- **`stage_draw`** — Draw the OWNER'S CYCLE boundaries on the chart: one dashed vertical line per TRANSITION, labelled "cycle base>accumulation 2026-05-14", plus ONE callo

### relative_* (1)

- **`relative_strength`** — Performance against a benchmark — the "compared to what" question no single-symbol tool can answer

### export_* (1)

- **`export_bars_csv`** — Write the chart's bars to a CSV file

### momentum_* (1)

- **`momentum_read`** — Time-series momentum — the best-replicated effect in the technical literature, and the one this toolchain lacked

### vcp_* (2)

- **`vcp_check`** — Minervini's volatility contraction pattern, as a measurable rule: successive pullbacks each tighter than the last, on declining volume, after a prior 
- **`vcp_draw`** — Draw the VCP on the chart — one labelled trend_line per contraction (`VCP c<n> <d>%`) plus the pivot line, into group `vcp-<TICKER>`, clearing that gr

### cup_* (1)

- **`cup_check`** — Is this a proper CUP WITH HANDLE? Eight numbered clauses in the vcp_check style — U-shape not V (time in the bottom quarter of the cup, 35% between a 

### pivots_* (1)

- **`pivots_kernel`** — Locate swing pivots by kernel regression, then read each one from the ACTUAL bar high or low — the step from Lo, Mamaysky & Wang that keeps every repo

### deflated_* (1)

- **`deflated_sharpe`** — Correct a Sharpe ratio for how hard you looked for it

### rule_* (1)

- **`rule_select`** — Select among candidate rules with transaction costs treated as ENDOGENOUS — the fix for the ordering error every scan in this repo made

### horizon_* (1)

- **`horizon_prior`** — THE structural problem underneath swing trading, and the one this toolchain was silent about

### turnover_* (1)

- **`turnover_cost`** — Whether a strategy can survive its own trading frequency — the arithmetic that eliminates most swing systems before any signal work begins

### stopping_* (1)

- **`stopping_premium`** — Does a stop-loss ADD expected return on this chart, or just cost you? Kaminski & Lo (2014) prove the stopping premium is ALWAYS NEGATIVE under a rando

### pivot_* (1)

- **`pivot_trail`** — Where a trailing stop goes when the rule is the DEFINITION of the trend rather than a distance

### edge_* (1)

- **`edge_breadth`** — What a published cross-sectional edge is actually worth on YOUR number of positions

### volatility_* (1)

- **`volatility_state`** — Crabel's contraction/expansion measures, reported as a VOLATILITY STATE and never as a signal

### tier_* (1)

- **`tier_a_factors`** — The four Tier A cross-sectional factors from the evidence review, computed over the live index universe in one scanner request

### short_* (1)

- **`short_interest`** — FINRA short interest for a symbol — how many shares are sold short and not yet covered, the average daily volume behind it, and days to cover, as a bi

### finra_* (1)

- **`finra_status`** — Whether the FINRA credentials are configured and which short-interest dataset is in use, plus the reporting cadence

### group_* (2)

- **`group_context`** — The industry-group context Livermore put BEFORE every trade, and the one thing this toolchain had no equivalent for
- **`group_top_down`** — Livermore's Top Down Trading as an explicit four-step GATE, in his order: the market the stock trades on, then the industry group, then the two leader

### ticker_* (2)

- **`ticker_playbook`** — THE ENTRY POINT for analysing one ticker
- **`ticker_analyze`** — THE WHOLE CHART ANALYSIS IN ONE CALL, and it reports what it did NOT do

### entry_* (1)

- **`entry_hypothesis`** — AT WHAT PRICE WOULD YOU ACT — the forward half of an analysis, for BOTH directions

---

## Not in this server

- **WRDS** research tools (`wrds_*`) live in the separate `wrds-mcp` server — see [data-sources.md](data-sources.md).
- **FSI plugin skills** are invoked by name, not as MCP tools — see [plugins.md](plugins.md).

## Regenerating

This file is generated from the running server, so it stays honest:

```bash
node scripts/gen-tools-doc.js
```
