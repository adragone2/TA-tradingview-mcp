---
name: supply-demand-setup
description: Find and trade supply and demand zones the way the SMC material teaches it — structure first, then zones at proven swings, then a confirmed return. Use when the user asks about supply/demand zones, order blocks, SMC, smart money concepts, strong/weak highs and lows, or where an institution "left orders".
---

# Supply and Demand Zones

A zone is **where price departed from**, not where it reversed. That is the entire distinction from `levels_find`, and it is worth being precise about because a chart usually answers the two questions at different prices:

| | Question | Evidence |
|---|---|---|
| `levels_find` | Where did price **reverse**, repeatedly? | The tests |
| `zones_find` | Where did price **leave**, fast? | The departure |

Use both. They are complementary, not competing.

## What you can honestly claim

The standard explanation is institutional: a large buyer could not fill their whole order, unfilled bids rest in the zone, and they lift price again on the return.

**That is not visible in OHLCV and nothing in these tools depends on it.** Do not present it as a finding.

What is measured, and all you should report:

- price left this area unusually fast (`momentum_x`),
- how far it got before coming back (`departure_pct`),
- whether it has since reacted here at all (`tests`, `status`).

Every zone comes back with an `evidence` string assembled from exactly those. Quote it. If someone asks *why* a zone should hold, the honest answer is "price left it in a hurry and hasn't traded through it" — not a story about institutions.

## The workflow

Run it in this order. Steps 1 and 2 are what separate a zone worth trading from a rectangle drawn around a big candle.

### 1. Is this market worth trading at all?

```
market_regime
```

`choppy` means stop. Zones in chop are noise — price departs sharply in both directions constantly and every zone gets broken. Say so and stop rather than producing a setup.

### 2. Structure, and which swings the market proved

```
structure_analyze
swing_strength
```

`swing_strength` is the one that matters here. A **strong** swing is one whose move went on to break structure — the market confirmed it. A **weak** swing is one whose move failed to break anything, and those get taken out.

The material's rule: high-quality demand sits at a **strong low**, high-quality supply at a **strong high**. `zones_find` tags this automatically as `at_strong_swing`; a zone carrying that tag has a second, independent reason behind it.

### 3. Find the zones

```
zones_find                        → recent, unbroken zones
zones_find fresh_only=true        → only those price has never returned to
zones_find base_candles=3         → the 3-candle drawing convention
zones_find momentum_multiple=3    → stricter: only very sharp departures
```

Read the counts before reading the zones. `total_found` will typically be 20–40 on 300 bars. **Zones are common.** A returned zone is a place price left quickly, not a place it is obliged to return to.

Each zone reports:

- `kind` — demand (below, price left upward) or supply (above, price left downward)
- `status` — `fresh` (never revisited), `tested` (came back at least once), `broken` (price **closed** through it)
- `grade` — `aggressive` if the departure candle also engulfed the one before it *and* follow-through carried further; otherwise `plain`
- `at_strong_swing` — whether it sits on a swing the market proved

Broken zones are excluded by default. A zone price has closed through is spent, and offering one as support is how someone buys support that is no longer there. A **wick** through is not a break — same discipline as `wyckoff_spring`.

> **"Fresh beats tested" is convention, not a measurement made here.** Report it as the convention it is. If the user wants to weight it, backtest it.

### 4. Wait for the return, and require confirmation

Price arriving at a zone is not the trade. The material is explicit about this and it is the step people skip.

```
patterns_detect            → a reversal candle at the zone
fair_value_gaps            → an unfilled gap inside or near the zone
breakout_check             → if price is breaking the zone rather than respecting it
```

Two or more independent reasons at the same price is the bar. One is not.

### 5. Levels

- **Entry** — the close of the candle that confirmed the zone.
- **Stop** — beyond the far side of the zone. `zones_find` gives you `top` and `bottom`; use them rather than the pattern's own low, which is usually tighter than the zone it sits in.
- **Target** — `fib_targets` for the measured move, or the opposite zone from `zones_find`.

Then:

```
draw_trade_plan entry=... stop=... targets=[...]
position_size ...
```

`draw_trade_plan` returns the R:R. If it comes back under 1.5, say so — the setup being valid does not make the arithmetic work.

## Drawing them

```
zones_draw                      → up to 6, grouped as zones-<TICKER>
zones_draw max_zones=3
draw_clear group="zones-TTD"    → remove them
```

Demand green, supply red. Fresh zones draw more solidly than tested ones. The label carries kind, status, grade and the momentum multiple; the full evidence stays in the tool result.

## The 1-candle vs 3-candle question

You will be asked which is right. **Neither, and it does not matter** — what matters is picking one and keeping it, so results stay comparable. `base_candles` defaults to 1 and the answer always reports which was used. Do not let a discussion of drawing convention substitute for checking whether the zone has anything behind it.

## Vocabulary that is not new capability

The SMC material renames a lot of things that already exist here. Map them rather than reaching for a tool that does not exist:

| SMC term | Already is |
|---|---|
| Order block | A supply/demand zone — `zones_find` |
| Liquidity sweep / grab | A failed break — `wyckoff_spring`, `breakout_check` |
| Liquidity run | A real breakout — `breakout_check` scores it |
| Internal vs external BOS | Minor vs major swings — `structure_analyze lookback=` |
| Strong / weak high / low | `swing_strength` |
| Imbalance | Fair value gap — `fair_value_gaps` |
| Premium / discount | Retracement depth — `fib_levels` |

## Reporting

Lead with the regime and the structure, then the zone, then the confirmation. A zone with no structural backing and no confirmation is a rectangle, and should be reported as one.

Never invent a price. Zone boundaries come from `zones_find`; targets from `fib_targets` or another zone. If nothing supports a number, write `n/a`.

This is not trade advice — it renders the user's own criteria against their own chart.
