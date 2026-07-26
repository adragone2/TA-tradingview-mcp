# Using the FSI Plugins

Five Anthropic FSI plugins are installed: **Financial Analysis** (18 skills), **Equity Research** (15), **Market Researcher** (5), **Earnings Reviewer** (6), **Wealth Management** (9).

They are worth using, but not naively. Read this before invoking one.

## The data problem, and the fix

These plugins were built around **FactSet, CapIQ and Daloopa MCP connectors**. None of those are connected here — `mcp__factset__*` and `mcp__capiq__*` do not exist in this environment.

A skill that expects them will otherwise stall or, worse, produce confident output from nothing. **Supply the data yourself** from what is actually available:

| The skill wants | Get it from |
|---|---|
| Fundamentals, financial statements | WRDS `comp` (Compustat) |
| Estimates, revisions, announcement dates | WRDS `ibes` |
| Company/deal/transcript data | WRDS `ciq` (**Capital IQ is available through WRDS**) |
| Prices, returns | WRDS `crsp`, or the live chart |
| Portfolio, positions, exposure | TA `ta_portfolio` |
| Upcoming earnings dates | TA `ta_earnings` — **not** WRDS, which is historical |
| Sector rotation, regime, macro | TA `ta_regime`, `ta_get /api/sectors` |
| Current quotes and levels | This MCP |

State where the numbers came from in the output. A valuation built on 2024 CRSP data is not a current valuation, and must not read like one.

## Worth using

**`equity-research:thesis-tracker`** — pairs with `session_save`. The repo's own [thesis-tracking](../skills/thesis-tracking/SKILL.md) skill covers the chart side; this handles the written thesis record.

**`equity-research:earnings-preview` / `earnings`** — genuinely useful for swing holds through a report. Feed it TA's earnings date and WRDS `ibes` estimates. Pair with the historical reaction question: how has this name moved on its last several reports?

**`equity-research:morning-note`** — formatting for the written brief. See [morning-note](../skills/morning-note/SKILL.md).

**`equity-research:screen` / `idea-generation`** — screening across a universe. WRDS can supply the quantitative side; TA supplies what is already held so ideas aren't just existing positions.

**`financial-analysis:xlsx-author` / `audit-xls`** — the trade journal, and checking it. See [trade-journal](../skills/trade-journal/SKILL.md).

**`financial-analysis:comps`** — peer relative valuation. On a swing horizon this answers "is this stretched versus its peers", which is real context for a multi-week hold. Compustat and CapIQ via WRDS can feed it.

**`wealth-management:portfolio-rebalance` / `tax-loss-harvesting`** — TA holds the portfolio, so these have something to work on. Note the ledger (cost basis, lots, realised P&L) is **deliberately unreachable** with this key, so TLH in particular cannot see the tax lots it needs. Say so rather than estimating.

## Use with care

**`equity-research:sector-overview`** — TA already computes sector rotation with 7d/21d returns and leader/laggard signals. Prefer `ta_get /api/sectors`; use the skill for the write-up, not the analysis.

**`equity-research:catalyst-calendar`** — TA's `/api/earnings` is the authoritative source for dates here. Use the skill's structure, TA's data.

## Skip for trading

These value companies on quarters of fundamentals. On an intraday-to-weeks horizon they add cost, not signal — and most cannot run without the missing connectors:

`dcf-model`, `lbo-model`, `3-statement-model`, `initiating-coverage`, `model-update`

Presentation tooling — `pptx-author`, `deck-refresh`, `ib-check-deck`, `ppt-template-creator` — is fine if the user explicitly wants a deck, and irrelevant otherwise.

Client-facing Wealth Management skills — `client-report`, `proposal`, `financial-plan`, `client-review` — assume advising a third party. That is not what this setup is for.

## The rule

Reach for a plugin skill when the user wants **analysis or a written work product** that the MCP tools don't produce. Don't reach for one to re-derive something TA already computes, and don't run a valuation model on a day trade.

If a skill's data source is missing and you cannot substitute it, say so and stop. Do not fill the gap with plausible numbers.
