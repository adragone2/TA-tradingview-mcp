# The analysis workflow

How a ticker becomes a trade plan, end to end, and what each stage is allowed to conclude.

The executable version is the [ticker-playbook](../skills/ticker-playbook/SKILL.md) skill. This page
is the architecture: what connects to what, which piece was missing, and where the workflow is
*designed to stop*.

---

## The chain

```
   TICKER
     │
  ┌──▼──────────────────────────────────────────────────┐
  │ 0  POSITION & CALENDAR    ta_trading_context        │  can end it: earnings inside the hold
  ├─────────────────────────────────────────────────────┤
  │ 1  WHICH SCREENS?         ticker_playbook           │  can end it: passes nothing, no near miss
  │      reverse screener — 8 swing + 2 intraday        │
  │      clause by clause, with near misses             │
  │                    ↓                               │
  │    WHICH STRATEGIES?     from strategies.json       │  ranked by evidence tier
  ├─────────────────────────────────────────────────────┤
  │ 2  CONTEXT               group_context              │  can end it: horizon fights the setup
  │                          horizon_prior              │
  │                          ta_regime                  │
  ├─────────────────────────────────────────────────────┤
  │ 3  READ THE CHART        market-structure skill      │
  │                          structure_analyze, legs_classify,
  │                          levels_find, volatility_state,
  │                          momentum_read, relative_strength
  ├─────────────────────────────────────────────────────┤
  │ 4  CONFIRM               strategy_check              │  refuses REJECTED entries with the measurement
  ├─────────────────────────────────────────────────────┤
  │ 5  PLAN                  draw_trade_plan             │  entry/stop/targets, R:R per target
  ├─────────────────────────────────────────────────────┤
  │ 6  SIZE                  position_size_constrained   │  the MINIMUM of three constraints wins
  │                          pivot_trail + stopping_premium
  ├─────────────────────────────────────────────────────┤
  │ 7  DRAW                  draw_clear FIRST, then        │  clear before drawing, every time
  │                          levels_draw, draw_trade_plan,
  │                          zones_draw, capture_screenshot
  ├─────────────────────────────────────────────────────┤
  │ 8  INDICATORS            chart_indicators_for_strategy│  driven from the catalogue
  ├─────────────────────────────────────────────────────┤
  │ 9  REPORT                fixed shape, tiers quoted    │
  └─────────────────────────────────────────────────────┘
```

## The pattern pass, and the entry hypothesis

Two omissions found by running this on a live name, both of which make a report read as
complete when it is not.

**Patterns are part of step 3, and "none" is a result.** `patterns_detect`, `vcp_check`,
`wyckoff_spring`, `divergence_survey` and `elliott_survey` all belong in the chart read. Three
fields decide what a detection is worth: `status` (`forming` is not a signal — Bulkowski
measures from the breakout onward, so his statistics do not apply to a forming shape),
`noise_check` (64.5% of random walks contain at least one structural pattern), and
`breakout_levels` on NR4/NR7/inside bars, which is where a concrete trigger price comes from.
Two forming patterns can point opposite ways on the same bars — report both and say the chart
does not favour either, rather than picking one.

**A confirmed pattern whose target has already been hit is history.** Check the target against
the high since it completed. A DLO inverse H&S completed at a 13.495 neckline with a 15.83
target on a chart that then printed 16.78 — the pattern paid out months ago, and quoting its
71% meeting-target rate as though the move were still ahead would be wrong.

**Every report needs a forward entry hypothesis**, stated as a conditional and given for both
directions: a trigger price and the *event* at it (a daily close, not "around" a number), a
stop from structure checked against 1x ATR, the invalidation price, and the R:R measured at
the trigger rather than at today's price. Build the trigger from something already on the
chart — a pattern's `completion_level`, an NR7 `breakout_levels` value, a level. If the
trigger cannot plausibly be reached before a known catalyst, say so.

## Two things that go wrong at step 7 and 8

Both were found running this workflow against a live chart, not in a test.

**Clear before drawing.** Drawings from earlier runs survive, and a stale level from a
previous session looks exactly like one this analysis just proved. A live DLO run found
**12 orphaned MCP shapes** already on the chart; the new levels were drawn on top of them.
`draw_clear scope:"mcp"` first — it never touches hand-drawn shapes — then check
`remaining_shapes`. Anything left is either the user's own or an orphan from a restarted
TV session, which `node scripts/clear-orphans.js` finds by label text.

Also: `levels_draw` ranks by score and takes the top N, and support levels routinely
outscore resistance. Asking for 6 returned **six supports and no resistance** on a name
sitting under overhead supply — hiding the only levels that mattered for a position held
at a loss. Read the `counts` field rather than trusting the count you asked for.

**The permanent studies are Volume, MA 50 and MA 200 — three, not two.** The Moving
Average Ribbon has four MA slots with SMA 50 and SMA 200 enabled and EMA 8 / EMA 100 off.
So `group_leader_momentum`, which names MA(50) + MA(200) + Volume, needs **nothing added**
and all three free slots stay free. `coveredByPermanent` in `src/core/chart_budget.js`
matches the period as well as the name, since MA(20) is genuinely absent while MA(50) is
genuinely present.

And an `inputs` override could be silently ignored while the add still reported success:
`createStudy`'s fourth argument takes raw values **positionally** in the study's declared
input order, not `[{id, value}]` objects, so `Moving Average` with `{length: 200}` produced
a **9-period** MA reading 14.58 where the real sma(200) was 13.40. `getInputValues()` also
returns `[]` until the study finishes loading, so setting inputs straight after creating
matched nothing and wrote nothing. Both are fixed and `chart_manage_indicator` now returns
`inputs_verified`, read back from the property tree — check it, and cross-check the number
against what `strategy_check` computed.

## What was missing, and is now built

The workflow existed as pieces. Three joints did not.

| Gap | Why it blocked the workflow | Built |
|---|---|---|
| **No reverse screener** | Screens ran universe-first only. `SCREENS` was not imported by a single tool, so the only way to learn whether a symbol passed `momentum_pullback` was to scan the whole universe and look for it. There was no way to ask "what is this ticker" at all. | `ticker_playbook`, [screen_check.js](../src/core/screen_check.js) |
| **No screen → strategy link** | The catalogue named a screener per strategy, but nothing walked it backwards from a passing screen to the strategies it implies. | the `strategies` field on each result |
| **No catalogue → chart link** | Every strategy already named its TradingView studies and `chart_manage_indicator` adds them by full name — nothing drove one from the other. | `chart_indicators_for_strategy` |

Two things that were *not* missing and are worth knowing about: `strategy_check` already evaluated a
strategy's criteria against the chart symbol, and `chart-analysis` already covered steps 3 and 5
thoroughly. The new skill orchestrates rather than replaces them.

## Screens are a coarse filter, not a verdict

The two-stage design in [screening.md](screening.md) is load-bearing here:

- **Stage 1** is TradingView narrowing the universe on cheap fields.
- **Stage 2** is this repo's own detectors returning a verdict.

`ticker_playbook` is stage 1 run backwards. **Passing a screen means "worth looking at".** Of 20
catalogued strategies: 3 Tier A, 4 Tier B, 5 Tier C, **6 REJECTED**. A report that lists matches
without their tiers has thrown away the only part that distinguishes evidence from a hypothesis.

**Near misses are often the more useful output.** "Fails RSI by 2 points" tells you what to wait for;
a bare "no match" tells you nothing.

## Where the workflow is designed to stop

Stopping is a result, and each of these has its own reason:

| Condition | Reason |
|---|---|
| No screen passes and nothing is close | There is no setup. Manufacturing one is the failure mode. |
| Earnings inside the intended hold | Shannon: *"make sure that you are not holding a stock position ahead of the report."* |
| Only REJECTED strategies match | Each has been measured here to have no edge over its own null. |
| Continuation setup on a 2–10 day hold | The reversal zone — the setup fights its own horizon. |
| Regime is chop **and** the horizon disagrees | Two independent reasons. |

## The three things this workflow cannot establish

Every report should carry these, because the machinery looks more conclusive than it is.

**1. Alignment is not an edge.** Three confirmation gates have been measured in this repo and all
three failed:

| Gate | Result |
|---|---|
| `level_pressure` pressure clause | +39.1 in sample → **+4.6 on a fresh universe with more data** |
| `stage_plan` Stage 2 gate | long **33.5% vs a 36.4% baseline**; 4 configurations, none favouring it |
| Livermore's two-leader Key Price | **−9.3 points** (21.6% vs 30.9%), discarding 58% of signals |

The shared mechanism: a confirmation rule describes what has *already* happened, and below ~21
trading days the documented effect is reversal.

**2. Every well-evidenced effect here is a portfolio result.** Momentum's Sharpe 1.28 came from 58
futures; the 52-week-high effect from 1000+ ranked stocks. `IR = IC × √BR` — applied to one position,
momentum retains about **13%** of its published information ratio. Run `edge_breadth` before quoting
a study's Sharpe at a single symbol.

**3. Nothing above includes costs.** A 5-day hold is ~50 round trips a year, roughly **10% annually
at 20bps** before any edge exists. `trade_cost` then `costs_vs_edge`.

## Related

- [ticker-playbook](../skills/ticker-playbook/SKILL.md) — the executable procedure
- [strategies.md](strategies.md) — the catalogue, generated from `strategies.json`
- [screening.md](screening.md) / [screening-parameters.md](screening-parameters.md) — the screens
- [chart-analysis](../skills/chart-analysis/SKILL.md) — reading a chart you were already given
- [routines.md](routines.md) — the daily and weekly flows this sits inside
