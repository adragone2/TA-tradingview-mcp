---
name: ta-decisions
description: Surface Tactical Alpha's entry and exit decisions and draw their levels on the chart. Use when the user asks what to trade today, what needs attention, whether to exit something, or asks to see TA's levels for a symbol.
---

# TA Entry & Exit Decisions

TA computes complete trade plans — entry levels with a put wall and stop distance, exit levels with a stop, call wall and resistance — and they used to live in a CSV nobody could see while looking at a chart. These tools surface them and put them on screen.

**This is the trading layer.** Walls, gamma, entry and exit answer *where do I get in and out of this trade*. Regime and portfolio sizing (`ta_regime`, `max_new_position_pct`) are portfolio-deployment decisions — useful context, but they don't select or time a trade.

## Step 1: What needs attention

```
ta_actionable
```

Exits ordered by urgency, entries by score. **Lead with CRITICAL exits** — those are positions TA says are already past their stop. An entry candidate is never more urgent than a breached stop.

## Step 2: One symbol

```
ta_exit    symbol="CSD"     → urgency, action, exit %, stop, call wall, BB upper, PIF resistance
ta_entry   symbol="CARG"    → action, conviction, suggested size, put wall, BB lower, PIF support
```

Exit decisions exist only for **held positions**; entry decisions only for **current candidates**. A symbol having neither is normal, not an error.

## Step 3: Put it on the chart

```
chart_set_symbol "CSD"
ta_draw_decision
```

Draws every level TA supplied, colour-coded — **stops red, resistance/targets green, support blue** — with labels staggered by price rank so nearby levels stay readable. Grouped as `ta-exit-<TICKER>` or `ta-entry-<TICKER>`, so `draw_clear group="…"` removes exactly that set.

Add gamma walls on top with the [walls-overlay](../walls-overlay/SKILL.md) skill when the symbol is covered.

## Freshness is not optional here

TA's decisions come off its EOD pipeline. Every response carries `age_hours`.

**Past ~30 hours on a trading day, the run did not happen.** A stale exit signal is genuinely misleading: the position may already have been closed, or the stop may have been re-cut. Say the age out loud every time — do not present a two-day-old `SELL_ALL` as today's call.

## Attribution matters

These are **TA's decisions**, not analysis produced here. Say "TA flags CSD as a critical exit — price 135.28 against a 143.24 stop", not "you should sell CSD".

The distinction is not pedantry. TA's numbers carry its own reasoning, thresholds and position context. Restating them as your own recommendation strips the provenance the user needs to judge them — and this toolchain does not produce trade advice.

## Guardrails

- Report the `Reasoning` and `Exit_Reason_Code` when present. "STOP_BREACH detected" is more useful than "TA says sell".
- Never invent a level TA didn't supply. If a row has no call wall, it has no call wall.
- Suggested sizing (`Suggested_USD`, `Suggested_Shares`) is TA's, computed against its own portfolio and cash rules. Pass it through; don't recompute it.
- Entry decisions are candidates TA is *considering*. `BUY_NEW` is TA's classification, not an instruction the user has agreed to.
