# Start Here

You are working with a trading toolchain built around a live TradingView chart. This is the entry point — read it before doing anything else, then follow the links for depth.

## The three layers

They do different jobs. Confusing them produces confident nonsense.

| Layer | What it is | Use it for |
|-------|-----------|------------|
| **TradingView MCP** (this repo) | 121 tools driving a live TradingView Desktop chart over CDP | Charts, levels, entries, drawings, Pine. **Trading.** |
| **Tactical Alpha (TA)** | The master system on a VPS, reached through `ta_*` tools | Portfolio, earnings, regime, gamma walls, watchlists. **Investing.** |
| **WRDS** (separate `wrds-mcp` server) | Read-only SQL over academic market data | Historical research and validating whether a rule ever worked. |

**TA is the master.** It holds the databases, watchlists and positions. This MCP renders TA's view on a chart and reads the chart back. It does not duplicate TA's research.

**WRDS is not live.** CRSP daily data ends 2024. It answers "did this rule ever have edge", never "what is happening now".

## First moves in any session

```
tv_doctor          → is everything wired up? every failing check carries its fix
chart_get_state    → what symbol, timeframe and indicators are loaded
ta_health          → is the TA API reachable and is a key configured
```

If `tv_doctor` fails, fix that before anything else. It distinguishes "TradingView isn't running" from "the MCP server won't load" from "your key is wrong", which otherwise all look the same.

## Which tool answers which question

| The user asks | Use |
|---|---|
| "What's on my chart?" | `chart_get_state` → `data_get_study_values` → `quote_get` |
| "Analyse this chart" | [chart-analysis](../skills/chart-analysis/SKILL.md) skill |
| "What's the trend?" / "where's the structure?" | [market-structure](../skills/market-structure/SKILL.md) skill — `structure_analyze`, never read off a screenshot |
| "Where are support and resistance?" | `levels_find` → `levels_draw`. Quote each level's `reason` |
| "Mark my entry / stop / targets" | `draw_trade_plan` — one call, never hand-built from `draw_shape` |
| "How much should I buy?" | `position_size`, or `position_read` for a plan the user drew by hand |
| "What should I look at today?" | `morning_brief`, or [catalyst-aware-brief](../skills/catalyst-aware-brief/SKILL.md) for event risk |
| "Add the walls" / "plot gamma levels" | [walls-overlay](../skills/walls-overlay/SKILL.md) skill |
| "Do I already own this?" / "does it report soon?" | `ta_trading_context` |
| "What's the market regime?" | `ta_regime` — also carries position sizing |
| "Write a Pine indicator" | [pine-develop](../skills/pine-develop/SKILL.md) skill |
| "Which of these qualify?" / a rule with numbers in it | [strategy-scan](../skills/strategy-scan/SKILL.md) skill — `strategy_check`, `strategy_scan` |
| "Does this strategy work?" / "backtest this" | [backtest-strategy](../skills/backtest-strategy/SKILL.md) skill — always report the benchmark |
| "Did this setup ever work?" | WRDS `wrds_backtest_signal` |
| "Write this up" / "preview the earnings" / "screen for ideas" | An FSI plugin skill — see [plugins.md](plugins.md) first |
| "Clean up the chart" | `draw_clear` — removes only what these tools drew |

Full inventory: [tools-reference.md](tools-reference.md). Where data comes from and how stale it can be: [data-sources.md](data-sources.md).

## Rules that matter

These exist because each one has already gone wrong here.

**Verify, don't assume.** Several tools in this codebase historically reported `success: true` while doing nothing. Fixed ones now verify and throw. If a tool returns a warning or a partial result, report that — don't round it up to success.

**Never invent a price.** Levels come from `drawn_levels`, `drawn_labels`, `price_action`, or TA. If nothing supports a level, write `n/a`.

**A 200 is not freshness.** TA stamps `age_hours` on its responses from the source file's mtime. Walls more than ~30h old on a trading day mean TA's scan didn't run — the levels describe positioning that may be gone. Say the age out loud.

**These tools touch a live account.** `draw_clear` defaults to removing only MCP drawings — never pass `scope: "all"` without asking. `alert_create` makes a real alert that can fire and notify; check the price is on the correct side of spot first. `alert_delete` needs explicit ids.

**The chart is the user's workspace.** Scanning drives it through symbols and restores it afterwards. Don't leave them somewhere unexpected, and don't run long sweeps without saying how long it will take.

**Nothing here is trade advice.** It renders the user's own criteria and TA's own output. R:R and position size are arithmetic on numbers they supplied. Present it as context.

## Three categories — keep them straight

They are enriched separately, and conflating them is how this repository would rot.

| | **Tools** | **Strategies** | **Workflows** |
|---|---|---|---|
| What it is | One capability, one call | A set of rules — objective and testable | An ordered procedure using several tools |
| Where it lives | `src/tools/`, `src/core/` | `rules.json`, Pine strategy scripts | `skills/*/SKILL.md` |
| Example | `levels_find`, `backtest_drawn` | a `strategies` block in rules.json | [backtest-strategy](../skills/backtest-strategy/SKILL.md) |
| Answers | *What can I do?* | *What am I testing?* | *In what order, and what do I check?* |

A tool must not encode a strategy — `levels_find` computes levels, it does not decide whether to buy them. A strategy must not live in a skill's prose, or it cannot be backtested. A workflow is where judgement, sequencing and the honesty checks belong.

When adding something, ask which category it is. A capability that needs a sequence of calls and a judgement call is a **workflow**, not a tool.

## Where things live

```
docs/          this repository's documentation — start here, then the files below
skills/        WORKFLOWS — step-by-step procedures, invoked by name
src/tools/     TOOLS — one MCP tool per capability
rules.json     STRATEGIES — the user's own bias criteria, risk rules and watchlist
wrds-mcp/      separate MCP server for historical research
```

- [architecture.md](architecture.md) — how the layers connect, and what runs where
- [tools-reference.md](tools-reference.md) — all 121 tools by group
- [data-sources.md](data-sources.md) — TA endpoints, WRDS datasets, freshness
- [routines.md](routines.md) — the daily and weekly workflows
- [plugins.md](plugins.md) — the FSI plugin skills, and how to feed them data
- [troubleshooting.md](troubleshooting.md) — known breakages and their causes

## The FSI plugins

Five are installed (Financial Analysis, Equity Research, Market Researcher, Earnings Reviewer, Wealth Management). Use them for **analysis and written work products** the MCP tools don't produce — earnings previews, screens, thesis records, journals, peer comps.

One trap: they were built for FactSet/CapIQ connectors that are **not** wired up here. Supply data from WRDS and TA instead — [plugins.md](plugins.md) has the mapping. If a skill's data source is missing and you cannot substitute it, say so and stop rather than filling the gap.
