---
name: chart-patterns
description: Identify chart and candlestick patterns on a chart and report them honestly — with the measurements behind each one, whether it has actually completed, and how reliable that pattern measurably is. Use when the user asks what patterns are on a chart, whether something is a double top / head and shoulders / triangle / flag, or asks you to analyse a chart's formations.
---

# Chart Patterns

Identifying patterns is easy. Identifying them *honestly* is the hard part, and it is the whole job here.

```
patterns_detect                     → everything, last 300 bars
patterns_detect count=600           → deeper history for big formations
patterns_detect include=["double_top","head_and_shoulders"]
```

## Three rules, in order of how often they are broken

### 1. A forming pattern is not a signal

**A pattern is not complete until price CLOSES through its completion level.** Every structural pattern reports `status`:

- `forming` — the shape is there, the breakout has **not** happened
- `confirmed` — price closed through the level

Say which. "There's a double top forming at 302, which completes only on a close below 279" is honest. "There's a double top, target 255" is not — that pattern may never complete, and reporting it as a signal is usually simply wrong.

### 2. Reliability is measured, and it often contradicts the name

Bulkowski tested 103 candle types against real data. Several do the **opposite** of what they are traditionally said to do:

| Pattern | Traditionally | Actually | Rank /103 |
|---|---|---|---|
| Hanging man | bearish reversal | **bullish continuation** 59% | 87 |
| Inverted hammer | bullish reversal | **bearish continuation** 65% | 6 |
| Bearish harami | bearish reversal | **bullish continuation** 53% | 72 |
| Bearish engulfing | bearish reversal | bearish reversal **79%** | 5 |
| Piercing line | bullish reversal | bullish reversal 64% | 21 |
| Hammer | bullish reversal | bullish reversal 60% | 65 |

`patterns_detect` sets `direction` from the **measurement**, not the folklore, and adds `contradicts_folklore` when they disagree. Quote the reliability when you report a pattern.

Two numbers, two different questions:

- **`reliability.pct`** — how often it does what it says. Below ~58% is `close to random`; a harami is a coin flip with a Japanese name.
- **`reliability.rank_of_103`** — how far price travels afterwards. **The hammer reverses 60% of the time and ranks 65th** — it marks the turn and then goes nowhere much. High reliability with a poor rank is a real and common combination.

### 3. Candlestick reversals need a prior trend

A hammer in the middle of a range is a bar with a long wick. The tool reports `prior_trend` and attaches a caveat when there isn't one — pass that on rather than quietly dropping it.

## What gets detected

**Candlestick** — doji, hammer/hanging man, shooting star/inverted hammer, bullish/bearish engulfing, harami, dark cloud cover, piercing line, inside bar, NR4/NR7, gaps.

**Structural, from swings** — double and triple tops/bottoms, head-and-shoulders and its inverse.

**Structural, from trend lines** — ascending/descending/symmetrical triangles, rectangles, rising/falling wedges, broadening formations, bull/bear flags. These require **at least two touches of each line**; fewer is two points and an opinion.

Two that catch people out:

- A **rising wedge is bearish** and a **falling wedge is bullish** — each breaks *against* the direction of its own lines.
- A **symmetrical triangle is bilateral**. Its breakout direction is not knowable in advance; it usually continues the prior trend. Do not assign it one.

## Reading the output

| Field | Use |
|---|---|
| `status` | forming vs confirmed — lead with this |
| `completion_level` | the price that completes the pattern |
| `target` | measured move: pattern height projected from the breakout |
| `measurements` | the numbers that produced the call — quote them |
| `bars_ago` | how long ago it finished forming |
| `reliability` | measured behaviour, for candles |

**`bars_ago` matters.** Structural patterns older than `max_age_bars` (default 60) are excluded and reported in `excluded_old`. A double top completed 200 bars ago at half the current price is history, not a setup.

**No patterns is a normal answer.** Most of the time a chart has none worth reporting, and `structural_note` says so. Do not go hunting with looser parameters until something appears — that is the "see patterns where there aren't any" failure, which the source material lists as the *first* human error with patterns.

## Direction and type are two separate questions

Every pattern has a **direction** (bullish / bearish) and a **type** (reversal / continuation / uncertain). Confusing them is why people trade a continuation pattern as if it called a turn.

- **Reversal** — price went one way in, comes out the other. Double/triple tops and bottoms, head-and-shoulders.
- **Continuation** — a pause inside a trend. Flags, ascending/descending triangles.
- **Uncertain** — the tool sets `type: "uncertain"` and adds an `avoid` field.

**Take the `avoid` field seriously.** Symmetrical triangles, rectangles and broadening formations frequently resolve into a plain trading range rather than a trend, and price inside a range is close to random. Worse, ranges are where imaginary patterns come from — it is always possible to find another triangle inside the noise. Being able to say "this is a range, there is no setup here" is as useful as spotting a setup.

Wedges are the special case: **direction is fixed but type is not.** A falling wedge is bullish whether it reverses a downtrend or continues an uptrend.

## Three ways to enter a pattern

Once a pattern completes, there is more than one entry, and they carry different stops.

| Entry | Where | Stop | Trade-off |
|---|---|---|---|
| **Breakout** | Close beyond the completion level | Beyond the far side of the pattern | Earliest, widest stop, most false starts |
| **Retest** | The broken level flips and price reacts to it | Beyond the retest extreme | Tighter stop, tighter target; may never come |
| **Failure test** | Price pokes *through* the level and closes back inside | Beyond the poke | Best price, needs the reversal to be immediate |

Prefer a breakout candle whose **body is larger than the bodies inside the pattern**. A breakout that closes back inside its own range is a warning, not a signal.

For targets, two conventions — report which one you used:
- **Measured move** — pattern height projected from the breakout. This is what `target` gives.
- **Fixed R:R** — commonly 2:1 against wherever the stop sits.

Flags deserve one extra check: **quality comes mostly from the impulse into them.** A sharp move with large candles followed by a tight, small-candle pause is a good flag. A slow drift followed by a wide sloppy pause is not, even when the shape is textbook.

## Scoring a breakout instead of eyeballing it

Every source describes good breakouts with adjectives — a "strong" candle, "increased" volume, an "obvious" level. `breakout_check` turns those into five measurements:

```
breakout_check level=566.83 direction="up"
```

momentum (body vs recent average) · how far beyond it **closed** · volume vs average · how established the level was · follow-through on the next bar.

**A break reclaimed on the very next bar is `failed`, regardless of the other four.** It also flags a long `rejection_wick` — price through the level and pushed back — even when the close held.

And before assuming a tested level holds again:

```
level_pressure level=554.66 side="support"
```

Lower highs into support (or higher lows into resistance) mean each attempt is failing earlier, so the level is more likely to break than hold. That shape *is* a descending or ascending triangle — which is why those patterns work.

## A worked sequence

```
1. chart_get_state        → symbol and timeframe
2. structure_analyze      → trend and BOS/CHoCH, so patterns have context
3. patterns_detect        → the patterns themselves
4. levels_find            → do the completion levels line up with tested levels?
5. breakout_check         → if something has broken, is the break any good?
6. quote_get              → where price sits relative to them
```

Then report: the trend, any **confirmed** pattern with its measurements, any **forming** pattern with what would complete it, and the reliability of anything candlestick.

Confluence is worth stating when it is real: a double top whose completion level is also a level with four tests (`levels_find`) is a stronger observation than either alone. Two names for the same swing is not confluence.

## What patterns cannot do

- They describe shape, not cause. A pattern does not know about earnings, a Fed meeting, or an index rebalance.
- The measure-rule target assumes typical behaviour. Frequently that does not happen.
- Every statistic above comes from historical US equity studies. A different instrument or regime may not behave the same way.
- Volume confirmation is part of the classical definition of most of these and is **not** currently checked. Say so when volume matters to the setup.

## Guardrails

- Report what the tool returned, including `forming`, `excluded_old` and any caveat.
- Never invent a level. Completion levels and targets come from the tool.
- Nothing here is trade advice. It is geometry on the user's chart, plus published statistics about how that geometry has behaved.

## Measured statistics are attached

Confirmed structural patterns now carry Bulkowski's measurements in a `measured` block: `break_even_failure_pct`, `average_move_pct`, `meeting_target_pct`, `throwback_pullback_pct` and his performance rank — split by breakout direction and by bull/bear market.

- **Quote `meeting_target_pct` next to any target you report.** A measured move that is reached 55% of the time is a different claim from one reached 84% of the time.
- **Only confirmed patterns have them.** He measures from the breakout onward, so a forming shape gets a `stats_note` explaining why the numbers do not apply.
- **Pass `market`.** The bull/bear difference is often large and is the part folklore omits — a rising wedge breaking down fails 24% of the time in a bull market against 8% for the upward break.
- Some patterns carry a `_range` instead of a figure, because Bulkowski measured sub-variants this detector cannot tell apart. Report the range; the average is a number he never measured.

Also useful alongside: **`candle_read`** classifies any candle as momentum, reaction or indecision — it always answers, where `patterns_detect` answers only for named patterns.

## Nison's context and confirmation rules

`measured` says how often a pattern works. The `nison` block on each candlestick says whether it is a pattern **at all** — the prior question, and one detection alone cannot answer.

- **`context_ok`** — Nison requires a prior trend: "A hammer must come after a decline. A hanging man must come after a rally." The identical shape without that context is the shape, not the pattern. Report `context_warning` when present.
- **`confirmation_required`** — this is asymmetric and it matters: a **hammer need not be confirmed, a hanging man must be.** Same for shooting star and inverted hammer.
- **`confirmation_status`** — `confirmed`, `not_confirmed`, or `awaiting_confirmation` when the next bar does not exist yet. Treat the last two exactly as you treat a `forming` structural pattern: a hypothesis, never a signal.

For the engulfing pattern he requires a clearly definable trend, even a short-term one, and allows one exception to the opposite-colour rule — a doji engulfed by a very large body still counts.

> Source: Nison, *Japanese Candlestick Charting Techniques*, 2nd ed., ch. 4.

## The noise floor — read this before reporting any structural pattern

Measured with `src/core/synthetic.js` over 40 seeded random walks of 200 bars:

**This detector reports 19 structural patterns per 200 bars of PURE NOISE**, including ~5 double bottoms and ~5 double tops, with head-and-shoulders in 88% of walks. 100% of random walks produce at least one pattern.

So a chart showing three double bottoms is not showing a signal. It is showing **less than the noise floor**.

`patterns_detect` now returns `noise_check` alongside the detections. **Quote it.** A verdict of "at or below the noise floor" means exactly that — report it as no finding, not as a weak one.

This does not mean the detectors are useless. It means a structural pattern is only worth reporting when:

- the count is **clearly** above the floor (`noise_check` says so), **and**
- `market_regime` is not choppy — a random walk is what chop *is*, and
- the pattern is **confirmed**, not forming, and
- something independent agrees (a tested level, a zone, divergence).

**Flags are never detected at all** — 0% across every noise level. That is a broken detector, recorded in `tests/synthetic.test.js` with an assertion that goes red when it is fixed. Do not report the absence of a flag as meaningful.

