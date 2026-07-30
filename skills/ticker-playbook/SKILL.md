---
name: ticker-playbook
description: End-to-end analysis of one ticker — match it against every screener, identify which catalogued strategies apply, examine the chart, draw the findings, and produce entry/exit levels with the indicators to add. Use when asked to "analyse TICKER", "how would I trade TICKER", "what setup is on TICKER", or "is TICKER worth a look".
---

# Ticker playbook

The whole workflow for one symbol: **data → screens → strategies → chart → plan → drawings → indicators.**

This is the skill to run when someone names a ticker. `chart-analysis` reads a chart you were
already given; this one starts from the symbol and works out *what it is* before looking at it.

**Nothing here is advice.** Every number is arithmetic on the user's own criteria and on measured
base rates. Say so once at the end and do not soften it.

---

## Step 0 — Position and calendar, before anything

```
ta_trading_context symbol="TICKER"
```

Do you already own it? Does it report soon? Both change the answer, and finding out afterwards
wastes the analysis. Shannon is explicit: **hold nothing into an earnings report** — "make sure
that you are not holding a stock position ahead of the report."

If earnings are inside the intended hold, say so at the top of the report, not in a footnote.

## Step 1 — What is this? Match it against every screener

```
ticker_playbook symbol="TICKER"
```

This is the reverse screener. It returns, clause by clause:

- which of the **8 swing screens** and **1 intraday screen** the symbol passes
- **near misses** — one clause away, with the gap. This is often the more useful output: "fails RSI
  by 2 points" tells you what to wait for
- the **strategies** each passing screen implies, ranked by evidence tier, each with its entry
  rule, exit rule, indicators, skills and tools
- which screens were **skipped** and why (session-restricted ones are not evaluated on data that
  cannot support them)

**Read the tiers before anything else.** A screen is a coarse filter — passing one means *worth
looking at*. Of 20 catalogued strategies, 3 are Tier A, 4 are Tier B, 5 are Tier C and **6 are
REJECTED outright**. If the only matches are Tier C, say that plainly.

If it passes nothing and has no near miss, **stop and say so**. Cash is a position, and this
toolchain's own measurements say most setups do not beat entering arbitrarily.

## Step 2 — Context the chart cannot show

Run these three before opening the chart, because each can end the analysis:

```
group_context symbol="TICKER"      → which industry group, who leads it, is it a leader or a laggard
horizon_prior                       → which side of the reversal/continuation boundary the hold sits on
ta_regime                           → regime, and TA's own position sizing for today
```

**The horizon check is load-bearing.** Below ~21 trading days the documented effect is
**REVERSAL**; above ~63 it is continuation; 11–63 days is a gap where neither is documented. Almost
every structural setup — breakouts, flags, triangles, VCP — is a *continuation* bet. If the
intended hold is 2–10 days and the strategy is a continuation one, name the conflict.

On `group_context`: read it as a **description**. Two-leader agreement was measured and *hurts* —
it discarded 58% of signals and cost 9.3 points of win rate.

## Step 3 — Read the chart

Set the timeframe the analysis needs; never assume the one that happens to be loaded.

```
chart_set_symbol → chart_set_timeframe → chart_get_state
```

Then run the [market-structure](../market-structure/SKILL.md) skill, or directly:

```
structure_analyze     → HH/HL/LH/LL, trend, BOS, CHoCH
legs_classify         → impulse vs pullback, AND time corrections
levels_find           → support/resistance with the evidence for each
volatility_state      → coiled or expanded
momentum_read         → 12m/6m/3m/1m, and whether they agree
relative_strength     → against SPY, because "strong" needs a "compared to what"
```

Four things to carry forward from these:

- **`since_last_leg`** — swings need bars to their right, so the last leg always ends some way
  back. If price has moved since, never describe the last leg as what price is doing now.
- **Time corrections** — a flat, quiet digestion is a correction with no depth. A depth-based
  reading reports "no pullback" and skips a live setup.
- **Level evidence** — quote each level's `reason`. Ignore its touch count: measured, it carries
  no information about whether the level holds next time.
- **Momentum horizons disagreeing IS the answer**, not a problem to resolve.

## Step 4 — Confirm the strategy against the chart

For each candidate from Step 1:

```
strategy_check strategy_name="<name>"
```

It evaluates the criteria as data and shows the **actual value on each side of every comparison**.
A criterion whose operands cannot be resolved is UNKNOWN, never a fail.

A REJECTED strategy is refused here *with the measurement* — that is the tool working, not an error.

## Step 5 — Levels, then the plan

Entry and exit come from the strategy's own rules plus the levels on the chart. Do not invent them.

```
draw_trade_plan     → entry/stop/targets in ONE call, returns R:R per target
```

Where the levels come from, by strategy family:

| Family | Entry | Stop | Target |
|---|---|---|---|
| Pullback / momentum | first new higher high after the pullback, not the touch | below the most recent higher low | prior high, or measured move |
| Breakout | a CLOSE beyond the level, volume at least normal | just beyond the broken level | measured move; `fib_targets` for extensions |
| Reversal / spring | the reclaim close, never the wick | below the spring low | the range high |
| Monthly factor | the monthly rebalance, not a chart trigger | rank deterioration, not a price | the next rerank |

Two entry-quality checks that are easy to skip:

- **Are you chasing?** Livermore: more than **5–10% above the trigger** and the edge is gone.
- **Is the stop inside the noise?** A stop closer than 1× ATR gets hit by ordinary bar range rather
  than by being wrong. `position_size_atr` with `manual_stop` compares the two.

## Step 6 — Size it, and let the binding constraint win

```
position_size_constrained account_size=... entry=... stop=... adv=...
```

**The risk budget alone is not the answer.** Under fixed risk a *tighter* stop buys *more* shares,
so the concentration cap binds exactly when the entry looks best — Shannon's own example turns a 1%
budget on $100,000 into a **$66,650** position. Report `binding_constraint`.

Pass `adv` or the liquidity constraint comes back **NOT CHECKED**, and unknown is not satisfied.

Then, if the position will be trailed:

```
pivot_trail direction="long"     → a new higher high promotes the stop to the last higher low
stopping_premium                 → does this series have the persistence a trail assumes?
```

A trail is a bet on persistence. On 9 of 12 real holdings there was none.

## Step 7 — Draw it

Mark only what survived its checks.

```
levels_draw           → the levels, labelled with their evidence
draw_trade_plan       → entry/stop/targets, grouped
zones_draw            → only with confluence; a zone alone has a 99.5% noise floor
capture_screenshot    → confirm it rendered as intended
```

**Live chart.** `draw_clear` defaults to MCP-only drawings; never pass `scope:"all"` without asking.
If you add a new label format, append its signature to `MCP_TEXT_SIGNATURES` or it leaks an orphan
that can never be cleaned up.

## Step 8 — Put the indicators on the chart

```
chart_indicators_for_strategy strategy_name="<name>"
```

Drives the studies from the catalogue's own `indicators` field.

**The chart has a budget.** `Volume` and `Moving Average Ribbon` are permanent and the cap is **5
studies**, so at most **3** may be added. Several strategies name more than that — `momentum_pullback`
names five — and the tool reports what it **dropped** rather than silently truncating. Pass
`clear_added: true` to free the non-permanent slots when moving from one strategy's indicators to
another's.

If the analysis needs a value from an indicator that will not fit, read it with
`data_get_study_values` in a separate pass rather than leaving it on the chart.

Three things that make this fail quietly if ignored:

- `chart_get_state` returns the field as **`studies`**, not `indicators`.
- `chart_manage_indicator` returns `success: false` **without throwing** when TradingView rejects a
  name. The tool checks the flag *and* the new-study count, then re-reads the chart to verify.
- Study names must be **exact**: `Moving Average` works, `Simple Moving Average (50)` does not — the
  period is an **input**, not part of the name.

Pine graphics tools need a study **visible** to read it.

## Step 9 — Report

Lead with the decision, then the evidence, then what would change it.

```
TICKER — <name> · <group> · <close>

VERDICT      trade / watch / no setup, and the strategy if there is one
EVIDENCE     the tier, and the measurement behind it
HORIZON      which side of the boundary, and whether the strategy fights it
SCREENS      passed, and the near misses worth waiting for
STRUCTURE    trend, last confirmed leg, staleness if any
LEVELS       each with its reason. `n/a` if nothing supports one
PLAN         entry / stop / targets / R:R, and the binding size constraint
CATALYSTS    earnings inside the hold, and the LULD band
WHAT KILLS IT  the specific condition that invalidates this
```

### Rules for the report

- **Never invent a price.** Levels come from `levels_find`, `drawn_levels`, `price_action` or TA. If
  nothing supports one, write `n/a`.
- **Every base rate with its sample size.** A percentage without an n reads as meaningful when it is
  not.
- **Quote the tier.** "Tier C, practitioner source, unmeasured here" is the honest form.
- **Say what would change your mind.** An analysis with no invalidation condition is a story.
- **One disclaimer, at the end, unhedged.** These tools render the user's own criteria; R:R and size
  are arithmetic on numbers they supplied. Not advice.

---

## When to stop early

Stopping is a result. Say which of these fired:

| Condition | Why stop |
|---|---|
| Passes no screen, no near miss | There is no setup. Do not manufacture one. |
| Earnings inside the intended hold | Shannon holds nothing into a report |
| Only REJECTED strategies match | Each has been measured to have no edge over its own null |
| Regime says chop and the horizon fights the setup | Two independent reasons to sit out |
| Continuation setup on a 2–10 day hold | The reversal zone. Name it and let the user decide |

## What this workflow does NOT establish

Worth saying at the end of any report, because the machinery looks more conclusive than it is:

- **Passing screens is not an edge.** Three alignment/confirmation gates have been measured here and
  all three failed — `level_pressure` out of sample, `stage_plan`'s gate forward-tested negative,
  and Livermore's two-leader Key Price costing 9.3 points.
- **Every well-evidenced effect here is a PORTFOLIO result.** One chart is not a portfolio. Run
  `edge_breadth` before quoting any study's Sharpe at a single symbol.
- **Costs are not in any of it.** `trade_cost` then `costs_vs_edge`; a 5-day hold is ~50 round trips
  a year, about 10% annually at 20bps before any edge.
