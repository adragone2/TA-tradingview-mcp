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

## Guardrails

- Log only what the tools and the user actually provide. Never invent an entry price, a fill, or an outcome.
- A blank `Outcome` column is correct until the user fills it. Do not infer results from later price action unless explicitly asked, and label it as inferred if you do.
- Reviewing a journal is performance bookkeeping, not advice about what to trade next.
