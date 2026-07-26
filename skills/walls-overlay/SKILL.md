---
name: walls-overlay
description: Load Tactical Alpha's gamma walls into the Institutional Matrix indicator on the chart, replacing manual JSON entry. Use when the user asks to plot walls, refresh walls, load gamma levels, or says the matrix data is stale.
---

# Walls Overlay

TA's `walls_scanner` computes call/put OI walls, GEX walls, gamma flip and implied move per expiry horizon. The Institutional Matrix Pro indicator renders them from a compact JSON string that was previously pasted in by hand — so it went stale, and could end up describing a different instrument than the chart.

These tools read the walls from TA and write them in.

## Step 1: Make sure the indicator is on the chart

The Institutional Matrix lives on the **TA-Trading** layout:

```
layout_switch  "TA-Trading"
```

`walls_apply` finds the study by name and will tell you if it isn't present.

## Step 2: Check coverage before promising anything

```
walls_coverage
```

Walls come from option chains, so they exist only for names with a liquid one — currently ~44 tickers spanning the watchlist: equities (AMD, AVGO, META, MSFT, GOOGL, NFLX, TSM, ASML, LLY …) and ETFs (SMH, SPY, QQQM, VOO …). Coverage tracks TA's watchlist, so it moves. If the user asks for a symbol that isn't in it, say so plainly rather than writing zeros into the indicator.

## Step 3: Apply

For the symbol already on the chart:

```
walls_apply
```

For a specific symbol, or a sweep:

```
walls_apply   symbol="SMH"
walls_apply_many   symbols=["SMH","XLK","XLE"]
```

`walls_apply_many` switches the chart to each symbol in turn and restores it afterwards. Note the indicator holds **one symbol's walls at a time** — that is how the Pine input works. Applying across a list pre-loads each one as the chart passes through; it does not display them all simultaneously. Don't imply otherwise.

Use `dry_run: true` to inspect the JSON without writing.

## Two ways to render walls

| | `walls_apply` | `walls_draw` |
|---|---|---|
| Renders | Into the Institutional Matrix indicator | Native chart lines |
| Needs | The TA-Trading layout | Nothing |
| Also shows | VIX/VVIX, flip, expected move, its own DATA FRESH/STALE verdict | Just the levels |
| Updates | Recalculates with the chart | Static snapshot |
| Readable back | No | Yes — `draw_list`, cleared by group |

**Prefer `walls_apply` where the indicator is present** — it renders more than lines can. Reach for `walls_draw` when the indicator isn't on the layout, when you want walls alongside entry/exit levels in one visual system, or when the levels need to be read back.

```
walls_draw                                  → daily + weekly, OI + GEX + flip
walls_draw horizons=["d"] include_gex=false → just the daily OI walls
walls_draw merge_within_pct=1.0             → fewer lines, more aggressive merging
```

Levels closer than `merge_within_pct` (default 0.5%) merge into one line carrying both labels — a flip at 583 between GEX walls at 582 and 585 is three unreadable overlapping labels otherwise. Raise it when a symbol's levels cluster tightly.

Drawn as `walls-<TICKER>`, so `draw_clear group="walls-SMH"` removes exactly that set.

> **The indicator keeps the last symbol you applied.** After `walls_apply` on AMD, switching the chart to SMH leaves AMD's flip showing in the panel. Re-apply per symbol, or use `walls_draw`, which is always the symbol you drew it for.

## Step 4: Report freshness honestly

TA stamps every response with `X-Data-Generated-At` and `X-Data-Age-Hours`, taken from the source file's mtime — **a 200 does not mean the data is current**. Responses carry `as_of` and `age_hours`.

TA refreshes walls each weekday shortly after **19:30 UTC**. Past roughly **30 hours on a trading day, something upstream broke** — say so and tell the user to flag it to TA. This is not hypothetical: the scanner was silently starved out of TA's execution lock for five days, serving stale walls with no error.

The indicator renders its own verdict in the panel — `DATA FRESH` or `DATA STALE (Nh)` — computed from the same `ts`. If your report and the panel disagree, trust the panel and investigate.

Also surface, don't bury:
- Any horizon whose strength key is 0 — that horizon has no data and its walls are written as zeros
- Walls computed around a spot far from current price

## What the numbers mean

| Key | Meaning |
|-----|---------|
| `dCW` / `wCW` / `mCW` | Call OI wall — daily / weekly / monthly expiry |
| `dPW` / `wPW` / `mPW` | Put OI wall |
| `dCGX` / `wCGX` / `mCGX` | Call GEX wall |
| `dPGX` / `wPGX` / `mPGX` | Put GEX wall |
| `dS` / `wS` / `mS` | Strength: 4 when either side's OI clears TA's threshold, 2 otherwise, 0 when that horizon has no data |
| `flip` | Gamma flip level, from the weekly horizon (or daily if weekly is absent) |
| `im` | Implied move |
| `vix` / `vvix` | Read live from TA so the panel matches TA's own volatility view |
| `ts` | Snapshot date — what the indicator uses to decide it is stale |

## Guardrails

- These are levels TA computed from option positioning. They describe where dealer hedging concentrates, not what price will do. Present them as context, not as signals.
- Never hand-edit the JSON to "fill in" a missing horizon or a symbol with no coverage. A zero is honest; an invented level is not.
- The write is verified — if `walls_apply` reports the input did not take, the study was likely removed or its input layout changed. Don't retry blindly.
