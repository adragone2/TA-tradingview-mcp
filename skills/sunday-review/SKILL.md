---
name: sunday-review
description: Weekly complete assessment of every ticker TA suggests acting on — full analysis per ticker in a fixed schema, drawn on the chart, plus a validation of TA's suggestion. Use on Sundays, when the user asks for the weekly portfolio review, or asks what TA wants done this week and whether the charts support it.
---

# Sunday Review

A **complete assessment** of every ticker TA is suggesting action on, in a fixed machine-readable schema, with the findings drawn on each chart — and, as one section of that, a validation of TA's suggestion.

It is not a TA-validation tool that happens to look at charts. **It is our own full analysis, which also says whether TA agrees.**

## Run it

```bash
node scripts/sunday-review.js --out-dir reports
```

| Flag | Effect |
|---|---|
| `--limit N` | First N of each side — for a quick check |
| `--holdings` | Add every portfolio position, not only the actionable ones |
| `--no-draw` | Skip chart drawings (faster) |

**~7–12 minutes for ~60 tickers.** It drives the chart through each one on 1D, computes everything offline, draws the findings, and restores the original symbol.

Output: `reports/sunday-review-YYYY-MM-DD.json` — schema v1.0, documented in [docs/sunday-review-schema.md](../../docs/sunday-review-schema.md).

**Do not attempt this conversationally.** Sixty tickers × 26 analysis blocks is far more than a context window holds. The script produces the data; the conversation reads it.

## The schema is a contract

**Every ticker carries every key**, `null` where a measurement was unavailable. Never an absent field. That is what lets TA import it without defensive parsing, and what makes "no value" distinguishable from "no field".

Bump `schema_version` on any breaking change, and update the schema doc in the same commit.

Per ticker, four parts:

1. **`assessment`** — 26 blocks, one per analysis type this repo has a skill for
2. **`our_view`** — our independent bias, computed **before** TA is consulted
3. **`ta_validation`** — whether TA's suggestion holds up against that
4. **`drawings`** — what went on the chart

`our_view` being computed first is what stops the validation being circular.

## Reading it

### Start with `ta_validation_summary` and `our_bias_summary`

Two counts give the shape of the week before any individual name.

### Then every `CONTRADICTED` row

These are not differences of degree — TA and a measurement assert **incompatible** things:

- TA urgency `CRITICAL` while **both** daily and weekly structures are uptrends → *if the stop was breached while the trend is intact, examine the stop placement, not the trend*
- TA cites `HURST_TRENDING` while autocorrelation on those bars shows **no significant persistence**

### Read `market_condition` before blaming individual names

A random walk over 30 bars has expected efficiency **~0.183**. The 0.3 gate means "better than random", not "trending". On the first full run **93% of names were below it** — so "high conviction into chop" is recorded as a *conflict*, not a contradiction, and the market-wide share is stated once in `market_condition.choppy_share_pct`.

**If `broad_chop` is true, say so as a statement about the week's market**, then stop repeating it per name.

### Then `DISPUTED`, then `MIXED`

`NO_SIGNAL` means nothing fired either way. **That is not agreement.**

### Always check `counts.failed`

A failed ticker was **not checked**. It is unknown, not confirming.

## The drawings

Every ticker's findings are drawn on its own chart in group **`sunday-<TICKER>`**, so the report and the chart can be read against each other later:

- Up to 3 supports and 3 resistances, labelled with distance
- Nearest demand and supply zone
- **Only patterns that passed the stability check** — a pattern present at one sensitivity is a fit, not a shape, and does not belong on a chart
- VCP pivot where one qualifies
- **TA's own stop**, in orange, so its placement can be seen against the structure

The prior week's group is cleared before drawing. Remove manually with `draw_clear group="sunday-<TICKER>"`.

## Catalyst evidence travels with the suggestion

TA cites effects from the literature this repo has assessed. Each carries its `evidence_tier`:

| Catalyst | Tier | Why |
|---|---|---|
| `PEAD_DRIFT` | `PORTFOLIO_ONLY` | Real in aggregate, dissolves at firm level — **16.1% of good-news quarters drift negative** |
| `FROG_IN_PAN` | `CROSS_SECTIONAL` | A decile result; see `edge_breadth` for what it retains on one position |
| `HURST_TRENDING` | `DIRECTLY_TESTABLE` | A persistence claim, and we measure persistence on the actual bars |
| `INSIDER_BUY`, `ABOVE_GAMMA_FLIP`, `EXCEED_MODEL` | `NOT_TECHNICAL` | Nothing here can confirm or deny them — say so rather than implying the chart did |

## Reporting to the user

Lead with the two summaries, then contradictions individually with their numbers, then anything disputed. Keep the rest tabular unless asked.

**State the regime distribution.** If most entry candidates sit in choppy regimes, that is a finding about the week's market, not about the names.

## Never

- **Never present our view as overriding TA.** TA is the master system for what to own. This is a second opinion from a different kind of data.
- **Never turn a disagreement into a recommendation.** "TA says sell, our read is bullish" is the finding; what to do is the user's call.
- **Never treat a failed or `NO_SIGNAL` ticker as agreeing.**
- **Never quote a report older than the week** — TA's suggestions change. Regenerate.
- Nothing here is trade advice.

## If the script crashes mid-run

It restores the original symbol on completion, not on crash. Check `chart_get_state` before doing anything else, and expect a partial set of `sunday-*` drawing groups.
