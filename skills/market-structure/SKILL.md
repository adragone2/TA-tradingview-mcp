---
name: market-structure
description: Read market structure (swing highs/lows, trend, BOS, CHoCH) and find support/resistance levels with the evidence behind each one, then draw them. Use when the user asks about trend, structure, key levels, support, resistance, or where price has reacted before.
---

# Market Structure and Key Levels

Two questions this answers, both from the chart's own price data rather than from looking at it:

1. **What is the structure doing?** — swing highs and lows, labelled HH/HL/LH/LL, the trend they imply, and every break of structure (BOS) and change of character (CHoCH).
2. **Which levels matter, and why?** — support and resistance, each carrying the evidence that earned it a place.

## The rule that makes this worth having

**Never state a level without its evidence.** Once a line is drawn on a chart, a level backed by four tests and a volume shelf looks exactly like one you guessed. The tools return a `reason` for every level; quote it.

This is also why you should not read structure off a screenshot. A swing point you identify by eye is a guess — `structure_analyze` reads the actual bars.

## Structure

```
structure_analyze                        → 200 bars, default sensitivity
structure_analyze count=500 lookback=10  → longer history, only major swings
```

Returns `trend` (uptrend / downtrend / range / undetermined), the recent swings with their labels, and the BOS/CHoCH events.

- **BOS** — the trend extended (a higher high in an uptrend). Continuation.
- **CHoCH** — the trend's defining low or high failed. The first sign it has turned.
- `lookback` is the sensitivity dial. Higher finds fewer, more significant swings. Start at 5 for intraday, 10 or more for a daily chart where you only want majors.

> **The last few bars are deliberately absent.** A swing needs `lookback` bars to its right before it confirms. The tool says so in its `caveat` — pass that on rather than implying the structure is current to the last tick.

`trend: "range"` is a real answer, not a failure. So is `undetermined`. Report them as-is instead of forcing a directional read.

## Key levels

```
levels_find                                  → the strongest levels near price
levels_find min_touches=3                    → only well-tested levels
levels_find max_distance_pct=50              → include distant major levels
levels_find tolerance_pct=1.5                → looser clustering, fewer/wider levels
```

Each level carries:

| Field | What it means |
|-------|---------------|
| `tests` | How many **separate** times price visited the level |
| `bars_in_band` | Total bars that traded inside it |
| `swing_highs` / `swing_lows` | Both non-zero means the level **flipped** — held as resistance and as support |
| `volume_ratio` | Volume there vs the chart average |
| `round_number` | A psychological level sitting on top, if any |
| `kind` | `line` for a tight level, `zone` when the cluster is wide |
| `score` | The additive sum of the above — every term is visible, so check it |
| `reason` | The evidence, assembled from those fields |

**`tests` is not `bars_in_band`.** Twenty consecutive bars grinding along a level is one test, not twenty. A level with 4 tests and 19 bars has been genuinely rejected four times; one with 1 test and 40 bars is just where price happened to drift.

### Two parameters that change the answer a lot

- **`max_distance_pct`** (default 25) — a level 50% away is real history but not a level for today, and it outscores nearby ones simply by having had longer to accumulate tests. When it filters something out it says so in `excluded_far`.
- **`tolerance_pct`** (default 0.75) — how close two swings must be to count as the same level. Raise it on a volatile symbol, lower it on a tight one.

## Drawing

```
levels_draw                        → up to 8 levels, compact labels
levels_draw label_detail="full"    → whole reason in each label
levels_draw max_levels=4           → just the majors
```

Green below price, red above. Line thickness tracks score. Zones draw as shaded rectangles rather than lines.

Labels are **compact by default** — price plus the two strongest signals. `label_detail="full"` writes the entire reason, which overlaps badly when levels sit a few percent apart. The complete evidence is in the tool result either way, so the chart carries the level and you carry the argument.

Drawn as `levels-<TICKER>`, so `draw_clear group="levels-SMH"` removes exactly that set and nothing the user drew.

## A worked sequence

```
1. chart_get_state          → confirm symbol and timeframe
2. structure_analyze        → trend, and whether it recently changed character
3. levels_find              → the levels, with evidence
4. levels_draw max_levels=6 → put them on the chart
5. quote_get                → where price sits relative to them
```

Then report: the trend, the nearest level either side **with its reason**, and any CHoCH that argues against the trend.

## Combining with the other layers

- **Gamma walls** (`walls_draw`, `walls_apply`) come from option positioning — a different kind of level entirely. Where a wall and a tested price level coincide, say so; that is genuine confluence rather than the same fact counted twice.
- **TA entry/exit levels** (`ta_draw_decision`) are TA's own decisions. Keep them attributed to TA.
- Drawing all three at once is legible if each keeps its own group.

## Guardrails

- These levels come from **this chart's price history only** — no options data, no fundamentals, no other timeframe. A level found on the daily is not automatically a level on the 5-minute; re-run per timeframe.
- The scoring is a heuristic for ranking, not a probability. A score of 13 is not "13% likely to hold".
- Levels describe where price has reacted before. They do not say it will react again.
- Nothing here is advice. It is arithmetic on the user's chart.
