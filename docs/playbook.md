# Playbook — strategies and patterns extracted from the reference books

Distilled from the PDFs in `books/` (the user's own copies; git-ignored, never committed). This file records **what the rules are** and, just as importantly, **which parts this toolchain cannot yet evaluate**.

Nothing here has been backtested. Every setup below is a hypothesis until `backtest_drawn` or `backtest_strategy` says otherwise — see [backtest-strategy](../skills/backtest-strategy/SKILL.md), and always report buy-and-hold.

---

## Part 1 — Setups

### Swing / position (daily chart)

| Setup | Entry conditions | Stop | Target |
|---|---|---|---|
| **RSI 50 cross + SMA20 trend** | SMA20 sloping (not flat); RSI crosses 50 in the trend direction; enter on the close after the cross | Recent swing low (long) / high (short) | 1.5–2R |
| **Breakout** | Close beyond a major S/R level, **confirmed by rising volume** | Just beyond the broken level | 1.5–2R |
| **RSI divergence** | Price lower low, RSI higher low (bullish); needs a reversal candle to confirm | Beyond the divergence extreme | 1.5–2R |
| **Pullback to MA** | Strong trend (SMA20 sloping sharply); price pulls back to the MA and *bounces* | Beyond the MA | 1.5–2R |
| **Swing breakout long** | Above 200 SMA; riding/reclaiming the 8 EMA; breakout above resistance tested 2–3× | Close below the 8 EMA | Sell into extension from the 8 EMA, in quarters |

### Intraday (day-trading setups)

| Setup | Window | Core idea | Stop |
|---|---|---|---|
| **Fallen Angel / Rising Devil** | 09:30–09:40 | Gap reverses into the open, then resumes with the trend off a *pre-identified* support/resistance area | Next S/R break |
| **5-min opening range breakout** | 09:35 | Break of the first 5-minute candle's high/low, near VWAP | Loss of VWAP |
| **Extreme reversal** | 12:00–15:30 | 9/20 crosses the 50 SMA, pullback to it, entry on a new 1-min extreme | Prior wave extreme / 50 SMA |
| **Parabolic reversal** | any | Price extended from the 9 EMA; fade back toward it | Prior candle extreme |
| **ABCD** | any | Trend leg A→B, 40–70% pullback to support (often the 9 EMA), new high D | Consolidation low |
| **Lightning bolt** | 09:40–15:00 | Breaks VWAP, pulls back <½ the move, continues; volume falls on the pullback and rises on the continuation | Beyond VWAP |
| **Mountain pass** | 09:50–15:00 | Double top/bottom at the day's extreme, then a 50 SMA cross | Break of the day's extreme |
| **Break of HOD $ level** | any | HOD sits on a round-dollar level; enter on the break | ≥ $0.51 beyond entry |

### Rules that recur across nearly every intraday setup

These are **risk management**, not entry criteria — they belong in `risk_rules`, not in a strategy's `criteria`:

- Once a partial is taken, move the stop to break-even.
- Take partials at 2R and 4R, and at S/R along the way.
- If any required condition fails, **abort** — a partial setup is not a setup.
- Prefer higher relative volume (RVOL > 100%) and an actual catalyst.

---

## Part 2 — Patterns

`patterns_detect` computes these from the bars. Each returns the measurements behind it, so the claim can be checked.

### Candlestick

| Pattern | Definition as implemented |
|---|---|
| Doji | Body ≤ 10% of range |
| Hammer / Hanging man | Lower wick ≥ 2× body, upper wick ≤ body. **Name depends entirely on prior trend** |
| Shooting star / Inverted hammer | Mirror of the above |
| Bullish / Bearish engulfing | Second body fully contains the first, opposite colours |
| Harami | Small opposite body entirely inside the prior body (≤ 30% of it) |
| Dark cloud / Piercing line | Opens beyond the prior bar, closes back past the midpoint of its body |
| Inside bar | Entire *range* inside the prior bar's range |
| NR4 / NR7 | Narrowest range of the last 4 / 7 bars |
| Gap up / down | No overlap between consecutive bars' ranges |

### Structural (built from swings)

Double top/bottom, triple top/bottom, head-and-shoulders and its inverse. Each reports its **completion level** and the standard measured-move **target** (pattern height projected from the completion level).

### The two rules that matter most

**1. A pattern is not complete until price closes through its completion level.** Everything else is a shape. `patterns_detect` reports `status: "forming"` or `"confirmed"` for exactly this reason — never present a forming pattern as a signal.

**2. Candlestick reversals need a prior trend.** A hammer in a range is a bar with a long wick. The tool reports `prior_trend` and adds a caveat when there isn't one.

Both come straight from the source material, which lists *"see patterns where there aren't any"* as the first human failure mode, alongside *"believe market lore without evidence"*.

---

## Part 3 — What this toolchain cannot evaluate yet

Being explicit about this matters: a strategy silently missing its key condition becomes a much looser strategy that appears to work.

**Since built**, and now available as `strategy_check` operands: `vwap`, `rvol`, `opening_range_high(N)` / `opening_range_low(N)`, `time_et`, `minutes_since_open`. Each returns null — and so UNKNOWN — on a chart whose bars are sessions rather than intraday. Anchored VWAP with standard-deviation bands is a separate tool (`anchored_vwap`), not an operand.

Also since built: **divergence** between price and RSI / MACD / OBV / MFI / volume (`divergence_find`, `divergence_survey`) — it remains a tool rather than a `strategy_check` operand.

Also since built, as `strategy_check` operands: `sma_slope(N)` / `ema_slope(N)` / `rsi_slope(N)`, `<a> crosses_above <b>` / `<a> crosses_below <b>` (an EVENT, not a state), and the structural values `pullback_pct`, `nearest_level_tests`, `nearest_level_distance_pct`, `in_demand_zone`, `in_supply_zone`, `nearest_zone_distance_pct` — which are computed by levels_find/zones_find and PASSED IN rather than recomputed, so criteria cannot drift from what those tools report.

Still missing:

| Missing primitive | Which setups need it |
|---|---|
| **Wave position** | "buy wave 3" — `elliott_count` enumerates counts, but wave position is not an operand, and the count is subjective anyway |
| **Float, catalyst, market cap** | Screening conditions. These are **TA's** job, not this layer's |

`strategy_check` returns **UNKNOWN** rather than a fail for anything it cannot evaluate — so a strategy referencing a missing primitive will say so instead of quietly passing.

---

## Guardrails

- These are **other people's strategies**, transcribed. They are not validated, not endorsed, and not tuned to this user's account or risk.
- Several were written for US small-cap day trading with a specific broker and platform. Windows, thresholds and instruments may not transfer.
- Source PDFs stay in `books/`, git-ignored. Do not commit them or reproduce them at length.
- Nothing here is trade advice.

## Triangle / contraction continuation (Cory Mitchell, Trade That Swing)

The most mechanically specified setup collected so far. Recorded in full because most of it is computable and several primitives are missing.

**Universe filter (before the pattern matters)**
- Strong stock in an uptrend, near 52-week highs.
- **Stronger than the S&P 500** — `relative_strength` answers this directly.
- No swing trades held through earnings, and none taken just before earnings — `ta_trading_context`.

**Formation sequence**
1. Overall uptrend.
2. Pullback (downswing 1).
3. Rally that reaches the prior high or a bit lower. A marginally higher high is fine; price shooting well above prior highs while contracting is not.
4. Second drop, ideally reaching into the turning point of the first. A second drop much smaller than the first suggests a bigger drop still to come.
5. Price rallies and forms a **consolidation** in the middle-to-upper portion of the triangle, or just above its upper line. Consolidation = **three or more bars moving sideways**.

**Volume**
- At least one low-volume day during the consolidation; two or three better.
- Volume must **not** be increasing into the consolidation (absent a reason such as earnings).

**Entry and stop — the part that differs from textbook triangle trading**
- Entry is a buy-stop above the **consolidation** high, not the triangle.
- Stop just below the **consolidation** low, not the triangle.
- That is the entry-precision principle: same target, materially smaller stop.

**Tightness — relative, not absolute**
- "Tight" is judged against *that stock's own* prior contractions, on a log scale.
- A contraction notably larger than the earlier ones in the same uptrend is more likely a **topping** pattern. Do not trade it.

**Exhaustion count**
- Two or three contractions in an uptrend is normal. **After four or more, a bigger pullback becomes more likely.**
- When contractions turn loose and choppy and volume stays high even during consolidations, stop trading the name.

**Targets**
- At least **3:1** reward:risk. 6% risk implies an 18% target.
- Consolidation at the *bottom* of the triangle is a different setup ("front-running"), not this one.

**Missing primitives this needs** — none of these exist yet:

| Needed | For |
|---|---|
| Distance from 52-week high | the universe filter |
| Consolidation detection (3+ sideways bars, tight) | the entry trigger |
| Contraction sequence: count and relative height | tightness, and the four-contraction exhaustion rule |

> Source: [Trade That Swing](https://tradethatswing.com/how-to-swing-trade-continuation-patterns-in-stocks-and-which-ones-to-trade/), read July 2026.

## Price-pattern criteria (books/Technical-analysis-Price-patterns.pdf)

Read in full. Its opening process ends with "Do not force a conclusion; sometimes no trade is the best trade" — the same rule `market_regime` enforces with a number.

Most of its patterns are already detected. These criteria are **not** implemented and are computable:

| Rule | Why it matters |
|---|---|
| **Triangle: breakout must not occur beyond 3/4 of the way to the apex** (measured horizontally from reversal point 1) | A late breakout is unreliable. Nothing currently checks this, so late triangle breaks are reported with full confidence. |
| **H&S target is capped by the preceding move** — a H&S "cannot be expected to retrace more than the price move that preceded it". If the standard height objective lands beyond where the previous move began, that extreme is the limiting factor | Directly prevents an overstated measured-move target. |
| **Triangle needs four minor-trend reversals**; violation of the opposite boundary, even intrabar, destroys the pattern | Validity, not just shape. |
| **Triangle measuring objective counts from reversal point 2**, not the widest part | Different target from the one currently produced. |
| **Wedge objective is not a measured move**: a falling wedge's minimum objective is to take out the pattern's highest point (reversal 1); a rising wedge's is to take out its lowest | The standard height projection is the wrong construction for wedges. |
| **Flags**: slope against the trend, body seldom exceeds five sessions, objective duplicates the preceding straight-line move (half-mast). Once the objective is reached, a violent move the other way often follows | Both a target rule and an exit rule. |
| ~~**Gap classification** — pattern/common, breakaway, runaway (measuring), exhaustion~~ | **ASSESSED AND REJECTED — do not build.** See [swing-evidence-review.md §4.2](swing-evidence-review.md#42-the-gap-taxonomy). The scheme is circular: a gap is "exhaustion" because the move reversed and "runaway" because it continued, so the label is an ex-post relabelling of the outcome presented as an ex-ante signal. At the gap itself the four categories are indistinguishable, which is the only moment the classification would need to work. `patterns_detect` reporting `gap_up`/`gap_down` with no classification is the correct behaviour, not a shortfall. The credible material nearby is PEAD and the high-volume return premium. |
| **Key reversal**: after three higher highs, a new high with a lower close, on high volume | Not implemented. |
| **Outside range** bar, **mid-range close** | Not implemented. |

**A conflict to keep rather than resolve.** This deck quotes reliability of 86-88% for head-and-shoulders, 76-78% for symmetrical triangles, 75-80% for right-angle triangles. Bulkowski's *measured* figures say something different in kind: H&S tops fail to move 5% only 4% of the time, but reach the measured-move target just 55% of the time. These are different questions — "resolves in the expected direction" versus "reaches its target" — and the deck does not say which it measured or on what sample. **Prefer Bulkowski's numbers, which state their construction, and do not blend the two.**

### What the EXHIBITS add (pages 10-58, read as images)

The slides that read as just "Example" in the text layer *are* the chart. Read as rendered images, they carry things the prose does not:

**The H&S cap rule, with numbers** (Copper, May 1992). Traditional height objective 105.04. The objective was **not met** — the price move preceding the H&S top began at 104.10, and that was the limiting factor. This is the concrete case for capping a measured move at the origin of the preceding move.

**Double-top arithmetic spelled out** (Euro-fx weekly). Highs 1.599 and 1.599, intervening low 1.526. Height 1.599 − 1.529 = 0.073. Objective 1.526 − 0.073 = 1.453, and it was met. Confirms the objective is subtracted from the **intervening low**, not from the highs.

**High tight flag** (Alcoa 1999) — a pattern this toolchain does **not** detect. The exhibit gives its projection explicitly: the range of prices that created the flag **pole** is added to the price **at the point of breakout from the flag**. Pole $6.00 → $6.00 projection. Note this differs from the generic flag construction.

**Flags have two accepted constructions.** The schematic marks the standard objective and separately "the slightly more aggressive method of obtaining the measuring objective in a bull flag" — measured from the bottom of the flag rather than from the breakout. Report which one is used.

**Gaps, classified on a real chart** (Apollo Group). A *measuring* gap mid-advance and a *runaway* gap later are labelled separately on the same chart; the exhaustion-gap slide shows a breakaway near the low and an exhaustion gap at the top on heavy volume. `patterns_detect` returns `gap_up`/`gap_down` with no classification, and the measuring gap in particular implies a halfway target.

**Key reversal followed by an inside range** (Silver, Dec 2008) — a compound signal, not two separate ones.

**Triangle reversal points are numbered on the chart**: point 1 is a relative price **high** in a bull market, then 2 low, 3 high, 4 low. The "multiple triangles" exhibit shows a smaller triangle nested inside a larger one, which is what "redrawing the boundary lines by relocating points 3-4" means in practice.

> **An internal contradiction, left unresolved.** The wedge text calls wedges *continuation* patterns. Both wedge exhibits in the same deck label them **"(reversal)"** — rising wedge on Anntaylor, falling wedge on Freeport McMoRan. The deck disagrees with itself. Bulkowski's measured data is the tiebreaker this repo already carries: a rising wedge breaking **down** fails 24% of the time in a bull market against 8% for the upward break, which is why `STRUCTURAL_STATS` reports wedges by breakout direction rather than assigning them a single meaning.

## What the IMAGES in the books folder add

Rescanned the whole folder. Inventory, and whether the images have been looked at:

| File | Pages | Kind | Images read |
|---|---|---|---|
| Technical-analysis-Price-patterns.pdf | 58 | text + 199 charts | yes — see the exhibits section above |
| BBT_Tradebook_strategies_cheatsheet | 13 | text + 15 charts | yes |
| Idenitfying-Chart-Patterns.pdf | 49 | text + 24 charts | partly — pattern slides pending |
| Full_Trading_Playbook.pdf | 3 | text only | n/a |
| Encyclopedia of Chart Patterns (Bulkowski) | 1035 | text + 326 charts | statistics extracted; chart exhibits not read |
| Japanese Candlestick (Nison) | 298 | **pure scan** | ch. 4 rules read as images |
| Technical Analysis Explained (Pring) | 329 | **pure scan** | preface only |

### The only measured expectancy in any of these sources — and it is in an image

The BearBull **Lightning Bolt** diagram carries success rates and expectancy that appear nowhere in the text:

| | 3rd Touch Method | Double Confirmation Method |
|---|---|---|
| Success probability | 60% | 70% |
| — small winner | 30% at 0.5R | 35% at 0.5R |
| — large winner | 30% at 8R+ | 35% at 6R+ |
| Failure rate | 40% at −1R | 33% at −1R |
| **Stated average return** | **~1.6R** | **~1.9R** |

**Checked with `risk_expectancy`-style arithmetic, and one does not reconcile:**

- Double Confirmation: 0.35(0.5) + 0.35(6) + 0.33(−1) = **1.94R** — matches the stated 1.9R. Note the probabilities sum to 103%, a rounding slip that does not change the result materially.
- 3rd Touch: 0.30(0.5) + 0.30(8) + 0.40(−1) = **2.15R**, not the stated 1.6R. To reach 1.6R the large-winner bucket has to average **6.17R**, not 8R. So either "8R+" is a maximum rather than a mean, or the stated average is conservative. **Quote 1.6R, not the 8R figure** — and say the arithmetic behind it does not close.

This is the only source in the folder that states an expectancy, which makes it the only one that can be checked, and it is worth more than any number of pattern definitions.

### Full_Trading_Playbook — four strategies, all now expressible

Never opened before this pass. Four setups, all 1H, all targeting 1.5-2x R:R. Every one is now writable as a `rules.json` strategy block using operands added this session:

| Strategy | Expressible as |
|---|---|
| RSI 50 Cross + SMA20 Trend | `rsi(14) crosses_above 50` AND `sma_slope(20) > 0` |
| Breakout | `nearest_level_distance_pct`, `rvol`, close beyond level |
| RSI Divergence | `divergence_find indicator=rsi` |
| Pullback to MA | `sma_slope(20)` steep, price near `sma(20)` |

Its "common mistakes" list is worth keeping: trading with a flat SMA20, entering without confirmation, ignoring stop discipline. The first is exactly why `sma_slope` was needed — a moving average's level says nothing about whether it is rising.

## thepatternsite.com — Bulkowski's own site, and it CONTRADICTS the book extraction

The site is fetchable and carries current data with far larger samples than the 2005 2nd edition I parsed. **`STRUCTURAL_STATS` in `src/core/patterns.js` is materially wrong and needs rebuilding from these pages.**

### The discrepancy

| Pattern (bull market) | My table (2nd ed., parsed) | Site (current) |
|---|---|---|
| H&S top | rank **1/21**, fail **4%**, decline 22%, target 55% | rank **9/36**, fail **19%**, decline 16%, target 51% |
| H&S bottom | rank 7/23, fail 3%, rise 38%, target 74% | rank 13/39, fail 11%, rise 45%, target 71% |
| Ascending triangle, up | rank 17/23, fail 13%, rise 35%, target 75% | rank 16/39, fail 17%, rise 43%, target 70% |
| Descending triangle, up | rank **5/23**, fail **7%**, rise 47%, target **84%** | rank **33/39**, fail **22%**, rise 38%, target 64% |
| Symmetrical triangle, up | rank 16/23, fail 9%, rise 31%, target 66% | rank 36/39, fail 25%, rise 34%, target 58% |
| Rising wedge, down | rank 20/21, fail **24%**, decline 14%, target 46% | rank **36/36 (last)**, fail **51%**, decline 9%, target 32% |
| Falling wedge, up | rank 20/23, fail 11%, rise 32%, target 70% | rank 31/39, fail 26%, rise 38%, target 62% |

Three things are going on and they compound:

1. **Different edition.** Denominators moved from 23/21 patterns to 39/36. Ranks are not comparable across editions at all.
2. **Much larger samples.** The site quotes 1,400-3,197 perfect trades per pattern.
3. **Possible parse error in my extraction.** Descending-triangle-upward at 5/23 with an 84% target rate was the best figure in my whole table, and the site puts the same pattern at 33/39 with 64%. That gap is large enough to suspect the up/down block labelling in my PDF parse, independent of the edition change.

**The site figures are bull-market only** — it does not publish the bear split the book does. A rebuild trades the bull/bear dimension for currency and sample size. Worth it, and the loss should be stated in the output.

### Confirmed: the wedge measure rule

Bulkowski states it directly, which makes three independent sources in agreement and validates the fix already shipped:

- Rising wedge: *"For downward breakouts, the lowest valley in the pattern (A) is the price target."*
- Falling wedge: *"For upward breakouts, the highest peak in the pattern (A) is the price target."*

He also gives a **second, better construction worth adopting generally**: take the pattern height, **multiply it by the percentage-meeting-price-target**, then add or subtract from the breakout price. That discounts the projection by how often it is actually reached, which turns an optimistic target into a realistic one. Nothing here does that yet.

### The methodology caveat that applies to every one of these numbers

From the top-10 page: *"The average rise and decline are for hundreds of 'perfect trades' without commissions or fees deducted."* Measurement runs from the open the day after the breakout to the ultimate high or low before a 20% reversal.

So **every `average_move_pct` figure is a perfect trade, gross of costs**, measured to a peak you could not have known at the time. Quote them next to `trade_cost` and `costs_vs_edge`, never alone.

### Pages identified for the rebuild

`hst` `hsb` `aadt` `aedt` `eadt` `eedt` `aadb` `aedb` `eadb` `eedb` `tt` `tb` `at` `dt` `st` `recttops` `rectbots` `risewedge` `fallwedge` `bt` `broadb` `flags` — plus **`htf` (high tight flag)**, the pattern identified as missing from the BBT/price-pattern exhibits and still not detected.

## Patternz — an independent implementation to check against

Bulkowski ships a free Windows program, Patternz, that finds 110+ chart patterns and 105 candlesticks. **The binary was not run and not decompiled** — his published identification guidelines are the legitimate source for detection rules and are already used here.

What is useful is its data format, which is trivially simple and exactly what this toolchain produces:

```
Date,Open,High,Low,Close,Volume
2025-02-14,145.84,147.48,145.69,146.56,2388382
```

`export_bars_csv` writes the chart's bars in that layout. That makes the one form of validation this repo has never had possible: run Patternz over the same bars and compare his detections against `patterns_detect`.

Everything here is checked against its own tests and against a live chart. Nothing has ever been checked against an **independent implementation** of the same patterns — least of all the one written by the person whose statistics the tool quotes. Where the two disagree, at least one is wrong, and until now there was no way to find out which.

Patternz keys bars by date, so it expects DAILY data. The export warns when the chart is intraday, because multiple bars sharing a date would be misread rather than rejected.

## Crabel's contraction/expansion — why it is not in the playbook

`volatility_state` implements it, and it is deliberately absent from the
strategies above.

A narrow range really does precede a wider one — 76.4% of the time. But a
random walk manages 80.2%, against a 50% base in both, so there is no edge to
build a rule on. Daily range is mean-reverting by arithmetic and that accounts
for all of it.

Use it as CONTEXT — "this market is coiled, expect a bigger bar" — and take the
direction from structure. Anything more is trading an artefact of ranges.

---

## Five sources studied 2026-07-29 — verdicts

Triaged for NEW CAPABILITY versus renamed vocabulary. Two produced code; three did not.

| Source | Verdict |
|---|---|
| **Grimes / Waverly Advisors**, *Multiple Timeframe Analysis* (2013, 57 slides) | **Highest value of the five.** Quantitative. Produced `timeframe_scale` (sqrt law), the `mtf_analyze` corrections, and the timeframe-justification guard. |
| **Shannon**, *Technical Analysis Using Multiple Timeframes* (2008, 198p, SCANNED) | Fig. 10.4 produced the linear lookback law. Framework is Weinstein stage analysis = the Wyckoff phases we already ship, and ours carries a measured noise floor his does not. |
| **Farley**, *The Master Swing Trader* (2000, 377p) | Corroboration, no new capability. Reaches our horizon-and-cost doctrine independently — "trend relativity errors steal more profits than any other trading mistake". For a 1-3 day hold: reward from the daily, execution from the 60-minute (a horizon our Weeks/Months split excludes). |
| **Aziz**, *How to Day Trade for a Living* (116p) | Adds nothing here. Day-trading horizon; one statistical mention in the whole book; the ABCD pattern is a pullback `fib_levels` and the momentum-pullback screen already cover. |
| **Bellafiore**, *The PlayBook* (42p EXCERPT) | Excerpt is front matter, the Introduction, and the Index — no method. But its index surfaced `Reasons2Sell`: a DISJUNCTIVE exit list closing on whichever condition fires first, one of which is a TIME stop. See the open gap below. |

### What Grimes measured, and why it changed our code

A triple moving-average trend indicator over **973,087 observations** with a **random control column** — the same discipline this repo runs on. Across ~903,586 equity observations the indicator was **inverted**: excess return −157.9 when it read up against +166.9 when it read down, with next-bar direction at ~50% in every category *including random*. The random column showed the opposite sign pattern, so the framework flatters the indicator and real equities reverse that.

Consequences, both now in code:

- `mtf_analyze` no longer states Elder's rule as settled. The surviving claim is the weaker one — against-trend setups fail more often — not "the higher timeframe is always right".
- A ranging context now withholds a directional **lean** instead of returning "neither". A ranging higher timeframe is a specific regime, not missing information: it is where sharp lower-timeframe trends appear, and lower-timeframe ranges inside it are usually continuation patterns for the range.

### The self-fulfilling-prophecy problem

Four of these sources justify moving averages by crowd self-fulfilment — Farley ("the crowd perpetrates a self-fulfilling event"), Aziz ("self-fulfilling prophecy effect"), and the video material studied earlier ("a self-fulfilling magnet"). Shannon, the most careful, warns the opposite: treating moving averages as literal entry levels is the amateur error that gets traders trapped. Grimes measured the thing and found it inverted on ~900k equity observations.

They agree on the mechanism, contradict each other on what to do with it, and the only one who measured found the opposite of what three of them teach. Treat the mechanism as unfalsifiable and prefer `scaling_exponent`, which measures persistence directly.

### Open gap: a disjunctive exit list

`labeling.js` implements triple-barrier labelling — profit, stop, and **time** — but only for building training sets. Nothing in the trade-management layer takes a time barrier. `MONTHS_EXIT` is effectively one (the monthly rebalance) but it is implicit rather than enumerated beside the others. Bellafiore's `Reasons2Sell` is the framing: list every independent reason to close, and close on whichever fires first. Not built.
