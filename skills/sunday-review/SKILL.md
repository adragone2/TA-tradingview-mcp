---
name: sunday-review
description: Weekly complete assessment of TA's WHOLE book — every exit, entry and holding — as the full unified analysis per ticker in a fixed schema, drawn on the chart, plus a validation of TA's suggestion. Report schema 2.0. Use on Sundays, when the user asks for the weekly portfolio review, or asks what TA wants done this week and whether the charts support it.
---

# Sunday Review

A **complete assessment** of every ticker TA holds or is suggesting action on, in a fixed machine-readable schema, with the findings drawn on each chart — and, as one section of that, a validation of TA's suggestion.

It is not a TA-validation tool that happens to look at charts. **It is our own full analysis, which also says whether TA agrees.**

It is also the SAME analysis everything else here runs: one call to `analyzeTicker`, which is `assess()` + `ourAssessment()` + `drawFindings()` + the 23 context sections + the completeness score. It used to call the first three directly, which is how the review of real money ended up thinner than the morning candidate screen.

## Run it

```bash
node scripts/sunday-review.js --out-dir reports
```

**TradingView Desktop must be up with CDP on port 9222** — check `tv_doctor`
first. If it is closed, or open without the debugging port, `tv_launch` starts
it. Call that ONLY when the check has actually failed: it defaults to
`kill_existing: true`, which is what reattaches CDP to an already-running
TradingView and is destructive against a healthy session. It also returns
`success: true` when CDP never came up, so re-run `tv_doctor` afterwards rather
than trusting the flag.

| Flag | Effect |
|---|---|
| `--limit N` | First N of each side — for a quick check |
| `--no-holdings` | **Opt OUT** of the held positions. Holdings are IN by default — do not pass this on a scheduled run |
| `--no-draw` | Skip chart drawings (faster) |
| `--tickers A,B,C` | Named tickers only. TA's list re-orders live, so `--limit 1` is not reproducible — use this to re-check one name |
| `--out-dir DIR` | Where the report lands (default `reports/`) |

**~15–20 minutes for ~62 tickers.** It drives the chart through each one on 1D, computes everything offline, draws the findings, and restores the original symbol.

Output: `reports/sunday-review-YYYY-MM-DD.json` — **schema v2.0**, documented in [docs/sunday-review-schema.md](../../docs/sunday-review-schema.md). TA imports this file; [docs/ta-importer-migration-2.0.md](../../docs/ta-importer-migration-2.0.md) is the paste-ready prompt for migrating its importer.

**Do not attempt this conversationally.** Sixty tickers × 28 analysis blocks plus 23 context sections is far more than a context window holds — the report is ~6MB. The script produces the data; the conversation reads it programmatically.

### The whole book, with exclusions stated rather than silent

**`--holdings` was opt-in and the scheduled task never passed it.** Measured 2026-07-30: TA held **73 positions**, the actionable list was 53, and **35 holdings were never queued** — ANET, AVGO, VOO, VXUS, ICVT, COPX, HYDR, ILIT, RING, SLVP among them. A weekly portfolio review that silently skipped half the portfolio.

The owner's rule: *"The sunday routine analyzes all TA tickers period. no exclusions."* An opt-in flag on a scheduled job IS an exclusion by default, so holdings are now in unless `--no-holdings`.

**Crypto is excluded, with a reason per line**, in `excluded_from_review[]` and counted in `counts.excluded`. TA owns the crypto book on the investing layer; this is the equity trading layer. It is also the safe call: **`BTC-USD` does not fail on the chart — it lies.** TradingView reads the hyphen as a SPREAD operator, so `BTC-USD` silently resolves to `CRYPTOCAP:BTC-BATS:USD`, returns 300 bars, and every detector runs happily on a synthetic series that is not the price of Bitcoin. Verified live for BTC, ETH and USDC. The decision and the trap live in `src/core/ta_symbols.js` so nobody "fixes" it by passing crypto through.

**EXCLUDED is not FAILED.** A failed ticker was attempted and could not be read; an excluded one was never charted here at all. Report them separately — collapsing them makes a scope boundary read as breakage. On the 2026-07-30 run: 62 requested, 59 analysed, 3 failed (CQTM and SKHY too few bars, VIIIX a NAV-priced fund with no intraday range), 25 excluded, all crypto.

## The schema is a contract

**Every ticker carries every key**, `null` where a measurement was unavailable. Never an absent field. That is what lets TA import it without defensive parsing, and what makes "no value" distinguishable from "no field".

Bump `schema_version` on any breaking change, and update the schema doc in the same commit.

### 2.0 moved three keys — everything the analysis produces is under `analysis`

| 1.0 | 2.0 |
|---|---|
| `ticker.assessment` | **`ticker.analysis.assessment`** |
| `ticker.our_view` | **`ticker.analysis.verdict`** |
| `ticker.drawings` | **`ticker.analysis.drawings`** |

Nothing was deleted or renamed in place. **`ta_suggestion` and `ta_validation` stay at the ticker top level** — they are the one thing here that is not part of the shared analysis.

A 1.0 path read off a 2.0 report returns `undefined`; it does not throw. That is how a whole section vanishes from a summary with nothing said, which is exactly what happened to the scheduled prompt.

Per ticker:

```
ticker, symbol, resolution, bars, status, error, side
ta_suggestion        what TA said, unmodified
ta_validation        whether OUR read supports it        ← top level, not under analysis
analysis
  assessment         28 blocks, one per analysis type, incl. channels and trade_plans
  verdict            our independent bias, computed BEFORE TA is consulted (was our_view)
  drawings           what went on the chart, plus patterns_skipped / plans_suppressed
  completeness       scored against the 45-section contract — complete, missing[], not_applicable[]
  context            portfolio_heat, short_interest, pivot_trail, luld_band, sizing, screens, ...
  entry_hypothesis   forward entry, both directions
  primary_levels     the swing-anchored primary support and resistance
```

`verdict` being computed first is what stops the validation being circular.

A `failed` ticker still carries every key, with `analysis` and `ta_validation` `null`. It was not checked — that is not the same as agreeing.

### `completeness` — a skipped section is reported, not absent

`analysis.completeness` carries `complete`, `required_done`/`required_total`, `missing[]` **with a reason each**, `not_applicable[]`, and a one-line `summary` ("All 12 applicable required sections ran."). 1.0 had no such property: a section that did not run was simply not there.

**A section in `not_applicable` is neither a pass nor a failure.** `horizon_prior` below daily is the standing example — it is measured in trading days, so it reports NOT APPLICABLE rather than failing, and the score must not count that as a gap. `completeness_summary` at the top level counts complete/incomplete across the run; the `incomplete` key is **absent** when it is zero, so read it as `?? 0`.

### `context.portfolio_heat` — the whole book, read once

`analysis.context.portfolio_heat` is TA's ENTIRE book on every row, not this symbol's slice: heat is a cross-position quantity, and reading it from the analysed symbol alone made it meaningless. It is sized against **the book's own equity** (`equity_basis`, `equity_source`), NOT the trading account in `rules.json` — those are the investing and trading layers and must not be divided into each other. Quote it once, with its `caveat`: heat assumes every stop fills at its price, and treats positions as independent when they are not.

### `analysis.assessment.trade_plans` — entry, stop and target per pattern

Every detected pattern carries its levels. Two things to respect:

- **`tradeable_now` is false for a forming pattern.** Its levels are what WOULD confirm it, not a live setup.
- **Bilateral patterns carry BOTH legs.** Triangles, broadening formations and rectangles do not know which way they break. A typed rectangle (`bullish_rectangle` / `bearish_rectangle`) adds `primary_leg` naming the continuation — but the other leg stays planned, and Bulkowski's numbers say the *upward* break is the better one regardless of approach, so a bearish rectangle's continuation leg is the weaker of its two.

R:R is arithmetic on the levels. Quote the pattern's `base_rate` beside it or the number flatters itself — a 5.46 R:R on a rising wedge that fails 51% of the time is not a good trade.

### `analysis.assessment.channels` — quote the stability count

A channel is found on **33.5%** of random walks and 12% of walks produce a "stable" one. A single-window fit is not a shape. `windows_agreeing` and `stable` are the fields that matter, not `found`.

## Reading it

### Start with `ta_validation_summary` and `our_bias_summary`

Two counts give the shape of the week before any individual name.

### Then every `CONTRADICTED` row

These are not differences of degree — TA and a measurement assert **incompatible** things:

- TA urgency `CRITICAL` while **both** daily and weekly structures are uptrends → *if the stop was breached while the trend is intact, examine the stop placement, not the trend*
- TA cites `HURST_TRENDING` while autocorrelation on those bars shows **no significant persistence**

### Read the market condition before blaming individual names

A random walk over 30 bars has expected efficiency **~0.183**. The 0.3 gate means "better than random", not "trending". On the first full run **93% of names were below it** — so "high conviction into chop" is recorded as a *conflict*, not a contradiction, and the market-wide share is stated once rather than per name.

**Take the distribution from the top-level `market_condition` block** — `regime_counts`, `choppy_share_pct`, `median_efficiency` beside `random_walk_efficiency`, and `broad_chop`. Drop to `analysis.assessment.market_regime.regime` per ticker only when you need the split by name. On the 2026-07-30 run the split was 50 choppy / 6 mixed / 3 trending, 84.7% choppy, median efficiency 0.174 against the 0.183 baseline.

That block was assembled from 1.0 paths for the whole of schema 2.0's first life and emitted `{regime_counts: {}, choppy_share_pct: null, broad_chop: false}` on every real report — a **dead optional-chain path returns `undefined`, not an error**, so `broad_chop: false` meant *the block did not read*, not *the market is fine*. Fixed in `scripts/sunday-review.js`; `tests/sunday_prompt.test.js` holds the source contract that keeps it fixed.

**If most names are below the gate, say so once as a statement about the week's market**, then stop repeating it per name.

### Then `DISPUTED`, then `MIXED`

`NO_SIGNAL` means nothing fired either way. **That is not agreement.**

### Always check `counts.failed` — and `counts.excluded` beside it

A failed ticker was **not checked**. It is unknown, not confirming.

An **excluded** ticker was never charted on this layer at all, and `excluded_from_review[]` gives the reason per line. That is a scope boundary, not breakage — report the two separately, and never let either read as agreement.

## The drawings

Every ticker's findings are drawn on its own chart in group **`sunday-<TICKER>`**, so the report and the chart can be read against each other later:

- Up to 3 supports and 3 resistances, labelled with distance
- Nearest demand and supply zone
- **Only patterns that passed the stability check** — a pattern present at one sensitivity is a fit, not a shape, and does not belong on a chart
- **Pattern GEOMETRY, not just the break level.** Wedges and triangles use TradingView's own 5-point pattern tool anchored to real pivots; rectangles draw as a box; flags and pennants draw the pole as a line and the pause as a box; tops/bottoms connect the peaks and add the neckline
- **Channel boundaries** where a channel was found, as two parallel lines
- **ENTRY / STOP / TARGET** lines, but only for patterns that are `tradeable_now` — a forming pattern's levels are a hypothesis and do not belong on the chart as if they were live
- VCP pivot where one qualifies
- **TA's own stop**, in orange, so its placement can be seen against the structure

The prior week's group is cleared before drawing. Remove manually with `draw_clear group="sunday-<TICKER>"`.

**If old drawings will not clear**, they are from a previous TradingView session — entity IDs die with the app, so `draw_clear` cannot see them. Run `node scripts/clear-orphans.js` (dry run; `--apply` to delete). It identifies them by label text and leaves hand-drawn work alone.

**If you add or change a drawn label, append its format to `MCP_TEXT_SIGNATURES` in `src/core/orphans.js`.** A label with no signature leaks a drawing that can never be cleaned up. There is a test that lifts every label template out of this script and checks it.

## Catalyst evidence travels with the suggestion

TA cites effects from the literature this repo has assessed. Each carries its `evidence_tier`:

| Catalyst | Tier | Why |
|---|---|---|
| `PEAD_DRIFT` | `PORTFOLIO_ONLY` | Real in aggregate, dissolves at firm level — **16.1% of good-news quarters drift negative** |
| `FROG_IN_PAN` | `CROSS_SECTIONAL` | A decile result; see `edge_breadth` for what it retains on one position |
| `HURST_TRENDING` | `DIRECTLY_TESTABLE` | A persistence claim, and we measure persistence on the actual bars |
| `INSIDER_BUY`, `ABOVE_GAMMA_FLIP`, `EXCEED_MODEL` | `NOT_TECHNICAL` | Nothing here can confirm or deny them — say so rather than implying the chart did |

## Reporting to the user

Lead with the counts — analysed, failed and **excluded stated separately** — then the two summaries, then contradictions individually with their numbers, then anything disputed. Keep the rest tabular unless asked.

**State the regime distribution**, computed from `analysis.assessment.market_regime.regime`. If most entry candidates sit in choppy regimes, that is a finding about the week's market, not about the names.

**Quote portfolio heat once** from `analysis.context.portfolio_heat` — the whole book, with its caveat — and **name any ticker whose `analysis.completeness.complete` is false**, with the sections in `.missing`. A section in `.not_applicable` is not a gap.

## Never

- **Never present our view as overriding TA.** TA is the master system for what to own. This is a second opinion from a different kind of data.
- **Never turn a disagreement into a recommendation.** "TA says sell, our read is bullish" is the finding; what to do is the user's call.
- **Never treat a failed or `NO_SIGNAL` ticker as agreeing.**
- **Never quote a report older than the week** — TA's suggestions change. Regenerate.
- Nothing here is trade advice.

## If the script crashes mid-run

It restores the original symbol on completion, not on crash. Check `chart_get_state` before doing anything else, and expect a partial set of `sunday-*` drawing groups.
