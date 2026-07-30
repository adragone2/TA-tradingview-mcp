---
name: trade-journal
description: Export trade plans and saved session briefs to a spreadsheet for review — entry, stop, targets, R:R, and the bias at the time. Use when the user wants to log a trade, review past plans, or asks "add this to my journal" / "export my trades".
---

# Trade Journal

Turns what was on the chart into a reviewable record. The point is being able to ask later whether the setups that were graded Tier A actually worked.

## Step 1: Collect what to log

**A plan just drawn** — the `draw_trade_plan` response already contains everything: direction, entry, stop, `risk_per_unit`, per-target `rr`, `best_rr`, group, and sizing if it was supplied. Use those numbers directly; do not recompute them.

**Plans on the chart now** — `draw_list_groups` for the groups, then `draw_list` with `include_points: true` to read the levels back.

**Session context** — `session_get` for the bias at the time. A logged trade without the reasoning behind it is much less useful on review.

**Symbol context** — `quote_get` for the price when logged, `chart_get_state` for symbol and timeframe.

## Step 2: Build the row

One row per plan:

| Field | Source |
|-------|--------|
| Date, time | now |
| Symbol, timeframe | `chart_get_state` |
| Direction | plan |
| Entry, stop | plan |
| Targets | plan (one column per target, or a single comma-separated column) |
| R:R best / worst | plan `best_rr` / `worst_rr` |
| Risk per unit | plan `risk_per_unit` |
| Position size | plan `sizing.position_size` if present, else blank |
| Bias at entry | `session_get` for that date |
| Key level cited | the brief's KEY LEVEL for that symbol |
| Rules check | which `rules.risk_rules` this plan satisfies or breaks |
| Outcome | leave blank — filled in later by the user |
| Notes | the plan's thesis in one line |

Leave `Outcome` empty. Never guess or backfill a result.

### Record WHICH BARRIER was hit, not just win or lose

Add these columns. They are the difference between a diary and a dataset:

| Field | Source |
|-------|--------|
| Barrier hit | `target` / `stop` / `time` — which came **first** |
| **Exit reason** | a key from `EXIT_REASONS` in `src/core/exits.js` — see below |
| Bars held | bars from entry to resolution |
| Exit price | the actual fill |
| Ambiguous | `true` if one bar's range contained both stop and target |

### Barrier hit is not the same question as exit reason

`target` / `stop` / `time` are the only three exits a backtest can model, which is precisely why those three alone teach nothing: they cannot separate an exit the **plan** called for from one **decided while the position was live**.

Use the fifteen-key taxonomy in [src/core/exits.js](../../src/core/exits.js) — Bellafiore's Reasons2Sell plus Shannon's two, `gap_against_trend` (a gap of 5% or more against the position) and `ma_crossover` (the moving averages crossing, which Shannon reads as indecision and therefore as an exit and never an entry). Both are **planned**, so leaving them out was pushing modellable exits into `discretionary_other` and understating how much of the book a backtest can represent.

Run `exit_mix` over the column periodically. It splits planned from discretionary and counts the ones driven by the **index** rather than the position — which no single-symbol backtest can see at all.

The reason to bother is not discipline. It is that **a backtest can only model a planned exit**, so if most real exits are discretionary the backtest is measuring a different strategy that merely shares an entry signal. Every rule in this repo about benchmarks, trial counts and deflated Sharpe is void if the exit in the test is not the exit in the account.

Record `discretionary_other` rather than forcing a poor fit. An honest unknown still counts; a wrong label corrupts the distribution.

A plan that emits an entry, a stop and a target **is a triple-barrier problem**: the outcome is decided by which of the three is touched first. `tripleBarrier` in `labeling.js` resolves exactly this, and `backtest_evaluate` reports the ambiguous share.

The review puts it bluntly:

> Systems that emit entry/stop/target levels but never record which barrier was hit are **discarding their own training data on every scan.**

A win/lose column cannot distinguish a target reached in three days from one reached in nineteen, or a stop from a time-expiry. Those are different outcomes with different implications, and without the distinction there is no dataset, no calibration, and no possibility of the persistence testing that separates a strategy from a lucky rule.

**Flag ambiguous resolutions rather than silently scoring them.** When a single bar contained both barriers, OHLC cannot say which came first — this repo resolves those as losses and counts them, and the journal should carry the same flag.

## Step 3: Write the spreadsheet

Use `financial-analysis:xlsx-author` (or the `xlsx` skill) to write or append.

- Default location: `journal/trades.xlsx` in the repo, unless the user names another path. Ask before writing outside the working directory.
- **Append, never overwrite.** Read existing rows first and add to them. Clobbering a trade journal destroys data the user cannot reconstruct.
- Keep one sheet per year if the file grows; keep the column order stable so filters and formulas keep working.

## Step 4: Review mode

When asked to review rather than log, read the sheet and report:
- Win rate and average R by **setup tier** — did Tier A actually outperform Tier B?
- Whether realised R:R matched planned R:R
- Which `rules.risk_rules` were broken most often
- Any pattern by symbol, timeframe, or day

State the sample size next to every statistic. Eleven trades is not a win rate. If the sample is too small to conclude anything, say that instead of reporting a percentage that reads as meaningful.

### Slice it — a profitable book can contain losing halves

Run `journal_slice` over the rows. It cuts by **direction, share size, share price and holding time** and reports P&L per bucket, because an aggregate win rate hides the two things worth knowing: which parts of the book pay, and which quietly do not.

The dimensions are Shannon's, from Figure 16.2 — his own broker's report over three weeks of real trading. Two of its buckets were net **negative** inside a book that made money overall:

| Bucket | Trades | Winners | Average |
|---|---|---|---|
| Share price over $100 | 159 | 47.2% | **−3.82** |
| Held 16–30 minutes | 44 | 50.0% | **−17.93** |

Neither is visible in a headline win rate, and both are actionable in a way "improve your discipline" is not. His shorts also won *more* often than his longs (56.4% vs 52.0%), which is the opposite of what most traders assume about themselves.

**A losing bucket is a hypothesis, not a conclusion.** Cut forty trades four ways and one bucket will look terrible by chance. `journal_slice` reports every bucket's `n`, flags buckets under `min_n` as `underpowered` and refuses to rank them, and states how many buckets it examined so the multiple-comparison problem is visible. Before acting on one, ask whether it has a mechanism, and check whether it survives on the next batch of trades.

## Guardrails

- Log only what the tools and the user actually provide. Never invent an entry price, a fill, or an outcome.
- A blank `Outcome` column is correct until the user fills it. Do not infer results from later price action unless explicitly asked, and label it as inferred if you do.
- Reviewing a journal is performance bookkeeping, not advice about what to trade next.
