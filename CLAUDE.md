# TradingView MCP — Claude Instructions

**Read [docs/START-HERE.md](docs/START-HERE.md) first.** It is the entry point for this project. This file is the always-loaded index; the docs carry the detail.

157 MCP tools driving a live TradingView Desktop chart over CDP (port 9222), plus the Tactical Alpha API and a separate WRDS server.

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
| [docs/tools-reference.md](docs/tools-reference.md) | All 157 tools (generated — `node scripts/gen-tools-doc.js`) |
| [docs/data-sources.md](docs/data-sources.md) | TA endpoints, WRDS datasets, **freshness rules** |
| [docs/routines.md](docs/routines.md) | Daily and weekly workflows |
| [docs/plugins.md](docs/plugins.md) | FSI plugin skills and how to feed them data |
| [docs/architecture.md](docs/architecture.md) | How the layers connect |
| [docs/playbook.md](docs/playbook.md) | Strategies and patterns from the reference books |
| [docs/research-evidence.md](docs/research-evidence.md) | What the academic evidence supports, what didn't replicate, and what to build next |
| [docs/sunday-review-schema.md](docs/sunday-review-schema.md) | Fixed output contract for the weekly review — TA imports this |
| [docs/swing-evidence-review.md](docs/swing-evidence-review.md) | **Read first.** The owner's own evidence review — tiers A/B/C, and the horizon problem |
| [docs/literature.md](docs/literature.md) | 25 papers, paper by paper — including the ones that contradict our own modules |
| [docs/troubleshooting.md](docs/troubleshooting.md) | Known breakages and causes |
| `skills/` | Step-by-step procedures, invoked by name |

## Decision tree

| The user asks | Do |
|---|---|
| Anything is broken | `tv_doctor` — every failing check carries its fix |
| "What's on my chart?" | `chart_get_state` → `data_get_study_values` → `quote_get` |
| "Analyse this chart" | `chart-analysis` skill |
| "Which timeframe?" / swing vs day | `timeframe_plan` then `mtf_analyze` — context grants permission, structure finds the setup |
| "Is it beating the market?" | `relative_strength` — the only tool that answers "compared to what" |
| "Mark my entry/stop/targets" | `draw_trade_plan` — one call, returns R:R |
| "What should I look at today?" | `morning_brief`, or `catalyst-aware-brief` for event risk |
| Weekly portfolio review / "validate TA's suggestions" | `sunday-review` skill — full assessment of every TA exit/entry in a fixed schema, drawn on the charts. Scheduled Sundays 08:00 |
| "Add the walls" | `walls-overlay` skill (needs the **TA-Trading** layout) |
| "Do I own this? Does it report soon?" | `ta_trading_context` — call **before** acting on a setup |
| "What's the regime?" | `ta_regime` — also carries position sizing |
| "Write a Pine script" | `pine-develop` skill |
| "What's the trend?" / "key levels?" | `market-structure` skill — `structure_analyze`, `levels_find`. Quote each level's evidence |
| "Supply/demand zones?" / "order blocks?" / "SMC" | `supply-demand-setup` skill — `zones_find`. A zone is where price DEPARTED from, not where it reversed |
| "Where does this move project to?" | `fib_targets` — extensions find exits; `fib_levels` finds entries. They get confused constantly |
| "Any patterns?" / "analyse this chart" | `chart-patterns` skill — a *forming* pattern is not a signal |
| "Which symbols qualify?" / a rule with numbers | `strategy-scan` skill — criteria as data, not prose |
| "Did that breakout hold?" | `breakout_check` — 5 measurements; reclaimed next bar = failed |
| "Backtest this" / "does it work?" | `backtest-strategy` skill — **always report buy-and-hold** |
| "How much should I risk?" / "what's my expectancy?" | `risk-sizing` skill — expectancy AND risk of ruin. A win rate means nothing without its payoff |
| "Does this still work after costs?" | `trade_cost` then `costs_vs_edge` — an edge smaller than its costs is a losing strategy |
| "How much risk am I carrying?" | `portfolio_heat` + `position_correlation` — six 1% positions are not 6% if they move together |
| "Count the waves" / "Elliott" | `elliott_survey` — returns EVERY rule-valid count, never one. Disagreement across sensitivities is the finding |
| "What is this candle saying?" | `candle_read` — every candle is momentum, reaction or indecision. `patterns_detect` for named patterns |
| "Any divergence?" / "RSI divergence" | `divergence_survey` — agreement across indicators is the only thing that makes one worth reading |
| "Is this an impulse or a pullback?" | `legs_classify` — three measurements per leg, and it flags a stale last leg |
| "Is it trending?" / "how strong is the move?" | `momentum_read` — 12m/6m/3m/1m at once. The best-replicated effect here; horizons disagreeing IS the answer |
| "Is this a proper base?" / "VCP?" | `vcp_check` — every clause a number, and a near miss names the clause that failed |
| "Is that really converging?" | `pivots_kernel` — pivots read from real bar highs/lows, plus the converging/diverging verdict |
| "Is this backtest real?" | `deflated_sharpe` — the best of 200 no-edge strategies scores 2.19 annualised. Below 0.95 is not a discovery |
| "Did this ever work?" | `wrds_backtest_signal` |
| "Clean up the chart" | `draw_clear` — removes only MCP drawings by default |

## Rules

Each of these exists because it has already gone wrong here.

**Verify — don't trust a success flag.** Eight tools in this codebase were found reporting `success: true` while doing nothing, because their tests asserted things that could not fail. If a tool claims success but the chart didn't change, believe the chart.

**A backtest without a benchmark flatters itself.** Net profit cannot tell a good strategy from a rising market. Always report buy-and-hold over the same bars, and report return *and* drawdown — a strategy often earns its keep by avoiding a drawdown while returning less. Lead with expectancy, not win rate.

**A result without a trial count flatters itself just as badly.** Search 200 strategies with no edge and the best scores an annualised Sharpe of **2.19** with a probabilistic Sharpe of 0.985 — measured, in `tests/validation.test.js`. Deflated for the search it is 0.267. Any scan or backtest that reports a winner must report how many candidates it beat; `deflated_sharpe` does the arithmetic. Below 0.95 is not a discovery. See [docs/research-evidence.md](docs/research-evidence.md).

**A forecast without a persistence baseline flatters itself too.** "Tomorrow equals today" scores ~99% accuracy on daily bars. Published LSTM stock predictors reporting 97% were reproducing exactly that. `momentum_read` returns the baseline beside every reading.

**Every well-evidenced edge here is a PORTFOLIO result. One chart is not a portfolio.** Momentum's Sharpe 1.28 came from 58 futures; the 52-week high effect from 1000+ ranked stocks; PEAD from decile portfolios — and PEAD *dissolves* at the firm level (16% of good-news quarters drift negative). `IR = IC × √BR`: momentum applied to **one** position retains **13%** of its published information ratio and would take ~136 years to prove. Run `edge_breadth` before quoting any study's Sharpe at a single symbol.

**Tools, strategies and workflows are different things.** Tools are capabilities (`src/tools/`), strategies are testable rules (`rules.json`, Pine), workflows are procedures (`skills/`). A tool must not encode a strategy; a strategy must not live in a skill's prose. See [docs/START-HERE.md](docs/START-HERE.md).

**Never invent a price.** Levels come from `drawn_levels`, `drawn_labels`, `price_action`, or TA. If nothing supports one, write `n/a`.

**A 200 is not freshness.** TA stamps `age_hours` from the source file's mtime. Walls past ~30h on a trading day mean TA's scan didn't run. Say the age out loud.

**Live account, live chart.** `draw_clear scope:"all"` deletes the user's own drawings — always ask. `alert_create` makes a real alert that can fire; check the price is on the correct side of spot. `alert_delete` needs explicit ids. Scans drive the chart and must restore it.

**Swing trading sits on top of a sign change.** Below ~21 trading days the documented effect is REVERSAL; above ~63 it is CONTINUATION, and momentum's skip-month exists because the boundary falls inside the swing window. Nearly every structural detector here — flags, triangles, wedges, VCP, breakouts — is a CONTINUATION bet placed at the horizon where continuation is weakest. Run `horizon_prior` before hunting a setup and say which side of the boundary it is on. See [docs/swing-evidence-review.md](docs/swing-evidence-review.md).

**Turnover decides whether a swing strategy can exist.** A 5-day hold is ~50 round trips a year; at 20bps each that is ~10% annually before any edge. `turnover_cost` does the arithmetic, and computes the hysteresis exit that halved turnover while raising net returns.

**A stop-loss is a bet on persistence, not free insurance.** Kaminski & Lo prove the stopping premium is ALWAYS NEGATIVE under a random walk — a stop in a no-persistence market lowers expected return without benefit. It turns positive under momentum, proportional to persistence. Run `stopping_premium` before claiming a stop helps; it may still be right as a solvency constraint, but say which reason applies.

**Candlesticks failed two independent academic tests.** Marshall/Young/Rose (2006, DJIA, random-OHLC bootstrap) and Marshall/Young/Cahan (2008, Tokyo 1975-2004) both found no value — in any sub-period, bull or bear. Report a candle as a description of what the bar did, never as a signal.

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
