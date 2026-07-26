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

Walls come from option chains, so they exist only for names with a liquid chain — currently ~22 sector ETFs (SMH, XLK, XLE, KRE, IBB, …), **not** individual equities like AMD or AVGO. If the user asks for a symbol with no chain, say so plainly rather than writing zeros into the indicator.

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

## Step 4: Report freshness honestly

Every response carries `as_of` and `age_days`, and a warning past ~3 days. The indicator itself renders `DATA STALE (Nh)` in its panel from the same timestamp.

Walls move with the option chain. A snapshot from last week describes positioning that may have rolled off entirely — say the age out loud rather than presenting old levels as current. If the data is stale, the fix is on TA's side: its walls scanner needs to run.

Also surface, don't bury:
- `THIN_CHAIN` status on a horizon — those levels are unreliable
- Any horizon missing from the snapshot (its keys are written as 0)
- `spot_at_snapshot` far from current price — the walls were computed around a different price

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
