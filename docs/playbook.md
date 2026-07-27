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
| **Gap classification** — pattern/common, breakaway, runaway (measuring), exhaustion | A **runaway gap typically marks the halfway point of a move**, which yields a target. `patterns_detect` reports `gap_up`/`gap_down` with no classification at all. |
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

