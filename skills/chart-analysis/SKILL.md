---
name: chart-analysis
description: Read a chart end to end and report what is actually there — regime, structure, levels, zones, patterns, and whether there is a trade. Use when the user asks you to analyse, review, or "look at" a chart or a symbol.
---

# Chart Analysis

The whole toolchain, in the order that keeps the answer honest.

**The order is the method.** Running the same tools in a different order produces a different report, because the early steps decide whether the later ones mean anything. A pattern found in chop is noise; a level quoted without its evidence is a guess with a price attached.

## Step 0 — Position and calendar, before anything

```
ta_trading_context symbol=<SYM>
```

Do you already own it? Does it report earnings this week? A perfect technical read on a stock reporting tomorrow is not actionable, and TA is the master system for that question. Say what it returns before analysing.

## Step 1 — Set up, and read the chart you were given

```
chart_set_symbol / chart_set_timeframe   → only if the user named one
chart_get_state                          → symbol, timeframe, indicators, entity IDs
quote_get                                → live price
```

If the user did not specify a timeframe, **analyse the one already loaded** and say which it is. Do not silently switch.

## Step 2 — Is this market worth reading at all?

```
market_regime
```

This is the gate, not a formality.

- `choppy` (efficiency below ~0.3) → **say so and stop hunting.** Structure breaks are noise, patterns appear that are not there, stops get run. The honest report is "no setup here", and the efficiency ratio is how you say it with a number instead of a feeling.
- `trending` → the rest of the analysis carries weight.
- `mixed` → proceed, but discount everything.

A report that finds a setup on a chart with efficiency 0.06 has failed, however many tools it ran.

## Step 2.5 — Which timeframe, and does it agree with the one above it?

```
timeframe_plan style=swing        → which three timeframes this style implies
mtf_analyze base_label=1D         → trend and regime across three at once
```

Timeframes step by a factor of 4-6 into three screens: **context** grants permission, **structure** finds the setup, **trigger** times it. Swing is weekly/daily/hourly; day trading is daily/hourly/15m.

`mtf_analyze` aggregates upward from the loaded bars, so the chart is never switched.

- **Read `alignment.permitted_direction` before looking for a setup.** A daily long inside a weekly downtrend is countertrend, and the tool says so in those words. Take it if you like, but say it out loud.
- **Check `partial_last_bar`.** A half-finished weekly bar can show a reversal that has not happened. It is the commonest way multi-timeframe analysis misleads.
- For US equities the swing trigger is **1H, not 4H** — a 6.5-hour session makes a 4H bar only ~1.6x a daily, too close to be a separate screen. `swing_24h` is the crypto/FX variant.

## Step 3 — Structure

```
structure_analyze          → trend, HH/HL/LH/LL, BOS, CHoCH
legs_classify              → each leg impulse or pullback, and staleness
swing_strength             → which swings the market actually proved
```

**Always read `since_last_leg`.** Swings need bars to their right to confirm, so the last leg always ends some way back. When price has moved since, the warning says so — never describe the last leg as what price is doing now.

`legs_classify` also flags a "pullback" that travelled further than the impulse before it. That shape is a trend change, not a retracement.

## Step 4 — Where price is, relative to what

```
levels_find                → support/resistance with evidence
volume_profile             → POC, value area, high/low volume nodes
anchored_vwap              → anchored to the last major swing
```

**Quote each level's `reason`.** "733 — 7 tests, flipped, 27 bars traded within it" can be argued with. "733" cannot.

> **The failure mode to watch for:** after a large decline, every swing-derived level sits *above* price and `levels_find` returns nothing below. That is a real finding, not a tool failure — **there is no tested support beneath price.** Say exactly that, then give the nearest reference that does exist: the value-area low from `volume_profile`, a round number, or the prior range low. Never leave "nearest support" blank, and never invent one.

## Step 4.5 — Compared to what?

```
relative_strength benchmark=AMEX:SPY
```

No single-symbol tool can answer this, and it changes the read. A stock up 8% looks strong until its index is up 12%.

- Read `leadership` **and** `leadership_note`. A recent bounce inside long-term underperformance comes back as `mixed`, not `outperforming` — do not quote the short window alone.
- `high_warning` is the one to watch: price at a new high while the RS line is not means the move is market-led rather than stock-led.
- This is **not** the RSI. RSI compares a symbol to its own past; this compares it to another symbol.
- RS says nothing about direction. A stock can outperform all the way down.

The tool switches the chart to the benchmark and restores it; if restoring fails it raises rather than leaving the chart elsewhere.

## Step 5 — What kind of market this is

```
wyckoff_phase              → accumulation / markup / distribution / markdown
effort_vs_result           → volume against price movement
```

Interpretive, not statistical. Report the phase with its evidence and the word "interpretive".

## Step 6 — Setups, only if Steps 2-3 justified looking

```
patterns_detect            → candlestick and chart patterns
candle_read                → what the last few candles say, named pattern or not
zones_find                 → supply/demand zones
divergence_survey          → RSI, MACD, OBV, MFI agreement
breakout_check             → if price is at a level
wyckoff_spring             → if price just failed a break
```

Rules that decide whether any of this is reportable:

- A structural pattern is **forming** until price closes through its completion level. A forming pattern is a hypothesis. Never present one as a signal.
- Confirmed patterns carry Bulkowski's `measured` statistics — quote `break_even_failure_pct` and `meeting_target_pct` next to any target.
- Divergence: prefer `divergence_survey`. One indicator out of four is weak, and in a strong trend divergence is normal rather than a warning.
- **Candles carry Nison's context and confirmation rules in a `nison` block.** A hammer needs no confirmation; a hanging man does, and until the next bar closes beneath it the status is `awaiting_confirmation` — a hypothesis, not a signal. Check `context_ok` too: the same shape without its required prior trend is not the pattern.
- Zones: read `total_found` before the list. Dozens exist; the returned ones are not rare.
- **Structural patterns: read `noise_check` FIRST.** The noise floor is now 0.78 patterns per 200-bar random walk, down from 19.3, so a double top is worth reading. But `rectangle` still appears in 30% of random walks and the wedges in 8-18% — treat those four with suspicion, especially in a choppy regime.

## Step 7 — Projection, if there is a move to project

```
fib_levels                 → pullback depth, golden zone
fib_targets                → measured move and extensions
```

`fib_targets` refuses when the pullback gave back the whole impulse — there is no impulse left to project. That refusal is correct; report it rather than reaching for another number.

## Step 8 — Reconcile before reporting

The tools answer different questions and will sometimes appear to disagree. Reconcile them explicitly rather than listing them:

| Apparent conflict | How to read it |
|---|---|
| Regime `choppy` + a confirmed pattern | The regime wins. Say the pattern exists and that chop makes it unreliable. |
| Structure `range` + Wyckoff `distribution` | These agree — distribution *is* a range, after an advance. |
| Last leg "pullback up" + price far below | `since_last_leg` staleness. Lead with where price is now. |
| Levels all above price | No tested support. See Step 4. |

If two genuinely conflict and you cannot reconcile them, **say so.** "Structure and volume disagree here" is a real finding.

## Step 9 — Report

Lead with the answer, not the tool run.

1. **What this chart is doing** — regime and structure, in a sentence.
2. **Where price sits** — nearest level above and below, each with its evidence and distance.
3. **What is present** — patterns, zones, divergence, phase. Forming vs confirmed, always.
4. **Is there a trade?** — and "no" is a complete answer. If yes: entry, stop, target, and the R:R from `draw_trade_plan`.
5. **What would change the read** — the price that invalidates it.

## Optional — mark it up

Only if the user wants it on the chart:

```
levels_draw / zones_draw            → grouped, clearable
draw_trade_plan                     → entry/stop/targets in ONE call, returns R:R
capture_screenshot                  → after annotating
```

Then `draw_clear group="..."` to remove. **Never `scope:"all"` without asking** — it deletes the user's own drawings.

## If a trade is proposed

```
position_size_atr / position_size   → size it
trade_cost preset=ibkr_pro_fixed    → what the round trip costs, in R
costs_vs_edge                       → does the edge survive its costs
```

An R:R under 1.5 should be said out loud. So should an edge that costs eat.

## Never

- Read structure, levels or patterns **off a screenshot**. The tools read the bars; your eyes read a picture.
- State a price that no tool produced. If nothing supports it, write `n/a`.
- Present a forming pattern, a stale leg, or a choppy-market setup as actionable.
- Skip Step 2 because the chart "looks" trending.

None of this is trade advice. The tools render the user's own criteria against their own chart.
