# TradingView MCP — Claude Instructions

**Read [docs/START-HERE.md](docs/START-HERE.md) first.** It is the entry point for this project. This file is the always-loaded index; the docs carry the detail.

122 MCP tools driving a live TradingView Desktop chart over CDP (port 9222), plus the Tactical Alpha API and a separate WRDS server.

## The three layers — don't confuse them

| Layer | Tools | Job |
|---|---|---|
| **TradingView MCP** (here) | everything except `ta_*` | Charts, levels, entries, drawings, Pine. **Trading.** |
| **Tactical Alpha** (VPS) | `ta_*`, `walls_*` | Portfolio, earnings, regime, walls, watchlists. **Investing.** TA is the master system. |
| **WRDS** (`wrds-mcp` server) | `wrds_*` | Historical research. **Not live** — CRSP ends 2024. |

`ta_investing_brief` and `morning_brief` are different views, not duplicates.

## Documentation

| File | For |
|---|---|
| [docs/START-HERE.md](docs/START-HERE.md) | Entry point — layers, first moves, guardrails |
| [docs/tools-reference.md](docs/tools-reference.md) | All 122 tools (generated — `node scripts/gen-tools-doc.js`) |
| [docs/data-sources.md](docs/data-sources.md) | TA endpoints, WRDS datasets, **freshness rules** |
| [docs/routines.md](docs/routines.md) | Daily and weekly workflows |
| [docs/plugins.md](docs/plugins.md) | FSI plugin skills and how to feed them data |
| [docs/architecture.md](docs/architecture.md) | How the layers connect |
| [docs/playbook.md](docs/playbook.md) | Strategies and patterns from the reference books |
| [docs/troubleshooting.md](docs/troubleshooting.md) | Known breakages and causes |
| `skills/` | Step-by-step procedures, invoked by name |

## Decision tree

| The user asks | Do |
|---|---|
| Anything is broken | `tv_doctor` — every failing check carries its fix |
| "What's on my chart?" | `chart_get_state` → `data_get_study_values` → `quote_get` |
| "Analyse this chart" | `chart-analysis` skill |
| "Mark my entry/stop/targets" | `draw_trade_plan` — one call, returns R:R |
| "What should I look at today?" | `morning_brief`, or `catalyst-aware-brief` for event risk |
| "Add the walls" | `walls-overlay` skill (needs the **TA-Trading** layout) |
| "Do I own this? Does it report soon?" | `ta_trading_context` — call **before** acting on a setup |
| "What's the regime?" | `ta_regime` — also carries position sizing |
| "Write a Pine script" | `pine-develop` skill |
| "What's the trend?" / "key levels?" | `market-structure` skill — `structure_analyze`, `levels_find`. Quote each level's evidence |
| "Any patterns?" | `patterns_detect` — a *forming* pattern is not a signal |
| "Which symbols qualify?" / a rule with numbers | `strategy-scan` skill — criteria as data, not prose |
| "Backtest this" / "does it work?" | `backtest-strategy` skill — **always report buy-and-hold** |
| "Did this ever work?" | `wrds_backtest_signal` |
| "Clean up the chart" | `draw_clear` — removes only MCP drawings by default |

## Rules

Each of these exists because it has already gone wrong here.

**Verify — don't trust a success flag.** Eight tools in this codebase were found reporting `success: true` while doing nothing, because their tests asserted things that could not fail. If a tool claims success but the chart didn't change, believe the chart.

**A backtest without a benchmark flatters itself.** Net profit cannot tell a good strategy from a rising market. Always report buy-and-hold over the same bars, and report return *and* drawdown — a strategy often earns its keep by avoiding a drawdown while returning less. Lead with expectancy, not win rate.

**Tools, strategies and workflows are different things.** Tools are capabilities (`src/tools/`), strategies are testable rules (`rules.json`, Pine), workflows are procedures (`skills/`). A tool must not encode a strategy; a strategy must not live in a skill's prose. See [docs/START-HERE.md](docs/START-HERE.md).

**Never invent a price.** Levels come from `drawn_levels`, `drawn_labels`, `price_action`, or TA. If nothing supports one, write `n/a`.

**A 200 is not freshness.** TA stamps `age_hours` from the source file's mtime. Walls past ~30h on a trading day mean TA's scan didn't run. Say the age out loud.

**Live account, live chart.** `draw_clear scope:"all"` deletes the user's own drawings — always ask. `alert_create` makes a real alert that can fire; check the price is on the correct side of spot. `alert_delete` needs explicit ids. Scans drive the chart and must restore it.

**Not trade advice.** These tools render the user's own criteria and TA's own output. R:R and position size are arithmetic on numbers they supplied.

## Context management

- `data_get_ohlcv` — always `summary: true` unless individual bars are needed
- Pine graphics tools — always pass `study_filter`; never `verbose` unless asked
- `pine_get_source` can return 200KB+ — avoid unless editing
- `chart_get_state` once at the start; reuse entity IDs
- Prefer `capture_screenshot` over pulling large datasets for visual context

## Conventions

- All tools return `{ success: true/false, ... }`
- Entity IDs are session-specific — don't cache across sessions
- `chart_manage_indicator` needs **full names**: "Relative Strength Index", not "RSI"
- Pine indicators must be **visible** for the pine graphics tools to read them
- Screenshots land in `screenshots/`
- On Git Bash, prefix commands passing `/api/...` paths with `MSYS_NO_PATHCONV=1`
