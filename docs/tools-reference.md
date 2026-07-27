# Tools Reference

All **121 tools** exposed by this MCP server, generated from the live server so it cannot drift from what is actually registered.

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

### chart_* (8)

- **`chart_get_state`** — Get current chart state (symbol, timeframe, chart type, indicators)
- **`chart_set_symbol`** — Change the chart symbol
- **`chart_set_timeframe`** — Change the chart timeframe/resolution
- **`chart_set_type`** — Change chart type
- **`chart_manage_indicator`** — Add or remove an indicator/study on the chart
- **`chart_get_visible_range`** — Get the visible date range (unix timestamps) and bars range on the chart
- **`chart_set_visible_range`** — Zoom the chart to a specific date range (unix timestamps)
- **`chart_scroll_to_date`** — Jump the chart view to center on a specific date

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

### draw_* (7)

- **`draw_shape`** — Draw a shape/line on the chart
- **`draw_trade_plan`** — Draw a complete trade plan — entry, stop, targets with optional partial percentages, and optional break-even — as labelled, colour-coded, non-overlapp
- **`draw_list`** — List drawings on the chart
- **`draw_clear`** — Remove drawings
- **`draw_list_groups`** — List the drawing groups this tool has created, so you can clear or reference a specific trade plan.
- **`draw_remove_one`** — Remove a specific drawing by entity ID
- **`draw_get_properties`** — Get properties and points of a specific drawing

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

### position_* (3)

- **`position_draw`** — Draw TradingView's native Long/Short Position tool — shaded risk and reward boxes with entry, stop and target, and a size TradingView computes from ac
- **`position_read`** — Read Long/Short Position tools off the chart as plain prices — entry, stop, target, R:R and quantity
- **`position_size`** — Position size for a trade already drawn on the chart, given an account size and risk percent

### structure_* (1)

- **`structure_analyze`** — Market structure from the chart's own price data: swing highs and lows, each labelled HH/HL/LH/LL, the resulting trend, and every break of structure (

### levels_* (2)

- **`levels_find`** — Support and resistance levels computed from price history, each carrying the evidence that earned it: how many SEPARATE times price tested it, how man
- **`levels_draw`** — Draw computed key levels on the chart — horizontal lines for tight levels, shaded rectangles for zones — green for support, red for resistance, thickn

### backtest_* (4)

- **`backtest_strategy`** — Evaluate the Pine strategy on the chart: win rate, payoff, expectancy, profit factor and streaks, computed from its trades — AND compared against buy-
- **`backtest_drawn`** — Backtest the trades the user DREW on the chart
- **`backtest_benchmark`** — Buy-and-hold return and max drawdown for the bars on the chart
- **`backtest_evaluate`** — Win rate, payoff, expectancy, profit factor and streaks for a list of trades you supply — the way to score trades taken manually in Bar Replay, or imp

### strategy_* (3)

- **`strategy_list`** — List the machine-evaluable strategies defined in rules.json, with their criteria and any validation errors
- **`strategy_check`** — Evaluate a strategy against the symbol on the chart, criterion by criterion, showing the ACTUAL value on each side of every comparison
- **`strategy_scan`** — Check a strategy across several symbols and return the ones where every criterion passes

---

## Not in this server

- **WRDS** research tools (`wrds_*`) live in the separate `wrds-mcp` server — see [data-sources.md](data-sources.md).
- **FSI plugin skills** are invoked by name, not as MCP tools — see [plugins.md](plugins.md).

## Regenerating

This file is generated from the running server, so it stays honest:

```bash
node scripts/gen-tools-doc.js
```
