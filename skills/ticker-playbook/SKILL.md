---
name: ticker-playbook
description: End-to-end analysis of one ticker — match it against every screener, identify which catalogued strategies apply, examine the chart, draw the findings, and produce entry/exit levels with the indicators to add. Use when asked to "analyse TICKER", "how would I trade TICKER", "what setup is on TICKER", or "is TICKER worth a look".
---

# Ticker playbook

The whole workflow for one symbol: **data → screens → strategies → chart → plan → drawings → indicators.**

## There is ONE analysis workflow. It is `ticker_analyze`.

```
ticker_analyze holding_days=... days_to_catalyst=...
```

Everything below describes how to READ what it returns. It is not a second path.

**One measurement, one drawer, one contract:**

| Layer | Module | Also used by |
|---|---|---|
| Measure | `assess()` — 30 blocks | morning screen, Sunday review |
| Judge | `ourAssessment()` — bias, conviction, cautions, tradeable | morning screen, Sunday review |
| Draw | `drawFindings()` — geometry, channels, levels, plans | morning screen, Sunday review |
| Score | `scoreAnalysis()` against `analysis_contract.js` | this workflow |

`assess()` opens with the rule that governs all of this:

> *"The morning screen needs the SAME assessment, and the obvious move — copy it across — is
> the one thing that must not happen here. Two copies drift, and the drift is silent."*

That rule was broken once and it cost real output. `ticker_analyze` was first written
hand-rolling structure, levels, patterns, momentum, divergence, VCP and the horizon prior beside
`assess()` — silently dropping **multi_timeframe, supply_demand_zones, wyckoff, elliott,
fibonacci, liquidity, costs, channels and trade_plans**. It also drew one horizontal line per
pattern instead of calling `drawFindings`, which erased the channel boundaries, wedge edges,
flag poles and head-and-shoulders the charts had carried for months. The owner noticed the
drawings had degraded before any review did: *"yesterday you drew a channel, on other tickers
you drew wedges, triangles etc. It seems you are not doing this anymore."*

**Before adding anything to this workflow, check whether it already exists.** The failure mode
is not a missing capability — it is a worse duplicate built beside a better original.

The chain is **scored against a contract**, so anything that did not run comes back in
`completeness.missing` with a reason. Read `completeness.summary` first.

**Read `completeness.summary` first and put it at the top of the write-up.** An analysis
missing a required section must say so, rather than reading as though the section found
nothing. On a live DLO run it correctly reported `INCOMPLETE — 2 of 9 required section(s) did
not run: position_and_calendar, screens`.

**Nothing is outside the workflow.** This used to list four things it "deliberately does not
do" — position and calendar, the screens, group and regime, relative strength — each with a
reason that was true and useless. All four run now. The last one had a reason that was simply
wrong: *"loading a benchmark would move the chart mid-analysis."* It does move the chart, for
about a second, and then moves it back — while NOT loading it meant `assess(bars, null)`, so
`relative_strength.leadership` came back **null on every analysis** and the completeness score
marked the section OK because the block object exists with null fields inside it.

A declared skip is still a step somebody has to remember, and a step somebody has to remember
is a step that eventually does not happen.

The steps below remain the reference for what each section means and how to read it.

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

**It is measured in TRADING DAYS, so below daily bars it does not apply.** On a 5-minute chart
`horizon` comes back **NOT APPLICABLE** with its reason, and the completeness score counts that
as neither a pass nor a failure — `All 11 applicable required sections ran. 1 do not apply here:
horizon.` Quoting a daily-horizon prior beside an intraday setup attaches evidence to a position
closed before the session ends.

On `group_context`: read it as a **description**. Two-leader agreement was measured and *hurts* —
it discarded 58% of signals and cost 9.3 points of win rate.

## Step 3 — Read the chart

Set the timeframe the analysis needs; never assume the one that happens to be loaded.

```
chart_set_symbol → chart_set_timeframe → chart_get_state
```

**Which timeframe** comes from the EXECUTION TIER, and `src/core/timeframe_policy.js` owns it:

| Tier | Analysis | Context | Bars |
|---|---|---|---|
| intraday | **5-minute** | 15-minute | 800 ≈ 10 sessions, traded 10:15–14:30 ET |
| weekly / monthly | **daily** | weekly macro | 400, 4-hour to fine-tune the entry |

A daily chart cannot show an intraday setup — a whole session is one bar, so an opening range
or a VWAP reclaim is not merely hard to see, it is *not representable*. The morning routine got
this wrong and analysed every candidate on the daily, including the intraday ones.

Two traps come with an intraday chart:

- **A fresh 5-minute chart holds 300 bars — two sessions** — and `data_get_ohlcv` caps a read at
  500, which is three. `chart.loadHistory` extends it; without that, an intraday analysis reads
  *less* history than the daily one it replaced.
- **`assess()` measures fixed BAR COUNTS** — 252/126/63/21, captioned 12m/6m/3m/1m. On 5-minute
  bars 252 bars is **3.2 sessions**. Every number stays correct and every calendar label on it
  goes false. Read `timeframe_calibration` in the result and quote the bar counts.

Then run the [market-structure](../market-structure/SKILL.md) skill, or directly:

```
structure_analyze     → HH/HL/LH/LL, trend, BOS, CHoCH
legs_classify         → impulse vs pullback, AND time corrections
levels_find           → support/resistance with the evidence for each
volatility_state      → coiled or expanded
momentum_read         → 12m/6m/3m/1m, and whether they agree
relative_strength     → against SPY, because "strong" needs a "compared to what"
```

**Then run the pattern pass. It is not optional, and "none" is a result worth reporting.**

```
patterns_detect       → structural + candlestick, each with its noise floor
vcp_check             → 0% noise floor, so a pass here is worth something
wyckoff_spring        → also 0%; a spring needs a CLOSE back inside, not a wick
divergence_survey     → agreement across RSI/MACD/OBV/MFI; one alone is 99% noise
elliott_survey        → every rule-valid count, never one
```

Read `patterns_detect` carefully, because three of its fields decide the answer:

- **`status`** — `forming` is NOT a signal. A pattern completes when price CLOSES through
  its completion level, and Bulkowski's statistics are measured *from the breakout onward*,
  so they do not apply to a forming shape. The tool says so; repeat it.
- **`noise_check`** — compares each detection against its random-walk rate. 68% of random
  walks contain at least one structural pattern, so a detection *at* the floor is nothing.
- **`breakout_levels`** on NR4/NR7/inside bars — these are the concrete numbers an entry
  hypothesis is built from.

**Two forming patterns can point opposite ways on the same bars.** That is not a bug and not
something to resolve by picking the one you prefer — it is the finding. Report both with
their completion levels and say the chart does not favour either.

**Watch the `symbol` field on every one of these.** A scheduled scan drives the chart symbol
by symbol, and `scripts/morning-screen.js` running in the background will move it out from
under an analysis mid-pass. It has already happened: a `vcp_check` during a DLO analysis came
back stamped `BATS:AMLX` and the chart finished on `BATS:PANW`. Every chart-reading tool
returns the symbol it actually read — compare it to the one you asked for, and if it differs,
discard the result and re-run. Do not merge it into the report.

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

### Always give a forward entry hypothesis — even when the answer is "don't buy it here"

```
entry_hypothesis holding_days=... days_to_catalyst=...
```

A report that only describes the present is not actionable. This returns, for **both**
directions, a trigger price with the event required at it, a stop, the invalidation, and R:R
measured at the trigger:

```
TRIGGER      the price AND the event — "a daily CLOSE above 15.37", not "around 15.40"
STOP         from structure, then checked against 1x ATR
INVALIDATION the price that ends the idea, usually the opposite pattern completing
R:R          at the trigger, not at today's price
```

Triggers come from a forming pattern's `completion_level`, a swing extreme, or an existing
level — in that order, and `trigger_basis` says which, with the third labelled the weakest.
A side with none of the three returns `available: false` and a reason rather than a rounded
guess. Pass `holding_days` and `days_to_catalyst` and it flags a trigger that would put you
into the event.

Two fields worth reading rather than skimming: `stop_widened_from` names a level that was
rejected for sitting inside 1× ATR, and `chasing_warning` fires past 10% (Livermore).

Three things that make a hypothesis honest rather than decorative:

- **Give the bear case a trigger too.** If a bearish pattern is forming, its completion level is
  the short/exit hypothesis and it belongs in the same table as the long one.
- **A confirmed pattern whose target price has already been reached is HISTORY, not a setup.**
  Check the target against the high since completion before quoting Bulkowski's statistics at
  it. An inverse H&S with a 15.83 target on a chart that has since printed 16.78 has already
  paid out; its 71% meeting-target rate is not a forecast of anything still to come.
- **Say when the hypothesis cannot be reached in time.** A trigger 5% away with earnings in
  four sessions is a trigger that probably will not fire before the event.

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

**Clear the chart FIRST, and clear it COMPLETELY.** The owner's instruction is explicit:
*"you need to clear all drawings from a chart before an analysis."* Drawings from earlier
runs survive, and a stale level from a previous session is indistinguishable from one this
analysis just proved.

```
draw_clear scope:"all"   → FIRST, before any reading is drawn
levels_draw              → the two primaries, anchored to the swing extremes
patterns_draw            → every detected pattern's completion level
draw_trade_plan          → entry/stop/targets, grouped
zones_draw               → only with confluence; a zone alone has a 99.5% noise floor
capture_screenshot       → confirm it rendered as intended
```

**Never draw a pattern with `draw_shape` by hand.** `patterns_draw` exists precisely because
that was being done: a hand-written label matches no signature in `MCP_TEXT_SIGNATURES`, and
entity IDs die with the TradingView session, so the drawing can never be swept up again. It
draws each pattern's **completion level** — the price at which a shape stops being a shape and
becomes a fact, which is the only line on a pattern that is also a trigger. Bullish patterns
are labelled *completes*, bearish ones *breaks at*, because a rising wedge breaking DOWN
through support is not the same event as a flag completing UP through its high.

Targets are off by default: a measured move assumes the pattern behaves typically, and on a
forming pattern it is projected off a shape that has not happened. Candlestick patterns are
never drawn — single visible bars, and two independent academic tests found no value in them.

**Why `all` and not `mcp` here.** `scope:"mcp"` only removes drawings matching a signature in
`MCP_TEXT_SIGNATURES`, so anything written by older code, by a scan, or by TradingView's own
pattern tools survives it. On a live DLO run `scope:"mcp"` left a Head / Left Shoulder /
Right Shoulder annotation on the chart that was not the owner's and not this toolchain's —
and it was nearly reported as the owner's own analysis. `scope:"all"` is the reliable reset.

**It still deletes hand-drawn work, so it is only safe because the owner asked for it as the
default for an ANALYSIS.** Outside that workflow, ask. And note `scripts/clear-orphans.js`
solves a different problem — recovering drawings orphaned by a session restart without
touching anything hand-drawn.

### `levels_draw` draws TWO lines: the primary support and resistance

The owner's rule, verbatim: *"you should draw only the primary support and resistance and if I
ask you you show the next one and so on."*

The primaries are anchored to the **last confirmed swing low and swing high** — the levels that
BOUND the range — not to whatever is nearest price. `tier: 2` walks out to the next level
beyond each, `tier: 3` the one after. Everything not drawn comes back in `interior` and
`beyond`.

**Two rankings were tried on a live chart and both failed. Do not reintroduce either.**

1. **By `score`** — put six supports and no resistance on a name sitting under overhead supply.
   Score is driven by test count, and touch count carries no measured information about whether
   a level holds.
2. **By proximity** — worse, and it fails precisely when it matters. With price mid-range the
   nearest levels are the congestion price is *inside*. Measured on DLO, the three nearest were
   traded through **16.7%, 16.7% and 21.7%** of the last 60 bars — the three worst on the chart
   — while the swing-anchored resistance at 15.54 was traded through **0.0%** with containment
   1.000.

That through-rate is the tell: a level price cuts across is not a level. `mode:"band"` keeps
the ATR-band behaviour with `pins` for your stop and targets, but it is no longer the default.

If a side has no level within 3% of its swing extreme, the tool falls back to the nearest one
and sets `anchored: false` with a warning — "on the swing high" and "nearest thing above price"
are different claims and only one is structural.

One thing `levels_draw` will do quietly: it ranks by score and takes the top N, and
support levels routinely outscore resistance. Asking for 6 on a name sitting under
overhead supply returned **six supports and no resistance**. Raise `max_levels` or check
the `counts` field — the levels that matter for a position underwater are the ones above it.

**Live chart.** `draw_clear` defaults to MCP-only drawings. **An ANALYSIS is the exception the
owner asked for and `ticker_analyze` passes `scope:"all"` by default** — see the section above for
why `mcp` is not enough there. Anywhere else, ask first. The unattended morning batch narrows back
to `mcp` deliberately: it walks twenty machine-selected charts with nobody present to be asked.
If you add a new label format, append its signature to `MCP_TEXT_SIGNATURES` or it leaks an orphan
that can never be cleaned up.

**Only the VERDICT SIDE is drawn.** `drawFindings` takes the bias from `ourAssessment` and filters
both the pattern geometry and the trade-plan legs. Drawing everything put a bullish wedge targeting
22.3 and a bearish head-and-shoulders targeting 8.19 on one chart at 11.67 — 22 shapes, and a stop
above the price beside a target far below it. What was withheld comes back in `patterns_skipped`
and `plans_suppressed`; read them, because a disagreement between the sides is *why* a verdict
reads NEUTRAL.

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

**The ribbon already plots MA 50 and MA 200.** Its four slots have SMA 50 and SMA 200 enabled and the
EMA 8 / EMA 100 slots off, so the chart permanently carries **Volume, MA 50 and MA 200**. A strategy
naming any of those three needs nothing added — `group_leader_momentum` names exactly MA(50), MA(200)
and Volume, so all three free slots stay free. Adding a separate `Moving Average` at 50 or 200 is a
duplicate that costs a slot; `coveredByPermanent` in `src/core/chart_budget.js` catches it, matching on
the period as well as the name, because MA(20) is genuinely absent while MA(50) is genuinely present.

If the analysis needs a value from an indicator that will not fit, read it with
`data_get_study_values` in a separate pass rather than leaving it on the chart.

Three things that make this fail quietly if ignored:

- `chart_get_state` returns the field as **`studies`**, not `indicators`.
- `chart_manage_indicator` returns `success: false` **without throwing** when TradingView rejects a
  name. The tool checks the flag *and* the new-study count, then re-reads the chart to verify.
- Study names must be **exact**: `Moving Average` works, `Simple Moving Average (50)` does not — the
  period is an **input**, not part of the name.
- **An `inputs` override can be ignored while the add still reports success.** `createStudy`'s fourth
  argument takes raw values **positionally**, in the study's own declared input order, not
  `[{id, value}]` objects — so `Moving Average` with `{length: 200}` silently became a **9-period** MA
  reading 14.58 instead of 13.40. Compounding it, `getInputValues()` returns `[]` until the study
  finishes loading, so setting inputs immediately after creating matched nothing and wrote nothing.
  Both are fixed, and `chart_manage_indicator` now returns `inputs_verified` with the values read back
  from the property tree. **Check that flag, and sanity-check the value against the number the analysis
  computed** — a 200-period MA that does not match `strategy_check`'s `sma(200)` is not a 200.

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
PATTERNS     forming vs confirmed, each with its noise floor. "None" is a real answer
LEVELS       each with its reason. `n/a` if nothing supports one
PLAN         entry / stop / targets / R:R, and the binding size constraint
ENTRY HYPOTHESIS  the price you would act at, as a trigger + stop + invalidation —
             for BOTH directions, even when the verdict is "no trade today"
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
